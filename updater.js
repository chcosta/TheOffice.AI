'use strict';

// Self-hosted in-app updater for the packaged desktop build.
//
// The GitHub Actions "Desktop installer" workflow publishes a preview release
// (`vX.Y.Z-preview.N`) with a `*-setup.exe` NSIS installer + a `.sha256` sidecar
// on every push to main. This module lets the running desktop app:
//   1. check GitHub for a newer release (semver-aware, prerelease-aware),
//   2. download + sha256-verify the installer in the background (timeout-resilient),
//   3. stage a "pending update" marker that the Tauri shell reads on app exit.
//
// The Tauri shell (desktop/src-tauri/src/main.rs) runs the staged installer with
// `/UPDATE /P /R` on exit: `/UPDATE` skips the reinstall prompt and upgrades in
// place (single version, no WebView2 re-download, prereq hook skipped), `/P` is
// passive (progress only), `/R` relaunches the app afterwards. => seamless.
//
// Everything here is a no-op unless running as the desktop sidecar
// (SUPERVISOR_SIDECAR=1), so `npm start` / browser / LAN use is unaffected.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const REPO = process.env.THEOFFICE_UPDATE_REPO || 'chcosta/TheOffice.AI';
const CHECK_CACHE_MS = 15 * 60 * 1000; // don't hammer the unauthenticated GitHub API
const DOWNLOAD_IDLE_MS = 90 * 1000;    // abort a stalled read; we retry
const DOWNLOAD_RETRIES = 3;

// A local (never OneDrive-synced) staging area + a marker the Rust shell reads.
const BASE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TheOffice.AI');
const UPDATE_DIR = path.join(BASE_DIR, 'updates');
const MARKER_PATH = path.join(BASE_DIR, 'pending-update.json');

function isDesktop() {
  return process.env.SUPERVISOR_SIDECAR === '1';
}

// --- semver (prerelease-aware) ---------------------------------------------

// Parse "1.2.3", "v1.2.3", "1.2.3-preview.4" -> { main:[1,2,3], pre:['preview',4] }
function parseSemver(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(s);
  if (!m) return null;
  const main = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] ? m[4].split('.').map(p => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { main, pre };
}

// Standard semver precedence. Returns 1 if a>b, -1 if a<b, 0 if equal.
function compareSemver(av, bv) {
  const a = parseSemver(av);
  const b = parseSemver(bv);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a.main[i] !== b.main[i]) return a.main[i] > b.main[i] ? 1 : -1;
  }
  // A version with no prerelease outranks one with a prerelease.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) return x > y ? 1 : -1;
    if (xn) return -1;         // numeric identifiers rank lower than alphanumeric
    if (yn) return 1;
    return x > y ? 1 : -1;      // ASCII compare
  }
  return 0;
}

// --- release lookup ---------------------------------------------------------

let _checkCache = { at: 0, current: '', result: null };

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'TheOffice.AI-Updater',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  return res.json();
}

// Query GitHub for the newest release with a *-setup.exe asset and compare it
// to the currently-running version.
async function checkForUpdate(currentVersion) {
  const current = String(currentVersion || '').trim();
  const now = Date.now();
  if (_checkCache.result && _checkCache.current === current && now - _checkCache.at < CHECK_CACHE_MS) {
    return _checkCache.result;
  }

  const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
  let best = null; // { version, tag, asset, shaAsset, notes, publishedAt }
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft) continue;
    const tag = rel.tag_name || rel.name || '';
    if (!parseSemver(tag)) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const setup = assets.find(a => /-setup\.exe$/i.test(a.name || ''));
    if (!setup) continue;
    const sha = assets.find(a => a.name === `${setup.name}.sha256`)
      || assets.find(a => /\.sha256$/i.test(a.name || ''));
    const version = String(tag).replace(/^v/i, '');
    if (!best || compareSemver(version, best.version) > 0) {
      best = {
        version,
        tag,
        assetName: setup.name,
        assetUrl: setup.browser_download_url,
        shaUrl: sha ? sha.browser_download_url : null,
        notes: rel.body || '',
        publishedAt: rel.published_at || '',
      };
    }
  }

  const updateAvailable = !!(best && current && parseSemver(current) && compareSemver(best.version, current) > 0);
  const result = {
    supported: true,
    current,
    latest: best ? best.version : '',
    updateAvailable,
    assetName: best ? best.assetName : '',
    notes: best ? best.notes : '',
    publishedAt: best ? best.publishedAt : '',
    _best: best, // internal: consumed by startDownload
  };
  _checkCache = { at: now, current, result };
  return result;
}

// --- download + stage -------------------------------------------------------

let _dl = { phase: 'idle', progress: 0, receivedBytes: 0, totalBytes: 0, version: '', error: '', installer: '' };
let _abort = null;

function status() {
  return {
    phase: _dl.phase,
    progress: _dl.progress,
    receivedBytes: _dl.receivedBytes,
    totalBytes: _dl.totalBytes,
    version: _dl.version,
    error: _dl.error,
    installer: _dl.installer,
  };
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// Download `url` to `dest`, resetting an idle timer on every chunk so a stalled
// socket aborts (and we retry) instead of hanging forever.
async function downloadTo(url, dest, onProgress) {
  const controller = new AbortController();
  _abort = controller;
  let idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_MS); };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'TheOffice.AI-Updater' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`download ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const out = fs.createWriteStream(dest);
    const body = Readable.fromWeb(res.body);
    body.on('data', chunk => {
      received += chunk.length;
      bump();
      if (onProgress) onProgress(received, total);
    });
    await new Promise((resolve, reject) => {
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      body.pipe(out);
    });
    return { received, total };
  } finally {
    clearTimeout(idle);
    _abort = null;
  }
}

async function _run(best) {
  _dl = { phase: 'downloading', progress: 0, receivedBytes: 0, totalBytes: 0, version: best.version, error: '', installer: '' };
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    // Clear any stale installers so we don't accumulate versions on disk.
    try {
      for (const f of fs.readdirSync(UPDATE_DIR)) {
        if (/\.exe$/i.test(f)) fs.rmSync(path.join(UPDATE_DIR, f), { force: true });
      }
    } catch { /* best effort */ }

    const dest = path.join(UPDATE_DIR, best.assetName);

    // Optional expected hash from the published .sha256 sidecar.
    let expected = '';
    if (best.shaUrl) {
      try {
        const res = await fetch(best.shaUrl, { headers: { 'User-Agent': 'TheOffice.AI-Updater' } });
        if (res.ok) expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
      } catch { /* verification is best-effort if the sidecar is unreachable */ }
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        await downloadTo(best.assetUrl, dest, (received, total) => {
          _dl.receivedBytes = received;
          _dl.totalBytes = total;
          _dl.progress = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        try { fs.rmSync(dest, { force: true }); } catch { /* */ }
        if (attempt < DOWNLOAD_RETRIES) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastErr) throw lastErr;

    _dl.phase = 'verifying';
    if (expected) {
      const actual = (await sha256File(dest)).toLowerCase();
      if (actual !== expected) {
        try { fs.rmSync(dest, { force: true }); } catch { /* */ }
        throw new Error('Downloaded installer failed checksum verification.');
      }
    }

    // Stage the marker the Tauri shell consumes on exit.
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(MARKER_PATH, JSON.stringify({
      installer: dest,
      version: best.version,
      args: ['/UPDATE', '/P', '/R'],
      stagedAt: new Date().toISOString(),
    }, null, 2));

    _dl.installer = dest;
    _dl.progress = 100;
    _dl.phase = 'ready';
  } catch (e) {
    _dl.phase = 'error';
    _dl.error = (e && e.message) || String(e);
  }
}

// Begin (or resume) staging the newest update. Idempotent while in progress /
// ready for the same version.
function startDownload(best) {
  if (!best || !best.assetUrl) return { started: false, error: 'No installer asset available.' };
  if ((_dl.phase === 'downloading' || _dl.phase === 'verifying') && _dl.version === best.version) {
    return { started: true, already: true };
  }
  if (_dl.phase === 'ready' && _dl.version === best.version) {
    return { started: true, ready: true };
  }
  _run(best); // fire-and-forget; progress via status()
  return { started: true };
}

function cancel() {
  try { if (_abort) _abort.abort(); } catch { /* */ }
  try { fs.rmSync(MARKER_PATH, { force: true }); } catch { /* */ }
  try {
    if (fs.existsSync(UPDATE_DIR)) {
      for (const f of fs.readdirSync(UPDATE_DIR)) {
        if (/\.exe$/i.test(f)) fs.rmSync(path.join(UPDATE_DIR, f), { force: true });
      }
    }
  } catch { /* */ }
  _dl = { phase: 'idle', progress: 0, receivedBytes: 0, totalBytes: 0, version: '', error: '', installer: '' };
  return { ok: true };
}

module.exports = {
  isDesktop,
  compareSemver,
  checkForUpdate,
  startDownload,
  status,
  cancel,
  MARKER_PATH,
  UPDATE_DIR,
};
