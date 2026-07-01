// Stamp a single version string across every manifest that carries the app
// version, so the git tag, the baked build-info.json, the Tauri installer, and
// the /api/version endpoint all agree.
//
// Usage:  node desktop/scripts/set-version.mjs 1.0.3-preview.7
//
// Touches: package.json (root), desktop/package.json, tauri.conf.json,
//          Cargo.toml, and the theoffice-desktop entry in Cargo.lock.
// Intentionally does NOT touch package-lock.json — npm ci ignores the root
// package's own version field, and rewriting the lock risks clobbering an
// unrelated dependency that happens to share the old version number.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktop = join(here, '..');                     // desktop
const repoRoot = join(desktop, '..');                 // repo root
const srcTauri = join(desktop, 'src-tauri');

const version = String(process.argv[2] || '').trim();
if (!version) {
  console.error('usage: node desktop/scripts/set-version.mjs <version>');
  process.exit(1);
}
// major.minor.patch with optional -prerelease and +build metadata.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid semantic version: "${version}"`);
  process.exit(1);
}

function log(m) { console.log(`[set-version] ${m}`); }

function setJsonVersion(file) {
  if (!existsSync(file)) { log(`skip (missing): ${file}`); return; }
  const json = JSON.parse(readFileSync(file, 'utf-8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  log(`${file} -> ${version}`);
}

setJsonVersion(join(repoRoot, 'package.json'));
setJsonVersion(join(desktop, 'package.json'));
setJsonVersion(join(srcTauri, 'tauri.conf.json'));

// Cargo.toml: the first `version = "..."` (the [package] version).
const cargoToml = join(srcTauri, 'Cargo.toml');
if (existsSync(cargoToml)) {
  const txt = readFileSync(cargoToml, 'utf-8').replace(
    /^version = "[^"]*"/m,
    `version = "${version}"`,
  );
  writeFileSync(cargoToml, txt);
  log(`${cargoToml} -> ${version}`);
}

// Cargo.lock: only the theoffice-desktop package entry.
const cargoLock = join(srcTauri, 'Cargo.lock');
if (existsSync(cargoLock)) {
  const txt = readFileSync(cargoLock, 'utf-8').replace(
    /(name = "theoffice-desktop"\nversion = ")[^"]*(")/,
    `$1${version}$2`,
  );
  writeFileSync(cargoLock, txt);
  log(`${cargoLock} -> ${version}`);
}

log('done.');
