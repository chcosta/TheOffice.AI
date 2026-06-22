// Board INTERACTION UX regression test.
//
// The sibling test (board-jumble.regression.mjs) proves a board is calm when left
// ALONE. This one proves the board stays calm and correct while the user DRIVES it:
// resize, move, collapse/expand, Fixed toggle, Organize, Pin-ify, zoom, font size,
// Reset layout, the "Ask board" drawer, and a live dynamic-content update.
//
// After every interaction it re-snapshots the board and asserts the board invariants:
//   * NO STUCK SCROLLBAR  -- no genuinely-fluid panel (not chip/Fixed/mh/size-locked/
//                            collapsed) keeps an inner scrollbar after settling.
//   * NO SPILL            -- no panel's content escapes the bottom of its frame.
//   * NO OVERLAP          -- no two visible, non-chip, non-collapsed panels overlap.
// ...plus the EXPECTED EFFECT of that specific interaction (e.g. a resize actually
// changed the width, a drag moved ONLY the dragged panel, collapse shrank to the
// header, Fixed froze geometry through an Organize, the drawer left the grid untouched).
//
//   1. start the app:   npm start            (serves on http://localhost:3847)
//   2. run the test:    npm run test:board:ux
//
// Env vars:
//   BOARD_TEST_URL      base url (default http://localhost:3847)
//   BOARD_UX_BOARD      board name substring to drive (default "Helix")
//   BOARD_TEST_SETTLE   ms to wait after opening / after each interaction (default 2600)
//   BOARD_TEST_BROWSER  path to a Chromium/Edge/Chrome executable
//
// Exit code 0 = every interaction kept the board valid, 1 = at least one failed.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const BASE = (process.env.BOARD_TEST_URL || 'http://localhost:3847').replace(/\/+$/, '');
const BOARD = (process.env.BOARD_UX_BOARD || 'Helix').toLowerCase();
const SETTLE = parseInt(process.env.BOARD_TEST_SETTLE || '2600', 10);
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
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return existsSync(p); } catch { return false; } });
}

// Snapshot every panel: screen rect + scrollbar/spill + layout coords (x,y,w,h grid
// units) + fluid/Fixed/mh/size-lock/collapsed classification, read from live Alpine.
function SNAP() {
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
      rx: Math.round(r.x), ry: Math.round(r.y), rw: Math.round(r.width), rh: Math.round(r.height),
      gx: g.x, gy: g.y, gw: g.w, gh: g.h, mhVal: g.mh,
      title: (p.querySelector('.board-panel-type,.board-panel-title,h3,h4') || {}).textContent ?
        (p.querySelector('.board-panel-type,.board-panel-title,h3,h4').textContent || '').trim().slice(0, 24) : '',
      chip, sb, spill, fixed, mh, sizeLocked, collapsed,
      fluid: !chip && !fixed && !mh && !sizeLocked && !collapsed,
    };
  });
  return px;
}

// Geometry of an element (panel head / resize handle) in screen px, for a given pid.
function RECT_OF(pid, sel) {
  const p = document.querySelector('.board-panel[data-pid="' + pid + '"]');
  if (!p) return null;
  const el = sel ? p.querySelector(sel) : p;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

// ---- invariant checks (node side, over a snapshot) -------------------------
const SPILL_TOL = 4;
function rectsOverlap(a, b) {
  const ox = Math.min(a.rx + a.rw, b.rx + b.rw) - Math.max(a.rx, b.rx);
  const oy = Math.min(a.ry + a.rh, b.ry + b.rh) - Math.max(a.ry, b.ry);
  return Math.min(ox, oy); // >0 px both axes == overlap
}
function invariants(snap) {
  const fails = [];
  const ids = Object.keys(snap);
  for (const id of ids) {
    const s = snap[id];
    if (s.fluid && s.sb > 2) fails.push(`stuck-scrollbar ${s.title || id.slice(0, 16)} (sb=${s.sb})`);
    if (!s.chip && s.spill > SPILL_TOL) fails.push(`spill ${s.title || id.slice(0, 16)} (${s.spill}px)`);
  }
  // Overlap among visible, non-chip, non-collapsed panels.
  const vis = ids.filter((id) => !snap[id].chip && !snap[id].collapsed && snap[id].rw > 0 && snap[id].rh > 0);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const ov = rectsOverlap(snap[vis[i]], snap[vis[j]]);
      if (ov > 6) fails.push(`overlap ${snap[vis[i]].title || vis[i].slice(0, 12)} <> ${snap[vis[j]].title || vis[j].slice(0, 12)} (${Math.round(ov)}px)`);
    }
  }
  return fails;
}

// Drag-aware invariants: a FREE head-drag may deliberately leave the dragged card overlapping
// another (the user's placement, tidied later by explicit Organize — the locked calm-lens design).
// So for the move test we keep spill / stuck-scrollbar checks but drop overlaps that involve the
// dragged panel. Overlaps NOT involving it (collateral damage) still fail.
function invariantsExcl(snap, exclId) {
  return invariants(snap).filter((f) => !(f.startsWith('overlap') && f.includes((snap[exclId] && snap[exclId].title) ? snap[exclId].title : exclId.slice(0, 12))));
}

let PASS = 0, FAIL = 0;
const results = [];
function record(step, fails, extra) {
  const ok = fails.length === 0;
  if (ok) PASS++; else FAIL++;
  results.push({ step, ok, detail: ok ? (extra || '') : fails.join('; ') });
  console.log(`[board-ux] ${ok ? 'PASS' : 'FAIL'}  ${step}${extra && ok ? '  (' + extra + ')' : ''}${ok ? '' : '  -> ' + fails.join('; ')}`);
}

async function main() {
  const exe = resolveBrowser();
  if (!exe) { console.error('[board-ux] no Chromium/Edge/Chrome found'); process.exit(1); }
  const puppeteer = await resolvePuppeteer();
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1100 } });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(String(e.message || e)); console.log('PAGEERR>', String(e.message||e), '\n', (e.stack||'').split('\n').slice(0,6).join('\n')); });
  let stash = null;

  try {
    // find the board id
    const list = await (await fetch(`${BASE}/api/boards`)).json();
    const boards = Array.isArray(list) ? list : (list.boards || []);
    const target = boards.find((b) => (b.name || '').toLowerCase().includes(BOARD)) || boards[0];
    if (!target) { console.error('[board-ux] no boards'); process.exit(1); }
    console.log(`[board-ux] driving board: ${target.name} (${target.id})`);

    // SAVE the board's mutable state so this destructive test restores it on exit.
    // (Resize/move/Organize/collapse/Fixed/Pin-ify/Reset/assistant all persist via PUT.)
    try {
      const full = await (await fetch(`${BASE}/api/boards/${encodeURIComponent(target.id)}`)).json();
      const src = (full && full.board) || full || target;
      const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
      stash = {
        items: clone(src.items), notes: clone(src.notes), checklists: clone(src.checklists),
        layout: clone(src.layout), hidden: clone(src.hidden), locks: clone(src.locks),
        pinView: src.pinView, savedLayouts: clone(src.savedLayouts), archived: src.archived,
      };
      console.log('[board-ux] saved board state for restore');
    } catch (e) { console.warn('[board-ux] could not snapshot board for restore:', e.message); }

    await page.goto(`${BASE}/app.html#/boards/${encodeURIComponent(target.id)}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.board-panel', { timeout: 20000 });
    await sleep(SETTLE + 3000); // cold-load fit-on-open converges in ~4s

    const snap = () => page.evaluate(SNAP);
    const settleAfter = async () => { await sleep(SETTLE); };

    // helper: real pointer drag through the document handlers
    const drag = async (x, y, dx, dy) => {
      if (![x, y, dx, dy].every((n) => Number.isFinite(n))) return false;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // The board's @mousedown handlers attach document mousemove/mouseup listeners and drive
      // updates through requestAnimationFrame; firing all moves in one synchronous burst can land
      // before those listeners register. Space the events out (~1 frame each) so a real drag is
      // observed -- this is harness fidelity, not a product change.
      await sleep(24);
      const steps = 8;
      for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await sleep(20); }
      await sleep(24);
      await page.mouse.up();
      return true;
    };
    const rectOf = (pid, sel) => page.evaluate(RECT_OF, pid, sel);
    const callM = (fn, ...args) => page.evaluate((f, a) => {
      const root = document.querySelector('[x-data]'); const d = root._x_dataStack[0];
      return typeof d[f] === 'function' ? d[f](...a) : null;
    }, fn, args);

    // pick stable target panels from the first snapshot
    let s0 = await snap();
    record('cold-load settled', invariants(s0), `${Object.keys(s0).length} panels`);

    const fluidIds = Object.keys(s0).filter((id) => s0[id].fluid);
    const anyIds = Object.keys(s0).filter((id) => !s0[id].chip);
    // Resize-width target must have room to grow rightward (a panel flush to the canvas right
    // edge is clamped and CAN'T widen — that would be a test-fidelity false failure, not a bug).
    const cols = await page.evaluate(() => {
      const root = document.querySelector('[x-data]'); const d = root && root._x_dataStack && root._x_dataStack[0];
      return (d && (d.boardCols || (d._boardEffCols && d._boardEffCols()))) || 12;
    });
    const growable = fluidIds.find((id) => (s0[id].gx + s0[id].gw) < cols - 1) ||
      anyIds.find((id) => (s0[id].gx + s0[id].gw) < cols - 1);
    const target1 = growable || fluidIds[0] || anyIds[0];

    // Start the gesture suite from a CLEAN, converged board so a flaky cold-load snapshot can't
    // cascade its stuck panels into every downstream resize/drag assertion (the suite does not
    // reset between tests).
    await callM('organizeBoard'); await settleAfter();

    // 1) RESIZE WIDTH (drag the 'w' handle right by 120px)
    {
      const before = (await snap())[target1];
      const h = await rectOf(target1, '.board-resize-w');
      if (h) {
        await drag(h.cx, h.cy, 120, 0);
        await settleAfter();
        const after = (await snap())[target1];
        const grew = after && before && after.gw > before.gw;
        record('resize width (+120px)', invariants(await snap()), grew ? `gw ${before.gw}->${after.gw}` : 'width unchanged');
        if (!grew) record('resize width EFFECT', ['width did not change'], '');
      } else record('resize width', ['no w-handle'], '');
    }

    // 2) RESIZE HEIGHT (drag the 'h' handle down by 90px -> pins manual height)
    {
      const before = (await snap())[target1];
      const h = await rectOf(target1, '.board-resize-h');
      if (h) {
        await drag(h.cx, h.cy, 0, 90);
        await settleAfter();
        const after = (await snap())[target1];
        const changed = after && before && (after.gh !== before.gh || after.mhVal != null);
        record('resize height (+90px)', invariants(await snap()), changed ? `gh ${before.gh}->${after.gh} mh=${after.mhVal}` : 'height unchanged');
        if (!changed) record('resize height EFFECT', ['height did not change'], '');
      } else record('resize height', ['no h-handle'], '');
    }

    // 3) MOVE / DRAG a panel (head) -- ONLY that panel may move
    {
      const before = await snap();
      const head = await rectOf(target1, '.board-panel-head');
      if (head) {
        await drag(head.x + 30, head.cy, 140, 70);
        await settleAfter();
        const after = await snap();
        const moved = after[target1] && before[target1] && (after[target1].gx !== before[target1].gx || after[target1].gy !== before[target1].gy);
        // any OTHER non-chip panel that changed grid coords = collateral movement
        const collateral = Object.keys(after).filter((id) => id !== target1 && !after[id].chip && before[id] &&
          (after[id].gx !== before[id].gx || after[id].gy !== before[id].gy));
        // Locked calm-lens: a free drag moves ONLY the dragged card; it MAY land overlapping
        // another (user's placement -> tidy with Organize). So allow overlaps involving target1,
        // but still forbid collateral movement and any new spill / stuck-scrollbar.
        const fails = invariantsExcl(after, target1);
        if (!moved) fails.push('dragged panel did not move');
        if (collateral.length) fails.push(`collateral move: ${collateral.length} other panel(s)`);
        record('drag panel (only it moves)', fails, moved ? `to (${after[target1].gx},${after[target1].gy})` : '');
      } else record('drag panel', ['no head'], '');
    }

    // 4) ORGANIZE -- tidies everything; must end with no overlap/spill/stuck sb
    { await callM('organizeBoard'); await settleAfter(); record('Organize', invariants(await snap())); }

    // 5) COLLAPSE then EXPAND a panel
    {
      const beforeH = (await snap())[target1]?.rh;
      await callM('togglePanelCollapse', target1); await settleAfter();
      const col = (await snap())[target1];
      const fails = invariants(await snap());
      if (!col?.collapsed) fails.push('panel did not collapse');
      if (col?.collapsed && col.rh >= beforeH) fails.push('collapsed height did not shrink');
      record('collapse panel', fails, col?.collapsed ? `rh ${beforeH}->${col.rh}` : '');
      await callM('togglePanelCollapse', target1); await settleAfter();
      const exp = (await snap())[target1];
      const f2 = invariants(await snap());
      if (exp?.collapsed) f2.push('panel did not expand');
      record('expand panel', f2, exp ? `rh->${exp.rh}` : '');
    }

    // 6) FIXED toggle -- geometry frozen through an Organize, then release
    {
      // target1 is a data-pid == the boardLayout key (kind-prefixed). togglePanelFixed
      // keys boardLayout by p.id, so pass that prefixed id directly -- resolving from
      // activeBoard().items (which use RAW ids) would silently no-op.
      const setFixed = (pid) => page.evaluate((id) => {
        const d = document.querySelector('[x-data]')._x_dataStack[0];
        d.togglePanelFixed({ id });
        return !!(d.boardLayout && d.boardLayout[id]);
      }, pid);
      const ok1 = await setFixed(target1); await settleAfter();
      const fxd = (await snap())[target1];
      const geomBefore = fxd && { gx: fxd.gx, gy: fxd.gy, gw: fxd.gw, gh: fxd.gh };
      await callM('organizeBoard'); await settleAfter();
      const after = (await snap())[target1];
      const frozen = ok1 && fxd?.fixed && after && geomBefore &&
        after.gx === geomBefore.gx && after.gy === geomBefore.gy && after.gw === geomBefore.gw && after.gh === geomBefore.gh;
      const fails = invariants(await snap());
      if (!fxd?.fixed) fails.push('Fixed toggle did not engage');
      else if (!frozen) fails.push('Fixed geometry moved through Organize');
      record('Fixed freezes geometry', fails, frozen ? 'geometry held through Organize' : '');
      await setFixed(target1); await settleAfter(); // release
      record('release Fixed', invariants(await snap()));
    }

    // 7) ZOOM out + Fit (view-only; must not introduce spill/scrollbars)
    {
      // The harness-limited drag steps (1-3) and the Fixed toggle (6) can leave the board
      // drifted; the view ops are an INDEPENDENT feature, so converge first (Organize is the
      // explicit converger per the locked design) -- a clean board is the correct precondition
      // for asserting "zoom/fit are view-only and introduce no overlap/spill".
      await callM('organizeBoard'); await settleAfter();
      await callM('setBoardZoom', 0.6); await sleep(600);
      record('zoom 60%', invariants(await snap()));
      await callM('fitBoardZoom'); await sleep(600);
      record('Fit zoom', invariants(await snap()));
      await callM('fitBoardWidth'); await settleAfter();
      record('Fit width', invariants(await snap()));
      await callM('setBoardZoom', 1); await sleep(600);
    }

    // 8) FONT SIZE up -- content grows; fluid panels MUST re-fit (no spill/scrollbar)
    {
      await callM('bumpBoardFont', 0.2); await sleep(200);
      await callM('bumpBoardFont', 0.2); await settleAfter(); await sleep(1500);
      record('font +40% (fluid re-fit)', invariants(await snap()));
      await callM('setBoardFont', 1); await settleAfter();
      record('font reset', invariants(await snap()));
    }

    // 9) ASK BOARD drawer -- overlay OUTSIDE the grid; opening must NOT move panels
    {
      const before = await snap();
      const opened = await page.evaluate(() => {
        const d = document.querySelector('[x-data]')._x_dataStack[0];
        if (typeof d.openBoardAssistant === 'function') { d.openBoardAssistant(); return true; }
        return false;
      });
      await sleep(900);
      const after = await snap();
      const moved = Object.keys(after).filter((id) => before[id] && !after[id].chip &&
        (Math.abs(after[id].rx - before[id].rx) > 2 || Math.abs(after[id].ry - before[id].ry) > 2 ||
         Math.abs(after[id].rw - before[id].rw) > 2 || Math.abs(after[id].rh - before[id].rh) > 2));
      const fails = invariants(after);
      if (!opened) fails.push('openBoardAssistant missing');
      if (moved.length) fails.push(`drawer shifted ${moved.length} grid panel(s)`);
      record('Ask board drawer (grid frozen)', fails, opened ? 'grid unchanged while drawer open' : '');
      await page.evaluate(() => {
        const d = document.querySelector('[x-data]')._x_dataStack[0];
        if (d.boardAssistant) d.boardAssistant.open = false;
        if (typeof d.closeBoardAssistant === 'function') d.closeBoardAssistant();
      });
      await sleep(400);
    }

    // 10) PIN-IFY -> chips, then RESET layout -> default
    {
      await callM('pinifyBoard'); await settleAfter();
      record('Pin-ify (all chips)', invariants(await snap()));
      await callM('resetBoardLayout'); await settleAfter(); await sleep(800);
      record('Reset layout', invariants(await snap()));
    }

    // 11) DYNAMIC CONTENT update -- refresh the briefing; fluid reflow must stay clean
    {
      // Isolated feature test: a clean, converged board + a dynamic content update must stay
      // clean. Converge first so a prior step's drift can't masquerade as a reflow failure.
      await callM('organizeBoard'); await settleAfter();
      const did = await page.evaluate(() => {
        const d = document.querySelector('[x-data]')._x_dataStack[0];
        if (typeof d.refreshBoardSummary === 'function') { d.refreshBoardSummary(); return true; }
        return false;
      });
      await sleep(SETTLE + 2500);
      record('dynamic briefing refresh', invariants(await snap()), did ? 'reflowed cleanly' : 'refresh n/a');
    }

    if (pageErrors.length) record('no page errors', pageErrors.slice(0, 3), '');
    else record('no page errors', []);

  } catch (e) {
    console.error('[board-ux] ERROR', e && e.stack || e);
    FAIL++;
  } finally {
    try { await browser.close(); } catch (e) {}
    // RESTORE the board's pre-test state so repeated runs don't accumulate corruption.
    if (stash) {
      try {
        const target = (await (await fetch(`${BASE}/api/boards`)).json());
        const boards = Array.isArray(target) ? target : (target.boards || []);
        const b = boards.find((x) => (x.name || '').toLowerCase().includes(BOARD)) || boards[0];
        if (b) {
          await fetch(`${BASE}/api/boards/${encodeURIComponent(b.id)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stash),
          });
          console.log('[board-ux] restored board state');
        }
      } catch (e) { console.warn('[board-ux] restore failed:', e.message); }
    }
  }

  console.log(`\n[board-ux] ${PASS} pass / ${FAIL} fail`);
  if (FAIL) {
    console.log('[board-ux] FAILURES:');
    for (const r of results.filter((r) => !r.ok)) console.log(`   - ${r.step}: ${r.detail}`);
  } else {
    console.log('[board-ux] OK: every interaction kept the board valid (no stuck scrollbar / spill / overlap).');
  }
  process.exit(FAIL ? 1 : 0);
}

main();
