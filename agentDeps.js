'use strict';

// agentDeps.js
// ---------------------------------------------------------------------------
// Agent tool & MCP-server dependency health check for TheOffice.AI.
//
// Our SYSTEM agents (standup agents, the Board assistant, the Connect
// assistant, ops/markbot helpers, …) rely on EXTERNAL tools and MCP servers to
// do real work — e.g. the ScriptedAI Azure DevOps dotnet global tool, or the
// M365 WorkIQ MCP server. Those are operational REQUIREMENTS: if they aren't
// installed the agent silently loses capability.
//
// This module is a distinct, parallel concept to dependencies.js:
//   * dependencies.js manages the app's own RUNTIME FLOOR (Copilot CLI/SDK,
//     node, git, az, ripgrep).
//   * agentDeps.js reports on the AGENT-LEVEL external tools/MCP servers our
//     system agents need, tells you what's missing, why, and how to fix it,
//     and can install the ones we know how to install (dotnet global tools).
//
// Design invariants:
//   * Extensible: a curated REQUIREMENTS registry describes the known system
//     dependencies + how to install them, and we ALSO auto-discover any other
//     MCP command referenced by an installed system plugin (via
//     capabilities.buildCatalog) so nothing new is ever silently missed.
//   * Self-describing where possible: dotnet global tools resolve their
//     packageId + version straight out of `dotnet tool list --global`, so
//     detection needs no per-tool hardcoding.
//   * Defensive: nothing here ever throws to the caller; failures are captured
//     as status/error.
// ---------------------------------------------------------------------------

const { execFile, execFileSync } = require('child_process');

let capabilities = null;
try { capabilities = require('./capabilities'); } catch { /* optional */ }

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Curated requirements — the external tools/MCP servers our system agents need.
// Each entry knows how to be detected and (where possible) installed.
//   kind:
//     'dotnet-tool' — a dotnet global tool; command IS the PATH shim. Detected
//                     + versioned via `dotnet tool list --global`; installable.
//     'npm-npx'     — launched via npx; the launcher (node/npx) is the floor and
//                     npx fetches the package on demand, so "available" == npx
//                     present. Not separately installable.
//     'runtime'     — a prerequisite runtime (dotnet). Detected via PATH/--version;
//                     guidance only (not auto-installed).
// ---------------------------------------------------------------------------

const REGISTRY = [
  {
    id: 'dotnet',
    name: '.NET SDK',
    kind: 'runtime',
    command: 'dotnet',
    detail: 'Prerequisite runtime for the ScriptedAI dotnet global tools below.',
    installHint: 'Install the .NET 8 SDK, then reopen the app. winget: winget install Microsoft.DotNet.SDK.8',
    docs: 'https://dotnet.microsoft.com/download',
  },
  {
    id: 'scriptedai-azdo',
    name: 'ScriptedAI · Azure DevOps MCP',
    kind: 'dotnet-tool',
    command: 'scriptedai-mcp-azdo',
    packageId: 'scriptedai.mcp.azuredevops',
    requires: ['dotnet'],
    detail: 'Work-item, sprint and repo tools used by the standup agents and ops assistants.',
    docs: 'https://dev.azure.com/dnceng',
  },
  {
    id: 'scriptedai-devtools',
    name: 'ScriptedAI · DevTools MCP',
    kind: 'dotnet-tool',
    command: 'scriptedai-mcp-devtools',
    packageId: 'scriptedai.mcp.devtools',
    requires: ['dotnet'],
    detail: 'Work-item linking and developer-workflow tools used by the standup agents.',
    docs: 'https://dev.azure.com/dnceng',
  },
  {
    id: 'scriptedai-comms',
    name: 'ScriptedAI · Communication MCP',
    kind: 'dotnet-tool',
    command: 'scriptedai-mcp-comms',
    packageId: 'scriptedai.mcp.communication',
    requires: ['dotnet'],
    detail: 'Email + Teams notification tools used by ops/notifier assistants.',
    docs: 'https://dev.azure.com/dnceng',
  },
  {
    id: 'workiq',
    name: 'Microsoft WorkIQ MCP',
    kind: 'npm-npx',
    command: 'npx',
    pkg: '@microsoft/workiq',
    requires: ['node'],
    detail: 'M365 work-context tools (email, meetings, files) used by the Connect assistant.',
    docs: 'https://github.com/microsoft/work-iq',
  },
];

// ---------------------------------------------------------------------------
// Shell helpers — defensive, never throw.
// ---------------------------------------------------------------------------

function _runSync(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: opts.timeout || 20000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell || false, ...opts,
    });
    return { ok: true, out: (out || '').toString() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString(), err: (e.stderr || e.message || '').toString() };
  }
}

function _runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8', timeout: opts.timeout || 300000, windowsHide: true,
      maxBuffer: 1024 * 1024 * 16, shell: opts.shell || false, ...opts,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: (stdout || '').toString(), err: (stderr || err.message || '').toString() });
      else resolve({ ok: true, out: (stdout || '').toString() });
    });
  });
}

function _which(cmd) {
  if (!cmd) return null;
  const r = _runSync(IS_WIN ? 'where.exe' : 'which', [cmd], { timeout: 8000 });
  if (!r.ok) return null;
  const first = (r.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first || null;
}

function _semver(text) {
  const m = String(text || '').match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// dotnet global-tool table — the source of truth for dotnet-tool detection.
// Parses `dotnet tool list --global` into command -> { packageId, version }.
// ---------------------------------------------------------------------------

function _dotnetPresent() {
  return !!_which('dotnet');
}

function _dotnetToolMap() {
  const map = new Map();          // command -> { packageId, version }
  const byPkg = new Map();        // packageId -> { version, commands:[] }
  if (!_dotnetPresent()) return { map, byPkg, ran: false };
  const r = _runSync('dotnet', ['tool', 'list', '--global'], { timeout: 30000 });
  if (!r.ok) return { map, byPkg, ran: false };
  const lines = (r.out || '').split(/\r?\n/);
  for (const line of lines) {
    // Skip header + separator; data rows are 3 columns split on 2+ spaces.
    if (/^Package\s+Id/i.test(line) || /^-{3,}/.test(line) || !line.trim()) continue;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3) continue;
    const packageId = cols[0].trim().toLowerCase();
    const version = cols[1].trim();
    const commands = cols[2].trim();
    byPkg.set(packageId, { version, commands: commands.split(/[,\s]+/).filter(Boolean) });
    for (const c of commands.split(/[,\s]+/)) {
      if (c) map.set(c.trim(), { packageId, version });
    }
  }
  return { map, byPkg, ran: true };
}

// ---------------------------------------------------------------------------
// Discovery — which installed system plugins reference which MCP command.
// Returns command -> Set(sourceLabels), plus a list of extra (non-registry)
// MCP commands so newly added tools are surfaced automatically.
// ---------------------------------------------------------------------------

function _catalogUsage() {
  const usage = new Map();   // command -> Set(labels)
  const byName = new Map();  // mcp server name -> { command, args, source }
  try {
    const cat = capabilities && capabilities.buildCatalog ? capabilities.buildCatalog() : { mcp: [] };
    for (const m of (cat.mcp || [])) {
      byName.set(m.name, m);
      const cmd = String(m.command || '');
      // Resolve the "real" dependency command for wrapper launchers.
      const key = _depCommand(cmd, m.args || []);
      if (!key) continue;
      if (!usage.has(key)) usage.set(key, new Set());
      if (m.source) usage.get(key).add(m.source);
    }
  } catch { /* best effort */ }
  return { usage, byName };
}

// For a launcher command + args, return the identity we probe/report on:
// npx/npm -> 'npx' (launcher is the floor), node/absolute node -> null (internal),
// dotnet <tool> -> the tool name if bare, else the bare command itself.
function _depCommand(command, args) {
  const base = String(command || '').replace(/\.(exe|cmd|bat)$/i, '');
  const leaf = base.split(/[\\/]/).pop().toLowerCase();
  if (leaf === 'node') return null;                 // our own board-mcp etc. — always present
  if (leaf === 'npx' || leaf === 'npm') return 'npx';
  if (leaf === 'python' || leaf === 'python3' || leaf === 'uv' || leaf === 'uvx') return leaf;
  return command;                                    // bare command (e.g. a dotnet global tool shim)
}

// ---------------------------------------------------------------------------
// Probe one registry/discovered entry -> normalized status object.
// ---------------------------------------------------------------------------

function _probe(entry, ctx) {
  const out = {
    id: entry.id,
    name: entry.name || entry.command,
    command: entry.command,
    kind: entry.kind,
    detail: entry.detail || '',
    docs: entry.docs || '',
    requires: entry.requires || [],
    packageId: entry.packageId || entry.pkg || null,
    source: entry.source || 'required',   // 'required' | 'discovered'
    usedBy: [],
    status: 'unknown',                     // ok | missing | degraded | unknown
    installed: false,
    available: false,
    version: null,
    installable: false,
    installCommand: '',
    installHint: entry.installHint || '',
    error: null,
  };

  // Who references it (from the installed-plugin catalog).
  const key = entry.command;
  if (ctx.usage.has(key)) out.usedBy = Array.from(ctx.usage.get(key));

  if (entry.kind === 'runtime') {
    const path = _which(entry.command);
    if (path) {
      out.available = out.installed = true;
      const v = _runSync(entry.command, ['--version'], { timeout: 12000 });
      out.version = _semver(v.out) || (v.out || '').trim().split(/\r?\n/)[0] || null;
      out.status = 'ok';
    } else {
      out.status = 'missing';
      out.error = `${entry.command} was not found on PATH.`;
    }
    return out;
  }

  if (entry.kind === 'dotnet-tool') {
    if (!ctx.dotnet) {
      out.status = 'degraded';
      out.installable = false;
      out.error = 'Requires the .NET SDK, which is not installed.';
      out.installHint = out.installHint || 'Install the .NET SDK first (see “.NET SDK” above).';
      out.installCommand = `dotnet tool install --global ${entry.packageId}`;
      return out;
    }
    const hit = ctx.toolMap.get(entry.command);
    out.installable = true;
    out.installCommand = `dotnet tool install --global ${entry.packageId}`;
    if (hit) {
      out.installed = out.available = true;
      out.version = hit.version;
      out.status = 'ok';
    } else {
      out.status = 'missing';
      out.error = `The '${entry.command}' dotnet global tool is not installed.`;
      out.installHint = out.installHint ||
        `Installs from your configured NuGet feeds. If the package can't be found, add the ScriptedAI feed to your NuGet sources first.`;
    }
    return out;
  }

  if (entry.kind === 'npm-npx') {
    const npx = _which('npx') || _which('npx.cmd');
    if (npx) {
      out.available = out.installed = true;
      out.status = 'ok';
      out.detail = out.detail + ' Fetched on demand via npx — no separate install needed.';
    } else {
      out.status = 'missing';
      out.error = 'npx (Node.js) was not found on PATH.';
      out.installHint = out.installHint || 'Node.js ships with the app; if this is missing, reinstall/repair the app.';
    }
    return out;
  }

  // Generic / discovered bare command.
  const p = _which(entry.command);
  // A discovered command that resolves as a dotnet global tool -> make it installable.
  const hit = ctx.toolMap.get(entry.command);
  if (hit) {
    out.kind = 'dotnet-tool';
    out.packageId = hit.packageId;
    out.installed = out.available = true;
    out.version = hit.version;
    out.installable = !!ctx.dotnet;
    out.installCommand = `dotnet tool install --global ${hit.packageId}`;
    out.status = 'ok';
    return out;
  }
  if (p) {
    out.available = out.installed = true;
    out.status = 'ok';
  } else {
    out.status = 'missing';
    out.error = `${entry.command} was not found on PATH.`;
    out.installHint = out.installHint || 'Unknown install method — declare this tool in the requirements registry to enable one-click install.';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public: check() — probe everything and return items + summary.
// ---------------------------------------------------------------------------

let _cache = null;

function check() {
  const toolInfo = _dotnetToolMap();
  const dotnet = _dotnetPresent();
  const { usage } = _catalogUsage();
  const ctx = { toolMap: toolInfo.map, dotnet, usage };

  const items = [];
  const seen = new Set();

  // 1) Curated requirements first.
  for (const entry of REGISTRY) {
    const probed = _probe(entry, ctx);
    items.push(probed);
    seen.add(entry.command);
  }

  // 2) Auto-discovered MCP commands referenced by installed system plugins but
  //    not already in the registry (extensibility — new tools show up for free).
  for (const [cmd, labels] of usage.entries()) {
    if (seen.has(cmd)) continue;
    if (cmd === 'npx') continue;              // covered by the WorkIQ/npx floor entry
    seen.add(cmd);
    const probed = _probe({
      id: 'disc-' + cmd.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      name: cmd,
      command: cmd,
      kind: 'bare',
      source: 'discovered',
      detail: 'Referenced by an installed system plugin.',
    }, ctx);
    probed.usedBy = Array.from(labels);
    items.push(probed);
  }

  const summary = {
    total: items.length,
    ok: items.filter(i => i.status === 'ok').length,
    missing: items.filter(i => i.status === 'missing').length,
    degraded: items.filter(i => i.status === 'degraded').length,
    unknown: items.filter(i => i.status === 'unknown').length,
    dotnet,
  };
  // "needsAttention" = required (non-discovered) things that aren't ok.
  summary.needsAttention = items.filter(i => i.source === 'required' && i.status !== 'ok').length;
  summary.lastChecked = new Date().toISOString();

  _cache = { items, summary };
  return _cache;
}

function list() {
  return _cache || check();
}

// ---------------------------------------------------------------------------
// Public: install(id) — install a known dotnet global tool.
// ---------------------------------------------------------------------------

async function install(id) {
  const cur = list();
  const item = (cur.items || []).find(i => i.id === id);
  if (!item) return { ok: false, error: `Unknown dependency '${id}'.` };
  if (!item.installable || !item.packageId) {
    return { ok: false, error: `'${item.name}' cannot be installed automatically.`, installHint: item.installHint };
  }
  if (!_dotnetPresent()) {
    return { ok: false, error: 'The .NET SDK is required to install this tool and was not found.' };
  }
  // install, or update if it turns out to already be present.
  let r = await _runAsync('dotnet', ['tool', 'install', '--global', item.packageId], { timeout: 300000 });
  if (!r.ok && /already installed/i.test(r.err + r.out)) {
    r = await _runAsync('dotnet', ['tool', 'update', '--global', item.packageId], { timeout: 300000 });
  }
  const fresh = check();                       // re-probe so the caller sees new state
  const now = (fresh.items || []).find(i => i.id === id);
  if (r.ok || (now && now.status === 'ok')) {
    return { ok: true, output: (r.out || r.err || '').trim(), item: now };
  }
  return { ok: false, error: (r.err || r.out || 'Install failed.').trim(), item: now };
}

module.exports = { check, list, install, REGISTRY };
