// capabilities.js
//
// Marketplace Phase 2: agent capabilities — attach / detach MCP servers and
// skills to a single agent, and a catalog that aggregates the MCP servers and
// skills available across everything already installed (plugins, AzDO sources,
// builtin plugins, and the generated overlays).
//
// Attached capabilities are stored in a per-agent OVERLAY directory
// (SUPERVISOR_DATA_DIR/agent-overlays/<id>/) which agentPackage.buildAgentPackage
// merges automatically by agent id:
//   <overlay>/.mcp.json          -> extra MCP servers
//   <overlay>/skills/<name>/      -> extra skills (each contains SKILL.md)
//
// Nothing here talks to the SDK; validation/dry-run lives in server.js where the
// runner is available. This module is pure fs/path + the agentPackage helpers.

const fs = require('fs');
const path = require('path');
const agentPackage = require('./agentPackage');

const SUPERVISOR_DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.copilot', 'agent-supervisor');

const PLUGINS_DIR = path.join(SUPERVISOR_DATA_DIR, 'plugins');
const AZDO_STORE = path.join(SUPERVISOR_DATA_DIR, 'azdo-sources');
const BUILTIN_PLUGINS_DIR = path.join(__dirname, 'builtin-plugins');

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw) || {};
  } catch (_) { return {}; }
}

function safeSlug(v) {
  return String(v || 'item').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

// ---- Overlay (attached) state -------------------------------------------

function overlayMcpPath(id) {
  return path.join(agentPackage.overlayDir(id), '.mcp.json');
}
function overlaySkillsDir(id) {
  return path.join(agentPackage.overlayDir(id), 'skills');
}

/** Read the attached overlay MCP servers for an agent. Returns {name: cfg}. */
function getOverlayMcp(id) {
  const j = readJson(overlayMcpPath(id));
  return (j && j.mcpServers) || {};
}

/** Read the attached overlay skills for an agent. Returns [{name, description}]. */
function getOverlaySkills(id) {
  const dir = overlaySkillsDir(id);
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sk = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(sk)) continue;
    out.push({ name: e.name, description: skillDescription(sk) });
  }
  return out;
}

function skillDescription(skillMdPath) {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      let d = (m[1].match(/^description:\s*(.+?)\s*$/m) || [])[1];
      if (d) return d.trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return '';
}

// ---- Attach / detach ----------------------------------------------------

/** Attach (or replace) an MCP server in the agent overlay. serverConfig is the
 *  raw { command, args, env } object. Returns the updated overlay servers. */
function attachMcp(id, name, serverConfig) {
  if (!name) throw new Error('mcp server name is required');
  const dir = agentPackage.overlayDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const servers = getOverlayMcp(id);
  servers[name] = sanitizeServer(serverConfig);
  fs.writeFileSync(overlayMcpPath(id), JSON.stringify({ mcpServers: servers }, null, 2));
  return servers;
}

function detachMcp(id, name) {
  const servers = getOverlayMcp(id);
  if (!(name in servers)) return servers;
  delete servers[name];
  const p = overlayMcpPath(id);
  if (Object.keys(servers).length) {
    fs.writeFileSync(p, JSON.stringify({ mcpServers: servers }, null, 2));
  } else {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  return servers;
}

/**
 * Attach a skill to the agent overlay. Either copy from a source dir (must
 * contain SKILL.md) or write an inline { name, description, body }.
 */
function attachSkill(id, skill) {
  const name = safeSlug(skill && skill.name);
  if (!name || name === 'item') throw new Error('skill name is required');
  const dest = path.join(overlaySkillsDir(id), name);
  fs.mkdirSync(dest, { recursive: true });
  if (skill.sourceDir && fs.existsSync(path.join(skill.sourceDir, 'SKILL.md'))) {
    copyDir(skill.sourceDir, dest);
  } else {
    const desc = String(skill.description || '').replace(/\r?\n/g, ' ').trim();
    const body = String(skill.body || '').trim() || `# ${skill.name}\n\n${desc}`;
    const md = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(desc)}\n---\n${body}\n`;
    fs.writeFileSync(path.join(dest, 'SKILL.md'), md);
  }
  return getOverlaySkills(id);
}

function detachSkill(id, name) {
  const dest = path.join(overlaySkillsDir(id), safeSlug(name));
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
  // Tidy up the overlay skills dir + generated manifest when nothing remains so
  // sdk-runner._applyOverlayCaps doesn't add an empty plugin directory.
  const skillsDir = overlaySkillsDir(id);
  try {
    if (fs.readdirSync(skillsDir).length === 0) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
      const manifest = path.join(agentPackage.overlayDir(id), 'plugin.json');
      if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true });
    }
  } catch (_) {}
  return getOverlaySkills(id);
}

// Strip nothing structural but ensure a safe shape; secret env values are kept
// locally (they're needed to run) but flagged non-exportable downstream.
function sanitizeServer(cfg) {
  cfg = cfg || {};
  const out = {};
  if (cfg.command !== undefined) out.command = String(cfg.command);
  if (cfg.url !== undefined) out.url = String(cfg.url);
  if (cfg.type !== undefined) out.type = String(cfg.type);
  out.args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  out.env = (cfg.env && typeof cfg.env === 'object') ? cfg.env : {};
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// ---- Effective capabilities (what the agent actually runs with) ---------

/**
 * Compute the effective capabilities for an agent config by building (a fresh
 * copy of) its generated package and reading what landed in it. Falls back to
 * the agent's source cwd for project agents that aren't packaged.
 * Returns { mcp: [{name, source}], skills: [{name, description, source}] }.
 */
function getEffectiveCapabilities(config) {
  const id = config.id;
  const overlayMcp = getOverlayMcp(id);
  const overlaySkills = getOverlaySkills(id);

  // Base (co-located / plugin) MCP servers.
  const baseMcp = {};
  const baseMcpPaths = [];
  if (config.pluginDir) baseMcpPaths.push(path.join(config.pluginDir, '.mcp.json'));
  if (config.cwd) baseMcpPaths.push(path.join(config.cwd, '.mcp.json'));
  if (config.mcpConfig) {
    baseMcpPaths.push(path.isAbsolute(config.mcpConfig)
      ? config.mcpConfig : path.resolve(config.cwd || '.', config.mcpConfig));
  }
  for (const p of baseMcpPaths) {
    const j = readJson(p);
    if (j && j.mcpServers) for (const k of Object.keys(j.mcpServers)) baseMcp[k] = true;
  }

  // Base skills: plugin skills/ + co-located repo skills.
  const baseSkills = [];
  const skillRoots = [];
  if (config.pluginDir) skillRoots.push(path.join(config.pluginDir, 'skills'));
  if (config.cwd) { skillRoots.push(path.join(config.cwd, '.github', 'skills')); skillRoots.push(path.join(config.cwd, 'skills')); }
  for (const root of skillRoots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sk = path.join(root, e.name, 'SKILL.md');
      if (fs.existsSync(sk)) baseSkills.push({ name: e.name, description: skillDescription(sk), source: 'base' });
    }
  }

  const mcp = [];
  for (const name of Object.keys(baseMcp)) mcp.push({ name, source: 'base', attached: true, removable: false });
  for (const name of Object.keys(overlayMcp)) {
    if (mcp.find(m => m.name === name)) continue;
    mcp.push({ name, source: 'overlay', attached: true, removable: true, config: redact(overlayMcp[name]) });
  }

  const skills = [];
  for (const s of baseSkills) skills.push({ ...s, attached: true, removable: false });
  for (const s of overlaySkills) {
    if (skills.find(x => x.name === s.name)) continue;
    skills.push({ ...s, source: 'overlay', attached: true, removable: true });
  }

  return { mcp, skills };
}

// Redact env values so the UI never displays raw secrets.
function redact(server) {
  const out = { command: server.command, url: server.url, args: server.args || [] };
  out.env = {};
  for (const k of Object.keys(server.env || {})) out.env[k] = server.env[k] ? '••••' : '';
  return out;
}

// ---- Catalog (available capabilities across everything installed) -------

function listDirs(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch (_) { return []; }
}

/**
 * Build the capability catalog: every distinct MCP server and skill we can find
 * across installed plugins, builtin plugins, and materialized AzDO sources.
 * Returns { mcp: [{name, command, source, sourcePath, args}],
 *           skills: [{name, description, source, sourceDir}] }.
 */
function buildCatalog() {
  const mcpByName = new Map();
  const skillByKey = new Map();

  const addMcp = (name, cfg, sourceLabel, sourcePath) => {
    if (!name || mcpByName.has(name)) return;
    mcpByName.set(name, {
      name,
      command: cfg.command || cfg.url || '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      envKeys: Object.keys(cfg.env || {}),
      source: sourceLabel,
      sourcePath,
    });
  };
  const addSkill = (name, sk, sourceLabel) => {
    const key = name.toLowerCase();
    if (!name || skillByKey.has(key)) return;
    skillByKey.set(key, { name, description: sk.description, source: sourceLabel, sourceDir: sk.dir });
  };

  // 1) MCP from any .mcp.json under plugins/ and builtin-plugins/.
  const mcpRoots = [PLUGINS_DIR, BUILTIN_PLUGINS_DIR, AZDO_STORE];
  for (const root of mcpRoots) {
    for (const file of findFiles(root, '.mcp.json', 6)) {
      const j = readJson(file);
      const label = sourceLabelFor(file);
      if (j && j.mcpServers) for (const [n, c] of Object.entries(j.mcpServers)) addMcp(n, c || {}, label, file);
    }
    // 2) skills: any SKILL.md under these roots.
    for (const file of findFiles(root, 'SKILL.md', 6)) {
      const dir = path.dirname(file);
      addSkill(path.basename(dir), { description: skillDescription(file), dir }, sourceLabelFor(file));
    }
  }

  return {
    mcp: Array.from(mcpByName.values()).sort((a, b) => a.name.localeCompare(b.name)),
    skills: Array.from(skillByKey.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Resolve the RAW (non-redacted) server config for a catalog entry, read
// server-side from its source .mcp.json so secrets never round-trip the client.
function resolveCatalogMcp(sourcePath, name) {
  if (!sourcePath || !name) return null;
  const j = readJson(sourcePath);
  const srv = j && j.mcpServers && j.mcpServers[name];
  return srv ? sanitizeServer(srv) : null;
}

// Resolve a catalog skill's source dir (must contain SKILL.md).
function resolveCatalogSkill(sourceDir) {
  if (!sourceDir) return null;
  return fs.existsSync(path.join(sourceDir, 'SKILL.md')) ? sourceDir : null;
}

function sourceLabelFor(file) {
  const rel = file.replace(SUPERVISOR_DATA_DIR + path.sep, '').replace(__dirname + path.sep, '');
  const parts = rel.split(path.sep);
  if (parts[0] === 'plugins') return 'plugin:' + (parts[1] === '.runtime' ? parts[2] : parts[1]);
  if (parts[0] === 'azdo-sources') return 'azdo:' + parts.slice(1, 4).join('/');
  if (parts[0] === 'builtin-plugins') return 'builtin:' + parts[1];
  return parts.slice(0, 2).join('/');
}

// Shallow recursive file finder (bounded depth) for a given basename.
function findFiles(root, basename, maxDepth, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      findFiles(p, basename, maxDepth, depth + 1, out);
    } else if (e.name.toLowerCase() === basename.toLowerCase()) {
      out.push(p);
    }
  }
  return out;
}

module.exports = {
  getOverlayMcp,
  getOverlaySkills,
  attachMcp,
  detachMcp,
  attachSkill,
  detachSkill,
  getEffectiveCapabilities,
  buildCatalog,
  resolveCatalogMcp,
  resolveCatalogSkill,
};
