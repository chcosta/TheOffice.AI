// Agent export: serialize an agent (+ its capability overlay) into a set of
// files suitable for committing to an Azure DevOps repo. Two layouts:
//   - 'plugin' : a full package under .github/plugin/<name>/ (agent + .mcp.json + skills)
//   - 'agent'  : just .github/agents/<slug>.agent.md (single-file; caps dropped)
//
// Secrets never leave the box raw: every non-empty MCP env value is rewritten to
// a ${VAR} placeholder, and a secret scan runs over the final content so a stray
// token in an agent body or skill blocks the push.

const fs = require('fs');
const path = require('path');
const agentPackage = require('./agentPackage');

function safeSlug(v) {
  return String(v || 'agent').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw) || {};
  } catch (_) { return {}; }
}

// Recursively list files under root as repo-relative POSIX paths.
function walk(root, base = root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Stage the complete effective package for a config into a temp dir.
 * - project agents: reuse buildAgentPackage (already merges overlay).
 * - plugin agents:  copy the plugin dir, then merge the overlay .mcp.json and
 *   overlay skills on top.
 * Returns { stageDir, slug, pluginName, kind } or null if nothing to export.
 */
function stageExport(config) {
  const tmpRoot = path.join(require('os').tmpdir(), 'agent-export', safeSlug(config.id || config.name) + '-' + Date.now());
  rmrf(tmpRoot);

  if (!config.pluginDir) {
    const built = agentPackage.buildAgentPackage(config);
    if (!built) return null;
    copyDir(built.pluginDir, tmpRoot);
    return { stageDir: tmpRoot, slug: built.agentSlug, pluginName: built.pluginName, kind: 'project' };
  }

  // Plugin agent: stage the plugin package, then overlay.
  copyDir(config.pluginDir, tmpRoot);
  const ovDir = agentPackage.overlayDir(config.id || config.name);
  // Merge overlay MCP (overlay wins).
  const ovMcp = readJson(path.join(ovDir, '.mcp.json'));
  if (ovMcp && ovMcp.mcpServers && Object.keys(ovMcp.mcpServers).length) {
    const target = path.join(tmpRoot, '.mcp.json');
    const base = readJson(target);
    const merged = { mcpServers: { ...(base.mcpServers || {}), ...ovMcp.mcpServers } };
    fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  }
  // Add overlay skills.
  const ovSkills = path.join(ovDir, 'skills');
  try {
    for (const e of fs.readdirSync(ovSkills, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(ovSkills, e.name, 'SKILL.md'))) {
        copyDir(path.join(ovSkills, e.name), path.join(tmpRoot, 'skills', safeSlug(e.name)));
      }
    }
  } catch (_) {}
  const name = safeSlug(path.basename(config.pluginDir));
  // Find an agent slug from agents/*.agent.md if present.
  let slug = name;
  try {
    const f = fs.readdirSync(path.join(tmpRoot, 'agents')).find(x => /\.agent\.md$/i.test(x));
    if (f) slug = safeSlug(f.replace(/\.agent\.md$/i, ''));
  } catch (_) {}
  return { stageDir: tmpRoot, slug, pluginName: name, kind: 'plugin' };
}

// Rewrite every non-empty MCP env value to a ${KEY} placeholder so secrets are
// never serialized. Returns { json, redactions:[{server,key}] }.
function redactMcpJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (_) { return { json: text, redactions: [] }; }
  const redactions = [];
  for (const [server, cfg] of Object.entries(obj.mcpServers || {})) {
    if (!cfg || !cfg.env) continue;
    for (const k of Object.keys(cfg.env)) {
      if (cfg.env[k] !== undefined && cfg.env[k] !== null && String(cfg.env[k]).length) {
        cfg.env[k] = '${' + k + '}';
        redactions.push({ server, key: k });
      }
    }
  }
  return { json: JSON.stringify(obj, null, 2), redactions };
}

const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'Azure DevOps PAT', re: /\b[a-z2-7]{52}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

function scanSecrets(files) {
  const findings = [];
  for (const f of files) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(f.content)) findings.push({ path: f.path, kind: p.name });
    }
  }
  return findings;
}

/**
 * Build the file set + metadata for an export. Does NOT touch the network.
 * opts: { layout:'plugin'|'agent', basePath?:'', pluginName?:string }
 * Returns { files:[{path,content,changeType}], redactions, secrets, warnings,
 *           slug, pluginName, layout, branchSuggestion }.
 */
function buildExport(config, opts = {}) {
  const layout = opts.layout === 'agent' ? 'agent' : 'plugin';
  const staged = stageExport(config);
  if (!staged) return null;
  const base = String(opts.basePath || '').replace(/^\/+|\/+$/g, '');
  const prefix = base ? base + '/' : '';
  const pluginName = safeSlug(opts.pluginName || staged.pluginName);

  const rel = walk(staged.stageDir);
  const files = [];
  const warnings = [];
  let redactions = [];

  if (layout === 'agent') {
    const md = rel.find(r => /^agents\/.*\.agent\.md$/i.test(r));
    if (!md) { rmrf(staged.stageDir); throw new Error('No .agent.md found to export in single-agent layout.'); }
    const content = fs.readFileSync(path.join(staged.stageDir, md), 'utf8');
    files.push({ path: `${prefix}.github/agents/${staged.slug}.agent.md`, content });
    const hasMcp = rel.some(r => /(^|\/)\.mcp\.json$/i.test(r));
    const hasSkills = rel.some(r => /^skills\//i.test(r));
    if (hasMcp) warnings.push('MCP servers are not included in single-agent layout. Use the plugin package layout to carry them.');
    if (hasSkills) warnings.push('Skills are not included in single-agent layout. Use the plugin package layout to carry them.');
  } else {
    for (const r of rel) {
      let content = fs.readFileSync(path.join(staged.stageDir, r), 'utf8');
      if (/(^|\/)\.mcp\.json$/i.test(r)) {
        const red = redactMcpJson(content);
        content = red.json;
        redactions = redactions.concat(red.redactions.map(x => ({ ...x, path: `${prefix}.github/plugin/${pluginName}/${r}` })));
      }
      files.push({ path: `${prefix}.github/plugin/${pluginName}/${r}`, content });
    }
  }

  const secrets = scanSecrets(files);
  rmrf(staged.stageDir);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return {
    files,
    redactions,
    secrets,
    warnings,
    slug: staged.slug,
    pluginName,
    layout,
    kind: staged.kind,
    branchSuggestion: `agent-export/${staged.slug}-${stamp}`
  };
}

module.exports = { buildExport, redactMcpJson, scanSecrets, stageExport };
