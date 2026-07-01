'use strict';

// In-place sidecar delta applier. Runs at the VERY TOP of server.js, before any
// other module is required, so the files it overwrites on disk are not yet locked
// by this process's module cache (the previous process already exited).
//
// It consumes a marker written by updater.js after a delta was downloaded,
// verified and extracted to a staging directory:
//
//   %LOCALAPPDATA%\TheOffice.AI\pending-server-update.json
//   {
//     version:  "<target version>",
//     staging:  "<abs path to extracted delta files>",
//     deleted:  ["rel/path", ...],
//     files:    { "rel/path": "<sha256>", ... },   // changed/added + server-manifest.json
//     stagedAt: "<iso>"
//   }
//
// Contract: NEVER throws, idempotent, only acts when SUPERVISOR_SIDECAR==='1'.
// On any verification failure it discards the marker + staging (so a corrupt
// delta can't wedge startup) and leaves the installed files untouched — the
// updater will simply fall back to the full installer next time.

const fs = require('fs');
const path = require('path');
const os = require('os');

function baseDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'TheOffice.AI');
}

function log(line) {
  try {
    fs.appendFileSync(
      path.join(baseDir(), 'apply-update.log'),
      `[${new Date().toISOString()}] ${line}\n`
    );
  } catch { /* logging is best-effort */ }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

function sha256(file) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

module.exports = function applyPendingServerUpdate(serverDir) {
  if (process.env.SUPERVISOR_SIDECAR !== '1') return;

  const markerPath = path.join(baseDir(), 'pending-server-update.json');
  let marker;
  try {
    if (!fs.existsSync(markerPath)) return;
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch (e) {
    log(`could not read marker: ${e.message}`);
    try { fs.rmSync(markerPath, { force: true }); } catch { /* ignore */ }
    return;
  }

  const staging = marker && marker.staging;
  const files = (marker && marker.files) || {};
  const deleted = (marker && Array.isArray(marker.deleted)) ? marker.deleted : [];

  const cleanup = () => {
    try { fs.rmSync(markerPath, { force: true }); } catch { /* ignore */ }
    if (staging) rmrf(staging);
  };

  try {
    if (!staging || !fs.existsSync(staging)) {
      log('staging dir missing; discarding marker');
      cleanup();
      return;
    }

    // 1) Verify every staged file matches its expected sha BEFORE touching serverDir.
    for (const rel of Object.keys(files)) {
      const src = path.join(staging, rel);
      if (!fs.existsSync(src)) {
        log(`staged file missing: ${rel}; aborting apply`);
        cleanup();
        return;
      }
      const actual = sha256(src);
      if (actual !== files[rel]) {
        log(`sha mismatch for ${rel} (want ${files[rel]}, got ${actual}); aborting apply`);
        cleanup();
        return;
      }
    }

    // 2) Copy changed/added files over the installed tree.
    let applied = 0;
    for (const rel of Object.keys(files)) {
      const src = path.join(staging, rel);
      const dst = path.join(serverDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      applied++;
    }

    // 3) Remove files deleted in the new release (best-effort, path-guarded).
    let removed = 0;
    for (const rel of deleted) {
      const dst = path.join(serverDir, rel);
      // Guard against path traversal escaping serverDir.
      const resolved = path.resolve(dst);
      if (!resolved.startsWith(path.resolve(serverDir) + path.sep)) continue;
      try {
        if (fs.existsSync(dst)) { fs.rmSync(dst, { force: true }); removed++; }
      } catch { /* ignore individual delete failures */ }
    }

    log(`applied server update -> ${marker.version} (${applied} files, ${removed} deleted)`);
  } catch (e) {
    log(`apply failed: ${e && e.message}`);
  } finally {
    cleanup();
  }
};
