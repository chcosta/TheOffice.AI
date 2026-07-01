'use strict';

// dependencies.js
// ---------------------------------------------------------------------------
// Managed dependency layer for TheOffice.AI.
//
// The app ships a BUNDLED copy of each critical dependency (portable Node, the
// Copilot CLI + SDK vendored under node_modules, git/az/ripgrep as machine
// prereqs). That bundled copy is the guaranteed FLOOR — the app always runs.
//
// On top of the floor this module manages an APP-OWNED, per-user updatable copy
// of the npm-delivered dependencies (Copilot CLI + SDK) in the profile data dir.
// A scheduled task (wired in server.js) can refresh that copy; the resolver
// prefers it. Everything is per-user (no admin), install is staged + validated
// + atomically promoted, and the previous version is kept for one-click
// rollback.
//
// Design invariants:
//   * Never install in place. Stage into versions/<ver>, validate, then flip an
//     atomic active-version pointer.
//   * Validate before promote (copilot --version for the CLI; require() for the
//     SDK) — a bad download can never become active.
//   * Keep N-1 for rollback.
//   * Node is PINNED — reported, never auto-updated (coupled to the server
//     process + native addons).
//   * git / az / ripgrep are machine prereqs — reported + upgradable via winget
//     --scope user, but the app keeps working off the machine copy.
//   * Nothing here ever throws to the caller; failures are captured as status.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { DATA_DIR } = require('./data-paths');

const MANAGED_ROOT = path.join(DATA_DIR, 'dependencies');
const STATE_PATH = path.join(MANAGED_ROOT, 'dependencies.json');
const STATE_VERSION = 1;

try { fs.mkdirSync(MANAGED_ROOT, { recursive: true }); } catch { /* best effort */ }

// ---------------------------------------------------------------------------
// Registry — the set of dependencies we know how to report on / manage.
// ---------------------------------------------------------------------------

const REGISTRY = [
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    kind: 'managed-npm',
    pkg: '@github/copilot',
    manageable: true,      // app can install/update an owned copy
    autoUpdatable: true,
    detail: 'The Copilot CLI drives interactive TUI sessions and “where copilot” discovery.',
  },
  {
    id: 'copilot-sdk',
    name: 'GitHub Copilot SDK',
    kind: 'managed-npm',
    pkg: '@github/copilot-sdk',
    manageable: true,
    autoUpdatable: true,
    detail: 'The SDK is the runtime that executes every agent, manager and chain.',
  },
  {
    id: 'node',
    name: 'Node.js runtime',
    kind: 'portable-node',
    manageable: false,     // pinned — coupled to the running server + addons
    autoUpdatable: false,
    detail: 'Pinned. The server process and any native addons are built against this version.',
  },
  {
    id: 'git',
    name: 'Git',
    kind: 'winget',
    wingetId: 'Git.Git',
    bin: 'git',
    manageable: true,
    autoUpdatable: true,
    detail: 'Used to clone repos and manage dev-card worktrees.',
  },
  {
    id: 'az',
    name: 'Azure CLI',
    kind: 'winget',
    wingetId: 'Microsoft.AzureCLI',
    bin: 'az',
    manageable: true,
    autoUpdatable: true,
    detail: 'Provides secretless Azure DevOps identity for Code Flow and dev cards.',
  },
  {
    id: 'ripgrep',
    name: 'ripgrep',
    kind: 'winget',
    wingetId: 'BurntSushi.ripgrep.MSVC',
    bin: 'rg',
    manageable: true,
    autoUpdatable: true,
    detail: 'Fast code search used by Copilot agents.',
  },
];

function registryFor(id) {
  return REGISTRY.find(r => r.id === id) || null;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function _blankState() {
  return { version: STATE_VERSION, deps: {} };
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return _blankState();
    if (!obj.deps || typeof obj.deps !== 'object') obj.deps = {};
    obj.version = STATE_VERSION;
    return obj;
  } catch {
    return _blankState();
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(MANAGED_ROOT, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[dependencies] could not write state:', e.message);
  }
}

function depState(state, id) {
  if (!state.deps[id]) {
    state.deps[id] = {
      channel: 'stable',
      autoUpdate: null,      // null = inherit global setting
      activeVersion: null,
      activePath: null,
      previousVersion: null,
      previousPath: null,
      currentVersion: null,
      latestKnown: null,
      lastChecked: null,
      lastUpdated: null,
      status: 'idle',        // idle | checking | updating | ok | error
      lastError: null,
      history: [],
    };
  }
  return state.deps[id];
}

// ---------------------------------------------------------------------------
// Shell helpers — all defensive, never throw.
// ---------------------------------------------------------------------------

function _runSync(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell || false,
      ...opts,
    });
    return { ok: true, out: (out || '').toString() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString(), err: (e.stderr || e.message || '').toString() };
  }
}

function _runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 180000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16,
      shell: opts.shell || false,
      ...opts,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: (stdout || '').toString(), err: (stderr || err.message || '').toString() });
      else resolve({ ok: true, out: (stdout || '').toString() });
    });
  });
}

const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------------------
// Current-version detection (what is actually installed / running).
// ---------------------------------------------------------------------------

function _semverFrom(text) {
  const m = String(text || '').match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/);
  return m ? m[0] : null;
}

function _detectCurrent(reg, dstate) {
  try {
    switch (reg.id) {
      case 'node':
        return process.version.replace(/^v/, '');
      case 'copilot': {
        // Prefer the managed active copy, else the bundled/PATH CLI.
        const bin = (dstate && dstate.activePath) || process.env.COPILOT_PATH;
        if (bin && fs.existsSync(bin)) {
          const r = _runSync(bin, ['--version'], { timeout: 10000 });
          if (r.ok) return _semverFrom(r.out);
        }
        // Fall back to the vendored package.json version.
        return _bundledPkgVersion(reg.pkg);
      }
      case 'copilot-sdk':
        return _bundledPkgVersion(reg.pkg);
      case 'git': {
        const r = _runSync('git', ['--version'], { timeout: 8000 });
        return r.ok ? _semverFrom(r.out) : null;
      }
      case 'az': {
        const r = _runSync(process.platform === 'win32' ? 'az.cmd' : 'az', ['version', '--output', 'json'], { timeout: 20000, shell: process.platform === 'win32' });
        if (r.ok) { try { return JSON.parse(r.out)['azure-cli'] || null; } catch { return _semverFrom(r.out); } }
        return null;
      }
      case 'ripgrep': {
        const r = _runSync('rg', ['--version'], { timeout: 8000 });
        return r.ok ? _semverFrom(r.out) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function _bundledPkgVersion(pkg) {
  try {
    const pj = path.join(__dirname, 'node_modules', pkg, 'package.json');
    return JSON.parse(fs.readFileSync(pj, 'utf8')).version || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Latest-version checks (network).
// ---------------------------------------------------------------------------

function _distTag(channel) {
  if (channel === 'latest') return 'prerelease';   // most bleeding edge tag we expose
  if (channel === 'pinned') return null;
  return 'latest';                                  // 'stable' -> npm 'latest'
}

async function _checkNpmLatest(reg, channel) {
  const tag = _distTag(channel) || 'latest';
  const r = await _runAsync(NPM_CMD, ['view', reg.pkg, 'dist-tags', '--json'], { timeout: 30000, shell: process.platform === 'win32' });
  if (!r.ok) return { error: (r.err || 'npm view failed').trim().split('\n')[0] };
  try {
    const tags = JSON.parse(r.out);
    return { version: tags[tag] || tags.latest || null, tags };
  } catch {
    return { error: 'could not parse npm dist-tags' };
  }
}

async function _checkWingetLatest(reg) {
  // `winget list --id <id>` shows the Available column when an upgrade exists.
  const r = await _runAsync('winget', ['list', '--id', reg.wingetId, '--exact', '--accept-source-agreements'], { timeout: 45000 });
  const text = (r.out || '') + (r.err || '');
  // Parse the data row (Name Id Version Available Source). We only need Available.
  const lines = text.split(/\r?\n/).filter(l => l.includes(reg.wingetId));
  if (!lines.length) return { error: 'winget: package not found', installed: null };
  const parts = lines[0].trim().split(/\s{2,}/);
  // Heuristic: find semver-looking tokens; last-but-source is Available if present.
  const semvers = parts.filter(p => /\d+\.\d+/.test(p));
  const installed = semvers[0] || null;
  const available = semvers.length > 1 ? semvers[semvers.length - 1] : null;
  return { version: available || installed, installed, available };
}

async function checkLatest(id, channel) {
  const reg = registryFor(id);
  if (!reg) return { error: 'unknown dependency' };
  if (reg.kind === 'managed-npm') return _checkNpmLatest(reg, channel || 'stable');
  if (reg.kind === 'winget') return _checkWingetLatest(reg);
  if (reg.kind === 'portable-node') return { version: process.version.replace(/^v/, ''), pinned: true };
  return { error: 'unsupported kind' };
}

// ---------------------------------------------------------------------------
// Managed npm install (staged → validate → atomic promote → keep N-1).
// ---------------------------------------------------------------------------

function _npmDir(id) {
  return path.join(MANAGED_ROOT, id);
}
function _versionsDir(id) {
  return path.join(_npmDir(id), 'versions');
}
function _pointerPath(id) {
  return path.join(_npmDir(id), 'active.json');
}

function readPointer(id) {
  try {
    return JSON.parse(fs.readFileSync(_pointerPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function _writePointerAtomic(id, pointer) {
  const target = _pointerPath(id);
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2));
  fs.renameSync(tmp, target);  // atomic on the same volume
}

// Resolve the copilot CLI executable inside an installed version dir.
function _resolveCliBin(versionDir, pkg) {
  const candidates = [
    // platform binary vendored by @github/copilot
    path.join(versionDir, 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe'),
    path.join(versionDir, 'node_modules', '.bin', process.platform === 'win32' ? 'copilot.cmd' : 'copilot'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Install @github/<pkg>@<version> into a private versioned prefix.
async function _installNpmVersion(reg, version) {
  const vdir = path.join(_versionsDir(reg.id), version);
  try { fs.rmSync(vdir, { recursive: true, force: true }); } catch { /* fresh */ }
  fs.mkdirSync(vdir, { recursive: true });
  // A private package.json so npm treats vdir as an isolated project root.
  fs.writeFileSync(path.join(vdir, 'package.json'), JSON.stringify({
    name: `managed-${reg.id}`, version: '1.0.0', private: true,
  }, null, 2));
  const spec = `${reg.pkg}@${version}`;
  const r = await _runAsync(NPM_CMD, ['install', spec, '--no-audit', '--no-fund', '--prefix', vdir], {
    timeout: 600000, shell: process.platform === 'win32', cwd: vdir,
  });
  if (!r.ok) return { ok: false, dir: vdir, err: (r.err || 'npm install failed').trim().split('\n').slice(-3).join(' ') };
  return { ok: true, dir: vdir };
}

// Validate an installed version before promoting it.
function _validateNpmVersion(reg, versionDir) {
  if (reg.id === 'copilot') {
    const bin = _resolveCliBin(versionDir, reg.pkg);
    if (!bin) return { ok: false, err: 'copilot binary not found after install' };
    const r = _runSync(bin, ['--version'], { timeout: 15000 });
    if (!r.ok || !_semverFrom(r.out)) return { ok: false, err: 'copilot --version smoke test failed' };
    return { ok: true, bin, version: _semverFrom(r.out) };
  }
  if (reg.id === 'copilot-sdk') {
    const entry = path.join(versionDir, 'node_modules', reg.pkg);
    const pj = path.join(entry, 'package.json');
    if (!fs.existsSync(pj)) return { ok: false, err: 'sdk package.json missing after install' };
    // Structural smoke test: it must be require-resolvable.
    try {
      require.resolve(entry);
    } catch (e) {
      return { ok: false, err: 'sdk not require-resolvable: ' + e.message };
    }
    let version = null;
    try { version = JSON.parse(fs.readFileSync(pj, 'utf8')).version; } catch { /* */ }
    return { ok: true, bin: entry, version };
  }
  return { ok: false, err: 'no validator for ' + reg.id };
}

// Prune installed versions down to the active + previous (keep N-1).
function _pruneVersions(id, keep) {
  try {
    const dir = _versionsDir(id);
    if (!fs.existsSync(dir)) return;
    const keepSet = new Set((keep || []).filter(Boolean));
    for (const name of fs.readdirSync(dir)) {
      if (keepSet.has(name)) continue;
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* */ }
    }
  } catch { /* */ }
}

// Public: install/update a managed-npm dependency to a target version.
async function updateManagedNpm(id, opts = {}) {
  const reg = registryFor(id);
  if (!reg || reg.kind !== 'managed-npm') return { ok: false, error: 'not a managed npm dependency' };

  const state = readState();
  const dstate = depState(state, id);
  const channel = opts.channel || dstate.channel || 'stable';

  dstate.status = 'updating';
  dstate.lastError = null;
  writeState(state);

  // Resolve target version.
  let version = opts.version;
  if (!version) {
    const latest = await _checkNpmLatest(reg, channel);
    if (latest.error) { dstate.status = 'error'; dstate.lastError = latest.error; writeState(state); return { ok: false, error: latest.error }; }
    version = latest.version;
    dstate.latestKnown = version;
    dstate.lastChecked = new Date().toISOString();
  }
  if (!version) { dstate.status = 'error'; dstate.lastError = 'no target version'; writeState(state); return { ok: false, error: 'no target version' }; }

  if (dstate.activeVersion === version) {
    dstate.status = 'ok';
    writeState(state);
    return { ok: true, unchanged: true, version };
  }

  // Stage install.
  const inst = await _installNpmVersion(reg, version);
  if (!inst.ok) { dstate.status = 'error'; dstate.lastError = inst.err; writeState(state); return { ok: false, error: inst.err }; }

  // Validate before promote.
  const val = _validateNpmVersion(reg, inst.dir);
  if (!val.ok) {
    try { fs.rmSync(inst.dir, { recursive: true, force: true }); } catch { /* */ }
    dstate.status = 'error'; dstate.lastError = val.err; writeState(state);
    return { ok: false, error: val.err };
  }

  // Atomic promote: keep the old active as previous (N-1), flip the pointer.
  const prevVersion = dstate.activeVersion;
  const prevPath = dstate.activePath;
  const pointer = { id, version, dir: inst.dir, bin: val.bin, promotedAt: new Date().toISOString() };
  try {
    _writePointerAtomic(id, pointer);
  } catch (e) {
    dstate.status = 'error'; dstate.lastError = 'pointer write failed: ' + e.message; writeState(state);
    return { ok: false, error: dstate.lastError };
  }

  dstate.previousVersion = prevVersion || null;
  dstate.previousPath = prevPath || null;
  dstate.activeVersion = version;
  dstate.activePath = val.bin;
  dstate.currentVersion = val.version || version;
  dstate.status = 'ok';
  dstate.lastUpdated = new Date().toISOString();
  dstate.history = (dstate.history || []).concat([{ version, at: dstate.lastUpdated, action: 'update' }]).slice(-20);
  writeState(state);

  // Keep only active + previous version dirs.
  _pruneVersions(id, [version, prevVersion].filter(Boolean).map(v => v));

  return { ok: true, version, bin: val.bin, previousVersion: prevVersion || null };
}

// Public: roll back a managed-npm dependency to the retained previous version.
async function rollbackManagedNpm(id) {
  const reg = registryFor(id);
  if (!reg || reg.kind !== 'managed-npm') return { ok: false, error: 'not a managed npm dependency' };
  const state = readState();
  const dstate = depState(state, id);
  if (!dstate.previousVersion) return { ok: false, error: 'no previous version to roll back to' };

  const prevDir = path.join(_versionsDir(id), dstate.previousVersion);
  if (!fs.existsSync(prevDir)) return { ok: false, error: 'previous version files were pruned' };
  const val = _validateNpmVersion(reg, prevDir);
  if (!val.ok) return { ok: false, error: 'previous version failed validation: ' + val.err };

  const pointer = { id, version: dstate.previousVersion, dir: prevDir, bin: val.bin, promotedAt: new Date().toISOString(), rolledBack: true };
  try { _writePointerAtomic(id, pointer); }
  catch (e) { return { ok: false, error: 'pointer write failed: ' + e.message }; }

  const swappedFrom = dstate.activeVersion;
  dstate.previousVersion = swappedFrom || null;
  dstate.previousPath = dstate.activePath || null;
  dstate.activeVersion = pointer.version;
  dstate.activePath = val.bin;
  dstate.currentVersion = val.version || pointer.version;
  dstate.status = 'ok';
  dstate.lastUpdated = new Date().toISOString();
  dstate.history = (dstate.history || []).concat([{ version: pointer.version, at: dstate.lastUpdated, action: 'rollback' }]).slice(-20);
  writeState(state);
  return { ok: true, version: pointer.version, from: swappedFrom || null };
}

// ---------------------------------------------------------------------------
// winget upgrade (machine prereqs, --scope user, no admin).
// ---------------------------------------------------------------------------

async function updateWinget(id) {
  const reg = registryFor(id);
  if (!reg || reg.kind !== 'winget') return { ok: false, error: 'not a winget dependency' };
  const state = readState();
  const dstate = depState(state, id);
  dstate.status = 'updating';
  dstate.lastError = null;
  writeState(state);

  const r = await _runAsync('winget', [
    'upgrade', '--id', reg.wingetId, '--exact', '--scope', 'user',
    '--silent', '--accept-source-agreements', '--accept-package-agreements',
    '--disable-interactivity',
  ], { timeout: 900000 });

  const current = _detectCurrent(reg, dstate);
  dstate.currentVersion = current;
  if (!r.ok) {
    // winget exits non-zero when already up to date in some versions; treat
    // "No available upgrade" / "No applicable update" as success.
    const combined = ((r.out || '') + (r.err || '')).toLowerCase();
    const benign = /no available upgrade|no applicable update|no newer|already installed|up to date/.test(combined);
    if (!benign) {
      dstate.status = 'error';
      dstate.lastError = (r.err || 'winget upgrade failed').trim().split('\n').slice(-2).join(' ');
      writeState(state);
      return { ok: false, error: dstate.lastError };
    }
  }
  dstate.status = 'ok';
  dstate.lastUpdated = new Date().toISOString();
  dstate.history = (dstate.history || []).concat([{ version: current, at: dstate.lastUpdated, action: 'winget-upgrade' }]).slice(-20);
  writeState(state);
  return { ok: true, version: current };
}

// ---------------------------------------------------------------------------
// Public surface used by the server.
// ---------------------------------------------------------------------------

// Resolve the managed active Copilot CLI binary if it validates; else null.
// server.js consults this FIRST when resolving COPILOT_PATH.
function resolveManagedCopilot() {
  const ptr = readPointer('copilot');
  if (ptr && ptr.bin && fs.existsSync(ptr.bin)) return ptr.bin;
  return null;
}

// Build the status list for the UI: registry + persisted state + live detect.
function list() {
  const state = readState();
  return REGISTRY.map(reg => {
    const dstate = depState(state, reg.id);
    const current = _detectCurrent(reg, dstate);
    dstate.currentVersion = current;
    const managed = reg.kind === 'managed-npm' && !!dstate.activeVersion;
    return {
      id: reg.id,
      name: reg.name,
      kind: reg.kind,
      detail: reg.detail,
      manageable: reg.manageable,
      autoUpdatable: reg.autoUpdatable,
      pkg: reg.pkg || null,
      wingetId: reg.wingetId || null,
      channel: dstate.channel || 'stable',
      autoUpdate: dstate.autoUpdate,        // null = inherit global
      currentVersion: current,
      bundledVersion: reg.kind === 'managed-npm' ? _bundledPkgVersion(reg.pkg) : null,
      activeVersion: dstate.activeVersion || null,
      managed,
      previousVersion: dstate.previousVersion || null,
      latestKnown: dstate.latestKnown || null,
      updateAvailable: _updateAvailable(current, dstate.latestKnown),
      lastChecked: dstate.lastChecked || null,
      lastUpdated: dstate.lastUpdated || null,
      status: dstate.status || 'idle',
      lastError: dstate.lastError || null,
      history: dstate.history || [],
    };
  });
}

function _cmpSemver(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split(/[.\-+]/).map(n => parseInt(n, 10));
  const pb = String(b).split(/[.\-+]/).map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return String(a) === String(b) ? 0 : (a < b ? -1 : 1);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function _updateAvailable(current, latest) {
  if (!current || !latest) return false;
  return _cmpSemver(current, latest) < 0;
}

// Refresh latest-known versions for one or all dependencies (network).
async function check(id) {
  const ids = id ? [id] : REGISTRY.filter(r => r.autoUpdatable).map(r => r.id);
  const state = readState();
  const results = {};
  for (const depId of ids) {
    const reg = registryFor(depId);
    if (!reg) { results[depId] = { error: 'unknown' }; continue; }
    const dstate = depState(state, depId);
    const res = await checkLatest(depId, dstate.channel || 'stable');
    if (res && res.version) {
      dstate.latestKnown = res.version;
      dstate.lastChecked = new Date().toISOString();
      dstate.lastError = null;
    } else if (res && res.error) {
      dstate.lastError = res.error;
      dstate.lastChecked = new Date().toISOString();
    }
    results[depId] = res;
  }
  writeState(state);
  return results;
}

// Update one dependency (dispatch by kind).
async function update(id, opts = {}) {
  const reg = registryFor(id);
  if (!reg) return { ok: false, error: 'unknown dependency' };
  if (!reg.manageable) return { ok: false, error: `${reg.name} is pinned and cannot be updated` };
  if (reg.kind === 'managed-npm') return updateManagedNpm(id, opts);
  if (reg.kind === 'winget') return updateWinget(id);
  return { ok: false, error: 'unsupported kind' };
}

async function rollback(id) {
  const reg = registryFor(id);
  if (!reg) return { ok: false, error: 'unknown dependency' };
  if (reg.kind === 'managed-npm') return rollbackManagedNpm(id);
  return { ok: false, error: `${reg.name} does not support rollback` };
}

// Update per-dependency config (channel / autoUpdate override).
function setConfig(id, patch = {}) {
  const reg = registryFor(id);
  if (!reg) return { ok: false, error: 'unknown dependency' };
  const state = readState();
  const dstate = depState(state, id);
  if (typeof patch.channel === 'string' && ['stable', 'latest', 'pinned'].includes(patch.channel)) {
    dstate.channel = patch.channel;
  }
  if (patch.autoUpdate === null || typeof patch.autoUpdate === 'boolean') {
    dstate.autoUpdate = patch.autoUpdate;
  }
  writeState(state);
  return { ok: true };
}

module.exports = {
  MANAGED_ROOT,
  STATE_PATH,
  REGISTRY,
  list,
  check,
  checkLatest,
  update,
  rollback,
  setConfig,
  readState,
  readPointer,
  resolveManagedCopilot,
};
