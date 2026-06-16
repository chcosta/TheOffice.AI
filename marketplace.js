// marketplace.js
//
// Marketplace Phase 3: a unified, greedy catalog of agents, plugins, skills and
// MCP servers discovered from user-managed "sources" (local folders or AzDO
// repos). Sources are scanned with a bounded walk that classifies every
// capability it finds — including standalone skills and co-located .mcp.json
// files that the older agent/plugin-only discovery missed (the root cause of the
// "Helix UX Standup agent can't query AzDO" bug: its .mcp.json lived next to the
// agent but was never surfaced).
//
// Data files (in SUPERVISOR_DATA_DIR):
//   marketplace-sources.json   -> [{ id, kind, label, local|azdo, addedAt, lastScannedAt, counts }]
//   marketplace-catalog.json   -> { [sourceId]: { scannedAt, entries:[...] } }
//
// AzDO skills/mcp are downloaded on demand into marketplace-cache/<sourceId>/...
// so "add to agent" can reuse the Phase 2 capabilities.attach* helpers uniformly.
//
// Pure fs/path + azdo.js (network) + capabilities.buildCatalog (installed view).
// No SDK here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const azdo = require('./azdo');
const capabilities = require('./capabilities');

const SUPERVISOR_DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.copilot', 'agent-supervisor');

const SOURCES_PATH = path.join(SUPERVISOR_DATA_DIR, 'marketplace-sources.json');
const CATALOG_PATH = path.join(SUPERVISOR_DATA_DIR, 'marketplace-catalog.json');
const CACHE_DIR = path.join(SUPERVISOR_DATA_DIR, 'marketplace-cache');

const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', '.vs', 'bin', 'obj', 'dist', 'out']);
const MAX_DEPTH = 6;

// ---- low-level json ------------------------------------------------------

function readJson(p, fallback) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (_) { return fallback; }
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function shortHash(v) {
  return crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);
}

function safeSlug(v) {
  return String(v || 'item').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

// ---- sources store -------------------------------------------------------

function listSources() {
  const arr = readJson(SOURCES_PATH, []);
  return Array.isArray(arr) ? arr : [];
}

function saveSources(sources) {
  writeJson(SOURCES_PATH, sources);
}

function getSource(id) {
  return listSources().find(s => s.id === id) || null;
}

// input: { kind:'local', path } | { kind:'azdo', org, project, repo, branch, label? }
function addSource(input) {
  if (!input || !input.kind) throw new Error('kind is required');
  const sources = listSources();
  let source;
  if (input.kind === 'local') {
    const dir = String(input.path || '').trim();
    if (!dir) throw new Error('path is required for a local source');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
    const id = 'local-' + shortHash(path.resolve(dir).toLowerCase());
    if (sources.some(s => s.id === id)) throw new Error('That folder is already a source');
    source = {
      id, kind: 'local',
      label: input.label || path.basename(dir.replace(/[\\/]+$/, '')) || dir,
      local: { path: path.resolve(dir) },
      addedAt: new Date().toISOString(),
      lastScannedAt: null,
      counts: {},
    };
  } else if (input.kind === 'azdo') {
    const { org, project, repo, branch } = input;
    if (!org || !project || !repo || !branch) {
      throw new Error('org, project, repo and branch are required for an azdo source');
    }
    const id = 'azdo-' + shortHash([org, project, repo, branch].join('/').toLowerCase());
    if (sources.some(s => s.id === id)) throw new Error('That AzDO repo/branch is already a source');
    source = {
      id, kind: 'azdo',
      label: input.label || `${repo}@${branch}`,
      azdo: { org, project, repo, branch },
      addedAt: new Date().toISOString(),
      lastScannedAt: null,
      counts: {},
    };
  } else {
    throw new Error(`Unknown source kind: ${input.kind}`);
  }
  sources.push(source);
  saveSources(sources);
  return source;
}

function removeSource(id) {
  const sources = listSources();
  const idx = sources.findIndex(s => s.id === id);
  if (idx < 0) return false;
  sources.splice(idx, 1);
  saveSources(sources);
  // drop cached catalog + materialization for that source
  const cat = readJson(CATALOG_PATH, {}) || {};
  if (cat[id]) { delete cat[id]; writeJson(CATALOG_PATH, cat); }
  try { fs.rmSync(path.join(CACHE_DIR, safeSlug(id)), { recursive: true, force: true }); } catch (_) {}
  return true;
}

// Derive candidate marketplace sources from the source locations of already
// installed agents/plugins. Returns inputs ready for addSource(), each tagged
// with the predicted id, a label, whether it already exists, and which agents
// it came from. Pure: callers pass the agents.json array.
function suggestSources(agents) {
  const existing = new Set(listSources().map(s => s.id));
  const byId = new Map();

  const add = (input, predictedId, fromName) => {
    let rec = byId.get(predictedId);
    if (!rec) {
      rec = { ...input, id: predictedId, exists: existing.has(predictedId), from: [] };
      byId.set(predictedId, rec);
    }
    if (fromName && !rec.from.includes(fromName)) rec.from.push(fromName);
  };

  for (const a of Array.isArray(agents) ? agents : []) {
    const name = a.name || a.id || 'agent';
    const src = a.source || {};

    // AzDO-installed agents/plugins -> an azdo source for that repo/branch.
    const org = src.org, project = src.project, repo = src.repo, branch = src.branch;
    if ((src.type === 'azdo' || (org && repo)) && org && project && repo && branch) {
      const id = 'azdo-' + shortHash([org, project, repo, branch].join('/').toLowerCase());
      add({ kind: 'azdo', org, project, repo, branch, label: `${repo}@${branch}` }, id, name);
      continue;
    }

    // Local agents/plugins -> a local folder source. Prefer the real repo/source
    // root; skip the azdo materialization cache (covered above) and missing paths.
    const candidates = [];
    if (src.type === 'local' && src.path) {
      try { candidates.push(fs.statSync(src.path).isDirectory() ? src.path : path.dirname(src.path)); } catch (_) {}
    }
    if (a.pluginDir) candidates.push(a.pluginDir);
    if (a.sourceDir) candidates.push(a.sourceDir);
    if (a.cwd) candidates.push(a.cwd);
    for (const c of candidates) {
      const dir = String(c || '').trim();
      if (!dir) continue;
      if (/[\\/]azdo-sources[\\/]/i.test(dir)) continue; // azdo cache, not a real local source
      let resolved;
      try { if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue; resolved = path.resolve(dir); } catch (_) { continue; }
      const id = 'local-' + shortHash(resolved.toLowerCase());
      add({ kind: 'local', path: resolved, label: path.basename(resolved.replace(/[\\/]+$/, '')) || resolved }, id, name);
      break; // one local source per agent
    }
  }

  return [...byId.values()];
}

// ---- classification helpers ---------------------------------------------

function mcpServerNames(text) {
  try {
    const j = JSON.parse(text);
    return j && j.mcpServers ? Object.entries(j.mcpServers) : [];
  } catch (_) { return []; }
}

function skillDescription(text) {
  // SKILL.md frontmatter `description:` or first non-heading line.
  const m = text.match(/^description:\s*(.+)$/im);
  if (m) return m[1].replace(/^["']|["']$/g, '').trim().slice(0, 240);
  const line = text.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#'));
  return line ? line.trim().slice(0, 240) : '';
}

function agentMeta(text) {
  // .agent.md frontmatter: name / description.
  const out = { name: '', description: '' };
  const fm = text.match(/^---\s*([\s\S]*?)\r?\n---/);
  const block = fm ? fm[1] : text.slice(0, 600);
  const n = block.match(/^name:\s*(.+)$/im); if (n) out.name = n[1].replace(/^["']|["']$/g, '').trim();
  const d = block.match(/^description:\s*(.+)$/im); if (d) out.description = d[1].replace(/^["']|["']$/g, '').trim().slice(0, 240);
  return out;
}

function makeEntry(source, type, name, extra) {
  const base = {
    id: [source.id, type, safeSlug(name), shortHash(extra.path || name)].join(':'),
    sourceId: source.id,
    sourceLabel: source.label,
    sourceKind: source.kind,
    type,
    name,
    displayName: extra.displayName || name,
    description: extra.description || '',
    path: extra.path || '',
  };
  return Object.assign(base, extra.fields || {});
}

// ---- local scan ----------------------------------------------------------

function scanLocal(source) {
  const root = source.local.path;
  const entries = [];
  const seenAgent = new Set();

  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const inAgentsDir = /[\\/]\.github[\\/]agents$/i.test(dir);
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue;
        walk(p, depth + 1);
        continue;
      }
      const lower = it.name.toLowerCase();
      if (lower.endsWith('.agent.md') || (inAgentsDir && lower.endsWith('.md'))) {
        if (seenAgent.has(p)) continue; seenAgent.add(p);
        let meta = {}; try { meta = agentMeta(fs.readFileSync(p, 'utf8')); } catch (_) {}
        const ref = it.name.replace(/\.agent\.md$/i, '').replace(/\.md$/i, '');
        entries.push(makeEntry(source, 'agent', meta.name || ref, {
          displayName: meta.name || ref, description: meta.description, path: p,
          fields: { agent: { ref, cwd: rootCwdFor(root, p) } },
        }));
      } else if (lower === 'plugin.json') {
        let meta = {}; try { meta = readJson(p, {}) || {}; } catch (_) {}
        const name = meta.name || path.basename(path.dirname(p));
        entries.push(makeEntry(source, 'plugin', name, {
          displayName: meta.displayName || name, description: meta.description || '', path: p,
          fields: { plugin: { dir: path.dirname(p) } },
        }));
      } else if (lower === 'skill.md') {
        const dir2 = path.dirname(p);
        let desc = ''; try { desc = skillDescription(fs.readFileSync(p, 'utf8')); } catch (_) {}
        entries.push(makeEntry(source, 'skill', path.basename(dir2), {
          description: desc, path: p,
          fields: { skill: { dir: dir2 } },
        }));
      } else if (lower === '.mcp.json') {
        let text = ''; try { text = fs.readFileSync(p, 'utf8'); } catch (_) {}
        for (const [sname, cfg] of mcpServerNames(text)) {
          entries.push(makeEntry(source, 'mcp', sname, {
            description: (cfg && (cfg.command || cfg.url)) || '', path: p,
            fields: {
              mcp: {
                server: sname,
                command: (cfg && (cfg.command || cfg.url)) || '',
                args: (cfg && Array.isArray(cfg.args)) ? cfg.args : [],
                envKeys: (cfg && cfg.env) ? Object.keys(cfg.env) : [],
              },
            },
          }));
        }
      }
    }
  }

  walk(root, 0);
  return entries;
}

// Best-effort cwd for a local agent: the repo root (folder containing .github)
// if present, else the folder holding the agent file.
function rootCwdFor(root, agentPath) {
  let d = path.dirname(agentPath);
  for (let i = 0; i < MAX_DEPTH && d.startsWith(root); i++) {
    if (fs.existsSync(path.join(d, '.github'))) return d;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return root;
}

// ---- azdo scan -----------------------------------------------------------

async function scanAzdo(source) {
  const { org, project, repo, branch } = source.azdo;
  const entries = [];

  // Agents + plugins via the existing discover (frontmatter aware).
  let discovered = [];
  try { discovered = await azdo.discover(org, project, repo, branch); } catch (_) { discovered = []; }
  for (const d of discovered) {
    entries.push(makeEntry(source, d.kind === 'plugin' ? 'plugin' : 'agent', d.displayName || d.name || d.id, {
      displayName: d.displayName || d.name || d.id,
      description: d.description || '',
      path: d.path || '',
      fields: {
        azdo: { org, project, repo, branch, objectId: d.objectId || null },
        install: { kind: d.kind, item: d },
      },
    }));
  }

  // Standalone skills + co-located .mcp.json via a tree sweep.
  let tree = [];
  try { tree = await azdo.getTree(org, project, repo, branch); } catch (_) { tree = []; }
  const skillPaths = tree.filter(i => /(^|\/)SKILL\.md$/i.test(i.path));
  const mcpPaths = tree.filter(i => /(^|\/)\.mcp\.json$/i.test(i.path));

  for (const s of skillPaths) {
    const dir = s.path.replace(/\/SKILL\.md$/i, '');
    const name = dir.split('/').filter(Boolean).pop() || 'skill';
    let desc = '';
    try { desc = skillDescription(await azdo.getFileText(org, project, repo, branch, s.path)); } catch (_) {}
    entries.push(makeEntry(source, 'skill', name, {
      description: desc, path: s.path,
      fields: { azdo: { org, project, repo, branch }, skill: { repoPath: s.path } },
    }));
  }
  for (const m of mcpPaths) {
    let text = '';
    try { text = await azdo.getFileText(org, project, repo, branch, m.path); } catch (_) {}
    for (const [sname, cfg] of mcpServerNames(text)) {
      entries.push(makeEntry(source, 'mcp', sname, {
        description: (cfg && (cfg.command || cfg.url)) || '', path: m.path,
        fields: {
          azdo: { org, project, repo, branch },
          mcp: {
            server: sname,
            command: (cfg && (cfg.command || cfg.url)) || '',
            args: (cfg && Array.isArray(cfg.args)) ? cfg.args : [],
            envKeys: (cfg && cfg.env) ? Object.keys(cfg.env) : [],
            repoPath: m.path,
          },
        },
      }));
    }
  }
  return entries;
}

// ---- scan + catalog ------------------------------------------------------

async function scanSource(id) {
  const source = getSource(id);
  if (!source) throw new Error('Unknown source: ' + id);
  const entries = source.kind === 'local' ? scanLocal(source) : await scanAzdo(source);

  const counts = {};
  for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;

  const cat = readJson(CATALOG_PATH, {}) || {};
  cat[id] = { scannedAt: new Date().toISOString(), entries };
  writeJson(CATALOG_PATH, cat);

  const sources = listSources();
  const sIdx = sources.findIndex(s => s.id === id);
  if (sIdx >= 0) {
    sources[sIdx].lastScannedAt = cat[id].scannedAt;
    sources[sIdx].counts = counts;
    saveSources(sources);
  }
  return { source: sources[sIdx], counts, total: entries.length };
}

// Merge every scanned source's entries with an implicit "installed" view so the
// catalog is useful even before the user adds a source.
function installedEntries() {
  const installedSource = { id: 'installed', kind: 'installed', label: 'Installed' };
  const out = [];
  let cat = { mcp: [], skills: [] };
  try { cat = capabilities.buildCatalog(); } catch (_) {}
  for (const m of cat.mcp || []) {
    out.push(makeEntry(installedSource, 'mcp', m.name, {
      description: m.command || '', path: m.sourcePath || '',
      fields: {
        sourceLabel: m.source || 'Installed',
        mcp: { server: m.name, command: m.command, args: m.args || [], envKeys: m.envKeys || [], sourcePath: m.sourcePath },
      },
    }));
  }
  for (const s of cat.skills || []) {
    out.push(makeEntry(installedSource, 'skill', s.name, {
      description: s.description || '', path: s.sourceDir || '',
      fields: { sourceLabel: s.source || 'Installed', skill: { dir: s.sourceDir } },
    }));
  }
  return out;
}

function getCatalog(filter) {
  filter = filter || {};
  const cat = readJson(CATALOG_PATH, {}) || {};
  let entries = [];
  if (filter.sourceId && filter.sourceId !== 'installed') {
    entries = (cat[filter.sourceId] && cat[filter.sourceId].entries) || [];
  } else if (filter.sourceId === 'installed') {
    entries = installedEntries();
  } else {
    for (const v of Object.values(cat)) entries = entries.concat((v && v.entries) || []);
    entries = entries.concat(installedEntries());
  }
  if (filter.type) entries = entries.filter(e => e.type === filter.type);
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    entries = entries.filter(e =>
      (e.name && e.name.toLowerCase().includes(q)) ||
      (e.displayName && e.displayName.toLowerCase().includes(q)) ||
      (e.description && e.description.toLowerCase().includes(q)) ||
      (e.sourceLabel && e.sourceLabel.toLowerCase().includes(q)));
  }
  const counts = {};
  for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;
  return { entries, counts, total: entries.length };
}

function findEntry(entryId) {
  const cat = readJson(CATALOG_PATH, {}) || {};
  for (const v of Object.values(cat)) {
    const hit = (v.entries || []).find(e => e.id === entryId);
    if (hit) return hit;
  }
  return installedEntries().find(e => e.id === entryId) || null;
}

// Resolve the first catalog entry matching a type + name (case-insensitive).
// Used by Design-with-AI apply, where the model references caps by type:name.
function resolveByTypeName(type, name) {
  if (!type || !name) return null;
  const want = String(name).toLowerCase();
  const { entries } = getCatalog({ type });
  return entries.find(e => (e.name || '').toLowerCase() === want)
    || entries.find(e => (e.displayName || '').toLowerCase() === want)
    || null;
}

// Resolve a skill/mcp entry to a LOCAL source path/dir usable by
// capabilities.attach*. AzDO entries are downloaded into the cache on demand.
async function materializeForAttach(entry) {
  if (!entry) throw new Error('entry not found');
  if (entry.type === 'mcp') {
    if (entry.mcp && entry.mcp.sourcePath) return { kind: 'mcp', sourcePath: entry.mcp.sourcePath, name: entry.mcp.server };
    if (entry.sourceKind === 'local' && entry.path) return { kind: 'mcp', sourcePath: entry.path, name: entry.mcp.server };
    if (entry.azdo && entry.mcp && entry.mcp.repoPath) {
      const { org, project, repo, branch } = entry.azdo;
      const text = await azdo.getFileText(org, project, repo, branch, entry.mcp.repoPath);
      const dest = path.join(CACHE_DIR, safeSlug(entry.sourceId), safeSlug(entry.mcp.repoPath));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
      return { kind: 'mcp', sourcePath: dest, name: entry.mcp.server };
    }
  } else if (entry.type === 'skill') {
    if (entry.skill && entry.skill.dir) return { kind: 'skill', sourceDir: entry.skill.dir, name: entry.name };
    if (entry.azdo && entry.skill && entry.skill.repoPath) {
      const { org, project, repo, branch } = entry.azdo;
      const text = await azdo.getFileText(org, project, repo, branch, entry.skill.repoPath);
      const dir = path.join(CACHE_DIR, safeSlug(entry.sourceId), 'skills', safeSlug(entry.name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
      return { kind: 'skill', sourceDir: dir, name: entry.name };
    }
  }
  throw new Error(`Cannot add a ${entry.type} of this source to an agent`);
}

module.exports = {
  SOURCES_PATH,
  CATALOG_PATH,
  CACHE_DIR,
  listSources,
  getSource,
  addSource,
  removeSource,
  suggestSources,
  scanLocal,
  scanAzdo,
  scanSource,
  getCatalog,
  findEntry,
  resolveByTypeName,
  materializeForAttach,
};
