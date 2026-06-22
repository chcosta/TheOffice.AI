// Multi-client board concurrency regression test.
//
// Opens TWO independent clients (separate browser tabs => separate sessionStorage
// clientIds) on the SAME board and proves the server-authoritative writer-lease keeps
// them from fighting over the layout (the bug the lease was built to kill: two visible
// clients each fit to their own viewport and PUT layout, ping-ponging over SSE and
// jumbling a focused user's board):
//
//   1. SINGLE WRITER -- after both settle, exactly ONE client holds the lease (the
//      most-recently-opened "master"); the other is demoted to a read-only listener,
//      and both agree on who the holder is.
//   2. NO JUMBLE     -- with BOTH clients open and idle, NEITHER client's panels
//      move / resize / scrollbar-flicker / spill. A stale listener must never degrade
//      the master's view.
//   3. FOCUS HANDOFF -- when the listener interacts (claims the lease), it becomes the
//      master and the prior master drops to listener -- and the board still doesn't
//      jumble afterward.
//
// Run it any time you touch the lease wiring, board layout, or SSE board-lease handling:
//   1. start the app:   npm start                 (serves on http://localhost:3847)
//   2. run the test:    npm run test:board:mc
//
// Useful env vars:
//   BOARD_TEST_URL      base url of the running app (default http://localhost:3847)
//   BOARD_MC_SECONDS    idle frames captured per phase     (default 6)
//   BOARD_MC_SETTLE     ms to wait after opening a board   (default 6000)
//   BOARD_TEST_ONLY     only test the board whose name contains this string
//   BOARD_TEST_BROWSER  path to a Chromium/Edge/Chrome executable
//
// Exit code 0 = clean, 1 = a failure (or setup error).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BASE = (process.env.BOARD_TEST_URL || 'http://localhost:3847').replace(/\/+$/, '');
const SECONDS = parseInt(process.env.BOARD_MC_SECONDS || '6', 10);
const SETTLE = parseInt(process.env.BOARD_MC_SETTLE || '6000', 10);
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

// Snapshot every panel's geometry + scrollbar/spill + fluid classification (identical
// classification to the jumble suite so by-design scrollbars on Fixed/locked/collapsed
// panels are NOT flagged).
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

// Read the live writer-lease state out of the Alpine component.
const LEASE = `() => {
  const root = document.querySelector('[x-data]');
  const d = root && root._x_dataStack && root._x_dataStack[0];
  if (!d) return null;
  return {
    held: d._boardLeaseHeld !== false,
    holder: d._boardLeaseHolder || '',
    clientId: (typeof d._clientId === 'function' ? d._clientId() : d._boardClientId) || '',
  };
}`;

function analyze(frames) {
  const SPILL_TOL = 4;
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
  const sbToggle = [];
  for (const id of Object.keys(frames[0] || {})) {
    if (frames[0][id].chip) continue;
    const seq = frames.map((f) => (f[id] ? (f[id].sb > 2 ? 1 : 0) : 0));
    const toggles = seq.reduce((n, v, i) => n + (i && v !== seq[i - 1] ? 1 : 0), 0);
    if (toggles >= 2) sbToggle.push({ id: id.slice(0, 22), title: frames[0][id].title, seq: seq.join('') });
  }
  const last = frames[frames.length - 1] || {};
  const stuckSb = [], spillBad = [];
  for (const id of Object.keys(last)) {
    const p = last[id];
    if (p.chip) continue;
    if (p.fluid && p.sb > 2) stuckSb.push({ id: id.slice(0, 22), title: p.title, sb: p.sb });
    if (p.spill > SPILL_TOL) spillBad.push({ id: id.slice(0, 22), title: p.title, spill: p.spill });
  }
  return { changes, sbToggle, stuckSb, spillBad };
}

// Capture `n` idle frames from a page, one per second.
async function capture(page, n) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(await page.evaluate(`(${SNAP})()`));
    await sleep(1000);
  }
  return frames;
}

function jumbleSummary(label, frames, pageErrors) {
  const { changes, sbToggle, stuckSb, spillBad } = analyze(frames);
  const ok = changes.length === 0 && sbToggle.length === 0 && stuckSb.length === 0
    && spillBad.length === 0 && pageErrors.length === 0;
  return { label, ok, changes, sbToggle, stuckSb, spillBad, pageErrors: pageErrors.slice() };
}

async function main() {
  // 1. Discover boards.
  let boards;
  try {
    const res = await fetch(`${BASE}/api/boards`);
    if (!res.ok) throw new Error(`GET /api/boards -> ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : (json.boards || json.items || []);
    boards = arr.map((b) => ({ id: b.id, name: b.name || b.title || b.id, items: (b.items || []).length })).filter((b) => b.name);
  } catch (e) {
    console.error(`\n[board-mc] cannot reach the app at ${BASE} (${e.message}).`);
    console.error('[board-mc] start it first with "npm start", then re-run "npm run test:board:mc".\n');
    process.exit(1);
  }
  if (!boards.length) { console.error('[board-mc] no boards to test.'); process.exit(1); }

  // Pick the board: an explicit ONLY filter wins; otherwise prefer a content-rich board
  // that ISN'T the live-chat-heavy Helix UX one (its async live content settles on its
  // own timeline and would mask the multi-client signal). Most pins = best exercise.
  let pick;
  if (ONLY) pick = boards.find((b) => b.name.toLowerCase().includes(ONLY));
  if (!pick) {
    const calm = boards.filter((b) => !/helix/i.test(b.name));
    pick = (calm.length ? calm : boards).slice().sort((a, b) => b.items - a.items)[0];
  }
  if (!pick) { console.error('[board-mc] could not pick a board.'); process.exit(1); }

  const exe = resolveBrowser();
  if (!exe) {
    console.error('[board-mc] no Chromium/Edge/Chrome executable found. Set BOARD_TEST_BROWSER.');
    process.exit(1);
  }

  console.log(`[board-mc] board: "${pick.name}" (${pick.items} pins)  base=${BASE}`);

  const puppeteer = await resolvePuppeteer();
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--window-size=1600,1100'], defaultViewport: { width: 1600, height: 1100 },
  });

  const url = `${BASE}/app.html#/boards/${encodeURIComponent(pick.id)}`;
  const failures = [];
  let pass = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`[board-mc]   PASS  ${name}`); }
    else { failures.push({ name, detail }); console.log(`[board-mc]   FAIL  ${name}`); if (detail) console.log('             ' + JSON.stringify(detail)); }
  };

  try {
    // Client A opens first.
    const a = await browser.newPage();
    const aErr = []; a.on('pageerror', (e) => aErr.push(e.message));
    await a.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(SETTLE);

    // Client B opens second on the SAME board -> B becomes the most-recently-active master.
    const b = await browser.newPage();
    const bErr = []; b.on('pageerror', (e) => bErr.push(e.message));
    await b.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(SETTLE);
    // Allow the steal broadcast to reach A over SSE before we read the lease.
    await sleep(2500);

    // --- Check 1: SINGLE WRITER ---
    const la = await a.evaluate(`(${LEASE})()`);
    const lb = await b.evaluate(`(${LEASE})()`);
    const heldCount = [la, lb].filter((x) => x && x.held).length;
    check('single writer: exactly one client holds the lease', heldCount === 1, { a: la, b: lb });
    check('most-recently-opened client (B) is the master', !!(lb && lb.held) && !!(la && !la.held), { a: la, b: lb });
    check('demoted client agrees B is the holder',
      !!(la && lb && la.holder && la.holder === lb.clientId), { aHolder: la && la.holder, bClientId: lb && lb.clientId });

    // --- Check 2: NO JUMBLE while both are open & idle ---
    // Capture both concurrently so the listener (A) is genuinely live alongside the master.
    const [fa, fb] = await Promise.all([capture(a, SECONDS), capture(b, SECONDS)]);
    const ra = jumbleSummary('listener A idle', fa, aErr);
    const rb = jumbleSummary('master B idle', fb, bErr);
    check('master B does not jumble while a listener is open', rb.ok,
      rb.ok ? null : { changes: rb.changes.slice(0, 4), sbToggle: rb.sbToggle, stuckSb: rb.stuckSb, spillBad: rb.spillBad, pageErrors: rb.pageErrors.slice(0, 2) });
    check('listener A does not jumble', ra.ok,
      ra.ok ? null : { changes: ra.changes.slice(0, 4), sbToggle: ra.sbToggle, stuckSb: ra.stuckSb, spillBad: ra.spillBad, pageErrors: ra.pageErrors.slice(0, 2) });

    // --- Check 3: FOCUS HANDOFF ---
    // The listener (A) interacts -> claims the lease -> becomes master; B must drop.
    await a.evaluate(`(() => { const d = document.querySelector('[x-data]')._x_dataStack[0]; d._claimBoardLease(); })()`);
    await sleep(2500); // let the steal broadcast reach B
    const la2 = await a.evaluate(`(${LEASE})()`);
    const lb2 = await b.evaluate(`(${LEASE})()`);
    check('focus handoff: A becomes master after it interacts', !!(la2 && la2.held), { a: la2 });
    check('focus handoff: prior master B drops to listener', !!(lb2 && !lb2.held), { b: lb2 });
    check('focus handoff: exactly one holder after handoff', [la2, lb2].filter((x) => x && x.held).length === 1, { a: la2, b: lb2 });

    // --- Check 4: still no jumble after the handoff ---
    aErr.length = 0; bErr.length = 0;
    const [fa2, fb2] = await Promise.all([capture(a, SECONDS), capture(b, SECONDS)]);
    const ra2 = jumbleSummary('A master post-handoff', fa2, aErr);
    const rb2 = jumbleSummary('B listener post-handoff', fb2, bErr);
    check('no jumble after focus handoff (new master A)', ra2.ok,
      ra2.ok ? null : { changes: ra2.changes.slice(0, 4), sbToggle: ra2.sbToggle, stuckSb: ra2.stuckSb, spillBad: ra2.spillBad });
    check('no jumble after focus handoff (demoted B)', rb2.ok,
      rb2.ok ? null : { changes: rb2.changes.slice(0, 4), sbToggle: rb2.sbToggle, stuckSb: rb2.stuckSb, spillBad: rb2.spillBad });

    await a.close(); await b.close();
  } catch (e) {
    failures.push({ name: 'harness error', detail: e.message });
    console.error('[board-mc] harness error:', e.stack || e.message);
  } finally {
    await browser.close();
  }

  console.log(`\n[board-mc] ${pass} passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f.name}`); process.exit(1); }
  console.log('[board-mc] multi-client concurrency: CLEAN');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
