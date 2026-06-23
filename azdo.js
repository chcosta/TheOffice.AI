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
async function apiSend(org, projectAndRest, { method = 'GET', body } = {}) {
  const url = `https://dev.azure.com/${seg(org)}/` + projectAndRest;
  const headers = { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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

// Open a pull request from newBranch into baseBranch.
async function createPullRequest(org, project, repo, { sourceBranch, targetBranch, title, description }) {
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

module.exports = {
  AZDO_STORE,
  getToken,
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
  getRefObjectId,
  pushFiles,
  createPullRequest,
  cloneUrl,
  workItemUrl,
  pullRequestUrl,
  getWorkItem,
  getPullRequest
};
