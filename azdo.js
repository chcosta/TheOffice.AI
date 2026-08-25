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
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

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
// In-flight token acquisition, so a burst of concurrent requests (e.g. the
// Epics tab firing several ADO calls at once) shares a SINGLE `az` invocation
// instead of spawning the slow CLI many times over.
let _tokenInflight = null;

async function getToken(forceRefresh = false) {
  const now = Date.now();
  // Cache until the token's ACTUAL expiry (minus a 2-min safety buffer) rather
  // than a fixed window: `az` hands back a token from its own MSAL cache that may
  // already be partway through its life, so a fixed 50-min cache can serve an
  // expired token — and Azure DevOps answers an expired token with a 2xx HTML
  // sign-in page (not a 401), which then breaks JSON parsing downstream.
  if (!forceRefresh && _tokenCache.token && now < _tokenCache.expiresAt - 120_000) {
    return _tokenCache.token;
  }
  // Coalesce concurrent acquisitions: whoever arrives first spawns `az`, the
  // rest await the same promise. This avoids N parallel ~2.7s CLI launches.
  if (_tokenInflight) return _tokenInflight;
  _tokenInflight = _acquireToken().finally(() => { _tokenInflight = null; });
  return _tokenInflight;
}

// Spawn the Azure CLI ASYNCHRONOUSLY (execFile, not execSync) so acquiring a
// token never blocks the Node event loop. The old synchronous `az account
// get-access-token` froze the entire server for ~2.7s on the first Code Flow
// visit (and on every token refresh), stalling all other requests/heartbeats.
async function _acquireToken() {
  let raw;
  try {
    // Command string + default shell (matches the original execSync form). The
    // resource is a fixed constant — no user input — so there's no injection
    // surface, and this avoids the execFile+args+shell deprecation (DEP0190).
    const { stdout } = await execAsync(
      `az account get-access-token --resource ${AZDO_RESOURCE} -o json`,
      { encoding: 'utf-8', timeout: 30_000, windowsHide: true }
    );
    raw = String(stdout || '').trim();
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    throw new Error(
      'Could not get an Azure DevOps token from the Azure CLI. Run "az login" on the server machine. ' +
      (msg ? `Details: ${msg.split('\n')[0]}` : '')
    );
  }
  return _parseAndCacheToken(raw);
}

// Parse `az account get-access-token` JSON, cache it to its real expiry, return
// the token. Shared by the async ({@link _acquireToken}) and sync
// ({@link getTokenSync}) acquisition paths so their caching is identical.
function _parseAndCacheToken(raw) {
  const now = Date.now();
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

// SYNCHRONOUS token accessor for the ONE caller that can't be async: building
// git `http.extraheader` auth args for a synchronous execFileSync git call
// (devitems clone/worktree). It shares _tokenCache with the async path, so once
// the background pre-warm has populated the cache this returns instantly with NO
// `az` spawn. It only falls back to a blocking `az` when the cache is cold —
// acceptable there because that code path is already a synchronous subprocess
// call outside the web-request hot path. Never use this from an HTTP handler.
function getTokenSync(forceRefresh = false) {
  const now = Date.now();
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
  return _parseAndCacheToken(raw);
}

// Best-effort background pre-warm: acquire the ADO token shortly after boot and
// keep it fresh, so the FIRST user request (typically the Code Flow / Epics tab)
// doesn't pay the ~2.7s cold `az` cost inline. Safe to call when not signed in
// (the rejection is swallowed) and idempotent (single-flight + interval guard).
let _prewarmTimer = null;
function prewarmToken() {
  getToken().catch(() => { /* not signed in yet — will retry on demand */ });
  if (!_prewarmTimer) {
    // Refresh well before the ~60-min token lifetime so it never expires under
    // an active user. unref() so this timer never keeps the process alive.
    _prewarmTimer = setInterval(() => {
      getToken(true).catch(() => {});
    }, 30 * 60_000);
    if (_prewarmTimer.unref) _prewarmTimer.unref();
  }
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

  let res = await doFetch(await getToken());
  let body = await res.text();

  // A rejected/expired token comes back as a 2xx HTML sign-in page (not a 401).
  // Force a fresh token and retry once before giving up.
  if (looksLikeSignInHtml(res, body, expectsJson)) {
    res = await doFetch(await getToken(true));
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

// Fetch an ADO Git file given its browser web URL, e.g.
//   https://dev.azure.com/{org}/{project}/_git/{repo}?path=/docs/roadmap.md&version=GBmain
// (also handles {org}.visualstudio.com). Best-effort: tries the URL's branch
// then main/master; returns '' on any failure (never throws).
async function fetchGitDocByWebUrl(webUrl) {
  let u;
  try { u = new URL(String(webUrl || '')); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let org, project, repo;
  if (host.endsWith('.visualstudio.com')) {
    org = host.split('.')[0];
    const gi = parts.indexOf('_git');
    if (gi < 1) return '';
    project = decodeURIComponent(parts[gi - 1]);
    repo = decodeURIComponent(parts[gi + 1] || project);
  } else {
    const gi = parts.indexOf('_git');
    if (gi < 2) return '';
    org = decodeURIComponent(parts[0]);
    project = decodeURIComponent(parts[gi - 1]);
    repo = decodeURIComponent(parts[gi + 1] || project);
  }
  const itemPath = u.searchParams.get('path') || '/';
  const ver = u.searchParams.get('version') || '';
  const branches = [];
  const gb = ver.match(/^GB(.+)$/i);
  if (gb) branches.push(decodeURIComponent(gb[1]));
  branches.push('main', 'master');
  for (const b of branches) {
    if (!b) continue;
    try {
      const txt = await getFileText(org, project, repo, b, itemPath);
      if (txt) return txt;
    } catch { /* try next branch */ }
  }
  return '';
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

// A plugin is a multi-file artifact (plugin.json + agents/, skills/, .mcp.json,
// configs, scripts…). Fingerprinting only plugin.json's blob misses changes to
// any other file, so updates to agent prompts/tools went undetected. This
// returns a stable composite signature over EVERY file's git objectId so a
// change to any file in the plugin flips the signature.
function pluginSignature(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  const lines = list
    .map(f => `${f.path}:${f.objectId || ''}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha1').update(lines).digest('hex');
}

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
      // Composite of all files in the plugin, so updates to any file (agents,
      // skills, .mcp.json, configs) are detected — not just plugin.json edits.
      objectId: pluginSignature(files) || it.objectId,
      pluginJsonObjectId: it.objectId,
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
  const headers = { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' };
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
    // Additive fields (other callers ignore these) — used to ground a generated
    // standup agent's persona in the real epic.
    areaPath: f['System.AreaPath'] || '',
    iterationPath: f['System.IterationPath'] || '',
    tags: f['System.Tags'] || '',
    description: f['System.Description'] || '',
    url: workItemUrl(org, project, id)
  };
}

// Search Epics (and DNCEng Epics) in a project by title substring. Returns a
// compact list for the standup-agent Epic picker. WIQL only returns IDs, so we
// fetch fields for the top matches via the batch endpoint. Never throws on an
// empty result; bubbles auth/permission errors from apiSend.
const EPIC_TYPES = ['Epic', 'DNCEng Epic'];
async function searchEpics(org, project, text, { top = 25 } = {}) {
  const q = String(text || '').trim().replace(/'/g, "''");
  const typeClause = EPIC_TYPES.map(t => `[System.WorkItemType] = '${t}'`).join(' OR ');
  let where = `(${typeClause})`;
  if (q) where += ` AND [System.Title] CONTAINS '${q}'`;
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`;
  const res = await apiSend(org, `${seg(project)}/_apis/wit/wiql?api-version=${API_VERSION}`, {
    method: 'POST', body: { query: wiql }, contentType: 'application/json'
  });
  const ids = (res.workItems || []).map(w => w.id).filter(Boolean).slice(0, top);
  if (!ids.length) return [];
  const batch = await apiSend(org, `${seg(project)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
    method: 'POST',
    body: {
      ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.AreaPath']
    },
    contentType: 'application/json'
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  return (batch.value || [])
    .map(d => {
      const f = d.fields || {};
      const assigned = f['System.AssignedTo'];
      return {
        id: d.id,
        title: f['System.Title'] || '',
        state: f['System.State'] || '',
        type: f['System.WorkItemType'] || '',
        areaPath: f['System.AreaPath'] || '',
        assignedTo: assigned ? (assigned.displayName || assigned.uniqueName || '') : '',
        url: workItemUrl(org, project, d.id)
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// Fetch the discussion comments on a work item, newest first, as plain text.
// The work-item *fields* (title/state/assignedTo) are only the headline — the real
// up-to-date status (decisions, blockers, "moved to X because…", carry-forward
// context) lives in the comment thread. Comment bodies are HTML, so they're
// flattened to readable text. Returns { count, comments:[{id, author, date, text}] }
// ordered newest→oldest and capped at `top`. Never throws on an empty/locked
// thread; bubbles auth errors from apiSend. Uses the preview comments API.
async function getWorkItemComments(org, project, id, { top = 20 } = {}) {
  let d;
  try {
    d = await apiSend(org, `${seg(project)}/_apis/wit/workItems/${seg(id)}/comments?$top=${Math.max(1, Math.min(200, top))}&api-version=7.1-preview.4`);
  } catch (_) {
    // Older collections / restricted threads — treat as no comments rather than fail.
    return { count: 0, comments: [] };
  }
  const all = Array.isArray(d.comments) ? d.comments : [];
  const flatten = (html) => String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const comments = all
    .map(c => {
      const by = c.createdBy || c.modifiedBy || {};
      return {
        id: c.id,
        author: by.displayName || by.uniqueName || '',
        date: c.createdDate || c.modifiedDate || '',
        text: flatten(c.text)
      };
    })
    .filter(c => c.text)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, top);
  return { count: typeof d.totalCount === 'number' ? d.totalCount : all.length, comments };
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

// Create a work item. `type` is the work-item-type name (e.g. "Task",
// "DNCEng Task", "Bug"); it is URL-appended after a literal "$". Optional fields
// (description/assignedTo/areaPath/iterationPath/state/tags) are set via the
// JSON-patch document. Returns the compact getWorkItem shape.
async function createWorkItem(org, project, type, { title, description, assignedTo, areaPath, iterationPath, state, tags } = {}) {
  if (!String(title || '').trim()) throw new Error('Work item title is required.');
  const patch = [{ op: 'add', path: '/fields/System.Title', value: String(title).slice(0, 250) }];
  if (description) patch.push({ op: 'add', path: '/fields/System.Description', value: String(description) });
  if (assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: String(assignedTo) });
  if (areaPath) patch.push({ op: 'add', path: '/fields/System.AreaPath', value: String(areaPath) });
  if (iterationPath) patch.push({ op: 'add', path: '/fields/System.IterationPath', value: String(iterationPath) });
  if (state) patch.push({ op: 'add', path: '/fields/System.State', value: String(state) });
  if (tags) patch.push({ op: 'add', path: '/fields/System.Tags', value: String(tags) });
  const wtype = encodeURIComponent('$' + String(type || 'Task').trim());
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/wit/workitems/${wtype}?api-version=${API_VERSION}`,
    { method: 'POST', body: patch, contentType: 'application/json-patch+json' }
  );
  const f = d.fields || {};
  const assigned = f['System.AssignedTo'];
  return {
    id: d.id,
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    type: f['System.WorkItemType'] || '',
    assignedTo: assigned ? (assigned.displayName || assigned.uniqueName || '') : '',
    url: workItemUrl(org, project, d.id),
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
    sourceHead: (d.lastMergeSourceCommit && d.lastMergeSourceCommit.commitId) || '',
    reviewers: (d.reviewers || []).map(rv => ({
      id: rv.id || '',
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

// Reflects the Azure CLI sign-in that Azure DevOps auth relies on. Uses
// `az account show` so we can report the identity without needing a specific
// org/project. Never throws — returns a {connected,...} shape either way.
function getSignInStatus() {
  let raw;
  try {
    raw = execSync('az account show -o json', { encoding: 'utf-8', timeout: 20_000, shell: true }).trim();
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().split('\n')[0];
    return {
      connected: false, login: '', name: '', tenant: '', subscription: '', source: 'az',
      reason: 'Not signed in to Azure CLI. Run "az login" (or use the button).' + (msg ? ` Details: ${msg}` : '')
    };
  }
  try {
    const a = JSON.parse(raw);
    const user = a.user || {};
    return {
      connected: true,
      login: user.name || '',        // usually the signed-in UPN / email
      name: user.name || '',
      tenant: a.tenantId || '',
      subscription: a.name || '',
      source: 'az',
      reason: ''
    };
  } catch {
    // `az` returned something we couldn't parse, but it didn't error — treat as
    // signed in with an unknown identity rather than reporting a false negative.
    return { connected: true, login: '', name: '', tenant: '', subscription: '', source: 'az', reason: '' };
  }
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
    sourceHead: (d.lastMergeSourceCommit && d.lastMergeSourceCommit.commitId) || '',
    creationDate: d.creationDate || '',
    closedDate: d.closedDate || '',
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

// Project-wide PR search (across ALL repos in a project), filtered by creatorId.
// Unlike listPullRequests this takes no repo segment, so it answers "every PR I
// authored in this project". Azure DevOps has no server-side date filter here, so
// callers filter the returned creationDate/closedDate by their own window.
// status: active (default) | completed | abandoned | all.
async function listProjectPullRequests(org, project, { creatorId, reviewerId, status = 'completed', top = 100 } = {}) {
  const qs = [`searchCriteria.status=${encodeURIComponent(status)}`, `$top=${Number(top) || 100}`];
  if (creatorId) qs.push(`searchCriteria.creatorId=${encodeURIComponent(creatorId)}`);
  if (reviewerId) qs.push(`searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}`);
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/pullrequests?${qs.join('&')}&api-version=${API_VERSION}`
  );
  return (d.value || []).map(pr => _compactPr(pr, org, project, (pr.repository && pr.repository.name) || ''));
}

// Work items the authenticated user (@Me — the Azure CLI account) either had
// ASSIGNED to them and changed, or CREATED, within [start,end]. `start`/`end` are
// 'YYYY-MM-DD'; the window is widened to full-day UTC bounds. Returns compact,
// window-relevant items hydrated via the batch endpoint. Never throws on empty.
async function listMyWorkItems(org, project, { start, end, top = 200 } = {}) {
  // WIQL DateTime literals use "date precision" — a time component is rejected
  // (400). Use date-only bounds with an EXCLUSIVE upper bound (end + 1 day) so the
  // whole of the end day is still included.
  const lo = String(start).slice(0, 10);
  const hiEx = (() => { const d = new Date(`${String(end).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const wiql =
    `SELECT [System.Id] FROM WorkItems WHERE ` +
    `( [System.AssignedTo] = @Me AND [System.ChangedDate] >= '${lo}' AND [System.ChangedDate] < '${hiEx}' ) ` +
    `OR ( [System.CreatedBy] = @Me AND [System.CreatedDate] >= '${lo}' AND [System.CreatedDate] < '${hiEx}' ) ` +
    `ORDER BY [System.ChangedDate] DESC`;
  const res = await apiSend(org, `${seg(project)}/_apis/wit/wiql?api-version=${API_VERSION}`, {
    method: 'POST', body: { query: wiql }, contentType: 'application/json'
  });
  const ids = (res.workItems || []).map(w => w.id).filter(Boolean).slice(0, Math.max(1, Math.min(200, top)));
  if (!ids.length) return [];
  const batch = await apiSend(org, `${seg(project)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
    method: 'POST',
    body: {
      ids,
      fields: [
        'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
        'System.ChangedDate', 'System.CreatedDate', 'System.AssignedTo', 'System.CreatedBy',
        'Microsoft.VSTS.Common.ClosedDate'
      ]
    },
    contentType: 'application/json'
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  const person = (v) => (v ? (v.displayName || v.uniqueName || '') : '');
  const personId = (v) => (v ? (v.id || v.descriptor || '') : '');
  return (batch.value || [])
    .map(d => {
      const f = d.fields || {};
      return {
        id: d.id,
        title: f['System.Title'] || '',
        type: f['System.WorkItemType'] || '',
        state: f['System.State'] || '',
        changedDate: f['System.ChangedDate'] || '',
        createdDate: f['System.CreatedDate'] || '',
        closedDate: f['Microsoft.VSTS.Common.ClosedDate'] || '',
        assignedTo: person(f['System.AssignedTo']),
        assignedToId: personId(f['System.AssignedTo']),
        createdBy: person(f['System.CreatedBy']),
        createdById: personId(f['System.CreatedBy']),
        org, project,
        url: workItemUrl(org, project, d.id)
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// Query work items in a project by a filter (used by the dev-card auto-create
// rules). Filters are AND-combined; any omitted filter is simply not constrained.
// `state` may be a single value or an array of allowed states. `areaPath` matches
// UNDER the given node (so a parent area path also catches children). Always
// scopes to items ASSIGNED to @Me unless assignedToMe is explicitly false.
// Returns compact items hydrated via the batch endpoint. Never throws on empty.
async function queryWorkItems(org, project, { type, state, areaPath, assignedToMe = true, assignedTo, top = 100, titleContains } = {}) {
  // WIQL escapes a single quote by doubling it.
  const lit = (v) => `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
  const clauses = [];
  const t = String(type || '').trim();
  if (t) clauses.push(`[System.WorkItemType] = ${lit(t)}`);
  const states = (Array.isArray(state) ? state : [state])
    .map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  if (states.length === 1) clauses.push(`[System.State] = ${lit(states[0])}`);
  else if (states.length > 1) clauses.push(`( ${states.map(s => `[System.State] = ${lit(s)}`).join(' OR ')} )`);
  const area = String(areaPath || '').trim();
  if (area) clauses.push(`[System.AreaPath] UNDER ${lit(area)}`);
  const assignee = String(assignedTo == null ? '' : assignedTo).trim();
  if (assignee) clauses.push(`[System.AssignedTo] = ${lit(assignee)}`);
  else if (assignedToMe !== false) clauses.push(`[System.AssignedTo] = @Me`);
  // Free-text title search (compose source picker): CONTAINS runs a substring match
  // over [System.Title]. Combined with the other clauses via AND.
  const titleQ = String(titleContains || '').trim();
  if (titleQ) clauses.push(`[System.Title] CONTAINS ${lit(titleQ)}`);
  // Exclude terminal states unless the caller pinned a specific state list, or is
  // running a free-text title search (where finding a specific item — even a closed
  // one — matters more than filtering by activity).
  if (!states.length && !titleQ) clauses.push(`[System.State] <> 'Closed' AND [System.State] <> 'Removed' AND [System.State] <> 'Done'`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')} ` : '';
  const wiql =
    `SELECT [System.Id] FROM WorkItems ${where}ORDER BY [System.ChangedDate] DESC`;
  const res = await apiSend(org, `${seg(project)}/_apis/wit/wiql?api-version=${API_VERSION}`, {
    method: 'POST', body: { query: wiql }, contentType: 'application/json'
  });
  const ids = (res.workItems || []).map(w => w.id).filter(Boolean).slice(0, Math.max(1, Math.min(200, top)));
  if (!ids.length) return [];
  const batch = await apiSend(org, `${seg(project)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
    method: 'POST',
    body: {
      ids,
      fields: [
        'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
        'System.AreaPath', 'System.IterationPath', 'System.Tags',
        'System.ChangedDate', 'System.CreatedDate', 'System.AssignedTo', 'System.CreatedBy'
      ]
    },
    contentType: 'application/json'
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  const person = (v) => (v ? (v.displayName || v.uniqueName || '') : '');
  const personId = (v) => (v ? (v.id || v.descriptor || '') : '');
  return (batch.value || [])
    .map(d => {
      const f = d.fields || {};
      return {
        id: d.id,
        title: f['System.Title'] || '',
        type: f['System.WorkItemType'] || '',
        state: f['System.State'] || '',
        areaPath: f['System.AreaPath'] || '',
        iterationPath: f['System.IterationPath'] || '',
        tags: f['System.Tags'] || '',
        changedDate: f['System.ChangedDate'] || '',
        createdDate: f['System.CreatedDate'] || '',
        assignedTo: person(f['System.AssignedTo']),
        assignedToId: personId(f['System.AssignedTo']),
        assignedToUnique: (f['System.AssignedTo'] && f['System.AssignedTo'].uniqueName) || '',
        createdBy: person(f['System.CreatedBy']),
        org, project,
        url: workItemUrl(org, project, d.id)
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// Expand an epic's hierarchy: its direct child work items (Hierarchy-Forward
// relations) plus any linked pull requests (ArtifactLink relations). Batch-fetches
// child field details (incl. TargetDate) in one call. Returns
// { epic, children:[...], prs:[{id}] }. Never throws on an epic with no relations;
// bubbles auth/permission errors from apiSend.
async function getEpicTree(org, project, id) {
  const d = await apiSend(org, `${seg(project)}/_apis/wit/workitems/${seg(id)}?$expand=relations&api-version=${API_VERSION}`);
  const f = d.fields || {};
  const assigned = f['System.AssignedTo'];
  const epic = {
    id: d.id,
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    type: f['System.WorkItemType'] || '',
    assignedTo: assigned ? (assigned.displayName || assigned.uniqueName || '') : '',
    areaPath: f['System.AreaPath'] || '',
    iterationPath: f['System.IterationPath'] || '',
    tags: f['System.Tags'] || '',
    description: f['System.Description'] || '',
    targetDate: f['Microsoft.VSTS.Scheduling.TargetDate'] || '',
    startDate: f['Microsoft.VSTS.Scheduling.StartDate'] || '',
    url: workItemUrl(org, project, id)
  };
  const childIds = [];
  const prs = [];
  for (const rel of (d.relations || [])) {
    const relType = String(rel.rel || '');
    if (relType === 'System.LinkTypes.Hierarchy-Forward') {
      const m = String(rel.url || '').match(/workItems\/(\d+)/i);
      if (m) childIds.push(Number(m[1]));
    } else if (relType === 'ArtifactLink') {
      const nm = String((rel.attributes && rel.attributes.name) || '');
      if (/pull ?request/i.test(nm)) {
        // vstfs artifact URI: .../PullRequestId/<git-project-guid>%2F<repo-guid>%2F<prId>
        const enc = String(rel.url || '').split('/').pop() || '';
        let decoded = enc; try { decoded = decodeURIComponent(enc); } catch {}
        const prId = decoded.split('/').pop();
        if (prId) prs.push({ id: prId });
      }
    }
  }
  let children = [];
  const ids = childIds.slice(0, 200);
  if (ids.length) {
    const batch = await apiSend(org, `${seg(project)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
      method: 'POST',
      body: {
        ids,
        fields: [
          'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
          'System.AreaPath', 'System.IterationPath', 'System.Tags',
          'System.ChangedDate', 'System.CreatedDate', 'System.AssignedTo',
          'Microsoft.VSTS.Scheduling.TargetDate'
        ]
      },
      contentType: 'application/json'
    });
    const person = (v) => (v ? (v.displayName || v.uniqueName || '') : '');
    children = (batch.value || []).map(c => {
      const cf = c.fields || {};
      return {
        id: c.id,
        title: cf['System.Title'] || '',
        state: cf['System.State'] || '',
        type: cf['System.WorkItemType'] || '',
        areaPath: cf['System.AreaPath'] || '',
        iterationPath: cf['System.IterationPath'] || '',
        tags: cf['System.Tags'] || '',
        changedDate: cf['System.ChangedDate'] || '',
        createdDate: cf['System.CreatedDate'] || '',
        assignedTo: person(cf['System.AssignedTo']),
        targetDate: cf['Microsoft.VSTS.Scheduling.TargetDate'] || '',
        url: workItemUrl(org, project, c.id)
      };
    });
  }
  return { epic, children, prs };
}

// Comment threads on a PR. Returns active/resolved counts (user threads only)
// plus a light list of resolvable threads for context.
async function getPrThreads(org, project, repo, prId) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/threads?api-version=${API_VERSION}`
  );
  let active = 0, resolved = 0, total = 0;
  const items = [];
  for (const t of (d.value || [])) {
    const comments = (t.comments || []).filter(c => !c.isDeleted && (c.commentType || 'text') === 'text');
    if (!comments.length) continue; // skip pure system/status threads
    total++;
    const st = (t.status || '').toLowerCase();
    const isResolved = st === 'fixed' || st === 'closed' || st === 'wontfix' || st === 'bydesign';
    if (isResolved) resolved++;
    else active++; // active, pending, or unset
    const root = comments[0] || {};
    const last = comments[comments.length - 1] || root;
    const tc = t.threadContext || {};
    items.push({
      id: String(t.id),
      status: st || 'active',
      active: !isResolved,
      rootAuthorId: String((root.author && root.author.id) || ''),
      rootAuthor: (root.author && (root.author.displayName || root.author.uniqueName)) || 'unknown',
      lastAuthorId: String((last.author && last.author.id) || ''),
      lastAuthor: (last.author && (last.author.displayName || last.author.uniqueName)) || 'unknown',
      lastCommentAt: last.lastUpdatedDate || last.publishedDate || '',
      commentCount: comments.length,
      file: tc.filePath ? String(tc.filePath).replace(/^\/+/, '') : null,
      line: (tc.rightFileStart && tc.rightFileStart.line) || (tc.leftFileStart && tc.leftFileStart.line) || null,
      preview: String(root.content || '').trim().slice(0, 240)
    });
  }
  return { activeComments: active, resolvedComments: resolved, totalThreads: total, items };
}

// Ordered commits currently in a PR. The durable Code Flow checkpoint stores
// these IDs so a later refresh can distinguish genuinely new commits from a
// force-push or a comment-only update.
async function getPrCommits(org, project, repo, prId, limit = 250) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullRequests/${seg(prId)}/commits?$top=${Number(limit) || 250}&api-version=${API_VERSION}`
  );
  return (d.value || []).map(c => ({
    id: c.commitId || '',
    message: String(c.comment || '').split(/\r?\n/)[0],
    author: (c.author && (c.author.name || c.author.email)) || '',
    date: (c.author && c.author.date) || (c.committer && c.committer.date) || '',
    url: c.remoteUrl || ''
  })).filter(c => c.id);
}

async function getChangedFilesBetween(org, project, repo, baseSha, headSha, limit = 300) {
  if (!baseSha || !headSha || baseSha === headSha) return [];
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/diffs/commits?baseVersion=${encodeURIComponent(baseSha)}&baseVersionType=commit&targetVersion=${encodeURIComponent(headSha)}&targetVersionType=commit&$top=${Number(limit) || 300}&api-version=${API_VERSION}`
  );
  return (d.changes || []).map(c => c.item || {}).filter(i => i.path && !i.isFolder).map(i => String(i.path).replace(/^\/+/, ''));
}

// Per-reviewer participation stats on a PR, for gauging how a person helped the
// author flow their code. Returns how many comments THIS person authored, how many
// discussion threads they STARTED (root comment), and of those, how many ended up
// resolved (fixed/closed/wontfix/bydesign) — a proxy for "feedback that was acted
// on". System/status-only threads are ignored. Best-effort; never throws on empty.
async function getPrMyReview(org, project, repo, prId, personId) {
  const d = await apiSend(
    org,
    `${seg(project)}/_apis/git/repositories/${seg(repo)}/pullrequests/${seg(prId)}/threads?api-version=${API_VERSION}`
  );
  const pid = String(personId || '');
  let myComments = 0, myThreads = 0, myThreadsResolved = 0;
  for (const t of (d.value || [])) {
    const comments = (t.comments || []).filter(c => !c.isDeleted && (c.commentType || 'text') === 'text');
    if (!comments.length) continue;
    const mineHere = comments.filter(c => c.author && String(c.author.id) === pid);
    myComments += mineHere.length;
    const root = comments[0];
    if (root && root.author && String(root.author.id) === pid) {
      myThreads++;
      const st = (t.status || '').toLowerCase();
      if (st === 'fixed' || st === 'closed' || st === 'wontfix' || st === 'bydesign') myThreadsResolved++;
    }
  }
  return { myComments, myThreads, myThreadsResolved };
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
  getTokenSync,
  prewarmToken,
  getCurrentUser,
  voteLabel,
  getRepoContributors,
  getFileContributors,
  getPrChangedFiles,
  getPrCommits,
  getChangedFilesBetween,
  listPullRequests,
  getPrThreads,
  getPrMyReview,
  getPrActiveThreads,
  createPrThread,
  getPrStatuses,
  getPrPolicyEvaluations,
  getBuild,
  listRepos,
  listBranches,
  discover,
  pluginSignature,
  getTree,
  getFileText,
  fetchGitDocByWebUrl,
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
  getWorkItemComments,
  createWorkItem,
  searchEpics,
  EPIC_TYPES,
  getPrWorkItems,
  updateWorkItemState,
  getPullRequest,
  getSignInStatus,
  listProjectPullRequests,
  listMyWorkItems,
  queryWorkItems,
  getEpicTree
};
