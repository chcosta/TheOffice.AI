'use strict';

// Central resolver for all runtime config/state files.
//
// Config and state (agents, managers, tasks, chains, boards, chats, the SQLite
// db, etc.) are PER-USER runtime data — not repo source. They live under the
// user profile so the public repo never contains personal data, internal emails
// or environment-specific configuration. Overridable via SUPERVISOR_DATA_DIR.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || require('os').homedir(), '.copilot', 'agent-supervisor');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }

// Resolve a runtime data file/dir to its on-disk location under the profile dir.
function dataPath(name) {
  return path.join(DATA_DIR, name);
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

module.exports = { DATA_DIR, dataPath };
