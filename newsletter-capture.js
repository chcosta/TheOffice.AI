'use strict';
// Headless browser capture for the Newsletter feature.
//
// puppeteer-core (already a dependency) drives a *system* Chrome/Edge — it does
// NOT bundle Chromium — so we discover an installed browser executable. On the
// Windows desktop the WebView2 runtime ships Edge, and Edge/Chrome are almost
// always present, so headless screenshots work out of the box with no extra
// download. Callers get back a PNG saved into the newsletter assets directory,
// referenced from the newsletter as `assets/<file>`.
const fs = require('fs');
const path = require('path');
const os = require('os');

let _puppeteer = null;
function puppeteer() {
  if (_puppeteer === null) {
    try { _puppeteer = require('puppeteer-core'); }
    catch (_) { _puppeteer = false; }
  }
  return _puppeteer || null;
}

// Find an installed Chrome/Edge/Chromium executable to drive.
function findBrowser() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (_) { /* ignore */ } }
  return null;
}

function capabilities() {
  const exe = findBrowser();
  return { available: !!(puppeteer() && exe), hasPuppeteer: !!puppeteer(), browser: exe || null };
}

function slugify(s, fallback) {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || fallback || ('shot-' + Date.now());
}

// Capture a screenshot of `url` into `outDir`. Options:
//   name        base filename (sanitized); a .png is written
//   selector    CSS selector to clip to a single element
//   fullPage    capture the entire scrollable page (ignored when selector set)
//   width       viewport width (default 1280)
//   height      viewport height (default 800)
//   waitMs      extra settle time after load (default 600)
//   timeoutMs   navigation timeout (default 30000)
// Returns { ok, file: 'assets/<name>.png', path, bytes } or { ok:false, error }.
async function captureUrl(url, outDir, opts = {}) {
  const pp = puppeteer();
  if (!pp) return { ok: false, error: 'puppeteer-core is not installed' };
  const exe = findBrowser();
  if (!exe) return { ok: false, error: 'No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH.' };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'Only http(s) URLs can be captured' };

  const width = Math.max(320, Math.min(2000, parseInt(opts.width, 10) || 1280));
  const height = Math.max(240, Math.min(4000, parseInt(opts.height, 10) || 800));
  const timeoutMs = Math.max(5000, Math.min(60000, parseInt(opts.timeoutMs, 10) || 30000));
  const waitMs = Math.max(0, Math.min(8000, parseInt(opts.waitMs, 10) || 600));
  const name = slugify(opts.name, 'shot');
  fs.mkdirSync(outDir, { recursive: true });
  const file = name + '.png';
  const dest = path.join(outDir, file);

  let browser;
  try {
    browser = await pp.launch({
      executablePath: exe,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(async () => {
      // networkidle can hang on chatty pages — fall back to domcontentloaded.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    });
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    let buf;
    if (opts.selector) {
      const el = await page.$(String(opts.selector)).catch(() => null);
      if (!el) throw new Error('Selector not found: ' + opts.selector);
      buf = await el.screenshot({ type: 'png' });
    } else {
      buf = await page.screenshot({ type: 'png', fullPage: !!opts.fullPage });
    }
    fs.writeFileSync(dest, buf);
    return { ok: true, file: 'assets/' + file, path: dest, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { findBrowser, capabilities, captureUrl, slugify };
