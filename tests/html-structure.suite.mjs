// Structural-integrity guard for the shipped single-file SPA.
//
// public/app.html is authored by hand and by agents. A single dropped or extra
// container tag (a rogue </div>, an unbalanced <template>/<section>) does not
// trip `node -c` or _syntax.mjs — those only parse inline <script> JS — yet it
// silently corrupts the DOM at browser parse time. The concrete regression this
// guards against: a missing `<div class="mr-metrics">` open let a later </div>
// close .content-inner early and ejected ~17 route sections (settings, reports,
// activity, marketplace, …) below the fold.
//
// This suite fails CI/`npm test` the moment app.html's structural containers go
// unbalanced, and self-tests the checker so a future edit can't quietly neuter
// the guard.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from './lib/harness.mjs';
import { checkHtmlStructure, tokenizeTags } from './lib/html-structure.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(__dirname);

const t = createRunner('html-structure');

// --- The real guard: the shipped SPA must be structurally balanced. ---------
await t.test('public/app.html structural containers are balanced', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.html'), 'utf8');
  const r = checkHtmlStructure(src);
  if (!r.ok) {
    const detail = r.errors
      .slice(0, 6)
      .map((e) => (e.line ? `L${e.line}: ${e.message}` : e.message))
      .join('  |  ');
    t.fail(`app.html has ${r.errors.length} structural error(s): ${detail}`);
  }
  t.ok(r.ok);
});

// --- Self-tests: prove the checker actually catches broken tag state. --------
// These run against tiny in-memory fixtures so the guard's own correctness is
// verified independently of app.html's current (good) state.

await t.test('detects a stray/extra </div>', () => {
  const r = checkHtmlStructure('<div><div></div></div></div>');
  t.notOk(r.ok, 'expected an unbalanced-div error');
  t.ok(r.errors.some((e) => e.tag === 'div'));
});

await t.test('detects a missing container open (the mr-metrics bug shape)', () => {
  // A </div> whose opening tag was dropped — closes an ancestor early.
  const r = checkHtmlStructure('<section><div class="wrap"><span>x</span></div></div></section>');
  t.notOk(r.ok);
  t.ok(r.errors.some((e) => e.tag === 'div' && /stray|unbalanced/.test(e.message)));
});

await t.test('detects an unbalanced <template>', () => {
  const r = checkHtmlStructure('<template><div></div>');
  t.notOk(r.ok);
  t.ok(r.errors.some((e) => e.tag === 'template'));
});

await t.test('accepts balanced markup with self-closing + void elements', () => {
  const r = checkHtmlStructure('<div><br><img src="x"><section><input/></section></div>');
  t.ok(r.ok, JSON.stringify(r.errors));
});

// --- Tokenizer robustness: the traps that make naive parsers wrong here. -----

await t.test('attribute values with > and < (Alpine JS exprs) do not break parsing', () => {
  // x-show="count > 0" and :class="a < b ? .." contain bare comparison operators
  // inside quotes — a naive /<[^>]*>/ tokenizer mis-splits these.
  const html = '<div x-show="count > 0"><span :class="a < b ? \'y\' : \'n\'">z</span></div>';
  const r = checkHtmlStructure(html);
  t.ok(r.ok, JSON.stringify(r.errors));
});

await t.test('raw-text <script>/<style> contents are not treated as tags', () => {
  const html = '<div><script>if (a < b) { x = "</div>"; }<\/script><style>.c > .d {}</style></div>';
  const r = checkHtmlStructure(html);
  t.ok(r.ok, JSON.stringify(r.errors));
});

await t.test('HTML comments containing tags are ignored', () => {
  const r = checkHtmlStructure('<div><!-- <div> orphan </div> --></div>');
  t.ok(r.ok, JSON.stringify(r.errors));
});

await t.test('escaped quote inside an opposite-quoted attribute is handled', () => {
  // :title="pin this panel\'s size" — a \' inside a double-quoted value.
  const html = '<div :title="pin this panel\\\'s size"><span>ok</span></div>';
  const r = checkHtmlStructure(html);
  t.ok(r.ok, JSON.stringify(r.errors));
});

await t.test('tokenizer distinguishes open/close/selfclose kinds', () => {
  const toks = tokenizeTags('<div></div><br/><img>');
  t.eq(toks.filter((x) => x.tag === 'div' && x.kind === 'open').length, 1);
  t.eq(toks.filter((x) => x.tag === 'div' && x.kind === 'close').length, 1);
  t.eq(toks.filter((x) => x.tag === 'br').length, 1);
  t.eq(toks.find((x) => x.tag === 'br').kind, 'selfclose');
  t.eq(toks.find((x) => x.tag === 'img').kind, 'selfclose');
});

const r = await t.done();
process.exit(r.fail ? 1 : 0);
