// Azure DevOps git integration for agent/plugin discovery and install.
//
// Auth: secretless — uses the locally signed-in Azure CLI to mint a bearer
// token for the Azure DevOps resource. No PAT is stored.
//
// Discovery: walks the repo tree at a given branch and finds agent/plugin
// definitions under ANY `.github` folder (at any depth):
//   - `.github/agents/*.md`            -> repo agent
//   - `.github/plugin/<name>/plugin.json` -> repo plugin
//
// Install: materializes the relevant files into a profile-local store so the
// runtime has them on disk, then records source metadata on the agent so it
// can be reinstalled (re-fetched) from the same org/project/repo/branch.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Well-known Azure DevOps application (resource) ID for AAD tokens.
const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API_VERSION = '7.1';

let SUPERVISOR_DATA_DIR;
try {
  SUPERVISOR_DATA_DIR = require('./config-sync').SUPERVISOR_DATA_DIR;
} catch {
  SUPERVISOR_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
}
const AZDO_STORE = path.join(SUPERVISOR_DATA_DIR, 'azdo-sources');

let _tokenCache = { token: null, expiresAt: 0 };

function getToken(forceRefresh = false) {
  const now = Date.now();
  // Cache until the token's ACTUAL expiry (minus a 2-min safety buffer) rather
  // than a fixed window: `az` hands back a token from its own MSAL cache that may
  // already be partway through its life, so a fixed 50-min cache can serve an
  // expired token — and Azure DevOps answers an expired token with a 2xx HTML
  // sign-in page (not a 401), which then breaks JSON parsing downstream.
  if (!forceRefresh && _tokenCache.token && now < _tokenCache.expiresAt - 120_000) {
    return _tokenCache.token;
  }
  let raw;
  try {
    raw = execSync(
      `az account get-access-token --resource ${AZDO_RESOURCE} -o json`,
      { encoding: 'utf-8', timeout: 30_000, shell: true }
    ).trim();
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    throw new Error(
      'Could not get an Azure DevOps token from the Azure CLI. Run "az login" on the server machine. ' +
      (msg ? `Details: ${msg.split('\n')[0]}` : '')
    );
  }
  let token = '', expiresAt = 0;
  try {
    const parsed = JSON.parse(raw);
    token = (parsed.accessToken || '').trim();
    // `expires_on` is epoch seconds (timezone-safe); `expiresOn` is a local-time
    // string fallback for older CLI versions.
    if (parsed.expires_on) {
      expiresAt = Number(parsed.expires_on) * 1000;
    } else if (parsed.expiresOn) {
      const t = Date.parse(parsed.expiresOn);
      if (!Number.isNaN(t)) expiresAt = t;
    }
  } catch {
    // Older CLIs or unexpected output: treat the whole string as the token.
    token = raw;
  }
  if (!token) throw new Error('Azure CLI returned an empty Azure DevOps token. Run "az login".');
  // If we couldn't determine a real expiry, cache conservatively for 25 minutes.
  if (!expiresAt || expiresAt < now) expiresAt = now + 25 * 60_000;
  _tokenCache = { token, expiresAt };
  return token;
}

// True when Azure DevOps answered with its interactive sign-in HTML page instead
// of API data — its way of signalling a rejected/expired bearer token (served
// with a 2xx status, not a 401). `expectsJson` lets raw (file content) fetches
// avoid false-positives on legitimately HTML/XML file bodies.
function looksLikeSignInHtml(res, body, expectsJson) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  if (!expectsJson) return false;
  const head = (body || '').trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml');
}

function seg(v) {
  return encodeURIComponent(String(v || '').trim());
}

async function api(org, projectAndRest, { raw = false } = {}) {
  const base = `https://dev.azure.com/${seg(org)}/`;
  const url = base + projectAndRest;
  const expectsJson = !raw;

  const doFetch = (token) => fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'text/plain' : 'application/json'
    }
  });

  let res = await doFetch(getToken());
  let body = await res.text();

  // A rejected/expired token comes back as a 2xx HTML sign-in page (not a 401).
  // Force a fresh token and retry once before giving up.
  if (looksLikeSignInHtml(res, body, expectsJson)) {
    res = await doFetch(getToken(true));
    body = await res.text();
  }

  if (!res.ok) {
    const detail = (body || '').slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Azure DevOps denied access (${res.status}). Confirm you have access to this org/project/repo. ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`Azure DevOps resource not found (404). Check the org/project/repo/branch names. ${detail}`);
    }
    throw new Error(`Azure DevOps request failed (${res.status}). ${detail}`);
  }

  if (raw) return body;

  if (looksLikeSignInHtml(res, body, true)) {
    throw new Error('Azure DevOps returned a sign-in page instead of data — the Azure CLI session likely expired. Run "az login" on the server machine.');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Azure DevOps returned an unexpected non-JSON response. Run "az login" on the server machine if your session expired.');
  }
}

// ---- Listing -------------------------------------------------------------

async function listRepos(org, project) {
  const data = await api(org, `${seg(project)}/_apis/git/repositories?api-version=${API_VERSION}`);
  return (data.value || [])
    .map(r => ({ id: r.id, name: r.name, defaultBranch: (r.defaultBranch || '').replace('refs/heads/', '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listBranches(org, project, repo) {
  const data = await api(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/refs?filter=heads/&api-version=${API_VERSION}`);
  return (data.value || [])
    .map(r => (r.name || '').replace('refs/heads/', ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

// ---- Tree + content ------------------------------------------------------

async function getTree(org, project, repo, branch) {
  const qs = [
    'scopePath=/',
    'recursionLevel=Full',
    `versionDescriptor.version=${seg(branch)}`,
    'versionDescriptor.versionType=branch',
    `api-version=${API_VERSION}`
  ].join('&');
  const data = await api(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/items?${qs}`);
  // Each item: { objectId, gitObjectType: 'blob'|'tree', path: '/a/b', isFolder }
  return (data.value || []).filter(i => i.gitObjectType === 'blob' || (!i.isFolder && i.objectId));
}

async function getFileText(org, project, repo, branch, itemPath) {
  const qs = [
    `path=${encodeURIComponent(itemPath)}`,
    `versionDescriptor.version=${seg(branch)}`,
    'versionDescriptor.versionType=branch',
    'includeContent=true',
    '$format=json',
    `api-version=${API_VERSION}`
  ].join('&');
  const data = await api(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/items?${qs}`);
  return typeof data.content === 'string' ? data.content : '';
}

// ---- Parsing helpers -----------------------------------------------------

function parseFrontmatter(content) {
  const fm = content.replace(/\r\n/g, '\n').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const block = fm[1];
  const name = (block.match(/^name:\s*['"]?([^'"\n]+)/m) || [])[1];
  const description = (block.match(/^description:\s*['"]?([^'"\n]+)/m) || [])[1];
  return { name: name && name.trim(), description: description && description.trim() };
}

function titleCase(id) {
  return String(id || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const AGENT_RE = /(^|\/)\.github\/agents\/([^/]+)\.md$/i;
const PLUGIN_JSON_RE = /(^|\/)\.github\/plugin\/([^/]+)\/plugin\.json$/i;

// ---- Discovery -----------------------------------------------------------

async function discover(org, project, repo, branch) {
  const tree = await getTree(org, project, repo, branch);
  const discovered = [];

  // Agents: .github/agents/*.md
  const agentItems = tree.filter(i => AGENT_RE.test(i.path));
  for (const it of agentItems) {
    const p = it.path.replace(/^\//, '');
    let meta = {};
    try { meta = parseFrontmatter(await getFileText(org, project, repo, branch, it.path)); } catch {}
    const baseName = path.basename(p).replace(/\.md$/i, '');
    const id = (meta.name || baseName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    discovered.push({
      kind: 'agent',
      id,
      agentRef: meta.name || baseName,
      name: meta.name || baseName,
      displayName: titleCase(meta.name || baseName),
      description: meta.description || '',
      path: p,
      objectId: it.objectId
    });
  }

  // Plugins: .github/plugin/<name>/plugin.json
  const pluginJsons = tree.filter(i => PLUGIN_JSON_RE.test(i.path));
  for (const it of pluginJsons) {
    const pjPath = it.path.replace(/^\//, '');
    const pluginRoot = pjPath.replace(/\/plugin\.json$/i, '');
    let pj = {};
    try { pj = JSON.parse(await getFileText(org, project, repo, branch, it.path)); } catch {}
    const folderName = path.basename(pluginRoot);
    const id = (pj.name || folderName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    // Collect every blob under the plugin root for materialization.
    const files = tree
      .filter(f => {
        const fp = f.path.replace(/^\//, '');
        return fp === pluginRoot || fp.startsWith(pluginRoot + '/');
      })
      .map(f => ({ path: f.path.replace(/^\//, ''), objectId: f.objectId }));
    const hasMcp = files.some(f => /(^|\/)\.mcp\.json$/i.test(f.path));
    discovered.push({
      kind: 'plugin',
      id,
      name: pj.name || folderName,
      displayName: titleCase(pj.name || folderName),
      description: pj.description || '',
      version: pj.version || '',
      path: pluginRoot,
      objectId: it.objectId,
      hasMcp,
      files
    });
  }

  return discovered.sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
}

// ---- Materialization -----------------------------------------------------

function sanitize(v) {
  return String(v || '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function repoRoot(org, project, repo, branch) {
  return path.join(AZDO_STORE, sanitize(org), sanitize(project), sanitize(repo), sanitize(branch));
}

async function writeFileFromRepo(org, project, repo, branch, root, relPath) {
  const content = await getFileText(org, project, repo, branch, '/' + relPath.replace(/^\//, ''));
  const dest = path.join(root, relPath.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return dest;
}

// Materialize a single agent .md plus its co-located capabilities (.mcp.json and
// skills) so a generated runtime package can wire MCP + skills for it. Returns
// { cwd, agentMdPath, mcpConfig, skillCount }.
// cwd is the directory that contains the `.github` folder so the runtime can
// resolve `.github/agents/<file>.md` exactly as it would in a local checkout.
async function materializeAgent(org, project, repo, branch, agentPath) {
  const root = repoRoot(org, project, repo, branch);
  const rel = agentPath.replace(/^\//, '');
  await writeFileFromRepo(org, project, repo, branch, root, rel);
  const ghIdx = rel.toLowerCase().indexOf('.github/');
  const cwdRel = ghIdx > 0 ? rel.slice(0, ghIdx).replace(/\/$/, '') : '';
  const cwd = cwdRel ? path.join(root, cwdRel.replace(/\//g, path.sep)) : root;

  // Greedily pull capabilities that live alongside the agent so the agent can
  // actually use them at runtime (the fix for the "AzDO single-agent install
  // can't query AzDO / no Reasoning & steps" bug). Scoped to the agent's base
  // dir so we never pull unrelated files from elsewhere in the repo.
  const base = cwdRel ? cwdRel.replace(/\/$/, '') + '/' : '';
  let mcpConfig = null;
  let skillCount = 0;
  try {
    const tree = await getTree(org, project, repo, branch);
    const inBase = p => (base ? p.startsWith(base) : true);
    const wanted = [];
    for (const it of tree) {
      const p = it.path.replace(/^\//, '');
      if (!inBase(p)) continue;
      const sub = base ? p.slice(base.length) : p;
      // co-located mcp config (repo/base root or under .github)
      if (/^\.mcp\.json$/i.test(sub) || /^\.github\/\.mcp\.json$/i.test(sub)) wanted.push(p);
      // skills: <base>/.github/skills/** and <base>/skills/**
      else if (/^(\.github\/)?skills\//i.test(sub)) wanted.push(p);
    }
    for (const w of wanted) {
      await writeFileFromRepo(org, project, repo, branch, root, w);
      if (/(^|\/)SKILL\.md$/i.test(w)) skillCount++;
    }
    const mcpAbs = path.join(cwd, '.mcp.json');
    if (fs.existsSync(mcpAbs)) mcpConfig = mcpAbs;
  } catch (e) {
    // Capability sweep is best-effort; the agent .md is already materialized.
  }

  return {
    cwd,
    agentMdPath: path.join(root, rel.replace(/\//g, path.sep)),
    mcpConfig,
    skillCount,
  };
}

// Materialize an entire plugin folder. Returns { pluginDir, mcpConfig }.
async function materializePlugin(org, project, repo, branch, item) {
  const root = repoRoot(org, project, repo, branch);
  const pluginDir = path.join(root, item.path.replace(/\//g, path.sep));
  // Clear any stale copy so removed files don't linger.
  try { if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true }); } catch {}
  const files = item.files && item.files.length
    ? item.files
    : (await getTree(org, project, repo, branch))
        .filter(f => { const fp = f.path.replace(/^\//, ''); return fp === item.path || fp.startsWith(item.path + '/'); })
        .map(f => ({ path: f.path.replace(/^\//, '') }));
  for (const f of files) {
    await writeFileFromRepo(org, project, repo, branch, root, f.path);
  }
  const mcpAbs = path.join(pluginDir, '.mcp.json');
  return {
    pluginDir,
    mcpConfig: fs.existsSync(mcpAbs) ? mcpAbs : null
  };
}

// Fetch the current objectId for a given path (used by check-update).
async function getObjectId(org, project, repo, branch, itemPath) {
  const qs = [
    `path=${encodeURIComponent('/' + itemPath.replace(/^\//, ''))}`,
    `versionDescriptor.version=${seg(branch)}`,
    'versionDescriptor.versionType=branch',
    `api-version=${API_VERSION}`
  ].join('&');
  try {
    const data = await api(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/items?${qs}`);
    return data.objectId || null;
  } catch {
    return null;
  }
}

// ---- Write helpers (export) ----------------------------------------------

// Write-capable request. Mirrors api() but allows a method + JSON body and
// surfaces AzDO's error message. Used only by the export flow.
async function apiSend(org, projectAndRest, { method = 'GET', body, contentType } = {}) {
  const url = `https://dev.azure.com/${seg(org)}/` + projectAndRest;
  const headers = { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const detail = text.slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Azure DevOps denied access (${res.status}). You may not have permission to push to this repo. ${detail}`);
    }
    if (res.status === 404) throw new Error(`Azure DevOps resource not found (404). Check org/project/repo. ${detail}`);
    if (res.status === 409) throw new Error(`Azure DevOps conflict (409). ${detail}`);
    throw new Error(`Azure DevOps request failed (${res.status}). ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

// Repo metadata (id + default branch). Read-only; used in export preflight.
async function getRepo(org, project, repo) {
  const d = await apiSend(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}?api-version=${API_VERSION}`);
  return { id: d.id, name: d.name, defaultBranch: (d.defaultBranch || '').replace('refs/heads/', '') };
}

// Current commit SHA a branch points at, or null if the branch doesn't exist.
async function getRefObjectId(org, project, repo, branch) {
  const d = await apiSend(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/refs?filter=${encodeURIComponent('heads/' + String(branch || '').trim())}&api-version=${API_VERSION}`);
  const want = 'refs/heads/' + String(branch || '').trim();
  const hit = (d.value || []).find(r => r.name === want);
  return hit ? hit.objectId : null;
}

/**
 * Create a new branch off `baseBranch` and commit a set of files onto it.
 * `changes` = [{ path, content, changeType }]; changeType defaults to 'add'.
 * Paths are repo-absolute (leading '/' enforced). Retries once on a 409 by
 * re-reading the base head (handles the base branch moving under us).
 */
async function pushFiles(org, project, repo, { baseBranch, newBranch, changes, commitMessage }) {
  const norm = changes.map(c => ({
    changeType: c.changeType || 'add',
    item: { path: '/' + String(c.path || '').replace(/^\/+/, '') },
    newContent: { content: c.content, contentType: 'rawtext' }
  }));
  const attempt = async () => {
    const baseSha = await getRefObjectId(org, project, repo, baseBranch);
    if (!baseSha) throw new Error(`Base branch "${baseBranch}" not found in ${repo}.`);
    return apiSend(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/pushes?api-version=${API_VERSION}`, {
      method: 'POST',
      body: {
        refUpdates: [{ name: 'refs/heads/' + newBranch.replace(/^refs\/heads\//, ''), oldObjectId: baseSha }],
        commits: [{ comment: commitMessage || 'Export agent', changes: norm }]
      }
    });
  };
  try {
    return await attempt();
  } catch (e) {
    if (/\(409\)/.test(e.message)) return attempt();
    throw e;
  }
}

// Project metadata (id). Org-level read; used to build PR artifact links.
async function getProject(org, project) {
  const d = await apiSend(org, `_apis/projects/${seg(project)}?api-version=${API_VERSION}`);
  return { id: d.id, name: d.name };
}

// Open a pull request from sourceBranch into targetBranch. When `workItemId` is
// provided, best-effort links the work item to the new PR (so the PR shows on
// the work item and vice-versa). The PR is returned regardless of link success.
async function createPullRequest(org, project, repo, { sourceBranch, targetBranch, title, description, workItemId } = {}) {
  const d = await apiSend(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests?api-version=${API_VERSION}`, {
    method: 'POST',
    body: {
      sourceRefName: 'refs/heads/' + sourceBranch.replace(/^refs\/heads\//, ''),
      targetRefName: 'refs/heads/' + targetBranch.replace(/^refs\/heads\//, ''),
      title: title || 'Add exported agent',
      description: description || ''
    }
  });
  const webUrl = `https://dev.azure.com/${seg(org)}/${seg(project)}/_git/${seg(repo)}/pullrequest/${d.pullRequestId}`;
  if (workItemId) {
    try {
      const [repoMeta, proj] = await Promise.all([getRepo(org, project, repo), getProject(org, project)]);
      const artifactUrl = `vstfs:///Git/PullRequestId/${proj.id}%2F${repoMeta.id}%2F${d.pullRequestId}`;
      await apiSend(org, `${seg(project)}/_apis/wit/workitems/${seg(workItemId)}?api-version=${API_VERSION}`, {
        method: 'PATCH',
        contentType: 'application/json-patch+json',
        body: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } } }]
      });
    } catch { /* best-effort — the PR exists regardless of work-item link */ }
  }
  return { pullRequestId: d.pullRequestId, url: webUrl };
}

// ----- Dev item helpers (work item + PR state, clone URL) -----

// HTTPS clone URL for a repo. Auth is injected at git time via an
// `http.extraheader` bearer token (see devitems.js) so no PAT/credential
// manager is required.
function cloneUrl(org, project, repo) {
  return `https://dev.azure.com/${seg(org)}/${seg(project)}/_git/${seg(repo)}`;
}

// Web (browser) URLs for quick-navigation from the board.
function workItemUrl(org, project, id) {
  return `https://dev.azure.com/${seg(org)}/${seg(project)}/_workitems/edit/${seg(id)}`;
}
function pullRequestUrl(org, project, repo, prId) {
  return `https://dev.azure.com/${seg(org)}/${seg(project)}/_git/${seg(repo)}/pullrequest/${seg(prId)}`;
}

// Fetch a work item's headline fields. Returns a compact, UI-friendly shape.
async function getWorkItem(org, project, id) {
  const d = await apiSend(org, `${seg(project)}/_apis/wit/workitems/${seg(id)}?api-version=${API_VERSION}`);
  const f = d.fields || {};
  const assigned = f['System.AssignedTo'];
  return {
    id: d.id,
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    type: f['System.WorkItemType'] || '',
    assignedTo: assigned ? (assigned.displayName || assigned.uniqueName || '') : '',
    url: workItemUrl(org, project, id)
  };
}

// Move a work item to a new state (e.g. "In PR"). Uses a JSON-Patch PATCH.
// Returns the updated compact work-item shape. Best-effort caller should catch.
async function updateWorkItemState(org, project, id, state) {
  const patch = [{ op: 'add', path: '/fields/System.State', value: String(state) }];
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/wit/workitems/${seg(id)}?api-version=${API_VERSION}`,
    { method: 'PATCH', body: patch, contentType: 'application/json-patch+json' }
  );
  const f = d.fields || {};
  const assigned = f['System.AssignedTo'];
  return {
    id: d.id,
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    type: f['System.WorkItemType'] || '',
    assignedTo: assigned ? (assigned.displayName || assigned.uniqueName || '') : '',
    url: workItemUrl(org, project, id)
  };
}

// Fetch a pull request's status. Returns a compact, UI-friendly shape.
async function getPullRequest(org, project, repo, prId) {
  const d = await apiSend(org, `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}?api-version=${API_VERSION}`);
  const strip = (r) => (r || '').replace(/^refs\/heads\//, '');
  return {
    id: d.pullRequestId,
    title: d.title || '',
    status: d.status || '',            // active | completed | abandoned
    isDraft: !!d.isDraft,
    mergeStatus: d.mergeStatus || '',  // succeeded | conflicts | queued | ...
    sourceBranch: strip(d.sourceRefName),
    targetBranch: strip(d.targetRefName),
    reviewers: (d.reviewers || []).map(rv => ({
      name: rv.displayName || rv.uniqueName || '',
      vote: rv.vote,                   // 10 approve, 5 approve-w/-sug, 0 none, -5 waiting, -10 reject
      isRequired: !!rv.isRequired
    })),
    url: pullRequestUrl(org, project, repo, prId)
  };
}

// Linked work items for a pull request. Returns the (best-effort, fully-resolved)
// compact work items referenced by the PR, so a review agent can ground itself in
// the original intent. Never throws — returns [] on any failure.
async function getPrWorkItems(org, project, repo, prId) {
  let refs = [];
  try {
    const d = await apiSend(
      org,
      `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullRequests/${seg(prId)}/workitems?api-version=${API_VERSION}`
    );
    refs = (d.value || []).map(r => r.id).filter(Boolean);
  } catch { return []; }
  const out = [];
  for (const id of refs.slice(0, 8)) {
    try { out.push(await getWorkItem(org, project, id)); } catch { /* skip */ }
  }
  return out;
}

// ---- Code Flow: PR monitoring -------------------------------------------

// Identity of the Azure CLI account, scoped to an org. Used to answer
// "my PRs" / "reviews needed from me". connectionData needs no api-version.
async function getCurrentUser(org) {
  const d = await api(org, `_apis/connectionData`);
  const u = d.authenticatedUser || {};
  const email =
    (u.properties && u.properties.Account && u.properties.Account.$value) ||
    u.subjectDescriptor || '';
  return {
    id: u.id || '',
    name: u.providerDisplayName || u.customDisplayName || '',
    email: email || '',
    descriptor: u.descriptor || ''
  };
}

// Map an Azure DevOps reviewer vote to a friendly label.
function voteLabel(vote) {
  switch (Number(vote)) {
    case 10: return 'approved';
    case 5: return 'approved-with-suggestions';
    case -5: return 'waiting-for-author';
    case -10: return 'rejected';
    default: return 'no-vote';
  }
}

function _compactPr(d, org, project, repo) {
  const strip = (r) => (r || '').replace(/^refs\/heads\//, '');
  const repoName = (d.repository && d.repository.name) || repo || '';
  return {
    id: d.pullRequestId,
    title: d.title || '',
    description: (d.description || '').slice(0, 1200),
    status: d.status || '',
    isDraft: !!d.isDraft,
    mergeStatus: d.mergeStatus || '',
    sourceBranch: strip(d.sourceRefName),
    targetBranch: strip(d.targetRefName),
    creationDate: d.creationDate || '',
    createdBy: {
      id: (d.createdBy && d.createdBy.id) || '',
      name: (d.createdBy && (d.createdBy.displayName || d.createdBy.uniqueName)) || ''
    },
    reviewers: (d.reviewers || []).map(rv => ({
      id: rv.id || '',
      name: rv.displayName || rv.uniqueName || '',
      vote: rv.vote,
      voteLabel: voteLabel(rv.vote),
      isRequired: !!rv.isRequired
    })),
    org, project,
    repo: repoName,
    url: pullRequestUrl(org, project, repoName, d.pullRequestId)
  };
}

// List pull requests in a repo. Filter by creatorId / reviewerId / status.
// status: active (default) | completed | abandoned | all.
async function listPullRequests(org, project, repo, { creatorId, reviewerId, status = 'active', top = 50 } = {}) {
  const qs = [`searchCriteria.status=${encodeURIComponent(status)}`, `$top=${Number(top) || 50}`];
  if (creatorId) qs.push(`searchCriteria.creatorId=${encodeURIComponent(creatorId)}`);
  if (reviewerId) qs.push(`searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}`);
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests?${qs.join('&')}&api-version=${API_VERSION}`
  );
  return (d.value || []).map(pr => _compactPr(pr, org, project, repo));
}

// Comment threads on a PR. Returns active/resolved counts (user threads only)
// plus a light list of resolvable threads for context.
async function getPrThreads(org, project, repo, prId) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/threads?api-version=${API_VERSION}`
  );
  let active = 0, resolved = 0, total = 0;
  for (const t of (d.value || [])) {
    const comments = (t.comments || []).filter(c => !c.isDeleted && (c.commentType || 'text') === 'text');
    if (!comments.length) continue; // skip pure system/status threads
    total++;
    const st = (t.status || '').toLowerCase();
    if (st === 'fixed' || st === 'closed' || st === 'wontfix' || st === 'bydesign') resolved++;
    else active++; // active, pending, or unset
  }
  return { activeComments: active, resolvedComments: resolved, totalThreads: total };
}

// Detailed ACTIVE (unresolved) comment threads on a PR, for an agent that must
// respond to and fix reviewer feedback. Returns up to `max` threads, each with
// its file/line anchor, status, and the ordered human comments (author + text).
// System/status-only threads and resolved threads are skipped. Best-effort.
async function getPrActiveThreads(org, project, repo, prId, { max = 50 } = {}) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/threads?api-version=${API_VERSION}`
  );
  const out = [];
  for (const t of (d.value || [])) {
    const st = (t.status || '').toLowerCase();
    // Only unresolved discussion threads need a response.
    if (st === 'fixed' || st === 'closed' || st === 'wontfix' || st === 'bydesign') continue;
    const comments = (t.comments || [])
      .filter(c => !c.isDeleted && (c.commentType || 'text') === 'text')
      .map(c => ({
        author: (c.author && c.author.displayName) || 'unknown',
        text: String(c.content || '').trim()
      }))
      .filter(c => c.text);
    if (!comments.length) continue; // pure system/status thread
    const tc = t.threadContext || {};
    const file = tc.filePath ? String(tc.filePath).replace(/^\/+/, '') : null;
    const line = (tc.rightFileStart && tc.rightFileStart.line) ||
      (tc.leftFileStart && tc.leftFileStart.line) || null;
    out.push({ id: t.id, status: st || 'active', file, line, comments });
    if (out.length >= max) break;
  }
  return out;
}

// Post a comment thread to a PR. When filePath + rightLine are given the thread
// is anchored to that file/line in the PR diff (right/new side); otherwise it is
// a general discussion comment. Returns the created thread. Caller should catch.
async function createPrThread(org, project, repo, prId, { content, filePath, rightLine, status = 'active' } = {}) {
  const body = {
    comments: [{ parentCommentId: 0, content: String(content || ''), commentType: 1 }],
    status
  };
  if (filePath) {
    const p = '/' + String(filePath).replace(/^\/+/, '');
    const line = parseInt(rightLine, 10);
    body.threadContext = { filePath: p };
    if (line > 0) {
      body.threadContext.rightFileStart = { line, offset: 1 };
      body.threadContext.rightFileEnd = { line, offset: 1 };
    }
  }
  return apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/threads?api-version=${API_VERSION}`,
    { method: 'POST', body }
  );
}

// CI / validation statuses posted to a PR (build policies, custom checks).
// These ARE the "PR runs / CI runs" surfaced in the Validation section.
async function getPrStatuses(org, project, repo, prId) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/statuses?api-version=${API_VERSION}`
  );
  // The statuses feed appends a new entry each time a check re-posts; keep only
  // the most recent per (genre/name) context.
  const byCtx = new Map();
  for (const s of (d.value || [])) {
    const ctx = s.context || {};
    const key = `${ctx.genre || ''}/${ctx.name || ''}`;
    const prev = byCtx.get(key);
    if (!prev || new Date(s.creationDate || 0) > new Date(prev.creationDate || 0)) {
      byCtx.set(key, s);
    }
  }
  return [...byCtx.values()].map(s => {
    const ctx = s.context || {};
    return {
      id: s.id,
      state: (s.state || '').toLowerCase(), // succeeded|failed|pending|error|notApplicable|notSet
      genre: ctx.genre || '',
      name: ctx.name || '',
      description: s.description || '',
      targetUrl: s.targetUrl || '',
      creationDate: s.creationDate || ''
    };
  }).sort((a, b) => `${a.genre}${a.name}`.localeCompare(`${b.genre}${b.name}`));
}

// Branch (merge) policy evaluations for a PR — the authoritative "is it ready
// to merge" signal. Needs the project GUID. Best-effort: callers should catch.
async function getPrPolicyEvaluations(org, project, prId, projectId) {
  let pid = projectId;
  if (!pid) {
    try { pid = (await getProject(org, project)).id; } catch { pid = null; }
  }
  if (!pid) return { evaluations: [], ready: null, builds: [] };
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${pid}/${prId}`;
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=${API_VERSION}-preview.1`
  );
  const evals = (d.value || []).map(e => {
    const cfg = e.configuration || {};
    const settings = cfg.settings || {};
    const ctx = e.context || {};
    const typeName = (cfg.type && (cfg.type.displayName || cfg.type.id)) || '';
    const isBuild = /build/i.test(typeName);
    return {
      status: (e.status || '').toLowerCase(), // approved|queued|running|rejected|notApplicable
      blocking: !!cfg.isBlocking,
      type: typeName,
      isBuild,
      displayName: settings.displayName || '',
      buildDefinitionId: settings.buildDefinitionId || null,
      buildId: (ctx.buildId != null ? ctx.buildId : null),
      statusGenre: settings.statusGenre || '',
      statusName: settings.statusName || '',
      isExpired: !!ctx.isExpired
    };
  });
  const blocking = evals.filter(e => e.blocking && e.status !== 'notapplicable');
  const ready = blocking.length ? blocking.every(e => e.status === 'approved') : null;

  // The "major PR builds" — Build-type policy gates. Best-effort enrich each
  // with the build's name + timing so Code Flow can surface them as validation.
  const buildEvals = evals.filter(e => e.isBuild && e.status !== 'notapplicable');
  const builds = await Promise.all(buildEvals.map(async (e) => {
    let b = null;
    if (e.buildId) { try { b = await getBuild(org, project, e.buildId); } catch { b = null; } }
    // Map the gate to a status-check-like state for unified rendering.
    let state = e.status; // approved|queued|running|rejected
    if (b) {
      if (b.status === 'inProgress' || b.status === 'notStarted') state = 'running';
      else if (b.result === 'succeeded') state = 'approved';
      else if (b.result === 'failed') state = 'rejected';
      else if (b.result === 'canceled' || b.result === 'partiallySucceeded') state = b.result;
    }
    return {
      kind: 'build',
      name: (b && b.definitionName) || e.displayName || 'Build validation',
      state,                       // approved|rejected|running|queued|canceled|partiallySucceeded
      blocking: e.blocking,
      buildId: e.buildId,
      buildNumber: b && b.buildNumber,
      result: b && b.result,
      durationMs: b && b.durationMs != null ? b.durationMs : null,
      startTime: b && b.startTime,
      finishTime: b && b.finishTime,
      isExpired: e.isExpired,
      url: (b && b.url) || (e.buildId
        ? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_build/results?buildId=${e.buildId}`
        : '')
    };
  }));
  return { evaluations: evals, ready, builds };
}

// Fetch a build's status, result, timing and definition name. Best-effort.
async function getBuild(org, project, buildId) {
  const b = await apiSend(
    org,
    `${seg(project)}/_apis/build/builds/${seg(buildId)}?api-version=${API_VERSION}`
  );
  const start = b.startTime ? new Date(b.startTime).getTime() : null;
  const finish = b.finishTime ? new Date(b.finishTime).getTime() : null;
  const durationMs = (start && finish) ? Math.max(0, finish - start)
    : (start ? Math.max(0, Date.now() - start) : null);
  return {
    id: b.id,
    buildNumber: b.buildNumber || '',
    status: b.status || '',       // notStarted|inProgress|completed|cancelling|postponed
    result: b.result || '',       // succeeded|failed|canceled|partiallySucceeded
    definitionName: (b.definition && b.definition.name) || '',
    startTime: b.startTime || '',
    finishTime: b.finishTime || '',
    durationMs,
    url: (b._links && b._links.web && b._links.web.href) || ''
  };
}

// ---- Reviewer / area-expert intelligence (deterministic, no AI) -----------
// Tally git commit authors over a recent window, optionally scoped to a single
// file path. Returns [{ name, email, count }] sorted by count desc. Best-effort:
// callers should .catch() — a missing repo/permission must never break Code Flow.
async function _commitAuthors(org, project, repo, { days = 60, top = 300, itemPath } = {}) {
  const fromDate = new Date(Date.now() - days * 86400000).toISOString();
  const qs = [
    `searchCriteria.fromDate=${encodeURIComponent(fromDate)}`,
    `searchCriteria.$top=${Number(top) || 300}`,
    `api-version=${API_VERSION}`
  ];
  if (itemPath) {
    qs.push(`searchCriteria.itemPath=${encodeURIComponent(itemPath)}`);
    qs.push('searchCriteria.itemVersion.versionType=branch');
  }
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/commits?${qs.join('&')}`
  );
  const tally = new Map(); // key -> { name, email, count }
  for (const c of (d.value || [])) {
    const a = c.author || {};
    const email = (a.email || '').trim().toLowerCase();
    const name = (a.name || '').trim();
    if (!name && !email) continue;
    const key = email || name.toLowerCase();
    const cur = tally.get(key) || { name, email, count: 0 };
    if (!cur.name && name) cur.name = name;
    cur.count++;
    tally.set(key, cur);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}

// Most active authors in a repo over the window (area-expert + reviewer fallback).
async function getRepoContributors(org, project, repo, days = 60, top = 300) {
  return _commitAuthors(org, project, repo, { days, top });
}

// Authors who recently touched a specific file (suggested-reviewer signal).
async function getFileContributors(org, project, repo, path, days = 60, top = 30) {
  if (!path) return [];
  return _commitAuthors(org, project, repo, { days, top, itemPath: path });
}

// Changed file paths for a PR (latest iteration). Returns up to `limit` edited/added
// file paths (folders + pure deletes excluded). Best-effort: callers should .catch().
async function getPrChangedFiles(org, project, repo, prId, limit = 100) {
  const its = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullRequests/${seg(prId)}/iterations?api-version=${API_VERSION}`
  );
  const iters = its.value || [];
  if (!iters.length) return [];
  const latest = iters.reduce((m, it) => (it.id > m ? it.id : m), iters[0].id || 1);
  const ch = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullRequests/${seg(prId)}/iterations/${seg(latest)}/changes?api-version=${API_VERSION}`
  );
  const out = [];
  for (const e of (ch.changeEntries || [])) {
    const item = e.item || {};
    if (item.isFolder) continue;
    const ct = (e.changeType || '').toLowerCase();
    if (ct === 'delete' || ct === 'sourcerename, delete') continue;
    const p = item.path || '';
    if (p) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  AZDO_STORE,
  getToken,
  getCurrentUser,
  voteLabel,
  getRepoContributors,
  getFileContributors,
  getPrChangedFiles,
  listPullRequests,
  getPrThreads,
  getPrActiveThreads,
  createPrThread,
  getPrStatuses,
  getPrPolicyEvaluations,
  getBuild,
  listRepos,
  listBranches,
  discover,
  getTree,
  getFileText,
  materializeAgent,
  materializePlugin,
  getObjectId,
  repoRoot,
  apiSend,
  getRepo,
  getProject,
  getRefObjectId,
  pushFiles,
  createPullRequest,
  cloneUrl,
  workItemUrl,
  pullRequestUrl,
  getWorkItem,
  getPrWorkItems,
  updateWorkItemState,
  getPullRequest
};
