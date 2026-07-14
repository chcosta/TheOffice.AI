// Browserless feature-coverage suite for TheOffice.AI.
//
// Complements meai.suite.mjs (which focuses on the Me.AI agenda engine) by
// exercising the OTHER primary features the owner called out: workspaces/boards,
// Code Flow, Diary, Newsletter, Connect, playbooks, water cooler, home, dev
// cards, system agents, marketplace/skills, dependencies, and appearance.
//
// Two layers, mirroring meai.suite:
//   * UNIT — a handful of pure server.js helpers extracted into a vm sandbox so
//     the assertions run the SHIPPED code (identity/key helpers that underpin
//     dev-card / PR-pin / agent dedupe).
//   * INTEGRATION — read-only GET probes over the live HTTP API. When the dev
//     server on :3847 is down these SKIP (not fail), so `npm test` still yields
//     a meaningful unit-only result offline.
//
// Water cooler and appearance have NO dedicated backend route — water cooler is
// a client view over managers/agents chat, appearance persists through
// /api/settings — so they are covered via those backing endpoints rather than
// an invented URL.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createRunner, extractFns, api, serverUp, sliceSource } from './lib/harness.mjs';

const require = createRequire(import.meta.url);

const SERVER = 'server.js';
const APP_HTML = 'public/app.html';

const t = createRunner('features.suite');

// ---------------------------------------------------------------------------
// UNIT — pure identity/key helpers (dev cards, PR pins, agents)
// ---------------------------------------------------------------------------

const U = extractFns(SERVER, ['slugifyId', '_meAiPrRefId', '_meAiParseWorkItem', '_meAiDevKey']);

await t.test('slugifyId lowercases + hyphenates, strips edges', () => {
  t.eq(U.slugifyId('Helix UX Standup'), 'helix-ux-standup');
  t.eq(U.slugifyId('  Foo/Bar!! '), 'foo-bar');
  t.eq(U.slugifyId('keep.dots_and-dashes'), 'keep.dots_and-dashes');
});

await t.test('slugifyId falls back to "agent" for empty/blank', () => {
  t.eq(U.slugifyId(''), 'agent');
  t.eq(U.slugifyId(null), 'agent');
  t.eq(U.slugifyId('!!!'), 'agent');
});

await t.test('_meAiPrRefId is provider-scoped + case-insensitive (PR pin identity)', () => {
  const azdo = U._meAiPrRefId({ org: 'DncEng', project: 'Internal', repo: 'Arcade', prId: 17018 });
  t.eq(azdo, 'dnceng|internal|arcade|17018');
  const gh = U._meAiPrRefId({ provider: 'github', org: 'dotnet', project: '', repo: 'arcade', prId: 6629 });
  t.eq(gh, 'github|dotnet||arcade|6629');
});

await t.test('_meAiPrRefId: same PR two casings collapses to one key (no dup pin)', () => {
  const a = U._meAiPrRefId({ org: 'dnceng', project: 'internal', repo: 'helix', prId: '42' });
  const b = U._meAiPrRefId({ org: 'DNCENG', project: 'Internal', repo: 'Helix', prId: '42' });
  t.eq(a, b);
});

await t.test('_meAiParseWorkItem parses AzDO + GitHub, else null', () => {
  const azdo = U._meAiParseWorkItem('https://dev.azure.com/dnceng/internal/_workitems/edit/12345');
  t.ok(azdo, 'expected an AzDO parse');
  t.eq(azdo.provider, 'azdo');
  t.eq(azdo.workItemId, '12345');
  const gh = U._meAiParseWorkItem('https://github.com/dotnet/arcade/issues/678');
  t.ok(gh, 'expected a GitHub parse');
  t.eq(gh.provider, 'github');
  t.eq(gh.repo, 'arcade');
  t.eq(gh.workItemId, '678');
  t.eq(U._meAiParseWorkItem('https://example.com/nope'), null);
});

await t.test('_meAiDevKey collapses an agenda item + a dev card on the same work item', () => {
  const fromParse = U._meAiParseWorkItem('https://dev.azure.com/dnceng/internal/_workitems/edit/999');
  const k1 = U._meAiDevKey(fromParse.provider, fromParse.org, fromParse.project, fromParse.workItemId);
  const k2 = U._meAiDevKey('AzDO', 'DncEng', 'Internal', '999');
  t.eq(k1, k2, 'same work item should yield one stable dev key regardless of casing');
});

// ---------------------------------------------------------------------------
// INTEGRATION — read-only GET probes across the primary features
// ---------------------------------------------------------------------------

const up = await serverUp();
if (!up) t.skipAll(`server ${process.env.BASE_URL || 'http://localhost:3847'} not reachable`);

// Small helper: assert a GET returns an ok/near-ok status and yields JSON.
async function probe(path, shapeCheck) {
  const r = await api(path);
  t.ok(r.status >= 200 && r.status < 500, `${path} returned a sane status (${r.status})`);
  if (r.json != null && typeof shapeCheck === 'function') shapeCheck(r.json, r);
  return r;
}

// --- Workspaces / boards ---
await t.test('boards: GET /api/boards returns an array of boards', async () => {
  await probe('/api/boards', (j) => {
    t.ok(Array.isArray(j), 'boards payload is an array');
    if (j.length) { t.ok('id' in j[0], 'board has id'); t.ok('name' in j[0], 'board has name'); }
  });
});

// --- Dev cards ---
await t.test('dev cards: GET /api/dev-items returns an array', async () => {
  await probe('/api/dev-items', (j) => {
    t.ok(Array.isArray(j), 'dev-items payload is an array');
    if (j.length) t.ok('id' in j[0], 'dev item has id');
  });
});

// --- Code Flow ---
await t.test('code flow: GET /api/codeflow/repos returns { repos: [] }', async () => {
  await probe('/api/codeflow/repos', (j) => {
    t.ok(Array.isArray(j.repos), 'codeflow repos is an array');
  });
});

await t.test('code flow: GET /api/codeflow/pullrequests answers', async () => {
  const r = await api('/api/codeflow/pullrequests?view=reviews');
  t.ok(r.status >= 200 && r.status < 500, `status ${r.status}`);
});

// --- System agents + water cooler backing data ---
await t.test('system agents: GET /api/agents returns an array', async () => {
  await probe('/api/agents', (j) => {
    t.ok(Array.isArray(j), 'agents payload is an array');
    if (j.length) t.ok('agent_id' in j[0], 'agent has agent_id');
  });
});

await t.test('water cooler backing: GET /api/chats returns an array', async () => {
  // Water cooler is a client view over agent chats (route #/chat) — no
  // dedicated route. Its data source is /api/chats. (The old /api/managers
  // backing was retired along with the manager plugin.)
  await probe('/api/chats', (j) => {
    t.ok(Array.isArray(j), 'chats payload is an array');
    if (j.length) t.ok('id' in j[0], 'chat has id');
  });
});

// --- Diary + Connect ---
await t.test('connect: GET /api/connect returns { state }', async () => {
  await probe('/api/connect', (j) => {
    t.ok(j.state && typeof j.state === 'object', 'connect has a state object');
  });
});

await t.test('diary: GET /api/connect/evidence answers (diary reuses connect evidence)', async () => {
  const r = await api('/api/connect/evidence');
  t.ok(r.status >= 200 && r.status < 500, `status ${r.status}`);
});

// --- Newsletter ---
await t.test('newsletter: GET /api/newsletter returns { state }', async () => {
  await probe('/api/newsletter', (j) => {
    t.ok(j.state && typeof j.state === 'object', 'newsletter has a state object');
  });
});

// --- Playbooks ---
await t.test('playbooks: GET /api/me-ai/playbooks returns a non-empty catalog', async () => {
  await probe('/api/me-ai/playbooks', (j) => {
    t.ok(j.ok, 'playbooks ok flag');
    t.ok(Array.isArray(j.playbooks), 'playbooks is an array');
    t.gt(j.playbooks.length, 0, 'at least one playbook');
    t.ok('label' in j.playbooks[0], 'playbook has a label');
  });
});

// --- Marketplace / skills ---
await t.test('marketplace: GET /api/marketplace/catalog returns { entries }', async () => {
  await probe('/api/marketplace/catalog', (j) => {
    t.ok(Array.isArray(j.entries), 'catalog entries is an array');
  });
});

// --- Dependencies ---
await t.test('dependencies: GET /api/dependencies returns { items }', async () => {
  await probe('/api/dependencies', (j) => {
    t.ok(Array.isArray(j.items), 'dependencies items is an array');
  });
});

// --- Appearance (persists through settings) + home ---
await t.test('appearance/home: GET /api/settings returns a settings object', async () => {
  await probe('/api/settings', (j) => {
    t.ok(j && typeof j === 'object' && !Array.isArray(j), 'settings is an object');
  });
});

// --- Unified writing assistant (newsletter + compose share one FAB panel) ---
// Locks in the shared, context-dispatched assistant: one floating panel gated on
// asstCtx() (newsletter route OR an open compose studio), replacing the old inline
// "Revise" drawer + embedded compose chat aside. Guards against regressing to the
// per-feature FABs / duplicate chat panels or leaving stale references behind.
await t.test('assistant: unified FAB panel is context-dispatched, no stale refs', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // The shared FAB + panel gate on asstCtx() (visible on newsletter + compose studio only).
  t.ok(/x-show="asstCtx\(\) && !asstPanelOpen\(\)"/.test(html), 'FAB button gates on asstCtx() && !asstPanelOpen()');
  t.ok(/x-show="asstCtx\(\) && asstPanelOpen\(\)"/.test(html), 'floating panel gates on asstCtx() && asstPanelOpen()');
  t.ok(/asstCtx\s*\(\s*\)\s*\{/.test(html), 'asstCtx() is defined');
  // asstCtx returns compose only inside an open studio, so the FAB never shows on the launcher.
  t.ok(/route === 'compose' && this\.compose && this\.compose\.view === 'studio' && this\.compose\.current/.test(html),
    'asstCtx() restricts compose to an open studio with a current composition');

  // Dispatch layer routes to the correct backend for each context.
  for (const fn of ['asstSend', 'asstToggle', 'asstPaste', 'asstDrop', 'asstRemoveAttachment', 'asstChat', 'asstAttachmentUrl']) {
    t.ok(new RegExp('\\b' + fn + '\\s*\\(').test(html), fn + ' is wired');
  }

  // No stale references to the removed per-feature FAB / pending-draft apply-discard flow.
  for (const dead of ['composeFab', 'pendingDraft', 'composeApplyPendingDraft', 'composeDiscardPendingDraft']) {
    t.ok(!new RegExp('\\b' + dead + '\\b').test(html), 'no stale reference to ' + dead);
  }
});

// Compose areas resume the last composition of a purpose by default (so users land
// on their last generated draft + its history) and can still start a fresh one.
await t.test('compose: purpose picker resumes latest by default, forceNew starts blank', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/composeLatestForPurpose\s*\(/.test(html), 'composeLatestForPurpose helper exists');
  // composeStart resumes an existing composition unless forceNew is passed.
  t.ok(/async composeStart\(purposeId, opts = \{\}\)/.test(html), 'composeStart takes opts');
  t.ok(/if \(!opts\.forceNew\)/.test(html), 'composeStart resumes unless forceNew');
  t.ok(/composeStart\(p\.id, \{ forceNew: true \}\)/.test(html), 'gallery exposes a fresh-start (forceNew) action');
  // Saving refreshes the version list so the History count stays live.
  t.ok(/async composeSaveDraft\(\)[\s\S]{0,700}composeLoadVersions\(\)/.test(html), 'composeSaveDraft refreshes versions');
});

await t.test('compose: another-composition/newsletter source is wired end-to-end', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const composeJs = readFileSync('compose.js', 'utf8');
  const serverJs = readFileSync('server.js', 'utf8');
  // compose.js: source catalog + default fields.
  t.ok(/id: 'composition'/.test(composeJs), 'compose.js exposes a "composition" source in the catalog');
  t.ok(/composition: false, compositionRef: ''/.test(composeJs), '_defaultSources seeds composition/compositionRef');
  t.ok(/'prRef', 'pursuitRef', 'workitemsRef', 'compositionRef'/.test(composeJs), 'updateComposition clamps compositionRef');
  // server.js: the referenced draft(s) get INLINED as evidence, self-ref guarded.
  t.ok(/src\.composition && String\(src\.compositionRef/.test(serverJs), 'server gates on composition + compositionRef');
  t.ok(/if \(ref === c\.id\) continue;/.test(serverJs), 'server skips self-reference');
  t.ok(/newsletter\.getState\(\)[\s\S]{0,200}draft && st\.draft\.markdown/.test(serverJs), 'server inlines the Newsletter draft for the newsletter sentinel');
  t.ok(/compose\.getComposition\(ref\)/.test(serverJs), 'server resolves other compositions by id');
  // app.html: multi-select picker + persistence wiring.
  t.ok(/composeLoadCompositionRefs\s*\(/.test(html), 'composeLoadCompositionRefs loader exists');
  t.ok(/composeRefToggle\s*\(/.test(html) && /composeRefIsSelected\s*\(/.test(html), 'ref toggle/isSelected helpers exist');
  t.ok(/composition: !!\(c\.sources && c\.sources\.composition\), compositionRef:/.test(html), 'regenerate PATCH payload includes the composition source');
  t.ok(/compose\.current\.sources\.composition/.test(html), 'rail renders the composition picker');
});

await t.test('compose: email subject comes from the draft Subject: line, not the placeholder title', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const serverJs = readFileSync('server.js', 'utf8');
  // Server: split helper + it's used to strip the Subject line and derive the subject.
  t.ok(/function _composeSplitSubjectLine\(/.test(serverJs), '_composeSplitSubjectLine helper exists');
  t.ok(/const split = _composeSplitSubjectLine\(raw\);/.test(serverJs), '_composeBuildEml splits the Subject line');
  t.ok(/const md = split\.subject \? split\.body : raw;/.test(serverJs), 'the Subject line is stripped from the emailed body');
  t.ok(/subject \|\| split\.subject \|\|/.test(serverJs), 'subject falls back to the extracted Subject line');
  // Client: the deliver dialog pre-fills from the draft, not just the title.
  t.ok(/composeEmailSubjectGuess\s*\(/.test(html), 'composeEmailSubjectGuess helper exists');
  t.ok(/co\.deliver\.subject = this\.composeEmailSubjectGuess\(\)/.test(html), 'deliver dialog pre-fills the guessed subject');
});

await t.test('compose: AI drafts auto-title from the generated subject/H1 (recent list is scannable)', () => {
  const composeJs = readFileSync('compose.js', 'utf8');
  t.ok(/function _deriveTitleFromContent\(/.test(composeJs), '_deriveTitleFromContent helper exists');
  // Only overwrites while the title is still an auto placeholder.
  t.ok(/const isPlaceholder = !String\(c\.title \|\| ''\)\.trim\(\) \|\| c\.title === label \|\| c\.title === 'Untitled';/.test(composeJs), 'title is replaced only when it is a placeholder');
  t.ok(/if \(t\) c\.title = t;/.test(composeJs), 'derived title is applied on AI save');
});

// Code Flow: a review worktree must not read as "dirty" from throwaway build/SDK
// droppings (e.g. a dotnet build pinning global.json leaves global.json.bak/.tmp),
// and those droppings must never be swept into the PR commit by commitAll.
await t.test('devitems: throwaway .bak/.tmp/.orig droppings are ignorable (not committable, not dirty)', () => {
  const D = 'devitems.js';
  const prelude = [
    "const path = require('node:path');",
    sliceSource(D, 'const REPORT_EXTS', 'const REPORT_SUBDIRS'),
    sliceSource(D, 'const BUILD_OUTPUT_SEGMENTS', ']);'),
    sliceSource(D, 'const BUILD_DROPPING_EXTS', ']);'),
  ].join('\n');
  const F = extractFns(D, [
    'isIgnorableReportPath', 'isIgnorableAgentArtifact', 'isIgnorableBuildOutput',
    'isIgnorableBuildDropping', 'isIgnorableWorktreePath', 'classifyPorcelain',
  ], { prelude });

  // The dropping extensions are ignorable; real source is not.
  t.ok(F.isIgnorableBuildDropping('global.json.bak'), '.bak dropping is ignorable');
  t.ok(F.isIgnorableBuildDropping('global.json.tmp'), '.tmp dropping is ignorable');
  t.ok(F.isIgnorableBuildDropping('src/Foo/App.cs.orig'), '.orig dropping is ignorable (nested)');
  t.notOk(F.isIgnorableBuildDropping('global.json'), 'global.json itself is NOT a dropping');
  t.notOk(F.isIgnorableBuildDropping('src/Program.cs'), 'real source is not a dropping');
  t.ok(F.isIgnorableWorktreePath('x.bak'), 'isIgnorableWorktreePath folds in droppings');

  // The exact PR-61625 shape: only the tracked global.json edit is committable;
  // the two droppings are filtered out (so Push would commit ONLY global.json).
  const real = F.classifyPorcelain(' M global.json\n?? global.json.bak\n?? global.json.tmp');
  t.deep(real.changed, ['global.json'], 'only the tracked global.json edit is committable');
  t.ok(real.dirty, 'a tracked edit still reads dirty');
  t.eq(real.ignored.length, 2, 'both droppings are classified ignorable');

  // A worktree whose ONLY changes are droppings reads clean.
  const droppingsOnly = F.classifyPorcelain('?? global.json.bak\n?? global.json.tmp');
  t.deep(droppingsOnly.changed, [], 'droppings-only tree has no committable changes');
  t.notOk(droppingsOnly.dirty, 'droppings-only tree is clean');
});

// Code Flow worktree route: the drift "dirty" badge and the "Uncommitted N files"
// row must be computed from a SINGLE change read so they can never contradict each
// other ("Out of sync (uncommitted)" vs "Clean") due to worktree churn between two
// separate reads.
await t.test('codeflow: worktree drift.dirty and changeCount come from one read (consistent)', () => {
  const serverJs = readFileSync('server.js', 'utf8');
  const route = serverJs.slice(serverJs.indexOf("app.get('/api/codeflow/pr/worktree'"), serverJs.indexOf("app.get('/api/codeflow/pr/worktree'") + 4200);
  // branchDir resolved once, up front; a single worktreeChanges read feeds both.
  t.ok(/const branchDir = _cfUsableDir\(rec\) \|\| rec\.worktreePath;[\s\S]{0,400}wc = devitems\.worktreeChanges\(branchDir\)/.test(route), 'branchDir + single worktreeChanges read up front');
  // The persisted/recomputed drift's dirty is reconciled to that single read.
  t.ok(/drift\.dirty = wc\.dirty;/.test(route), 'drift.dirty is reconciled to the single change read');
  t.ok(/extra\.changeCount = \(wc\.changed \|\| \[\]\)\.length;/.test(route), 'changeCount comes from the same read');
  t.ok(/extra\.drift = Object\.assign\(\{\}, rec\.drift, \{[\s\S]{0,120}dirty,/.test(route), 'returned drift dirty is overridden from the same read even when not recomputed');
});

// Code Flow: Boards is NOT a tab in the PR detail — it renders as a "Workspaces.AI"
// clickable row directly below Notes (mirrors the dev card layout). Guards against a
// regression that re-adds it to the tab strip or drops the row.
await t.test('codeflow: PR Boards renders as a Workspaces.AI row below Notes, not a tab', () => {
  // cfSections no longer pushes a 'boards' tab.
  const secs = readFileSync('public/app.html', 'utf8');
  const cfSec = secs.slice(secs.indexOf('cfSections(pr) {'), secs.indexOf('cfSections(pr) {') + 1400);
  t.notOk(/id:\s*'boards'/.test(cfSec), "cfSections does not push a 'boards' tab");
  t.notOk(/x-show="cfActivePane\(pr\) === 'boards'"/.test(secs), "the orphaned 'boards' pane is gone");
  // The PR card body has a Workspaces.AI cf-ws-row wired to the PR board helpers.
  const body = secs.slice(secs.indexOf('<!--CF_PR_CARD_BODY:START-->'), secs.indexOf('<!--CF_PR_CARD_BODY:START-->') + 12000);
  t.ok(/class="cf-ws-row"[\s\S]{0,600}cfPrPinnedBoards\(pr\)/.test(body), 'a cf-ws-row iterates cfPrPinnedBoards(pr)');
  t.ok(/cfPrUnpinFromBoard\(pr, b\)/.test(body), 'the row can unpin a board');
  t.ok(/openQuickPin\('pr'/.test(body), 'the row can pin the PR to a workspace');
});

// Index rows carry the reference number so a PR / dev card is findable by # in the list.
await t.test('codeflow: index rows show the PR # and the dev card work-item #', () => {
  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/dvx-idx-repo"[^>]*x-text="[^"]*'#' \+ pr\.id/.test(html), 'PR index row appends #<id>');
  t.ok(/dvx-idx-repo"[^>]*x-text="[^"]*'#' \+ card\.workItemId/.test(html), 'dev card index row appends #<workItemId>');
});

// Report artifacts carry timestamps and preserved previous versions ("Past reports")
// are numbered with a clean (N) suffix before the extension, per repo.
await t.test('devitems: listReportHistory numbers superseded reports (N) per repo', () => {
  const prelude = [
    "const path = require('node:path');",
    // Stub the on-disk manifest (newest-first, as the real reader returns).
    "function _readHistoryManifest() { return [",
    "  { rel: '__history/pr-review-report-c.html', name: 'pr-review-report.html', ts: 3, kind: 'html' },",
    "  { rel: '__history/pr-review-report-b.html', name: 'pr-review-report.html', ts: 2, kind: 'html' },",
    "  { rel: 'repoA/__history/pr-review-report-a.html', name: 'pr-review-report.html', repoId: 'repoA', ts: 1, kind: 'html' },",
    "  { rel: '__history/no-name-x.md', ts: 0, kind: 'md' },",
    "]; }",
  ].join('\n');
  const F = extractFns('devitems.js', ['listReportHistory'], { prelude });
  const out = F.listReportHistory('board', 'dev');
  t.eq(out.length, 4, 'all manifest rows returned');
  t.eq(out[0].displayName, 'pr-review-report(1).html', 'newest superseded primary is (1)');
  t.eq(out[1].displayName, 'pr-review-report(2).html', 'next-older primary is (2)');
  t.eq(out[2].displayName, 'pr-review-report(1).html', 'a different repo numbers independently');
  t.ok(/^no-name-x\(1\)\.md$/.test(out[3].displayName), 'displayName falls back to basename(rel) when name missing');
  t.eq(out[0].name, 'pr-review-report.html', 'raw name is preserved for callers');
  t.eq(out[0].ts, 3, 'raw ts is preserved for callers');
  // Guards against an empty/missing board or dev id.
  t.deep(F.listReportHistory('', 'dev'), [], 'missing boardId → empty');
  t.deep(F.listReportHistory('board', ''), [], 'missing devId → empty');
});

// The PR + dev artifact panes must show a per-report timestamp on the CURRENT reports
// (not only on the collapsed history), and the dev card must surface a "Past reports"
// disclosure wired to the reactive devHistExpanded store.
await t.test('codeflow: PR + dev artifacts show timestamps and a Past reports disclosure', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // PR: current report rows render cfReportTs; the helper exists.
  t.ok(/<span class="cf-wt-history-ts" x-text="cfReportTs\(r\)"><\/span>/.test(html), 'PR full pane renders a cfReportTs timestamp per report');
  t.ok(/\+ ' · ' \+ cfReportTs\(r\)/.test(html), 'PR mini worktree render appends · <ts>');
  t.ok(/cfReportTs\(r\)\s*\{/.test(html), 'cfReportTs helper is defined');
  // Dev: both artifact panes have a "Past reports" collapsible (2 occurrences).
  const toggles = (html.match(/@click="devToggleHist\(d\)"/g) || []).length;
  t.eq(toggles, 2, 'both dev artifact panes wire a Past reports toggle');
  t.ok(/x-text="\(devHistOpen\(d\) \? '▾ ' : '▸ '\) \+ 'Past reports ' \+ d\.reportHistory\.length"/.test(html), 'toggle label reflects reportHistory length');
  t.ok(/formatRelative\(h\.ts\)/.test(html), 'history rows show a relative timestamp');
  // The disclosure is backed by a declared reactive store (not an ad-hoc field) so
  // Alpine re-renders on toggle.
  t.ok(/devHistExpanded:\s*\{\}/.test(html), 'devHistExpanded reactive store is declared');
  t.ok(/devHistOpen\(d\)\s*\{\s*return[^}]*devHistExpanded\[d\.id\]/.test(html), 'devHistOpen reads the reactive store');
});

// The server must attach reportHistory to dev cards on the GET refresh, the manual
// scan, and the summarizer loop, so the client's d.reportHistory is populated.
await t.test('server: dev routes plumb reportHistory alongside reports', () => {
  const s = readFileSync('server.js', 'utf8');
  t.ok(/partial\.reportHistory = devitems\.listReportHistory\(req\.params\.id, req\.params\.devId\)/.test(s), 'GET refresh attaches reportHistory');
  t.ok(/ctx\.save\(\{ reports, reportHistory \}\)/.test(s), 'manual scan saves reports + reportHistory');
  t.ok(/cR\.save\(\{ reports, reportHistory \}\)/.test(s), 'summarizer loop saves reports + reportHistory on change');
});

// The themed icon engine swaps nav emoji for SVG glyphs when a non-emoji icon set is
// active. Compose.AI's ✍️ must be mapped (to the dedicated "compose" glyph) so it gets
// a themed icon like every other sidebar piece instead of falling back to raw emoji.
await t.test('appearance: Compose.AI ✍️ maps to a themed glyph (no raw-emoji fallback)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // The emoji→role map includes both the FE0F and bare variants → "compose".
  t.ok(/"✍️":\s*"compose"/.test(html), '✍️ (with variation selector) maps to compose');
  t.ok(/"✍":\s*"compose"/.test(html), '✍ (bare) maps to compose');
  // The compose glyph is actually defined in the PATHS library.
  t.ok(/\n\s*compose:\s*'<path/.test(html), 'a compose glyph is defined in the icon PATHS');
  // The Compose.AI nav item still uses ✍️, so the mapping is the one that applies.
  t.ok(/label:\s*'Compose\.AI'[^}]*icon:\s*'✍️'/.test(html), 'Compose.AI nav item uses the ✍️ icon that is now mapped');
});

// ── Pursuit map enhancements (context menu, running-node pulse, node duration,
// export overhaul). Static guards over the shipped SPA markup + methods.

// Feature C — a node shows how long it ran: dedicated CSS, a duration helper, and
// the LOD hover tooltip appends "running <dur>" / "ran <dur>".
await t.test('pursuit map: nodes surface run duration', () => {
  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/\.meai-pnode-dur \{/.test(html), 'a node-duration style exists');
  t.ok(/meAiPursuitNodeDuration\(n\)\s*\{/.test(html) || /meAiPursuitNodeDuration\(n\) \{/.test(html), 'a node-duration helper is defined');
  // DOM card renders the duration span, gated on there being a duration.
  t.ok(/<span class="meai-pnode-dur" x-show="meAiPursuitNodeDuration\(n\)"/.test(html), 'the DOM node card renders a duration span');
  // LOD tooltip appends running/ran duration.
  t.ok(/running ' \+ dur/.test(html) && /ran ' \+ dur/.test(html), 'the LOD tooltip appends running/ran duration');
});

// Feature B — a node doing work pulses (not just the path), and every DOM pulse is
// gated on the "Pulse running work" toggle via a .pu-pulse class on the world.
await t.test('pursuit map: running nodes pulse, gated on the toggle', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // the world carries pu-pulse bound to the lodPulse toggle
  t.ok(/'pu-pulse':\s*meai\.pursuit\.lodPulse !== false/.test(html), '.meai-pworld toggles pu-pulse off lodPulse');
  // both the DOM-card and the LOD-dot running pulses are gated behind it
  t.ok(/\.meai-pworld\.pu-pulse \.meai-pnode\.prun \{ animation:meaiPuNodePulse/.test(html), 'DOM running-node pulse is gated on pu-pulse');
  t.ok(/\.meai-pworld\.lod\.pu-pulse \.meai-pnode\.prun::after \{ animation:meaiPuLodPulse/.test(html), 'LOD running-node pulse is gated on pu-pulse');
});

// Feature A — right-click context menu (zoom / follow / monitor) + a docked monitor
// panel. Plain rows, no pills (per AGENTS.md), wired to real methods.
await t.test('pursuit map: right-click context menu + follow + monitor', () => {
  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/@contextmenu\.prevent="meAiPursuitCtx\(\$event\)"/.test(html), 'the canvas opens a context menu on right-click');
  // the three headline actions dispatch to real methods
  t.ok(/action === 'zoom'.*meAiPursuitZoomToNode\(id\)/.test(html), 'zoom-to-node is wired');
  t.ok(/action === 'follow'.*meAiPursuitFollowNode/.test(html), 'follow-node is wired');
  t.ok(/action === 'monitor'.*meAiPursuitToggleMonitor\(id\)/.test(html), 'monitor toggle is wired');
  // methods are defined
  t.ok(/meAiPursuitZoomToNode\(id\)\s*\{/.test(html), 'zoom method defined');
  t.ok(/meAiPursuitFollowNode\(id\)\s*\{/.test(html), 'follow method defined');
  t.ok(/meAiPursuitToggleMonitor\(id\)\s*\{/.test(html), 'monitor method defined');
  // docked monitor panel, shown only when something is monitored
  t.ok(/<div class="meai-pu-monitor" x-show="\(meai\.pursuit\.monitored\|\|\[\]\)\.length"/.test(html), 'a monitor panel docks when nodes are monitored');
  // monitored set persists across reloads
  t.ok(/localStorage\.setItem\('meai-pu-monitored'/.test(html), 'monitored node set is persisted');
});

// Feature D — export overhaul: the header offers a single-file "Export ↓" (the
// self-contained report page) AND a whole-record "Export as zip ↓" (the bundle
// route). The old single-file "export.zip"/"compendium.zip" wiring is gone.
await t.test('pursuit map: Export (single file) + Export as zip (bundle)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // single-file export → the /view page, saved via download attr, named off the report
  t.ok(/\/view'" :download="meAiPursuitExportName\(meAiPursuitReport\(\)\)"[^>]*>Export ↓<\/a>/.test(html), 'report view offers a single-file "Export ↓"');
  t.ok(/\/view'" :download="meAiPursuitExportName\(meai\.pursuit\.artView\)"[^>]*>Export ↓<\/a>/.test(html), 'artifact view offers a single-file "Export ↓"');
  // whole-record bundle → the bundle.zip route
  const bundleLinks = (html.match(/\+ '\/export\/bundle\.zip'" :download="'pursuit-bundle\.zip'"[^>]*>Export as zip ↓<\/a>/g) || []).length;
  t.eq(bundleLinks, 2, 'both report + artifact views link the whole-record bundle.zip');
  // the export-name helper is defined
  t.ok(/meAiPursuitExportName\(a\)\s*\{/.test(html), 'the export-filename helper is defined');
  // no stale single-file zip wiring survives
  t.ok(!/\/export\.zip'/.test(html), 'the old per-report export.zip link is gone');
  t.ok(!/compendium\.zip/.test(html), 'the old compendium.zip download name is gone');
});

// Feature — Pulse.AI Teams cache: the monitor picker is stale-while-revalidate.
// The GET routes serve the disk cache INSTANTLY (never await the multi-minute WorkIQ
// collector) and report a `refreshing` flag the client polls on; the mode toggle
// preserves specific-channel picks via an explicit `allMode` boolean instead of
// nulling `channels` (which lost the selection).
function _win(src, marker, chars) {
  const i = src.indexOf(marker);
  return i < 0 ? '' : src.slice(i, i + chars);
}
await t.test('pulse monitor: stale-while-revalidate teams cache (server routes)', () => {
  const src = readFileSync('server.js', 'utf8');
  // routes must NOT block on the gather (collector) fns
  const teamsRoute = _win(src, "app.get('/api/me-ai/pulse/teams',", 1200);
  t.ok(teamsRoute, 'teams route found');
  t.ok(!/await\s+_pulseGatherTeams/.test(teamsRoute), 'teams GET no longer awaits the blocking collector');
  t.ok(/_pulseKickTeamsRefresh\(\)/.test(teamsRoute), 'teams GET kicks a background refresh');
  t.ok(/refreshing:\s*_pulseTeamsRefreshing/.test(teamsRoute), 'teams GET reports the refreshing flag');
  t.ok(/stale/.test(teamsRoute), 'teams GET reports staleness');
  const chanRoute = _win(src, "app.get('/api/me-ai/pulse/teams/:id/channels',", 1400);
  t.ok(chanRoute, 'channels route found');
  t.ok(!/await\s+_pulseGatherChannels/.test(chanRoute), 'channels GET no longer awaits the blocking collector');
  t.ok(/_pulseKickChannelsRefresh\(teamId\)/.test(chanRoute), 'channels GET kicks a background channel refresh');
  t.ok(/refreshing:\s*_pulseChannelsRefreshing\.has\(teamId\)/.test(chanRoute), 'channels GET reports per-team refreshing');
  // the SWR helpers exist
  t.ok(/_pulseKickTeamsRefresh\s*\(/.test(src), 'teams background-refresh kicker defined');
  t.ok(/_pulseKickChannelsRefresh\s*\(/.test(src), 'channels background-refresh kicker defined');
});

await t.test('pulse monitor: mode toggle preserves selection + client polls (app.html)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // All-channels mode is an explicit boolean; switching to "all" must NOT drop channels
  const setMode = _win(html, 'pulseSetTeamMode(t, mode) {', 600);
  t.ok(setMode, 'pulseSetTeamMode found');
  t.ok(/s\.allMode\s*=\s*true/.test(setMode), "switching to 'all' sets allMode without wiping channels");
  t.ok(!/s\.channels\s*=\s*null/.test(setMode), "switching to 'all' no longer nulls the channel picks");
  // state carries the poll timers + seed guard
  t.ok(/refreshing:\s*false/.test(html) && /_selSeeded:\s*false/.test(html), 'monitor state has refreshing + seed guard');
  t.ok(/chanRefreshing:\s*\{\}/.test(html), 'monitor state tracks per-team channel refreshing');
  // teams loader only cold-loads + seeds once + polls while refreshing
  const loadTeams = _win(html, 'async pulseLoadTeams(refresh) {', 2400);
  t.ok(loadTeams, 'pulseLoadTeams found');
  t.ok(/if\s*\(!m\.teams\.length\)\s*m\.loading\s*=\s*true/.test(loadTeams), 'blocking loader only when nothing cached');
  t.ok(/m\._selSeeded/.test(loadTeams), 'selection seeded once so a re-poll cannot clobber edits');
  t.ok(/setTimeout\(\(\)\s*=>\s*this\.pulseLoadTeams/.test(loadTeams), 'polls again while refreshing');
  // channels loader no longer permanently caches an empty list
  const loadCh = _win(html, 'async pulseLoadChannels(teamId, teamName) {', 900);
  t.ok(loadCh, 'pulseLoadChannels found');
  t.ok(!/if\s*\(m\.channels\[teamId\]\s*\|\|\s*m\.chanLoading\[teamId\]\)\s*return/.test(loadCh), 'channel loader no longer short-circuits on a cached empty array');
  // refreshing indicators in the modal
  t.ok(/pmd-refreshing/.test(html), 'a refreshing indicator is surfaced in the picker');
});

await t.test('pulse monitor chip: Teams-specific label + channel count + activity dot', () => {
  const src = readFileSync('server.js', 'utf8');
  // server exposes a richer summary (teams, channels, active teams) on the monitoring GET
  t.ok(/function\s+_pulseMonitorSummary\s*\(/.test(src), 'monitor summary helper defined');
  t.ok(/summary:\s*_pulseMonitorSummary\(\)/.test(src), 'monitoring route returns the summary');
  const sum = _win(src, 'function _pulseMonitorSummary', 1400);
  t.ok(/activeTeams/.test(sum) && /channels/.test(sum), 'summary carries channel count + active teams');
  const html = readFileSync('public/app.html', 'utf8');
  // chip is clearly Teams-specific, shows the compact meta, and a live-activity dot
  t.ok(/Monitor Teams/.test(html) && /Monitoring Teams/.test(html), 'chip labels the monitoring as Teams-specific');
  t.ok(/pulseMonitorChipText\(\)/.test(html), 'chip renders the compact team/channel meta');
  t.ok(/pmb-live/.test(html) && /pulseMonitorActiveCount\(\)/.test(html), 'chip surfaces a recent-activity indicator');
  const chip = _win(html, 'pulseMonitorChipText() {', 500);
  t.ok(/channel/.test(chip), 'chip text names channels');
});

await t.test('compose prototype: interactive scenario (site format lock, sandbox, repos source, share)', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  // repos source in the catalog + defaults + clamp
  t.ok(/id:\s*'repos'/.test(cjs), 'compose.js SOURCES catalog has a repos source');
  const defs = _win(cjs, '_defaultSources', 600);
  t.ok(/repos:\s*false/.test(defs) && /reposRef:\s*''/.test(defs), '_defaultSources seeds repos + reposRef');
  t.ok(/'reposRef'/.test(cjs), 'updateComposition clamps reposRef');

  const src = readFileSync('server.js', 'utf8');
  // writer prompt: interactive prototype (JS allowed), repos ref branch
  const ctx = _win(src, '_composeSourceContext', 3000);
  t.ok(/reposRef/.test(ctx), '_composeSourceContext reads a repos ref');
  const gen = _win(src, 'Prototype requirements', 1200);
  t.ok(gen, 'generate prompt has a prototype-requirements block');
  t.ok(/simulate/i.test(gen), 'prototype prompt asks it to simulate real activity');
  t.ok(/in-page|in-frame|inside the (doc|prototype)/i.test(gen), 'prototype prompt keeps navigation in-page');

  const html = readFileSync('public/app.html', 'utf8');
  // format lock: prototype offers only 'site'; other purposes hide 'site'
  const fc = _win(html, 'composeFormatChoices() {', 400);
  t.ok(fc, 'composeFormatChoices helper defined');
  t.ok(/prototype/.test(fc) && /f\.id === 'site'/.test(fc), 'prototype → only the site format');
  t.ok(/composeFormatChoices\(\)\.length/.test(html), 'format field switches on the choice count');
  // sandbox: scripts run but the frame is opaque-origin (cannot escape to the app)
  t.ok(/sandbox="allow-scripts"/.test(html), 'prototype iframe enables scripts (opaque origin, no same-origin)');
  t.ok(!/sandbox="allow-scripts allow-same-origin"/.test(html), 'prototype iframe never combines scripts with same-origin');
  // prototype share actions: Open (blob preview) + Download, no Copy/JSON for site
  t.ok(/composePreviewSite\(\)/.test(html), 'prototype has an Open full-window preview action');
  const prev = _win(html, 'composePreviewSite() {', 700);
  t.ok(/createObjectURL/.test(prev), 'preview uses a blob URL (standalone opaque origin)');
  // repos ref input in the rail
  t.ok(/sources\.reposRef/.test(html), 'sources rail binds a repos ref input');
});

await t.test('director clash: high-level area summary + option comparison', () => {
  const src = readFileSync('server.js', 'utf8');
  // AI prompt asks for a clashSummary (area + compare) on clash stops
  t.ok(/clashSummary/.test(src), 'reason prompt requests a clashSummary');
  const prompt = _win(src, 'CLASH SUMMARY', 700);
  t.ok(/area/.test(prompt) && /compare/.test(prompt), 'clashSummary framing names area + compare');
  // verdict normalization keeps clashSummary
  t.ok(/clashSummary:\s*\(v\.clashSummary/.test(src), 'verdict normalizer carries clashSummary');

  const djs = readFileSync('director.js', 'utf8');
  // deskNode carries the AI summary; grouped clash item builds a summary with a fallback
  t.ok(/aiClashSummary/.test(djs), 'deskNode carries aiClashSummary');
  const grp = _win(djs, 'const areaText', 700);
  t.ok(/areaText/.test(grp) && /compareText/.test(grp), 'clash item synthesizes area + compare (with fallback)');
  t.ok(/aiAuthored/.test(djs), 'summary flags whether it is AI-authored vs synthesized');
  t.ok(/directorRationale: rationale, summary/.test(djs), 'grouped clash item exposes summary');

  const html = readFileSync('public/app.html', 'utf8');
  // clash pane renders the framing block above the two sides
  t.ok(/meai-dir-summary/.test(html), 'clash pane has a summary block');
  t.ok(/What this is about/.test(html), 'summary block is labelled');
  t.ok(/summary\.area/.test(html) && /summary\.compare/.test(html), 'summary renders area + comparison');
  t.ok(/summary\.aiAuthored/.test(html), 'summary notes when it is synthesized, not AI-authored');
  t.ok(/\.meai-dir-summary\s*\{/.test(html), 'summary block has CSS');
});

await t.test('pursuit follow-up anchors on the main spine trunk (not a sub-agent)', () => {
  const src = readFileSync('server.js', 'utf8');
  // A tree-aware resolver exists and never returns a branch/scout sub-agent.
  t.ok(/function _meAiSpineAnchor\(/.test(src), 'spine-anchor resolver exists');
  const rez = _win(src, 'function _meAiSpineAnchor', 900);
  t.ok(/lane === 'spine'/.test(rez), 'resolver only considers spine-lane legs (no sub-agents)');
  t.ok(/order\.length - 1; i >= 0; i--/.test(rez), 'resolver walks to the LAST spine node (trunk tip)');
  // reAct (steer follow-up) repairs the pointer from the folded tree before parenting.
  const react = _win(src, 'function _meAiTreeReAct', 1400);
  t.ok(/const anchor = _meAiSpineAnchor\(t, tree\)/.test(react), 'reAct resolves the spine anchor');
  t.ok(/if \(anchor\) t\._spineId = anchor/.test(react), 'reAct repairs t._spineId before spawning the you node');
  // converse (chat comment) does the same, so a comment continues the primary effort.
  const conv = _win(src, 'function _meAiTreeConverse', 2200);
  t.ok(/const prevSpine = _meAiSpineAnchor\(t, ctree\)/.test(conv), 'converse resolves the spine anchor');
  t.ok(/if \(prevSpine\) t\._spineId = prevSpine/.test(conv), 'converse repairs t._spineId before spawning the you node');
});

await t.test('pursuit header exposes always-available compendium + bundle export (outside the report pane)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // The always-available action group lives in the pursuit header (meai-pu-top), gated on a tid.
  const hdr = _win(src, 'class="meai-pu-hdract"', 1400);
  t.ok(/x-show="meai\.pursuit\.tid"/.test(hdr), 'header action group is gated on an open pursuit');
  // Build/Rebuild the compendium from the header — label flips on whether a report exists.
  t.ok(/meAiPursuitBuildCompendium\(\)/.test(hdr), 'header wires the compendium build action');
  t.ok(/meAiPursuitReport\(\) \? 'Rebuild compendium' : 'Build compendium'/.test(hdr), 'label flips Build vs Rebuild');
  t.ok(/:disabled="meai\.pursuit\.compendiumBusy"/.test(hdr), 'build button is gated while compiling');
  // Full-record .zip bundle is reachable from the header too (whole record without opening the report).
  t.ok(/\/export\/bundle\.zip/.test(hdr), 'header exposes the navigable .zip bundle export');
  t.ok(/Export bundle/.test(hdr), 'bundle export is labelled');
  // A quiet jump to the compiled report when one already exists.
  t.ok(/meAiPursuitShowReport\(\)/.test(hdr), 'header offers a jump to the report when present');
  // No pills — the group uses the existing calm link/button styling.
  t.ok(/\.meai-pu-hdract \{/.test(src), 'header action group has calm layout CSS');
});

await t.test('compose prototype preview auto-sizes to content (no arbitrary vertical constraint)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // The site iframe reports its content height and the parent sizes it — so the prototype
  // flows into the single page scroll instead of a fixed-height box with an inner scrollbar.
  t.ok(/x-ref="composeSite"/.test(src), 'site iframe is ref-addressable for height sync');
  t.ok(/:srcdoc="composeSiteSrcdoc\(\)"/.test(src), 'iframe renders the height-reporter srcdoc, not raw draftText');
  t.ok(/x-init="composeSiteHeightListen\(\)"/.test(src), 'iframe registers the parent height listener');
  t.ok(/composeSiteSrcdoc\(\)\s*\{/.test(src), 'composeSiteSrcdoc method exists');
  t.ok(/__composeHeight/.test(src), 'reporter posts a content-height message the parent consumes');
  t.ok(/f\.style\.height = Math\.max\(360/.test(src), 'parent sets the iframe height from the reported content height');
  // The arbitrary 520px lock + inert flex are gone; a modest floor + block growth remain.
  t.ok(/\.cmpx-site\{min-height:360px;[^}]*display:block\}/.test(src), 'cmpx-site drops the 520px lock for a growable block');
  t.ok(!/\.cmpx-site\{flex:1;min-height:520px/.test(src), 'no stale fixed-height site rule');
});

await t.test('compose repositories source uses an org/project picker (not a fragile free-text box)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // The Sources rail repos field auto-loads a real repo list on enable.
  t.ok(/compose\.current\.sources\.repos && composeLoadRepos\(\)/.test(src), 'repos source primes the picker when enabled');
  // Picker rows come from the loaded list, filtered by a search box, and toggle selection.
  t.ok(/composeRepoFiltered\(\)/.test(src), 'repos render from the filtered picker list');
  t.ok(/composeRepoToggle\(compose\.current\.sources, rp, true\)/.test(src), 'a repo row toggles selection');
  t.ok(/composeRepoIsSelected\(compose\.current\.sources, rp\.ref\)/.test(src), 'selected repos are checkmarked');
  // Storage stays backward-compatible: chosen refs join into sources.reposRef.
  t.ok(/sources\.reposRef = refs\.join\(', '\)/.test(src), 'selection persists as the comma-joined reposRef the server already parses');
  // Loader hits the new sources/repos endpoint and toggling the source primes it.
  t.ok(/\/api\/compose\/sources\/repos/.test(src), 'loader calls the sources/repos endpoint');
  t.ok(/else if \(s\.id === 'repos'\) this\.composeLoadRepos\(\)/.test(src), 'enabling the repos source loads the list');
  // A manual fallback textarea only appears when the org/project list is empty.
  t.ok(/x-show="!compose\.pickers\.reposLoading && !compose\.pickers\.repos\.length && compose\.pickers\.reposLoaded"[^>]*>[^<]*<label[^>]*>Or specify manually/.test(src.replace(/\n/g, ' ')) || /Or specify manually/.test(src), 'manual entry remains as a fallback when no repos are discovered');
  // Server endpoint lists repos from the configured default org/project(s).
  const server = readFileSync('server.js', 'utf8');
  t.ok(/app\.get\('\/api\/compose\/sources\/repos'/.test(server), 'server exposes GET /api/compose/sources/repos');
  t.ok(/_connectAdoTargets\(settings\.getSettings\(\)\)[\s\S]{0,600}azdo\.listRepos\(org, project\)/.test(server), 'endpoint lists repos across the configured ADO targets');
  t.ok(/ref: `\$\{org\}\/\$\{project\}\/\$\{r\.name\}`/.test(server), 'each repo carries an org/project/name ref');
});

await t.test('Monitor Teams pre-loads cached channels + shows currently-monitored channels', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // On open, after seeding the saved selection, warm the channel cache for monitored teams.
  t.ok(/m\._selSeeded = true;[\s\S]{0,600}this\._pulseWarmMonitoredChannels\(\)/.test(src), 'seed warms monitored-team channels on open');
  // The warmer expands each specific-scoped monitored team and loads its (cached) channels.
  t.ok(/_pulseWarmMonitoredChannels\(\)\s*\{/.test(src), '_pulseWarmMonitoredChannels helper exists');
  t.ok(/m\.expanded\[teamId\] = true;\s*\n\s*this\.pulseLoadChannels\(teamId, s\.teamName\)/.test(src), 'warmer expands + loads cached channels');
  // A human list of the monitored channels is surfaced inline (no expand needed).
  t.ok(/pulseTeamSelectedNames\(teamId\)\s*\{/.test(src), 'pulseTeamSelectedNames helper exists');
  t.ok(/pmd-team-chansel/.test(src), 'inline monitored-channels row is rendered');
  t.ok(/x-text="pulseTeamSelectedNames\(t\.id\)"/.test(src), 'inline row shows the monitored channel names');
  t.ok(/\.pmd-team-chansel \{/.test(src), 'inline row has calm muted CSS');
});

await t.test('Pulse.AI Reel — forward/back nav, tap-to-fullscreen, copy-in-fullscreen, doom-scroll order', () => {
  const src = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  // Reel panel now has BOTH a previous and a next nav button (was previous-only).
  t.ok(/pc-reel-nav prev"[^>]*pulseReelStep\(-1\)/.test(src), 'reel has a previous nav button');
  t.ok(/pc-reel-nav next"[^>]*pulseReelStep\(1\)/.test(src), 'reel has a forward nav button');
  // Tapping the reel image opens the fullscreen lightbox (not advance-in-place).
  t.ok(/pc-s-media clickable"\s*@click="pulseReelOpenFull\(it, i\)"/.test(src), 'reel image click opens fullscreen');
  // Fullscreen lightbox can copy the image + open the original.
  t.ok(/pulseReelCopyFull\(\)/.test(src), 'lightbox wires a copy-image action');
  t.ok(/async pulseReelCopyFull\(\)\s*\{/.test(src), 'pulseReelCopyFull method exists');
  t.ok(/_pulseRasterize\(/.test(src), 'copy rasterizes svg/non-png to a png blob');
  t.ok(/new window\.ClipboardItem\(\{ 'image\/png': blob \}\)/.test(src), 'copy writes an image ClipboardItem');
  t.ok(/_reelCopied:\s*false/.test(src), '_reelCopied state exists');
  // Server reel order: today first, then RANDOM older art (doom-scroll).
  t.ok(/const today = items\.filter\(isToday\)\.sort/.test(srv), 'server puts today\'s art first');
  t.ok(/const older = items\.filter\(x => !isToday\(x\)\);[\s\S]{0,200}Math\.random\(\)/.test(srv), 'older art is shuffled randomly');
  // Email share accepts data: image URIs and never drops the joke caption.
  t.ok(/\/\^\(https\?:\|data:image\\\/\)\/i\.test\(url\)/.test(srv), 'email image renderer accepts data: URIs');
  t.ok(/No renderable image — keep the caption/.test(srv), 'email keeps the caption when no image renders');
});

await t.test('Me-agent view is its own page (agenda hidden), not an overlay flashed over the agenda', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // A dedicated agentPage flag exists in the meai state.
  t.ok(/agentPage:\s*false,/.test(src), 'meai.agentPage state flag exists');
  // The agenda body is hidden when an agent page is active.
  t.ok(/class="meai-wrap"\s+x-show="!meai\.agentPage"/.test(src), 'agenda body (.meai-wrap) hides when agentPage');
  // A calm "opening" placeholder covers the load window before the surface opens.
  t.ok(/meai\.agentPage && !meai\.console && !meai\.pursuit\.open/.test(src), 'agent-page loading placeholder gated correctly');
  t.ok(/meai-agentpage-load/.test(src) && /Opening agent…/.test(src), 'placeholder markup + copy present');
  t.ok(/meAiAgentPageLeave\(\)/.test(src), 'placeholder Back wires meAiAgentPageLeave');
  // Both open paths set agentPage; both close paths clear it.
  t.ok(/p\.open = true; p\.tid = id; p\.follow = true;[\s\S]{0,200}this\.meai\.agentPage = true;/.test(src), 'meAiPursuitOpen sets agentPage');
  t.ok(/console drawer is this single-thread agent's own page[\s\S]{0,200}this\.meai\.agentPage = true;/.test(src), 'console-drawer open sets agentPage');
  t.ok(/p\.open = false; p\.artView = null;\s*this\.meai\.agentPage = false;/.test(src), 'meAiPursuitClose clears agentPage');
  // Router seeds agentPage from the deep-link param up front (no agenda flash).
  t.ok(/this\.meai\.agentPage = !!monId;\s*await this\.loadMeAi\(\);/.test(src), 'router sets agentPage before loading the agenda');
});

await t.test('Director diagnosis explains zero automated handling + zero redundant paths', () => {
  const director = require('../director.js');
  const S = (o) => Object.assign({ status: 'open' }, o);
  const tree = { id: 'p1', stops: [
    S({ id: 's1', type: 'needs-auth', action: { risk: 'write', op: 'edit-file', target: 'src/a.cs', summary: 'edit a' } }),
    S({ id: 's2', type: 'needs-auth', action: { risk: 'write', op: 'edit-file', target: 'src/a.cs', summary: 'edit a' } }),
    S({ id: 's3', type: 'needs-auth', action: { risk: 'write', op: 'push', target: 'origin/main', summary: 'push' } }),
    S({ id: 's4', type: 'needs-decision', conflictId: 'c1' }),
    S({ id: 's5', type: 'needs-info' }),
  ], conflicts: [{ id: 'c1', subject: 'x', a: { stance: 'affirm' }, b: { stance: 'deny' } }] };

  // Director OFF (default): whyZero names the off state; redundancy note explains the AI-pass gating.
  const off = director.planReduction(tree, { enabled: false });
  t.ok(off.diagnosis && typeof off.diagnosis === 'object', 'reduction carries a diagnosis object');
  t.ok(/handling is off/i.test(off.diagnosis.whyZero || (off.handledCount ? 'n/a' : '')) || off.handledCount > 0, 'off-state whyZero or something handled');
  // Buckets reconcile: desk stops are all accounted by reason.
  const dw = off.diagnosis.deskWhy;
  const bucketSum = dw.external + dw.judgement + dw.missingInfo + dw.heldForGrant + dw.lowConfidence + dw.pausedOffline + dw.deliverable + dw.other;
  t.ok(bucketSum === off.reconciliation.deskStops, 'deskWhy buckets sum to desk-stop count');
  t.ok(dw.external >= 1 && dw.judgement >= 1 && dw.missingInfo >= 1, 'push=external, clash=judgement, needs-info bucketed');
  t.ok(typeof off.diagnosis.duplicatesFound === 'number' && typeof off.diagnosis.redundancyCount === 'number', 'redundancy counts present');

  // Enabled but no AI verdicts yet (not-leader / pass not run) → whyZero explains pending judging.
  const pend = director.planReduction(tree, { enabled: true, grant: { id: 'g', paths: ['src'], classes: ['duplicate', 'reversible-local', 'factual-clash'], ops: ['cull', 'absorb', 'resolve'], expiresAt: Date.now() + 1e7 } });
  if (pend.handledCount === 0) t.ok(/not finished judging|absorbable|granted paths/i.test(pend.diagnosis.whyZero || ''), 'enabled zero-handled whyZero is honest');

  // UI surfaces the diagnosis with calm helpers (no pills).
  const src = readFileSync('public/app.html', 'utf8');
  t.ok(/meAiDirectorDiagnosis\(\)/.test(src) && /meAiDirectorWhyZero\(\)/.test(src) && /meAiDirectorRedundancyNote\(\)/.test(src), 'diagnosis helpers wired');
  t.ok(/class="meai-dir-why"/.test(src) && /Why the Director handled so little/.test(src), 'why block rendered');
  t.ok(/\.meai-dir-why\s*\{/.test(src), 'why block CSS present');
});

await t.done();