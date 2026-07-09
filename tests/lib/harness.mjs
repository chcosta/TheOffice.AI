// Browserless test harness for TheOffice.AI.
//
// The existing tests/board-*.regression.mjs suites drive a real browser via
// puppeteer-core. That path is invaluable for layout/paint bugs but is heavy and,
// in some CI/dev environments, flaky. This harness is the complementary layer:
//
//   * UNIT tests over pure server.js helpers, run with NO browser and NO running
//     server, by extracting the real function bodies into a vm sandbox
//     (extractFns) so the tests exercise the SHIPPED code, not a copy.
//   * INTEGRATION tests over the live HTTP API (api / serverUp). When the dev
//     server on :3847 isn't running these are SKIPPED (not failed) so `npm test`
//     still yields a meaningful unit-only result offline.
//
// It intentionally has zero dependencies beyond Node core.
//
// Usage:
//   import { createRunner, extractFns, api, serverUp } from './lib/harness.mjs';
//   const t = createRunner('my-suite');
//   await t.test('adds', () => t.eq(1 + 1, 2));
//   await t.done();          // prints summary, returns { pass, fail, skip }
//
// A suite file can be run directly (node tests/foo.mjs) or collected by
// tests/run-all.mjs, which aggregates every suite's counts into one exit code.

import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const BASE = (process.env.MEAI_TEST_URL || process.env.BASE_URL || 'http://localhost:3847').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export class AssertionError extends Error {}

function fmt(v) {
  try {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'bigint') return `${v}n`;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createRunner(suiteName) {
  const results = [];
  let skipReason = null;

  function record(name, status, detail) {
    results.push({ name, status, detail });
    const tag = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
    let line = `  ${tag} ${name}`;
    if (detail) line += `  — ${detail}`;
    console.log(line);
  }

  const api = {
    // Register a synchronous or async test. A throw = fail. Return value ignored.
    async test(name, fn) {
      if (skipReason) { record(name, 'skip', skipReason); return; }
      try {
        await fn(api);
        record(name, 'pass');
      } catch (e) {
        const msg = e instanceof AssertionError ? e.message : `${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`;
        record(name, 'fail', msg);
      }
    },
    // Skip every remaining test in this suite (e.g. server unreachable).
    skipAll(reason) { skipReason = reason || 'skipped'; },
    // --- assertion helpers (throw AssertionError on failure) ---
    ok(cond, msg) { if (!cond) throw new AssertionError(msg || `expected truthy, got ${fmt(cond)}`); },
    notOk(cond, msg) { if (cond) throw new AssertionError(msg || `expected falsy, got ${fmt(cond)}`); },
    eq(a, b, msg) { if (a !== b) throw new AssertionError(msg || `expected ${fmt(b)}, got ${fmt(a)}`); },
    ne(a, b, msg) { if (a === b) throw new AssertionError(msg || `expected not ${fmt(b)}`); },
    deep(a, b, msg) {
      const sa = JSON.stringify(a), sb = JSON.stringify(b);
      if (sa !== sb) throw new AssertionError(msg || `expected ${sb}, got ${sa}`);
    },
    gt(a, b, msg) { if (!(a > b)) throw new AssertionError(msg || `expected ${fmt(a)} > ${fmt(b)}`); },
    gte(a, b, msg) { if (!(a >= b)) throw new AssertionError(msg || `expected ${fmt(a)} >= ${fmt(b)}`); },
    lt(a, b, msg) { if (!(a < b)) throw new AssertionError(msg || `expected ${fmt(a)} < ${fmt(b)}`); },
    lte(a, b, msg) { if (!(a <= b)) throw new AssertionError(msg || `expected ${fmt(a)} <= ${fmt(b)}`); },
    includes(hay, needle, msg) {
      const has = hay && typeof hay.includes === 'function' && hay.includes(needle);
      if (!has) throw new AssertionError(msg || `expected ${fmt(hay)} to include ${fmt(needle)}`);
    },
    throws(fn, msg) {
      let threw = false;
      try { fn(); } catch { threw = true; }
      if (!threw) throw new AssertionError(msg || 'expected function to throw');
    },
    fail(msg) { throw new AssertionError(msg || 'forced failure'); },
    // Finish the suite: print a one-line summary, return counts.
    async done() {
      const pass = results.filter((r) => r.status === 'pass').length;
      const fail = results.filter((r) => r.status === 'fail').length;
      const skip = results.filter((r) => r.status === 'skip').length;
      const tag = fail ? 'FAIL' : 'PASS';
      console.log(`[${suiteName}] ${tag}  ${pass} passed, ${fail} failed, ${skip} skipped`);
      return { suite: suiteName, pass, fail, skip };
    },
  };
  console.log(`\n=== ${suiteName} ===`);
  return api;
}

// ---------------------------------------------------------------------------
// vm extraction — unit-test the REAL server.js helper bodies with no server
// ---------------------------------------------------------------------------

// Balanced-brace scan: given the whole source and a starting index at the
// opening '{' of a function body, return the index just past the matching '}'.
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces while extracting function body');
}

// Extract one or more named `function NAME(...) { ... }` definitions from a
// source file and evaluate them together in a fresh vm context, returning the
// module.exports object. The functions run as the SHIPPED code (same text), so
// a passing test proves the real implementation, not a re-typed copy.
//
//   const { _hmToMin, _meAiValidateAgendaChange } = extractFns(
//     'server.js', ['_hmToMin', '_meAiScheduleMap', '_meAiValidateAgendaChange']);
export function extractFns(relOrAbsPath, names, opts = {}) {
  const path = relOrAbsPath;
  const src = fs.readFileSync(path, 'utf8');
  const bodies = [];
  for (const name of names) {
    // Find "function NAME(" — first occurrence at a definition site.
    const re = new RegExp(`function\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\(`);
    const m = re.exec(src);
    if (!m) throw new Error(`extractFns: could not find function ${name} in ${path}`);
    // Advance PAST the parameter list first — a destructured param
    // (e.g. `function f(a, { x, y })`) has its own `{ ... }` that must NOT be
    // mistaken for the body. Paren-match from the signature's `(` to its `)`,
    // then take the first `{` after that as the true body brace.
    const openParen = src.indexOf('(', m.index);
    if (openParen < 0) throw new Error(`extractFns: no param list for ${name}`);
    let pdepth = 0, closeParen = -1;
    for (let k = openParen; k < src.length; k++) {
      const c = src[k];
      if (c === '(') pdepth++;
      else if (c === ')') { pdepth--; if (pdepth === 0) { closeParen = k; break; } }
    }
    if (closeParen < 0) throw new Error(`extractFns: unbalanced param parens for ${name}`);
    const i = src.indexOf('{', closeParen);
    if (i < 0) throw new Error(`extractFns: no body brace for ${name}`);
    const end = matchBrace(src, i);
    bodies.push(src.slice(m.index, end));
  }
  const exportsList = names.map((n) => `${n}`).join(', ');
  const prelude = opts.prelude ? `${opts.prelude}\n\n` : '';
  const code = `${prelude}${bodies.join('\n\n')}\n\nmodule.exports = { ${exportsList} };`;
  const sandbox = {
    module: { exports: {} },
    require,
    console,
    Date,
    Math,
    JSON,
    ...(opts.sandbox || {}),
  };
  vm.runInNewContext(code, sandbox, { filename: `extract:${path}` });
  return sandbox.module.exports;
}

// Slice a contiguous region of a source file from the start of `startMarker`
// through the end of the line containing `endMarker` (inclusive). Handy for
// pulling module-level const declarations (e.g. shared regexes) out of the
// shipped source to feed into extractFns's `prelude`, so a test exercises the
// real value rather than a duplicated copy.
export function sliceSource(relOrAbsPath, startMarker, endMarker) {
  const src = fs.readFileSync(relOrAbsPath, 'utf8');
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`sliceSource: start marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error(`sliceSource: end marker not found: ${endMarker}`);
  const lineEnd = src.indexOf('\n', b);
  return src.slice(a, lineEnd < 0 ? undefined : lineEnd);
}

// ---------------------------------------------------------------------------
// HTTP — live API integration helpers
// ---------------------------------------------------------------------------

// Fetch JSON (or text) from the live app. Returns { ok, status, json, text }.
export async function api(pathname, opts = {}) {
  const url = pathname.startsWith('http') ? pathname : `${BASE}${pathname}`;
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(to);
  }
}

// True if the dev server answers a cheap endpoint. Used by integration suites
// to skipAll() gracefully when the server isn't running.
export async function serverUp(timeout = 4000) {
  try {
    const r = await api('/api/settings', { timeout });
    return r.status > 0 && r.status < 500;
  } catch {
    return false;
  }
}
