'use strict';

// Central resolver for all runtime config/state files.
//
// Config and state (agents, managers, tasks, chains, boards, chats, the SQLite
// db, etc.) are PER-USER runtime data — not repo source. They live under the
// user profile so the public repo never contains personal data, internal emails
// or environment-specific configuration. Overridable via SUPERVISOR_DATA_DIR.

const fs = require('fs');
const path = require('path');
const os = require('os');

// The built-in default profile location. This is ALWAYS where the breadcrumb
// (redirect pointer) lives, so a user can point their data elsewhere (OneDrive,
// another drive) and we can still find where it went after an app reinstall.
const DEFAULT_DATA_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || os.homedir(),
  '.copilot', 'agent-supervisor'
);

// A small pointer file at the DEFAULT location redirecting to a user-chosen dir.
const REDIRECT_FILE = path.join(DEFAULT_DATA_DIR, '.data-location.json');

// Make sure the default dir exists so the breadcrumb can always be written/read.
try { fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true }); } catch { /* best effort */ }

function readRedirectTarget() {
  try {
    const obj = JSON.parse(fs.readFileSync(REDIRECT_FILE, 'utf8'));
    const p = obj && typeof obj.path === 'string' ? obj.path.trim() : '';
    return p || null;
  } catch { return null; }
}

const ENV_OVERRIDE = (process.env.SUPERVISOR_DATA_DIR || '').trim() || null;
const REDIRECT_TARGET = ENV_OVERRIDE ? null : readRedirectTarget();

// Resolution priority: env override > redirect pointer > default.
const DATA_DIR = ENV_OVERRIDE || REDIRECT_TARGET || DEFAULT_DATA_DIR;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }

// Resolve a runtime data file/dir to its on-disk location under the profile dir.
function dataPath(name) {
  return path.join(DATA_DIR, name);
}

// --- Configurable data-dir location (breadcrumb / redirect) -----------------

function getLocationInfo() {
  const redirected = !ENV_OVERRIDE && !!REDIRECT_TARGET && path.resolve(DATA_DIR) !== path.resolve(DEFAULT_DATA_DIR);
  return {
    effective: DATA_DIR,
    default: DEFAULT_DATA_DIR,
    target: REDIRECT_TARGET,
    redirected,
    envOverride: !!ENV_OVERRIDE,
  };
}

// Copy every entry from `srcDir` into `destDir` without clobbering existing
// destination entries. Skips the breadcrumb file itself.
function copyDataTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name === '.data-location.json') continue;
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (fs.existsSync(dest)) continue; // never clobber existing target data
    try {
      fs.cpSync(src, dest, { recursive: true });
    } catch (e) {
      console.warn(`[data-paths] Could not copy ${ent.name} to new location:`, e.message);
    }
  }
}

// Point the data dir at `newPath`. Optionally copy existing data over. Writes
// the breadcrumb at the DEFAULT location so it survives an app reinstall.
// Changing the live DATA_DIR is unsafe (open DB, cached paths), so callers must
// require an app restart for this to take effect.
function setLocation(newPath, opts = {}) {
  const target = String(newPath || '').trim();
  if (!target) throw new Error('A destination path is required.');
  if (!path.isAbsolute(target)) throw new Error('The destination path must be absolute.');
  const resolved = path.resolve(target);
  if (resolved === path.resolve(DEFAULT_DATA_DIR)) {
    // Pointing back at the default == clearing the redirect.
    clearLocation();
    return getLocationInfo();
  }
  fs.mkdirSync(resolved, { recursive: true });
  if (opts.move !== false) {
    copyDataTree(DATA_DIR, resolved);
  }
  fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  fs.writeFileSync(REDIRECT_FILE, JSON.stringify({ path: resolved, updatedAt: new Date().toISOString() }, null, 2));
  return { ...getLocationInfo(), target: resolved, redirected: true, restartRequired: true };
}

function clearLocation() {
  try { fs.rmSync(REDIRECT_FILE, { force: true }); } catch { /* best effort */ }
  return { ...getLocationInfo(), target: null, redirected: false, restartRequired: true };
}

// Legacy in-repo config/state that predates the profile-dir store. On first run
// we move each into DATA_DIR (without clobbering an existing profile copy) so the
// app keeps working with the same data while the repo working tree stays clean.
const LEGACY_NAMES = [
  'agents.json', 'managers.json', 'tasks.json', 'teams.json', 'organizations.json',
  'boards.json', 'insights.json', 'chains.json', 'events-config.json', 'settings.json',
  'sync-config.json', 'suggestions.json', 'suggestions-latest.json',
  'supervisor.db', 'supervisor.db-wal', 'supervisor.db-shm',
  'chats', '.config-backup',
];

(function migrateLegacy() {
  const repoDir = __dirname; // data-paths.js lives in the repo root
  if (path.resolve(repoDir) === path.resolve(DATA_DIR)) return;
  for (const name of LEGACY_NAMES) {
    const src = path.join(repoDir, name);
    const dest = path.join(DATA_DIR, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue; // never clobber the profile copy
    try {
      fs.renameSync(src, dest);
      console.log(`[data-paths] Migrated ${name} -> profile data dir`);
    } catch {
      try {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        console.log(`[data-paths] Migrated (copy) ${name} -> profile data dir`);
      } catch (e) {
        console.warn(`[data-paths] Could not migrate ${name}:`, e.message);
      }
    }
  }
})();

module.exports = {
  DATA_DIR, DEFAULT_DATA_DIR, dataPath,
  getLocationInfo, setLocation, clearLocation,
};
