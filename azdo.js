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

function getToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  let token;
  try {
    token = execSync(
      `az account get-access-token --resource ${AZDO_RESOURCE} --query accessToken -o tsv`,
      { encoding: 'utf-8', timeout: 30_000, shell: true }
    ).trim();
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    throw new Error(
      'Could not get an Azure DevOps token from the Azure CLI. Run "az login" on the server machine. ' +
      (msg ? `Details: ${msg.split('\n')[0]}` : '')
    );
  }
  if (!token) throw new Error('Azure CLI returned an empty Azure DevOps token. Run "az login".');
  // Tokens last ~1h; cache for 50 minutes.
  _tokenCache = { token, expiresAt: now + 50 * 60_000 };
  return token;
}

function seg(v) {
  return encodeURIComponent(String(v || '').trim());
}

async function api(org, projectAndRest, { raw = false } = {}) {
  const base = `https://dev.azure.com/${seg(org)}/`;
  const url = base + projectAndRest;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: raw ? 'text/plain' : 'application/json'
    }
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Azure DevOps denied access (${res.status}). Confirm you have access to this org/project/repo. ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`Azure DevOps resource not found (404). Check the org/project/repo/branch names. ${detail}`);
    }
    throw new Error(`Azure DevOps request failed (${res.status}). ${detail}`);
  }
  return raw ? res.text() : res.json();
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

// Materialize a single agent .md. Returns { cwd, agentMdPath }.
// cwd is the directory that contains the `.github` folder so the runtime can
// resolve `.github/agents/<file>.md` exactly as it would in a local checkout.
async function materializeAgent(org, project, repo, branch, agentPath) {
  const root = repoRoot(org, project, repo, branch);
  const rel = agentPath.replace(/^\//, '');
  await writeFileFromRepo(org, project, repo, branch, root, rel);
  const ghIdx = rel.toLowerCase().indexOf('.github/');
  const cwdRel = ghIdx > 0 ? rel.slice(0, ghIdx).replace(/\/$/, '') : '';
  return {
    cwd: cwdRel ? path.join(root, cwdRel.replace(/\//g, path.sep)) : root,
    agentMdPath: path.join(root, rel.replace(/\//g, path.sep))
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

module.exports = {
  AZDO_STORE,
  getToken,
  listRepos,
  listBranches,
  discover,
  materializeAgent,
  materializePlugin,
  getObjectId,
  repoRoot
};
