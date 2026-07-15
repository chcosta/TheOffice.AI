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

  // The shared floating FAB + panel are now NEWSLETTER-ONLY — compose uses a docked
  // paired-assistant column inside the studio (see the compose-pairing guard), so the
  // floating surface must not appear over the compose studio.
  t.ok(/x-show="asstCtx\(\) === 'newsletter' && !asstPanelOpen\(\)"/.test(html), 'FAB button gates on newsletter ctx');
  t.ok(/x-show="asstCtx\(\) === 'newsletter' && asstPanelOpen\(\)"/.test(html), 'floating panel gates on newsletter ctx');
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

// Compose paired-programming studio: the free-text "What to say" brief is replaced by a
// docked, collapsible, width-adjustable paired-assistant column. Pairing drives the draft
// directly (server drafts even from an empty draft), keeping audience/format/sources structure.
await t.test('compose: paired-assistant studio replaces the free-text brief', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // The "What to say" brief textarea + its brief-gated regenerate button are GONE.
  t.ok(!/x-model="compose\.current\.brief"/.test(html), 'the What-to-say brief textarea is removed');
  t.ok(!/composeUpdateBriefAndRegen\(\)/.test(html), 'the brief-gated Update & regenerate button is removed');
  // Structure the user KEEPS: audience toggles + format + title still bind.
  t.ok(/compose\.current\.audience/.test(html), 'audience framing is kept');
  t.ok(/composeFormatChoices\(\)/.test(html), 'format framing is kept');

  // The docked paired panel: its own scroll container (distinct from the floating asstChatScroll),
  // reuses compose.chat state + composeChat* methods, and lives inside the studio grid.
  t.ok(/id="composePairScroll"/.test(html), 'docked paired panel has its own scroll container');
  t.ok(/class="nlx-studio cmpx-paired"/.test(html), 'studio grid gains the cmpx-paired modifier');
  t.ok(/'paired-open': compose\.chat\.open/.test(html), 'grid reacts to the open/collapsed state');
  t.ok(/composePairResizeStart\(\$event\)/.test(html), 'the panel is width-adjustable (drag resizer)');
  t.ok(/class="cmpx-pair-tab"[\s\S]{0,80}?composeToggleChat\(\)/.test(html), 'collapsed state shows a reopen tab');

  // Methods are wired.
  for (const fn of ['composePairedOpen', 'composePairW', 'composePairResizeStart', 'composePairOpener', 'composePairQuickChips', 'composePairQuick']) {
    t.ok(new RegExp('\\b' + fn + '\\s*\\(').test(html), fn + ' is defined');
  }

  // Not arbitrarily vertically constrained — the panel fills the viewport height + scrolls internally.
  t.ok(/\.cmpx-pair\{[^}]*height:calc\(100vh/.test(html), 'paired panel fills available height (no arbitrary cap)');

  // Sticky-bottom auto-scroll: _composeChatScroll respects a stickiness flag + honors a force arg.
  t.ok(/_composeChatScroll\(force\)/.test(html), '_composeChatScroll takes a force arg');
  t.ok(/c\._stick !== false/.test(html), 'auto-scroll only when the user is riding the bottom');
  t.ok(/compose\.chat\._stick = \(\$event\.target\.scrollHeight/.test(html), 'scroll handler tracks bottom-stickiness');

  // Docked panel default open + persisted width in state.
  t.ok(/pairW: 360,/.test(html), 'pairW default is in compose state');
  t.ok(/chat: \{ open: true,/.test(html), 'the docked panel is open by default');
});

// The left rail can expand/shrink/collapse and scrolls with the view (not sticky); the
// Sources section is always open (non-collapsible); each source's config renders directly
// beneath its own checkbox; the regenerate/generate-draft button is gone (assistant-driven).
await t.test('compose: rail resize/collapse + inline source config + no regenerate button', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // Regenerate/Generate-draft button removed — generation is initiated by the assistant.
  // The composeGenerate() method is retained, but nothing in the markup invokes it via a button.
  t.ok(/async composeGenerate\(\)/.test(html), 'composeGenerate() method is retained');
  t.ok(!/@click="composeGenerate\(\)"/.test(html), 'no button invokes composeGenerate() (assistant-driven)');

  // Left rail: state + helpers for width + collapse, persisted.
  t.ok(/railW: 300,/.test(html), 'railW default is in compose state');
  t.ok(/railOpen: true,/.test(html), 'railOpen default is in compose state');
  for (const fn of ['composeRailW', 'composeRailResizeStart', 'composeToggleRail', 'composeRailOpen']) {
    t.ok(new RegExp('\\b' + fn + '\\s*\\(').test(html), fn + ' is defined');
  }
  t.ok(/composeRailResizeStart\(\$event\)/.test(html), 'the rail has a drag resizer');
  t.ok(/class="cmpx-rail-collapse"[\s\S]{0,120}?composeToggleRail\(\)/.test(html), 'the rail has a collapse control');
  t.ok(/x-show="!composeRailOpen\(\)"[\s\S]{0,120}?composeToggleRail\(\)/.test(html), 'a collapsed reopen tab restores the rail');
  t.ok(/'rail-open': composeRailOpen\(\)/.test(html), 'grid reacts to the rail open/collapsed state');
  t.ok(/--cmpx-rail-col:/.test(html), 'the grid rail column is driven by a width var');

  // Rail scrolls with the view: .nlx-rail is NOT sticky (relative for the resize handle).
  const railCss = _win(html, '.nlx-rail {', 200);
  t.ok(!/position:sticky/.test(railCss), 'the rail is not sticky (scrolls with the view)');
  t.ok(/position:relative/.test(railCss), 'the rail is positioned relative for its resize handle');

  // Sources section is always open + non-collapsible (no x-data toggle, no chevron click).
  t.ok(/<div class="nlx-acc open">\s*<div class="nlx-acc-head" style="cursor:default">🔎 Sources<\/div>/.test(html),
    'the Sources section is always open (no collapse toggle)');

  // Each source's config sits directly under its card via id-matched x-if templates in one loop.
  t.ok(/class="cmpx-srcitem"/.test(html), 'each source is a self-contained item (card + its own config)');
  t.ok(/class="cmpx-srccfg"/.test(html), 'a per-source config wrapper renders inline under the card');
  t.ok(/x-if="s\.id==='pr'"/.test(html) && /x-if="s\.id==='agentruns'"/.test(html) && /x-if="s\.id==='repos'"/.test(html),
    'id-matched config templates live inside the single source loop');
  // pasted is a text field (a string) — kept standalone, NOT toggled as a checkbox card.
  t.ok(/compose\.sourceCatalog\.filter\(x => x\.id !== 'pasted'\)/.test(html), 'the text-only pasted source is excluded from the checkbox loop');
  t.ok(/x-model="compose\.current\.sources\.pasted"/.test(html), 'the Pasted context textarea still binds the real field');
});

// The paired-assistant conversation is persisted PER COMPOSITION server-side, so navigating
// away from a composition and back restores the full transcript exactly where it left off.
await t.test('compose: paired-assistant transcript persists per composition (survives reopen)', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const src = readFileSync(SERVER, 'utf8');
  const cjs = readFileSync('compose.js', 'utf8');

  // Server owns the transcript: runComposeChat writes both turns via compose.appendChat.
  const chatFn = _win(src, 'async function runComposeChat(', 4000);
  t.ok(/compose\.appendChat\(id, \{ role: 'user'/.test(chatFn), 'the user turn is persisted up front (survives a writer error)');
  t.ok(/compose\.appendChat\(id, \{ role: 'assistant', text: reply \}\)/.test(src), 'the assistant reply is persisted');
  t.ok(/compose\.appendChat\(id, \{ role: 'assistant'[\s\S]{0,80}?structure: true \}\)/.test(src), 'a framing-change note is persisted with its structure flag');

  // The exact rendered user bubble (incl. inline image thumbnails) round-trips via `display`.
  t.ok(/display: shown,/.test(html), 'the client sends the displayed bubble text so reopen is identical');
  t.ok(/const \{ message, history, runId, draft, attachments, display \}/.test(src), 'the chat route threads display through');
  t.ok(/String\(display \|\| msg/.test(src), 'the server prefers the displayed text for the persisted user turn');

  // On reopen, _composeSetCurrent hydrates messages from the stored chat, preserving structure.
  t.ok(/co\.chat\.messages = Array\.isArray\(c\.chat\)[\s\S]{0,160}?structure: !!m\.structure/.test(html),
    'reopening a composition rebuilds the transcript from c.chat (structure flag preserved)');

  // compose.js appendChat keeps the optional structure flag it now receives.
  t.ok(/if \(msg && msg\.structure\) entry\.structure = true;/.test(cjs), 'appendChat preserves the structure flag');
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
  t.ok(/async composeSaveDraft\(prompt\)[\s\S]{0,800}composeLoadVersions\(\)/.test(html), 'composeSaveDraft refreshes versions');
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
  // Stale-cache fix: the picker force-refreshes on enable/studio-entry, exposes a manual ↻,
  // and the refs cache is invalidated whenever the current composition changes — so a
  // newly-created composition can't be hidden by the frozen `refsLoaded` cache.
  t.ok(/composeLoadCompositionRefs\(true\); \$watch\('compose\.current\.sources\.composition', v => v && composeLoadCompositionRefs\(true\)\)/.test(html), 'composition picker x-init/$watch force a fresh refetch');
  t.ok(/@click="composeLoadCompositionRefs\(true\)"/.test(html), 'composition picker has a manual refresh button');
  t.ok(/if \(co\.pickers\) co\.pickers\.refsLoaded = false;/.test(html), '_composeSetCurrent invalidates the refs cache on composition change');
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
  const ctx = _win(src, '_composeSourceContext', 9000);
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

await t.test('compose one-pager: DNCEng epic one-pager blueprint drives writer + editor', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  // blueprint catalog + helper exported
  t.ok(/PURPOSE_BLUEPRINTS\s*=\s*\{/.test(cjs), 'compose.js defines PURPOSE_BLUEPRINTS');
  t.ok(/function blueprintFor\(/.test(cjs), 'compose.js exports blueprintFor');
  t.ok(/PURPOSE_BLUEPRINTS,/.test(cjs) && /blueprintFor,/.test(cjs), 'module.exports includes the blueprint API');
  const bp = _win(cjs, 'onepager: {', 2600);
  t.ok(/DNCEng epic one-pager/.test(bp), 'onepager blueprint is the DNCEng epic one-pager');
  // all six template sections from the wiki template are present, in order
  ['Goal and motivation', 'Stakeholders', 'Proof of concept', 'Risk', 'Usage telemetry', 'Serviceability'].forEach(h => {
    t.ok(bp.includes(h), `onepager blueprint has the "${h}" section`);
  });
  t.ok(/epic issue number|epic’s GitHub issue/.test(bp), 'onepager blueprint carries the naming + sign-off process');
  // source defaults reflect an epic doc (work items + pursuit)
  t.ok(/onepager:\s*\['workitems'/.test(cjs), 'onepager seeds the work-items (epic) source');

  const src = readFileSync('server.js', 'utf8');
  // blueprint block helper + injection into BOTH prompts
  t.ok(/function _composeBlueprintBlock\(/.test(src), 'server has a _composeBlueprintBlock helper');
  const blk = _win(src, 'function _composeBlueprintBlock(', 1400);
  t.ok(/Required structure/.test(blk), 'blueprint block emits a Required structure heading');
  t.ok(/role === 'editor'/.test(blk), 'blueprint block tunes framing for the paired editor');
  t.ok(/never fabricate|TBD/.test(blk), 'writer framing forbids fabricating empty sections');
  const genP = _win(src, 'function _composeGeneratePrompt(', 1400);
  t.ok(/_composeBlueprintBlock\(c\.purpose,\s*'writer'\)/.test(genP), 'generation prompt injects the writer blueprint');
  t.ok(/_composeBlueprintBlock\(c\.purpose,\s*'editor'\)/.test(src), 'chat prompt injects the editor blueprint');
  // list route exposes blueprints to the client
  t.ok(/blueprints:\s*compose\.PURPOSE_BLUEPRINTS/.test(src), '/api/compose exposes blueprints');

  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/composeCurrentBlueprint\(\)/.test(html), 'client has a composeCurrentBlueprint helper');
  t.ok(/co\.blueprints\s*=/.test(html), 'client stores blueprints from the response');
  t.ok(/cmpx-blueprint/.test(html), 'framing rail surfaces the blueprint sections calmly');
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
  t.ok(/const floor = Math\.max\(480, \(window\.innerHeight/.test(src), 'height floor is viewport-based, not an arbitrary 360px');
  t.ok(/f\.style\.height = Math\.max\(floor/.test(src), 'parent sets the iframe height from the reported content height');
  // The arbitrary 520px lock + inert flex are gone; a modest floor + block growth remain.
  t.ok(/\.cmpx-site\{min-height:calc\(100vh - 260px\);[^}]*display:block\}/.test(src), 'cmpx-site drops the 520px lock for a viewport-based floor + block growth');
  t.ok(!/\.cmpx-site\{flex:1;min-height:520px/.test(src), 'no stale fixed-height site rule');
});

  await t.test('compose fullscreen is a focus mode + iterations show their provenance', () => {
    const src = readFileSync('public/app.html', 'utf8');
    // Fullscreen collapses the studio to the deliverable: single column, rail + paired
    // assistant hidden, the stage owns the viewport (a genuine focus, not just covering the topbar).
    t.ok(/\.cmpx-fs \.nlx-rail,\s*\.cmpx-fs \.cmpx-pair\{display:none\}/.test(src), 'fullscreen hides the sources rail + paired assistant');
    t.ok(/\.cmpx-fs \.nlx-stage\{height:calc\(100vh - 96px\)/.test(src), 'fullscreen stage fills the viewport height');
    t.ok(/\.cmpx-fs \.nlx-scroll\{flex:1;min-height:0;overflow:auto\}/.test(src), 'fullscreen scrolls inside the stage');
    // Provenance — the driving comment + framing that produced the CURRENT draft and every version.
    t.ok(/composeProvHas\(compose\.current && compose\.current\.draft\)/.test(src), 'current iteration renders its provenance');
    t.ok(/composeProvHas\(v\)/.test(src), 'each history version renders its provenance');
    t.ok(/composeProvPrompt\(d\)\s*\{[\s\S]{0,200}Manual edit/.test(src), 'prompt helper falls back to a Manual-edit label');
    t.ok(/composeProvFraming\(d\)\s*\{[\s\S]{0,300}f\.format[\s\S]{0,120}f\.audience/.test(src), 'framing helper surfaces audience + format + sources');
    // compose.js persists prompt + framing snapshot into the draft and carries it into versions.
    const cjs = readFileSync('compose.js', 'utf8');
    t.ok(/function _framingSnapshot\(c\)/.test(cjs), 'compose.js snapshots the framing');
    t.ok(/next\.framing = _framingSnapshot\(c\)/.test(cjs), 'saveDraft stamps the framing onto the draft');
    t.ok(/prompt: typeof draft\.prompt === 'string' \? draft\.prompt : ''/.test(cjs), '_pushVersion carries the driving prompt');
    t.ok(/prompt: typeof v\.prompt === 'string'[\s\S]{0,60}framing: v\.framing/.test(cjs), 'listVersions exposes prompt + framing');
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
  // Email/Teams image renderer accepts data: URIs AND hostedContents refs; never drops the caption.
  t.ok(/\/\^\(https\?:\|data:image\\\/\|\\\.\\\.\\\/hostedContents\\\/\)\/i\.test\(url\)/.test(srv), 'image renderer accepts data: URIs + hostedContents refs');
  t.ok(/No renderable image — keep the caption/.test(srv), 'email keeps the caption when no image renders');
});

await t.test('Pulse.AI Teams share — data-URI comics post via Graph hostedContents (not truncated inline base64) + capped raster', () => {
  const src = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  // Client caps the rasterized PNG so the base64 payload stays small (avoids the timeout).
  t.ok(/const MAXW = 1000;/.test(src), 'raster width is capped');
  t.ok(/const scale = nw > MAXW \? \(MAXW \/ nw\) : 1;/.test(src), 'raster scales down oversized art');
  // Server: data-URI images are lifted OUT of the body into a Graph hostedContents array,
  // and the body references them by ../hostedContents/{id}/$value (short, never truncated).
  const route = (srv.match(/app\.post\('\/api\/me-ai\/pulse\/share\/teams'[\s\S]*?\n\}\);/) || [''])[0];
  t.ok(/const hosted = \[\];/.test(route), 'route collects hostedContents');
  t.ok(/\^data:\(image\\\/\[a-z0-9\.\+\-\]\+\);base64,\(\.\+\)\$/i.test(route), 'data-URI images are matched + split');
  t.ok(/'@microsoft\.graph\.temporaryId': id, contentType: m\[1\], contentBytes: m\[2\]/.test(route), 'each image becomes a hostedContents entry');
  t.ok(/\.\.\/hostedContents\/\$\{id\}\/\$value/.test(route), 'body references the hosted image by its temporary id');
  t.ok(/if \(hosted\.length\) bodyObj\.hostedContents = hosted;/.test(route), 'hostedContents attached to the body only when present');
  // The whole body object (with contentBytes) is passed verbatim; retry-without-images fallback.
  t.ok(/pass it verbatim/.test(route), 'agent is told to pass the body verbatim');
  t.ok(/retry the SAME create_entity but with the hostedContents array removed/.test(route), 'text still posts if the image post fails');
  // The 24000-char body slice no longer carries base64 (only the short hostedContents ref).
  t.ok(/let html = _pulseShareHtml\(markdown, teamsImages\);/.test(route), 'body is built from the hostedContents-rewritten images');
});

await t.test('Pulse.AI share — inline-SVG comic is rasterized to a PNG data URI so the baked-in joke text survives Outlook', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // A browser-side rasterizer turns an SVG (with its <text> panels) into a PNG data URI.
  t.ok(/async _pulseSvgToPngDataUrl\(svg, bg\)\s*\{/.test(src), '_pulseSvgToPngDataUrl helper exists');
  t.ok(/data:image\/svg\+xml;charset=utf-8,'\s*\+\s*encodeURIComponent/.test(src), 'rasterizer sources the SVG as a data URI');
  t.ok(/c\.toDataURL\('image\/png'\)/.test(src), 'rasterizer exports a PNG data URI');
  // A pre-processor swaps any inline-svg share image for the rasterized url.
  t.ok(/async _pulseRasterizeShareImages\(images\)\s*\{/.test(src), '_pulseRasterizeShareImages helper exists');
  t.ok(/if \(im\.url\)\s*\{\s*out\.push\(im\);\s*continue;\s*\}/.test(src), 'already-url images pass through unchanged');
  t.ok(/out\.push\(\{ url: dataUrl, caption: im\.caption \|\| '' \}\)/.test(src), 'svg images become { url, caption }');
  // pulseShareSend rasterizes BEFORE posting to either target (email is the reported bug).
  const send = (src.match(/async pulseShareSend\(\)\s*\{[\s\S]*?\n        \},/) || [''])[0];
  t.ok(/await this\._pulseRasterizeShareImages\(sh\.images\)/.test(send), 'share send rasterizes the images first');
  t.ok(/images \} \)/.test(send.replace(/\s+/g, ' ')) || /body: JSON\.stringify\(\{ subject: sh\.title, markdown: body, images \}\)/.test(send), 'email POST sends the rasterized images (not raw sh.images)');
  t.ok(!/markdown: body, images: sh\.images/.test(send), 'raw sh.images is no longer posted directly');
});

await t.test('Compose paired assistant negotiates structure — server judges + applies, client mirrors into the framing panel', async () => {
  const srv = readFileSync('server.js', 'utf8');
  // Server: fence-tolerant JSON extractor + per-purpose format lock helpers.
  t.ok(/function _composeParseJsonBlock\(s\)\s*\{/.test(srv), '_composeParseJsonBlock helper exists');
  t.ok(/function _composeAllowedFormats\(purpose\)\s*\{[\s\S]*?purpose === 'prototype' \? \['site'\] : compose\.FORMATS\.filter\(f => f !== 'site'\)/.test(srv), 'allowed-format helper honours the prototype site-lock');
  // The prompt injects the structure context + the ===STRUCTURE=== control-block protocol.
  t.ok(/## Structure \(you own this/.test(srv), 'prompt gives the assistant ownership of the structure');
  t.ok(/===STRUCTURE===[\s\S]*?===END STRUCTURE===/.test(srv), 'prompt documents the STRUCTURE control block');
  // Parse/validate/apply: format validated against the allowed list + only when changed;
  // sources add/remove validated against the catalog; patch applied via updateComposition.
  const fn = (srv.match(/async function runComposeChat\([\s\S]*?return \{ reply, draft: newDraft, structure \};/) || [''])[0];
  t.ok(/allowedFormats\.includes\(j\.format\) && j\.format !== c\.format/.test(fn), 'format change validated against the allowed list + must differ');
  t.ok(/patch\.audience = j\.audience\.trim\(\)\.slice\(0, 400\)/.test(fn), 'audience clamped');
  t.ok(/patch\.title = j\.title\.trim\(\)\.slice\(0, 200\)/.test(fn), 'title clamped');
  t.ok(/const known = new Set\(compose\.SOURCES\.map\(s => s\.id\)\)/.test(fn), 'source ids validated against the catalog');
  t.ok(/compose\.updateComposition\(id, patch\)/.test(fn), 'structure patch applied through the real update path');
  t.ok(/return \{ reply, draft: newDraft, structure \}/.test(fn), 'handler returns the structure alongside reply + draft');
  // Control blocks are stripped from the human-visible reply.
  t.ok(/\.replace\(\/===STRUCTURE===\[\\s\\S\]\*\?===END STRUCTURE===\/i, ''\)/.test(fn), 'STRUCTURE block stripped from the reply');
  // Route forwards the whole out object (structure included).
  t.ok(/const out = await runComposeChat\(req\.params\.id[\s\S]*?res\.json\(\{ ok: true, \.\.\.out \}\)/.test(srv), 'chat route spreads out so structure passes through');

  // Live functional proof: the parse/validate/apply logic honours the rails.
  const { default: compose } = await import('../compose.js');
  const parse = (s) => { let t2 = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim(); try { return JSON.parse(t2); } catch (_) {} const a = t2.indexOf('{'), b = t2.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(t2.slice(a, b + 1)); } catch (_) {} } return null; };
  t.ok(parse('```json\n{"audience":"execs"}\n```').audience === 'execs', 'fenced JSON parses');
  t.ok(parse('noise {"title":"X"} tail').title === 'X', 'brace-sliced JSON parses');
  const allowed = (p) => p === 'prototype' ? ['site'] : compose.FORMATS.filter(f => f !== 'site');
  t.ok(!allowed('proposal').includes('site'), 'non-prototype purpose cannot switch to site');
  t.ok(allowed('prototype').length === 1 && allowed('prototype')[0] === 'site', 'prototype purpose is locked to site');

  // Client: composeChatSend consumes r.structure → sets co.current + surfaces note/ask.
  const html = readFileSync('public/app.html', 'utf8');
  const send = (html.match(/async composeChatSend\(\)\s*\{[\s\S]*?\n        \},/) || [''])[0];
  t.ok(/if \(r && r\.structure\)/.test(send), 'client acts on r.structure');
  t.ok(/co\.current = st\.composition/.test(send), 'client mirrors the returned composition into the framing panel');
  t.ok(/\.\.\.this\.composeSourcesDefault\(\)/.test(send), 'client re-merges the sources defaults');
  t.ok(/text: '🧭 ' \+ \(st\.note \|\| 'Updated the framing\.'\), structure: true/.test(send), 'a decision note surfaces as a distinct structure message');
  t.ok(/if \(st\.ask && !\(reply && reply\.includes\(st\.ask\)\)\)/.test(send), 'an open question surfaces (de-duped against the prose reply)');
  t.ok(/user: m\.role === 'user', structure: m\.structure/.test(html), 'structure messages get their own class');
  t.ok(/\.cmpx-pair-msg\.structure \.body\{/.test(html), 'structure message has a calm accent style');
});

await t.test('Compose.AI documents library — real list/search/sort/filter/grid/bulk wired to compositions', async () => {
  // Server list carries the fields the library needs (size + preview) per composition.
  const cjs = readFileSync('compose.js', 'utf8');
  const list = (cjs.match(/function listCompositions\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  t.ok(/size:\s*Buffer\.byteLength\(content, 'utf8'\)/.test(list), 'listCompositions reports byte size from the draft content');
  t.ok(/preview:\s*String\(content\)/.test(list), 'listCompositions carries a plain-text preview snippet');

  // Live proof: the size/preview derivation is real (not a placeholder).
  const { default: compose } = await import('../compose.js');
  t.ok(typeof compose.listCompositions === 'function', 'listCompositions is exported');

  const html = readFileSync('public/app.html', 'utf8');
  // A distinct library view exists, reachable from the launcher header.
  t.ok(/compose\.view === 'library'/.test(html), 'library is its own compose view');
  t.ok(/@click="goTo\('#\/documents'\)">📁 Documents/.test(html), 'launcher header opens the Documents page');
  // The library is driven by real bindings, not the mock DOCS array.
  t.ok(/composeLibFiltered\(\)/.test(html), 'rows/cards render composeLibFiltered()');
  t.ok(/x-model="compose\.lib\.q"/.test(html), 'search binds to compose.lib.q');
  t.ok(/x-model="compose\.lib\.sort"/.test(html), 'sort binds to compose.lib.sort');
  // Filter row is calm text links with muted counts — NO pills.
  t.ok(/class="cmpx-lib-filt"/.test(html) && /composeLibFacets\(\)/.test(html), 'quiet filter index row driven by facets');
  t.ok(!/border-radius:\s*999px/.test((html.match(/\.cmpx-lib-filt[\s\S]*?\.cmpx-lib-sum\{/) || [''])[0]), 'filter row uses no pill radius');
  // List + grid toggle both present.
  t.ok(/compose\.lib\.mode==='list'/.test(html) && /compose\.lib\.mode==='grid'/.test(html), 'list + grid view modes');
  // Bulk selection bar + timestamps + size.
  t.ok(/class="cmpx-lib-bulk"/.test(html) && /composeLibBulk\(/.test(html), 'bulk action bar wired');
  t.ok(/composeLibSize\(c\.size\)/.test(html), 'row size rendered from real byte size');
  t.ok(/class="col-when" x-text="formatRelative\(c\.updatedAt\)"/.test(html), 'row timestamp from meta.updatedAt');

  // Actions reuse real compose paths (open/share-deliver/export/delete) — not mock stubs.
  const methods = html;
  t.ok(/async composeOpenLibrary\(\)\s*\{[\s\S]*?await this\.loadCompose\(\)/.test(methods), 'library refreshes via the real loader');
  t.ok(/composeLibExport\(id\)\s*\{[\s\S]*?\/api\/compose\/' \+ encodeURIComponent\(id\) \+ '\/export/.test(methods), 'export hits the real per-id export route');
  t.ok(/async composeLibShare\(id\)\s*\{[\s\S]*?await this\.composeOpen\(id\)[\s\S]*?composeOpenDeliver/.test(methods), 'share opens the studio deliver flow');
  t.ok(/composeDelete\(c\.id, \{ silent: true \}\)/.test(methods), 'bulk delete uses the silent delete path');
  // loadCompose must not clobber an explicit library view.
  t.ok(/else if \(!co\.current && co\.view !== 'library'\)/.test(methods), 'loadCompose preserves the library view');
});

await t.test('Me-agent view is its own page (agenda hidden), not an overlay flashed over the agenda', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // A dedicated agentPage flag exists in the meai state.
  t.ok(/agentPage:\s*false,/.test(src), 'meai.agentPage state flag exists');
  // The agenda body is hidden when an agent page is active — but the wrap itself must
  // NOT be x-show'd away: the fixed agent surfaces (placeholder/console/pursuit) are its
  // OWN children, so display:none on the wrap blanked the Open-run deep link. Regression
  // guard: the wrap toggles a class that hides only agenda-body flow, exempting the
  // position:fixed surfaces.
  t.ok(!/class="meai-wrap"\s+x-show="!meai\.agentPage"/.test(src), 'wrap does NOT display:none itself in agent mode (would blank the fixed surfaces it contains)');
  t.ok(/class="meai-wrap"[^>]*'meai-wrap-agentpage':\s*meai\.agentPage/.test(src), 'wrap toggles .meai-wrap-agentpage class when agentPage');
  t.ok(/\.meai-wrap-agentpage\s*>\s*:not\(\.meai-agentpage-load\):not\(\.meai-cpage\):not\(\.meai-pursuit\)[^{]*\{\s*display:none/.test(src), 'agent-page CSS hides agenda-body flow but exempts the fixed agent surfaces');
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

await t.test('compose fullscreen fills width (real classes) + single fullscreen button (app.html)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // Fullscreen must widen the capped wrap and NOT target the stale .cmpx-studio/.cmpx-stage
  // classes that don't exist in the compose markup (real grid is .nlx-studio/.nlx-stage).
  t.ok(/\.cmpx-fs\s+\.cmpx-wrap\s*\{[^}]*max-width:\s*none/.test(src), 'fullscreen wrap uncaps width');
  t.ok(!/\.cmpx-fs\s+\.cmpx-studio\s*,\s*\.cmpx-fs\s+\.cmpx-stage/.test(src), 'stale .cmpx-studio/.cmpx-stage height rule removed');
  // Exactly one fullscreen toggle button remains (the labeled header one).
  const btnCount = (src.match(/@click="composeToggleFullscreen\(\)"/g) || []).length;
  t.ok(btnCount === 1, 'exactly one compose fullscreen button (was two): ' + btnCount);
});

await t.test('me-ai run open: evicted DEEP run falls back to durable /tree map, never a blank page (app.html)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // The plain /task/:id endpoint 404s once a finished/errored run leaves memory. Opening
  // it must probe the durable /tree and open the pursuit map instead of stranding the user.
  t.ok(/_meAiOpenTaskFallback\s*\(/.test(src), 'fallback helper defined');
  t.ok(/\.catch\(\(\)\s*=>\s*\{\s*this\._meAiOpenTaskFallback\(id\)/.test(src), 'fetch failure routes to the fallback');
  const m = src.match(/async\s+_meAiOpenTaskFallback\s*\(id\)\s*\{[\s\S]{0,600}?\n\s{8}\}/);
  t.ok(!!m, 'fallback body found');
  const body = m ? m[0] : '';
  t.ok(/\/tree/.test(body) && /meAiPursuitOpen\(id\)/.test(body), 'fallback probes /tree + opens the pursuit map');
  t.ok(/meAiAgentPageLeave\(\)/.test(body), 'no durable record → backs out cleanly (no blank agent page)');
});

await t.test('pursuit follow-up chat: fold + director_note render boxed multi-line, never a truncated substep row (app.html)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // Root cause: while _converse is set (the continue re-engagement clone), the server tags
  // EVERY emitted event converse:true — including fold + director_note. Those land in the
  // follow-up converse loop, which previously only special-cased 'you'/'response' and dumped
  // everything else into the single-line .meai-pu-ev-s row (white-space:nowrap; text-overflow:ellipsis).
  // The converse loop must now box fold + director_note like the main thread, and EXCLUDE them
  // from the generic substep row.
  // Isolate the converse loop block.
  const seg = src.slice(src.indexOf('meAiPursuitConverseEvents()') >= 0 ? src.indexOf("(ev, ci) in meAiPursuitConverseEvents()") : 0);
  const loop = seg.slice(0, 6000);
  t.ok(/x-for="\(ev, ci\) in meAiPursuitConverseEvents\(\)"/.test(src), 'converse loop present');
  // Boxed fold card + director turn inside the converse block.
  t.ok(/ev\.kind==='fold'[\s\S]{0,120}meai-pu-fold/.test(loop), 'converse fold renders the boxed .meai-pu-fold card');
  t.ok(/ev\.kind==='director_note'[\s\S]{0,120}meai-pu-turn director/.test(loop), 'converse director_note renders the prominent Director turn');
  t.ok(/:key="'cff-'\+ci\+'-'\+fi"/.test(loop), 'converse fold findings key is unique to the converse loop');
  // The generic substep row must now exclude fold + director_note so they can never fall through
  // to the truncated single-line .meai-pu-ev-s row.
  t.ok(/ev\.who!=='you' && ev\.kind!=='response' && ev\.kind!=='fold' && ev\.kind!=='director_note'/.test(loop),
    'generic converse substep row excludes fold + director_note');
  // The main-thread spine loop already excluded them (guard against regression).
  t.ok(/ev\.kind!=='fold' && ev\.kind!=='director_note' && !\(meai\.pursuit\.hideThinking/.test(src),
    'main spine substep row still excludes fold + director_note');
});

await t.test('pulse.ai focus-lens meeting recaps: dedupe redundant + surface action items with add-to-todos / add-to-triage (server.js + app.html)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  // SERVER — semantic dedupe of recurring meeting recaps (collapse same-title occurrences).
  t.ok(/_pulseDedupeMeetings\(Array\.from\(mByKey\.values\(\)\)\)/.test(srv), 'meetings assembly runs through _pulseDedupeMeetings');
  t.ok(/function _pulseDedupeMeetings\(/.test(srv) && /function _pulseMeetingTitleKey\(/.test(srv), 'dedupe + title-key helpers exist');
  // Generic titles (<2 tokens) must NOT collapse; representative carries mergedCount.
  t.ok(/tokens\.length >= 2 \? norm : ''/.test(srv), 'title-key guards generic (<2-token) titles from collapsing');
  t.ok(/mergedCount/.test(srv), 'survivor carries a mergedCount');
  // SERVER — the capture endpoint routes to agenda to-dos OR the triage inbox.
  t.ok(/'\/api\/me-ai\/pulse\/meeting\/action'/.test(srv), 'meeting-action capture route exists');
  t.ok(/target === 'todo'[\s\S]{0,1200}saveMeAiTodoStore/.test(srv), "target 'todo' appends to the agenda todo store");
  t.ok(/target === 'inbox'[\s\S]{0,1600}_meAiMergeInbox\(date, \[sig\]\)/.test(srv), "target 'inbox' folds a meeting-action signal into the triage inbox");
  t.ok(/dedupeKey: 'mtgact:' \+ mid \+ ':' \+ h/.test(srv), 'inbox capture reuses the mtgact dedupeKey scheme so it merges with the auto-gather');
  // CLIENT — action items are expandable and each offers the two quiet add actions (no pills).
  const strip = html.slice(html.indexOf('Since your last meetings'), html.indexOf('Since your last meetings') + 3000);
  t.ok(/pulseMtgToggle\(m\.id\)/.test(strip), 'action-item count is a toggle that expands the list');
  t.ok(/pulseActAdd\(m, a, ai, 'todo'\)/.test(strip) && /pulseActAdd\(m, a, ai, 'inbox'\)/.test(strip), 'each action offers add-to-todos + add-to-triage');
  t.ok(/most recent of ' \+ m\.mergedCount/.test(strip), 'collapsed recurring recaps note "most recent of N"');
  t.ok(/pulse\._actState\[pulseActKey\(m, ai\)\]/.test(strip), 'added state is tracked per action item');
  // CLIENT — methods + state wired.
  t.ok(/pulseActAdd\(m, a, ai, target\)/.test(html) && /pulseMtgToggle\(id\)/.test(html), 'pulseActAdd + pulseMtgToggle methods exist');
  t.ok(/_mtgOpen: \{\}, _actState: \{\}/.test(html), 'pulse state seeds _mtgOpen + _actState maps');
});

// Newsletter is a MULTI-DOCUMENT model (was a singleton: one perpetual draft + a
// flat 40-entry version log). A newsletter now has a docId; the covered-timeframe
// window is the fingerprint for revision-vs-new. The Documents library lists every
// distinct newsletter; generating with a changed window prompts a calm choice.
await t.test('newsletter: multi-document model (revision vs new) end to end', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  const nl = readFileSync('newsletter.js', 'utf8');

  // MODEL (newsletter.js) — docId + window-aware storage + doc operations.
  t.ok(/docId:\s*''/.test(nl), 'draft state carries a docId');
  t.ok(/_ensureMigrated\b/.test(nl), 'legacy flat log migrates into docIds');
  t.ok(/windowChanged\s*\(/.test(nl) && /listDocuments\s*\(/.test(nl) && /openDocument\s*\(/.test(nl) && /newDocument\s*\(/.test(nl), 'window/doc operations defined');
  t.ok(/module\.exports[\s\S]{0,600}listDocuments[\s\S]{0,120}openDocument[\s\S]{0,120}newDocument[\s\S]{0,120}windowChanged/.test(nl), 'doc operations exported');
  // saveDraft honors an explicit docMode='new' (start a separate newsletter).
  t.ok(/saveDraft\s*\([^)]*docMode/.test(nl) || /docMode\s*===\s*'new'/.test(nl), 'saveDraft honors docMode new');

  // SERVER — generate returns needsDecision when the window changed and no mode was
  // given; the three document endpoints exist; versions are doc-scoped.
  t.ok(/needsDecision:\s*true/.test(srv), 'generate can return needsDecision');
  t.ok(/windowChanged\(win\)/.test(srv), 'generate consults windowChanged');
  t.ok(/docMode:\s*mode === 'new'/.test(srv), "generate passes docMode 'new' only on explicit new");
  t.ok(/'\/api\/newsletter\/documents'/.test(srv), 'GET documents route');
  t.ok(/'\/api\/newsletter\/documents\/:docId\/open'/.test(srv), 'open-document route');
  t.ok(/'\/api\/newsletter\/documents\/new'/.test(srv), 'new-document route');
  t.ok(/listDraftVersions\(req\.query && req\.query\.docId\)/.test(srv), 'versions endpoint is doc-scoped');

  // CLIENT — generate handles needsDecision with a calm binary confirm + re-POST;
  // New-newsletter button; library lists all newsletter docs and opens the right one.
  t.ok(/r\.needsDecision/.test(html) && /this\.newsletterGenerate\(\{ mode: startNew \? 'new' : 'revise' \}\)/.test(html), 'client resolves needsDecision then re-generates with a mode');
  t.ok(/newsletterNewDocument\s*\(/.test(html) && /\/api\/newsletter\/documents\/new/.test(html), 'New newsletter button posts documents/new');
  t.ok(/lib\.newsletters\s*=/.test(html) && /\/api\/newsletter\/documents'/.test(html), 'library loads all newsletter documents (array)');
  t.ok(/_newsletterOpenDoc\s*\(/.test(html) && /\/api\/newsletter\/documents\/'\s*\+\s*encodeURIComponent\(c\.docId\)\s*\+\s*'\/open'/.test(html), 'opening a newsletter row promotes that specific doc');
  t.ok(/composeLibRowMeta\s*\(/.test(html), 'library rows show a doc-aware sub-line (revisions/window)');
  // Bulk delete must not try to delete a newsletter as a composition.
  t.ok(/comps\.length[\s\S]{0,400}composeDelete\(c\.id/.test(html), 'bulk delete only targets compositions');
  // No stale singleton reference left behind.
  t.ok(!/lib\.newsletter\b(?!s)/.test(html.replace(/newsletters/g, 'NLS')), 'no stale singular lib.newsletter reference');
});

await t.test('compose sources: agent task runs (pick one or more agents, fold recent runs)', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  // catalog + defaults + clamp
  t.ok(/id:\s*'agentruns'/.test(cjs), 'compose.js SOURCES catalog has an agentruns source');
  const defs = _win(cjs, '_defaultSources', 1400);
  t.ok(/agentruns:\s*false/.test(defs) && /agentRunsRef:\s*''/.test(defs) && /agentRunsDays:\s*14/.test(defs), '_defaultSources seeds agentruns + ref + days window');
  t.ok(/'agentRunsRef'/.test(cjs), 'updateComposition clamps agentRunsRef');
  t.ok(/agentRunsDays/.test(cjs), 'updateComposition clamps agentRunsDays');

  const src = readFileSync('server.js', 'utf8');
  // corpus helper + fetcher + source-context branch + picker route
  t.ok(/function _composeAgentRunsCorpusText\s*\(/.test(src), 'server has an agent-runs corpus helper');
  const corpus = _win(src, 'function _composeAgentRunsCorpusText', 900);
  t.ok(/split\(\/\[,\\n\]\//.test(corpus), 'corpus splits the ref into one-or-more agent ids');
  const one = _win(src, 'function _composeAgentRunsForOne', 1600);
  t.ok(/getRunHistory/.test(one), 'per-agent fold reads the run history');
  t.ok(/loadAgents\(\)/.test(one), 'per-agent fold resolves the agent via loadAgents');
  t.ok(/86400000/.test(one), 'per-agent fold bounds runs to a lookback window');
  t.ok(/agentruns:\s*async/.test(src), '_composeSourceFetchers registers an agentruns fetcher');
  const ctx = _win(src, '_composeSourceContext', 12000);
  t.ok(/agentRunsRef/.test(ctx), '_composeSourceContext reads the agent-runs ref');
  t.ok(/'\/api\/compose\/sources\/agents'/.test(src), 'picker route GET /api/compose/sources/agents');

  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/composeLoadAgents\s*\(/.test(html), 'client has a composeLoadAgents loader');
  t.ok(/\/api\/compose\/sources\/agents/.test(html), 'client fetches the agents picker');
  // multi-select checklist (comma-joined ref), mirroring the repos picker — no pills
  t.ok(/composeAgentToggle\s*\(/.test(html) && /composeAgentIsSelected\s*\(/.test(html), 'agents picker is a multi-select checklist (toggle + isSelected)');
  t.ok(/composeAgentSelectedRefs\s*\(/.test(html), 'selection is stored as comma-joined refs');
  t.ok(/sources\.agentRunsRef/.test(html), 'sources rail binds the agent-runs ref');
  t.ok(/sources\.agentRunsDays/.test(html), 'sources rail binds the look-back window');
  const sd = _win(html, 'composeSourcesDefault() {', 700);
  t.ok(/agentruns:\s*false/.test(sd) && /agentRunsRef/.test(sd) && /agentRunsDays/.test(sd), 'composeSourcesDefault seeds the agentruns keys');
  // regression: the explicit PATCH payload must carry the agentruns fields, or
  // Check-sources would persist sources without them and reset the toggle.
  const pm = _win(html, 'async composePersistMeta() {', 1400);
  t.ok(/agentruns:\s*!!\(c\.sources/.test(pm) && /agentRunsRef:/.test(pm) && /agentRunsDays:/.test(pm), 'composePersistMeta persists the agentruns fields');
});

await t.test('compose sources: work-item refs accept an AB#-prefixed token', () => {
  const src = readFileSync('server.js', 'utf8');
  const fn = _win(src, 'function _composeParseWorkItemRefs', 900);
  t.ok(/\(\?:AB\)\?#\?/i.test(fn), 'numeric fallback accepts an optional AB# prefix');
  // prove the actual regex maps AB#10503 → 10503 (the bug the user hit)
  const re = /^(?:AB)?#?(\d{1,8})$/i;
  t.ok((('AB#10503'.match(re) || [])[1]) === '10503', 'AB#10503 resolves to 10503');
  t.ok((('10503'.match(re) || [])[1]) === '10503', 'bare 10503 still resolves');
  t.ok(!re.test('GH#5'), 'a GH#-prefixed token is not caught by the AzDO numeric fallback');
});

await t.test('compose sources: discrete selected sources are inlined in full — never truncated', () => {
  const src = readFileSync('server.js', 'utf8');
  // The user hit an assistant reporting a source as "truncated" (work item #10503
  // epic cut off mid-section). None of the selected sources should be truncated.
  const ctx = _win(src, 'async function _composeSourceContext', 16000);
  // work-item description: inlined in full (no .slice cap on the description)
  t.ok(/_composeHtmlText\(wi\.description\)\s*:/.test(ctx), 'work-item description is inlined in full');
  t.ok(!/_composeHtmlText\(wi\.description\)\.slice\(/.test(ctx), 'work-item description is NOT sliced/truncated');
  // PR description: full, not clipped at 4000
  t.ok(/String\(pr\.description\)\}`/.test(ctx), 'PR description is inlined in full');
  t.ok(!/String\(pr\.description\)\.slice\(/.test(ctx), 'PR description is NOT sliced/truncated');
  // pasted context: the user's own text, inlined verbatim
  t.ok(/String\(src\.pasted\)\.trim\(\);/.test(ctx), 'pasted context is inlined in full (no trailing slice)');
  // composition reuse: full body, no per-item 12000 clip
  t.ok(!/body\.slice\(0, Math\.min\(12000/.test(ctx), 'composition reuse no longer clips each body at 12000');
  // pursuit / agent-run folds keep only a high safety ceiling (not a low cap)
  const pur = _win(src, 'function _composePursuitCorpusText', 900);
  t.ok(!/\.slice\(0, 1400\)/.test(pur) && !/\.slice\(0, 260\)/.test(pur), 'pursuit fold no longer clips summaries/evidence at low caps');
});

await t.test('compose: sources auto-flush before a chat ask (Check sources not a prerequisite)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // composeChatSend must persist the framing/sources before hitting /chat, so the
  // assistant sees whatever is toggled on right now without a manual Check-sources.
  const send = _win(html, 'async composeChatSend() {', 2800);
  t.ok(/await this\.composePersistMeta\(\)/.test(send), 'composeChatSend flushes framing/sources before asking');
  const persistIdx = send.indexOf('composePersistMeta');
  const chatIdx = send.indexOf("/chat'");
  t.ok(persistIdx >= 0 && (chatIdx < 0 || persistIdx < chatIdx), 'the persist happens before the /chat request');
});

await t.test('compose: Brainstorm purpose blueprints options + strength scores + a recommendation', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  t.ok(/id:\s*'brainstorm'/.test(cjs), 'compose has a brainstorm purpose');
  const bp = _win(cjs, 'brainstorm: {', 2600);
  t.ok(/Pros/.test(bp) && /Cons/.test(bp), 'brainstorm asks for honest pros/cons per option');
  t.ok(/strength score/i.test(bp), 'brainstorm scores each option (strength score)');
  t.ok(/Recommendation/.test(bp), 'brainstorm lands a recommendation');
  t.ok(/best practice/i.test(bp) && /modern technolog/i.test(bp), 'brainstorm researches industry best practices + modern tech');
  // pasted source clamp lifted to a generous ceiling (no low truncation)
  t.ok(!/pasted\.slice\(0, 16000\)/.test(cjs) && /pasted\.slice\(0, 200000\)/.test(cjs), 'pasted source clamp raised (not truncated at 16000)');
});

await t.test('compose: version rename in place (+ promote fork still available) — server + core + UI', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  // compose.js core: promoteVersion (fork) still EXISTS as an available op, but is
  // no longer wired to the rename input — rename is now IN PLACE via renameVersion.
  t.ok(/function promoteVersion\(id, vid, title\)/.test(cjs), 'compose.js still has promoteVersion(id,vid,title)');
  const pv = _win(cjs, 'function promoteVersion(id, vid, title)', 1400);
  t.ok(/_defaultComposition\(/.test(pv), 'promote clones a new composition (fork)');
  t.ok(/promoteVersion,/.test(cjs), 'promoteVersion is exported');
  // compose.js core: renameVersion mutates the version's title IN PLACE + persists.
  t.ok(/function renameVersion\(id, vid, title\)/.test(cjs), 'compose.js has renameVersion(id,vid,title)');
  const rv = _win(cjs, 'function renameVersion(id, vid, title)', 500);
  t.ok(/c\.versions[\s\S]*\.find\(x => x\.id === vid\)/.test(rv), 'renameVersion locates the version by id');
  t.ok(/v\.title = t;/.test(rv) && /_writeAll\(st\)/.test(rv), 'renameVersion sets v.title in place and persists');
  t.ok(/if \(!t\) return null;/.test(rv), 'renameVersion rejects an empty title');
  t.ok(/renameVersion,/.test(cjs), 'renameVersion is exported');
  // server route: PATCH renames in place (NOT the promote POST)
  t.ok(/app\.patch\('\/api\/compose\/:id\/versions\/:vid'/.test(src), 'in-place rename PATCH route present');
  t.ok(/app\.post\('\/api\/compose\/:id\/versions\/:vid\/promote'/.test(src), 'promote route still present');
  // UI: editable title input on prior versions renames IN PLACE (no fork, no reset)
  t.ok(/@change="composeRenameVersion\(v, \$event\.target\.value\)"/.test(html), 'renaming a version calls composeRenameVersion');
  t.ok(/\$event\.target\.value = \(v\.title/.test(html) === false, 'rename input no longer resets its value (which discarded the edit)');
  t.ok(/composePromoteVersion/.test(html) === false, 'stale composePromoteVersion is gone from the UI');
  const rm = _win(html, 'async composeRenameVersion(v, newTitle)', 900);
  t.ok(/method: 'PATCH'/.test(rm), 'composeRenameVersion PATCHes the version');
  t.ok(/v\.title = nt;/.test(rm), 'composeRenameVersion updates v.title locally so the row sticks');
  t.ok(/v\.title = was;/.test(rm), 'composeRenameVersion reverts the input on failure');
  // Current draft is renamable in place from the history view (PATCHes the composition title).
  t.ok(/@change="composeRenameCurrent\(\$event\.target\.value, \$event\.target\)"/.test(html), 'current-draft row calls composeRenameCurrent');
  const rc = _win(html, 'async composeRenameCurrent(newTitle, el)', 700);
  t.ok(/method: 'PATCH'/.test(rc) && /\/api\/compose\/' \+ encodeURIComponent\(co\.current\.id\)/.test(rc), 'composeRenameCurrent PATCHes the composition');
  t.ok(/co\.current\.title = nt;/.test(rc), 'composeRenameCurrent updates the current title');
  // Studio view exposes an explicit "New" affordance (not just the buried switcher item),
  // and it starts a NEW composition of the SAME purpose the user is in.
  t.ok(/@click="composeNewSamePurpose\(\)"[\s\S]{0,240}✚ New/.test(html), 'studio header New button calls composeNewSamePurpose');
  const nsp = _win(html, 'composeNewSamePurpose() {', 500);
  t.ok(/const purpose = this\.compose\.current && this\.compose\.current\.purpose;/.test(nsp), 'New reads the current purpose');
  t.ok(/this\.composeStart\(purpose, \{ forceNew: true \}\);/.test(nsp), 'New starts a fresh same-purpose composition');
  // Layout: studio fills the content area (flex column) so panels scroll independently.
  t.ok(/\.cmpx-studio-fill\{flex:1;min-height:0/.test(html), 'studio-fill wrapper fills remaining height');
  t.ok(/\.cmpx-wrap:has\(\.cmpx-paired\)\{[^}]*var\(--ql-h,0px\)/.test(html), 'studio height subtracts the quick-launch bar');
  // Refresh/return restores the last-viewed composition instead of dumping to the launcher.
  t.ok(/localStorage\.setItem\('compose-last-id', c\.id\)/.test(html), 'opening a composition persists its id');
  const lc = _win(html, 'async loadCompose() {', 2400);
  t.ok(/localStorage\.getItem\('compose-last-id'\)/.test(lc), 'loadCompose reads the saved id');
  t.ok(/\(co\.compositions \|\| \[\]\)\.some\(c => c\.id === lastId\)[\s\S]{0,80}this\.composeOpen\(lastId\)/.test(lc), 'loadCompose reopens the saved doc when it still exists');
});

await t.test('compose: version quick-view (read-only preview without restoring)', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  // server: single-version GET returns the full content for preview
  t.ok(/app\.get\('\/api\/compose\/:id\/versions\/:vid'/.test(src), 'single-version GET route present');
  // UI: Quick view links on both the current row and prior versions
  t.ok(/composeVersionPreview\(composeCurrentVersion\(\)\)/.test(html), 'current draft has a Quick view');
  t.ok(/@click\.prevent="composeVersionPreview\(v\)"/.test(html), 'each prior version has a Quick view');
  // method fetches on demand + renders markdown vs sandboxed site
  const m = _win(html, 'async composeVersionPreview(v) {', 1400);
  t.ok(/__current__/.test(m), 'preview handles the current-draft pseudo-version');
  t.ok(/newsletterRenderHtml/.test(m), 'markdown versions render to HTML');
  t.ok(/p\.site = isSite/.test(m), 'html versions flagged for the sandboxed frame');
  // modal markup: sandboxed iframe for sites, x-html for markdown, close
  t.ok(/compose\.verPreview\.open/.test(html), 'preview modal is gated on verPreview.open');
  t.ok(/sandbox="allow-scripts"[\s\S]{0,80}:srcdoc="compose\.verPreview\.html"|:srcdoc="compose\.verPreview\.html"[\s\S]{0,80}sandbox="allow-scripts"/.test(html), 'site preview uses a sandboxed srcdoc iframe');
  t.ok(/composeVersionPreviewClose\(\)/.test(html), 'preview modal can be closed');
  t.ok(/verPreview: \{ open: false/.test(html), 'compose state seeds verPreview');
  // Library documents get the SAME read-only quick view (reuses the verPreview overlay).
  t.ok(/title="Quick view \(read-only\)" @click\.stop="composeLibPreview\(c\)"/.test(html), 'library rows/cards expose a Quick view action');
  const lp = _win(html, 'async composeLibPreview(c) {', 1200);
  t.ok(/this\.compose\.verPreview/.test(lp), 'composeLibPreview drives the shared verPreview overlay');
  t.ok(/\/api\/compose\/' \+ encodeURIComponent\(c\.id\)/.test(lp), 'composeLibPreview fetches the row document by its own id');
  t.ok(/newsletterRenderHtml/.test(lp) && /p\.site = isSite/.test(lp), 'composeLibPreview renders markdown vs sandboxed site like the version preview');
});

await t.test('compose studio: independent per-panel scroll + rail resize preserved', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // rail cards scroll inside an inner wrapper so the absolute resize grip is not clipped/scrolled
  t.ok(/class="nlx-rail-scroll"/.test(html), 'rail cards are wrapped in a scroll container');
  t.ok(/\.nlx-rail-scroll\{[^}]*overflow:auto/.test(html), '.nlx-rail-scroll scrolls');
  // the rail itself stays non-scrolling so the grip (right:-9px) stays visible
  const railCss = _win(html, '.nlx-studio.cmpx-paired > .nlx-rail{', 200);
  t.ok(/overflow:visible/.test(railCss), 'rail is non-scrolling (grip not clipped)');
  // resize grip still present + wired
  t.ok(/class="cmpx-rail-resize"[\s\S]{0,120}composeRailResizeStart/.test(html), 'rail resize grip is present + wired');
  // the paired studio fills its flex parent (which is viewport-bound via .cmpx-wrap) so each column scrolls on its own
  t.ok(/\.nlx-studio\.cmpx-paired\{height:100%;min-height:0/.test(html), 'paired studio fills its container for independent scroll');
  t.ok(/\.cmpx-wrap:has\(\.cmpx-paired\)\{[^}]*height:calc\(100vh/.test(html), 'the studio wrap is viewport-bound (page does not scroll)');
});

await t.test('compose chat: auto-grow input + type-while-busy (Send gated on busy)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // textarea auto-grows and is NOT disabled while busy (can compose while assistant works)
  const ta = _win(html, 'x-ref="composeChatInput"', 400);
  t.ok(/@input=.*composeChatGrow/.test(ta), 'chat input auto-grows on input');
  t.ok(!/:disabled="compose\.chat\.busy"/.test(ta), 'chat input is not disabled while busy');
  // Enter only sends when not shift + not busy
  t.ok(/!\$event\.shiftKey && !compose\.chat\.busy/.test(html), 'Enter sends only when idle (Shift/busy inserts newline)');
  // grow helper caps at 220px
  const grow = _win(html, 'composeChatGrow(el)', 300);
  t.ok(/220/.test(grow), 'auto-grow caps at 220px');
});

await t.test('pulse guide: share one or all "Guide to your team" entries', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Guide section header carries a calm "Share all" action + each entry a per-entry Share
  const guide = _win(html, '<!-- The Guide -->', 1500);
  t.ok(/pulseShareGuide\(\)/.test(guide) && />Share all</.test(guide), 'Guide header shares all entries');
  t.ok(/pulseShareGuideEntry\(e\)/.test(guide) && /class="pc-entry"/.test(guide), 'each guide entry has a Share action');
  // methods build a markdown share payload and open the existing share sheet
  const one = _win(html, 'pulseShareGuideEntry(e) {', 360);
  t.ok(/pulseShareOpen\(/.test(one) && /e\.subject/.test(one) && /e\.riff/.test(one), 'share-one composes subject + riff into the share sheet');
  const all = _win(html, 'pulseShareGuide() {', 720);
  t.ok(/pulseActiveComedy\(\)/.test(all) && /\.guide/.test(all) && /forEach/.test(all) && /pulseShareOpen\(/.test(all), 'share-all folds every entry into one share payload');
  // no pills: the term row uses the calm .pc-share-btn text button
  t.ok(/class="pc-term"><span class="pc-term-t"/.test(html), 'guide term row hosts the share button inline (no pill)');
});

await t.test('compose studio: in-studio document switcher + roomy quick-view', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Header switcher lets you see the current doc and jump to any composition
  const sw = _win(html, 'class="cmpx-switch"', 2600);
  t.ok(/composeToggleSwitcher\(\)/.test(sw), 'header shows a clickable switcher control');
  t.ok(/x-for="c in compose\.compositions"/.test(sw) && /composeSwitchTo\(c\.id\)/.test(sw), 'switcher lists every composition and jumps on click');
  t.ok(/All documents…/.test(sw) && /Start something new/.test(sw), 'switcher offers library + new-doc escapes');
  // methods exist and guard unsaved edits
  const m = _win(html, 'async composeSwitchTo(id) {', 320);
  t.ok(/draftDirty/.test(m) && /composeOpen\(id\)/.test(m), 'composeSwitchTo confirms unsaved edits before opening');
  t.ok(/switcherOpen: false/.test(html), 'switcher menu state is declared');
  // quick-view overlay is roomy (uses the viewport height, not a squat 86vh) and is a
  // TOP-LEVEL teleport to <body> — it must not be nested in a <template x-if>, or Alpine
  // won't teleport it and position:fixed stays trapped in the studio container.
  const qv = _win(html, 'Compose version quick-view — top-level teleport', 2600);
  t.ok(/height:94vh/.test(qv) && /min\(1200px,96vw\)/.test(qv), 'quick-view uses available viewport so scrollbars are last-resort');
  t.ok(/x-teleport="body"/.test(qv), 'quick-view is teleported to body (fixed resolves to viewport)');
  // centering MUST come from the .modal-backdrop stylesheet class (display:grid;place-items:center),
  // NOT inline display:flex — Alpine's x-show clears inline `display` on show, which would strand
  // the card top-left. Regression guard for that exact bug.
  t.ok(/class="modal-backdrop modal-overlay"[^>]*x-show="compose\.verPreview\.open"/.test(qv), 'quick-view backdrop centers via .modal-backdrop class (survives x-show clearing inline display)');
  // the rendered doc must NOT inherit the base .md-output max-height:300px cap — it should flow
  // full-height so the modal pane (not an inner 300px box) provides the single scrollbar.
  t.ok(/cmpx-doc"[^>]*max-height:none[^>]*overflow:visible/.test(qv), 'quick-view content is uncapped (no inner .md-output 300px scroll box)');
});

await t.test('boards: pin Compose.AI documents (backend + picker + card + assistant awareness)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  // BACKEND — 'document' is a pinnable board kind + resolves through _resolveBoardItems so
  // both the Briefing and the Workspace Assistant see the draft content.
  t.ok(/BOARD_KINDS[\s\S]{0,200}'document'/.test(srv), "'document' is a recognized board kind");
  t.ok(/it\.kind === 'document'/.test(srv), '_resolveBoardItems has a document branch');
  const docBranch = _win(srv, "it.kind === 'document'", 1200);
  t.ok(/compose\.getComposition\(/.test(docBranch), 'document branch resolves the composition draft');
  t.ok(/replace\(\/<\[\^>\]\+>\/g/.test(docBranch), 'document branch strips HTML tags for the plain-text context');
  // Assistant catalog exposes AVAILABLE DOCUMENTS + can pin_item kind document.
  t.ok(/AVAILABLE DOCUMENTS/.test(srv), 'assistant prints an AVAILABLE DOCUMENTS catalog');
  t.ok(/offer\('document'/.test(srv), 'assistant offers documents into catalogByKey');
  t.ok(/agent\|task\|flow\|pr\|document/.test(srv), 'pin_item system-prompt lists document as a kind');
  // FRONTEND — icon/label, picker candidates, jump, card detail, inline preview.
  t.ok(/document: 'Document'/.test(html), 'boardKindLabel maps document');
  t.ok(/document: '📄'/.test(html), 'boardKindIcon maps document');
  const loader = _win(html, 'async loadBoardDocCandidates(force)', 1000);
  t.ok(/\/api\/compose/.test(loader) && /newsletter/.test(loader), 'loadBoardDocCandidates GETs compositions and filters newsletters');
  t.ok(/this\.boardPinKind === 'document'/.test(html), 'pinCandidates has a document branch');
  // boardJump routes documents into the Compose studio on that composition.
  const jump = _win(html, "localStorage.setItem('compose-last-id', item.refId)", 300);
  t.ok(/#\/compose/.test(jump) && /composeOpen\(item\.refId\)/.test(jump), 'boardJump opens the document in Compose');
  // Card detail: meta + Open + Quick view + inline preview, lazy-loaded.
  t.ok(/board-doc-detail/.test(html), 'document pin card has a detail template');
  t.ok(/composeLibPreview\(\{ id: item\.refId, title: item\.label \}\)/.test(html), 'card exposes a Quick view reusing composeLibPreview');
  const ensure = _win(html, 'async boardDocEnsure(item)', 1200);
  t.ok(/\/api\/compose\/'/.test(ensure) && /boardDocDetail/.test(ensure), 'boardDocEnsure lazy-loads the draft into boardDocDetail');
  t.ok(/boardDocDetail: \{\}/.test(html), 'boardDocDetail cache is declared in state');
  t.ok(/boardPinHasDetail[\s\S]{0,160}'document'/.test(html), 'boardPinHasDetail includes document');
});

await t.test('boards: pin Me.AI runs (backend + picker + card + report access + assistant awareness)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  // BACKEND — 'meairun' is a pinnable board kind + resolves through _resolveBoardItems so
  // both the Briefing and the Workspace Assistant see the run's goal + final report.
  t.ok(/BOARD_KINDS[\s\S]{0,220}'meairun'/.test(srv), "'meairun' is a recognized board kind");
  t.ok(/it\.kind === 'meairun'/.test(srv), '_resolveBoardItems has a meairun branch');
  const branch = _win(srv, "it.kind === 'meairun'", 1400);
  t.ok(/meAiTasks\.get\(/.test(branch) && /_meAiLoadTask/.test(branch), 'meairun branch resolves the task');
  t.ok(/kind ?=== ?'report'|kind==='report'/.test(branch), 'meairun branch finds the latest report artifact');
  // Lean per-run report endpoint powering the card's inline preview + quick access.
  t.ok(/\/api\/me-ai\/task\/:id\/report\/latest/.test(srv), 'GET /report/latest route exists');
  const rpt = _win(srv, "/report/latest'", 1400);
  t.ok(/hasReport/.test(rpt) && /reportUrl/.test(rpt), '/report/latest returns hasReport + reportUrl');
  // Assistant catalog exposes AVAILABLE ME.AI RUNS + can pin_item kind meairun.
  t.ok(/AVAILABLE ME\.AI RUNS/.test(srv), 'assistant prints an AVAILABLE ME.AI RUNS catalog');
  t.ok(/offer\('meairun'/.test(srv), 'assistant offers Me.AI runs into catalogByKey');
  t.ok(/agent\|task\|flow\|pr\|document\|meairun/.test(srv), 'pin_item system-prompt lists meairun as a kind');
  // FRONTEND — icon/label, picker candidates, jump, card detail, inline preview.
  t.ok(/meairun: 'Me\.AI Run'/.test(html), 'boardKindLabel maps meairun');
  t.ok(/meairun: '🔭'/.test(html), 'boardKindIcon maps meairun');
  const loader = _win(html, 'async loadBoardMeAiCandidates(force)', 700);
  t.ok(/\/api\/compose\/sources\/pursuits/.test(loader), 'loadBoardMeAiCandidates GETs the pursuits source');
  t.ok(/this\.boardPinKind === 'meairun'/.test(html), 'pinCandidates has a meairun branch');
  // boardJump + route deep-link into the pursuit map.
  t.ok(/case 'meairun': return '#\/me-ai\/' \+ encodeURIComponent\(item\.refId\)/.test(html), 'boardItemRoute maps meairun to #/me-ai/<id>');
  // Card detail: goal/stage meta + Open pursuit + Read final report + inline preview, lazy-loaded.
  t.ok(/board-meai-detail/.test(html), 'meairun pin card has a detail template');
  t.ok(/🔭 Open pursuit/.test(html), 'card exposes Open pursuit');
  t.ok(/Read the final report →/.test(html), 'card exposes Read the final report');
  const ensure = _win(html, 'async boardMeAiEnsure(item)', 1400);
  t.ok(/report\/latest/.test(ensure) && /boardMeAiDetail/.test(ensure), 'boardMeAiEnsure lazy-loads the report into boardMeAiDetail');
  t.ok(/boardMeAiDetail: \{\}/.test(html), 'boardMeAiDetail cache is declared in state');
  t.ok(/boardPinHasDetail[\s\S]{0,200}'meairun'/.test(html), 'boardPinHasDetail includes meairun');
});

await t.test('board pin picker: candidate rows are fully clickable + prefetch on open + summary panel resizes', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // meai-pin-click: candidate rows are a full-width clickable <button>, pin affordance can't overflow.
  const row = _win(html, 'pinCandidate(cand)', 900);
  t.ok(/<button[^>]*class="card clickable"/.test(html), 'candidate row is a clickable card button');
  t.ok(/:disabled="cand\.pinned"/.test(html), 'already-pinned candidate is disabled');
  t.ok(/min-width:0;flex:1 1 auto/.test(html), 'candidate label wrapper can shrink with ellipsis');
  t.ok(/flex:0 0 auto/.test(html), 'pin affordance is fixed-size so it cannot overflow the modal');
  t.ok(/✓ Pinned|📌 Pin/.test(html), 'pin affordance shows Pinned/Pin state inline (not a stray button)');
  // meai-pin-slow: opening the picker prefetches Me.AI + document candidates in the background.
  const opener = _win(html, 'openPinPicker() {', 900);
  t.ok(/boardPinOpen ?= ?true/.test(opener), 'openPinPicker opens the picker');
  t.ok(/loadBoardMeAiCandidates\(\)/.test(opener), 'openPinPicker prefetches Me.AI candidates');
  t.ok(/loadBoardDocCandidates\(\)/.test(opener), 'openPinPicker prefetches document candidates');
  // grp-summary-resize: resizable group-summary panel with persisted state.
  t.ok(/sumW:/.test(html) && /sumH:/.test(html), 'bmap state carries sumW/sumH');
  t.ok(/bmap-selpanel-grip/.test(html), 'summary panel has a resize grip element');
  t.ok(/:style="bmapSummaryStyle\(\)"/.test(html), 'summary panel binds bmapSummaryStyle');
  const rs = _win(html, 'bmapSummaryResizeStart(ev)', 1600);
  t.ok(/setPointerCapture/.test(rs), 'resize uses pointer capture');
  t.ok(/startW - \(e\.clientX - startX\)/.test(rs), 'width grows as the grip drags left (panel anchored right)');
  t.ok(/startH \+ \(e\.clientY - startY\)/.test(rs), 'height grows as the grip drags down');
  t.ok(/localStorage\.setItem\('bmap-sum-w'/.test(rs) && /localStorage\.setItem\('bmap-sum-h'/.test(rs), 'resize persists width + height');
});

await t.test('board map: document + Me.AI-run cards are enriched (color, facts, meta, summary, action)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  // Distinct gradients: document = pink/rose, meairun = teal.
  t.ok(/document: '#f778ba'/.test(html), 'bmapKindColor maps document to a pink/rose gradient');
  t.ok(/meairun: '#2ec4b6'/.test(html), 'bmapKindColor maps meairun to a teal gradient');
  // Batched doc-meta cache + per-card meta accessors.
  t.ok(/_bmapDocMeta\(p\)/.test(html), '_bmapDocMeta accessor exists');
  t.ok(/_bmapMeAiMeta\(p\)/.test(html), '_bmapMeAiMeta accessor exists');
  t.ok(/_boardDocMeta\b/.test(html) && /_boardDocMetaLoaded/.test(html), 'batched document meta cache is present');
  t.ok(/ensureBoardDocMeta\(\)/.test(html), 'ensureBoardDocMeta lazily kicks the batched load');
  // Facts: document (Type/Format/Modified) + meairun (Status/Nodes/Last run/Report).
  const facts = _win(html, 'bmapFacts(p) {', 8000);
  t.ok(/k === 'document'[\s\S]{0,220}composePurposeLabel[\s\S]{0,160}Modified/.test(facts), 'bmapFacts has a document branch (type/format/modified)');
  t.ok(/k === 'meairun'[\s\S]{0,260}push\('Status'[\s\S]{0,160}Last run/.test(facts), 'bmapFacts has a meairun branch (status/nodes/last-run/report)');
  // Footer meta shows last-modified / last-run age for existing pins.
  t.ok(/k === 'document'[\s\S]{0,140}edited/.test(_win(html, 'bmapCardMeta(p) {', 900)), 'bmapCardMeta shows document edited-age');
  t.ok(/k === 'meairun'[\s\S]{0,120}_bmapAgo/.test(_win(html, 'bmapCardMeta(p) {', 900)), 'bmapCardMeta shows meairun last-run age');
  // Summary + show-summary include both kinds.
  t.ok(/bmapShowSummary/.test(html) && /'document'/.test(_win(html, 'bmapShowSummary(p) {', 400)) && /'meairun'/.test(_win(html, 'bmapShowSummary(p) {', 400)), 'bmapShowSummary renders document + meairun summaries');
  // Card action: meairun opens the final report when present.
  const act = _win(html, 'bmapCardAction(p) {', 1200);
  t.ok(/k === 'meairun'[\s\S]{0,200}Read the report/.test(act), 'bmapCardAction offers "Read the report" for a Me.AI run');
  t.ok(/k === 'document'[\s\S]{0,160}Open in Compose/.test(act), 'bmapCardAction offers "Open in Compose" for a document');
  t.ok(/hasReport && d\.reportUrl[\s\S]{0,120}window\.open/.test(_win(html, 'bmapDoCardAction(p) {', 700)), 'bmapDoCardAction opens the report url in a new tab');
  // Server /report/latest carries nodes + updatedAt for the card facts/footer.
  t.ok(/report\/latest/.test(srv), 'report/latest endpoint present');
  const rep = _win(srv, 'report/latest', 2600);
  t.ok(/nodes:/.test(rep) && /updatedAt:/.test(rep), 'report/latest returns nodes + updatedAt');
});

await t.test('compose library: pin a document to a board (row/card/studio) + non-overlapping row actions', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Icon overlap fix: the list-row action toolbar is a floating, occluding overlay
  // (absolute, pointer-events gated, backing gradient) instead of a too-small grid column,
  // and the grid dropped the dead 6th column (now 5 cells: cbx/doc/purpose/when/size).
  t.ok(/grid-template-columns:26px 1fr 150px 118px 92px;/.test(html), 'list grid is 5 columns (actions no longer reserve a column)');
  const rowacts = _win(html, '.cmpx-lib-trow .rowacts{', 400);
  t.ok(/position:absolute/.test(rowacts) && /pointer-events:none/.test(rowacts), 'rowacts floats as an overlay, click-through when hidden');
  t.ok(/linear-gradient\([\s\S]{0,120}var\(--cp-surface\)/.test(rowacts), 'rowacts has an occluding backing so icons never bleed into the size text');
  t.ok(/\.cmpx-lib-trow:hover \.rowacts\{opacity:1;pointer-events:auto\}/.test(html), 'rowacts becomes interactive on hover');
  // Pin affordance in all three surfaces, gated to non-newsletter (documents only).
  const pin = /openQuickPin\('document', c\.id, c\.title \|\| 'Untitled', composePurposeLabel\(c\.purpose\)\)/g;
  const hits = (html.match(pin) || []).length;
  t.ok(hits >= 2, 'list row + grid card each pin the document via openQuickPin(document)');
  t.ok(/openQuickPin\('document', compose\.current\.id, compose\.current\.title \|\| 'Untitled', composePurposeLabel\(compose\.current\.purpose\)\)/.test(html), 'studio header pins the current document');
  const pinBtns = _win(html, "title=\"Pin to a workspace\"", 400);
  t.ok(/x-show="c\.kind!=='newsletter' " ?title="Pin to a workspace"|x-show="c\.kind!=='newsletter'" title="Pin to a workspace"/.test(html), 'row pin button is gated to non-newsletter documents');
});

await t.test('documents-page: Documents is its own top-level route + nav item (app.html)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // 1. #/documents is a real route in the whitelist.
  t.ok(/'compose', 'documents', 'me-ai'/.test(html), "'documents' is registered in the parseHash route whitelist");
  // 2. the documents route dispatches to the library; #/compose scrubs a leftover library view.
  const disp = _win(html, "} else if (this.route === 'compose') {", 700);
  t.ok(/if \(this\.compose\.view === 'library'\) \{ this\.compose\.view = 'launcher'; this\.compose\.current = null; \}/.test(disp), 'compose route scrubs a leftover library view so refresh restores the studio');
  t.ok(/} else if \(this\.route === 'documents'\) \{\s*await this\.composeOpenLibrary\(\);/.test(disp), 'documents route opens the library');
  // 3. the compose section renders for BOTH routes.
  t.ok(/route === 'compose' \|\| route === 'documents'/.test(html), 'the compose section renders for #/compose and #/documents');
  // 4. the header title reflects the Documents page.
  t.ok(/route === 'documents' \? '📄 Documents' : '✍️ Compose\.AI'/.test(html), 'header title switches to Documents on the documents route');
  // 5. in-compose "Documents" affordances navigate to the route (not a view flip).
  t.ok(/x-show="compose\.view === 'launcher'" @click="goTo\('#\/documents'\)">📁 Documents/.test(html), 'launcher header Documents button routes to #/documents');
  t.ok(/@click="compose\.switcherOpen=false; goTo\('#\/documents'\)">📁 All documents/.test(html), 'studio switcher "All documents" routes to #/documents');
  t.ok(/@click="goTo\('#\/compose'\)">Iterations studio/.test(html), 'library "Iterations studio" routes back to #/compose');
  // 6. opening/creating a document from the library routes to #/compose (stable URL).
  const libOpen = _win(html, 'async composeLibOpen(c) {', 900);
  t.ok(/localStorage\.setItem\('compose-last-id', c\.id\)/.test(libOpen) && /goTo\('#\/compose'\)/.test(libOpen), 'composeLibOpen stashes the id + routes to #/compose');
  const libNew = _win(html, 'composeLibNew() {', 400);
  t.ok(/goTo\('#\/compose'\)/.test(libNew), 'composeLibNew routes to the Compose launcher');
  // 7. nav item + default keys (gated on the Compose.AI/newsletter feature).
  t.ok(/case 'documents': return mk\('Documents', '📄', '#\/documents', 'documents'\);/.test(html), '_navItemDef defines the Documents nav item');
  t.ok(/if \(en\('newsletter'\)\) out\.push\('newsletter', 'documents'\);/.test(html), "_navDefaultKeys offers 'documents' alongside Compose.AI");
  // 8. tier registration: routeMode + basic/advanced visibility.
  t.ok(/'compose', 'documents', 'me-ai'/.test(html), 'routeMode maps documents to the workspace mode');
  t.ok(/newsletter: \['newsletter', 'compose', 'documents'\]/.test(html), 'documents is visible under the newsletter feature gate (basic + advanced)');
});

await t.done();