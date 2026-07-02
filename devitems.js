// Dev item git layer: app-managed clone + per-item worktree, status, sync.
//
// Model (chosen design): the app maintains ONE managed clone per AzDo repo
// under SUPERVISOR_DATA_DIR/dev-repos/<org>/<project>/<repo>, then adds a git
// worktree per Dev item under SUPERVISOR_DATA_DIR/dev-worktrees/<repo>__<devId>.
// This keeps every Dev item self-contained and avoids touching the user's own
// checkouts.
//
// Auth: network git operations (clone/fetch/pull) inject the Azure DevOps AAD
// bearer token from azdo.getToken() as a one-shot `http.extraheader`, so it
// works regardless of Git Credential Manager / stored PATs. The token is never
// written to disk or into the remote URL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const azdo = require('./azdo');
const { forge } = require('./forge');

let SUPERVISOR_DATA_DIR;
try {
  SUPERVISOR_DATA_DIR = require('./config-sync').SUPERVISOR_DATA_DIR;
} catch {
  SUPERVISOR_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
}

const DEV_REPOS = path.join(SUPERVISOR_DATA_DIR, 'dev-repos');
const DEV_WORKTREES = path.join(SUPERVISOR_DATA_DIR, 'dev-worktrees');

// Where new worktrees are created. Prefers the user's configured `worktreeRoot`
// setting; otherwise a SHORT auto path (e.g. C:\a) to maximize Windows MAX_PATH
// (260) headroom for deep repos/obj paths. Existing worktree records store
// absolute paths, so only NEW worktrees follow a changed root. Never throws.
function _shortDefaultRoot() {
  try {
    if (process.platform === 'win32') {
      const root = path.parse(SUPERVISOR_DATA_DIR).root || 'C:\\';
      return path.join(root, 'a');
    }
  } catch {}
  return DEV_WORKTREES;
}

function worktreeRoot() {
  try {
    const s = require('./settings').getSettings();
    const r = s && typeof s.worktreeRoot === 'string' ? s.worktreeRoot.trim() : '';
    if (r) return r;
  } catch {}
  return _shortDefaultRoot();
}

function _safe(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function clonePath(org, project, repo, provider) {
  // GitHub sources live under a dedicated github/<owner>/<repo> subtree (GitHub
  // has no "project"); Azure DevOps keeps its <org>/<project>/<repo> layout.
  if (String(provider || '').toLowerCase() === 'github') {
    return path.join(DEV_REPOS, 'github', _safe(org), _safe(repo));
  }
  return path.join(DEV_REPOS, _safe(org), _safe(project), _safe(repo));
}

function worktreePath(repo, devId) {
  return path.join(worktreeRoot(), _safe(repo) + '__' + _safe(devId));
}

// Build host-scoped git auth args for the record's provider (R10 — the
// credential header only applies to that host so a mixed-provider environment
// can't leak one provider's token to another). AzDo uses a bearer token; GitHub
// uses HTTP basic with x-access-token (the gh/OAuth token as the password).
// `desc` is a {provider, org/owner, project, repo} record; null/true => azdo.
function _authArgs(desc) {
  const provider = String((desc && desc.provider) || 'azdo').toLowerCase();
  if (provider === 'github') {
    const token = forge(desc).getToken();
    const basic = Buffer.from('x-access-token:' + token).toString('base64');
    return ['-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + basic];
  }
  return ['-c', 'http.extraheader=AUTHORIZATION: bearer ' + azdo.getToken()];
}

// Run a git command, throwing on failure with a clean message.
function _git(args, cwd, { auth = false, timeout = 240_000 } = {}) {
  // core.longpaths=true makes git use the \\?\ prefix so deep repo paths
  // (e.g. dotnet-helix-machines) don't exceed the Windows MAX_PATH (260) limit
  // during clone + worktree checkout.
  // `auth` may be false, true (=> azdo default), or a provider descriptor.
  const authArgs = auth ? _authArgs(auth === true ? null : auth) : [];
  const full = ['-c', 'core.longpaths=true'].concat(authArgs).concat(args);
  try {
    return execFileSync('git', full, {
      cwd: cwd || undefined,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }).toString();
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString().trim();
    const safeArgs = args.join(' ');
    throw new Error(`git ${safeArgs} failed: ${err.split('\n').slice(-3).join(' ').slice(0, 400)}`);
  }
}

// Run a git command without throwing. Returns { ok, out, err }.
function _gitTry(args, cwd, opts = {}) {
  try {
    return { ok: true, out: _git(args, cwd, opts).trim(), err: '' };
  } catch (e) {
    return { ok: false, out: '', err: (e.message || '').toString() };
  }
}

function _isRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// Ensure the managed clone exists and is fetched. Returns the clone path.
// `desc` (optional) carries {provider, org/owner, project, repo}; when absent
// the record is treated as Azure DevOps (back-compat with positional callers).
function ensureClone(org, project, repo, desc) {
  const provider = String((desc && desc.provider) || 'azdo').toLowerCase();
  const auth = desc || true;
  const dir = clonePath(org, project, repo, provider);
  if (_isRepo(dir)) {
    _gitTry(['fetch', '--prune', 'origin'], dir, { auth });
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // Both providers expose cloneUrl(org/owner, project, repo) (GitHub ignores project).
  const url = forge(desc).cloneUrl(org, project, repo);
  _git(['clone', url, dir], path.dirname(dir), { auth });
  return dir;
}

// Create (or reuse) a worktree for a Dev item. Returns { worktreePath, branch, reused }.
function createWorktree({ org, project, repo, baseBranch, branch, devId, detach, provider }) {
  const desc = provider ? { provider, org, project, repo } : null;
  const clone = ensureClone(org, project, repo, desc);
  const base = (baseBranch || '').trim() || 'main';
  const br = (branch || '').trim() || ('dev/' + _safe(devId));
  const wt = worktreePath(repo, devId);

  if (_isRepo(wt)) {
    return { worktreePath: wt, branch: br, reused: true };
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });

  // Clear any stale worktree registrations (e.g. a prior worktree dir that was deleted
  // out from under git) so re-adding a branch whose old worktree is gone won't fail with
  // "already checked out" / "missing but locked".
  _gitTry(['worktree', 'prune'], clone);

  // Detached/read-only review checkout: snapshot the branch tip without occupying the
  // branch name, so it never collides with another worktree (e.g. a dev card) that has
  // the same branch checked out. Used for PR review worktrees.
  if (detach) {
    const ref = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok
      ? 'origin/' + br
      : (_gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok
        ? br
        : (_gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + base], clone).ok ? 'origin/' + base : base));
    _git(['worktree', 'add', '--detach', wt, ref], clone);
    return { worktreePath: wt, branch: br, reused: false, detached: true };
  }

  // Does the branch already exist locally in the managed clone? This happens when a
  // worktree was created before and later removed (remove-worktree deletes the worktree
  // dir but leaves the local branch behind). Attach the existing branch instead of
  // trying to (re-)create it, which would fail with "a branch named '…' already exists".
  const localHas = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok;
  // Does the branch already exist on origin?
  const remoteHas = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok;
  if (localHas) {
    // Check out the pre-existing local branch into the new worktree (no -b/-B so we
    // don't discard any local commits the branch already carries).
    _git(['worktree', 'add', wt, br], clone);
  } else if (remoteHas) {
    // Track the existing remote branch.
    _git(['worktree', 'add', '--track', '-B', br, wt, 'origin/' + br], clone);
  } else {
    // Brand-new branch off the base; no upstream yet (status compares vs origin/base).
    const baseRef = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + base], clone).ok
      ? 'origin/' + base : base;
    _git(['worktree', 'add', '-b', br, wt, baseRef], clone);
  }
  return { worktreePath: wt, branch: br, reused: false };
}

// Compute ahead/behind/dirty for a worktree. Optionally fetch first.
function worktreeStatus(wt, { fetch = true, baseBranch = 'main' } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });

  const branch = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt).out || '';
  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  const compare = up.ok && up.out ? '@{u}' : ('origin/' + (baseBranch || 'main'));

  let ahead = 0, behind = 0, comparable = false;
  const counts = _gitTry(['rev-list', '--left-right', '--count', compare + '...HEAD'], wt);
  if (counts.ok) {
    const m = counts.out.split(/\s+/);
    behind = parseInt(m[0], 10) || 0;
    ahead = parseInt(m[1], 10) || 0;
    comparable = true;
  }
  // Exclude agent-generated status reports (IMPLEMENTATION_SUMMARY.md, etc.) from
  // the dirty signal — they're surfaced on the card but intentionally never
  // committed, so they must not light up the worktree as "dirty".
  const cls = classifyPorcelain(_gitTry(['status', '--porcelain'], wt).out || '');
  const dirty = cls.dirty;
  // HEAD commit sha — lets callers detect a new commit even when ahead/behind
  // don't move (e.g. an amend, or a commit that also pulled base in).
  const head = _gitTry(['rev-parse', 'HEAD'], wt).out || '';

  return {
    branch, head,
    upstream: up.ok ? up.out : '',
    tracking: compare === '@{u}' ? (up.out || '') : compare,
    ahead, behind, comparable, dirty,
    ignoredReports: cls.ignored,
    lastChecked: new Date().toISOString()
  };
}

// Detailed commit-level view of a worktree branch vs its tracked remote — the
// branch's own origin/<branch> when an upstream exists, else origin/<baseBranch>.
// Lets the UI show exactly which commits are local-only (unpushed), which exist
// on the remote but are missing locally (behind), and a recent-history list with
// each commit tagged pushed/local. For a branch with an open PR the upstream IS
// the PR's source branch, so this doubles as "local worktree vs PR branch".
// Never throws; returns null when the path is not a repo.
function branchCommits(wt, { baseBranch = 'main', limit = 40, fetch = false } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });
  const branch = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt).out || '';
  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  const hasUpstream = up.ok && !!up.out;
  const tracking = hasUpstream ? up.out : ('origin/' + (baseBranch || 'main'));
  const trackingExists = _gitTry(['rev-parse', '--verify', '--quiet', tracking], wt).ok;
  const SEP = '\x1f';
  const FMT = ['%H', '%h', '%s', '%an', '%aI'].join(SEP);
  const parse = (out) => String(out || '').split('\n').filter(Boolean).map((l) => {
    const [sha, short, subject, author, date] = l.split(SEP);
    return { sha, short, subject, author, date };
  });
  let ahead = [], behind = [];
  if (trackingExists) {
    ahead = parse(_gitTry(['log', tracking + '..HEAD', '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
    behind = parse(_gitTry(['log', 'HEAD..' + tracking, '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
  }
  const recent = parse(_gitTry(['log', 'HEAD', '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
  const aheadSet = new Set(ahead.map((c) => c.sha));
  for (const c of recent) c.pushed = trackingExists ? !aheadSet.has(c.sha) : false;
  return {
    branch, tracking, hasUpstream, trackingExists,
    ahead, behind, recent,
    aheadCount: ahead.length, behindCount: behind.length,
    truncated: recent.length >= limit,
    lastChecked: new Date().toISOString()
  };
}

// Fetch + fast-forward the worktree. Returns { ok, message, status }.
function syncWorktree(wt, { baseBranch = 'main' } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to sync.' };
  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });

  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  let res;
  if (up.ok && up.out) {
    res = _gitTry(['pull', '--ff-only'], wt, { auth: true });
  } else {
    // No upstream: fast-forward onto the base branch instead.
    res = _gitTry(['merge', '--ff-only', 'origin/' + (baseBranch || 'main')], wt);
  }
  const status = worktreeStatus(wt, { fetch: false, baseBranch });
  if (!res.ok) {
    const diverged = /non-fast-forward|not possible to fast-forward|diverging|diverge/i.test(res.err);
    return {
      ok: false,
      message: diverged
        ? 'Branches have diverged — a fast-forward sync is not possible. Resolve locally (rebase/merge).'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Sync failed.'),
      status
    };
  }
  return { ok: true, message: 'Up to date with origin.', status };
}

// Truncate a patch to a character budget on a line boundary, with a marker.
function _capPatch(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut) +
    '\n… [diff truncated, ' + (s.length - maxChars) + ' more chars]';
}

// Pathspecs for noisy/generated files we never want to spend the diff budget on.
const _DIFF_EXCLUDES = [
  ':(exclude)**/package-lock.json',
  ':(exclude)**/yarn.lock',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)**/*.min.js',
  ':(exclude)**/*.map',
  ':(exclude)**/dist/**',
  ':(exclude)**/build/**'
];

// A textual summary of the code state for the AI summary prompt. Includes the
// actual patch hunks (committed-vs-base, staged, and unstaged) so the model can
// reason about WHAT changed, not just which files — each section bounded by a
// character budget so the overall prompt stays manageable.
function diffSummary(wt, { baseBranch = 'main', maxLines = 40, maxDiffChars = 9000 } = {}) {
  if (!wt || !_isRepo(wt)) return '';
  const base = 'origin/' + (baseBranch || 'main');
  const out = [];

  // High-level overview: which files changed vs base + how much churn.
  const stat = _gitTry(['diff', '--stat', base + '...HEAD'], wt);
  if (stat.ok && stat.out) {
    out.push('Changed files (git diff --stat vs ' + base + '):');
    out.push(stat.out.split('\n').slice(0, maxLines).join('\n'));
  }

  // Commits unique to this branch.
  const log = _gitTry(['log', '--oneline', '-15', base + '..HEAD'], wt);
  if (log.ok && log.out) {
    out.push('');
    out.push('Recent commits on this branch:');
    out.push(log.out);
  }

  // The actual committed change set vs base — the primary "what changed" patch.
  const committed = _gitTry(['diff', '--unified=3', base + '...HEAD', '--'].concat(_DIFF_EXCLUDES), wt);
  if (committed.ok && committed.out && committed.out.trim()) {
    out.push('');
    out.push('Committed changes vs ' + base + ' (patch):');
    out.push(_capPatch(committed.out, maxDiffChars));
  }

  // In-progress edits, split into staged vs unstaged so the model can tell them apart.
  const staged = _gitTry(['diff', '--staged', '--unified=3', '--'].concat(_DIFF_EXCLUDES), wt);
  if (staged.ok && staged.out && staged.out.trim()) {
    out.push('');
    out.push('Staged (not yet committed) changes (patch):');
    out.push(_capPatch(staged.out, Math.floor(maxDiffChars / 2)));
  }
  const unstaged = _gitTry(['diff', '--unified=3', '--'].concat(_DIFF_EXCLUDES), wt);
  if (unstaged.ok && unstaged.out && unstaged.out.trim()) {
    out.push('');
    out.push('Unstaged working changes (patch):');
    out.push(_capPatch(unstaged.out, Math.floor(maxDiffChars / 2)));
  }

  // Porcelain status catches untracked files (and anything excluded above).
  const dirty = _gitTry(['status', '--porcelain'], wt);
  if (dirty.ok && dirty.out) {
    out.push('');
    out.push('Working tree status (git status --porcelain):');
    out.push(dirty.out.split('\n').slice(0, maxLines).join('\n'));
  }

  return out.join('\n').trim();
}

// Push the worktree's current branch (or a given branch) to origin, with auth.
// Returns { ok, branch, message }.
function pushBranch(wt, { branch } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, branch: '', message: 'No worktree to push.' };
  let br = String(branch || '').trim();
  if (!br) {
    const cur = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
    br = cur.ok ? cur.out.trim() : '';
  }
  if (!br || br === 'HEAD') return { ok: false, branch: '', message: 'Could not determine the branch to push.' };
  const res = _gitTry(['push', '-u', 'origin', br], wt, { auth: true });
  return {
    ok: res.ok,
    branch: br,
    message: res.ok ? 'Pushed.' : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Push failed.')
  };
}

// Ensure the worktree has a committer identity so `git commit` won't fail on a
// machine with no global user.name/user.email. Sets a repo-local identity only
// when one is missing. Best-effort.
function _ensureGitIdentity(wt) {
  const name = _gitTry(['config', 'user.name'], wt);
  if (!name.ok || !name.out) _gitTry(['config', 'user.name', 'TheOffice.AI'], wt);
  const email = _gitTry(['config', 'user.email'], wt);
  if (!email.ok || !email.out) _gitTry(['config', 'user.email', 'noreply@theoffice.ai'], wt);
}

// Stage every change in the worktree and commit it. Used to make sure a user's
// uncommitted local edits are captured before a push / PR. Returns
// { ok, committed, files, message }. committed=false (ok:true) when nothing was
// staged (clean tree) — that is not an error.
// List a worktree's uncommitted changes, split into committable `changed` and
// ignorable agent-report `ignored`, each entry `{ path, xy }` where xy is the
// 2-char git porcelain status (e.g. " M", "??", "A "). Never throws.
function worktreeChanges(wt) {
  if (!wt || !_isRepo(wt)) return { dirty: false, changed: [], ignored: [] };
  const out = _gitTry(['status', '--porcelain'], wt).out || '';
  const changed = [], ignored = [];
  for (const raw of out.split('\n')) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    let p = raw.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    (isIgnorableReportPath(p) ? ignored : changed).push({ path: p, xy });
  }
  return { dirty: changed.length > 0, changed, ignored };
}

// Discard a worktree's uncommitted committable changes: hard-reset tracked edits
// and remove untracked files. Excluded agent reports (info/exclude) are left in
// place (git clean without -x skips ignored/excluded). Returns { ok, message }.
function discardWorktreeChanges(wt) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to clean.' };
  const reset = _gitTry(['reset', '--hard', 'HEAD'], wt);
  if (!reset.ok) return { ok: false, message: reset.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Reset failed.' };
  _gitTry(['clean', '-fd'], wt);  // remove untracked (keeps excluded reports)
  return { ok: true, message: 'Discarded uncommitted changes.' };
}

function commitAll(wt, { message } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, committed: false, files: 0, message: 'No worktree to commit.' };
  const before = (_gitTry(['status', '--porcelain'], wt).out || '');
  const files = before ? before.split(/\r?\n/).filter(Boolean).length : 0;
  if (!files) return { ok: true, committed: false, files: 0, message: 'Nothing to commit.' };
  _ensureGitIdentity(wt);
  const add = _gitTry(['add', '-A'], wt);
  if (!add.ok) return { ok: false, committed: false, files, message: add.err.slice(0, 300) || 'git add failed.' };
  const msg = String(message || '').trim() || 'Commit local changes';
  const res = _gitTry(['commit', '-m', msg], wt);
  if (!res.ok) return { ok: false, committed: false, files, message: res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Commit failed.' };
  return { ok: true, committed: true, files, message: 'Committed ' + files + ' change' + (files === 1 ? '' : 's') + '.' };
}

// Drift of a worktree vs a specific remote PR/source branch (origin/<branch>).
// Unlike worktreeStatus (which compares to @{u} or origin/base), this always
// compares the local HEAD to the PR's own source branch on origin — the right
// signal for "does my local checkout match the PR branch?". Optionally fetches.
// Returns { sourceBranch, localHead, remoteHead, ahead, behind, dirty, comparable, inSync, lastChecked } or null.
function prDrift(wt, sourceBranch, { fetch = true } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });
  const localHead = _gitTry(['rev-parse', 'HEAD'], wt).out || '';
  const remoteRef = src ? 'origin/' + src : '';
  const remoteHead = src ? (_gitTry(['rev-parse', '--verify', '--quiet', remoteRef], wt).out || '') : '';
  let ahead = 0, behind = 0, comparable = false;
  if (src && remoteHead) {
    const counts = _gitTry(['rev-list', '--left-right', '--count', remoteRef + '...HEAD'], wt);
    if (counts.ok) {
      const m = counts.out.split(/\s+/);
      behind = parseInt(m[0], 10) || 0;
      ahead = parseInt(m[1], 10) || 0;
      comparable = true;
    }
  }
  const cls = classifyPorcelain(_gitTry(['status', '--porcelain'], wt).out || '');
  const dirty = cls.dirty;
  const inSync = comparable && ahead === 0 && behind === 0 && !dirty;
  return {
    sourceBranch: src, localHead, remoteHead,
    ahead, behind, dirty, comparable, inSync,
    ignoredReports: cls.ignored,
    lastChecked: new Date().toISOString()
  };
}

// Push the worktree's current HEAD up to the PR's source branch on origin. Works
// even when the worktree is on a detached HEAD (review worktrees) by pushing
// `HEAD:refs/heads/<sourceBranch>`. Commits any uncommitted changes first so the
// user's full local state lands on the PR. Returns { ok, committed, files, message, drift }.
function pushPrBranch(wt, { sourceBranch, message } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to push.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src) return { ok: false, message: 'No PR source branch to push to.' };
  let committed = false, files = 0;
  const c = commitAll(wt, { message: message || ('Update ' + src) });
  if (!c.ok) return { ok: false, message: c.message };
  committed = c.committed; files = c.files;
  const res = _gitTry(['push', 'origin', 'HEAD:refs/heads/' + src], wt, { auth: true });
  if (!res.ok) {
    const nonff = /non-fast-forward|fetch first|rejected/i.test(res.err);
    return {
      ok: false, committed, files,
      message: nonff
        ? 'Push rejected — the PR branch has moved on the server. Sync your worktree first, then push.'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Push failed.')
    };
  }
  const drift = prDrift(wt, src, { fetch: true });
  return {
    ok: true, committed, files, drift,
    message: (committed ? ('Committed ' + files + ' change' + (files === 1 ? '' : 's') + ' and pushed.') : 'Pushed.')
  };
}

// Bring the worktree in line with the PR's source branch tip on origin by a hard
// reset. Intended for read-only review worktrees (no local work to preserve).
// Refuses when the local checkout has its own unpushed commits or uncommitted
// edits unless force=true, so a user's work is never silently discarded.
// Returns { ok, message, drift }.
function syncToPrBranch(wt, { sourceBranch, force = false } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to sync.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src) return { ok: false, message: 'No PR source branch to sync to.' };
  const pre = prDrift(wt, src, { fetch: true });
  if (!pre || !pre.remoteHead) return { ok: false, message: 'The PR source branch was not found on origin.', drift: pre };
  if (!force && (pre.ahead > 0 || pre.dirty)) {
    return {
      ok: false, needsForce: true, drift: pre,
      message: 'Your local worktree has ' + (pre.ahead > 0 ? pre.ahead + ' unpushed commit' + (pre.ahead === 1 ? '' : 's') : '') +
        (pre.ahead > 0 && pre.dirty ? ' and ' : '') + (pre.dirty ? 'uncommitted changes' : '') +
        '. Syncing will discard them. Push first, or confirm to overwrite.'
    };
  }
  if (pre.inSync) return { ok: true, message: 'Already up to date with the PR branch.', drift: pre };
  const res = _gitTry(['reset', '--hard', 'origin/' + src], wt);
  if (!res.ok) return { ok: false, message: res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Sync failed.', drift: pre };
  const drift = prDrift(wt, src, { fetch: false });
  return { ok: true, message: 'Synced to the PR branch.', drift };
}

// Bring the PR/source branch up to date with its TARGET (base) branch by merging
// or rebasing origin/<targetBranch> into the worktree's HEAD — the classic "my PR
// is behind main, catch it up" operation. This is the OPPOSITE direction of
// syncToPrBranch (which pulls the PR branch down); here we pull the target branch
// INTO the PR branch. It never pushes — the caller pushes separately (steward-only)
// via pushPrBranch once satisfied. A merge/rebase needs a clean tree, so it refuses
// (needsClean) when there are uncommitted changes rather than silently stashing.
// On conflict it aborts cleanly (leaving the worktree usable) and returns
// { ok:false, conflict:true, strategy } so the UI can offer the other strategy or
// manual resolution. Returns { ok, message, drift, conflict?, needsClean?, noop? }.
function updateFromTargetBranch(wt, { sourceBranch, targetBranch, strategy = 'merge' } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to update.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  const tgt = String(targetBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!tgt) return { ok: false, message: 'No target branch to update from.' };
  const mode = strategy === 'rebase' ? 'rebase' : 'merge';

  // A merge/rebase needs a clean tree — never silently discard the user's work.
  const cls = classifyPorcelain(_gitTry(['status', '--porcelain'], wt).out || '');
  if (cls.dirty) {
    return { ok: false, needsClean: true, message: 'Commit or discard your uncommitted changes before updating from ' + tgt + '.' };
  }

  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });
  const tgtRef = 'origin/' + tgt;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', tgtRef], wt).ok) {
    return { ok: false, message: 'The target branch ' + tgt + ' was not found on origin.' };
  }

  // Already contains the target tip (target is an ancestor of HEAD) — nothing to do.
  if (_gitTry(['merge-base', '--is-ancestor', tgtRef, 'HEAD'], wt).ok) {
    const drift = src ? prDrift(wt, src, { fetch: false }) : null;
    return { ok: true, noop: true, message: 'Already up to date with ' + tgt + '.', drift };
  }

  const res = mode === 'rebase'
    ? _gitTry(['rebase', tgtRef], wt)
    : _gitTry(['merge', '--no-edit', tgtRef], wt);
  if (!res.ok) {
    // Conflict (or other failure) — abort so the worktree is left clean and usable.
    _gitTry([mode, '--abort'], wt);
    const conflict = /conflict/i.test(res.err || '') || /CONFLICT/.test(res.err || '');
    return {
      ok: false, conflict, strategy: mode,
      message: conflict
        ? (mode === 'rebase' ? 'Rebase' : 'Merge') + ' onto ' + tgt + ' hit conflicts and was aborted. Try the other strategy or resolve manually in the worktree.'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || (mode + ' failed.'))
    };
  }
  const drift = src ? prDrift(wt, src, { fetch: false }) : null;
  return { ok: true, message: (mode === 'rebase' ? 'Rebased onto ' : 'Merged in ') + tgt + '.', drift };
}

// List the managed clone's registered worktrees as
// [{ path, branch|null, detached }]. Empty on any problem.
function listWorktrees(org, project, repo) {
  const clone = clonePath(org, project, repo);
  if (!_isRepo(clone)) return [];
  const r = _gitTry(['worktree', 'list', '--porcelain'], clone);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null, detached: false };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && cur) {
      cur.detached = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Resolve a directly-usable (branch-attached) worktree directory for a PR branch,
// so opening "Open → CLI/Dev Cmd/Explorer" lands the user on the real branch — ready
// to fetch/rebase/push — instead of a detached read-only review snapshot.
//
// Preference order:
//  1. `current` is itself already checked out on the branch → use it.
//  2. Another worktree is checked out on the branch (e.g. a dev card's "Work
//     worktree") → reuse that directory.
//  3. The branch isn't checked out anywhere AND `current` is a clean detached
//     review checkout sitting exactly at the branch tip → attach it onto the
//     branch (no commits lost) so it becomes usable.
// Otherwise fall back to `current`. Returns { dir, branch, reused, attached }.
function resolveUsableWorktree({ org, project, repo, sourceBranch, current } = {}) {
  const br = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  const fallback = { dir: current || '', branch: br, reused: false, attached: false };
  if (!br) return fallback;
  const norm = (p) => { try { return path.resolve(String(p || '')).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
  let wts;
  try { wts = listWorktrees(org, project, repo); } catch { return fallback; }
  const curN = norm(current);

  // 1. Current worktree already on the branch.
  const cur = wts.find(w => norm(w.path) === curN);
  if (cur && !cur.detached && cur.branch === br && fs.existsSync(cur.path)) {
    return { dir: cur.path, branch: br, reused: true, attached: false };
  }
  // 2. Another worktree checked out on the branch (e.g. a dev card Work worktree).
  const onBranch = wts.find(w => !w.detached && w.branch === br && norm(w.path) !== curN && fs.existsSync(w.path));
  if (onBranch) return { dir: onBranch.path, branch: br, reused: true, attached: false };

  // 3. Branch is free — attach the current detached review worktree onto it, but
  // only when it's clean and sitting exactly at the branch tip so no work is lost.
  if (current && _isRepo(current)) {
    const clone = clonePath(org, project, repo);
    const localHas = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok;
    const remoteHas = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok;
    const headSha = (_gitTry(['rev-parse', 'HEAD'], current).out || '').trim();
    const tgtRef = localHas ? ('refs/heads/' + br) : (remoteHas ? 'origin/' + br : '');
    const tgtSha = tgtRef ? (_gitTry(['rev-parse', tgtRef], clone).out || '').trim() : '';
    const clean = !(_gitTry(['status', '--porcelain'], current).out || '').trim();
    if (tgtRef && headSha && tgtSha && headSha === tgtSha && clean) {
      const sw = localHas
        ? _gitTry(['switch', br], current)
        : _gitTry(['switch', '-c', br, '--track', 'origin/' + br], current);
      if (sw.ok) return { dir: current, branch: br, reused: false, attached: true };
    }
  }
  return fallback;
}

// Add a path to the worktree's git exclude (so an app-managed file never shows
// in `git status` / gets committed). Resolves the correct exclude file even for
// a linked worktree via `git rev-parse --git-path`. Best-effort.
function addGitExclude(wt, relLine) {
  if (!wt || !_isRepo(wt) || !relLine) return false;
  let excl = '';
  const p = _gitTry(['rev-parse', '--git-path', 'info/exclude'], wt);
  if (p.ok && p.out) excl = p.out.trim();
  if (excl && !path.isAbsolute(excl)) excl = path.join(wt, excl);
  if (!excl) return false;
  try {
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    let cur = '';
    try { cur = fs.readFileSync(excl, 'utf-8'); } catch {}
    if (cur.split(/\r?\n/).includes(relLine)) return true;
    fs.appendFileSync(excl, (cur && !cur.endsWith('\n') ? '\n' : '') + relLine + '\n');
    return true;
  } catch { return false; }
}

// Remove a worktree (best-effort). Leaves the managed clone in place.
function removeWorktree(org, project, repo, devId, wt) {
  const target = wt || worktreePath(repo, devId);
  const clone = clonePath(org, project, repo);
  if (_isRepo(clone)) _gitTry(['worktree', 'remove', '--force', target], clone);
  try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch {}
  if (_isRepo(clone)) _gitTry(['worktree', 'prune'], clone);
  return true;
}

// Offload the (synchronous, potentially minutes-long) clone+worktree to a worker
// thread so the main HTTP event loop stays responsive while a large repo clones.
// Without this, execFileSync('git clone') blocks every other request — e.g. a Dev
// item's "Refresh summary" appears to do nothing until the clone finishes. The
// worker re-acquires its own AzDO token via `az`, so it is fully self-contained.
// Resolves to { worktreePath, branch, reused, git }.
// ---- Status reports surfaced from a worktree ---------------------------------
// The dev agent is instructed to write an HTML status report (default
// `dev-status-report.html`) into the worktree root when it completes major
// changes. Surface any such reports on the Dev card. Cheap, reflow-free scan:
// the worktree root plus a shallow `reports`/`docs`/`.reports` subfolder; match
// HTML/Markdown files whose name reads like a report. Never throws.
const REPORT_EXTS = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
const REPORT_NAME_RE = /(report|status|summary|metrics|results?)/i;
const REPORT_SUBDIRS = ['reports', 'report', 'docs', '.reports'];

// A worktree change is "ignorable" when it's an agent-generated status report
// (e.g. IMPLEMENTATION_SUMMARY.md, dev-status-report.html) — files we surface on
// the card but intentionally never commit. They must not flip a card to "dirty".
// Matches the same name/extension heuristic used to discover reports.
function isIgnorableReportPath(rel) {
  if (!rel) return false;
  const base = String(rel).split('/').pop();
  const ext = path.extname(base).toLowerCase();
  if (!REPORT_EXTS.has(ext)) return false;
  return REPORT_NAME_RE.test(base);
}

// Split `git status --porcelain` output into committable changes vs ignorable
// agent reports. Returns { dirty, changed:[], ignored:[] } where `dirty` reflects
// ONLY the committable changes — so a worktree whose only change is a generated
// report reads as clean.
function classifyPorcelain(out) {
  const changed = [], ignored = [];
  for (const raw of String(out || '').split('\n')) {
    if (!raw.trim()) continue;
    let p = raw.slice(3).trim();            // strip the 2-char XY status + space
    const arrow = p.indexOf(' -> ');         // rename entries: "old -> new"
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    (isIgnorableReportPath(p) ? ignored : changed).push(p);
  }
  return { dirty: changed.length > 0, changed, ignored };
}

function _scanReportDir(absDir, relPrefix, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    const ext = path.extname(name).toLowerCase();
    if (!REPORT_EXTS.has(ext)) continue;
    // Only surface files whose name reads like a report/status/summary, so we
    // don't list README.md, LICENSE.txt, source HTML, etc.
    if (!REPORT_NAME_RE.test(name)) continue;
    const isHtml = ext === '.html' || ext === '.htm';
    let st;
    try { st = fs.statSync(path.join(absDir, name)); } catch { continue; }
    // Skip absurdly large files (not a human-readable report).
    if (st.size > 8 * 1024 * 1024) continue;
    out.push({
      name,
      rel: (relPrefix ? relPrefix + '/' : '') + name,
      mtime: st.mtimeMs,
      size: st.size,
      kind: isHtml ? 'html' : (ext === '.md' || ext === '.markdown' ? 'md' : 'txt')
    });
  }
}

function findReports(wt) {
  const out = [];
  try {
    if (!wt || !fs.existsSync(wt)) return out;
    _scanReportDir(wt, '', out);
    for (const sub of REPORT_SUBDIRS) {
      const abs = path.join(wt, sub);
      try { if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) _scanReportDir(abs, sub, out); } catch {}
    }
  } catch {}
  // Newest first; cap to a sane number.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 16);
}

// Safely read a report file from a worktree. Resolves `rel` against the worktree
// root, blocks path traversal (the resolved path MUST stay inside the worktree),
// allows only report-ish extensions, and caps the read size. Returns
// { content, contentType, name } or throws an Error with a `.status`.
function _readReportFrom(rootDir, rel) {
  const err = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
  if (!rootDir || !fs.existsSync(rootDir)) throw err('Not found', 404);
  if (!rel || typeof rel !== 'string') throw err('Missing file', 400);
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) throw err('Forbidden path', 403);
  const ext = path.extname(abs).toLowerCase();
  if (!REPORT_EXTS.has(ext)) throw err('Unsupported file type', 415);
  let st;
  try { st = fs.statSync(abs); } catch { throw err('Not found', 404); }
  if (!st.isFile()) throw err('Not a file', 404);
  if (st.size > 8 * 1024 * 1024) throw err('Report too large to preview', 413);
  const content = fs.readFileSync(abs);
  const isHtml = ext === '.html' || ext === '.htm';
  const contentType = isHtml ? 'text/html; charset=utf-8'
    : (ext === '.md' || ext === '.markdown') ? 'text/markdown; charset=utf-8'
    : 'text/plain; charset=utf-8';
  return { content, contentType, name: path.basename(abs) };
}

function readReport(wt, rel) { return _readReportFrom(wt, rel); }

// ---------------------------------------------------------------------------
// Report cache. Reports surfaced from a worktree live inside that worktree, so
// they vanish the moment the user deletes the worktree. We mirror each surfaced
// report into a durable per-card store under the supervisor data dir, keyed by
// board + dev id, so the card's Reports/Links keep working after cleanup.
// ---------------------------------------------------------------------------
const REPORT_CACHE_DIR = path.join(SUPERVISOR_DATA_DIR, 'dev-report-cache');

function _sanitizeId(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_'; }

function reportCacheDir(boardId, devId) {
  return path.join(REPORT_CACHE_DIR, _sanitizeId(boardId), _sanitizeId(devId));
}

// Copy a worktree-relative file into the durable cache, mirroring `rel`. Both
// the source (inside the worktree) and the destination (inside the cache dir)
// are traversal-guarded. Returns true when a copy was made.
function _cacheCopy(wt, destRoot, rel) {
  try {
    if (!wt || !rel) return false;
    const rootWt = path.resolve(wt);
    const src = path.resolve(rootWt, rel);
    if (!(src === rootWt || src.startsWith(rootWt + path.sep))) return false;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return false;
    const rootDest = path.resolve(destRoot);
    const dest = path.resolve(rootDest, rel);
    if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch { return false; }
}

// Mirror a set of surfaced reports into the durable cache and flag each one that
// has a cached copy (so callers can persist `cached:true` on the dev item and
// keep serving the report after the worktree is removed). Mutates + returns the
// same array. Best-effort: never throws.
//
// Before overwriting an existing cached report whose CONTENT has changed, the
// prior cached copy is snapshotted into a timestamped `__history/` file and
// recorded in the history manifest — so regenerating a report never silently
// destroys the previous version (a comparable audit trail).
function cacheReports(boardId, devId, wt, reports) {
  if (!boardId || !devId || !Array.isArray(reports) || !reports.length) return reports || [];
  const destRoot = reportCacheDir(boardId, devId);
  for (const r of reports) {
    if (!r || !r.rel) continue;
    try { _snapshotHistoryIfChanged(boardId, devId, wt, destRoot, r); } catch {}
    const ok = _cacheCopy(wt, destRoot, r.rel);
    if (ok || hasCachedReport(boardId, devId, r.rel)) r.cached = true;
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Report history. When a report is regenerated with new content we keep the
// prior cached copy under `<cache>/__history/<base>-<ISO>.<ext>` and append an
// entry to `<cache>/__history/index.json` so the card can list past versions
// with timestamps. Snapshots ONLY happen on a genuine content change, so
// routine drift-refresh polling (same content) never creates spurious history.
// ---------------------------------------------------------------------------
const HISTORY_SUBDIR = '__history';

function _historyDir(boardId, devId) {
  return path.join(reportCacheDir(boardId, devId), HISTORY_SUBDIR);
}
function _historyManifestPath(boardId, devId) {
  return path.join(_historyDir(boardId, devId), 'index.json');
}
function _readHistoryManifest(boardId, devId) {
  try {
    const raw = fs.readFileSync(_historyManifestPath(boardId, devId), 'utf-8');
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function _writeHistoryManifest(boardId, devId, list) {
  try {
    const dir = _historyDir(boardId, devId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_historyManifestPath(boardId, devId), JSON.stringify((list || []).slice(0, 40), null, 2));
  } catch {}
}
function _fileSha(abs) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch { return ''; }
}

// If a cached copy of `r.rel` already exists AND the incoming worktree version
// differs in content, snapshot the existing cached copy into __history before it
// gets overwritten. Best-effort; never throws.
function _snapshotHistoryIfChanged(boardId, devId, wt, destRoot, r) {
  if (!wt || !r || !r.rel) return;
  const rootWt = path.resolve(wt);
  const src = path.resolve(rootWt, r.rel);
  if (!(src === rootWt || src.startsWith(rootWt + path.sep))) return;
  const rootDest = path.resolve(destRoot);
  const dest = path.resolve(rootDest, r.rel);
  if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return;
  // Nothing to preserve if there's no prior cached copy, or no incoming file.
  if (!fs.existsSync(dest) || !fs.existsSync(src)) return;
  try { if (!fs.statSync(dest).isFile() || !fs.statSync(src).isFile()) return; } catch { return; }
  const prevSha = _fileSha(dest);
  const nextSha = _fileSha(src);
  if (!prevSha || prevSha === nextSha) return;  // unchanged → no snapshot
  const ext = path.extname(r.rel);
  const base = path.basename(r.rel, ext);
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, '-');
  const histRel = HISTORY_SUBDIR + '/' + _sanitizeId(base) + '-' + stamp + ext;
  const histAbs = path.resolve(rootDest, histRel);
  if (!histAbs.startsWith(rootDest + path.sep)) return;
  try {
    fs.mkdirSync(path.dirname(histAbs), { recursive: true });
    fs.copyFileSync(dest, histAbs);
  } catch { return; }
  let size = 0; try { size = fs.statSync(histAbs).size; } catch {}
  const isHtml = /\.html?$/i.test(ext);
  const manifest = _readHistoryManifest(boardId, devId);
  manifest.unshift({
    rel: histRel,
    name: path.basename(r.rel),
    of: r.rel,
    ts: ts.toISOString(),
    size,
    sha: prevSha,
    kind: isHtml ? 'html' : (/\.(md|markdown)$/i.test(ext) ? 'md' : 'txt')
  });
  // Prune oldest history files beyond the cap so the cache can't grow forever.
  const KEEP = 30;
  for (const old of manifest.slice(KEEP)) {
    try { fs.rmSync(path.resolve(rootDest, old.rel), { force: true }); } catch {}
  }
  _writeHistoryManifest(boardId, devId, manifest.slice(0, KEEP));
}

// List a card's cached report history (newest first), enriched with a stable,
// same-origin URL rel the card can link to via the existing report endpoint.
function listReportHistory(boardId, devId) {
  if (!boardId || !devId) return [];
  return _readHistoryManifest(boardId, devId).filter(e => e && e.rel);
}

// Find reports in the worktree AND durably cache them in one shot. Use this
// everywhere instead of bare findReports so nothing is lost on cleanup.
function findAndCacheReports(boardId, devId, wt) {
  const reports = findReports(wt);
  try { cacheReports(boardId, devId, wt, reports); } catch {}
  // Keep generated reports out of git so they never dirty the card or get swept
  // into a push/commit. Best-effort; harmless if already excluded or tracked.
  for (const r of reports) { try { addGitExclude(wt, r.rel); } catch {} }
  return reports;
}

function readReportCached(boardId, devId, rel) {
  return _readReportFrom(reportCacheDir(boardId, devId), rel);
}

function hasCachedReport(boardId, devId, rel) {
  try { readReportCached(boardId, devId, rel); return true; } catch { return false; }
}

// Snapshot an arbitrary local file (e.g. the target of a file:// link that lives
// inside a worktree) into the cache under a `links/` namespace. Returns a cache
// rel (e.g. "links/dev-status-report.html") on success, or null. Only mirrors
// report-ish extensions within the size cap.
function cacheLinkFile(boardId, devId, absPath) {
  try {
    if (!boardId || !devId || !absPath) return null;
    const src = path.resolve(absPath);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
    if (fs.statSync(src).size > 8 * 1024 * 1024) return null;
    const ext = path.extname(src).toLowerCase();
    if (!REPORT_EXTS.has(ext)) return null;
    const base = _sanitizeId(path.basename(src));
    const rel = 'links/' + base;
    const rootDest = path.resolve(reportCacheDir(boardId, devId));
    const dest = path.resolve(rootDest, rel);
    if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return rel;
  } catch { return null; }
}

// Remove a card's whole report cache (call when a dev card is deleted).
function clearReportCache(boardId, devId) {
  try { fs.rmSync(reportCacheDir(boardId, devId), { recursive: true, force: true }); } catch {}
}

function createWorktreeAsync(params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const { Worker } = require('worker_threads');
    const worker = new Worker(__filename, { workerData: { __wtJob: params } });
    worker.once('message', (msg) => {
      settled = true;
      if (msg && msg.ok) resolve(msg.result);
      else reject(new Error((msg && msg.error) || 'Worktree failed'));
      worker.terminate();
    });
    worker.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.once('exit', (code) => { if (!settled) { settled = true; reject(new Error('Worktree worker exited with code ' + code)); } });
  });
}

// Open all of a dev card's ready worktrees together. For target 'editor' we write
// a durable multi-root .code-workspace into the dev-worktrees ROOT (so deleting any
// one worktree never loses it) and open it; for 'cli' we launch Copilot CLI in the
// first worktree (the dev agent there is aware of the sibling worktrees).
function openWorkspace({ devId, title, slots, target = 'editor', agent = null }) {
  const { spawn, spawnSync } = require('child_process');
  const list = (slots || []).filter(s => s && s.worktreePath && fs.existsSync(s.worktreePath));
  if (!list.length) throw new Error('No ready worktrees to open');

  if (target === 'cli') {
    const dir = list[0].worktreePath;
    const args = ['/c', 'start', '', 'cmd', '/k', 'copilot'];
    if (agent) { args.push('--agent', agent); }
    spawn(process.env.ComSpec || 'cmd.exe', args, { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    return { target: 'cli', dir };
  }

  // Resolve the editor (VS Code Insiders preferred, then VS Code).
  let editor = 'code';
  const whichIns = spawnSync('where', ['code-insiders'], { shell: true, encoding: 'utf-8' });
  if (whichIns.status === 0 && (whichIns.stdout || '').trim()) editor = 'code-insiders';

  const wsName = _safe(title || devId) + '__' + _safe(devId) + '.code-workspace';
  const wsFile = path.join(DEV_WORKTREES, wsName);
  const ws = {
    folders: list.map(s => ({ path: s.worktreePath, name: s.repo || path.basename(s.worktreePath) })),
    settings: {}
  };
  fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2), 'utf-8');
  spawn(editor, [wsFile], { shell: true, detached: true, stdio: 'ignore' }).unref();
  return { target: 'editor', editor, workspace: wsFile, folders: ws.folders.length };
}

module.exports = {
  DEV_REPOS,
  DEV_WORKTREES,
  clonePath,
  worktreePath,
  ensureClone,
  createWorktree,
  createWorktreeAsync,
  worktreeStatus,
  branchCommits,
  classifyPorcelain,
  isIgnorableReportPath,
  worktreeChanges,
  discardWorktreeChanges,
  syncWorktree,
  commitAll,
  prDrift,
  pushPrBranch,
  syncToPrBranch,
  updateFromTargetBranch,
  listWorktrees,
  resolveUsableWorktree,
  diffSummary,
  pushBranch,
  addGitExclude,
  removeWorktree,
  openWorkspace,
  findReports,
  readReport,
  findAndCacheReports,
  cacheReports,
  listReportHistory,
  readReportCached,
  hasCachedReport,
  cacheLinkFile,
  clearReportCache,
  reportCacheDir
};

// Worker-thread entry: when this module is loaded inside a Worker carrying a
// __wtJob, run the blocking clone+worktree here (off the main event loop) and
// post the result back. No-op in the main thread.
try {
  const { isMainThread, parentPort, workerData } = require('worker_threads');
  if (!isMainThread && workerData && workerData.__wtJob && parentPort) {
    const job = workerData.__wtJob;
    try {
      const r = createWorktree(job);
      let git = null;
      try { git = worktreeStatus(r.worktreePath, { baseBranch: job.baseBranch }); } catch {}
      parentPort.postMessage({ ok: true, result: { ...r, git } });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: (e && e.message) || 'Worktree failed' });
    }
  }
} catch {}
