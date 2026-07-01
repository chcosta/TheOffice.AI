// Stage the Node sidecar (server app + production node_modules + a portable Node)
// into desktop/src-tauri/resources/ so `tauri build` bundles them into the installer.
//
// Layout produced:
//   src-tauri/resources/server/       server.js + all runtime *.js + public/ + builtin-plugins/ + node_modules/
//   src-tauri/resources/node/node.exe portable Node used to run the sidecar
//
// main.rs prefers <resources>/server/server.js and <resources>/node/node.exe at runtime.
//
// Default strategy: COPY the repo's already-resolved node_modules (proven-working tree)
// and prune the dev-only puppeteer-core. Pass --clean to instead do a fresh
// `npm install --omit=dev` in the staged dir (canonical prod tree; needs network).

import {
  cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));      // desktop/scripts
const repoRoot = join(here, '..', '..');                   // repo root
const resources = join(here, '..', 'src-tauri', 'resources');
const serverDest = join(resources, 'server');
const nodeDest = join(resources, 'node');
const clean = process.argv.includes('--clean');

// Root dirs that make up the server runtime. Everything else in the repo
// (tests, experiments, docs, daemon, relay, routes, mcp-configs, desktop, .git)
// is NOT needed by the running server.
const RUNTIME_DIRS = ['public', 'builtin-plugins'];
// Dev-only packages to prune from a copied node_modules tree.
const DEV_PRUNE = ['puppeteer-core'];

function log(msg) { console.log(`[stage-sidecar] ${msg}`); }
function dirSizeMB(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += statSync(full).size; } catch { /* ignore */ } }
    }
  }
  return Math.round(total / (1024 * 1024));
}

log(`repo root:   ${repoRoot}`);
log(`server dest: ${serverDest}`);
log(`node dest:   ${nodeDest}`);

// 1) Clean previous staging.
rmSync(serverDest, { recursive: true, force: true });
rmSync(nodeDest, { recursive: true, force: true });
mkdirSync(serverDest, { recursive: true });
mkdirSync(nodeDest, { recursive: true });

// 2) Copy every root-level *.js (all required modules are root siblings) plus manifests.
let jsCount = 0;
for (const name of readdirSync(repoRoot)) {
  const src = join(repoRoot, name);
  let st;
  try { st = statSync(src); } catch { continue; }
  if (!st.isFile()) continue;
  if (name.endsWith('.js') || name === 'package.json' || name === 'package-lock.json') {
    copyFileSync(src, join(serverDest, name));
    if (name.endsWith('.js')) jsCount++;
  }
}
log(`copied ${jsCount} root .js files + manifests`);

// 3) Copy runtime dirs.
for (const d of RUNTIME_DIRS) {
  const src = join(repoRoot, d);
  if (!existsSync(src)) { log(`WARNING: missing runtime dir ${d}`); continue; }
  cpSync(src, join(serverDest, d), { recursive: true });
  log(`copied ${d}/ (${dirSizeMB(join(serverDest, d))} MB)`);
}

// 4) node_modules.
if (clean) {
  log('installing production node_modules (--omit=dev)…');
  execSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: serverDest, stdio: 'inherit',
  });
} else {
  const srcNm = join(repoRoot, 'node_modules');
  if (!existsSync(srcNm)) throw new Error('repo node_modules not found — run `npm install` first, or use --clean');
  log('copying repo node_modules… (large; ~1–2 min)');
  cpSync(srcNm, join(serverDest, 'node_modules'), { recursive: true });
  for (const pkg of DEV_PRUNE) {
    const p = join(serverDest, 'node_modules', pkg);
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); log(`pruned dev package ${pkg}`); }
  }
}
log(`node_modules staged (${dirSizeMB(join(serverDest, 'node_modules'))} MB)`);

// 5) Portable Node — copy the running node binary (single self-contained exe on Windows).
const nodeExe = process.execPath;
copyFileSync(nodeExe, join(nodeDest, process.platform === 'win32' ? 'node.exe' : 'node'));
log(`copied portable node from ${nodeExe}`);

// 6) Bundled scripts (prerequisite installer, invoked by the NSIS post-install hook).
const scriptsDest = join(resources, 'scripts');
rmSync(scriptsDest, { recursive: true, force: true });
mkdirSync(scriptsDest, { recursive: true });
const prereq = join(here, 'install-prerequisites.ps1');
if (existsSync(prereq)) {
  copyFileSync(prereq, join(scriptsDest, 'install-prerequisites.ps1'));
  log('copied install-prerequisites.ps1');
} else {
  log('WARNING: install-prerequisites.ps1 not found');
}

// 7) Bake build-info.json so the packaged server (no git available) can report
//    its version + commit. Version source of truth = desktop/package.json.
try {
  let version = '';
  try { version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).version || ''; } catch {}
  let commit = '', commitMessage = '';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim(); } catch {}
  try { commitMessage = execSync('git log -1 --format=%s', { cwd: repoRoot, encoding: 'utf-8' }).trim(); } catch {}
  const buildInfo = { version, commit, commitMessage, builtAt: new Date().toISOString() };
  writeFileSync(join(serverDest, 'build-info.json'), JSON.stringify(buildInfo, null, 2));
  log(`baked build-info.json (v${version || '?'}+${commit || '?'})`);
} catch (e) {
  log(`WARNING: could not bake build-info.json: ${e.message}`);
}

// Sanity: the entrypoint must exist.
if (!existsSync(join(serverDest, 'server.js'))) throw new Error('staging failed: server.js missing in dest');

log(`DONE. server=${dirSizeMB(serverDest)} MB, node=${dirSizeMB(nodeDest)} MB`);
