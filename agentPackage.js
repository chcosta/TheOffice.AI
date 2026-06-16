// agentPackage.js
//
// Marketplace Phase 1: the "generated per-agent runtime package".
//
// Background (proven by experiments/marketplace-spike/skills-spike.cjs and by the
// helix plugin in prod): when an agent is run through the SDK via
// `pluginDirectories:[dir]`, the SDK auto-loads everything a plugin folder
// declares — plugin.json + agents/ + .mcp.json + skills/ — with no manual
// wiring. PLUGIN agents already get this. PROJECT agents (and AzDO single-agent
// installs) do NOT: they run via `customAgents` + an explicit `mcpServers`, and
// skills are never wired. That asymmetry is the root of the Helix UX Standup
// "can't query AzDO / no Reasoning & steps" bug.
//
// This module removes the asymmetry by GENERATING a tiny plugin package on disk
// that wraps a single project/azdo agent together with its co-located MCP
// servers and skills, plus any per-agent overlay added via the marketplace.
// The runtime can then run ANY agent through the uniform pluginDirectories path.
//
// The builder is pure (fs/path only, no SDK). It is idempotent: it rebuilds the
// package from source on every call so edits to the source agent / mcp / skills
// are always reflected.

const fs = require('fs');
const path = require('path');

const SUPERVISOR_DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.copilot', 'agent-supervisor');

const PACKAGES_ROOT = path.join(SUPERVISOR_DATA_DIR, 'generated-packages');
const OVERLAYS_ROOT = path.join(SUPERVISOR_DATA_DIR, 'agent-overlays');

// Per-agent overlay directory: marketplace-attached MCP servers + skills live
// here and are merged into the generated package automatically by agent id, so
// attaching a capability only requires writing files under this dir + a
// re-register (no config threading through the runtime).
function overlayDir(id) {
  return path.join(OVERLAYS_ROOT, safeSlug(id));
}

// Plugin names are addressed by the SDK as "<name>:<agentSlug>"; keep them to a
// safe, lowercase, dash/underscore charset and namespace them so they never
// collide with a real installed plugin.
function pkgName(id) {
  const safe = String(id || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return 'gen-' + (safe || 'agent');
}

function safeSlug(v) {
  return String(v || 'agent').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// Read a JSON file, tolerating BOM / missing file. Returns {} on any problem.
function readJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Find the source `.agent.md` file for a config.
 * Honors an explicit config.agentMdPath; otherwise searches
 * <cwd>/.github/agents/*.agent.md by frontmatter name or file slug.
 * Returns the absolute file path or null.
 */
function resolveAgentMd(config) {
  if (config.agentMdPath && fs.existsSync(config.agentMdPath)) return config.agentMdPath;
  if (!config.cwd) return null;
  const agentsDir = path.join(config.cwd, '.github', 'agents');
  let files;
  try {
    files = fs.readdirSync(agentsDir).filter(f => f.toLowerCase().endsWith('.agent.md'));
  } catch (_) {
    return null;
  }
  if (!files.length) return null;
  const want = String(config.agent || config.name || '').trim().toLowerCase();
  const norm = s => s.replace(/\s+supervised$/, '');
  let exact = null, byName = null;
  for (const f of files) {
    const slug = f.replace(/\.agent\.md$/i, '').toLowerCase();
    if (slug === want) { exact = f; break; }
    try {
      const raw = fs.readFileSync(path.join(agentsDir, f), 'utf8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let nm = m && (m[1].match(/^name:\s*(.+?)\s*$/m) || [])[1];
      if (nm) nm = nm.trim().replace(/^["']|["']$/g, '');
      if (nm && norm(nm.toLowerCase()) === norm(want)) byName = f;
    } catch (_) {}
  }
  const pick = exact || byName || (files.length === 1 ? files[0] : null);
  return pick ? path.join(agentsDir, pick) : null;
}

/**
 * Discover candidate skill directories co-located with an agent's source.
 * Each returned entry is a directory that directly contains a SKILL.md.
 * Scans <cwd>/.github/skills and <cwd>/skills (one level deep).
 */
function discoverSkillDirs(cwd) {
  const out = [];
  if (!cwd) return out;
  const roots = [path.join(cwd, '.github', 'skills'), path.join(cwd, 'skills')];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push({ name: e.name, dir });
    }
  }
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Merge mcpServers from an ordered list of .mcp.json paths (later wins on key
 * collision). Returns a possibly-empty object { name: serverConfig, ... }.
 */
function mergeMcp(paths) {
  const merged = {};
  for (const p of paths) {
    if (!p) continue;
    const j = readJson(p);
    if (j && j.mcpServers && typeof j.mcpServers === 'object') {
      for (const [k, v] of Object.entries(j.mcpServers)) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Build a generated runtime package for a single agent config.
 *
 * Inputs honored on `config`:
 *   - id            stable agent id (used for the package namespace)
 *   - name / agent  agent display name or slug (used to find the .agent.md)
 *   - cwd           the agent's working dir (repo root containing .github)
 *   - agentMdPath   explicit path to the .agent.md (optional)
 *   - mcpConfig     path to a co-located .mcp.json (optional)
 *   - mcpOverlay    path to a per-agent overlay .mcp.json added via marketplace
 *                   (optional; merged last so it wins)
 *   - extraSkillDirs array of absolute dirs (each containing SKILL.md) to add
 *                   (optional; e.g. marketplace-attached skills)
 *
 * Returns { pluginDir, pluginName, agentId, agentSlug, mcpCount, skillCount }
 * or null if no source agent .md could be resolved.
 */
function buildAgentPackage(config) {
  const agentMd = resolveAgentMd(config);
  if (!agentMd) return null;

  const slug = safeSlug(path.basename(agentMd).replace(/\.agent\.md$/i, ''));
  const name = pkgName(config.id || slug);
  const pluginDir = path.join(PACKAGES_ROOT, name);

  // Rebuild from scratch for freshness.
  rmrf(pluginDir);
  fs.mkdirSync(path.join(pluginDir, 'agents'), { recursive: true });

  // 1) agent file (verbatim copy preserves frontmatter + body exactly)
  fs.copyFileSync(agentMd, path.join(pluginDir, 'agents', slug + '.agent.md'));

  // 2) skills
  let skillCount = 0;
  const skillRoot = path.join(pluginDir, 'skills');
  const skillDirs = discoverSkillDirs(config.cwd).slice();
  for (const extra of (config.extraSkillDirs || [])) {
    if (extra && fs.existsSync(path.join(extra, 'SKILL.md'))) {
      skillDirs.push({ name: path.basename(extra), dir: extra });
    }
  }
  // Marketplace-attached skills from the per-agent overlay dir.
  const ovSkills = path.join(overlayDir(config.id || slug), 'skills');
  try {
    for (const e of fs.readdirSync(ovSkills, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(ovSkills, e.name, 'SKILL.md'))) {
        skillDirs.push({ name: e.name, dir: path.join(ovSkills, e.name) });
      }
    }
  } catch (_) {}
  const seen = new Set();
  for (const s of skillDirs) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    copyDir(s.dir, path.join(skillRoot, safeSlug(s.name)));
    skillCount++;
  }

  // 3) mcp (co-located repo .mcp.json, then explicit mcpConfig, then per-agent
  //    overlay, then an explicit mcpOverlay path — later sources win)
  const mcpPaths = [];
  if (config.cwd) mcpPaths.push(path.join(config.cwd, '.mcp.json'));
  if (config.mcpConfig) {
    mcpPaths.push(path.isAbsolute(config.mcpConfig)
      ? config.mcpConfig
      : path.resolve(config.cwd || '.', config.mcpConfig));
  }
  mcpPaths.push(path.join(overlayDir(config.id || slug), '.mcp.json'));
  if (config.mcpOverlay) mcpPaths.push(config.mcpOverlay);
  const mcpServers = mergeMcp(mcpPaths);
  const mcpCount = Object.keys(mcpServers).length;
  if (mcpCount) {
    fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2));
  }

  // 4) plugin manifest
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name,
    description: 'Generated runtime package for agent ' + (config.id || slug),
    version: '1.0.0',
    agents: 'agents/',
    skills: 'skills/'
  }, null, 2));

  return {
    pluginDir,
    pluginName: name,
    agentId: name + ':' + slug,
    agentSlug: slug,
    mcpCount,
    skillCount,
  };
}

module.exports = {
  buildAgentPackage,
  resolveAgentMd,
  discoverSkillDirs,
  mergeMcp,
  overlayDir,
  PACKAGES_ROOT,
  OVERLAYS_ROOT,
};
