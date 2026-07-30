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

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// A marker the updater reads to force a clean FULL reinstall when the installed
// server tree is corrupt/partial (doesn't match its own manifest) and can't be
// repaired locally at boot (no network before modules load).
function healMarkerPath() { return path.join(baseDir(), 'pending-heal.json'); }

function applyPendingDelta(serverDir) {
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
}

// Reconcile the version the app ADVERTISES (build-info.json — read by
// /api/version and used by the updater's "updateAvailable" decision) with the
// server files actually on disk (described by server-manifest.json).
//
// Why this exists: a milestone full-installer can stamp a fresh build-info.json
// into runtime\<ver> without cleanly replacing the bundled server tree, leaving
// the version marker AHEAD of the real payload. The updater then compares
// build-info's (inflated) version against the latest release, concludes it is
// already current, and silently never heals — the app reports a version whose
// code it isn't actually running. This runs at every sidecar boot (before any
// other module loads) and:
//   * if the files faithfully match the manifest but build-info disagrees ->
//     rewrites build-info DOWN to the real version so /api/version is honest and
//     the update path re-engages (the normal delta chain then heals to latest);
//   * if the files don't even match their own manifest (corrupt/partial tree) ->
//     drops a heal marker the updater reads to force a clean FULL reinstall.
// Never throws.
function verifyAndHeal(serverDir) {
  const manifest = readJsonSafe(path.join(serverDir, 'server-manifest.json'));
  if (!manifest || !manifest.files) return; // dev / unpackaged — nothing to verify against
  const mFiles = manifest.files;
  const mVersion = String(manifest.version || '').replace(/^v/i, '');
  if (!mVersion) return;

  const buildInfoPath = path.join(serverDir, 'build-info.json');
  const bi = readJsonSafe(buildInfoPath) || {};
  const biVersion = String(bi.version || '').replace(/^v/i, '');

  const shaMatches = (rel) => {
    const entry = mFiles[rel];
    if (!entry || !entry.sha256) return true; // nothing to compare
    const abs = path.join(serverDir, rel.split('/').join(path.sep));
    try { return fs.existsSync(abs) && sha256(abs) === entry.sha256; } catch { return false; }
  };

  // Cheap tripwire on every boot: verify the two files that change on nearly
  // every release. A few MB hashed — catches a half-applied delta even when the
  // versions happen to agree. node_modules is never touched here.
  const lightMismatch = ['server.js', 'public/app.html'].some((rel) => !shaMatches(rel));
  const versionsDisagree = !!(biVersion && biVersion !== mVersion);

  if (!lightMismatch && !versionsDisagree) {
    // Consistent and intact — clear any stale heal request and we're done.
    try { fs.rmSync(healMarkerPath(), { force: true }); } catch { /* ignore */ }
    return;
  }

  // Something's off. Do a broader (still node_modules-free) integrity pass to
  // decide the direction of the fix.
  let treeMatchesManifest = true;
  for (const rel of Object.keys(mFiles)) {
    if (rel.indexOf('node_modules/') === 0) continue; // skip the huge, stable dep tree
    if (!shaMatches(rel)) { treeMatchesManifest = false; break; }
  }

  if (treeMatchesManifest) {
    // Files faithfully match the manifest, so the manifest is the truth and
    // build-info.json is the liar. Reconcile the advertised version to reality.
    if (versionsDisagree) {
      const healed = Object.assign({}, bi, {
        version: mVersion,
        commit: manifest.commit || bi.commit || '',
        healedAt: new Date().toISOString(),
        healedFrom: biVersion || null,
      });
      try {
        fs.writeFileSync(buildInfoPath, JSON.stringify(healed, null, 2));
        log(`self-heal: reconciled build-info ${biVersion || '?'} -> ${mVersion} (payload matches manifest)`);
      } catch (e) { log(`self-heal: could not rewrite build-info: ${e && e.message}`); }
    } else {
      log('self-heal: light tripwire flagged but broad tree matches manifest (transient)');
    }
    try { fs.rmSync(healMarkerPath(), { force: true }); } catch { /* ignore */ }
    return;
  }

  // The tree does NOT match its own manifest — genuinely corrupt/partial. We
  // can't fetch replacement files here (pre-module boot, no network), so drop a
  // marker the updater reads to force a clean FULL reinstall of the latest good
  // release.
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    fs.writeFileSync(healMarkerPath(), JSON.stringify({
      reason: 'server-tree-integrity-mismatch',
      manifestVersion: mVersion,
      buildInfoVersion: biVersion || null,
      detectedAt: new Date().toISOString(),
    }, null, 2));
    log(`self-heal: server tree does not match manifest (manifest=${mVersion}, build-info=${biVersion || '?'}); requested full reinstall`);
  } catch (e) { log(`self-heal: could not write heal marker: ${e && e.message}`); }
}

module.exports = function applyPendingServerUpdate(serverDir) {
  if (process.env.SUPERVISOR_SIDECAR !== '1') return;
  // 1) Apply any pending in-place delta staged by the updater.
  try { applyPendingDelta(serverDir); } catch (e) { log(`applyPendingDelta failed: ${e && e.message}`); }
  // 2) Reconcile the advertised version with the payload actually on disk, so a
  //    stale-but-mislabelled install (marker ahead of files) can't masquerade as
  //    current and silently block updates.
  try { verifyAndHeal(serverDir); } catch (e) { log(`verifyAndHeal failed: ${e && e.message}`); }
};
