// Board "periodic jumble" regression test.
//
// Guards against a class of bug where a board, left completely idle (no user
// interaction), re-lays-out itself every few seconds: panels resize/shift on their
// own and inner scrollbars flicker on and off. The board MUST be perfectly still
// when nobody is touching it -- it may only re-fit a panel when that panel's
// content actually changes, or once when the board is first opened.
//
// How it works: for every board the running app exposes, the test opens the board,
// lets it settle, then snapshots each panel's geometry (x/y/w/h) and scrollbar
// state once per second for several seconds without touching anything. If any
// panel's geometry moves between two consecutive idle snapshots, or a panel's
// scrollbar toggles repeatedly, the board is "jumbling" and the test fails.
//
// Run it any time you change board layout / sizing / observer code:
//   1. start the app:   npm start         (serves on http://localhost:3847)
//   2. run the test:    npm run test:board
//
// Useful env vars:
//   BOARD_TEST_URL      base url of the running app (default http://localhost:3847)
//   BOARD_TEST_SECONDS  idle frames to capture per board   (default 8)
//   BOARD_TEST_SETTLE   ms to wait after opening a board   (default 3500)
//   BOARD_TEST_ONLY     only test boards whose name contains this string
//   BOARD_TEST_BROWSER  path to a Chromium/Edge/Chrome executable
//
// Exit code 0 = all boards STILL, 1 = at least one board jumbling (or setup error).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BASE = (process.env.BOARD_TEST_URL || 'http://localhost:3847').replace(/\/+$/, '');
const SECONDS = parseInt(process.env.BOARD_TEST_SECONDS || '8', 10);
const SETTLE = parseInt(process.env.BOARD_TEST_SETTLE || '3500', 10);
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

// Snapshot every panel's geometry + scrollbar overflow. Runs in the page.
const SNAP = `() => {
  const px = {};
  document.querySelectorAll('.board-panel').forEach((p) => {
    const id = p.getAttribute('data-pid');
    const r = p.getBoundingClientRect();
    const body = p.querySelector('.board-panel-body');
    let sb = 0;
    if (body) sb = Math.max(0, body.scrollHeight - body.clientHeight);
    px[id] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      title: (p.querySelector('.board-panel-head,.board-panel-title,h3,h4')?.textContent || '').trim().slice(0, 28),
      chip: p.classList.contains('pin-chip'), sb,
    };
  });
  return px;
}`;

const openBoardByName = (page, name) => page.evaluate((nm) => {
  const cands = [...document.querySelectorAll('a,button,[role="button"],.board-card,.board-tile,li,div')]
    .filter((el) => (el.textContent || '').trim().toLowerCase().includes(nm.toLowerCase())
      && el.offsetParent !== null && (el.textContent || '').length < 120);
  cands.sort((a, b) => a.textContent.length - b.textContent.length);
  if (cands[0]) cands[0].click();
}, name);

function analyze(frames) {
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
  return { changes, sbToggle };
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
      await page.goto(`${BASE}/app.html#/boards`, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(1200);
      await openBoardByName(page, board.name);
      await sleep(SETTLE);

      const frames = [];
      for (let i = 0; i < SECONDS; i++) {
        frames.push(await page.evaluate(`(${SNAP})()`));
        await sleep(1000);
      }
      await page.close();

      const panels = Object.keys(frames[0] || {}).length;
      const { changes, sbToggle } = analyze(frames);
      const ok = changes.length === 0 && sbToggle.length === 0 && pageErrors.length === 0;
      results.push({ board: board.name, panels, ok, changes, sbToggle, pageErrors });

      const tag = ok ? 'PASS' : 'FAIL';
      console.log(`[board-jumble] ${tag}  ${board.name}  (${panels} panels)`);
      if (!ok) {
        if (changes.length) console.log(`           idle geometry changes: ${JSON.stringify(changes)}`);
        if (sbToggle.length) console.log(`           scrollbar toggling:    ${JSON.stringify(sbToggle)}`);
        if (pageErrors.length) console.log(`           page errors:           ${JSON.stringify(pageErrors)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[board-jumble] ${results.length - failed.length}/${results.length} boards STILL.`);
  if (failed.length) {
    console.error(`[board-jumble] FAILED: ${failed.map((r) => r.board).join(', ')} jumbled while idle.`);
    process.exit(1);
  }
  console.log('[board-jumble] OK: no board jumbled while idle.');
}

main().catch((e) => { console.error('[board-jumble] error:', e); process.exit(1); });
