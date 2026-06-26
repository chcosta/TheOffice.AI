// Board LAYOUT regression test (Organize / AI-Layout quality + jitter).
//
// Sister to board-jumble.regression.mjs. Where that test guards an IDLE board's
// stillness, this one guards the QUALITY of an explicit Organize and proves the
// board does not drift afterwards. It exists because Organize / AI Layout used to
// emit "arbitrary spacing": stale fractional row heights (e.g. h=7.21) and off-grid
// x positions (a pin parked at x=19.9, off the canvas) survived the pack, so cards
// never aligned to the grid and the board visibly shifted after settling.
//
// For each board it COLD-LOADS the board by id, runs `organizeBoard(false)`, lets it
// settle, then asserts on the STORED layout (d.boardLayout, the source of truth):
//   1. GRID-ALIGNED   -- every flowing (non-chip/Fixed/mh/size-locked/collapsed)
//                        panel has whole-row x / y / w / h and sits on the canvas
//                        (0 <= x and x+w <= cols). No fractional / off-grid geometry.
//   2. NO OVERLAP     -- no two non-chip panels overlap on the grid.
//   3. LOW DEAD SPACE -- each fluid panel's intra-card dead space (empty pixels below
//                        its content) is under one row + tolerance: spacing is the
//                        intended uniform gap, not arbitrary slack.
//   4. IDEMPOTENT     -- a second Organize produces a byte-identical layout.
//   5. NO JITTER      -- after Organize + settle, the layout is captured, the board is
//                        left idle for a few seconds, and captured again: the two MUST
//                        be identical (the async ResizeObserver settle must not re-write
//                        fractional heights / drift the board after Organize).
//
// Run after any change to organize / fit / settle / pack code:
//   1. start the app:   npm start            (serves on http://localhost:3847)
//   2. run the test:    npm run test:board:layout
//
// Env vars (shared with the other board tests):
//   BOARD_TEST_URL      base url               (default http://localhost:3847)
//   BOARD_TEST_SETTLE   ms to wait after Organize / load  (default 4000)
//   BOARD_TEST_JITTER   idle ms between the two jitter snapshots (default 4000)
//   BOARD_TEST_DEADPX   max allowed intra-card dead px for a fluid panel (default 44)
//   BOARD_TEST_ONLY     only boards whose name contains this string
//   BOARD_TEST_BROWSER  path to a Chromium/Edge/Chrome executable
//
// Exit 0 = every board organizes clean + stable, 1 = at least one failed / setup error.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BASE = (process.env.BOARD_TEST_URL || 'http://localhost:3847').replace(/\/+$/, '');
const SETTLE = parseInt(process.env.BOARD_TEST_SETTLE || '4000', 10);
const JITTER = parseInt(process.env.BOARD_TEST_JITTER || '4000', 10);
const DEADPX = parseInt(process.env.BOARD_TEST_DEADPX || '44', 10);
const ONLY = (process.env.BOARD_TEST_ONLY || '').trim().toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePuppeteer() {
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

// Snapshot the STORED layout (the source of truth) + per-panel classification and the
// measured intra-card dead space. Runs in the page. Dead space = the empty pixels in
// the body below the intrinsic (frame-independent) content height; only meaningful for
// an expanded fluid panel.
const SNAP = `() => {
  const root = document.querySelector('[x-data]');
  const d = root && root._x_dataStack && root._x_dataStack[0];
  if (!d) return { cols: 12, rowH: 36, panels: {} };
  const cols = d.boardCols || 12, rowH = d.boardRowH || 36;
  const px = {};
  document.querySelectorAll('.board-panel').forEach((p) => {
    const id = p.getAttribute('data-pid'); if (!id) return;
    const chip = p.classList.contains('pin-chip');
    const g = (d.boardLayout && d.boardLayout[id]) || {};
    let fixed = false, sizeLocked = false, collapsed = false;
    try { fixed = !!(d._isFixed && d._isFixed(id)); } catch (e) {}
    try { sizeLocked = !!(d._lockFor && d._lockFor(id, 'size')); } catch (e) {}
    try { collapsed = !!(d.isPanelCollapsed && d.isPanelCollapsed(id)); } catch (e) {}
    const mh = g && g.mh != null;
    const fluid = !chip && !fixed && !mh && !sizeLocked && !collapsed;
    let dead = 0;
    if (fluid) {
      const body = p.querySelector('.board-panel-body');
      if (body) {
        let childSum = 0; for (const ch of body.children) childSum += ch.offsetHeight;
        const cs = getComputedStyle(body);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const overflow = body.scrollHeight - body.clientHeight;
        dead = overflow > 1 ? 0 : Math.max(0, Math.round(body.clientHeight - (childSum + pad)));
      }
    }
    px[id] = {
      x: g.x, y: g.y, w: g.w, h: g.h, chip, fixed, mh, sizeLocked, collapsed, fluid, dead,
      title: (p.querySelector('.board-panel-head,.board-panel-title,h3,h4')?.textContent || '').trim().slice(0, 28),
    };
  });
  return { cols, rowH, panels: px };
}`;

const isInt = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-6;

function rectsOverlap(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  return a.x < bx2 - 1e-6 && b.x < ax2 - 1e-6 && a.y < by2 - 1e-6 && b.y < ay2 - 1e-6;
}

// Static quality checks on a single settled snapshot.
function checkSnap(snap) {
  const { cols, panels } = snap;
  const offGrid = [];
  const deadBad = [];
  const ids = Object.keys(panels);
  for (const id of ids) {
    const p = panels[id];
    if (p.chip) continue;                 // chips pack in pixels, not the row grid -- by design
    if (p.fluid) {
      // A flowing panel must be wholly grid-aligned and on the canvas.
      const bad = [];
      if (!isInt(p.x)) bad.push('x=' + p.x);
      if (!isInt(p.y)) bad.push('y=' + p.y);
      if (!isInt(p.w)) bad.push('w=' + p.w);
      if (!isInt(p.h)) bad.push('h=' + p.h);
      if (p.x < -1e-6) bad.push('x<0');
      if (p.x + p.w > cols + 1e-6) bad.push('x+w>' + cols + ' (' + (p.x + p.w) + ')');
      if (bad.length) offGrid.push({ id: id.slice(0, 22), title: p.title, bad });
      if (p.dead > DEADPX) deadBad.push({ id: id.slice(0, 22), title: p.title, dead: p.dead });
    }
  }
  // Overlap: every non-chip panel occupies grid rows; none may intersect.
  const boxes = ids.filter((id) => !panels[id].chip
    && panels[id].x != null && panels[id].w != null
    && panels[id].y != null && panels[id].h != null)
    .map((id) => ({ id, ...panels[id] }));
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i], boxes[j])) {
        overlaps.push({ a: boxes[i].id.slice(0, 18), b: boxes[j].id.slice(0, 18) });
      }
    }
  }
  return { offGrid, deadBad, overlaps };
}

// Compare two snapshots' stored geometry -- used for idempotency + jitter.
function diffSnap(a, b) {
  const out = [];
  const ids = new Set([...Object.keys(a.panels), ...Object.keys(b.panels)]);
  for (const id of ids) {
    const pa = a.panels[id], pb = b.panels[id];
    if (!pa || !pb) { out.push({ id: id.slice(0, 22), gone: !pb, added: !pa }); continue; }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Math.abs((pa[k] || 0) - (pb[k] || 0)) > 1e-6) {
        out.push({ id: id.slice(0, 22), title: pb.title, k, from: pa[k], to: pb[k] });
      }
    }
  }
  return out;
}

const organize = (page) => page.evaluate(() => {
  const d = document.querySelector('[x-data]')._x_dataStack[0];
  d.organizeBoard(false);
});

async function main() {
  let boards;
  try {
    const res = await fetch(`${BASE}/api/boards`);
    if (!res.ok) throw new Error(`GET /api/boards -> ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : (json.boards || json.items || []);
    boards = arr.map((b) => ({ id: b.id, name: b.name || b.title || b.id })).filter((b) => b.name);
  } catch (e) {
    console.error(`\n[board-layout] cannot reach the app at ${BASE} (${e.message}).`);
    console.error('[board-layout] start it first with "npm start", then re-run "npm run test:board:layout".\n');
    process.exit(1);
  }
  if (ONLY) boards = boards.filter((b) => b.name.toLowerCase().includes(ONLY));
  if (!boards.length) {
    console.error('[board-layout] no boards to test'
      + (ONLY ? ` matching BOARD_TEST_ONLY="${ONLY}"` : ` (the app reports zero boards)`) + '.');
    process.exit(1);
  }

  const exe = resolveBrowser();
  if (!exe) {
    console.error('[board-layout] no Chromium/Edge/Chrome executable found.');
    console.error('[board-layout] set BOARD_TEST_BROWSER to a browser path and re-run.');
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
      await page.goto(`${BASE}/app.html#/boards/${encodeURIComponent(board.id)}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(SETTLE);

      // Organize once, settle, capture the quality baseline.
      await organize(page);
      await sleep(SETTLE);
      const first = await page.evaluate(`(${SNAP})()`);
      const quality = checkSnap(first);

      // Organize a second time -> must be idempotent.
      await organize(page);
      await sleep(SETTLE);
      const second = await page.evaluate(`(${SNAP})()`);
      const notIdempotent = diffSnap(first, second);

      // Leave the board idle -> the settle path must not drift it (jitter).
      await sleep(JITTER);
      const third = await page.evaluate(`(${SNAP})()`);
      const jitter = diffSnap(second, third);

      await page.close();

      const panels = Object.keys(first.panels || {}).length;
      const ok = quality.offGrid.length === 0 && quality.overlaps.length === 0
        && quality.deadBad.length === 0 && notIdempotent.length === 0
        && jitter.length === 0 && pageErrors.length === 0;
      results.push({ board: board.name, panels, ok, quality, notIdempotent, jitter, pageErrors });

      const tag = ok ? 'PASS' : 'FAIL';
      console.log(`[board-layout] ${tag}  ${board.name}  (${panels} panels)`);
      if (!ok) {
        if (quality.offGrid.length) console.log(`           off-grid / off-canvas:  ${JSON.stringify(quality.offGrid)}`);
        if (quality.overlaps.length) console.log(`           overlapping panels:     ${JSON.stringify(quality.overlaps)}`);
        if (quality.deadBad.length) console.log(`           excess dead space (>${DEADPX}px): ${JSON.stringify(quality.deadBad)}`);
        if (notIdempotent.length) console.log(`           Organize not idempotent: ${JSON.stringify(notIdempotent)}`);
        if (jitter.length) console.log(`           drift after settle:     ${JSON.stringify(jitter)}`);
        if (pageErrors.length) console.log(`           page errors:            ${JSON.stringify(pageErrors)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[board-layout] ${results.length - failed.length}/${results.length} boards organize clean + stable.`);
  if (failed.length) {
    console.error(`[board-layout] FAILED: ${failed.map((r) => r.board).join(', ')}.`);
    process.exit(1);
  }
  console.log('[board-layout] OK: Organize is grid-aligned, gap-tight, overlap-free, idempotent, and drift-free.');
}

main().catch((e) => { console.error('[board-layout] error:', e); process.exit(1); });
