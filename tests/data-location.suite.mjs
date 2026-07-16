// Data-location contract suite for TheOffice.AI.
//
// Proves the single most important storage invariant: ALL settings, configuration,
// run history and user data resolve UNDER the Settings "data location" (the
// configured/redirected data dir) — with ONE documented exception, the Connect
// diary, which is handled separately via connectStorageDir.
//
// Two layers:
//   * RUNTIME — spawn child `node` processes that resolve data-paths under (a) an
//     explicit SUPERVISOR_DATA_DIR override and (b) a redirect breadcrumb, then
//     assert every representative data target lands inside that dir, that the env
//     var is aligned to the resolved dir (so the modules that read the env
//     directly follow a redirect too), and that the Connect diary is the lone
//     opt-out. Child processes avoid require-cache bleed and exercise the SHIPPED
//     resolution end-to-end.
//   * SOURCE — assert the wiring that makes the runtime behavior true: the env
//     alignment, the env consumers, config-sync deriving from data-paths, the
//     dataPath() consumers, and the diary exception.
//
// SAFETY: data-paths.js runs a one-time legacy migration at require time that
// MOVES any legacy data file found in the repo root into the resolved DATA_DIR.
// A clean repo has none, but to never risk relocating a developer's stray file
// into a throwaway temp dir, the runtime probes SKIP if any legacy name is
// present in the repo root.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('data-location.suite');

const ROOT = process.cwd(); // run-all sets cwd to the repo root; direct runs start there too

// Legacy files data-paths.js would migrate out of the repo root at require time.
const LEGACY_NAMES = [
  'agents.json', 'managers.json', 'tasks.json', 'teams.json', 'organizations.json',
  'boards.json', 'insights.json', 'chains.json', 'events-config.json', 'settings.json',
  'sync-config.json', 'suggestions.json', 'suggestions-latest.json',
  'supervisor.db', 'supervisor.db-wal', 'supervisor.db-shm', 'chats', '.config-backup',
];
const legacyPresent = LEGACY_NAMES.filter((n) => existsSync(path.join(ROOT, n)));

// Representative data targets spanning settings, config, history and user data.
// These are the buckets the audit enumerated; dataPath() is the single resolver
// they all flow through, so asserting these lands the whole surface.
const TARGETS = [
  'supervisor.db',          // history: agent/task run records, boards, insights, code-flow
  'settings.json',          // settings
  'ui-prefs.json',          // per-user UI prefs
  'agents.json', 'managers.json', 'tasks.json', 'chains.json', // config / flows
  'boards.json', 'insights.json',                              // workspaces / insights
  'me-ai',                  // Me.AI agenda + runs/<id> history
  'compose',                // documents
  'newsletter',             // newsletter history
  'connect',                // diary DEFAULT location (under data dir unless redirected)
  'chats', 'chat-uploads',  // chat history + uploads
  'dev-items.json',         // dev cards
  'marketplace-catalog.json', 'marketplace-cache', // marketplace (env-consumer surface)
  'generated-packages', 'agent-overlays', 'generated-agents', 'plugins', // packages/plugins
];

// A CJS probe run in a child process. Resolves data-paths + connect against the
// child's env and prints one `__DL__<json>` line. Never mutates real data (a
// clean repo has no legacy files to migrate; the parent guard enforces that).
const PROBE = `
const path = require('path');
const root = process.env.DL_ROOT;
try {
  const dp = require(path.join(root, 'data-paths.js'));
  const out = { dataDir: dp.DATA_DIR, env: process.env.SUPERVISOR_DATA_DIR || null, paths: {} };
  for (const n of ${JSON.stringify(TARGETS)}) out.paths[n] = dp.dataPath(n);
  const connect = require(path.join(root, 'connect.js'));
  out.connectDefault = connect.storageDir();
  out.connectExplicit = connect.resolveStorageDir(process.env.DL_DIARY || '');
  process.stdout.write('__DL__' + JSON.stringify(out));
} catch (e) {
  process.stdout.write('__DL__' + JSON.stringify({ error: e && e.message || String(e) }));
}
`;

function runProbe(extraEnv) {
  const env = { ...process.env, DL_ROOT: ROOT, ...extraEnv };
  const stdout = execFileSync(process.execPath, ['-e', PROBE], { env, encoding: 'utf8', timeout: 30000 });
  const i = stdout.indexOf('__DL__');
  if (i < 0) throw new Error('probe produced no marker; stdout=' + stdout.slice(0, 400));
  const obj = JSON.parse(stdout.slice(i + 6));
  if (obj.error) throw new Error('probe error: ' + obj.error);
  return obj;
}

// Is `child` inside `parent`? (resolved, tolerant of case on win32)
function under(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// RUNTIME — explicit SUPERVISOR_DATA_DIR override
// ---------------------------------------------------------------------------

await t.test('runtime: every data target resolves under an explicit data-location override', () => {
  if (legacyPresent.length) { t.ok(true, 'skipped (legacy files in repo root: ' + legacyPresent.join(', ') + ')'); return; }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'to-datloc-a-'));
  try {
    const o = runProbe({ SUPERVISOR_DATA_DIR: tmp });
    t.ok(under(o.dataDir, tmp), `DATA_DIR (${o.dataDir}) resolves to the override (${tmp})`);
    // The env is aligned to the resolved dir so modules that read
    // process.env.SUPERVISOR_DATA_DIR directly (capabilities/marketplace/
    // marketplace-design/agentPackage) land in the same place — no split-brain.
    t.ok(under(o.env, tmp), `SUPERVISOR_DATA_DIR env (${o.env}) is aligned to the data dir`);
    for (const n of TARGETS) t.ok(under(o.paths[n], tmp), `${n} is under the data location`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RUNTIME — redirect breadcrumb (the real "changed my data location" scenario)
// ---------------------------------------------------------------------------

await t.test('runtime: a redirect breadcrumb moves the whole data surface (and aligns the env)', () => {
  if (legacyPresent.length) { t.ok(true, 'skipped (legacy files in repo root: ' + legacyPresent.join(', ') + ')'); return; }
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'to-datloc-home-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'to-datloc-b-'));
  try {
    // Drop a redirect pointer at the DEFAULT profile location (fakeHome/.copilot/agent-supervisor).
    const defDir = path.join(fakeHome, '.copilot', 'agent-supervisor');
    mkdirSync(defDir, { recursive: true });
    writeFileSync(path.join(defDir, '.data-location.json'), JSON.stringify({ path: target }));
    // No env override — force resolution through the breadcrumb.
    const env = { USERPROFILE: fakeHome, HOME: fakeHome };
    const clean = { ...process.env, DL_ROOT: ROOT, ...env };
    delete clean.SUPERVISOR_DATA_DIR;
    const stdout = execFileSync(process.execPath, ['-e', PROBE], { env: clean, encoding: 'utf8', timeout: 30000 });
    const o = JSON.parse(stdout.slice(stdout.indexOf('__DL__') + 6));
    t.ok(!o.error, 'probe ran: ' + (o.error || 'ok'));
    t.ok(under(o.dataDir, target), `DATA_DIR (${o.dataDir}) follows the breadcrumb (${target})`);
    t.ok(under(o.env, target), `env aligned to the breadcrumb target (${o.env}) — env consumers follow the redirect`);
    for (const n of TARGETS) t.ok(under(o.paths[n], target), `${n} follows the redirect`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RUNTIME — the Connect diary is the documented exception
// ---------------------------------------------------------------------------

await t.test('runtime: Connect diary defaults into the data location but honors its own folder', () => {
  if (legacyPresent.length) { t.ok(true, 'skipped (legacy files in repo root)'); return; }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'to-datloc-c-'));
  const diary = mkdtempSync(path.join(os.tmpdir(), 'to-diary-'));
  try {
    const o = runProbe({ SUPERVISOR_DATA_DIR: tmp, DL_DIARY: diary });
    // With no connectStorageDir set, the diary lives UNDER the data location…
    t.ok(under(o.connectDefault, tmp), `diary default (${o.connectDefault}) is under the data location`);
    // …but an explicit connectStorageDir routes it to its OWN folder, independent
    // of the data location. This is the "handled separately" contract.
    t.ok(path.resolve(o.connectExplicit) === path.resolve(diary), 'explicit diary folder is honored verbatim');
    t.ok(!under(o.connectExplicit, tmp), 'an explicit diary folder is NOT forced under the data location');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(diary, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SOURCE — the wiring that makes the runtime behavior true
// ---------------------------------------------------------------------------

await t.test('source: data-paths aligns the SUPERVISOR_DATA_DIR env to the resolved dir', () => {
  const src = readFileSync('data-paths.js', 'utf8');
  t.ok(/process\.env\.SUPERVISOR_DATA_DIR = DATA_DIR;/.test(src), 'env is set to the resolved DATA_DIR');
  t.ok(src.indexOf('const DATA_DIR =') < src.indexOf('process.env.SUPERVISOR_DATA_DIR = DATA_DIR;'), 'env is set AFTER DATA_DIR resolves');
  t.ok(src.indexOf('process.env.SUPERVISOR_DATA_DIR = DATA_DIR;') < src.indexOf('function dataPath('), 'env is aligned before dataPath is defined/used');
});

await t.test('source: the direct env consumers read SUPERVISOR_DATA_DIR (so alignment reaches them)', () => {
  for (const f of ['capabilities.js', 'marketplace.js', 'marketplace-design.js', 'agentPackage.js']) {
    const src = readFileSync(f, 'utf8');
    t.ok(/process\.env\.SUPERVISOR_DATA_DIR/.test(src), `${f} resolves its base from SUPERVISOR_DATA_DIR`);
  }
});

await t.test('source: config-sync derives its base from data-paths (not a hardcoded dir)', () => {
  const src = readFileSync('config-sync.js', 'utf8');
  t.ok(/require\('\.\/data-paths'\)/.test(src) && /\bDATA_DIR\b/.test(src), 'config-sync imports DATA_DIR from data-paths');
  t.ok(/const SUPERVISOR_DATA_DIR = DATA_DIR;/.test(src), 'config-sync SUPERVISOR_DATA_DIR is the resolved DATA_DIR');
});

await t.test('source: the dataPath() consumers route settings/config/history/user data through data-paths', () => {
  // server.js owns the db + most history/user-data files; the domain modules own
  // their own stores. All must go through data-paths, never a hardcoded location.
  for (const f of ['server.js', 'compose.js', 'newsletter.js', 'chains.js', 'dev-store.js', 'settings.js', 'connect.js']) {
    const src = readFileSync(f, 'utf8');
    t.ok(/require\('\.\/data-paths'\)/.test(src), `${f} requires data-paths`);
    t.ok(/dataPath\(/.test(src), `${f} resolves storage via dataPath()`);
  }
  // server.js opens the SQLite db (all agent/task run HISTORY) at the resolved path.
  const server = readFileSync('server.js', 'utf8');
  t.ok(/dataPath\('supervisor\.db'\)/.test(server), 'the run-history database opens under the data location');
});

await t.test('source: the Connect diary is the documented, separate exception', () => {
  const src = readFileSync('connect.js', 'utf8');
  // Prefers the user-chosen connectStorageDir, falling back to the data location.
  t.ok(/connectStorageDir/.test(src), 'connect honors the connectStorageDir setting');
  t.ok(/dataPath\('connect'\)/.test(src), 'connect falls back to the data location when no folder is set');
  // The migration that keeps diary data with the folder when it changes.
  t.ok(/function migrateStorageDir\(/.test(src), 'connect migrates diary data when its folder changes');
});

await t.done();
