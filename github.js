// GitHub integration — Code Flow + Dev card parity with azdo.js.
//
// Auth: secretless first — mirrors the `az` pattern using the GitHub CLI
// (`gh auth token`). Fallbacks: GH_TOKEN / GITHUB_TOKEN env, then an optional
// PAT from settings. No token written to disk in the primary path.
//
// Signatures deliberately mirror azdo.js so forge.js can dispatch by descriptor
// with almost no call-site churn: the Code Flow read path uses the AzDo-style
// positional shape (owner, _project, repo, ...) and simply ignores the middle
// "project" slot (GitHub has no project). Work-item (issue) helpers are
// repo-scoped and take (owner, repo, number) because GitHub issues live in a
// repo, not a project — Dev-card callers branch on provider for those.
//
// REST only (no GraphQL): SAML-SSO orgs answer GraphQL with an SSO trap, and
// REST is sufficient for everything Code Flow needs. Thread "resolution" is
// therefore reported as unknown rather than faked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const API_ROOT = 'https://api.github.com';
const API_VERSION_HEADER = '2022-11-28';
const HOST = 'github.com';

let SUPERVISOR_DATA_DIR;
try {
  SUPERVISOR_DATA_DIR = require('./config-sync').SUPERVISOR_DATA_DIR;
} catch {
  SUPERVISOR_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
}
const GITHUB_STORE = path.join(SUPERVISOR_DATA_DIR, 'github-sources');

// Optional PAT fallback, read lazily from settings.js so a missing module or
// empty setting never breaks the primary `gh` path.
function _settingsPat() {
  try {
    const settings = require('./settings');
    const s = (settings.getSettings && settings.getSettings()) || {};
    const mode = s.githubAuthMode || 'cli';
    if (mode === 'pat' && s.githubPat) return String(s.githubPat).trim();
    // Even in cli/env mode, allow a stored PAT as a last resort.
    if (s.githubPat) return String(s.githubPat).trim();
  } catch {}
  return '';
}

let _tokenCache = { token: null, expiresAt: 0 };

// Get a GitHub token. Primary: `gh auth token`. Fallbacks: env, settings PAT.
// gh tokens don't expose an expiry, so we cache for a conservative window and
// refresh on demand. forceRefresh bypasses the cache after a 401.
function getToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  let token = '';
  // 1) GitHub CLI (secretless, primary).
  try {
    const raw = execSync(`gh auth token --hostname ${HOST}`, {
      encoding: 'utf-8', timeout: 15_000, shell: true
    }).trim();
    if (/^gh[opsu]_|^github_pat_/.test(raw)) token = raw;
    else if (raw && !/not logged|no oauth|error/i.test(raw)) token = raw;
  } catch {}
  // 2) Environment (CI / shells that exported a token).
  if (!token) token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  // 3) Optional stored PAT.
  if (!token) token = _settingsPat();

  if (!token) {
    throw new Error(
      'GitHub auth required. Run "gh auth login" on the server machine (or set GH_TOKEN, ' +
      'or add a PAT under Settings → GitHub).'
    );
  }
  _tokenCache = { token, expiresAt: now + 25 * 60_000 };
  return token;
}

// ---- Core request --------------------------------------------------------

function _headers(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION_HEADER,
    'User-Agent': 'TheOffice.AI'
  };
}

// Surface GitHub's SAML-SSO 403 clearly (the token is valid but not authorized
// for the org until the user approves it in the browser).
function _ssoMessage(res) {
  const sso = res.headers.get('x-github-sso') || '';
  if (sso) {
    const m = sso.match(/url=([^;,\s]+)/i);
    return 'GitHub blocked this token for a SAML-SSO org. Authorize it here: ' + (m ? m[1] : sso);
  }
  return '';
}

// Single request. Returns parsed JSON (or raw text when accept is a raw type).
// On 401 refreshes the token once. Follows no pagination itself — see apiAll.
async function api(rest, { method = 'GET', body, accept, raw = false } = {}) {
  const url = rest.startsWith('http') ? rest : API_ROOT + rest;
  const doFetch = (token) => fetch(url, {
    method,
    headers: {
      ..._headers(token, accept || (raw ? 'application/vnd.github.raw' : undefined)),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let res = await doFetch(getToken());
  if (res.status === 401) res = await doFetch(getToken(true));
  const text = await res.text();

  if (!res.ok) {
    const sso = _ssoMessage(res);
    let detail = '';
    try { detail = (JSON.parse(text).message || '').slice(0, 300); } catch { detail = (text || '').slice(0, 300); }
    if (res.status === 401) throw new Error('GitHub denied access (401). Token invalid or expired — run "gh auth login". ' + detail);
    if (res.status === 403) throw new Error((sso || `GitHub denied access (403). ${detail}`));
    if (res.status === 404) throw new Error(`GitHub resource not found (404). Check owner/repo/number. ${detail}`);
    throw new Error(`GitHub request failed (${res.status}). ${detail}`);
  }
  if (raw || (accept && /raw|html|diff/.test(accept))) return text;
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error('GitHub returned a non-JSON response.'); }
}

// Follow RFC5988 Link-header pagination and concatenate array results.
async function apiAll(rest, { cap = 500 } = {}) {
  let url = rest.startsWith('http') ? rest : API_ROOT + rest;
  const sep = url.includes('?') ? '&' : '?';
  if (!/[?&]per_page=/.test(url)) url += sep + 'per_page=100';
  const out = [];
  for (let guard = 0; guard < 20 && url && out.length < cap; guard++) {
    const res = await fetch(url, { headers: _headers(getToken()) });
    if (res.status === 401) { getToken(true); continue; }
    const text = await res.text();
    if (!res.ok) {
      const sso = _ssoMessage(res);
      let detail = ''; try { detail = (JSON.parse(text).message || ''); } catch { detail = text.slice(0, 200); }
      throw new Error(sso || `GitHub request failed (${res.status}). ${detail}`);
    }
    let arr = []; try { arr = JSON.parse(text); } catch {}
    if (Array.isArray(arr)) out.push(...arr);
    else if (arr && Array.isArray(arr.items)) out.push(...arr.items);
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : '';
  }
  return out.slice(0, cap);
}

// ---- Identity ------------------------------------------------------------

async function getCurrentUser(_owner) {
  const u = await api('/user');
  return {
    id: u.login || '',        // login IS the identity key for GitHub filters
    login: u.login || '',
    name: u.name || u.login || '',
    email: u.email || '',
    descriptor: u.login || ''
  };
}

// ---- Listing -------------------------------------------------------------

// List repos for an owner. Tries org first, then the authed user's affiliations
// (owner + private) filtered to the owner, then the public user endpoint.
async function listRepos(owner, _project) {
  const map = r => ({ id: r.id, name: r.name, defaultBranch: r.default_branch || 'main', private: !!r.private, fullName: r.full_name });
  const login = (owner || '').trim();
  // 1) Org repos.
  try {
    const orgRepos = await apiAll(`/orgs/${encodeURIComponent(login)}/repos?type=all&sort=full_name`);
    if (orgRepos.length) return orgRepos.map(map).sort((a, b) => a.name.localeCompare(b.name));
  } catch {}
  // 2) The authed user's repos (covers personal + collaborator + private).
  try {
    const mine = await apiAll('/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name');
    const filtered = mine.filter(r => (r.owner && r.owner.login || '').toLowerCase() === login.toLowerCase());
    if (filtered.length) return filtered.map(map).sort((a, b) => a.name.localeCompare(b.name));
  } catch {}
  // 3) Public user repos.
  const pub = await apiAll(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=full_name`);
  return pub.map(map).sort((a, b) => a.name.localeCompare(b.name));
}

async function listBranches(owner, _project, repo) {
  const data = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  return data.map(b => b.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

async function getRepo(owner, _project, repo) {
  const r = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  return { id: r.id, name: r.name, defaultBranch: r.default_branch || 'main', fullName: r.full_name };
}

async function getRefObjectId(owner, _project, repo, branch) {
  try {
    const r = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return (r.object && r.object.sha) || null;
  } catch { return null; }
}

// ---- Pull requests -------------------------------------------------------

// Map a GitHub review state to the AzDo vote scale so the shared UI works.
function _voteFor(state) {
  switch (String(state || '').toUpperCase()) {
    case 'APPROVED': return 10;
    case 'CHANGES_REQUESTED': return -10;
    case 'DISMISSED': return 0;
    case 'PENDING': return -5;
    case 'COMMENTED': return 0;
    default: return 0;
  }
}

function voteLabel(vote) {
  switch (Number(vote)) {
    case 10: return 'approved';
    case 5: return 'approved-with-suggestions';
    case -5: return 'waiting-for-author';
    case -10: return 'rejected';
    default: return 'no-vote';
  }
}

function pullRequestUrl(owner, _project, repo, prId) {
  return `https://github.com/${owner}/${repo}/pull/${prId}`;
}
function workItemUrl(owner, repo, id) {
  return `https://github.com/${owner}/${repo}/issues/${id}`;
}
function cloneUrl(owner, _project, repo) {
  return `https://github.com/${owner}/${encodeURIComponent(repo)}.git`;
}

// Normalize a GitHub PR (from /pulls or /pulls/{n}) into the neutral shape,
// with fork-aware head/base fields (R1). `reviews` (optional) enriches reviewer
// votes; without it, requested reviewers show as pending no-vote.
function _compactPr(d, owner, repo, reviews) {
  const head = d.head || {}, base = d.base || {};
  const headRepoFull = (head.repo && head.repo.full_name) || '';
  const baseRepoFull = (base.repo && base.repo.full_name) || `${owner}/${repo}`;
  const status = d.state === 'open' ? 'active' : (d.merged_at ? 'completed' : 'abandoned');

  // Reviewers: collapse latest non-pending review per user, plus still-requested.
  const reviewerMap = new Map();
  if (Array.isArray(reviews)) {
    for (const rv of reviews) {
      const login = (rv.user && rv.user.login) || '';
      if (!login || String(rv.state).toUpperCase() === 'PENDING') continue;
      // reviews are chronological; keep the last meaningful one per user
      reviewerMap.set(login, { login, state: rv.state });
    }
  }
  const reviewers = [];
  for (const [login, r] of reviewerMap) {
    reviewers.push({ id: login, name: login, login, vote: _voteFor(r.state), voteLabel: voteLabel(_voteFor(r.state)), isRequired: false });
  }
  for (const rr of (d.requested_reviewers || [])) {
    const login = rr.login || '';
    if (login && !reviewerMap.has(login)) {
      reviewers.push({ id: login, name: login, login, vote: 0, voteLabel: 'no-vote', isRequired: true });
    }
  }

  return {
    provider: 'github',
    id: d.number,
    title: d.title || '',
    description: (d.body || '').slice(0, 1200),
    status,
    isDraft: !!d.draft,
    mergeStatus: d.mergeable_state || (d.merged ? 'merged' : ''),
    sourceBranch: head.ref || '',
    targetBranch: base.ref || '',
    creationDate: d.created_at || '',
    closedDate: d.closed_at || '',
    createdBy: {
      id: (d.user && d.user.login) || '',
      name: (d.user && d.user.login) || '',
      login: (d.user && d.user.login) || ''
    },
    reviewers,
    // Fork-aware fields (R1) — worktree/sync/push must respect cross-repo heads.
    headRepoFullName: headRepoFull,
    headOwner: headRepoFull.split('/')[0] || owner,
    headRepo: headRepoFull.split('/')[1] || repo,
    headRef: head.ref || '',
    headSha: head.sha || '',
    baseRepoFullName: baseRepoFull,
    baseRef: base.ref || '',
    isCrossRepo: !!(headRepoFull && headRepoFull !== baseRepoFull),
    org: owner, project: '', repo,
    url: pullRequestUrl(owner, '', repo, d.number),
    webUrl: d.html_url || pullRequestUrl(owner, '', repo, d.number)
  };
}

// GitHub's /pulls has no server-side author/reviewer filter, so we list by state
// and client-filter by login. status: active(open) | completed/abandoned(closed)
// | all. creatorId / reviewerId are logins (from getCurrentUser().id).
async function listPullRequests(owner, _project, repo, { creatorId, reviewerId, status = 'active', top = 50 } = {}) {
  const ghState = status === 'active' ? 'open' : (status === 'all' ? 'all' : 'closed');
  const all = await apiAll(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${ghState}&sort=updated&direction=desc`,
    { cap: Math.max(50, Number(top) || 50) }
  );
  let list = all;
  const wantCreator = (creatorId || '').toLowerCase();
  const wantReviewer = (reviewerId || '').toLowerCase();
  if (wantCreator) list = list.filter(p => ((p.user && p.user.login) || '').toLowerCase() === wantCreator);
  if (wantReviewer) list = list.filter(p => (p.requested_reviewers || []).some(r => (r.login || '').toLowerCase() === wantReviewer));
  return list.slice(0, Number(top) || 50).map(p => _compactPr(p, owner, repo));
}

// Project-wide (all repos for an owner) — mirrors azdo.listProjectPullRequests.
// GitHub has no project scope, so this uses the Search API across the owner.
async function listProjectPullRequests(owner, _project, { creatorId, reviewerId, status = 'completed', top = 100 } = {}) {
  const parts = [`org:${owner}`, 'is:pr'];
  if (status === 'completed') parts.push('is:merged');
  else if (status === 'abandoned') parts.push('is:closed', 'is:unmerged');
  else if (status === 'active') parts.push('is:open');
  if (creatorId) parts.push(`author:${creatorId}`);
  if (reviewerId) parts.push(`review-requested:${reviewerId}`);
  const q = encodeURIComponent(parts.join(' '));
  const items = await apiAll(`/search/issues?q=${q}&sort=updated&order=desc`, { cap: Number(top) || 100 });
  // Search returns issue-shaped PRs; fetch full PR for repo/branch context lazily
  // would be N calls, so map what search gives and derive repo from repository_url.
  return items.map(it => {
    const m = (it.repository_url || '').match(/repos\/([^/]+)\/([^/]+)$/);
    const o = m ? m[1] : owner, r = m ? m[2] : '';
    return _compactPr({
      number: it.number, title: it.title, body: it.body, state: it.state,
      merged_at: it.pull_request && it.pull_request.merged_at,
      draft: it.draft, created_at: it.created_at, closed_at: it.closed_at,
      user: it.user, requested_reviewers: [], head: {}, base: { repo: { full_name: `${o}/${r}` } },
      html_url: it.html_url
    }, o, r);
  });
}

async function getPullRequest(owner, _project, repo, prId) {
  const d = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`);
  let reviews = [];
  try { reviews = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/reviews`, { cap: 200 }); } catch {}
  return _compactPr(d, owner, repo, reviews);
}

// Thread counts. GitHub REST can't tell resolved vs unresolved reliably, so we
// report open review comments and mark resolution unknown (R3).
async function getPrThreads(owner, _project, repo, prId) {
  let review = [], issue = [];
  try { review = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/comments`, { cap: 300 }); } catch {}
  const open = review.filter(c => c.in_reply_to_id == null); // top-level threads
  return { activeComments: open.length, resolvedComments: 0, totalThreads: open.length, resolutionUnknown: true };
}

// Detailed open review-comment threads (file/line + comments), for an agent that
// must respond to feedback. Prefers non-outdated comments (position != null).
async function getPrActiveThreads(owner, _project, repo, prId, { max = 50 } = {}) {
  let comments = [];
  try { comments = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/comments`, { cap: 300 }); } catch {}
  // Group by thread root (in_reply_to_id chain collapses to the first comment).
  const roots = new Map();
  for (const c of comments) {
    const rootId = c.in_reply_to_id || c.id;
    if (!roots.has(rootId)) roots.set(rootId, []);
    roots.get(rootId).push(c);
  }
  const out = [];
  for (const [id, thread] of roots) {
    const first = thread[0];
    const outdated = first.position == null; // GitHub nulls position when outdated
    const msgs = thread
      .map(c => ({ author: (c.user && c.user.login) || 'unknown', text: String(c.body || '').trim() }))
      .filter(c => c.text);
    if (!msgs.length) continue;
    out.push({
      id,
      status: outdated ? 'outdated' : 'active',
      file: first.path || null,
      line: first.line || first.original_line || null,
      comments: msgs
    });
    if (out.length >= max) break;
  }
  // Prefer active over outdated when trimming.
  out.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
  return out.slice(0, max);
}

// Post ONE comment to a PR. Anchored (filePath + rightLine) → single inline
// review comment on head.sha, RIGHT side. Unanchored → issue comment. Mirrors
// azdo.createPrThread's per-thread contract; the validated all-or-nothing batch
// review is a separate Phase-4 path.
async function createPrThread(owner, _project, repo, prId, { content, filePath, rightLine } = {}) {
  if (filePath) {
    const pr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`);
    const sha = (pr.head && pr.head.sha) || '';
    const line = parseInt(rightLine, 10);
    const body = { body: String(content || ''), commit_id: sha, path: String(filePath).replace(/^\/+/, ''), side: 'RIGHT' };
    if (line > 0) body.line = line;
    return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/comments`, { method: 'POST', body });
  }
  return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prId)}/comments`, { method: 'POST', body: { body: String(content || '') } });
}

// Post a batch review with N validated inline comments in one call (R2). Caller
// pre-validates lines against the diff; unanchored findings fold into `bodyText`.
async function createReview(owner, _project, repo, prId, { comments = [], bodyText = '', commitId } = {}) {
  let sha = commitId;
  if (!sha) {
    const pr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`);
    sha = (pr.head && pr.head.sha) || '';
  }
  const body = {
    event: 'COMMENT',
    commit_id: sha,
    body: bodyText || undefined,
    comments: comments.map(c => ({ path: String(c.filePath || c.path).replace(/^\/+/, ''), line: parseInt(c.rightLine || c.line, 10), side: 'RIGHT', body: String(c.content || c.body || '') }))
  };
  return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/reviews`, { method: 'POST', body });
}

// Map a check-run/status to the shared validation enum.
function _checkState(run) {
  if (run.status && run.status !== 'completed') return 'pending';
  switch (String(run.conclusion || '').toLowerCase()) {
    case 'success': return 'succeeded';
    case 'failure': return 'failed';
    case 'timed_out': case 'cancelled': case 'stale': case 'startup_failure': return 'error';
    case 'action_required': return 'pending';
    case 'neutral': case 'skipped': return 'notApplicable';
    default: return 'notSet';
  }
}

// CI checks + commit statuses on the PR head, normalized like getPrStatuses.
async function getPrStatuses(owner, _project, repo, prId) {
  const pr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`);
  const sha = (pr.head && pr.head.sha) || '';
  if (!sha) return [];
  const out = [];
  try {
    const cr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs`);
    for (const run of (cr.check_runs || [])) {
      out.push({
        id: run.id,
        state: _checkState(run),
        genre: 'check',
        name: run.name || '',
        description: (run.output && run.output.title) || run.conclusion || run.status || '',
        targetUrl: run.html_url || '',
        creationDate: run.started_at || run.completed_at || ''
      });
    }
  } catch {}
  try {
    const st = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/status`);
    for (const s of (st.statuses || [])) {
      const map = { success: 'succeeded', failure: 'failed', error: 'error', pending: 'pending' };
      out.push({
        id: s.id,
        state: map[String(s.state).toLowerCase()] || 'notSet',
        genre: 'status',
        name: s.context || '',
        description: s.description || '',
        targetUrl: s.target_url || '',
        creationDate: s.updated_at || s.created_at || ''
      });
    }
  } catch {}
  return out.sort((a, b) => `${a.genre}${a.name}`.localeCompare(`${b.genre}${b.name}`));
}

// Fetch branch protection, distinguishing "no protection" (404 → known, empty
// requirements) from "cannot read" (403 → unknown; readiness must degrade to
// null, never assert ready — R4). Returns { known, protection }.
async function _branchProtection(owner, repo, branch) {
  if (!branch) return { known: true, protection: null };
  try {
    const p = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}/protection`);
    return { known: true, protection: p };
  } catch (e) {
    const msg = String(e && e.message || '');
    // 404 = branch simply not protected → a KNOWN state (no required gates).
    if (/\(404\)/.test(msg) || /not found/i.test(msg)) return { known: true, protection: null };
    // 403 (or anything else) = we can't tell → unknown.
    return { known: false, protection: null };
  }
}

// Readiness signals (R4): NEVER derived from mergeable_state alone. Computes a
// verdict from discrete signals — mergeable (retry on null), branch-protection
// required contexts, combined check states, latest non-dismissed review per
// reviewer (changes-requested / required approving count), draft, up-to-date,
// conflicts. If branch protection can't be read (403) → ready = null (unknown),
// never true. Returns the azdo-shaped { evaluations, ready, builds } so the
// server's existing validation/readiness normalization works unchanged: the
// Status-type evaluations carry statusGenre/statusName/blocking (feeding the
// required-check marking) and the non-status gates surface as policy gates.
async function getPrPolicyEvaluations(owner, _project, prId, repo) {
  // Note: repo is passed in the 4th slot to keep the azdo (org,project,prId,projectId)
  // arity; server dispatch supplies repo here for GitHub.
  const evaluations = [];
  let pr;
  try { pr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`); }
  catch { return { evaluations, ready: null, builds: [] }; }

  // mergeable is computed async by GitHub — retry once on null before trusting it.
  let mergeable = pr.mergeable;
  if (mergeable === null || mergeable === undefined) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const pr2 = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`);
      mergeable = pr2.mergeable;
      if (pr2.mergeable_state) pr.mergeable_state = pr2.mergeable_state;
    } catch {}
  }
  const mergeableState = String(pr.mergeable_state || '').toLowerCase();
  const baseRef = (pr.base && pr.base.ref) || '';
  const isDraft = !!pr.draft;

  // Latest non-dismissed review per reviewer → approvals + changes-requested.
  let approvals = 0, changesRequested = false;
  try {
    const reviews = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/reviews`, { cap: 200 });
    const latest = new Map();
    for (const rv of reviews) {
      const login = (rv.user && rv.user.login) || '';
      const st = String(rv.state || '').toUpperCase();
      if (!login || st === 'PENDING' || st === 'COMMENTED') continue;
      latest.set(login, st); // chronological → last meaningful wins
    }
    for (const st of latest.values()) {
      if (st === 'APPROVED') approvals++;
      else if (st === 'CHANGES_REQUESTED') changesRequested = true;
    }
  } catch {}

  // Branch protection → required contexts, required approving count, strict.
  const { known: protectionKnown, protection } = await _branchProtection(owner, repo, baseRef);
  const rsc = (protection && protection.required_status_checks) || null;
  const requiredContexts = rsc
    ? (Array.isArray(rsc.contexts) && rsc.contexts.length
        ? rsc.contexts
        : (Array.isArray(rsc.checks) ? rsc.checks.map(c => c.context).filter(Boolean) : []))
    : [];
  const strict = !!(rsc && rsc.strict);
  const requiredApprovals = (protection && protection.required_pull_request_reviews
    && Number(protection.required_pull_request_reviews.required_approving_review_count)) || 0;

  // Required status contexts → Status-type evaluations (both possible genres, so
  // the server marks the matching check-run OR commit status as Required). Their
  // own status value is unused by the server (only `blocking` is read).
  for (const ctx of requiredContexts) {
    evaluations.push({ type: 'Status', statusGenre: 'check', statusName: ctx, blocking: true, status: 'notapplicable' });
    evaluations.push({ type: 'Status', statusGenre: 'status', statusName: ctx, blocking: true, status: 'notapplicable' });
  }

  // Required approvals gate (visible policy gate).
  if (requiredApprovals > 0) {
    evaluations.push({
      type: 'Minimum number of reviewers',
      displayName: `Required approvals (${approvals}/${requiredApprovals})`,
      blocking: true,
      status: approvals >= requiredApprovals ? 'approved' : 'running'
    });
  }
  // Changes requested → blocking rejected gate.
  if (changesRequested) {
    evaluations.push({ type: 'Code review', displayName: 'Changes requested', blocking: true, status: 'rejected' });
  }
  // Branch must be up to date with base (only when protection requires it).
  if (strict && mergeableState === 'behind') {
    evaluations.push({ type: 'Require branches up to date', displayName: 'Branch must be up to date', blocking: true, status: 'rejected' });
  }
  // Merge conflicts (independent of protection).
  if (mergeable === false || mergeableState === 'dirty') {
    evaluations.push({ type: 'Merge conflicts', displayName: 'Merge conflicts must be resolved', blocking: true, status: 'rejected' });
  }

  // Required check states (for the readiness verdict): match each required
  // context to an actual check-run / commit status by name.
  let requiredChecksOk = true, requiredChecksKnown = true;
  if (requiredContexts.length) {
    let statuses = [];
    try { statuses = await getPrStatuses(owner, '', repo, prId); } catch { requiredChecksKnown = false; }
    const byName = new Map();
    for (const s of statuses) {
      const prev = byName.get(s.name);
      // worst-of when a context appears as both a check and a status
      const rank = { failed: 3, error: 3, pending: 2, notSet: 1, notApplicable: 0, succeeded: 0 };
      if (!prev || (rank[s.state] || 0) > (rank[prev] || 0)) byName.set(s.name, s.state);
    }
    for (const ctx of requiredContexts) {
      const st = byName.get(ctx);
      if (st === undefined) { requiredChecksOk = false; continue; } // required but not yet reported
      if (st !== 'succeeded' && st !== 'notApplicable') requiredChecksOk = false;
    }
  }

  // Readiness verdict (R4). Unknown (null) when protection unreadable (403) or
  // mergeability is still indeterminate after retry — never assert ready then.
  let ready;
  if (!protectionKnown || mergeable === null || mergeable === undefined || !requiredChecksKnown) {
    ready = null;
  } else {
    ready = !isDraft
      && mergeable === true
      && !changesRequested
      && approvals >= requiredApprovals
      && requiredChecksOk
      && !(strict && mergeableState === 'behind');
  }

  return { evaluations, ready, builds: [] };
}

async function getPrChangedFiles(owner, _project, repo, prId, limit = 100) {
  const files = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}/files`, { cap: limit });
  const out = [];
  for (const f of files) {
    if (f.status === 'removed') continue;
    if (f.filename) out.push('/' + f.filename);
    if (out.length >= limit) break;
  }
  return out;
}

// Issues linked from a PR body (Closes #n / #n). Returns compact issue shape.
async function getPrWorkItems(owner, _project, repo, prId) {
  let pr;
  try { pr = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`); } catch { return []; }
  const body = pr.body || '';
  const nums = new Set();
  const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)?\s*#(\d+)/gi;
  let m; while ((m = re.exec(body))) nums.add(Number(m[1]));
  const out = [];
  for (const n of [...nums].slice(0, 20)) {
    try {
      const it = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${n}`);
      if (it.pull_request) continue; // skip PRs masquerading as issues
      out.push({ id: it.number, title: it.title || '', state: it.state || '', type: 'Issue', url: it.html_url });
    } catch {}
  }
  return out;
}

// Issue (GitHub "work item") — repo-scoped: (owner, repo, number).
async function getWorkItem(owner, repo, number) {
  const it = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`);
  const labels = (it.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  return {
    id: it.number,
    title: it.title || '',
    state: it.state || '',
    type: it.pull_request ? 'PullRequest' : 'Issue',
    assignedTo: (it.assignee && it.assignee.login) || ((it.assignees || [])[0] && it.assignees[0].login) || '',
    tags: labels.join('; '),
    description: it.body || '',
    url: it.html_url
  };
}

async function getWorkItemComments(owner, repo, number, { top = 20 } = {}) {
  let all = [];
  try { all = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`, { cap: 200 }); }
  catch { return { count: 0, comments: [] }; }
  const comments = all
    .map(c => ({ id: c.id, author: (c.user && c.user.login) || '', date: c.created_at || '', text: String(c.body || '').trim() }))
    .filter(c => c.text)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, top);
  return { count: all.length, comments };
}

async function updateWorkItemState(owner, repo, number, state) {
  // GitHub issues are open|closed. Map any "done/closed/resolved" to closed.
  const s = /clos|done|resolv|complet/i.test(state) ? 'closed' : 'open';
  const it = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`, { method: 'PATCH', body: { state: s } });
  return { id: it.number, title: it.title || '', state: it.state || '', url: it.html_url };
}

// Assigned issues for the current user (parity stub). The only live call site is
// the Connect/standup ADO collector, which is AzDo-only by design and never
// forge-dispatches to GitHub — so this exists solely to keep forge dispatch
// total (R12). Returns issues assigned to the authenticated user across the
// owner's repos in the window; best-effort, never throws.
async function listMyWorkItems(owner, _project, { start, end } = {}) {
  try {
    const me = await getCurrentUser();
    const login = me && me.login;
    if (!login) return [];
    const parts = [`assignee:${login}`, 'is:issue'];
    if (owner) parts.push(`user:${owner}`);
    if (start) parts.push(`updated:>=${String(start).slice(0, 10)}`);
    const q = encodeURIComponent(parts.join(' '));
    const data = await api(`/search/issues?q=${q}&per_page=50`).catch(() => null);
    const items = (data && data.items) || [];
    return items.map(it => ({
      id: it.number,
      title: it.title || '',
      state: it.state || '',
      type: 'Issue',
      assignedTo: (it.assignee && it.assignee.login) || login,
      changedDate: it.updated_at || '',
      createdDate: it.created_at || '',
      closedDate: it.closed_at || '',
      url: it.html_url
    }));
  } catch { return []; }
}

// Epics don't exist on GitHub — keep parity honest (AzDo-only feature).
const EPIC_TYPES = [];
async function searchEpics() {
  throw new Error('Epics are an Azure DevOps concept; GitHub has no Epic work-item type.');
}

// ---- Contributors --------------------------------------------------------

async function getRepoContributors(owner, _project, repo, days = 60, top = 300) {
  try {
    const contrib = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors`, { cap: top });
    return contrib
      .map(c => ({ name: c.login || '', email: '', login: c.login || '', count: c.contributions || 0 }))
      .filter(c => c.name)
      .sort((a, b) => b.count - a.count);
  } catch { return []; }
}

async function getFileContributors(owner, _project, repo, filePath, days = 60, top = 30) {
  if (!filePath) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    const commits = await apiAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(filePath.replace(/^\//, ''))}&since=${since}`, { cap: top * 5 });
    const tally = new Map();
    for (const c of commits) {
      const login = (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || '';
      const email = (c.commit && c.commit.author && c.commit.author.email) || '';
      if (!login) continue;
      const key = login.toLowerCase();
      const cur = tally.get(key) || { name: login, email, login, count: 0 };
      cur.count++; tally.set(key, cur);
    }
    return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, top);
  } catch { return []; }
}

// ---- Tree + content (for discovery / materialization) --------------------

function _blobItems(tree) {
  // Normalize GitHub tree entries to the azdo-like { path:'/a/b', objectId, gitObjectType }.
  return (tree || [])
    .filter(i => i.type === 'blob')
    .map(i => ({ path: '/' + i.path, objectId: i.sha, gitObjectType: 'blob' }));
}

async function getTree(owner, _project, repo, branch) {
  const r = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const data = await api(r);
  let items = _blobItems(data.tree);
  // R13: recursive tree truncates on large monorepos. Supplement with a targeted
  // recursive fetch of the top-level `.github` folder so agent/plugin discovery
  // still works even when the full tree was cut off.
  if (data.truncated) {
    const gh = (data.tree || []).find(t => t.type === 'tree' && t.path === '.github');
    if (gh && gh.sha) {
      try {
        const sub = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${gh.sha}?recursive=1`);
        const subItems = (sub.tree || [])
          .filter(i => i.type === 'blob')
          .map(i => ({ path: '/.github/' + i.path, objectId: i.sha, gitObjectType: 'blob' }));
        const seen = new Set(items.map(x => x.path));
        for (const it of subItems) if (!seen.has(it.path)) items.push(it);
      } catch {}
    }
  }
  return items;
}

async function getFileText(owner, _project, repo, branch, itemPath) {
  const p = String(itemPath).replace(/^\/+/, '');
  return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { accept: 'application/vnd.github.raw' });
}

async function getObjectId(owner, _project, repo, branch, itemPath) {
  const p = String(itemPath).replace(/^\/+/, '');
  try {
    const r = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    return r.sha || null;
  } catch { return null; }
}

// ---- Discovery (agents/plugins under any .github folder) -----------------

function parseFrontmatter(content) {
  const fm = content.replace(/\r\n/g, '\n').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const block = fm[1];
  const name = (block.match(/^name:\s*['"]?([^'"\n]+)/m) || [])[1];
  const description = (block.match(/^description:\s*['"]?([^'"\n]+)/m) || [])[1];
  return { name: name && name.trim(), description: description && description.trim() };
}
function titleCase(id) {
  return String(id || '').split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
const AGENT_RE = /(^|\/)\.github\/agents\/([^/]+)\.md$/i;
const PLUGIN_JSON_RE = /(^|\/)\.github\/plugin\/([^/]+)\/plugin\.json$/i;

function pluginSignature(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  const lines = list.map(f => `${f.path}:${f.objectId || ''}`).sort().join('\n');
  return crypto.createHash('sha1').update(lines).digest('hex');
}

async function discover(owner, _project, repo, branch) {
  const tree = await getTree(owner, '', repo, branch);
  const discovered = [];
  for (const it of tree.filter(i => AGENT_RE.test(i.path))) {
    const p = it.path.replace(/^\//, '');
    let meta = {};
    try { meta = parseFrontmatter(await getFileText(owner, '', repo, branch, it.path)); } catch {}
    const baseName = path.basename(p).replace(/\.md$/i, '');
    const id = (meta.name || baseName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    discovered.push({ kind: 'agent', id, agentRef: meta.name || baseName, name: meta.name || baseName, displayName: titleCase(meta.name || baseName), description: meta.description || '', path: p, objectId: it.objectId });
  }
  for (const it of tree.filter(i => PLUGIN_JSON_RE.test(i.path))) {
    const pjPath = it.path.replace(/^\//, '');
    const pluginRoot = pjPath.replace(/\/plugin\.json$/i, '');
    let pj = {};
    try { pj = JSON.parse(await getFileText(owner, '', repo, branch, it.path)); } catch {}
    const folderName = path.basename(pluginRoot);
    const id = (pj.name || folderName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const files = tree.filter(f => { const fp = f.path.replace(/^\//, ''); return fp === pluginRoot || fp.startsWith(pluginRoot + '/'); }).map(f => ({ path: f.path.replace(/^\//, ''), objectId: f.objectId }));
    const hasMcp = files.some(f => /(^|\/)\.mcp\.json$/i.test(f.path));
    discovered.push({ kind: 'plugin', id, name: pj.name || folderName, displayName: titleCase(pj.name || folderName), description: pj.description || '', version: pj.version || '', path: pluginRoot, objectId: pluginSignature(files) || it.objectId, pluginJsonObjectId: it.objectId, hasMcp, files });
  }
  return discovered.sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
}

// ---- Materialization -----------------------------------------------------

function sanitize(v) { return String(v || '').replace(/[^A-Za-z0-9._-]+/g, '_'); }
function repoRoot(owner, _project, repo, branch) {
  return path.join(GITHUB_STORE, sanitize(owner), sanitize(repo), sanitize(branch));
}
async function writeFileFromRepo(owner, repo, branch, root, relPath) {
  const content = await getFileText(owner, '', repo, branch, '/' + relPath.replace(/^\//, ''));
  const dest = path.join(root, relPath.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return dest;
}

async function materializeAgent(owner, _project, repo, branch, agentPath) {
  const root = repoRoot(owner, '', repo, branch);
  const rel = agentPath.replace(/^\//, '');
  await writeFileFromRepo(owner, repo, branch, root, rel);
  const ghIdx = rel.toLowerCase().indexOf('.github/');
  const cwdRel = ghIdx > 0 ? rel.slice(0, ghIdx).replace(/\/$/, '') : '';
  const cwd = cwdRel ? path.join(root, cwdRel.replace(/\//g, path.sep)) : root;
  const base = cwdRel ? cwdRel.replace(/\/$/, '') + '/' : '';
  let mcpConfig = null, skillCount = 0;
  try {
    const tree = await getTree(owner, '', repo, branch);
    const inBase = p => (base ? p.startsWith(base) : true);
    const wanted = [];
    for (const it of tree) {
      const p = it.path.replace(/^\//, '');
      if (!inBase(p)) continue;
      const sub = base ? p.slice(base.length) : p;
      if (/^\.mcp\.json$/i.test(sub) || /^\.github\/\.mcp\.json$/i.test(sub)) wanted.push(p);
      else if (/^(\.github\/)?skills\//i.test(sub)) wanted.push(p);
    }
    for (const w of wanted) { await writeFileFromRepo(owner, repo, branch, root, w); if (/(^|\/)SKILL\.md$/i.test(w)) skillCount++; }
    const mcpAbs = path.join(cwd, '.mcp.json');
    if (fs.existsSync(mcpAbs)) mcpConfig = mcpAbs;
  } catch {}
  return { cwd, agentMdPath: path.join(root, rel.replace(/\//g, path.sep)), mcpConfig, skillCount };
}

async function materializePlugin(owner, _project, repo, branch, item) {
  const root = repoRoot(owner, '', repo, branch);
  const pluginDir = path.join(root, item.path.replace(/\//g, path.sep));
  try { if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true }); } catch {}
  const files = item.files && item.files.length
    ? item.files
    : (await getTree(owner, '', repo, branch))
        .filter(f => { const fp = f.path.replace(/^\//, ''); return fp === item.path || fp.startsWith(item.path + '/'); })
        .map(f => ({ path: f.path.replace(/^\//, '') }));
  for (const f of files) await writeFileFromRepo(owner, repo, branch, root, f.path);
  const mcpAbs = path.join(pluginDir, '.mcp.json');
  return { pluginDir, mcpConfig: fs.existsSync(mcpAbs) ? mcpAbs : null };
}

// ---- Write helpers (PR create / push) ------------------------------------

async function createPullRequest(owner, _project, repo, { sourceBranch, targetBranch, title, description } = {}) {
  const d = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    body: { title: title || 'Update', head: sourceBranch, base: targetBranch, body: description || '' }
  });
  return { id: d.number, url: d.html_url, webUrl: d.html_url };
}

// Commit a set of file changes onto a new branch via the git data API.
// changes: [{ path, content }]. Creates newBranch from baseBranch's tip.
async function pushFiles(owner, _project, repo, { baseBranch, newBranch, changes, commitMessage } = {}) {
  const R = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const baseRef = await api(`${R}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await api(`${R}/git/commits/${baseSha}`);
  const baseTree = baseCommit.tree.sha;
  const treeItems = [];
  for (const ch of (changes || [])) {
    const blob = await api(`${R}/git/blobs`, { method: 'POST', body: { content: ch.content, encoding: 'utf-8' } });
    treeItems.push({ path: String(ch.path).replace(/^\//, ''), mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await api(`${R}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree: treeItems } });
  const commit = await api(`${R}/git/commits`, { method: 'POST', body: { message: commitMessage || 'Update', tree: newTree.sha, parents: [baseSha] } });
  try {
    await api(`${R}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${newBranch}`, sha: commit.sha } });
  } catch {
    await api(`${R}/git/refs/heads/${encodeURIComponent(newBranch)}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
  }
  return { branch: newBranch, commit: commit.sha };
}

module.exports = {
  HOST,
  GITHUB_STORE,
  getToken,
  getCurrentUser,
  voteLabel,
  getRepoContributors,
  getFileContributors,
  getPrChangedFiles,
  listPullRequests,
  listProjectPullRequests,
  getPrThreads,
  getPrActiveThreads,
  createPrThread,
  createReview,
  getPrStatuses,
  getPrPolicyEvaluations,
  listRepos,
  listBranches,
  discover,
  pluginSignature,
  getTree,
  getFileText,
  materializeAgent,
  materializePlugin,
  getObjectId,
  repoRoot,
  getRepo,
  getRefObjectId,
  pushFiles,
  createPullRequest,
  cloneUrl,
  workItemUrl,
  pullRequestUrl,
  getWorkItem,
  getWorkItemComments,
  searchEpics,
  EPIC_TYPES,
  getPrWorkItems,
  updateWorkItemState,
  listMyWorkItems,
  getPullRequest
};
