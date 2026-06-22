// Board layout regression test.
//
// Guards against three classes of board-layout bug:
//   1. PERIODIC JUMBLE -- a board left completely idle (no user interaction)
//      re-lays-out itself: panels resize/shift on their own and scrollbars flicker.
//   2. STUCK SCROLLBAR  -- a genuinely-fluid panel (not Fixed / manual-height /
//      size-locked / collapsed) keeps an inner scrollbar after settling, instead of
//      growing to fit its content (the cold-load fit-on-open bug).
//   3. CONTENT SPILL    -- a panel's content escapes the bottom of its frame.
// The board MUST be perfectly still when idle, every fluid panel MUST fit its
// content, and no panel's content may ever spill outside its frame.
//
// How it works: each board is COLD-LOADED directly by id (#/boards/<id>, no click --
// this is the auto-shown / deep-link path where the bugs lived), allowed to settle,
// then snapshotted once per second for several seconds without touching anything.
// Per-panel fluid/Fixed/mh/size-lock/collapsed classification is read from the live
// Alpine component so by-design scrollbars (locked / Fixed panels) are NOT flagged.
//
// Run it any time you change board layout / sizing / observer / fit code:
//   1. start the app:   npm start         (serves on http://localhost:3847)
//   2. run the test:    npm run test:board
//
// Useful env vars:
//   BOARD_TEST_URL      base url of the running app (default http://localhost:3847)
//   BOARD_TEST_SECONDS  idle frames to capture per board   (default 8)
//   BOARD_TEST_SETTLE   ms to wait after opening a board   (default 6000)
//   BOARD_TEST_ONLY     only test boards whose name contains this string
//   BOARD_TEST_BROWSER  path to a Chromium/Edge/Chrome executable
//
// Exit code 0 = all boards clean, 1 = at least one board failed (or setup error).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BASE = (process.env.BOARD_TEST_URL || 'http://localhost:3847').replace(/\/+$/, '');
const SECONDS = parseInt(process.env.BOARD_TEST_SECONDS || '8', 10);
const SETTLE = parseInt(process.env.BOARD_TEST_SETTLE || '6000', 10);
const ONLY = (process.env.BOARD_TEST_ONLY || '').trim().toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePuppeteer() {
  // puppeteer-core ships with the app's dependencies; load it from there.
  const core = require.resolve('puppeteer-core');
  return import(pathToFileURL(core).href).then((m) => m.default || m);
}

function resolveBrowser() {
  const candidates = [
    process.env.BOARD_TEST_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return existsSync(p); } catch { return false; } });
}

// Snapshot every panel's geometry + scrollbar/spill state + fluid classification.
// Runs in the page. A panel is "fluid" (it MUST fit its content with no inner
// scrollbar and no spill) unless it is a chip, Fixed, manual-height (mh),
// size-locked, or collapsed -- those keep a user/system-chosen size and may scroll.
const SNAP = `() => {
  const root = document.querySelector('[x-data]');
  const d = root && root._x_dataStack && root._x_dataStack[0];
  const px = {};
  document.querySelectorAll('.board-panel').forEach((p) => {
    const id = p.getAttribute('data-pid');
    const r = p.getBoundingClientRect();
    const body = p.querySelector('.board-panel-body');
    let sb = 0, spill = 0;
    if (body) {
      sb = Math.max(0, body.scrollHeight - body.clientHeight);
      const child = body.firstElementChild;
      if (child) spill = Math.round(child.getBoundingClientRect().bottom - p.getBoundingClientRect().bottom);
    }
    const g = (d && d.boardLayout && d.boardLayout[id]) || {};
    let fixed = false, sizeLocked = false, collapsed = false;
    try { fixed = !!(d && d._isFixed && d._isFixed(id)); } catch (e) {}
    try { sizeLocked = !!(d && d._lockFor && d._lockFor(id, 'size')); } catch (e) {}
    try { collapsed = !!(d && d.isPanelCollapsed && d.isPanelCollapsed(id)); } catch (e) {}
    const mh = g && g.mh != null;
    const chip = p.classList.contains('pin-chip');
    px[id] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      title: (p.querySelector('.board-panel-head,.board-panel-title,h3,h4')?.textContent || '').trim().slice(0, 28),
      chip, sb, spill, fixed, mh, sizeLocked, collapsed,
      fluid: !chip && !fixed && !mh && !sizeLocked && !collapsed,
    };
  });
  return px;
}`;

function analyze(frames) {
  const SPILL_TOL = 4;
  // Any geometry change >1px between consecutive idle frames is a jumble.
  const changes = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]; const b = frames[i];
    for (const id of Object.keys(b)) {
      if (!a[id] || b[id].chip) continue;
      const dx = b[id].x - a[id].x, dy = b[id].y - a[id].y, dw = b[id].w - a[id].w, dh = b[id].h - a[id].h;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(dw) > 1 || Math.abs(dh) > 1) {
        changes.push({ sec: i, id: id.slice(0, 22), title: b[id].title, dx, dy, dw, dh });
      }
    }
  }
  // A scrollbar that toggles on/off repeatedly is a feedback loop.
  const sbToggle = [];
  for (const id of Object.keys(frames[0] || {})) {
    if (frames[0][id].chip) continue;
    const seq = frames.map((f) => (f[id] ? (f[id].sb > 2 ? 1 : 0) : 0));
    const toggles = seq.reduce((n, v, i) => n + (i && v !== seq[i - 1] ? 1 : 0), 0);
    if (toggles >= 2) sbToggle.push({ id: id.slice(0, 22), title: frames[0][id].title, seq: seq.join('') });
  }
  // Steady-state checks on the final settled frame. A genuinely-fluid panel must
  // fit its content: no persistent inner scrollbar. ANY non-chip panel's content
  // must stay within its frame: no downward spill (Fixed/mh/locked panels clip via
  // overflow:auto, fluid panels grow to fit -- either way content never escapes).
  const last = frames[frames.length - 1] || {};
  const stuckSb = [];
  const spillBad = [];
  for (const id of Object.keys(last)) {
    const p = last[id];
    if (p.chip) continue;
    if (p.fluid && p.sb > 2) stuckSb.push({ id: id.slice(0, 22), title: p.title, sb: p.sb });
    if (p.spill > SPILL_TOL) spillBad.push({ id: id.slice(0, 22), title: p.title, spill: p.spill, fluid: p.fluid });
  }
  return { changes, sbToggle, stuckSb, spillBad };
}

async function main() {
  // 1. Make sure the app is up and discover its boards.
  let boards;
  try {
    const res = await fetch(`${BASE}/api/boards`);
    if (!res.ok) throw new Error(`GET /api/boards -> ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : (json.boards || json.items || []);
    boards = arr.map((b) => ({ id: b.id, name: b.name || b.title || b.id })).filter((b) => b.name);
  } catch (e) {
    console.error(`\n[board-jumble] cannot reach the app at ${BASE} (${e.message}).`);
    console.error('[board-jumble] start it first with "npm start", then re-run "npm run test:board".\n');
    process.exit(1);
  }
  if (ONLY) boards = boards.filter((b) => b.name.toLowerCase().includes(ONLY));
  if (!boards.length) {
    console.error('[board-jumble] no boards to test'
      + (ONLY ? ` matching BOARD_TEST_ONLY="${ONLY}"` : ` (the app reports zero boards)`) + '.');
    process.exit(1);
  }

  const exe = resolveBrowser();
  if (!exe) {
    console.error('[board-jumble] no Chromium/Edge/Chrome executable found.');
    console.error('[board-jumble] set BOARD_TEST_BROWSER to a browser path and re-run.');
    process.exit(1);
  }

  const puppeteer = await resolvePuppeteer();
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--window-size=1600,1100'], defaultViewport: { width: 1600, height: 1100 },
  });

  const results = [];
  try {
    for (const board of boards) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      // Cold-load the board directly by id (no click). This exercises the auto-shown /
      // deep-link path where the on-open content fit must run -- the path where stuck
      // scrollbars on fluid panels were slipping through.
      await page.goto(`${BASE}/app.html#/boards/${encodeURIComponent(board.id)}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(SETTLE);

      const frames = [];
      for (let i = 0; i < SECONDS; i++) {
        frames.push(await page.evaluate(`(${SNAP})()`));
        await sleep(1000);
      }
      await page.close();

      const panels = Object.keys(frames[0] || {}).length;
      const { changes, sbToggle, stuckSb, spillBad } = analyze(frames);
      const ok = changes.length === 0 && sbToggle.length === 0
        && stuckSb.length === 0 && spillBad.length === 0 && pageErrors.length === 0;
      results.push({ board: board.name, panels, ok, changes, sbToggle, stuckSb, spillBad, pageErrors });

      const tag = ok ? 'PASS' : 'FAIL';
      console.log(`[board-jumble] ${tag}  ${board.name}  (${panels} panels)`);
      if (!ok) {
        if (changes.length) console.log(`           idle geometry changes: ${JSON.stringify(changes)}`);
        if (sbToggle.length) console.log(`           scrollbar toggling:    ${JSON.stringify(sbToggle)}`);
        if (stuckSb.length) console.log(`           stuck fluid scrollbars: ${JSON.stringify(stuckSb)}`);
        if (spillBad.length) console.log(`           content spilling frame: ${JSON.stringify(spillBad)}`);
        if (pageErrors.length) console.log(`           page errors:           ${JSON.stringify(pageErrors)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[board-jumble] ${results.length - failed.length}/${results.length} boards clean.`);
  if (failed.length) {
    console.error(`[board-jumble] FAILED: ${failed.map((r) => r.board).join(', ')}.`);
    process.exit(1);
  }
  console.log('[board-jumble] OK: every board is idle-stable, fluid panels fit, nothing spills.');
}

main().catch((e) => { console.error('[board-jumble] error:', e); process.exit(1); });
