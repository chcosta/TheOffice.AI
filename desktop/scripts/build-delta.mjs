// Build a server-file delta zip for the desktop in-app updater.
//
// Compares the freshly-staged server-manifest.json (produced by stage-sidecar.mjs)
// against the PREVIOUS release's server-manifest.json (fetched from GitHub via the
// `gh` CLI) and emits, into the release-assets dir:
//
//   server-delta-<base>__<target>.zip
//   server-delta-<base>__<target>.zip.sha256
//
// The zip contains:
//   __delta__.json            = { base, target, deleted:[rel], files:{rel:sha256}, generatedAt }
//   <changed/added rel paths> = the actual file bytes from the staged server tree
//   server-manifest.json      = the NEW manifest (always included so the applied
//                               install's local manifest advances to <target>)
//
// If there is no previous release, or no differences, no delta is written (the
// updater simply falls back to the full installer for that release).
//
// Usage:
//   node desktop/scripts/build-delta.mjs --out <release-assets-dir> [--repo owner/name]

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));       // desktop/scripts
const repoRoot = join(here, '..', '..');                    // repo root
const serverDest = join(here, '..', 'src-tauri', 'resources', 'server');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUT_DIR = arg('--out', join(here, '..', 'src-tauri', 'target', 'release', 'bundle'));
const REPO = arg('--repo', process.env.THEOFFICE_UPDATE_REPO || 'chcosta/TheOffice.AI');

function log(msg) { console.log(`[build-delta] ${msg}`); }

const { diffManifests } = require(join(repoRoot, 'hash-tree.js'));
const { default: yazl } = await import('yazl');

// 1) Load the freshly-staged (new) manifest.
const newManifestPath = join(serverDest, 'server-manifest.json');
if (!existsSync(newManifestPath)) {
  log('no staged server-manifest.json — run stage-sidecar first; skipping delta.');
  process.exit(0);
}
const nextManifest = JSON.parse(readFileSync(newManifestPath, 'utf-8'));
const target = String(nextManifest.version || '').replace(/^v/i, '');
if (!target) { log('staged manifest has no version; skipping delta.'); process.exit(0); }

// 2) Find the previous release + fetch its server-manifest.json via `gh`.
function ghJson(url) {
  const out = execSync(`gh api ${url}`, { encoding: 'utf-8', cwd: repoRoot });
  return JSON.parse(out);
}

let prevManifest = null;
let base = '';
try {
  const releases = ghJson(`repos/${REPO}/releases?per_page=30`);
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft) continue;
    const ver = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (!ver || ver === target) continue;
    const asset = (rel.assets || []).find(a => a.name === 'server-manifest.json');
    if (!asset) continue;
    // Newest release (list is date-desc) with a manifest is our base.
    try {
      const txt = execSync(
        `gh api -H "Accept: application/octet-stream" repos/${REPO}/releases/assets/${asset.id}`,
        { encoding: 'utf-8', cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }
      );
      prevManifest = JSON.parse(txt);
      base = ver;
      break;
    } catch (e) {
      log(`could not fetch manifest for ${ver}: ${e.message}`);
    }
  }
} catch (e) {
  log(`could not list releases (${e.message}); skipping delta.`);
  process.exit(0);
}

if (!prevManifest || !base) {
  log('no previous release manifest found; skipping delta (installer fallback).');
  process.exit(0);
}

// 3) Diff.
const { changed, added, deleted } = diffManifests(prevManifest, nextManifest);
const changedAdded = [...changed, ...added].sort();
log(`base=${base} target=${target}: ${changed.length} changed, ${added.length} added, ${deleted.length} deleted`);

if (changedAdded.length === 0 && deleted.length === 0) {
  log('no file differences; skipping delta.');
  process.exit(0);
}

// 4) Build the delta zip.
mkdirSync(OUT_DIR, { recursive: true });
const zipName = `server-delta-${base}__${target}.zip`;
const zipPath = join(OUT_DIR, zipName);

// files map for the marker/verify step (rel -> sha256), always including the
// new manifest so the local install's manifest advances to <target>.
const deltaFiles = {};
for (const rel of changedAdded) {
  const info = nextManifest.files[rel];
  if (info) deltaFiles[rel] = info.sha256;
}
// server-manifest.json is excluded from the tree hash; add it explicitly.
deltaFiles['server-manifest.json'] = createHash('sha256')
  .update(readFileSync(newManifestPath)).digest('hex');

const meta = {
  base,
  target,
  deleted,
  files: deltaFiles,
  generatedAt: new Date().toISOString(),
};

const zip = new yazl.ZipFile();
zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), '__delta__.json');
for (const rel of changedAdded) {
  const abs = join(serverDest, rel);
  if (existsSync(abs)) zip.addFile(abs, rel);
  else log(`WARNING: staged file missing for ${rel}`);
}
zip.addFile(newManifestPath, 'server-manifest.json');

await new Promise((resolve, reject) => {
  const ws = createWriteStream(zipPath);
  ws.on('error', reject);
  ws.on('close', resolve);
  zip.outputStream.on('error', reject);
  zip.outputStream.pipe(ws);
  zip.end();
});

// 5) sha256 sidecar.
const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  ${zipName}\n`);

log(`wrote ${zipName} (${changedAdded.length} files) + .sha256 -> ${OUT_DIR}`);
