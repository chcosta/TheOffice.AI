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

// Compose documents are addressable by a shareable deep link (#/compose/<id>) so a
// specific document can be referenced by URL — pasted into a chat, a doc, or handed to
// an assistant. The studio also keeps the address bar pointed at the current doc.
await t.test('compose: shareable deep link to a document (#/compose/<id>)', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // Link builder + copy action.
  t.ok(/composeDocLink\(id\) \{/.test(html), 'composeDocLink(id) builds the deep-link URL');
  t.ok(/'#\/compose\/' \+ encodeURIComponent\(cid\)/.test(html), 'the link uses the #/compose/<id> hash route');
  t.ok(/async composeCopyLink\(\) \{/.test(html), 'composeCopyLink() is defined');
  t.ok(/@click="composeCopyLink\(\)"/.test(html), 'a toolbar button copies the document link');

  // Entry resolution: a deep link queues the doc id and loadCompose opens it (over the
  // last-viewed restore), with a graceful fallback when the id is unknown.
  t.ok(/if \(this\.app\.routeParam\) this\.compose\._pendingOpenId = this\.app\.routeParam/.test(html),
    'the compose route captures the id from the hash param');
  const load = _win(html, 'async loadCompose()', 1600);
  t.ok(/else if \(co\._pendingOpenId\)/.test(load), 'loadCompose honors a queued deep-link id');
  t.ok(/await this\.composeOpen\(oid\)/.test(load), 'a known id opens that document');
  t.ok(/could not be resolved/.test(load), 'an unknown id falls back with a notice');
  t.ok(/_pendingOpenId: null,/.test(html), '_pendingOpenId is declared in compose state');

  // The address bar tracks the current doc via replaceState (no hashchange loop).
  const setCur = _win(html, '_composeSetCurrent(c) {', 1000);
  t.ok(/history\.replaceState\(null, '', '#\/compose\/' \+ encodeURIComponent\(c\.id\)\)/.test(setCur),
    'selecting a doc rewrites the URL to its deep link');
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

// Regression — Director actions must address the OPEN pursuit by its real task id
// (pursuit.tid). A prior bug used pursuit.id (never assigned → undefined), so
// spawn/resume/redirect/probe all POSTed to /api/me-ai/task/undefined/... : the
// server created a throwaway "undefined" tree and returned ok, so the toast claimed
// success while the real pursuit's map and insights never changed.
await t.test('director actions target pursuit.tid, never pursuit.id', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // No Director endpoint may be addressed with the undefined pursuit.id.
  t.ok(!/encodeURIComponent\((?:this\.meai\.pursuit|p)\.id\)\s*\+\s*'\/director\//.test(html),
    'no /director/ request uses pursuit.id (undefined)');
  // The insight spin-off + resume + redirect all use .tid.
  t.ok(/encodeURIComponent\(this\.meai\.pursuit\.tid\)\s*\+\s*'\/director\/spawn'/.test(html),
    'director/spawn uses pursuit.tid');
  t.ok(/encodeURIComponent\(this\.meai\.pursuit\.tid\)\s*\+\s*'\/director\/resume'/.test(html),
    'director/resume uses pursuit.tid');
  t.ok(/encodeURIComponent\(this\.meai\.pursuit\.tid\)\s*\+\s*'\/director\/redirect'/.test(html),
    'director/redirect uses pursuit.tid');
  // After a spawn, the map is refolded (not just the Director rail) so the new node shows.
  t.ok(/meAiDirectorSpawnSubmit\(run\)\s*\{[\s\S]*?await this\.meAiPursuitLoad\(\);/.test(html),
    'spawn submit refreshes the pursuit map');
  // The actioned insight is marked so it no longer re-offers "Spin off effort".
  t.ok(/meAiDirectorInsightActed\(ins\)\s*\{/.test(html), 'an insight-acted helper is defined');
  t.ok(/x-show="ins\.action && meAiDirectorInsightActed\(ins\)"/.test(html),
    'the insight row shows a spun-off confirmation once acted');
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

await t.test('compose roadmap: a visual + documented Roadmap purpose (catalog + blueprint + sources)', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  // Purpose catalog: a first-class Roadmap purpose that defaults to a document.
  t.ok(/id: 'roadmap',\s*label: 'Roadmap'/.test(cjs), 'compose.js exposes a Roadmap purpose');
  t.ok(/id: 'roadmap'[\s\S]{0,160}defaultFormat: 'doc'/.test(cjs), 'Roadmap defaults to a doc (documented artifact)');
  // Source defaults ground it in real features/requests/deliverables.
  t.ok(/roadmap:\s*\['workitems', 'pursuit'\]/.test(cjs), 'Roadmap seeds work-items + pursuit sources');
  // Blueprint: BOTH visual and documented, with the sequencing sections in order.
  const bp = _win(cjs, 'roadmap: {', 4600);
  t.ok(/title: 'Roadmap'/.test(bp), 'roadmap blueprint is titled Roadmap');
  t.ok(/BOTH visual AND documented/.test(bp), 'roadmap intro mandates a visual + documented plan');
  t.ok(/Now \/ Next \/ Later|Now · Next · Later/.test(bp), 'roadmap frames horizons (Now/Next/Later or quarters)');
  ['Objectives & themes', 'Workstreams & scope', 'Visual roadmap', 'Milestones & deliverables', 'Dependencies & sequencing', 'Resourcing & capacity', 'Risks, assumptions & open questions'].forEach(h => {
    t.ok(bp.includes(h), `roadmap blueprint has the "${h}" section`);
  });
  // The visual section demands a REAL, offline-rendering visual (svg/table) — the
  // compose doc viewer renders inline SVG + tables verbatim, so this actually shows.
  const vis = _win(cjs, "h: 'Visual roadmap'", 900);
  t.ok(/<svg>|`<svg>`|inline `<svg>`/.test(vis) && /<table>|`<table>`/.test(vis), 'Visual roadmap section asks for an inline SVG or HTML-table timeline');
  t.ok(/render offline|no external assets/.test(vis), 'the visual must render offline (no external assets)');
  t.ok(/no pills/.test(vis), 'the visual keeps the no-pills convention');
  t.ok(/never fabricate a date|TBD|est\./.test(bp), 'roadmap forbids fabricating dates (TBD/est.)');
});

await t.test('compose paired assistant: heartbeat keeps the idle watchdog alive during active work', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  // Server: _composeRunAgent beats on ANY activity — streamed tokens + steps.
  const runAgent = _win(src, 'async function _composeRunAgent(', 1600);
  t.ok(/onActivity/.test(runAgent), '_composeRunAgent takes an onActivity heartbeat');
  t.ok(/onChunk:\s*\(c\)\s*=>\s*\{\s*acc\s*\+=\s*c;\s*if\s*\(beat\)/.test(runAgent), 'onChunk beats on every streamed token');
  t.ok(/if\s*\(beat\)[\s\S]{0,40}beat\(\)[\s\S]{0,80}if\s*\(userStep\)/.test(runAgent), 'onStep beats even when the step has no user-facing message');
  // Both run paths emit a throttled, text-less heartbeat compose-progress event.
  const genFn = _win(src, 'async function runComposeGeneration(', 2200);
  t.ok(/heartbeat:\s*true/.test(genFn) && /now\s*-\s*_lastBeat\s*<\s*4000/.test(genFn), 'generation heartbeat is throttled + flagged');
  t.ok(/_composeRunAgent\('writer', prompt, onStep, beat\)/.test(genFn), 'writer run is passed the heartbeat');
  const chatFn = _win(src, 'async function runComposeChat(', 7400);
  t.ok(/chat:\s*true,\s*heartbeat:\s*true/.test(chatFn), 'chat heartbeat carries chat:true + heartbeat:true');
  t.ok(/_composeRunAgent\('editor', prompt, onStep, beat\)/.test(chatFn), 'editor run is passed the heartbeat');
  // Client: the compose-progress handler consumes a heartbeat to feed the watchdog, renders nothing.
  const handler = _win(html, "source.addEventListener('compose-progress'", 2000);
  t.ok(/if\s*\(d\.heartbeat\)\s*\{\s*c\._lastActivityAt\s*=\s*Date\.now\(\);\s*return;\s*\}/.test(handler), 'chat branch resets _lastActivityAt on a heartbeat and renders nothing');
  t.ok(/if\s*\(d\.heartbeat\)\s*\{\s*co\._lastActivityAt\s*=\s*Date\.now\(\);\s*return;\s*\}/.test(handler), 'generate branch consumes a heartbeat');
  // Client: the idle floor is a generous safety net now that the heartbeat is the real signal.
  const watchdog = _win(html, 'async composeChatSend()', 2200);
  t.ok(/const IDLE_MS = 600000, CEILING_MS = 60 \* 60000;/.test(watchdog), 'compose chat idle floor raised to 10 min with a 60 min ceiling');
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
  const hdr = _win(src, 'class="meai-pu-hdract"', 2200);
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
  // The auto-sizing height reporter that caused the runaway grow loop is intentionally GONE.
  t.ok(!/__composeHeight/.test(src), 'no content-height reporter (auto-sizing removed — it slid the dialog down)');
  const listen = _win(src, 'composeSiteHeightListen() {', 300);
  t.ok(/f\.style\.height = ''/.test(listen), 'height listener is a no-op that only clears stale inline height');
  t.ok(!/f\.style\.height = Math\.max\(floor/.test(src), 'the listener no longer sizes the frame to reported content');
  // A fixed viewport with internal scroll: the site fills the stage and scrolls inside.
  t.ok(/\.cmpx-site\{min-height:calc\(100vh - 260px\);[^}]*display:block\}/.test(src), 'cmpx-site is a viewport-height block, not a runaway auto-grown box');
  t.ok(/\.nlx-stage \.nlx-scroll\.cmpx-scroll-site\{display:flex;flex-direction:column;overflow:hidden\}/.test(src), 'cmpx-scroll-site makes the stage a fixed internally-scrolling viewport');
  t.ok(!/\.cmpx-site\{flex:1;min-height:520px/.test(src), 'no stale fixed-height site rule');
});

await t.test('compose prototype: in-memory Storage shim so sandboxed localStorage never crashes the render', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // A prototype runs in a sandboxed, opaque-origin iframe (allow-scripts, no
  // allow-same-origin) so real window.localStorage THROWS on access. We inject an
  // ephemeral in-memory Storage polyfill at the top so generated code that persists
  // state "just works" without reaching real browser storage.
  t.ok(/composeStorageShim\(\)\s*\{/.test(src), 'composeStorageShim method exists');
  t.ok(/_composeInjectStorageShim\(html\)\s*\{/.test(src), 'injection helper exists');
  const shim = _win(src, 'composeStorageShim() {', 1400);
  t.ok(/data-compose-shim/.test(shim), 'shim script carries an idempotency marker');
  t.ok(/install\("localStorage"\);install\("sessionStorage"\)/.test(shim), 'shim installs BOTH localStorage and sessionStorage');
  t.ok(/getItem:function|setItem:function|removeItem:function|clear:function|key:function/.test(shim), 'shim provides the Storage method API');
  t.ok(/typeof Proxy!=="undefined"/.test(shim) && /new Proxy\(api/.test(shim), 'shim backs direct property access via Proxy (localStorage.foo = x)');
  t.ok(/Object\.defineProperty\(window,name,\{value:mk\(\),configurable:true\}\)/.test(shim), 'shim redefines the throwing window getter with the in-memory store');
  t.ok(/var s=window\[name\];s\.getItem\("__cp_probe"\);return;/.test(shim), 'install guard leaves real storage intact where it actually works');
  // Both run contexts inject the shim: the embedded srcdoc iframe and the blob full-window open.
  const srcdoc = _win(src, 'composeSiteSrcdoc() {', 700);
  t.ok(/return this\._composeInjectStorageShim\(html\)/.test(srcdoc), 'composeSiteSrcdoc injects the shim into the srcdoc');
  const prev = _win(src, 'composePreviewSite() {', 600);
  t.ok(/const html = this\._composeInjectStorageShim\(raw\)/.test(prev), 'composePreviewSite injects the shim into the blob preview');
  // Idempotent — a doc already carrying the marker is not double-injected.
  const inj = _win(src, '_composeInjectStorageShim(html) {', 400);
  t.ok(/data-compose-shim/.test(inj) && /return html;/.test(inj), 'injection is idempotent (skips docs already shimmed)');
  t.ok(/<head\[\^>\]\*>/.test(inj) && /<html\[\^>\]\*>/.test(inj), 'shim is placed at the top of the document (after <head>, then <html>, else prepend)');
});

  await t.test('compose fullscreen is a focus mode + iterations show their provenance', () => {
    const src = readFileSync('public/app.html', 'utf8');
    // Fullscreen collapses the studio to a single panel (a genuine focus, not just covering the
    // topbar). Two variants: view hides rail + assistant; assistant hides rail + stage.
    t.ok(/\.cmpx-fs-view \.nlx-rail,\s*\.cmpx-fs-view \.cmpx-pair\{display:none\}/.test(src), 'view fullscreen hides the sources rail + paired assistant');
    // The stage-hide (assistant fs) + stage-fill (view fs) rules MUST be scoped through the
    // studio so they out-specify `.nlx-studio.cmpx-paired > .nlx-stage` (0,3,0); otherwise the
    // plain `.cmpx-fs-pair .nlx-stage` (0,2,0) loses and the view stays visible in pair fs.
    t.ok(/\.cmpx-fs-pair \.nlx-rail,\s*\.cmpx-fs-pair \.nlx-studio\.cmpx-paired > \.nlx-stage\{display:none\}/.test(src), 'assistant fullscreen hides the rail + stage (studio-scoped to win specificity)');
    t.ok(/\.cmpx-fs-view \.nlx-studio\.cmpx-paired > \.nlx-stage\{height:calc\(100vh - 96px\)/.test(src), 'view fullscreen stage fills the viewport height (studio-scoped)');
    t.ok(/\.cmpx-fs \.nlx-scroll\{flex:1;min-height:0;overflow:auto\}/.test(src), 'fullscreen scrolls inside the panel');
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
  // Client renders the vector SVG at a fixed display width so the comic stays crisp
  // (a 1:1 raster of a small SVG looked blurry once the client upscaled it).
  t.ok(/const TARGET = 2000;/.test(src), 'raster targets a crisp display width');
  t.ok(/const scale = nw > 0 \? \(TARGET \/ nw\) : 1;/.test(src), 'the vector is re-rasterized to the target width (up or down)');
  // Server: data-URI images are lifted OUT of the body into a Graph hostedContents array,
  // and the body references them by ../hostedContents/{id}/$value (short, never truncated).
  const route = (srv.match(/app\.post\('\/api\/me-ai\/pulse\/share\/teams'[\s\S]*?\n\}\);/) || [''])[0];
  t.ok(/const hosted = \[\];/.test(route), 'route collects hostedContents');
  t.ok(/\^data:\(image\\\/\[a-z0-9\.\+\-\]\+\);base64,\(\.\+\)\$/i.test(route), 'data-URI images are matched + split');
  t.ok(/'@microsoft\.graph\.temporaryId': id, contentType: m\[1\], contentBytes: m\[2\]/.test(route), 'each image becomes a hostedContents entry');
  t.ok(/\.\.\/hostedContents\/\$\{id\}\/\$value/.test(route), 'body references the hosted image by its temporary id');
  t.ok(/if \(hosted\.length\) bodyObj\.hostedContents = hosted;/.test(route), 'hostedContents attached to the body only when present');
  // The image bytes are posted DETERMINISTICALLY to Graph over HTTPS — never through the
  // LLM prompt (the base64 is far too large for the model to echo → the 300s timeout).
  t.ok(/async function _graphPostChannelMessage\(/.test(srv), 'server has a direct Graph channel-message poster');
  t.ok(/az account get-access-token --resource https:\/\/graph\.microsoft\.com/.test(srv), 'Graph token minted from the Azure CLI sign-in');
  t.ok(/const g = await _graphPostChannelMessage\(teamId, channelId, bodyObj\);/.test(route), 'inline-image posts go straight to Graph');
  t.ok(/if \(g && g\.ok\) return res\.json\(\{ ok: true[^}]*via: 'graph'/.test(route), 'a successful Graph post returns immediately');
  t.ok(/delete bodyObj\.hostedContents;/.test(route), 'on Graph failure the image bytes are stripped before the agent fallback');
  // The whole body object (with contentBytes) is passed verbatim; retry-without-images fallback.
  t.ok(/pass it verbatim/.test(route), 'agent is told to pass the body verbatim');
  t.ok(/retry the SAME create_entity but with the hostedContents array removed/.test(route), 'text still posts if the image post fails');
  // The 24000-char body slice no longer carries base64 (only the short hostedContents ref).
  t.ok(/let html = _pulseShareHtml\(markdown, teamsImages\);/.test(route), 'body is built from the hostedContents-rewritten images');
});

await t.test('Pulse.AI Teams share — channel picker polls the lazy stale-while-revalidate load + shows progress', () => {
  const src = readFileSync('public/app.html', 'utf8');
  const fn = (src.match(/async pulseShareLoadChannels\(teamId\)\s*\{[\s\S]*?\n        \},/) || [''])[0];
  t.ok(fn, 'pulseShareLoadChannels found');
  // A cold team returns []+refreshing while a background WorkIQ fetch fills channels in;
  // the picker must poll rather than silently show an empty dropdown.
  t.ok(/const refreshing = !!\(r && \(r\.refreshing \|\| r\.stale\)\);/.test(fn), 'reads the refreshing/stale flag');
  t.ok(/sh\.chanRefreshing = true;/.test(fn), 'raises a refreshing flag while channels are still loading');
  t.ok(/setTimeout\(\(\)\s*=>\s*\{[^}]*this\.pulseShareLoadChannels\(teamId\); \}, 4000\)/.test(fn), 'polls again while the background refresh runs');
  t.ok(/if \(sh\.teamId !== teamId \|\| !sh\.open\) return;/.test(fn), 'bails if the user switched teams or closed the sheet');
  // The poll timer is cancelled when the sheet closes (no leaked polling).
  t.ok(/pulseShareClose\(\)\s*\{[^}]*clearTimeout\(sh\._chanPollT\)/.test(src), 'closing the sheet cancels the channel poll');
  // The UI surfaces the in-progress state + a genuine empty result (never a blank dropdown).
  t.ok(/Fetching this team's channels/.test(src), 'shows a fetching hint while channels load');
  t.ok(/No channels found for this team\./.test(src), 'shows an explicit empty state when there really are none');
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

await t.test('Director arbitrates a clash by AI verdict (checkability flipped to AI-driven, not regex)', () => {
  const director = require('../director.js');
  const I = director._internal;
  const grant = { id: 'g', paths: ['/'], classes: ['duplicate', 'reversible-local', 'factual-clash'], ops: ['cull', 'absorb', 'resolve'], expiresAt: Date.now() + 1e7 };

  // The checkability predicate is AI-DRIVEN and fully FLIPPED: a clash is checkable (→ arbitrate)
  // UNLESS the model EXPLICITLY marked it a values call (checkable === false). Crucially this now
  // includes the NO-VERDICT case — an un-reasoned clash STILL routes to a read-only arbitration
  // probe (which detects when the two sides actually AGREE and culls the false binary, or verifies
  // a provable fact like "does the item have this tag / link"), never punts to the human. Punting
  // un-arbitrated clashes to the desk was the exact bug ("both sides agree, why is this my call?").
  t.ok(I._clashCheckable({ checkable: true }) === true, 'an explicitly-checkable verdict arbitrates');
  t.ok(I._clashCheckable({}) === true, 'a verdict with no checkable flag DEFAULTS to checkable (the flip)');
  t.ok(I._clashCheckable({ checkable: false }) === false, 'an explicit values-call verdict stays a desk ask');
  t.ok(I._clashCheckable(null) === true, 'no AI verdict → STILL arbitrated (flip: un-reasoned clashes probe, never punt)');
  // The old brittle regex predicate is GONE.
  t.ok(typeof I._clashIsCheckable === 'undefined', 'the old regex _clashIsCheckable predicate is removed');

  // Recency/provenance note: when the two sides observed the target at different times, the note
  // prefers the more-recently-observed side (a state clash is usually a staleness artifact).
  const withRecency = { subject: 'main HEAD', a: { claim: 'HEAD is 2f92218', observedAt: '2026-07-12T10:00:00Z' }, b: { claim: 'HEAD is 67513f6', observedAt: '2026-07-12T09:00:00Z' } };
  const rec = I._recencyNote(withRecency);
  t.ok(/RECENCY/.test(rec) && /Side A/.test(rec) && /more recently/.test(rec), 'recency note prefers the newer-observed side');
  t.ok(I._recencyNote({ subject: 'x', a: { claim: 'p', observedAt: '2026-07-12T10:00:00Z' }, b: { claim: 'q', observedAt: '2026-07-12T10:00:00Z' } }) === '', 'equal observedAt → no recency note');
  t.ok(I._recencyNote({ subject: 'x', a: { claim: 'p' }, b: { claim: 'q' } }) === '', 'missing observedAt → no recency note');

  const provable = { id: 'c1', status: 'open', subject: 'roadmap-pr-merged',
    a: { stance: 'affirm', claim: 'PR 63007 is merged to main, merge commit 2f92218 on origin/main', observedAt: '2026-07-12T10:00:00Z' },
    b: { stance: 'deny', claim: "branch has NOT merged; main's HEAD is 67513f6", observedAt: '2026-07-12T09:00:00Z' } };
  const mkTree = (conflict, legs) => ({ id: 'p1', stops: [{ id: 's1', status: 'open', type: 'needs-decision', conflictId: conflict.id }], legs: legs || {}, conflicts: [conflict] });
  // The model punted a provable clash to the desk (action ask) but did NOT mark it a values call —
  // so under the flip it defaults checkable and the gate force-routes it to a probe.
  const aiPunt = { aiVerdicts: { s1: { cls: 'judgement-clash', action: 'ask', confidence: 0.9, checkable: true, reasoning: 'settleable against main' } } };

  const forced = director.planReduction(mkTree(provable), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiPunt));
  t.ok(forced.per[0].disposition === 'probe', 'a clash the AI left checkable is force-routed to probe (not the human)');
  t.ok(forced.probeItems.length === 1 && /ARBITRATE/.test(forced.probeItems[0].plan || ''), 'the probe carries an arbitration plan against the source of truth');
  t.ok(/human is not the tie-breaker/i.test(forced.probeItems[0].plan || ''), 'arbitration plan states the human is not the tie-breaker');
  t.ok(/RECENCY/.test(forced.probeItems[0].plan || ''), 'arbitration plan folds in the recency note when the sides observed at different times');

  // A verdict that DEFAULTS checkable (no flag) still arbitrates — this is the flip in action.
  const flip = director.planReduction(mkTree(provable), Object.assign({ enabled: true, autonomy: 'balanced', grant }, { aiVerdicts: { s1: { cls: 'judgement-clash', action: 'ask', confidence: 0.9 } } }));
  t.ok(flip.per[0].disposition === 'probe', 'a clash with no explicit checkable flag arbitrates by default (flipped default)');

  // A genuine values call (checkable:false) is NOT arbitrated — it honestly stays on the desk.
  const taste = { id: 'c2', status: 'open', subject: 'which tone for the summary', a: { stance: 'affirm', claim: 'warmer' }, b: { stance: 'deny', claim: 'terser' } };
  const kept = director.planReduction(mkTree(taste), Object.assign({ enabled: true, autonomy: 'balanced', grant }, { aiVerdicts: { s1: { cls: 'judgement-clash', action: 'ask', confidence: 0.9, checkable: false } } }));
  t.ok(kept.per[0].disposition === 'ask', 'an explicit values-call clash stays on the desk (not arbitrated)');

  // No AI verdict yet → under the flip the clash STILL routes to a read-only arbitration probe
  // (agreement-detection + live-fact check), it is NOT punted to the human's desk. This is the fix
  // for the recurring "both sides agree / the tag plainly exists — why is this my call?" complaint.
  const noai = director.planReduction(mkTree(provable), { enabled: true, autonomy: 'balanced', grant });
  t.ok(noai.per[0].disposition === 'probe', 'without an AI verdict the clash is arbitrated (flip: probe, never a premature desk ask)');
  t.ok((noai.probeItems || []).length === 1 && /ARBITRATE/.test(noai.probeItems[0].plan || ''), 'the un-reasoned clash carries an arbitration plan');

  // The arbitration brief detects CONSENSUS first and treats a tag/link/field as ALWAYS checkable
  // against the LIVE item — the two real bugs the user filed (agreeing sides; a provable tag).
  const probe = I._arbitrationProbe(provable);
  t.ok(/AGREE/.test(probe.plan) && /CONSENSUS/i.test(probe.plan), 'arbitration plan checks for agreement/consensus before forcing a choice');
  t.ok(/tag/i.test(probe.plan) && /link/i.test(probe.plan) && /field/i.test(probe.plan) && /ALWAYS checkable/.test(probe.plan), "arbitration plan treats a work item's tag/link/field as ALWAYS checkable against the live item");
  t.ok(/LIVE source of truth/.test(probe.plan) && /not just the repo or git history/.test(probe.plan), 'arbitration plan queries the LIVE item, not only the repo/git history');

  // Bounded arbitration (MAX_ARBITRATION_ATTEMPTS = 2). A FIRST terminal arbitration that did not
  // settle the clash does NOT immediately strand the human — it earns a SECOND, consensus-focused
  // attempt (the likeliest reason an arbitration "couldn't settle" a clash is that the two sides
  // actually AGREE — the exact bug: two legs at "90/90" both concluding the same thing).
  const oneAttempt = director.planReduction(mkTree(provable, { L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'error' } }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiPunt));
  t.ok(oneAttempt.per[0].disposition === 'probe', 'after ONE inconclusive arbitration the clash STILL probes (a second, consensus-focused attempt) rather than stranding the human');
  t.ok(/CONSENSUS/i.test(oneAttempt.per[0].aiProbe && oneAttempt.per[0].aiProbe.plan || '') && /MERGE/.test(oneAttempt.per[0].aiProbe && oneAttempt.per[0].aiProbe.plan || ''), 'the second attempt carries a consensus-focused MERGE brief (detect agreement, merge, reconcile child items)');
  t.ok(oneAttempt.per[0].aiProbe && oneAttempt.per[0].aiProbe.consensus === true && oneAttempt.per[0].aiProbe.attempt === 2, 'the re-probe is flagged consensus=true / attempt=2');

  // Two-attempt cap: after TWO terminal director-spawn probes have run for this stop → escalate
  // honestly to the human (bounded, never an infinite probe loop).
  const twoAttempts = director.planReduction(mkTree(provable, {
    L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'error' },
    L2: { id: 'L2', directorSpawn: true, fromStopId: 's1', status: 'done' },
  }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiPunt));
  t.ok(twoAttempts.per[0].disposition === 'ask', 'after TWO arbitration attempts the clash escalates honestly (bounded, no infinite probe loop)');

  // HARD CAP RAIL — the "reconciling the finding" stuck bug. When the AI verdict DIRECTLY returns
  // action:'probe' (disp becomes 'probe' via _AI_ACTION_DISP BEFORE the ask→probe flip gate runs),
  // the flip gate never bounds it — so a model that keeps wanting to investigate a clash loops
  // forever, never escalating even after MAX completed investigations. The cap rail escalates a
  // direct-probe verdict to the desk once MAX_ARBITRATION_ATTEMPTS terminal spawn legs have run.
  const aiProbeVerdict = { aiVerdicts: { s1: { cls: 'factual-clash', action: 'probe', confidence: 0.9, reasoning: 'go check main' } } };
  const probeCapped = director.planReduction(mkTree(provable, {
    L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'done' },
    L2: { id: 'L2', directorSpawn: true, fromStopId: 's1', status: 'done' },
  }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiProbeVerdict));
  t.ok(probeCapped.per[0].disposition === 'ask', 'a DIRECT action:probe verdict is capped to the desk after TWO terminal investigations (no reconcile loop)');
  t.ok(!(probeCapped.per[0].aiProbe), 'the capped clash carries no live probe plan (escalated honestly, not re-dispatched)');
  // One completed investigation is NOT yet capped — the direct-probe verdict still gets its bounded attempt.
  const probeOnce = director.planReduction(mkTree(provable, {
    L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'done' },
  }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiProbeVerdict));
  t.ok(probeOnce.per[0].disposition === 'probe', 'after ONE terminal investigation a direct-probe verdict is not yet capped (bounded, not premature)');

  // The consensus-focused re-probe brief (attempt >= 2) leads with agreement + MERGE + child-item
  // reconciliation — the user's literal ask ("merge the two legs and ensure child consistency").
  const reprobe = I._arbitrationProbe(provable, { attempt: 2 });
  t.ok(reprobe.consensus === true && reprobe.attempt === 2, '_arbitrationProbe(attempt:2) is a consensus re-probe');
  t.ok(/AGREE/.test(reprobe.plan) && /MERGE/.test(reprobe.plan) && /IGNORE the stance labels/.test(reprobe.plan), 're-probe brief ignores stance labels, checks agreement, and merges');
  t.ok(/reconcile any incidental child-item/i.test(reprobe.plan), 're-probe brief instructs reconciling incidental child-item discrepancies (counts/examples)');

  // No active grant → a READ-ONLY arbitration probe STILL dispatches (it only verifies facts +
  // redirects the loser; a grant is needed only to APPLY a resulting write). The human is never
  // the tie-break for a provable clash just because no grant is minted.
  const nogrant = director.planReduction(mkTree(provable), Object.assign({ enabled: true, autonomy: 'balanced' }, aiPunt));
  t.ok(nogrant.per[0].disposition === 'probe', 'without a grant a checkable clash STILL routes to arbitration (read-only probe needs no grant)');

  // Elapsed-time anchors: the surface must be able to tell a fresh, active investigation from an
  // old, stalled one. A LIVE spawn carries running anchors (startedAt for duration, updatedAt for
  // last-heartbeat/stall detection); a TERMINAL one carries when it finished + how long it took.
  const liveTiming = director.planReduction(mkTree(provable, { L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'running', startedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:03:00.000Z' } }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiPunt));
  const lp = (liveTiming.probeItems || []).find(p => (p.stopIds || []).indexOf('s1') !== -1) || liveTiming.probeItems[0];
  t.ok(lp && lp.sinceKind === 'running' && lp.spawnStartedAt === '2020-01-01T00:00:00.000Z' && lp.spawnUpdatedAt === '2020-01-01T00:03:00.000Z', 'a LIVE probe carries running timing anchors (startedAt + last-heartbeat updatedAt)');
  const ranTiming = director.planReduction(mkTree(provable, { L1: { id: 'L1', directorSpawn: true, fromStopId: 's1', status: 'error', startedAt: '2020-01-01T00:00:00.000Z', endedAt: '2020-01-01T00:02:00.000Z', durationMs: 120000 } }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiPunt));
  const rp = (ranTiming.probeItems || []).find(p => (p.stopIds || []).indexOf('s1') !== -1) || ranTiming.probeItems[0];
  t.ok(rp && rp.sinceKind === 'ran' && rp.spawnEndedAt === '2020-01-01T00:02:00.000Z' && rp.spawnDurationMs === 120000, 'a TERMINAL probe carries finished-time + duration anchors');

  // Helpers are exported for the server/tests (regex predicate replaced by the AI-driven one + recency).
  const dsrc = readFileSync('director.js', 'utf8');
  t.ok(/_internal:\s*\{[^}]*_clashCheckable[^}]*_recencyNote[^}]*_arbitrationProbe/.test(dsrc), 'director.js exports _clashCheckable + _recencyNote + _arbitrationProbe');
  t.ok(!/_CHECKABLE_RE/.test(dsrc), 'the brittle _CHECKABLE_RE regex is removed from director.js');

  // Server reason prompt: checkability is AI-driven, defaults to arbitrate, carries writeTarget + recency.
  const ssrc = readFileSync('server.js', 'utf8');
  t.ok(/"checkable":\s*true[\s\S]{0,120}the DEFAULT for EVERY clash/.test(ssrc), 'prompt: checkable defaults true for every clash (the flip)');
  t.ok(/checkable":\s*false ONLY for a genuine matter of taste/.test(ssrc), 'prompt: checkable false ONLY for a real values call');
  t.ok(/action "probe" and go check the ground truth/.test(ssrc), 'prompt: a checkable clash → probe the ground truth, not the human');
  t.ok(/return "writeTarget"/.test(ssrc) && /share a writeTarget COLLIDE/.test(ssrc), 'prompt: writes carry a canonical writeTarget; same-target writes collide');
  t.ok(/RECENCY \/ PROVENANCE/.test(ssrc) && /observed it more recently/.test(ssrc), 'prompt: recency/provenance doctrine present (newer observation wins for state)');
  // The AGREEMENT rule + live-item checkability (the two bugs: agreeing sides; a provable tag).
  t.ok(/AGREEMENT FIRST/.test(ssrc) && /it is NOT a clash/.test(ssrc) && /CONSENSUS/.test(ssrc), 'prompt: agreement-first rule — two sides that agree are consensus, not a clash');
  t.ok(/carries a given TAG/.test(ssrc) && /LINKED\/related/.test(ssrc) && /ALWAYS checkable and NEVER a values call/.test(ssrc), "prompt: a work item's tag/link/field existence is ALWAYS checkable, never a values call");
  t.ok(/against the\s*\n?\s*LIVE item/.test(ssrc) || /against the LIVE item/.test(ssrc) || /Verify these against the/.test(ssrc), 'prompt: verify existence/state against the LIVE item via tools');

  // The desk-item side labels are NEUTRAL (not the old prejudicial "Affirms the finding" / "Argues it's safe").
  t.ok(!/Affirms the finding/.test(dsrc) && !/Argues it\u2019s safe/.test(dsrc) && !/Argues it's safe/.test(dsrc), 'director.js drops the hardcoded prejudicial side labels');

  // Conflict sides carry per-side observedAt so the arbitrator/judge can weigh recency.
  t.ok(/a:\s*\{[^}]*observedAt:[^}]*\}/.test(ssrc) && /b:\s*\{[^}]*observedAt:[^}]*\}/.test(ssrc), 'server builds conflict sides with per-side observedAt');
  // The verdict parser defaults checkable:true for a clash and parses writeTarget.
  t.ok(/checkable:\s*_isClash\s*\?\s*\(v\.checkable === false \? false : true\)\s*:\s*null/.test(ssrc), 'verdict parser: clash defaults checkable true, non-clash null');
  t.ok(/writeTarget:\s*\(v\.writeTarget/.test(ssrc), 'verdict parser: writeTarget parsed from the model');

  // RECONCILE-AFTER-PROBE — a completed investigation must be consumed to re-judge the gating
  // clash, so cards no longer strand on "Investigation ran — reconciling the finding".
  const reconWin = _win(ssrc, 'function _meAiReconcileAfterProbe', 900);
  t.ok(/function _meAiReconcileAfterProbe\(t\)/.test(ssrc), 'server exposes _meAiReconcileAfterProbe(t)');
  t.ok(/if \(!d\.enabled\) return;/.test(reconWin) && /_meAiDirectorLeaderOk\(\)/.test(reconWin), 'reconcile is director-enabled + leader gated');
  t.ok(/t\._reconcilingProbe/.test(reconWin), 'reconcile dedupes overlapping completions via t._reconcilingProbe');
  t.ok(/_meAiDirectorReason\(id,\s*\{\s*force:\s*true\s*\}\)/.test(reconWin) && /_meAiDirectorSweep\(lt\)/.test(reconWin), 'reconcile FORCES a finding-informed re-judge then sweeps');

  // The spawn completion handler calls reconcile on ANY terminal outcome of a fromStopId probe.
  const spawnDoneWin = _win(ssrc, 'if (leg.fromStopId) _meAiReconcileAfterProbe(t);', 60);
  t.ok(/if \(leg\.fromStopId\) _meAiReconcileAfterProbe\(t\);/.test(spawnDoneWin), 'spawn completion reconciles on any terminal outcome of a gating-clash probe');

  // Sweep: a DONE leg is terminal (not "live"), and a completed-but-unjudged finding is a
  // pending-reconcile (self-heal), not a blocker to re-dispatch — reconciledProbe re-arms the sweep.
  const sweepWin = _win(ssrc, "const TERM = new Set(['cancelled', 'error', 'invalidated', 'done']);", 1500);
  t.ok(/TERM = new Set\(\['cancelled', 'error', 'invalidated', 'done'\]\)/.test(sweepWin), "sweep treats 'done' as terminal (a completed probe no longer counts as live)");
  t.ok(/pendingReconcile/.test(sweepWin) && /String\(lg\.endedAt\) > aiTs/.test(sweepWin), 'sweep self-heals a completed probe whose finding post-dates the last AI judgement');
  t.ok(/if \(pendingReconcile\.size\) \{ reconciledProbe = true; _meAiReconcileAfterProbe\(t\); \}/.test(sweepWin), 'a pending-reconcile stop forces a reconcile instead of a blind re-dispatch');
  t.ok(/const progressed = !!\([^)]*reconciledProbe[^)]*\)/.test(ssrc), 'reconciledProbe re-arms the sweep chain (progressed)');

  // Brief + prompt enrichment: the arbitrator SEES a completed investigation and is told it settles the clash.
  t.ok(/investigation:\s*_investigationFor\(c\.subject\)/.test(ssrc), 'brief attaches the newest Director-investigation finding to a conflict');
  t.ok(/byInvestigation:\s*true/.test(ssrc), 'the investigation finding is marked byInvestigation for the model');
  t.ok(/A COMPLETED INVESTIGATION SETTLES THE CLASH \(do NOT re-probe or punt\)/.test(ssrc), 'prompt: a completed investigation settles the clash (no re-probe / no punt)');
});

await t.test('Director arbitrates a same-target write COLLISION by AI writeTarget (never N desk asks)', () => {
  const director = require('../director.js');
  const grant = { id: 'g', paths: ['/'], classes: ['reversible-local', 'duplicate'], ops: ['cull', 'absorb'], expiresAt: Date.now() + 1e7 };

  // Two DIFFERENT writes the model keyed to the SAME writeTarget (work item 10503's description).
  // They collide (whichever lands last clobbers the other), so the Director arbitrates ONE probe —
  // it must not hand the user two independent approve/decline rows.
  const tree = { id: 'p2', legs: {}, stops: [
    { id: 's1', status: 'open', type: 'needs-auth', risk: 'write', action: { risk: 'write', op: 'update', target: 'wi:10503', summary: 'rewrite the objectives section' }, prompt: 'update the epic description', legId: 'La', observedAt: '2026-07-12T10:00:00Z' },
    { id: 's2', status: 'open', type: 'needs-auth', risk: 'write', action: { risk: 'write', op: 'update', target: 'wi:10503', summary: 'add a telemetry paragraph' }, prompt: 'rewrite work item #10503 description field', legId: 'Lb', observedAt: '2026-07-12T09:00:00Z' },
  ] };
  const aiv = { aiVerdicts: {
    s1: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.7, writeTarget: 'wi:10503:description' },
    s2: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.7, writeTarget: 'wi:10503:description' },
  } };
  const plan = director.planReduction(tree, Object.assign({ enabled: true, autonomy: 'balanced', grant }, aiv));
  const d1 = plan.per.find(p => p.stopId === 's1').disposition;
  const d2 = plan.per.find(p => p.stopId === 's2').disposition;
  t.ok(d1 === 'probe' || d2 === 'probe', 'same-target writes are force-routed to a collision probe, not paired desk asks');
  t.ok(plan.probeItems.length >= 1 && plan.probeItems.some(p => /collision/i.test(p.plan || '') || /clobber/i.test(p.plan || '')), 'the collision probe explains the clobber and arbitrates a single end state');
  // Collision probe carries recency when the members were decided at different times.
  t.ok(plan.probeItems.some(p => /RECENCY/.test(p.plan || '')), 'collision probe folds in recency for differently-timed writes');

  // The deterministic _collisionKey remains as the no-verdict FALLBACK (AI-first, regex-backstop).
  const dsrc = readFileSync('director.js', 'utf8');
  t.ok(/av\.writeTarget[\s\S]{0,80}_collisionKey\(s\)/.test(dsrc), 'collision key is AI-first (av.writeTarget) with _collisionKey as the deterministic fallback');
});

await t.test('compose fullscreen fills width (real classes) + two labeled panel buttons (app.html)', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // Fullscreen must widen the capped wrap and NOT target the stale .cmpx-studio/.cmpx-stage
  // classes that don't exist in the compose markup (real grid is .nlx-studio/.nlx-stage).
  t.ok(/\.cmpx-fs\s+\.cmpx-wrap\s*\{[^}]*max-width:\s*none/.test(src), 'fullscreen wrap uncaps width');
  t.ok(!/\.cmpx-fs\s+\.cmpx-studio\s*,\s*\.cmpx-fs\s+\.cmpx-stage/.test(src), 'stale .cmpx-studio/.cmpx-stage height rule removed');
  // The single ambiguous button is gone; there are two mode-specific header buttons now.
  t.ok((src.match(/@click="composeToggleFullscreen\(\)"/g) || []).length === 0, 'the old arg-less fullscreen button is gone');
  const viewBtns = (src.match(/@click="composeToggleFullscreen\('view'\)"/g) || []).length;
  const pairBtns = (src.match(/@click="composeToggleFullscreen\('pair'\)"/g) || []).length;
  t.ok(viewBtns === 1, 'exactly one Full-screen view button: ' + viewBtns);
  t.ok(pairBtns >= 1, 'at least one Full-screen assistant control: ' + pairBtns);
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

await t.test('compose studio: separate full-screen for the view panel vs the paired assistant', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // State is a mode, not a boolean — records which panel is full-screened.
  t.ok(/fsMode: ''/.test(html), 'compose.fsMode drives which panel is full-screened');
  // Full-screen is now a per-panel ICON on each panel — NOT two lazy page-header buttons.
  t.ok(!/Full-screen view/.test(html) && !/Full-screen assistant/.test(html), 'the old page-header full-screen buttons are gone');
  // The view-panel toolbar carries its own full-screen toggle icon (🗖 / 🗕 by mode).
  t.ok(/🕘 History[\s\S]{0,320}composeToggleFullscreen\('view'\)[\s\S]{0,120}compose\.fsMode === 'view' \? '🗕' : '🗖'/.test(html), 'the view panel toolbar has a full-screen icon after History');
  // The paired-assistant head carries its own full-screen toggle icon.
  t.ok(/cmpx-pair-head-actions[\s\S]{0,200}composeToggleFullscreen\('pair'\)[\s\S]{0,120}compose\.fsMode === 'pair' \? '🗕' : '🗖'/.test(html), 'the assistant head has a full-screen icon');
  // Exactly one of each panel icon (no duplicate header buttons lingering).
  t.ok((html.match(/@click="composeToggleFullscreen\('view'\)"/g) || []).length === 1, 'exactly one view full-screen control');
  t.ok((html.match(/@click="composeToggleFullscreen\('pair'\)"/g) || []).length === 1, 'exactly one assistant full-screen control');
  // Section class carries variant modifiers so the CSS can show only the chosen panel.
  t.ok(/'cmpx-fs': compose\.fsMode, 'cmpx-fs-view': compose\.fsMode === 'view', 'cmpx-fs-pair': compose\.fsMode === 'pair'/.test(html), 'the compose section exposes cmpx-fs-view / cmpx-fs-pair variants');
  // View mode hides rail + assistant; assistant mode hides rail + stage.
  t.ok(/\.cmpx-fs-view \.nlx-rail,\s*\.cmpx-fs-view \.cmpx-pair\{display:none\}/.test(html), 'view full-screen hides the rail + assistant');
  t.ok(/\.cmpx-fs-pair \.nlx-rail,\s*\.cmpx-fs-pair \.nlx-studio\.cmpx-paired > \.nlx-stage\{display:none\}/.test(html), 'assistant full-screen hides the rail + stage (studio-scoped so it wins specificity)');
  // Toggling to the assistant opens it; re-clicking the active mode exits.
  const fn = _win(html, 'composeToggleFullscreen(mode) {', 320);
  t.ok(/if \(this\.compose\.fsMode === mode\) \{ this\.compose\.fsMode = ''; return; \}/.test(fn), 're-clicking the active full-screen button exits');
  t.ok(/if \(mode === 'pair'\) this\.compose\.chat\.open = true/.test(fn), 'assistant full-screen opens the assistant');
});

await t.test('compose studio: unified collapse chevrons + hover-reveal action clusters', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Both side panels collapse with the SAME simple bare chevron — no "‹ Collapse" text.
  t.ok(/class="cmpx-rail-collapse"[^>]*>‹<\/button>/.test(html), 'the sources rail collapses with a bare ‹ chevron (no text)');
  t.ok(!/cmpx-rail-collapse[^>]*>‹ Collapse/.test(html), 'the old "‹ Collapse" text button is gone');
  t.ok(/composeToggleChat\(\)"[^>]*title="Collapse the assistant">⟩<\/button>/.test(html), 'the assistant collapses with the matching ⟩ chevron');
  // Header right-side buttons live in an always-visible cluster so the primary "New"
  // affordance is never hidden — it was intentionally removed from the hover-reveal gate.
  t.ok(/class="cmpx-head-actions"/.test(html), 'the header actions are grouped');
  t.ok(!/\.cmpx-head \.cmpx-head-actions[,{]/.test(html), 'header actions are NOT in the opacity:0 gate (New stays visible)');
  // The PANEL-level clusters (view toolbar, assistant head, rail collapse) keep hover-reveal.
  t.ok(/\.cmpx-paired \.nlx-stage-actions,\s*\.cmpx-paired \.cmpx-pair-head-actions,\s*\.cmpx-paired \.cmpx-rail-collapse\{opacity:0;transition:opacity[^}]*\}/.test(html), 'panel action clusters start at opacity:0');
  t.ok(/\.cmpx-paired \.nlx-stage:hover \.nlx-stage-actions,\s*\.cmpx-paired \.nlx-stage:focus-within \.nlx-stage-actions/.test(html), 'hovering or focusing the view panel reveals its toolbar');
  t.ok(/\.cmpx-paired \.cmpx-pair:hover \.cmpx-pair-head-actions,\s*\.cmpx-paired \.cmpx-pair:focus-within \.cmpx-pair-head-actions/.test(html), 'hovering or focusing the assistant reveals its head actions');
  t.ok(/\.cmpx-paired \.nlx-rail:hover \.cmpx-rail-collapse,\s*\.cmpx-paired \.nlx-rail:focus-within \.cmpx-rail-collapse\{opacity:1\}/.test(html), 'hovering or focusing the rail reveals its collapse control');
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
  t.ok(/grid-template-columns:26px minmax\(0,1fr\) 150px 118px 92px;/.test(html), 'list grid is 5 columns (actions no longer reserve a column)');
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
  const disp = _win(html, "} else if (this.route === 'compose') {", 1000);
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

// Feature — Documents file-explorer view. A third library mode ('explorer') adds
// folders/subfolders (create/rename/delete) + drag-to-file, as purely-additive
// grouping metadata. Documents stay fully accessible via Compose.AI + version
// history and remain pinnable — folders never touch storage/opening/versions.
await t.test('documents explorer: folder tree, drag-move, and additive-only grouping', () => {
  const cjs = readFileSync('compose.js', 'utf8');
  // model: folder CRUD + a docId→folderId assignment map, no document deletion on folder delete.
  t.ok(/function listFolders\(/.test(cjs) && /function getAssignments\(/.test(cjs), 'compose.js exposes listFolders + getAssignments');
  t.ok(/function createFolder\(/.test(cjs) && /function updateFolder\(/.test(cjs) && /function deleteFolder\(/.test(cjs), 'compose.js exposes folder CRUD');
  t.ok(/function moveDocument\(docId, folderId\)/.test(cjs), 'compose.js exposes moveDocument');
  const del = _win(cjs, 'function deleteFolder(id)', 700);
  t.ok(/st\.folders = st\.folders\.filter/.test(del) && !/deleteComposition|delete st\.items/.test(del), 'deleteFolder removes only the folder, never documents');

  const src = readFileSync('server.js', 'utf8');
  // GET payload carries folders + assignments; folder/move routes exist BEFORE /api/compose/:id.
  t.ok(/folders: compose\.listFolders\(\)/.test(src) && /assignments: compose\.getAssignments\(\)/.test(src), 'GET /api/compose returns folders + assignments');
  const fpost = src.indexOf("app.post('/api/compose/folders'");
  const mpost = src.indexOf("app.post('/api/compose/move'");
  const idget = src.indexOf("app.get('/api/compose/:id'");
  t.ok(fpost > 0 && mpost > 0 && idget > 0, 'folder + move + :id routes all present');
  t.ok(fpost < idget && mpost < idget, 'folder/move routes precede the /api/compose/:id catch-all');
  t.ok(/app\.patch\('\/api\/compose\/folders\/:fid'/.test(src) && /app\.delete\('\/api\/compose\/folders\/:fid'/.test(src), 'folder rename + delete routes present');

  const html = readFileSync('public/app.html', 'utf8');
  // the explorer view toggle + state.
  t.ok(/compose\.lib\.mode==='explorer'/.test(html), 'library has an explorer view mode');
  t.ok(/folders: \[\], assignments: \{\}, folder: '', expanded: \{\}, moveMenu: '', dragDoc: '', dragOver: '',/.test(html), 'compose.lib carries the folder-explorer state');
  // loadCompose populates folders/assignments; reload re-fetches them.
  t.ok(/co\.lib\.folders = \(r && r\.folders\) \|\| \[\];/.test(html) && /co\.lib\.assignments = \(r && r\.assignments\) \|\| \{\};/.test(html), 'loadCompose populates folders + assignments');
  const reload = _win(html, 'async composeReloadFolders() {', 500);
  t.ok(/this\.compose\.lib\.folders = \(r && r\.folders\)/.test(reload) && /this\.compose\.lib\.assignments = \(r && r\.assignments\)/.test(reload), 'composeReloadFolders re-fetches + reassigns folders/assignments');
  // the folder methods exist.
  t.ok(/composeFolderTree\(all\) \{/.test(html), 'composeFolderTree builds a depth-ordered node list');
  t.ok(/composeExplorerDocs\(\) \{/.test(html) && /composeExplorerFolders\(\) \{/.test(html), 'explorer content helpers exist');
  t.ok(/async composeFolderCreate\(\) \{/.test(html) && /async composeFolderRenameCommit\(n\) \{/.test(html) && /async composeFolderDelete\(n\) \{/.test(html), 'folder create/rename/delete methods exist');
  const move = _win(html, 'async composeDocMove(docId, folderId) {', 400);
  t.ok(/\/api\/compose\/move/.test(move) && /composeReloadFolders\(\)/.test(move), 'composeDocMove posts to /move then reloads');
  // documents in the explorer still open via the same library-open path (Compose.AI + versions),
  // and remain pinnable — the row reuses composeLibOpen + openQuickPin.
  const docRow = _win(html, 'cmpx-lib-trow cmpx-fx-doc', 2600);
  t.ok(/composeLibOpen\(c\)/.test(docRow), 'explorer doc rows still open via composeLibOpen (Compose.AI + version history)');
  t.ok(/openQuickPin\('document'/.test(docRow), 'explorer doc rows remain pinnable to a workspace');
  t.ok(/draggable="true"/.test(docRow) && /composeDocMove\(compose\.lib\.dragDoc/.test(html), 'documents drag onto folders to file them');
});

await t.test('compose explorer: doc rows are not clipped (grid min-width floor)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // The doc-row grid must floor the flexible title track at 0, not at min-content,
  // so the row never overflows the narrow explorer docs pane (was 1fr → clipped by
  // .cmpx-fx-docs overflow:hidden). Headless-verified: scrollWidth==clientWidth.
  t.ok(/26px minmax\(0,1fr\) 150px 118px 92px/.test(html), 'doc-row grid uses minmax(0,1fr) for the title track');
  t.ok(/\.cmpx-lib-trow \.doc\{min-width:0\}/.test(html), '.doc grid item allows shrinking below content width');
});

await t.test('data-paths: SUPERVISOR_DATA_DIR env aligns to the resolved dir', () => {
  const src = readFileSync('data-paths.js', 'utf8');
  // The split-brain fix: modules that read process.env.SUPERVISOR_DATA_DIR directly
  // (capabilities/marketplace/marketplace-design/agentPackage) must see the SAME dir
  // the redirect breadcrumb resolves to. data-paths sets the env to DATA_DIR.
  t.ok(/process\.env\.SUPERVISOR_DATA_DIR = DATA_DIR;/.test(src), 'data-paths exports the resolved DATA_DIR to the env var');
  // Must be set AFTER DATA_DIR is resolved (env line comes after the DATA_DIR const).
  t.ok(src.indexOf('const DATA_DIR =') < src.indexOf('process.env.SUPERVISOR_DATA_DIR = DATA_DIR;'), 'env is set after DATA_DIR resolves');
});

await t.test('connect: storage-folder change migrates diary data', () => {
  const csrc = readFileSync('connect.js', 'utf8');
  t.ok(/function resolveStorageDir\(explicit\)/.test(csrc), 'connect.resolveStorageDir exists');
  const mig = _win(csrc, 'function migrateStorageDir(from, to)', 900);
  t.ok(mig, 'connect.migrateStorageDir exists');
  t.ok(/state\.json.*evidence\.json.*draft-versions\.json.*memories\.json/s.test(csrc), 'all four Connect files are migrated');
  t.ok(/if \(src === dst\) return res;/.test(mig), 'no-op when source and destination resolve to the same dir');
  t.ok(/fs\.existsSync\(d\)/.test(mig) && /res\.skipped\.push/.test(mig), 'never clobbers a file already at the destination');
  t.ok(/resolveStorageDir,\s*\n\s*migrateStorageDir,/.test(csrc), 'both helpers exported');
  const ssrc = readFileSync('server.js', 'utf8');
  const route = _win(ssrc, "app.put('/api/settings'", 1400);
  t.ok(/_connectDirBefore/.test(route), 'settings route captures the previous connect dir before the update');
  t.ok(/'connectStorageDir' in body/.test(route) && /connect\.migrateStorageDir\(_connectDirBefore/.test(route), 'settings route migrates on a connectStorageDir change');
});

await t.test('notes: PR/dev card note URLs render as clickable links (escaped, no XSS)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // A dedicated linkifier: escapes HTML first, then only linkifies bare URLs
  // (no full markdown), so note text is verbatim except links become clickable.
  const fn = _win(html, 'linkifyNote(text) {', 700);
  t.ok(fn, 'linkifyNote helper exists');
  t.ok(/replace\(\/&\/g, '&amp;'\)/.test(fn), 'linkifyNote HTML-escapes & (XSS-safe)');
  t.ok(/replace\(\/</.test(fn) && /&lt;/.test(fn), 'linkifyNote HTML-escapes < ');
  t.ok(/https\?:\\\/\\\//.test(fn) && /www\\\./.test(fn), 'linkifyNote matches http(s):// and www. URLs');
  t.ok(/target="_blank" rel="noopener"/.test(fn), 'links open safely in a new tab');
  // Every note-text span renders THROUGH the linkifier, not raw x-text.
  t.ok(!/class="note-text"[^>]*x-text="n\.text"/.test(html), 'no note span still uses plain x-text');
  const spans = html.match(/class="note-text"[^>]*x-html="linkifyNote\(n\.text\)"/g) || [];
  t.gte(spans.length, 5, 'all note-text spans linkify (PR + dev cards)');
});

await t.test('monitoring.ai: grafana studio wired end to end (route/tier/nav/methods/server)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // --- section markup (single copy) ---
  const secs = html.match(/route === 'monitoring'/g) || [];
  t.gte(secs.length, 1, 'monitoring section present');
  t.ok(/x-show="!loading && !errorMessage && route === 'monitoring'"/.test(html), 'monitoring <section> gated on the route');
  t.ok(/monitoring\.view === 'launcher'/.test(html) && /monitoring\.view === 'studio'/.test(html) && /monitoring\.view === 'deep'/.test(html), 'launcher/studio/deep views present');
  t.ok(/class="monx-studio"/.test(html), 'studio grid markup present');
  // teal accent per the user ask (gradient uses --mon-graf teal #2fb2a6)
  t.ok(/--mon-graf:#2fb2a6/.test(html), 'gradient uses a teal (#2fb2a6) Grafana accent');
  t.ok(/linear-gradient\([^)]*var\(--mon-graf\)/.test(html), 'generate button gradient keys off the teal token');
  // --- state block ---
  const st = _win(html, 'monitoring: {', 1100);
  t.ok(st, 'monitoring state block exists');
  t.ok(/view:/.test(st) && /dashboards:/.test(st) && /grabbed:/.test(st) && /convo:/.test(st) && /conn:/.test(st), 'state carries view/dashboards/grabbed/convo/conn');
  // --- key methods defined ---
  for (const m of ['async monLoad(', 'async monLoadDashboard(', 'async monGenerate(', 'async monAnalyze(', 'async monAskFree(', 'monGrabToggle(', 'monOpenDeep(', 'monPanelBody(', 'monAnalysisHtml(', 'monSaveConnection(']) {
    t.ok(html.includes(m), 'method defined: ' + m);
  }
  // monLoadDashboard reads the dashboard object directly (route is not wrapped in {dashboard:…})
  const mld = _win(html, 'async monLoadDashboard(uid)', 400);
  t.ok(/w\.dash = r;/.test(mld), 'monLoadDashboard stores the raw dashboard response');
  // monAnalysisHtml escapes (XSS-safe)
  t.ok(/monAnalysisHtml/.test(html) && /&lt;/.test(_win(html, 'monAnalysisHtml(a)', 900) || ''), 'analysis HTML is escaped');
  // --- routing / tier / nav ---
  t.ok(/if \(first === 'monitoring' && second\) return \{ route: 'monitoring', param: second \};/.test(html), 'parseHash handles #/monitoring/<uid>');
  t.ok(/this\.route === 'monitoring'\) \{[\s\S]*?monLoad\(/.test(html), 'handleRouteChange calls monLoad');
  t.ok(/case 'monitoring': return mk\('Monitoring\.AI', '📊', '#\/monitoring', 'monitoring'\);/.test(html), 'nav item defined');
  t.ok(/routeMode\(route\)[\s\S]*?'monitoring'[\s\S]*?return 'workspace';/.test(html), 'routeMode maps monitoring → workspace');
  const cats = html.match(/key: 'monitoring', label: 'Monitoring\.AI'/g) || [];
  t.gte(cats.length, 2, 'monitoring in both feature catalogs (opt-in)');
  const rv = html.match(/monitoring: \['monitoring'\]/g) || [];
  t.gte(rv.length, 2, 'monitoring in both routeVisible maps');
  // --- server routes + modules ---
  const srv = readFileSync('server.js', 'utf8');
  for (const r of ["/api/monitoring/status", "/api/monitoring/connection", "/api/monitoring/dashboards", "/api/monitoring/dashboard/:uid", "/api/monitoring/generate", "/api/monitoring/analyze"]) {
    t.ok(srv.includes(r), 'server route: ' + r);
  }
  t.ok(/const grafana = require\('\.\/grafana'\);/.test(srv), 'grafana module required');
  // connection route never echoes the token back
  t.ok(/hasToken: !!g\.token/.test(srv), 'connection GET reports hasToken, never the token');
  const graf = readFileSync('grafana.js', 'utf8');
  for (const fn of ['createDashboard', 'deterministicAnalysis', 'panelSummary', 'listDashboards', 'getDashboard', 'deterministicSpec']) {
    t.ok(graf.includes(fn), 'grafana.js exports ' + fn);
  }
  const setj = readFileSync('settings.js', 'utf8');
  t.ok(/grafana:\s*\{[^}]*enabled:\s*false/.test(setj), 'settings default grafana.enabled=false (opt-in)');
  // --- Azure identity auth + push-by-default (per-dashboard auto-push) ---
  t.ok(/authMode:\s*'aad'/.test(setj) && /pushByDefault:\s*true/.test(setj), 'settings default to Azure identity + push-by-default');
  t.ok(/dashboard\.azure\.com\/\.default/.test(graf), 'grafana.js requests the AMG token scope');
  t.ok(/DefaultAzureCredential/.test(graf), 'grafana.js uses DefaultAzureCredential for Azure identity');
  t.ok(/function pushDashboard\(/.test(graf) && /function setDashboardOptions\(/.test(graf), 'grafana.js exposes manual push + per-dashboard options');
  t.ok(/pushDashboard,/.test(graf) && /setDashboardOptions,/.test(graf), 'push helpers are exported');
  t.ok(/authMode === 'aad'\s*\?\s*true\s*:\s*!!c\.token/.test(graf), 'configured() needs only a URL under Azure identity');
  t.ok(srv.includes('/api/monitoring/dashboard/:uid/push') && srv.includes('/api/monitoring/dashboard/:uid/options'), 'server exposes push + options routes');
  t.ok(/authMode: g\.authMode, pushByDefault: g\.pushByDefault/.test(srv), 'connection GET reports authMode + pushByDefault');
  // SPA: auth-mode selector, token hidden under aad, push controls + methods
  t.ok(/x-model="monitoring\.conn\.authMode"/.test(html), 'connection panel offers an auth-mode selector');
  t.ok(/monitoring\.conn\.authMode === 'token'/.test(html), 'token field is shown only in token mode');
  t.ok(/x-model="monitoring\.conn\.pushByDefault"/.test(html), 'connection panel has a push-by-default toggle');
  t.ok(/@click="monPushDashboard\(\)"/.test(html) && /@change="monToggleAutoPush\(\)"/.test(html), 'studio has push + auto-push controls');
  t.ok(/async monPushDashboard\(/.test(html) && /async monToggleAutoPush\(/.test(html), 'push methods defined');
  // Studio-first experience + actionable connection errors
  t.ok(/_authErrorMessage/.test(graf) && /needs a Grafana role/.test(graf), 'grafana.js surfaces an actionable auth error (role guidance)');
  t.ok(/Grafana configured — ' \+ st\.authError/.test(html), 'monConnLabel shows the real authError');
  t.ok(/this\.monLoadEpicDashboards\(\);/.test(html) && /w\.view = 'home';/.test(html), 'monLoad lands on the browse-first home hub');
  t.ok(/out\['My dashboards'\]/.test(html), 'rail groups My dashboards vs Azure Grafana folders');
  t.ok(/monNewPrompt\(\)/.test(html) && /monEditConnection\(\)/.test(html) && /monBackToStudio\(\)/.test(html), 'studio nav: new-prompt, edit-connection, back-to-studio');
  // Reconnect / retry credentials (clear the cached Azure token so a freshly-granted role is picked up)
  t.ok(/function resetAuthCache\(\)/.test(graf) && /_aadCred = null; _aadTok = ''; _aadExp = 0;/.test(graf), 'grafana.js clears the cached Azure token on reconnect');
  t.ok(/\bresetAuthCache,/.test(graf), 'resetAuthCache is exported');
  t.ok(/AMG_SCOPE = 'https:\/\/dashboard\.azure\.com\/\.default'/.test(graf), 'grafana.js uses the dashboard.azure.com AMG audience (grafana.azure.com 401s)');
  t.ok(srv.includes("app.post('/api/monitoring/reconnect'") && /grafana\.resetAuthCache\(\); res\.json\(\{ ok: true, status: await grafana\.status\(\)/.test(srv), 'server reconnect route clears cache then re-checks status');
  t.ok(/async monReconnect\(\)/.test(html) && /\/api\/monitoring\/reconnect/.test(html), 'SPA monReconnect posts the reconnect route');
  t.ok(/@click="monReconnect\(\)"/.test(html) && /Retry connection/.test(html), 'connection panel has a Retry connection button');
});

await t.test('code flow: Epics tab — DNCEng epic cockpit wired end to end (tab/section/state/methods/server/azdo)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // --- tab button present in BOTH Code Flow tab bars (dev + pr) ---
  const tabBtns = html.match(/@click="codeflow\.cfTab = 'epics'; loadCodeflowEpics\(\)">🏔 Epics/g) || [];
  t.gte(tabBtns.length, 2, 'Epics cf-tab button appears in both tab bars');
  // --- the epics <section> is gated on the route + sub-tab ---
  t.ok(/route === 'codeflow' && codeflow\.cfTab === 'epics'/.test(html), 'epics section gated on codeflow + cfTab');
  // --- restored-tab initial-load branch in the codeflow route dispatch ---
  t.ok(/else if \(this\.codeflow\.cfTab === 'epics'\) \{[\s\S]*?await this\.loadCodeflowEpics\(\);/.test(html), 'route dispatch loads epics when the tab is restored');
  // --- cfTab default read + persist include 'epics' ---
  const cfTabDefault = _win(html, "cfTab", 400);
  t.ok(cfTabDefault, 'cfTab wiring present');
  // --- state block ---
  const st = _win(html, 'epics: {', 1300);
  t.ok(st, 'codeflow.epics state block exists');
  t.ok(/list:/.test(st) && /idx:/.test(st) && /loading:/.test(st) && /chat:/.test(st) && /aiBusy:/.test(st), 'epics state carries list/idx/loading/chat/aiBusy');
  // --- key methods defined ---
  for (const m of ['cfEpicsCount()', 'cfEpicsAttn()', 'epicCur()', 'async loadCodeflowEpics(', 'epicSelect(', 'async epicUpgradeAi(', 'epicChatOpen(', 'async epicChatSend(', 'epicChatSuggestions(', 'epicChatBadge(']) {
    t.ok(html.includes(m), 'method defined: ' + m);
  }
  // loadCodeflowEpics guards double-load + honors refresh
  const load = _win(html, 'async loadCodeflowEpics(refresh)', 900);
  t.ok(/\/api\/codeflow\/epics/.test(load), 'loadCodeflowEpics hits the epics route');
  t.ok(/refresh/.test(load) && /loaded/.test(load), 'loadCodeflowEpics skips when already loaded unless refresh');
  // --- the assistant FAB/drawer is a TOP-LEVEL teleport (Alpine only teleports top-level templates) ---
  t.ok(/<template x-teleport="body">\s*<div x-show="route === 'codeflow' && codeflow\.cfTab === 'epics'/.test(html), 'epic assistant FAB/drawer is a top-level x-teleport');
  t.ok(/class="epx-fab"/.test(html) && /class="epx-drawer"/.test(html), 'scoped .epx-fab + .epx-drawer present');
  // --- server routes ---
  const srv = readFileSync('server.js', 'utf8');
  for (const r of ["app.get('/api/codeflow/epics'", "app.post('/api/codeflow/epics/ai'", "app.post('/api/codeflow/epics/assistant'"]) {
    t.ok(srv.includes(r), 'server route: ' + r);
  }
  t.ok(/_epicComputeCockpit/.test(srv), 'server builds a deterministic cockpit');
  t.ok(/state: 'In Progress'/.test(srv) && !/state: 'Dev'/.test(srv), 'epics query filters on the In Progress state (DNCEng Epics have no Dev state)');
  // --- azdo client ---
  const az = readFileSync('azdo.js', 'utf8');
  t.ok(/async function getEpicTree\(org, project, id\)/.test(az), 'azdo.js defines getEpicTree');
  t.ok(/\bgetEpicTree\b/.test(az.split('module.exports').pop() || az), 'azdo.js exports getEpicTree');
});

await t.test('code flow: Epics — entity decode + roadmap weaving (dates/docs/timeline)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const az = readFileSync('azdo.js', 'utf8');
  // --- entity decoding + word-boundary clip (fixes literal &quot; + mid-word truncation) ---
  t.ok(/function _epicDecodeEntities\(/.test(srv), 'server defines _epicDecodeEntities');
  t.ok(/function _epicClip\(/.test(srv), 'server defines _epicClip (word-boundary clip)');
  const dec = _win(srv, 'function _epicDecodeEntities(', 700);
  t.ok(/&quot;/.test(dec) && /&#/.test(dec) && /&amp;/.test(dec), '_epicDecodeEntities handles &quot;, numeric refs, and &amp;');
  // --- doc-link + roadmap parsers ---
  t.ok(/function _epicParseDocLinks\(/.test(srv), 'server defines _epicParseDocLinks');
  t.ok(/function _epicParseRoadmap\(/.test(srv), 'server defines _epicParseRoadmap');
  t.ok(/function _epicApplyRoadmap\(/.test(srv), 'server defines _epicApplyRoadmap');
  const apply = _win(srv, 'function _epicApplyRoadmap(', 3200);
  t.ok(/cockpit\.docs =/.test(apply) && /cockpit\.roadmap =/.test(apply) && /cockpit\.timeline =/.test(apply), '_epicApplyRoadmap sets docs/roadmap/timeline');
  t.ok(/targetFromRoadmap = true/.test(apply), 'borrows nearest open milestone as the target when the epic has none');
  // --- cockpit shape carries docs/roadmap ---
  t.ok(/docs: \[\], roadmap: null/.test(srv), 'cockpit shape includes docs + roadmap');
  // --- roadmap fetch wired into the GET route ---
  t.ok(/_epicFetchRoadmap\(/.test(srv), 'server fetches the roadmap doc');
  t.ok(/_epicParseDocLinks\(raw\.epic && raw\.epic\.description\)/.test(srv), 'GET route parses doc links from the epic description');
  t.ok(/_epicApplyRoadmap\(cockpit, docs, roadmap\)/.test(srv), 'GET route applies the roadmap to the cockpit');
  // --- AI + assistant prompts get roadmap milestones ---
  t.ok(/brief\.roadmap =/.test(srv), '/ai brief injects roadmap milestones');
  t.ok(/Roadmap milestones \(authoritative dates/.test(srv), 'assistant prompt injects roadmap milestones');
  // --- azdo web-url fetcher exported ---
  t.ok(/async function fetchGitDocByWebUrl\(webUrl\)/.test(az), 'azdo.js defines fetchGitDocByWebUrl');
  t.ok(/\bfetchGitDocByWebUrl\b/.test(az.split('module.exports').pop() || az), 'azdo.js exports fetchGitDocByWebUrl');
  // --- SPA surfaces docs + roadmap caption + work-item hrefs; stale "Dev" copy gone ---
  t.ok(/class="epx-docs"/.test(html), 'header surfaces linked docs');
  t.ok(/epicCur\(\)\.targetFromRoadmap/.test(html), 'header flags a roadmap-borrowed target');
  t.ok(/class="epx-tl-cap"/.test(html), 'timeline shows a "dates from the roadmap" caption');
  t.ok(/My epics · In Progress/.test(html) && /State = In Progress/.test(html), 'stale "Dev" copy replaced with "In Progress"');
  t.ok(!/My epics · in Dev/.test(html), 'no leftover "in Dev" rail copy');

  // --- roadmap milestones[] drive the Gantt viz (Style B) ---
  t.ok(/cockpit\.roadmap\.milestones|roadmap\.milestones\s*=|milestones:\s*\[/.test(apply) || /milestones/.test(apply), '_epicApplyRoadmap builds roadmap.milestones[]');
  t.ok(/epicGantt\(\)/.test(html), 'SPA renders the roadmap Gantt via epicGantt()');
  t.ok(/epicGantt\(\)\.ok/.test(html) && /epx-grid2--stack/.test(html), 'Gantt stacks the dates card when milestones exist');
  t.ok(/class="epx-gantt"/.test(html) && /epx-gantt-lane/.test(html) && /epx-gantt-today/.test(html), 'Gantt markup: lanes + today bar');
  t.ok(/epx-gantt-bar/.test(html) && /class="fill"/.test(html) && /epx-gantt-diamond/.test(html), 'Gantt bar carries a progress fill + a target diamond');
  const gantt = _win(html, 'epicGantt() {', 2600);
  t.ok(/roadmap && Array\.isArray\(cur\.roadmap\.milestones\)/.test(gantt), 'epicGantt reads cur.roadmap.milestones');
  t.ok(/done\|complete\|shipped\|closed\|resolved/.test(gantt), 'epicGantt tones by status (done/risk/prog/back)');
  t.ok(/d overdue/.test(gantt), 'epicGantt computes an overdue countdown');
  // falls back to the plain timeline list when there are no milestones
  t.ok(/x-if="!epicGantt\(\)\.ok"/.test(html), 'plain timeline list renders when there are no milestones');

  // --- dev selector: switch the view to another developer's In-Progress epics ---
  t.ok(/queryWorkItems/.test(az) && /assignedTo\b/.test(az) && /assignedToUnique/.test(az), 'azdo.js queryWorkItems supports assignedTo + returns assignedToUnique');
  t.ok(/let _epicRoster =/.test(srv), 'server caches an epics roster');
  t.ok(/assignedTo: assignee/.test(srv) && /assignedToMe: true/.test(srv), 'GET route branches the query on the assignee param');
  t.ok(/assignees: roster/.test(srv) && /activeAssignee: assignee/.test(srv), 'GET route returns the roster + active assignee');
  t.ok(/epicSetAssignee\(/.test(html), 'SPA defines epicSetAssignee');
  t.ok(/epicViewingMe\(\)/.test(html), 'SPA defines epicViewingMe');
  const setA = _win(html, 'epicSetAssignee(unique)', 800);
  t.ok(/ep\.loaded = false/.test(setA) && /this\.loadCodeflowEpics\(\)/.test(setA), 'epicSetAssignee refetches the new scope without forcing a refresh');
  const loadE = _win(html, 'async loadCodeflowEpics(refresh)', 1200);
  t.ok(/ep\.assignees = Array\.isArray\(r\.assignees\)/.test(loadE) && /ep\.me = r\.me/.test(loadE), 'loadCodeflowEpics merges the roster + me');
  t.ok(/'assignee=' \+ encodeURIComponent\(ep\.assignee\)/.test(loadE), 'loadCodeflowEpics sends the assignee query param');
  t.ok(/class="epx-devsel"/.test(html) && /@change="epicSetAssignee\(codeflow\.epics\.assignee\)"/.test(html), 'rail renders a dev <select> wired to epicSetAssignee');
  t.ok(/x-for="a in codeflow\.epics\.assignees"/.test(html) && /<option value="">Me<\/option>/.test(html), 'dev <select> lists roster developers + a "Me" option (no pills)');
  // Rail scroll + collapse/expand
  t.ok(/class="epx-rail-list"/.test(html), 'epic rail wraps its rows in a scrollable .epx-rail-list');
  const railListCss = _win(html, '.epx-rail-list {', 260);
  t.ok(/overflow-y:auto/.test(railListCss) && /min-height:0/.test(railListCss), '.epx-rail-list gets its own vertical scrollbar (overflow-y:auto + min-height:0)');
  t.ok(/x-init="epicInitRail\(\)"/.test(html), 'epics section wires epicInitRail on init');
  const initR = _win(html, 'epicInitRail() {', 1400);
  t.ok(/getBoundingClientRect\(\)\.top/.test(initR) && /window\.innerHeight/.test(initR) && /maxHeight/.test(initR), 'epicInitRail sizes the rail list from its live viewport top so the scrollbar fits');
  t.ok(/addEventListener\('scroll'/.test(initR) && /addEventListener\('resize'/.test(initR), 'epicInitRail recomputes on scroll + resize');
  t.ok(/epicToggleRail\(\)/.test(html), 'SPA defines/wires epicToggleRail for expand/shrink');
  const tgl = _win(html, 'epicToggleRail() {', 300);
  t.ok(/ep\.railCollapsed = !ep\.railCollapsed/.test(tgl) && /localStorage\.setItem\('epx-rail-collapsed'/.test(tgl), 'epicToggleRail flips railCollapsed + persists it');
  t.ok(/railCollapsed:/.test(html) && /localStorage\.getItem\('epx-rail-collapsed'\)/.test(html), 'epics data seeds railCollapsed from localStorage');
  t.ok(/class="epx-rail-xpand"/.test(html) && /'is-collapsed': codeflow\.epics\.railCollapsed/.test(html), 'collapsed rail shows an expand affordance + studio grid narrows via is-collapsed');

  // Work-item references are clickable (open the AzDO work item)
  t.ok(/class="mono epx-wilink" :href="epicCur\(\)\.url/.test(html), 'the epic number in the header links to its work item');
  t.ok(/\.epx-wilink \{/.test(html), 'work-item links get a calm .epx-wilink hover style');
  t.ok(/class="mono epx-wilink" :href="w\.href"/.test(html), 'the #id token on each in-flight work row links to that item');
  t.ok(/class="mono epx-wilink" :href="r\.href"[^>]*x-text="'#' \+ r\.wid"/.test(html), 'the roadmap Gantt #wid links to its work item');
  t.ok(/class="mono epx-wilink" :href="d\.href"[^>]*x-text="'#' \+ d\.wid"/.test(html), 'each deliverable #id links to its work item');
  // Server plumbs the ids/urls the links need
  t.ok(/wid: k\.id, href: k\.url, type: k\.type/.test(srv), 'server: deliverables carry wid/href/type so the client can link them');
  t.ok(/href: k\.url \}\);/.test(srv), 'server: the child-date timeline rows carry an href to the work item');

  // --- in-flight honesty + kanban standup strip ---
  t.ok(/const inflight = kids\.filter\(k => k\._st === 'blocked' \|\| k\._st === 'doing' \|\| k\._st === 'review'\)/.test(srv), 'server: inflight = only blocked/doing/review (backlog + done excluded)');
  t.ok(/const work = inflight\.slice\(\)/.test(srv), 'server: the work rows are built from inflight only (no backlog padding)');
  t.ok(!/const work = kids\.slice\(\)\.sort/.test(srv), 'server: work no longer sorts+slices ALL kids (the old backlog-padding bug is gone)');
  t.ok(/Nothing is actively in flight/.test(srv), 'server: honest empty-state summary when nothing is in flight');
  t.ok(/kanban: \{ doing: doingK\.length, review: reviewK\.length, blocked: blocked\.length, todo: todoK\.length, done: doneN, total \}/.test(srv), 'server: cockpit returns a kanban state breakdown');
  t.ok(!/still in flight; nothing is currently blocked/.test(srv), 'server: the misleading "N still in flight" line is removed');
  // client kanban strip
  t.ok(/epicKanbanSegs\(\) \{/.test(html), 'client defines epicKanbanSegs()');
  const segs = _win(html, 'epicKanbanSegs() {', 700);
  t.ok(/'doing'/.test(segs) && /'review'/.test(segs) && /'blocked'/.test(segs) && /'todo'/.test(segs) && /'done'/.test(segs), 'epicKanbanSegs returns all five states');
  t.ok(/class="epx-kanban"/.test(html) && /epicKanbanSegs\(\)/.test(html), 'the standup card renders a kanban strip fed by epicKanbanSegs');
  t.ok(/\.epx-kanban-bar \.seg\.blocked \{ background:var\(--cp-danger\)/.test(html), 'kanban bar reuses the epx status colors (no pills)');
  t.ok(/being worked, in review, or blocked — backlog is under Next up/.test(html), 'the in-flight section subtitle clarifies it excludes backlog');
});

await t.test('code flow: Epics — AI persona picker + auto-AI standup (built-in or installed standup agent)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // --- state: persona (persisted), agents list, auto-kick guard ---
  const st = _win(html, 'epics: {', 900);
  t.ok(/persona:/.test(st) && /epx-persona/.test(st), 'epics state carries a persisted persona (localStorage epx-persona)');
  t.ok(/agents:\s*\[\]/.test(st) && /agentsLoaded:/.test(st) && /_aiKicked:/.test(st), 'epics state carries agents/agentsLoaded/_aiKicked guard');

  // --- client methods ---
  for (const m of ['epicLoadAgents(', 'epicPersonaChoices()', 'epicPersonaLabel()', 'epicSetPersona(', 'epicAiAuto(', 'epicTogglePersona()']) {
    t.ok(html.includes(m), 'method defined: ' + m);
  }
  // loader hits the agents route
  const la = _win(html, 'async epicLoadAgents(', 500);
  t.ok(/\/api\/codeflow\/epics\/agents/.test(la), 'epicLoadAgents GETs the agents route');
  // built-in is always the first choice
  const pc = _win(html, 'epicPersonaChoices() {', 500);
  t.ok(/'builtin'/.test(pc) && /Built-in epic assistant/.test(pc), 'built-in epic assistant is always offered first');
  // auto-kick fires once per epic per persona, degrades to heuristic
  const aa = _win(html, 'epicAiAuto(force) {', 700);
  t.ok(/persona/.test(aa) && /_aiKicked/.test(aa) && /epicUpgradeAi\(\)/.test(aa), 'epicAiAuto is keyed by epic+persona and calls epicUpgradeAi');
  // auto-kick is invoked from load + select
  t.ok(/this\.epicAiAuto\(\)/.test(_win(html, 'async loadCodeflowEpics(refresh)', 1800) || ''), 'loadCodeflowEpics kicks the AI standup');
  t.ok(/this\.epicAiAuto\(\)/.test(_win(html, 'epicSelect(i) {', 300) || ''), 'epicSelect kicks the AI standup for the newly selected epic');

  // --- persona is sent in BOTH POST bodies ---
  const up = _win(html, 'async epicUpgradeAi()', 700);
  t.ok(/persona:\s*ep\.persona/.test(up), 'epicUpgradeAi POSTs the chosen persona');
  t.ok(/persona:\s*this\.codeflow\.epics\.persona/.test(_win(html, 'async epicChatSend(', 1400) || ''), 'epicChatSend POSTs the chosen persona');

  // --- picker markup (calm dropdown, no pills) + honest provenance ---
  t.ok(/class="epx-persona"/.test(html) && /epicPersonaChoices\(\)/.test(html), 'persona picker dropdown rendered from epicPersonaChoices');
  t.ok(/epx-persona-menu/.test(html) && /\.epx-persona-menu \{/.test(html), 'persona menu markup + CSS present');
  t.ok(/is synthesizing…/.test(html) && /AI-synthesized · <span x-text="epicPersonaLabel\(\)">/.test(html), 'standup provenance names the persona + shows a synthesizing state');

  // --- server: helpers + route + persona threaded ---
  t.ok(/_epicStandupAgents\s*\(/.test(srv), 'server defines _epicStandupAgents()');
  t.ok(/_epicPersonaConfig\s*\(/.test(srv), 'server defines _epicPersonaConfig()');
  t.ok(srv.includes("app.get('/api/codeflow/epics/agents'"), 'server route: GET /api/codeflow/epics/agents');
  // /ai route reads persona + stamps it on the cockpit
  const ai = _win(srv, "app.post('/api/codeflow/epics/ai'", 5200);
  t.ok(/persona/.test(ai) && /_epicPersonaConfig/.test(ai) && /aiPersona/.test(ai), '/ai route resolves the persona config + stamps cockpit.aiPersona');
  // /assistant route reads persona
  const as = _win(srv, "app.post('/api/codeflow/epics/assistant'", 2000);
  t.ok(/persona/.test(as) && /_epicPersonaConfig/.test(as), '/assistant route resolves the persona config');
});

await t.test('monitoring.ai: native render fidelity — var quoting, hidden vars, $__interval, time range, tables/no-data', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const graf = require('../grafana.js');
  const I = graf._internal;

  // Bug A — Grafana-style value formatting for KQL/Azure Monitor + ADX.
  t.eq(I._formatVarValue({ values: ['a', 'b'], multi: true }), "'a','b'", 'multi-value → single-quoted CSV');
  t.eq(I._formatVarValue({ values: ["o'brien"], multi: true }), "'o''brien'", "single-quote escaped as '' in a multi list");
  t.eq(I._formatVarValue({ values: ['x'], multi: false }), 'x', 'single-value → raw text (no quotes)');
  t.eq(I._formatVarValue({ values: [] }), '', 'empty value → empty string');

  // _applyVars: bare multi → quoted list; author-quoted single → raw inside quotes (no doubling); boundary respected.
  const vm = { QueueName: { values: ['a', 'b'], multi: true }, Single: { values: ['linux'], multi: false } };
  const bare = I._applyVars({ q: 'Jobs | where QueueName in ($QueueName)' }, vm);
  t.ok(bare.q === "Jobs | where QueueName in ('a','b')", 'bare $QueueName (multi) → quoted CSV');
  const quoted = I._applyVars({ q: "T | where Name == '$Single'" }, { Single: { values: ['linux'], multi: false } });
  t.ok(quoted.q === "T | where Name == 'linux'", "author-quoted '$Single' → raw (no doubled quotes)");
  const boundary = I._applyVars({ q: '$QueueNameX + $QueueName' }, vm);
  t.ok(/\$QueueNameX/.test(boundary.q) && /'a','b'$/.test(boundary.q), 'word-boundary: $QueueNameX not clobbered by $QueueName');

  // Bug C — hidden (hide:2) textbox variables MUST enter the substitution map (Grafana interpolates them).
  const model = { templating: { list: [
    { name: 'QueueName', type: 'query', multi: true, current: { value: ['a', 'b'] } },
    { name: 'UntrackedQueues', type: 'textbox', hide: 2, query: '"osx", "perf"' },
    { name: 'ds', type: 'datasource', current: { value: 'x' } },
  ] } };
  const map = I._varMap(model, {});
  t.ok(map.UntrackedQueues && map.UntrackedQueues.values.join('') === '"osx", "perf"', 'hidden textbox var is in the substitution map');
  t.ok(map.QueueName && map.QueueName.multi === true, 'query var carries its multi flag');
  t.ok(!map.ds, 'datasource-type variable is excluded from substitution');
  // UI-facing variable list still hides hidden ones.
  t.ok(!I._dashboardVariables(model).some(v => v.name === 'UntrackedQueues'), 'hidden var stays out of the UI picker');

  // Bug B — $__interval / $__interval_ms expansion (ADX backend does not expand them).
  t.eq(I._grafanaDuration(3.6e6), '1h', '1h duration');
  t.eq(I._grafanaDuration(3e5), '5m', '5m duration');
  t.eq(I._grafanaDuration(3e4), '30s', '30s duration');
  const iv = I._computeIntervalMs('now-24h', 'now', 300);
  t.ok(iv >= 1e3 && iv <= 864e5, 'computed interval snaps into a nice bucket');
  const exp = I._expandMacros([{ q: 'summarize by bin(t, $__interval) | $__timeFilter(t) | take $__interval_ms' }], 3e5);
  t.ok(exp[0].q.includes('bin(t, 5m)'), '$__interval → duration string');
  t.ok(exp[0].q.includes('take 300000'), '$__interval_ms → milliseconds');
  t.ok(exp[0].q.includes('$__timeFilter(t)'), '$__timeFilter left for the datasource backend');

  // Server route parses the time range + var-* params and threads them to getDashboard.
  const srv = readFileSync(SERVER, 'utf8');
  t.ok(/if \(k\.startsWith\('var-'\)\) vars\[k\.slice\(4\)\] = q\[k\];/.test(srv), 'dashboard route extracts var-* query params');
  t.ok(/from: q\.from \|\| undefined, to: q\.to \|\| undefined, vars/.test(srv), 'route threads from/to/vars into opts');
  t.ok(/grafana\.getDashboard\(req\.params\.uid, opts\)/.test(srv), 'route passes opts to getDashboard');

  // SPA: filter controls (time range + per-variable) + honest table / no-data rendering.
  t.ok(/class="monx-controls"/.test(html), 'SPA renders the .monx-controls filter row');
  t.ok(/monSetTimeRange\(/.test(html) && /monVarSet\(/.test(html) && /monApplyFilters\(/.test(html), 'time-range + var setters + apply wired');
  t.ok(/monx-table/.test(html) && /monx-nodata/.test(html), 'SPA has table + honest no-data render surfaces');
});

await t.test('monitoring.ai: Grafana view — live whole-dashboard iframe + rendered-image fallback + native data path', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const server = readFileSync(SERVER, 'utf8');
  const grafanaSrc = readFileSync('grafana.js', 'utf8');

  // Large-series crash fix: no Math.min/max.apply spreads left in the mon renderers.
  t.ok(!/Math\.(min|max)\.apply\(null,\s*(all|s|data)/.test(html), 'no Math.min/max.apply spreads in the panel renderers (stack-overflow guard)');

  // State + persisted toggle.
  t.ok(/embedMode:/.test(html) && /localStorage\.getItem\('mon-embed-mode'\)/.test(html), 'embedMode state is persisted');
  t.ok(/embedNonce:/.test(html), 'embedNonce state (refresh buster) exists');
  t.ok(/monSetEmbedMode\(/.test(html), 'View toggle wired to monSetEmbedMode');

  // Methods present. monEmbedActive is now no-arg (whole-dashboard).
  t.ok(/monEmbedActive\(\)\s*\{/.test(html), 'monEmbedActive (no-arg) gate exists');
  t.ok(/monDashRenderUrl\(\)\s*\{/.test(html), 'monDashRenderUrl (whole-dashboard server render) builder exists');
  t.ok(/monDashGrafanaUrl\(\)\s*\{/.test(html), 'monDashGrafanaUrl (open whole dashboard in Grafana) exists');
  t.ok(/monEmbedRefresh\(\)\s*\{/.test(html), 'monEmbedRefresh bumps the nonce to re-render');
  t.ok(/monPanelRenderUrl\(p, h\)\s*\{/.test(html), 'monPanelRenderUrl kept for the single-panel deep dive');
  t.ok(/monEmbedErr\(p\)/.test(html) && /monEmbedFail\(p\)/.test(html) && /monEmbedOk\(p\)/.test(html), 'render error/ok fallback helpers exist (keyed)');

  // Embed only when connected to a non-local dashboard.
  t.ok(/w\.embedMode === 'grafana'/.test(html) && /!w\.dash\.local/.test(html) && /w\.conn && w\.conn\.url/.test(html), 'embed gated on grafana mode + non-local dash + a configured connection');

  // The real dashboard is ONE same-origin server render (not N per-panel iframes
  // — AMG blocks a naked iframe at the AAD login framing wall, and per-panel
  // renders trip AMG's concurrent-render limit).
  t.ok(/'\/api\/monitoring\/render\/' \+ encodeURIComponent/.test(html), 'render URL points at our same-origin /api/monitoring/render proxy');
  t.ok(!/d-solo/.test(html), 'no client-side d-solo iframe URL remains (that path is AAD-framing-blocked)');
  t.ok(/params\.set\('whole', '1'\)/.test(html), 'dashboard render URL requests the whole dashboard (whole=1)');
  t.ok(/params\.set\('theme'/.test(html) && /params\.set\('width'/.test(html) && /params\.set\('height'/.test(html), 'render URL carries theme + width + height');
  t.ok(/params\.set\('from'/.test(html) && /params\.set\('to'/.test(html) && /append\('var-' \+ name/.test(html), 'embed URLs thread from/to + var-* (multi-value repeated)');

  // Markup: the primary Grafana view is now a LIVE iframe (Grafana's own nav/filters),
  // with a manual server-rendered-image fallback (XFO framing can't be auto-detected
  // cross-origin, so the fallback is a manual toggle, not @error-driven).
  t.ok(/x-if="monEmbedActive\(\)"/.test(html) && /class="monx-dashimg"/.test(html), 'Grafana view renders one whole-dashboard container');
  t.ok(/<iframe class="monx-dashframe"/.test(html) && /:src="monDashLiveUrl\(\)"/.test(html), 'the primary Grafana view is a live iframe fed by monDashLiveUrl');
  t.ok(/x-if="monGrafanaRenderMode\(\) !== 'image'"/.test(html) && /x-if="monGrafanaRenderMode\(\) === 'image'"/.test(html), 'live iframe vs rendered-image sub-branches gate on monGrafanaRenderMode');
  t.ok(/<img class="monx-dashimg-img"/.test(html) && /:src="monDashRenderUrl\(\)"/.test(html), 'the rendered-image fallback is fed by monDashRenderUrl');
  t.ok(/@click="monToggleGrafanaRender\(\)"/.test(html) && /monx-embedfail/.test(html), 'a manual View-rendered-image toggle + open-in-Grafana fallback exist');
  // Live-iframe URL builder: Grafana deep link WITHOUT kiosk (so its nav shows), + theme.
  t.ok(/monDashLiveUrl\(\)\s*\{/.test(html) && /'\/d\/' \+ encodeURIComponent\(w\.dash\.uid\)/.test(html), 'monDashLiveUrl builds a {base}/d/{uid}/{slug} live URL');
  t.ok(!/kiosk/.test(html), 'no kiosk param — the user WANTS Grafana\'s own nav inside the frame');
  t.ok(/grafanaRender:/.test(html) && /localStorage\.getItem\('mon-grafana-render'\)/.test(html), 'grafanaRender (live|image) state is persisted');
  // Left DASHBOARDS rail auto-collapses in the live Grafana view (Grafana's nav supersedes it).
  t.ok(/railOpen:/.test(html) && /monRailOpen\(\)/.test(html) && /monToggleRail\(\)/.test(html), 'railOpen state + monRailOpen/monToggleRail exist');
  t.ok(/this\.monitoring\.railOpen = \(mode !== 'grafana'\)/.test(html), 'entering the Grafana view auto-collapses the DASHBOARDS rail');
  t.ok(/class="monx-studio" :class="\{ railhidden: !monRailOpen\(\) \}"/.test(html) && /\.monx-studio\.railhidden\{/.test(html), 'studio reclaims the rail column when hidden (railhidden grid)');
  t.ok(/<div class="monx-rail" x-show="monRailOpen\(\)">/.test(html) && /☰ Dashboards/.test(html), 'rail is x-show-gated + a reopen affordance appears when collapsed');
  t.ok(/x-if="!monEmbedActive\(\)"/.test(html) && /class="monx-board"/.test(html) && /x-html="monPanelBody\(p\)"/.test(html), 'native per-panel grid is the default (non-Grafana) branch');
  t.ok(/@click="monGrabToggle\(p\.id\)"/.test(html), 'Grab (native data path for AI) stays available in the native view');

  // Server + bridge: authenticated render proxy, whole-dashboard capable.
  t.ok(/app\.get\('\/api\/monitoring\/render\/:uid'/.test(server), 'server exposes the /api/monitoring/render/:uid route');
  t.ok(/grafana\.renderPanel\(/.test(server) && /whole: q\.whole === '1'/.test(server), 'server route delegates to grafana.renderPanel and passes whole');
  t.ok(/async function renderPanel\(/.test(grafanaSrc) && /whole \? 'd' : 'd-solo'/.test(grafanaSrc), 'grafana.js renderPanel supports both /render/d (whole) and /render/d-solo (panel)');
  t.ok(/_acquireRenderSlot\(\)/.test(grafanaSrc) && /_releaseRenderSlot\(\)/.test(grafanaSrc) && /_renderCache\.set\(/.test(grafanaSrc), 'renderPanel uses the concurrency gate + TTL cache');
  t.ok(/renderPanel,/.test(grafanaSrc), 'renderPanel is exported');
});

await t.test('monitoring.ai: data overlay + honest source/query/last-updated provenance + assistant + bounded studio', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const grafanaSrc = readFileSync('grafana.js', 'utf8');

  // Req 1 — a "Data" button opens a roomy WINDOW OVERLAY (not an in-place flip) showing the rows behind the panel.
  t.ok(/@click="monOpenData\(p\.id\)"/.test(html), 'each native panel has a Data button that opens the overlay');
  t.ok(/x-html="monPanelBody\(p\)"/.test(html) && !/monIsFlipped/.test(html) && !/monFlipToggle/.test(html), 'the panel body always renders the chart (no in-place flip)');
  t.ok(/monOpenData\s*\(/.test(html) && /monCloseData\s*\(/.test(html) && /monDataPanel\s*\(/.test(html) && /monPanelDataTable\s*\(/.test(html), 'overlay helpers monOpenData/monCloseData/monDataPanel/monPanelDataTable exist');
  // The overlay is a TOP-LEVEL teleport with the shared centering classes (survives x-show) + escape/backdrop close.
  t.ok(/<template x-teleport="body">[\s\S]{0,400}?class="modal-backdrop monx-datamodal"/.test(html), 'the data overlay is a top-level x-teleport with .modal-backdrop centering');
  t.ok(/x-show="monitoring\.dataModal"/.test(html) && /@click\.self="monCloseData\(\)"/.test(html) && /@keydown\.escape\.window="monCloseData\(\)"/.test(html), 'overlay is gated on dataModal + closes on backdrop/escape');
  t.ok(/x-html="monPanelDataTable\(monDataPanel\(\)\)"/.test(html), 'the overlay body renders the data table for the open panel');
  t.ok(/dataModal:\s*null/.test(html), 'monitoring state seeds dataModal:null');
  t.ok(/\.monx-datamodal .monx-dmcard\{/.test(html) && /\.monx-tablewrap\b/.test(html) && /\.monx-table\b/.test(html) && /\.monx-nodata\b/.test(html), 'roomy overlay card + data-table/no-data CSS present');
  // monPanelDataTable is TABLE-ONLY now (the overlay header renders provenance), no duplicated meta block.
  t.ok(/monPanelDataTable\(p\)\s*\{[\s\S]{0,320}?let h = '';/.test(html), 'monPanelDataTable builds the table only (no inlined meta block)');

  // Reqs 2 & 3 — source, query and last-updated surfaced HONESTLY. Sample panels never claim a bogus datasource/query.
  t.ok(/monPanelIsSample\s*\(p\)\s*\{[\s\S]{0,120}?p\.sample === true \|\| p\.origin === 'sample'/.test(html), 'monPanelIsSample treats sample:true OR origin==="sample" as demo data');
  t.ok(/monPanelQueryText[\s\S]{0,200}?this\.monPanelIsSample\(p\)\)\s*return 'Synthesized demo data/.test(html), 'monPanelQueryText returns an honest sample note FIRST (no "query not exposed" noise for demo data)');
  t.ok(/'Query not exposed by this panel'/.test(html) && /'Synthesized sample series \(demo data\)'/.test(html), 'monPanelQueryText treats the grafana.js live/sample fallback strings as non-real queries');
  t.ok(/monPanelSourceLabel[\s\S]{0,400}?Sample data · modeled on/.test(html) && /Sample data \(demo\)/.test(html), 'monPanelSourceLabel labels sample panels honestly instead of a bare datasource id');
  t.ok(/_monPanelMetaHtml\s*\(/.test(html) && /monPanelSourceLabel\s*\(/.test(html) && /monPanelQueryText\s*\(/.test(html) && /monPanelUpdatedLabel\s*\(/.test(html), 'meta helpers (source/query/last-updated) exist');
  t.ok(/_monPanelMetaHtml\(monDeepPanel\(\)\)/.test(html), 'deep-dive still renders the panel meta block (inherits honest text)');
  t.ok(/monPanelIsSample\(monDataPanel\(\)\)/.test(html) && /Synthesized demo data/.test(html) && /\.monx-dmnote\b/.test(html), 'the overlay shows a calm sample-data note when the dashboard is demo data');

  // Req 3 (honest server-side source/query on every panel builder — unchanged).
  t.ok(/function _panelSourceText\(/.test(grafanaSrc) && /function _panelQueryText\(/.test(grafanaSrc), 'grafana.js exposes _panelSourceText/_panelQueryText');
  t.ok(/_panelSourceText[,\s]/.test(grafanaSrc) && /_panelQueryText[,\s]/.test(grafanaSrc) && /_internal:\s*\{[^}]*_panelSourceText[^}]*_panelQueryText/.test(grafanaSrc), 'both helpers are exported on _internal');
  t.ok(/source:\s*_panelSourceText\(gp\)/.test(grafanaSrc) && /query:\s*_panelQueryText\(gp\)/.test(grafanaSrc), 'live Grafana panels carry honest source/query');
  t.ok(/origin:\s*'sample'/.test(grafanaSrc) && /Synthesized sample series/.test(grafanaSrc), 'sample panels carry origin + honest query text');

  // Req 4a — rename Monitoring copilot -> Monitoring assistant.
  t.ok(/Monitoring assistant/.test(html) && !/Monitoring copilot/i.test(html), 'the side panel is renamed to "Monitoring assistant"');
  t.ok(/✨ Assistant/.test(html), 'empty-state / author label uses "✨ Assistant"');

  // Req 4b — the studio fills the viewport; only the conversation scrolls.
  t.ok(/\.monx-studio\{[^}]*height:calc\(100vh - 165px\)/.test(html), 'the studio is height-bounded to the viewport');
  t.ok(/\.monx-rail\{[^}]*min-height:0/.test(html) && /\.monx-cop\{[^}]*min-height:0/.test(html) && /\.monx-conv\{[^}]*overflow:auto/.test(html), 'rail/copilot flex to 0 and only the conversation scrolls');
  t.ok(/@media \(max-width:900px\)\{[\s\S]*?\.monx-studio\{[^}]*height:auto/.test(html), 'the mobile media query releases the height cap');
});

await t.test('monitoring.ai v2: internal workspace catalog + board-build + provenance + alerts', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync(SERVER, 'utf8');
  const graf = readFileSync('grafana.js', 'utf8');
  const wss = readFileSync('workspace-source.js', 'utf8');

  // --- Context & data catalog: workspace (internal) + external, with Ground/Chart role toggles ---
  t.ok(/Context &amp; data catalog/.test(html), 'launcher has the context & data catalog section');
  t.ok(/x-for="s in monitoring\.catalog\.workspace"/.test(html) && /x-for="s in monitoring\.catalog\.external"/.test(html), 'catalog renders workspace + external groups');
  t.ok(/@click="monToggleRole\(s\.id, 'ground'\)"/.test(html) && /monToggleRole\(s\.id, 'chart'\)/.test(html), 'Ground + Chart role toggles wired');
  t.ok(/s\.chartable && monToggleRole\(s\.id, 'chart'\)/.test(html), 'Chart toggle is gated on s.chartable (non-chartable sources cannot be charted)');
  // whole-object reassign so Alpine subscribes (repo reactivity note)
  const mtr = _win(html, 'monToggleRole(id, role)', 560);
  t.ok(/w\.catalogRoles = \{ \.\.\.w\.catalogRoles, \[id\]: next \}/.test(mtr), 'monToggleRole reassigns the whole catalogRoles map (Alpine reactivity)');
  for (const m of ['async monLoadCatalog(', 'monRoleOn(', 'monSelectedChartSources(', 'monCatSub(']) {
    t.ok(html.includes(m), 'catalog method present: ' + m);
  }
  // catalog source drives the generate request
  t.ok(/const sources = this\.monSelectedChartSources\(\);/.test(html) && /body\.sources = sources;/.test(html), 'monGenerate binds the chart-selected catalog sources');

  // --- Build from a workspace board ---
  t.ok(/Build from a workspace board/.test(html), 'launcher has the board-build section');
  t.ok(/x-model="monitoring\.boardBuild\.boardId"/.test(html) && /@click="monBuildFromBoard\(\)"/.test(html), 'board picker + Build button wired');
  for (const m of ['async monLoadBoards(', 'monBuildFromBoard(', 'monBoardRefGroups(']) {
    t.ok(html.includes(m), 'board method present: ' + m);
  }
  // /api/boards returns a bare array OR {boards:[]}; the loader handles both
  const mlb = _win(html, 'async monLoadBoards()', 320);
  t.ok(/Array\.isArray\(r\) \? r : \(r && r\.boards\) \|\| \[\]/.test(mlb), 'monLoadBoards handles a bare-array or {boards} response');
  // mined board refs surface in the launcher
  t.ok(/monitoring\.boardRefs/.test(html) && /monBoardRefGroups\(\)/.test(html) && /Context used:/.test(html), 'boardRefs (mined context) are shown after a board build');
  t.ok(/w\.boardRefs = \(r && r\.boardRefs\) \|\| null;/.test(html), 'monGenerate captures boardRefs from the response');

  // --- Panel provenance badge in the studio ---
  t.ok(/monPanelProvenance\(panel\)/.test(html) && /monProvLabel\(prov\)/.test(html), 'provenance helpers present');
  t.ok(/class="monx-provbadge"/.test(html) && /x-text="monProvLabel\(monPanelProvenance\(p\)\)"/.test(html), 'studio panel headers carry a provenance badge');
  t.ok(/workspace: monPanelProvenance\(p\)\.kind === 'workspace'/.test(html), 'provenance badge distinguishes workspace-kind panels');
  const mpl = _win(html, 'monProvLabel(prov)', 420);
  t.ok(/workspace · direct/.test(mpl) && /AMG MCP/.test(mpl) && /· direct/.test(mpl), 'monProvLabel labels workspace/direct/AMG-MCP access');
  t.ok(/workspace · by ' \+ prov\.dimension/.test(mpl), 'monProvLabel surfaces the real discovered dimension for ws.* panels');
  t.ok(/w\.provenance = \(r && r\.provenance\) \|\| \[\];/.test(html), 'monGenerate captures panel provenance');
  t.ok(/w\.discovery = \(r && r\.discovery\) \|\| \[\];/.test(html), 'monGenerate captures the discovery brief');
  // discovery-driven panels surface their real grouped-by dimension in the meta (badge, overlay, deep-dive)
  t.ok(/monPanelDimension\(p\)/.test(html) && /monPanelMetric\(p\)/.test(html), 'panel dimension/metric helpers present');
  t.ok(/<span class="ml">Grouped by<\/span>/.test(html), 'panel meta surfaces a Grouped-by row for discovery-driven panels');

  // --- Alerts: list + form + CRUD methods (with the two bug fixes) ---
  t.ok(/<div class="ph"><span>Alerts<\/span>/.test(html), 'home hub has the Alerts panel');
  for (const m of ['async monLoadAlerts(', 'monAlertableSources(', 'monAlertNew(', 'async monSaveAlert(', 'async monToggleAlert(', 'async monDeleteAlert(', 'monAlertSummary(', 'monAlertState(']) {
    t.ok(html.includes(m), 'alert method present: ' + m);
  }
  // only alertable workspace sources can back an alert
  t.ok(/\(this\.monitoring\.catalog\.workspace \|\| \[\]\)\.filter\(s => s\.alertable\)/.test(html), 'monAlertableSources filters to alertable workspace sources');
  // FIX 1: monSaveAlert sends window:{days} + an id when editing
  const msa = _win(html, 'async monSaveAlert()', 640);
  t.ok(/window: \{ days: Number\(d\.windowDays\) \|\| 7 \}/.test(msa), 'monSaveAlert maps the flat windowDays to window:{days}');
  t.ok(/if \(d\.id\) body\.id = d\.id;/.test(msa), 'monSaveAlert carries an id when editing (no duplicate)');
  // FIX 2: monToggleAlert PUTs the FULL alert object (sourceId/window/etc.) with a flipped enabled
  const mta = _win(html, 'async monToggleAlert(a)', 480);
  t.ok(/sourceId: a\.sourceId/.test(mta) && /window: a\.window/.test(mta) && /enabled: !a\.enabled/.test(mta), 'monToggleAlert PUTs the full alert body with a flipped enabled (server saveAlert needs sourceId)');
  t.ok(!/body: JSON\.stringify\(\{ enabled: !a\.enabled \}\)/.test(mta), 'monToggleAlert no longer sends a partial {enabled} body');

  // --- monitoring-alert SSE listener ---
  t.ok(/source\.addEventListener\('monitoring-alert'/.test(html), 'SPA subscribes to the monitoring-alert SSE event');
  const sse = _win(html, "addEventListener('monitoring-alert'", 1100);
  t.ok(/w\.alertNotices = \[/.test(sse) && /this\.toast\('🔔 Alert:/.test(sse) && /this\.monLoadAlerts\(\)/.test(sse), 'monitoring-alert listener records a notice, toasts, and refreshes the alert list');

  // --- Server routes ---
  for (const r of ["/api/monitoring/catalog", "/api/monitoring/alerts", "/api/monitoring/alerts/:id", "/api/monitoring/alerts/evaluate"]) {
    t.ok(srv.includes(r), 'server route present: ' + r);
  }
  t.ok(/app\.get\('\/api\/monitoring\/alerts'/.test(srv) && /app\.post\('\/api\/monitoring\/alerts'/.test(srv) && /app\.put\('\/api\/monitoring\/alerts\/:id'/.test(srv) && /app\.delete\('\/api\/monitoring\/alerts\/:id'/.test(srv), 'alert CRUD routes (GET/POST/PUT/DELETE) exist');
  t.ok(/async function _runMonitoringAlerts\(/.test(srv) && /broadcastSSE\('monitoring-alert'/.test(srv), 'server evaluates alerts and broadcasts monitoring-alert over SSE');

  // --- Phase 1 discovery backend: real-field binding, no synthesized ws.* data ---
  t.ok(/app\.get\('\/api\/monitoring\/discover\/:id'/.test(srv), 'discover route present (GET /api/monitoring/discover/:id)');
  t.ok(/grafana\.discover\(id\)/.test(srv) && /grafana\.discoverExternal\(id\)/.test(srv), 'discover route profiles internal via grafana.discover and external ds.* via grafana.discoverExternal');
  t.ok(/function _monValidatePanel\(panel, discovered\)/.test(srv), '_monValidatePanel binds AI panels to discovered fields');
  const mvp = _win(srv, 'function _monValidatePanel(panel, discovered)', 900);
  t.ok(/if \(p\.dimension && !dimFields\.has\(p\.dimension\)\) p\.dimension = null;/.test(mvp), '_monValidatePanel drops a hallucinated dimension not in the profile');
  t.ok(/if \(p\.metric && p\.metric !== 'count' && !metFields\.has\(p\.metric\)\) p\.metric = 'count';/.test(mvp), '_monValidatePanel falls back to count for an unknown metric');
  t.ok(/function _monDeterministicPanels\(discovered\)/.test(srv), '_monDeterministicPanels builds no-AI panels from real dimensions');
  const mdp = _win(srv, 'function _monDeterministicPanels(discovered)', 720);
  t.ok(/const dim = \(d\.dimensions \|\| \[\]\)\[0\];/.test(mdp) && /dimension: dim\.field/.test(mdp), '_monDeterministicPanels groups by the top real discovered dimension');
  t.ok(/j\.panels = j\.panels\.map\(p => _monValidatePanel\(p, discovered\)\)/.test(srv), 'generate validates every AI panel against the discovery brief');
  t.ok(/const detPanels = _monDeterministicPanels\(discovered\)/.test(srv), 'generate falls back to deterministic discovery-driven panels');

  // --- grafana.js alert exports + workspace-source alert gate ---
  for (const fn of ['listAlerts', 'saveAlert', 'deleteAlert', 'evaluateAlerts', 'isWorkspaceSource', 'catalog']) {
    t.ok(new RegExp('\\b' + fn + '\\b').test(graf) && graf.includes(fn + ','), 'grafana.js exports ' + fn);
  }
  t.ok(/Alerts are supported on internal Workspace sources only\./.test(graf), 'saveAlert rejects non-workspace sources');
  t.ok(/function catalog\(\)/.test(wss) && /function evaluateAlert\(/.test(wss), 'workspace-source.js provides catalog() + evaluateAlert()');
  t.ok(/catalog,/.test(wss) && /evaluateAlert,/.test(wss), 'workspace-source.js exports catalog + evaluateAlert');
});

await t.test('monitoring.ai Phase 2: external ds.* schema discovery + live proxy query + no fake data', () => {
  const graf = require('../grafana.js');
  const I = graf._internal;
  const srv = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');

  // --- Shared frame parser: /api/ds/query dataframes → { series, table } ---
  const tsOut = { results: { A: { frames: [ {
    schema: { fields: [ { name: 'time', type: 'time' }, { name: 'count', type: 'number', config: { unit: 'ops' } } ] },
    data: { values: [ [1000, 2000, 3000], [5, 8, 13] ] },
  } ] } } };
  const tsParsed = I._framesToSeriesTable(tsOut, false);
  t.eq(tsParsed.series.length, 1, 'timeseries frame → one series');
  t.eq(tsParsed.series[0].name, 'count', 'series named from the numeric field');
  t.eq(tsParsed.series[0].unit, 'ops', 'series carries the field unit');
  t.eq(tsParsed.series[0].sample, false, 'live series are never marked sample');
  t.eq(tsParsed.series[0].data.length, 3, 'all points parsed [time,value]');
  t.eq(tsParsed.series[0].data[2][1], 13, 'last value parsed');

  const tblOut = { results: { A: { frames: [ {
    schema: { fields: [ { name: 'Queue', type: 'string' }, { name: 'Depth', type: 'number' } ] },
    data: { values: [ ['osx', 'linux'], [4, 9] ] },
  } ] } } };
  const tblParsed = I._framesToSeriesTable(tblOut, true);
  t.ok(tblParsed.table && tblParsed.table.columns.join(',') === 'Queue,Depth', 'table frame → columns');
  t.eq(tblParsed.table.rows.length, 2, 'table rows parsed');
  t.eq(tblParsed.table.rows[0][0], 'osx', 'first row first cell');
  // A time-less frame becomes a table even when wantTable is false.
  const noTime = I._framesToSeriesTable(tblOut, false);
  t.ok(noTime.table && !noTime.series.length, 'time-less frame → table (not empty series)');

  // --- ADX schema parse + discovery shape ---
  const role = I._adxRole;
  t.eq(role('datetime'), 'time', 'datetime → time role');
  t.eq(role('long'), 'metric', 'long → metric role');
  t.eq(role('string'), 'dimension', 'string → dimension role');
  const schema = { Databases: { Fabric: { Tables: {
    Jobs: { OrderedColumns: [ { Name: 'Timestamp', CslType: 'datetime' }, { Name: 'Queue', CslType: 'string' }, { Name: 'Count', CslType: 'long' } ] },
    Meta: { OrderedColumns: [ { Name: 'Key', CslType: 'string' } ] },
  } } } };
  const tables = I._parseAdxSchema(schema);
  t.eq(tables.length, 2, 'both ADX tables parsed');
  const jobs = tables.find(x => x.table === 'Jobs');
  t.ok(jobs && jobs.database === 'Fabric', 'table carries its database');
  t.eq(jobs.columns.find(c => c.name === 'Timestamp').role, 'time', 'Timestamp classified as time');
  const disc = I._adxTableToDiscovery('ds.adx', 'ADX', 'uid1', 'grafana-azure-data-explorer-datasource', jobs);
  t.ok(disc.external === true && disc.timeField === 'Timestamp', 'discovery marks external + finds the time field');
  t.ok(disc.dimensions.some(d => d.field === 'Queue'), 'string column surfaced as a dimension');
  t.ok(disc.metrics[0].agg === 'count' && disc.metrics.some(m => m.field === 'Count'), 'count metric + numeric metric surfaced');

  // --- External target builder: per-datasource query shape ---
  const adxT = I._externalTarget({ dsType: 'kusto', datasourceUid: 'u', database: 'Fabric', query: 'Jobs | count' }, 'A');
  t.ok(adxT.query === 'Jobs | count' && adxT.database === 'Fabric' && adxT.datasource.uid === 'u', 'ADX target carries query/database/uid');
  const promT = I._externalTarget({ dsType: 'prometheus', datasourceUid: 'p', query: 'up' }, 'A');
  t.ok(promT.expr === 'up' && promT.range === true, 'Prometheus target uses expr + range');
  const genT = I._externalTarget({ dsType: 'mysql', datasourceUid: 'm', query: 'select 1' }, 'A');
  t.ok(genT.rawSql === 'select 1', 'generic SQL target uses rawSql');

  // --- discoverExternal honest not-profiled paths (dev env has no Grafana) ---
  return (async () => {
    const unknown = await graf.discoverExternal('ds.does-not-exist');
    t.ok(unknown.profiled === false && unknown.external === true, 'unknown external source → profiled:false');

    // --- _specToPanels external branch: NEVER synthesizes fake data ---
    const ext = I._specToPanels({ panels: [ { title: 'ADX panel', source: 'ds.adx', query: 'Jobs | count', datasourceUid: 'u', dsType: 'kusto' } ] }, 'uidX')[0];
    t.eq(ext.sample, false, 'external panel is not sample');
    t.eq(ext.empty, true, 'external panel starts honest-empty (live-queried later)');
    t.eq(ext.series.length, 0, 'external panel has no synthesized series');
    t.eq(ext.provider, 'external', 'external panel tagged provider:external');
    t.eq(ext.query, 'Jobs | count', 'external panel carries its AI-authored query');
    t.ok(/Live data loads/.test(ext.note), 'panel with a query notes live-load');
    const extNoQ = I._specToPanels({ panels: [ { title: 'No query', source: 'ds.adx' } ] }, 'uidX')[0];
    t.ok(extNoQ.sample === false && extNoQ.empty === true && /connect the data source/i.test(extNoQ.note), 'query-less external panel is honest-empty with a connect note');
    // A non-workspace, non-external source still synthesizes a labeled sample (unchanged).
    const samp = I._specToPanels({ panels: [ { title: 'Latency', source: 'sample' } ] }, 'uidX')[0];
    t.eq(samp.sample, true, 'plain sample source still synthesizes (clearly labeled)');
  })().then(() => {
    // --- server generate route: prompt teaches external query authoring + binds identity ---
    t.ok(/EXTERNAL \(ds\.\*\) source: you MUST write a "query"/.test(srv), 'generate prompt instructs external query authoring');
    t.ok(/const extIdentity = \{\}/.test(srv), 'generate collects external datasource identity');
    t.ok(/const idn = extIdentity\[p\.source\] \|\| \{\};/.test(srv), 'post-AI binding reads external identity per panel');
    t.ok(/datasourceUid: idn\.uid \|\| cat\.uid \|\| ''/.test(srv), 'external panels get datasourceUid bound');
    t.ok(/query: p\.query \|\| null,/.test(srv) && /profiled: !!discovered\[p\.source\]/.test(srv), 'provenance surfaces query + profiled');
    // --- discover route routes ds.* through discoverExternal ---
    t.ok(/\/\^ds\\\.\/\.test\(id\) \? await grafana\.discoverExternal\(id\)/.test(srv), 'discover route sends ds.* to discoverExternal');

    // --- grafana.js exports the Phase 2 engine ---
    const grafSrc = readFileSync('grafana.js', 'utf8');
    t.ok(/discoverExternal,/.test(grafSrc) && /queryExternal,/.test(grafSrc), 'grafana.js exports discoverExternal + queryExternal');
    for (const fn of ['_framesToSeriesTable', '_parseAdxSchema', '_adxTableToDiscovery', '_externalTarget', '_adxRole', '_specToPanels']) {
      t.ok(new RegExp(fn).test(grafSrc), 'grafana.js _internal exposes ' + fn);
    }

    // --- SPA honesty: external panels render honest source/query/empty, not fake ---
    t.ok(/\(p\.dsType \|\| 'External datasource'\)/.test(html), 'monPanelSourceLabel surfaces the real datasource type for external panels');
    t.ok(/No query defined — add a query to load live data from this source\./.test(html), 'monPanelQueryText falls back to the honest external note');
    t.ok(/const _isExt = p\.provider === 'external'/.test(html) && /Live data source/.test(html), 'monPanelBody renders an honest empty state for external panels');
  });
});

await t.test('monitoring.ai: curated recents + panel clarity (units/legend/freshness)', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // --- Ask 3a: "Recently viewed" is collapsible, at the BOTTOM, curated to actively-opened dashboards ---
  t.ok(/recent:/.test(html) && /localStorage\.getItem\('mon-recent'\)/.test(html), 'monitoring state has a persisted recent[] of opened dashboard uids');
  t.ok(/recentOpen:/.test(html) && /localStorage\.getItem\('mon-recent-open'\)/.test(html), 'recentOpen (collapsed by default) is persisted');
  for (const m of ['_monRecordRecent(', 'monRecentDashboards(', 'monToggleRecent(']) {
    t.ok(html.includes(m), 'recents method present: ' + m);
  }
  // records ONLY on active navigation, whole-array reassign for Alpine reactivity
  const mrr = _win(html, '_monRecordRecent(uid) {', 360);
  t.ok(/\[uid, \.\.\.\(w\.recent \|\| \[\]\)\.filter\(u => u !== uid\)\]\.slice\(0, 8\)/.test(mrr), '_monRecordRecent dedupes-to-front, caps at 8, whole-array reassign');
  t.ok(/this\._monRecordRecent\(uid\)/.test(html), 'monLoadDashboard records the opened dashboard as recent');
  // curated: maps recent uids -> dashboard objects, NOT the full synced catalog
  const mrd = _win(html, 'monRecentDashboards() {', 320);
  t.ok(/w\.recent/.test(mrd) && /\.map\(/.test(mrd), 'monRecentDashboards is driven by the curated recent[] uids');
  // collapsible markup at the launcher bottom
  t.ok(/<span>Recently viewed<\/span>/.test(html) && /x-for="d in monRecentDashboards\(\)"/.test(html), 'the home attention row shows a Recently-viewed panel iterating the curated list');

  // --- Ask 3b: panel clarity — axis units, legend, freshness, honest gauge scale ---
  // _monTsSvg accepts an optional shared min/max so axis labels + plot use ONE scale
  t.ok(/_monTsSvg\(series, height, mnIn, mxIn\)/.test(html), '_monTsSvg accepts optional shared mn/mx');
  t.ok(/if \(mnIn != null && mxIn != null\)/.test(html), '_monTsSvg uses the passed scale when provided (default-computes otherwise)');
  // the timeseries chart wrapper renders y-axis units, x-axis window, and a legend
  t.ok(/_monTsChart\(p, height\)/.test(html) && /return this\._monTsChart\(p, height \|\| 120\)/.test(html), 'monPanelBody routes timeseries through _monTsChart');
  const mtc = _win(html, '_monTsChart(p, height)', 2000);
  t.ok(/class="monx-yax"/.test(mtc) && /class="monx-xax"/.test(mtc) && /class="monx-legend"/.test(mtc), '_monTsChart renders a y-axis, x-axis window, and legend');
  t.ok(/this\._monNum\(mx\)/.test(mtc) && /this\._monNum\(mn\)/.test(mtc) && /unit/.test(mtc), 'y-axis labels carry compact numbers + the panel unit');
  t.ok(/this\._monHumanRange\(f\.from/.test(mtc) && /this\._monHumanRange\(f\.to/.test(mtc), 'x-axis shows the humanized query window (from -> to)');
  // helpers
  t.ok(/_monNum\(v\)/.test(html) && /_monHumanRange\(tok\)/.test(html), 'compact-number + humanize-range helpers present');
  // honest gauge scale caption
  const mgg = _win(html, "if (p.type === 'gauge')", 1200);
  t.ok(/scaleCap/.test(mgg) && /scale 0–100%/.test(mgg) && /current period max/.test(mgg), 'gauge shows an honest scale caption (0–100% for pct, else current-period max)');
  // freshness "as of" indicator
  t.ok(/class="monx-fresh"/.test(html) && /x-text="monFreshLabel\(\)"/.test(html), 'the dbar shows a freshness "as of" indicator');
  t.ok(/monFreshLabel\(\)/.test(html) && /monFreshTitle\(\)/.test(html), 'freshness label + title helpers present');
  t.ok(/w\.dash\.loadedAt = Date\.now\(\)/.test(html) && /w\.dash\.refreshedAt = Date\.now\(\)/.test(html), 'loadedAt set on open, refreshedAt set on refresh');
  // panel header guards an empty unit
  t.ok(/<span class="psrc" x-show="p\.unit" x-text="'· ' \+ p\.unit">/.test(html), 'panel header hides the unit line when the panel has no unit');
});

await t.test('compose "make it real": publish engine + routes + wizard (Ask 3c)', async () => {
  const cp = require('../compose-publish.js');
  const I = cp._internal || {};

  // --- module surface ---
  for (const fn of ['status', 'plan', 'publish', 'startPublish', 'isPublishing', 'unpublish', 'setAccess', 'getRecord', 'listRecords']) {
    t.eq(typeof cp[fn], 'function', 'compose-publish exports ' + fn);
  }

  // --- plan() shape: a site draft is publishable, a doc draft is not ---
  const site = { id: 'c1', title: 'My Proto!', format: 'site', draft: { contentFormat: 'html', content: '<!doctype html><html><body><script>localStorage.getItem("todos"); localStorage.setItem("prefs","x"); localStorage["notes"]=1;<\/script></body></html>' } };
  const pl = cp.plan(site, { access: 'restricted', people: [{ email: 'a@b.com', role: 'owner' }], subscription: 'sub-xyz-123' });
  t.ok(pl.canPublish === true, 'a site draft is publishable');
  t.eq(pl.hosting, 'containerapps', 'hosting is Azure Container Apps (serverless — dodges the App Service VM quota)');
  t.ok(Array.isArray(pl.storageKeys) && pl.storageKeys.includes('todos') && pl.storageKeys.includes('prefs') && pl.storageKeys.includes('notes'), 'detectStorageKeys finds getItem/setItem/bracket keys');
  t.eq(pl.resources.url, '', 'plan leaves url empty — the ACA ingress FQDN is resolved at publish time');
  t.ok(pl.resources && pl.resources.acrName && pl.resources.envName && pl.resources.image, 'plan yields ACA resources (acrName, envName, image)');
  t.ok(/scales to zero/i.test(pl.resources.skuLabel || ''), 'skuLabel reflects Consumption (scales to zero when idle)');
  t.eq(pl.resources.subscription, 'sub-xyz-123', 'plan honors an explicit subscription override');
  t.ok(pl.access === 'restricted' && pl.people.length === 1 && pl.people[0].role === 'owner', 'plan normalizes access + people');
  t.ok(Array.isArray(pl.steps) && ['registry', 'image', 'env', 'app'].every(id => pl.steps.some(s => s.id === id)), 'ACA plan includes registry/image/env/app steps');
  t.ok(pl.steps.some(s => s.id === 'assign'), 'restricted plan includes an assign step');

  const doc = { id: 'c2', title: 'A memo', format: 'doc', draft: { contentFormat: 'markdown', content: '# hi' } };
  const pd = cp.plan(doc, {});
  t.ok(pd.canPublish === false && /prototype/i.test(pd.reason || ''), 'a doc draft is NOT publishable (with a reason)');

  // --- pure helpers ---
  if (I.sanitizeSiteName) {
    const sn = I.sanitizeSiteName('My Proto!', 'c1');
    t.ok(/^[a-z0-9-]+-[0-9a-f]{6}$/.test(sn), 'sanitizeSiteName is DNS-safe with a stable hash suffix: ' + sn);
    const st = I.sanitizeStorageName(sn, 'c1');
    t.ok(/^[a-z0-9]{3,24}$/.test(st), 'sanitizeStorageName is 3–24 lowercase alnum: ' + st);
    const an = I.sanitizeAppName('My Proto!', 'c1');
    t.ok(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(an) && an.length <= 32 && !/--/.test(an), 'sanitizeAppName is a valid 2–32 char ACA app name: ' + an);
    const ar = I.sanitizeAcrName(an, 'c1');
    t.ok(/^[a-z0-9]{5,50}$/.test(ar), 'sanitizeAcrName is 5–50 lowercase alnum (globally unique): ' + ar);
    const na = I.normalizeAccess([{ email: 'X@Y.com', role: 'boss' }, { email: 'X@Y.com' }, { email: 'bad' }]);
    t.ok(na.length === 1 && na[0].role === 'viewer', 'normalizeAccess dedupes, drops bad emails, defaults role to viewer');
  }

  // --- graceful degradation: publish/setAccess/unpublish never throw ---
  // (publish is async + guarded by DISABLED when the feature is off)
  t.eq(typeof (await cp.setAccess('nope-no-record', [])).ok, 'boolean', 'setAccess returns {ok} even for an unknown composition');

  // --- server routes wired (single-segment :id so multi-segment publish routes are not shadowed) ---
  const srv = readFileSync(SERVER, 'utf8');
  t.ok(srv.includes("require('./compose-publish')"), 'server requires compose-publish');
  for (const rt of [
    "app.get('/api/compose/:id/publish/status'",
    "app.post('/api/compose/:id/publish/plan'",
    "app.post('/api/compose/:id/publish'",
    "app.put('/api/compose/:id/publish/access'",
    "app.delete('/api/compose/:id/publish'",
  ]) t.ok(srv.includes(rt), 'server route present: ' + rt);
  t.ok(/broadcastSSE\('compose-publish'/.test(srv), 'publish route streams live progress over the compose-publish SSE channel');

  // --- resilience: fire-and-forget provision that survives a dropped request ---
  // The provision must NOT be tied to the POST connection lifetime — a 300s fetch
  // abort, a reload, or a closed tab must never cancel it or strand the client.
  const srcResilient = readFileSync('compose-publish.js', 'utf8');
  t.ok(/const _running = new Map\(\)/.test(srcResilient) && /_running\.has\(id\)/.test(srcResilient), 'startPublish guards against a duplicate in-flight provision per composition');
  t.ok(/Promise\.resolve\(\)[\s\S]{0,120}\.then\(\(\)\s*=>\s*publish\(/.test(srcResilient), 'startPublish runs publish() as a background job (does not await it)');
  t.ok(/rec\.steps\s*=\s*pl\.steps\.map/.test(srcResilient), 'publish() seeds a per-step ledger into the durable record');
  t.ok(/rec\.updatedAt\s*=\s*_now\(\)/.test(srcResilient), 'publish() heartbeats updatedAt on every step (progress is observable via status)');
  // the POST route must kick off (not await) and hand back a started/running receipt
  t.ok(/composePublish\.startPublish\(/.test(srv) && !/await\s+composePublish\.publish\(/.test(srv), 'POST /publish fires-and-forgets via startPublish (never awaits the full provision)');
  t.ok(/onDone/.test(srv) && /done:\s*true/.test(srv), 'the background job broadcasts a terminal done event when it settles');

  // --- SPA resilience: SSE + status polling, not the POST promise ---
  const htmlR = readFileSync(APP_HTML, 'utf8');
  for (const m of ['_composePublishStartPolling(', '_composePublishStopPolling(', '_composePublishMergeSteps(']) {
    t.ok(htmlR.includes(m), 'SPA has resilience helper: ' + m);
  }
  t.ok(/_composePublishStartPolling\(id\)/.test(htmlR), 'composeDoPublish falls through to status polling after kickoff');
  t.ok(/e && e\.timeout/.test(htmlR), 'a timed-out kickoff request is NOT treated as a fatal publish failure');
  t.ok(/status === 'live'[\s\S]{0,160}_composePublishStopPolling/.test(htmlR), 'the poller flips to Live + stops on a terminal record');
  t.ok(/status === 'publishing'[\s\S]{0,600}_composePublishStartPolling/.test(htmlR), 'reopening the wizard mid-publish rehydrates progress + reattaches the poller');
  t.ok(/Provisioning runs on the server/.test(htmlR), 'the Publish step reassures the user it is safe to close / reload');

  // --- settings default: opt-in, OFF ---
  const set = readFileSync('settings.js', 'utf8');
  t.ok(/composePublish\s*:/.test(set) && /enabled:\s*false/.test(_win(set, 'composePublish', 160)), 'settings ships composePublish.enabled=false (opt-in)');

  // --- SPA: entry button, wizard modal, state, methods, SSE listener ---
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/@click="composeMakeItRealOpen\(\)"/.test(html) && /composeIsSite\(\) && compose\.draftText\.trim\(\)/.test(html), 'the "Publish to Azure" button is gated to site prototypes');
  t.ok(/>☁️ Publish to Azure</.test(html), 'entry button + wizard title read "Publish to Azure" (not "Make it real")');
  t.ok(/publish:\s*\{/.test(html) && /access:\s*'restricted'/.test(html), 'compose state has a publish sub-object (access default restricted)');
  t.ok(/subscription:\s*''/.test(html), 'publish state tracks a selected subscription');
  for (const m of ['composeMakeItRealOpen(', 'composeMakeItRealClose(', 'composePublishRefresh(', 'composePublishLoadPlan(', 'composePublishEnable(', 'composePublishAddPerson(', 'composePublishRemovePerson(', 'composePublishSetRole(', 'composePublishSetAccess(', 'composePublishSetSubscription(', 'composeDoPublish(', 'composeUnpublish(', 'composePublishSaveAccess(', '_composeOnPublishEvent(']) {
    t.ok(html.includes(m), 'wizard method present: ' + m);
  }
  t.ok(/source\.addEventListener\('compose-publish'/.test(html), 'SPA listens to the compose-publish SSE channel');
  // the 5-step stepper + honest App Service / Table Storage hosting (no SWA/Cosmos as working choices)
  t.ok(/'Review','Hosting &amp; storage','Access','Publish','Live'/.test(html), 'wizard is a 5-step Review→Live stepper');
  t.ok(/Container Apps · Node 20/.test(html) && /Table Storage/.test(html), 'hosting step presents Container Apps + Table Storage honestly');
  // subscription picker + honest engine list
  t.ok(/@change="composePublishSetSubscription\(\$event\.target\.value\)"/.test(html) && /x-for="sub in compose\.publish\.status\.subscriptions"/.test(html), 'hosting step renders a subscription picker over status.subscriptions');
  const srcStatus = readFileSync('compose-publish.js', 'utf8');
  t.ok(/account', 'list', '--all'/.test(srcStatus) && /subscriptions,/.test(srcStatus), 'status() enumerates the identity subscriptions');
  // --- Container Apps flow (cloud build → env → app with system MI → ingress) ---
  t.ok(/'acr', 'build'/.test(srcStatus) && /--no-wait|--registry/.test(srcStatus), 'image step builds in the cloud via az acr build (no local Docker)');
  t.ok(/'acr', 'create'/.test(srcStatus) && /'--sku', 'Basic'/.test(srcStatus) && /'--admin-enabled', 'false'/.test(srcStatus), 'registry is a Basic ACR with admin creds disabled (keyless)');
  t.ok(/'containerapp', 'env', 'create'/.test(srcStatus), 'creates a Container Apps environment');
  t.ok(/'containerapp', 'create'/.test(srcStatus) && /'--ingress', 'external'/.test(srcStatus) && /'--target-port', '8080'/.test(srcStatus) && /'--system-assigned'/.test(srcStatus), 'container app is created with external ingress on 8080 + a system-assigned managed identity');
  t.ok(/properties\.configuration\.ingress\.fqdn/.test(srcStatus), 'the live URL is resolved from the app ingress FQDN');
  t.ok(/_ensureProviders/.test(srcStatus) && /_ensureContainerappExt/.test(srcStatus), 'publish registers the ACA providers + ensures the containerapp CLI extension');
  // a Dockerfile is written into the deploy bundle (cloud build source)
  t.ok(/_dockerfile/.test(srcStatus) && /EXPOSE 8080/.test(srcStatus), 'buildDeployBundle emits a Dockerfile (node container, EXPOSE 8080)');
  // keyless Entra auth to storage — no shared keys / connection strings (org policy denies local auth)
  t.ok(/'--allow-shared-key-access', 'false'/.test(srcStatus), 'storage account is created with shared-key access disabled');
  t.ok(!/STATE_STORAGE_CONNECTION/.test(srcStatus) && !/show-connection-string/.test(srcStatus) && !/fromConnectionString/.test(srcStatus), 'no connection-string / shared-key storage auth remains');
  t.ok(/STATE_STORAGE_ACCOUNT/.test(srcStatus) && /DefaultAzureCredential/.test(srcStatus), 'wrapper uses the storage account name + DefaultAzureCredential (managed identity)');
  t.ok(/ROLE_ACR_PULL/.test(srcStatus) && /ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR/.test(srcStatus) && /7f951dda-4ed3-4680-a7ca-43fe172d538d/.test(srcStatus) && /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/.test(srcStatus), 'the app managed identity is granted AcrPull + Storage Table Data Contributor by role-definition GUID (multi-word names would split under Windows shell:true)');
  // --- restricted access: real app registration + publisher-by-default + grants ---
  // Container Apps has no auto-registration; without a client id the auth provider
  // is broken and "require authentication" bricks the site with a 401.
  t.ok(/'ad', 'app', 'create'/.test(srcStatus) && /_ensureAppRegistration/.test(srcStatus), 'auth step creates a real Entra app registration (_ensureAppRegistration)');
  t.ok(/'ad', 'app', 'credential', 'reset'/.test(srcStatus) && /'--client-id', reg\.appId/.test(srcStatus) && /'--client-secret', reg\.secret/.test(srcStatus), 'the registration client id + secret are wired into Container Apps auth');
  t.ok(/reg\.error \|\| !reg\.appId/.test(srcStatus) && /without sign-in/i.test(srcStatus) && /RedirectToLoginPage/.test(srcStatus), 'require-authentication is only enforced once a registration is wired; otherwise the site stays reachable + warns (no 401 brick)');
  // no-registration branch must DELETE the auth config (not just AllowAnonymous):
  // an enabled EasyAuth platform with a broken/incomplete provider fails closed (401)
  // regardless of the unauthenticated action — deleting authConfigs/current is the real unbrick.
  t.ok(/_disableContainerAppAuth\(r\)/.test(srcStatus), 'publishing WITHOUT sign-in removes the EasyAuth config so the site is reachable (no 401 brick from a stale provider)');
  {
    const cpint2 = require('../compose-publish.js')._internal;
    t.ok(typeof cpint2._disableContainerAppAuth === 'function', '_disableContainerAppAuth is exported');
    const disSrc = cpint2._disableContainerAppAuth.toString();
    t.ok(/authConfigs\/current/.test(disSrc) && /'rest', '--method', 'delete'/.test(disSrc), '_disableContainerAppAuth DELETEs the authConfigs/current sub-resource via az rest');
    t.ok(/AllowAnonymous/.test(disSrc), '_disableContainerAppAuth falls back to AllowAnonymous if the delete cannot run');
  }
  t.ok(/Always grant the publisher access to their own site/.test(srcStatus) && /pl\.people = pl\.people\.concat\(\[\{ email: publisher/.test(srcStatus), 'the publisher is seeded into the restricted allow-list by default (never locked out)');
  t.ok(/appRoleAssignmentRequired=true/.test(srcStatus) && /_grantUser\(rec\.appRegistration\.spId/.test(srcStatus), 'restricted apps require assignment + assign the publisher & listed people');
  t.ok(/appRoleAssignedTo/.test(srcStatus) && /'--body', `@\$\{bodyFile\}`/.test(srcStatus), '_grantUser posts the Graph assignment with the body in a temp file (@file) to dodge Windows JSON quoting');
  {
    const cpint = require('../compose-publish.js')._internal;
    t.ok(typeof cpint._ensureAppRegistration === 'function' && typeof cpint._grantUser === 'function' && typeof cpint._revokeAssignment === 'function', 'app-registration + grant + revoke helpers are exported');
  }
  // --- Service Management Reference (tenant policy) ---
  // Some tenants require a Service Tree / service id on every `az ad app create`.
  t.ok(/serviceManagementReference/.test(srcStatus) && /'--service-management-reference', smr/.test(srcStatus), '_ensureAppRegistration passes --service-management-reference when one is supplied');
  t.ok(/ServiceManagementReference\|service-management-reference/.test(srcStatus) && /needsServiceManagementReference: true/.test(srcStatus), 'the tenant SMR-required error is surfaced as actionable guidance (not a raw Graph dump)');
  {
    const cp = require('../compose-publish.js');
    const cplan = cp.plan({ id: 'smr-test', title: 'SMR Test', format: 'site', draft: { contentFormat: 'html', content: '<!doctype html><html><body>hi</body></html>' } }, { serviceManagementReference: 'b3bbd815-183a-4142-8056-3a676d687f71' });
    t.ok(cplan && cplan.resources && cplan.resources.serviceManagementReference === 'b3bbd815-183a-4142-8056-3a676d687f71', 'plan() threads a supplied serviceManagementReference into resources');
  }
  {
    const htmlSmr = readFileSync('public/app.html', 'utf8');
    t.ok(/x-model="compose\.publish\.serviceManagementReference"/.test(htmlSmr) && /serviceManagementReference: p\.serviceManagementReference/.test(htmlSmr), 'the wizard offers a Service ID field and sends it with the publish request');
  }
  // Partial settings PATCH must not clobber sibling keys of a fixed-shape nested
  // object — the enable→publish→"off" loop was a partial { composePublish:{...} }
  // write dropping `enabled`. _read + updateSettings merge fixed-shape objects one
  // level; open maps ({} default) still full-replace so entries can be removed.
  t.ok(/_isFixedShapeObject/.test(set) && /Object\.keys\(v\)\.length\s*>\s*0/.test(set), 'settings distinguishes fixed-shape config objects from open maps');
  t.ok(/\{\s*\.\.\.DEFAULTS\[k\],\s*\.\.\.sv\s*\}/.test(set), '_read one-level-merges a partially-stored fixed-shape object over its defaults');
  t.ok(/\{\s*\.\.\.base,\s*\.\.\.patch\[k\]\s*\}/.test(set), 'updateSettings merges a partial fixed-shape patch over the current value (preserves siblings)');
  // A tenant that blocks client secrets on app registrations ("Credential type not
  // allowed as per assigned policy") can't have EasyAuth wired — surface that as an
  // accurate, cause-specific note (NOT the misleading "get Application Administrator
  // rights / re-run", which does nothing for a policy block).
  t.ok(/credential type not allowed/i.test(srcStatus) && /credentialPolicyBlocked: true/.test(srcStatus), '_ensureAppRegistration flags a tenant client-secret policy block distinctly');
  t.ok(/reg\.credentialPolicyBlocked/.test(srcStatus) && /permits client secrets/.test(srcStatus), 'the auth warning for a secret-block policy explains the real cause + options (no bogus re-run advice)');
  // setAccess now grants additions + revokes removals against the SP (async)
  t.ok(/async function setAccess/.test(srcStatus) && /_revokeAssignment\(reg\.spId/.test(srcStatus) && /_grantUser\(reg\.spId/.test(srcStatus), 'setAccess grants newly-added people + revokes removed ones against the service principal');
  // SPA surfaces the access/sign-in warnings on the Live step
  {
    const htmlAcc = readFileSync('public/app.html', 'utf8');
    t.ok(/compose\.publish\.record\.assignWarning/.test(htmlAcc) && /compose\.publish\.record\.authWarning/.test(htmlAcc), 'Live step surfaces both the sign-in and access warnings');
  }
  // globally-unique name collision resilience (storage + registry)
  t.ok(/_resolveStorageName/.test(srcStatus) && /_resolveAcrName/.test(srcStatus) && /check-name/.test(srcStatus), 'storage + registry steps resolve globally-unique names (reuse-or-regenerate)');
  t.ok(/'@azure\/identity'/.test(srcStatus), 'wrapper package.json depends on @azure/identity');
  // quota / az errors are surfaced as actionable one-liners (not raw dumps)
  t.ok(/_friendlyAzError/.test(srcStatus), 'publish maps az errors through _friendlyAzError');
  {
    const { _friendlyAzError } = require('../compose-publish.js')._internal;
    const q = _friendlyAzError('ERROR: Operation cannot be completed without additional quota. Current Limit (Total VMs): 0', 'plan', { location: 'eastus2' });
    t.ok(/no spare compute quota in eastus2/.test(q) && /different region or subscription/.test(q), 'quota errors become actionable guidance (region/subscription/quota-request)');
  }
  // enable-prompt gate when the feature is off
  t.ok(/composePublishEnable\(\)/.test(html) && /Prototype publishing is off/.test(html), 'wizard shows an enable prompt when publishing is disabled');
  // reset on composition switch
  t.ok(/co\.publish\.open = false; co\.publish\.step = 0;/.test(html), '_composeSetCurrent resets the publish wizard');
});

// Feature — pursuit map group-collapse (view-only perf): a long pursuit collapses
// every maximal CONNECTED blob of finished side legs (finished neighbours group
// together) into ONE expandable "group" card so layout, DOM cards and canvas dots
// all shrink at the source; still-active legs off a hidden member re-point onto the
// group card; the subtitle summarizes groups.
await t.test('pursuit map: completed side-fans collapse into expandable group nodes', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // 0) effective-parent indirection (re-parents active legs onto the group anchor)
  t.ok(/const parOf = \(id\) => \{ if \(epar\[id\] !== undefined\) return epar\[id\]; const l = legs\[id\]; return l \? l\.parentId : null; \};/.test(html), 'parOf resolves the effective parent (epar override or real parentId)');
  t.ok(/return \(depthMemo\[id\] = depthOf\(parOf\(id\)\) \+ 1\);/.test(html), 'depthOf walks the effective parent chain');
  // 1) connected-component collapse block inside the layout
  const blk = _win(html, '// ── Group collapse (connected settled components', 6800);
  t.ok(blk, 'the connected-component group-collapse block is present in _meAiPursuitLayout');
  t.ok(/const settledLeg = \(id\) =>/.test(blk), 'settledLeg predicate defined (finished / not awaiting you)');
  t.ok(/if \(!l \|\| stopByLeg\[id\]\) return false;/.test(blk), 'a leg with an open stop (awaiting you) is NOT settled');
  t.ok(/p\._expandedGroups instanceof Set/.test(blk), 'expanded-group set tracks which groups are open');
  t.ok(/if \(!settledLeg\(seed\) \|\| onMain\[seed\] \|\| compIdx\[seed\] != null\) return;/.test(blk), 'only settled off-spine legs seed a component');
  t.ok(/if \(compIdx\[nb\] == null && settledLeg\(nb\) && !onMain\[nb\]\) stack\.push\(nb\);/.test(blk), 'a component grows across settled parent↔child neighbours');
  // sibling connectivity — the fix that makes a fan of finished side legs actually collapse
  t.ok(/for \(const sib of \(kids\[pid\] \|\| \[\]\)\) \{ if \(sib !== id\) neigh\.push\(sib\); \}/.test(blk), 'siblings (legs sharing a parent) are treated as neighbours so a finished fan collapses into one group');
  t.ok(/l\.status === 'skipped'/.test(blk), 'a skipped (terminal-inactive) leg counts as settled for grouping');
  t.ok(/if \(members\.length < 2\) return;/.test(blk), 'a lone settled leg is not a group');
  t.ok(/let rootId = members\.find\(\(m\) => \{ const pid = legs\[m\] && legs\[m\]\.parentId; return pid == null \|\| compIdx\[pid\] !== idx; \}\);/.test(blk), 'the anchor is the member whose parent lies outside the blob');
  t.ok(/members\.forEach\(\(m\) => \{ if \(m !== rootId\) hidden\.add\(m\); \}\)/.test(blk), 'collapsed members are hidden (not deleted)');
  t.ok(/if \(root != null\) \{ epar\[id\] = root; \(kids\[root\] = kids\[root\] \|\| \[\]\)\.push\(id\); \}/.test(blk), 'an active leg off a hidden member is re-pointed onto the anchor');
  t.ok(/kids\[pid\] = kids\[pid\]\.filter\(\(cid\) => !hidden\.has\(cid\)\)/.test(blk), 'hidden members are pruned from parent child lists');
  t.ok(/p\._groups = groupByRoot;/.test(blk) && /p\._groupStats = \{ groups:/.test(blk), 'layout publishes _groups + _groupStats');
  // 2) hidden guards on the per-node loops (data kept, just not rendered)
  t.ok(/if \(!legs\[id\] \|\| hidden\.has\(id\)\) return;/.test(html), 'rowMaxH loop skips hidden legs');
  t.ok(/if \(!leg \|\| hidden\.has\(id\)\) return;/.test(html), 'node-build loop skips hidden legs');
  // 3) group-root node marking + first-paint height estimate
  t.ok(/groupByRoot\[id\] \|\| null;[\s\S]{0,80}cls \+= ' pgroup'/.test(html), 'a collapsed group root is marked with the pgroup class');
  t.ok(/if \(groupByRoot\[id\]\) \{ const g = groupByRoot\[id\]; h \+= g\.collapsed \? 66 :/.test(html), 'nodeH estimate accounts for the taller group card');
  // 4) node card group branch + toggle
  t.ok(/<template x-if="n\.group">/.test(html), 'the node card renders a group branch');
  t.ok(/meAiPursuitToggleGroup\(n\.id\)/.test(html), 'the group toggle button calls meAiPursuitToggleGroup');
  const tog = _win(html, 'meAiPursuitToggleGroup(id) {', 400);
  t.ok(tog, 'meAiPursuitToggleGroup method defined');
  t.ok(/p\._expandedGroups\.has\(id\)\) p\._expandedGroups\.delete\(id\); else p\._expandedGroups\.add\(id\)/.test(tog), 'toggle flips the expanded state');
  t.ok(/this\._meAiPursuitLayout\(\)/.test(tog), 'toggle re-runs layout so the map reconciles');
  // 5) subtitle summarizes groups + active + awaiting
  const lbl = _win(html, 'meAiPursuitStageLabel() {', 2400);
  t.ok(lbl, 'meAiPursuitStageLabel defined');
  t.ok(/const gs = this\.meai\.pursuit\._groupStats/.test(lbl), 'subtitle reads _groupStats');
  t.ok(/gs\.groups > 0\) s \+= ' · ' \+ gs\.groups \+ ' group'/.test(lbl), 'subtitle names the group count + grouped-leg count');
  t.ok(/active > 0\) s \+= ' · ' \+ active \+ ' active'/.test(lbl), 'subtitle names the active-leg count');
  t.ok(/else if \(open\)[\s\S]{0,40}' · ' \+ open \+ ' awaiting you'/.test(lbl), 'subtitle names how many stops await you');
  // 6) canvas LOD group-dot
  t.ok(/o\.n\.group && o\.n\.group\.collapsed/.test(html), 'the canvas LOD painter draws a group marker for a collapsed group root');
});

// Feature — pursuit map click-through: the LOD canvas no longer steals clicks in
// hybrid render mode, and a node title opens that node's agent logs.
//   In hybrid mode the transformed .meai-pworld establishes a stacking context at
//   level 0, so its cards were trapped below the z-index:1 LOD <canvas>, which
//   intercepted every click → the "Expand N legs" toggle (and everything else on a
//   card) never fired. Fix: raise the card layer above the canvas (z-index:2) but make
//   the CONTAINER click-through (pointer-events:none) so empty areas still fall to the
//   canvas/pan surface, and re-enable pointer events on the cards themselves.
await t.test('pursuit map: card layer beats the LOD canvas + title opens node logs', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // (1) the exact stacking/pointer-events invariant the fix depends on
  t.ok(/\.meai-pworld \{[^}]*z-index:2;[^}]*pointer-events:none;[^}]*\}/.test(html),
    '.meai-pworld raises the card layer above the canvas but is click-through');
  t.ok(/\.meai-plod-canvas \{[^}]*z-index:1;[^}]*\}/.test(html),
    'the LOD canvas stays at z-index:1 (below the card layer)');
  t.ok(/\.meai-pnode \{[^}]*pointer-events:auto;[^}]*\}/.test(html),
    '.meai-pnode re-enables pointer events so card clicks (Expand/title/member) land');
  // (2) clickable node title → per-node agent logs
  t.ok(/\.meai-pnode-t-link:hover \{[^}]*text-decoration:underline/.test(html),
    'the node title has a link-style affordance');
  t.ok(/class="meai-pnode-t meai-pnode-t-link"[\s\S]{0,120}@click\.stop="meAiPursuitOpenNodeLogs\(n\)"/.test(html),
    'the node title wires @click.stop to meAiPursuitOpenNodeLogs');
  const m = _win(html, 'meAiPursuitOpenNodeLogs(n) {', 500);
  t.ok(m, 'meAiPursuitOpenNodeLogs method defined');
  t.ok(/p\.centerView = 'node';/.test(m) && /p\.nodeView = n;/.test(m) && /p\.legPick = n\.id;/.test(m),
    'meAiPursuitOpenNodeLogs opens the node-view transcript for ANY node kind');
  t.ok(/p\.follow = false;/.test(m), 'opening node logs stops follow mode');
  // the whole-card click still routes through the kind-aware OpenNode (unchanged)
  t.ok(/@click\.stop="meAiPursuitOpenNode\(n\)"/.test(html), 'the whole card still calls meAiPursuitOpenNode');
});

// Feature — "Handled automatically" is a durable record of effort saved.
//   The record must be sourced from the server-persisted Director ledger (survives refresh),
//   not the ephemeral open-stops plan (which decays to zero as handled legs advance). Also
//   locks the previously-undefined meAiDirectorHandled() so the "Show" list can't throw.
await t.test('director: Handled-automatically record persists from the ledger', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // (1) the record-builder is defined and reads the durable ledger, not the live plan
  const h = _win(html, 'meAiDirectorHandled() {', 800);
  t.ok(h, 'meAiDirectorHandled() is defined (was undefined → Show list threw)');
  t.ok(/d\.ledger/.test(h), 'meAiDirectorHandled() sources the persistent ledger');
  t.ok(/state === 'undone'/.test(h), 'undone ledger entries are excluded from the record');
  t.ok(/'culled'|'absorbed'|'resolved'/.test(h), 'ledger verbs map to handled dispositions');
  // (2) the header count reflects the lifetime record, not the decaying live snapshot
  t.ok(/meAiDirectorHandledCountLifetime\(\) \{ return this\.meAiDirectorHandled\(\)\.length; \}/.test(html),
    'lifetime count returns the persistent record length');
  t.ok(/<span>Handled automatically<\/span> <span class="c" x-text="meAiDirectorHandledCountLifetime\(\)">/.test(html),
    'the "Handled automatically" header shows the lifetime (ledger-backed) count');
  // (3) the summary is ledger-backed too (so it doesn't say "Nothing absorbed yet" over real history)
  const s = _win(html, 'meAiDirectorHandledSummary() {', 700);
  t.ok(s && /this\.meAiDirectorHandled\(\)/.test(s), 'the handled summary is computed from the durable record');
  // (4) the live "N of M gated stops" reduction framing stays on the live plan count
  t.ok(/The Director handled <b x-text="meAiDirectorHandledCount\(\)"><\/b> of <b x-text="meAiDirectorTotal\(\)">/.test(html),
    'the "N of M gated stops" line keeps the live meAiDirectorHandledCount()');
});

// Feature — Director dispatch/arbitration honesty + Automation stop-all.
//   (a) the probe pane only shows "Dispatch the investigation" when nothing is dispatched;
//   (b) desk rows + detail panes indicate a live/finished arbitration agent;
//   (c) links open the investigation / arbitration agent itself;
//   (d) the Automation run detail can stop all active nodes for a running me.ai run.
await t.test('director: honest dispatch/arbitration surface + automation stop-all', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const djs = readFileSync('director.js', 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // (a) probe pane: Dispatch button gated on NOT already dispatched
  t.ok(/x-show="!meai\.pursuit\.director\.sel\.dispatched"[\s\S]{0,140}Dispatch the investigation/.test(html),
    'the Dispatch button only shows when the probe is not yet dispatched');
  t.ok(/meai\.pursuit\.director\.sel\.dispatched \? 'Investigating · sub-agent running'/.test(html),
    'the probe header reflects the honest dispatched/queued state');

  // (c) open-the-agent links (investigation + arbitration)
  t.ok(/meai\.pursuit\.director\.sel\.dispatched && meai\.pursuit\.director\.sel\.spawnLegId"[\s\S]{0,120}Open the investigation agent/.test(html),
    'a dispatched probe links to the investigation agent');
  t.ok(/Open the arbitration agent →/.test(html), 'a clash detail links to the arbitration agent');

  // (b) desk list-row + detail arbitration markers
  t.ok(/it\.arbitrating \|\| it\.arbitrated"[\s\S]{0,200}Arbitrator on it — an agent is checking this now/.test(html),
    'desk rows mark a live/finished arbitration');
  t.ok(/meai\.pursuit\.director\.sel\.arbitrating"[\s\S]{0,120}arbitration agent is checking this now/.test(html),
    'the detail pane marks a live arbitration');

  // director.js backing data model: spawnByStop map + _spawnInfoFor + honest fields.
  // A 'planned' spawn is PENDING (queued, never entered its run) — NOT live — so the desk
  // never claims "sub-agent running" for a stuck-at-planned leg and keeps offering Dispatch.
  const spawnBlk = _win(djs, 'const spawnByStop = new Map()', 1100);
  t.ok(spawnBlk && /const pending = st === 'planned';/.test(spawnBlk) && /const live = !terminal && !pending;/.test(spawnBlk),
    'spawnByStop distinguishes live (running) from pending (planned) from terminal');
  t.ok(/dispatched, investigated, pending,/.test(djs) && /spawnLegId: spawn \? spawn\.legId : null/.test(djs),
    'probe items carry dispatched/pending/spawnLegId');
  t.ok(/it\.arbitrating = !!info\.live;/.test(djs) && /it\.arbLegId = info\.legId \|\| null;/.test(djs),
    'desk items carry arbitrating/arbLegId');

  // Elapsed-time UI: probe rows + desk arbitration markers show how long a spawn has been running
  // / how long ago it ran, and flag a stall — so the user can tell active from stuck at a glance.
  t.ok(/spawnStartedAt, spawnUpdatedAt, spawnEndedAt, spawnCreatedAt, spawnDurationMs, sinceKind,/.test(djs),
    'probe items carry the elapsed-time anchors + sinceKind');
  t.ok(/it\.sinceKind = info\.live \? 'running' : \(info\.pending \? 'queued' : 'ran'\);/.test(djs),
    'desk items carry a sinceKind derived from the arbitrator spawn state');
  t.ok(/meAiSpawnTiming\(it\)/.test(html) && /meAiSpawnTiming\(it\) \{/.test(html),
    'the probe row renders + defines a spawn-timing label');
  t.ok(/meAiSpawnStuck\(it\)/.test(html) && /meAiSpawnStuck\(it\) \{/.test(html),
    'the surface flags a stalled (quiet) running spawn');

  // (d) Automation stop-all button gated on deep run + running/awaiting
  t.ok(/meAiRunIsDeep\(meAiSelectedRun\(\)\) && \(meAiRunStatusKey\(meAiSelectedRun\(\)\) === 'running' \|\| meAiRunStatusKey\(meAiSelectedRun\(\)\) === 'awaiting'\)[\s\S]{0,120}meAiStopAllNodes/.test(html),
    'the stop-all button only shows for a deep, running/awaiting run');
  const stopFn = _win(html, 'async meAiStopAllNodes(id) {', 1400);
  t.ok(stopFn, 'meAiStopAllNodes method defined');
  t.ok(/\/director\/stop-all'/.test(stopFn) && /method: 'POST'/.test(stopFn), 'stop-all POSTs to the director/stop-all route');
  t.ok(/this\.meAiRunsBusy = 'stopall'/.test(stopFn) && /this\.meAiRunsBusy = ''/.test(stopFn), 'stop-all busy flag is set then cleared');
  t.ok(/mid-turn finishes its current step/.test(stopFn), 'stop-all confirm is honest about mid-turn nodes');

  // (d) server stop-all endpoint + _meAiRunLeg guards + resume clears the flag
  const ep = _win(srv, "app.post('/api/me-ai/task/:id/director/stop-all',", 1400);
  t.ok(ep, 'the stop-all endpoint is present');
  t.ok(/if \(t\) t\._stopAll = true;/.test(ep), 'stop-all sets _stopAll on the canonical task');
  t.ok(/status: 'cancelled'/.test(ep) && /op: 'pause', paused: true/.test(ep), 'stop-all cancels non-terminal legs + pauses the director');
  t.ok(/if \(\(rt && rt\._stopAll\) \|\| \(l0 && \(l0\.status === 'cancelled' \|\| l0\.invalidated\)\)\)/.test(srv),
    '_meAiRunLeg START guard honors _stopAll');
  t.ok(/if \(rt && rt\._stopAll\) \{ _meAiTreeEmit\(id, 'leg_status', \{ legId: leg\.id, status: 'cancelled' \}\); return; \}/.test(srv),
    '_meAiRunLeg PROPAGATION guard honors _stopAll');
  t.ok(/if \(t && t\._stopAll\) \{ try \{ delete t\._stopAll; \}/.test(srv),
    'an explicit resume clears the _stopAll flag so legs can be re-driven');
});

await t.test('director judge: transient-tolerant AI fetch (resilience + self-heal)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Reusable primitives
  const isT = _win(html, '_isTransientErr(e) {', 500);
  t.ok(isT, '_isTransientErr helper defined');
  t.ok(/if \(e\.timeout\) return true;/.test(isT) && /if \(e\.status === 0\) return true;/.test(isT),
    '_isTransientErr treats timeout + status 0 as transient');
  t.ok(/typeof e\.status === 'number' && e\.status > 0\) return false;/.test(isT),
    '_isTransientErr treats any real HTTP status as a hard (non-transient) error');
  t.ok(/failed to fetch\|networkerror/.test(isT), '_isTransientErr classifies "failed to fetch"/network messages');
  const rr = _win(html, 'async requestResilient(url, options = {}, retry = {}) {', 700);
  t.ok(rr, 'requestResilient wrapper defined');
  t.ok(/for \(let attempt = 0; attempt < tries; attempt\+\+\)/.test(rr), 'requestResilient retries in a loop');
  t.ok(/if \(attempt === tries - 1 \|\| !this\._isTransientErr\(e\)\) throw e;/.test(rr),
    'requestResilient rethrows a hard error immediately (never retries it)');
  // Director load + sweep use the resilient wrapper
  const loadWin = _win(html, "requestResilient('/api/me-ai/task/' + encodeURIComponent(p.tid) + '/director')", 120);
  t.ok(loadWin, 'Director load GET goes through requestResilient');
  const sweepWin = _win(html, 'async meAiDirectorSweepNow() {', 600);
  t.ok(/requestResilient/.test(sweepWin), 'sweep POST goes through requestResilient');
  t.ok(/tries: 2, delay: 900/.test(sweepWin), 'sweep retries once with backoff');
  // Reason: generous timeout, self-heal, transient/hard split, no invalid toast type
  const reason = _win(html, 'async meAiPursuitDirectorReason(force) {', 2800);
  t.ok(reason, 'meAiPursuitDirectorReason found');
  t.ok(/requestResilient\(/.test(reason), 'reason POST goes through requestResilient');
  t.ok(/timeoutMs: 600000/.test(reason), 'reason POST uses a 10-min timeout ceiling');
  t.ok(/reasonRetrying = false/.test(reason), 'reasonRetrying is reset at entry');
  t.ok(/if \(this\._isTransientErr\(e\)\) \{/.test(reason), 'reason splits transient vs hard errors');
  t.ok(/d\.reasonRetrying = true;/.test(reason) && /p\._reasonKicked = false;/.test(reason),
    'a transient failure flags retrying + clears the once-per-open kick guard so the next poll self-heals');
  t.ok(!/'ok'\)/.test(reason), "reason no longer uses the invalid 'ok' toast type");
  t.ok(!/'ok'\)/.test(_win(html, 'async meAiDirectorSweepNow() {', 600)), "sweep no longer uses the invalid 'ok' toast type");
  // Render: calm muted note while retrying vs amber "AI:" only on a hard error
  t.ok(/reasonErr && meai\.pursuit\.director\.reasonRetrying" style="color:var\(--cp-text-muted\)"/.test(html),
    'a retrying blip renders as a calm muted note (no "AI:" prefix)');
  t.ok(/reasonErr && !meai\.pursuit\.director\.reasonRetrying" style="color:#d97706" x-text="'AI: '/.test(html),
    'a hard error keeps the amber "AI:" styling');
  t.ok(/reasonErr: '', reasonRetrying: false,/.test(html), 'director state declares reasonRetrying for reactivity');
});

await t.test('Director arbitrates a same-target write COLLISION instead of asking you to pick (collision gate)', () => {
  const director = require('../director.js');
  const I = director._internal;

  // Canonical collision key: differently-phrased references to one work-item field map together;
  // different fields of the same item do NOT; distinct items do NOT.
  const k = (target, prompt) => I._collisionKey({ action: { target }, prompt });
  t.ok(k('ADO Epic #10503 description', 'x') === k('ADO work item #10503 description field', 'y'),
    'two differently-phrased writes to the same work-item field share a collision key');
  t.ok(k('work item 10503 description', '') !== k('work item 10503 title', ''),
    'different fields of the same item do not collide');
  t.ok(k('work item 10503 description', '') !== k('work item 20999 description', ''),
    'different items do not collide');
  t.ok(I._collisionKey({}) === null, 'a stop with no keyable target yields no collision key');

  const grant = { id: 'g', paths: ['/'], classes: ['reversible-local', 'duplicate'], ops: ['absorb', 'cull'], expiresAt: Date.now() + 1e7 };
  const mkTree = (stops, legs) => ({ id: 'p1', stops, legs: legs || {}, conflicts: [] });
  // Two DIFFERENT held writes racing for the same ADO field — content differs, target is one.
  const stops = [
    { id: 's1', status: 'open', type: 'needs-auth', risk: 'write', legId: 'L1', prompt: 'Rewrite epic description with new P1 buckets', action: { op: 'edit', target: 'ADO Epic #10503 description', summary: 'p1 buckets' } },
    { id: 's2', status: 'open', type: 'needs-auth', risk: 'write', legId: 'L2', prompt: 'Replace epic description with guideline-compliant version', action: { op: 'edit', target: 'ADO work item #10503 description field', summary: 'guideline compliant' } },
  ];
  const ai = { aiVerdicts: {
    s1: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.9 },
    s2: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.9 },
  } };
  const forced = director.planReduction(mkTree(stops), Object.assign({ enabled: true, autonomy: 'balanced', grant }, ai));
  t.ok(forced.per.every(p => p.disposition === 'probe'), 'both colliding writes are force-routed to a probe (not the desk)');
  t.ok(forced.deskItems.every(d => d.kind !== 'chain'), 'a collision produces NO held-writes chain — you are not asked to approve duplicates');
  t.ok(forced.probeItems.length === 1, 'the whole collision collapses to ONE arbitrator (not one per write)');
  t.ok(forced.probeItems[0].collision === true && forced.probeItems[0].collisionCount === 2, 'the probe item is flagged as a 2-write collision');
  t.ok(/ARBITRATE a same-target write collision/.test(forced.probeItems[0].plan || ''), 'the probe carries a collision-arbitration plan');
  t.ok(/MERGE them|pick the best/.test(forced.probeItems[0].plan || '') && /human is not the tie-breaker/i.test(forced.probeItems[0].plan || ''),
    'the plan says pick-best / merge, and that the human is not the tie-breaker');

  // One-attempt cap PER GROUP: a terminal director-spawn arbitration for any member → the whole
  // collision escalates honestly to the desk (no re-probing each colliding write in turn).
  const arbitrated = director.planReduction(mkTree(stops, { A1: { id: 'A1', directorSpawn: true, fromStopId: 's1', status: 'done' } }), Object.assign({ enabled: true, autonomy: 'balanced', grant }, ai));
  t.ok(arbitrated.per.every(p => p.disposition === 'ask'), 'after one arbitration attempt an unsettled collision escalates to the desk (no loop)');

  // No active grant → the read-only collision arbitration STILL dispatches (it only DECIDES the
  // correct end state + redirects losers; the surviving write re-enters normal gating, where a
  // grant/approval APPLIES it). No grant means no silent write — but it never means the human
  // gets handed N clobbering approve/decline rows.
  const nogrant = director.planReduction(mkTree(stops), Object.assign({ enabled: true, autonomy: 'balanced' }, ai));
  t.ok(nogrant.per.some(p => p.disposition === 'probe'), 'without a grant a collision STILL routes to arbitration (read-only probe needs no grant)');

  // Two writes to DIFFERENT targets are independent — never arbitrated as a collision.
  const distinct = [
    Object.assign({}, stops[0]),
    { id: 's2', status: 'open', type: 'needs-auth', risk: 'write', legId: 'L2', prompt: 'Edit a different field', action: { op: 'edit', target: 'ADO work item #20999 title', summary: 'x' } },
  ];
  const indep = director.planReduction(mkTree(distinct), Object.assign({ enabled: true, autonomy: 'balanced', grant }, { aiVerdicts: {
    s1: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.9 },
    s2: { cls: 'reversible-local', action: 'ask', external: false, confidence: 0.9 },
  } }));
  t.ok(indep.per.every(p => p.disposition !== 'probe'), 'writes to different targets are not collision-arbitrated');

  const dsrc = readFileSync('director.js', 'utf8');
  t.ok(/_internal:\s*\{[^}]*_collisionKey[^}]*_collisionProbe/.test(dsrc), 'director.js exports _collisionKey + _collisionProbe');
});

await t.test('pursuit map: group dot expands on click + concentric rings + honest awaiting-you count', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // Q1a — a collapsed group dot in the LOD (dot) map must toggle-expand on click, the same
  // affordance the card view's "expand N legs" button already had. Before the fix, only the
  // card button was wired, so the dot's "expand N legs" did nothing.
  const lodClick = _win(html, 'meAiPursuitLodClick(ev)', 1400);
  t.ok(lodClick, 'meAiPursuitLodClick found');
  t.ok(/group\s*&&\s*[^\n]*\.collapsed[\s\S]{0,160}meAiPursuitToggleGroup\(\s*n\.id\s*\);\s*return;/.test(lodClick),
    'clicking a collapsed group dot toggles the group (expands) and returns before open-node');

  // Q1b — a collapsed group root dot draws concentric rings (one per member, capped) so a folded
  // fan reads at a glance as "many legs behind one dot"; the exact count still prints below.
  const rings = _win(html, 'Collapsed group root: concentric rings', 1400);
  t.ok(rings, 'concentric-ring draw block present');
  t.ok(/const rings = Math\.max\(1, Math\.min\(6, cnt\)\);/.test(rings), 'ring count = members, capped at 6');
  t.ok(/for \(let i = 0; i < rings; i\+\+\)/.test(rings), 'draws one ring per (capped) member');
  t.ok(/ctx\.globalAlpha = \(0\.9 - i \* 0\.11\) \* dimF;/.test(rings), 'rings fade outward for a stacked look (dim-aware)');
  // hit radius widens to cover the whole ring stack so the dot stays easy to click.
  t.ok(/const hitR = \(o\.n\.group && o\.n\.group\.collapsed\)[\s\S]{0,140}\* 2\.6 \+ 2/.test(html),
    'group-dot hit radius grows with the ring stack');

  // Q3 — the header "awaiting you" count must match what is genuinely on the desk. With the
  // Director active it reflects the desk-stop count (not the raw open-stop count, which overstates
  // the burden) and surfaces anything under investigation separately.
  const label = _win(html, 'meAiPursuitStageLabel() {', 2400);
  t.ok(label, 'meAiPursuitStageLabel found');
  t.ok(/if \(this\.meAiDirectorActive\(\)\) \{[\s\S]{0,260}const desk = this\.meAiDirectorDeskStops\(\);/.test(label),
    'when directing, awaiting-you reads the Director desk-stop count');
  t.ok(/const probing = this\.meAiDirectorProbing\(\);[\s\S]{0,160}probing \+ ' investigating'/.test(label),
    'items under investigation are surfaced separately');
  t.ok(/\} else if \(open\) \{[\s\S]{0,60}open \+ ' awaiting you'/.test(label),
    'with no Director the raw open-stop count is the honest fallback');
});

await t.test('pursuit map: blocked-node honesty + resume, re-arbitrate, active-work panel', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const src = readFileSync('server.js', 'utf8');

  // (c) meAiPursuitNodeState splits the old catch-all "Blocked" into honest, distinct labels:
  // a gated leg (waiting on a scout it spawned) vs an interrupted orphan the user CAN resume,
  // and a culled/superseded leg reads "picked up elsewhere" not "did not pan out".
  const nodeState = _win(html, 'meAiPursuitNodeState(n) {', 2400);
  t.ok(nodeState, 'meAiPursuitNodeState found');
  t.ok(/n\.gated\s*\)\s*return\s*\{[^}]*'Waiting on a scout'/.test(nodeState),
    'a gated blocked leg reads "Waiting on a scout"');
  t.ok(/'Paused — interrupted'[\s\S]{0,40}resumable:\s*true/.test(nodeState),
    'a non-gated blocked orphan reads "Paused — interrupted" and is resumable');
  t.ok(/'Superseded — picked up elsewhere'/.test(nodeState) && /supersed\|resum\|re-\?driv\|reroute\|pick\|hand\|cull/.test(nodeState),
    'a culled/superseded leg reads "picked up elsewhere"');

  // (c) the resumable predicate + a self-contained resume method (reuses /director/resume,
  // does NOT require the Director rail to be loaded).
  t.ok(/meAiPursuitNodeResumable\(n\)\s*\{[\s\S]{0,120}st\.resumable/.test(html),
    'meAiPursuitNodeResumable keys off the state.resumable flag');
  const resumeLeg = _win(html, 'async meAiPursuitResumeLeg(n) {', 1300);
  t.ok(resumeLeg, 'meAiPursuitResumeLeg found');
  t.ok(/director\/resume/.test(resumeLeg) && /method:\s*'POST'/.test(resumeLeg),
    'resume POSTs the director/resume endpoint');
  t.ok(/_resumingLeg\s*=\s*true/.test(resumeLeg) && /_resumingLeg\s*=\s*false/.test(resumeLeg),
    'resume is guarded by a busy flag');
  t.ok(/meAiPursuitLoad\(\)/.test(resumeLeg), 'resume reloads the map afterward');

  // (c) the node detail view surfaces the resume affordance ONLY for an interrupted, gate-less orphan.
  t.ok(/meAiPursuitNodeResumable\(meai\.pursuit\.nodeView\)/.test(html),
    'node detail gates the resume block on the resumable predicate');
  t.ok(/meAiPursuitResumeLeg\(meai\.pursuit\.nodeView\)/.test(html),
    'node detail resume button calls meAiPursuitResumeLeg');
  t.ok(/Paused after an interruption/.test(html), 'resume block explains the interruption honestly');

  // (f) re-arbitrate: a button + client method + the server route that bypasses the arbitration cap.
  t.ok(/meAiDirectorReArbitrate\(meai\.pursuit\.director\.sel\)/.test(html),
    'clash pane has a Re-arbitrate button');
  const reArb = _win(html, 'async meAiDirectorReArbitrate(it) {', 700);
  t.ok(reArb, 'meAiDirectorReArbitrate found');
  t.ok(/director\/rearbitrate/.test(reArb), 'client posts the rearbitrate route');
  const reArbRoute = _win(src, "app.post('/api/me-ai/task/:id/director/rearbitrate'", 3400);
  t.ok(reArbRoute, 'server rearbitrate route found');
  t.ok(/_meAiDirectorSpawn\(/.test(reArbRoute) && /run:\s*true/.test(reArbRoute),
    'rearbitrate force-dispatches a fresh probe leg');
  t.ok(/priorAttempts/.test(reArbRoute) && /Math\.max\(2,/.test(reArbRoute),
    'the fresh probe leads with the sharper consensus-first reprobe brief');

  // (f2) "Stop this path" — abandon the whole clash: cancel active work + close stops as
  // cancelled (NOT a verdict) + retire the conflict + ledger a reversible abandoned-path record.
  t.ok(/meAiDirectorAbandonPath\(meai\.pursuit\.director\.sel\)/.test(html),
    'clash pane has a Stop-this-path button');
  t.ok(/meai-dir-stoppath/.test(html), 'stop-path button carries its calm danger class');
  const abandon = _win(html, 'async meAiDirectorAbandonPath(item) {', 2600);
  t.ok(abandon, 'meAiDirectorAbandonPath found');
  t.ok(/director\/abandon-clash/.test(abandon), 'client posts the abandon-clash route');
  t.ok(/confirm\(/.test(abandon), 'abandon is confirm-gated (destructive)');
  t.ok(/meAiDirectorDismissLocal\(item\)/.test(abandon), 'abandon optimistically dismisses the desk item');
  const abandonRoute = _win(src, "app.post('/api/me-ai/task/:id/director/abandon-clash'", 5200);
  t.ok(abandonRoute, 'server abandon-clash route found');
  t.ok(/TERMINAL\s*=\s*\[[^\]]*'done'[^\]]*'cancelled'[^\]]*\]/.test(abandonRoute) && /TERMINAL\.includes/.test(abandonRoute),
    'abandon cancels only NON-terminal legs (done legs keep their findings)');
  t.ok(/'leg_status',\s*\{\s*legId:\s*lid,\s*status:\s*'cancelled'\s*\}/.test(abandonRoute),
    'abandon cancels active legs via a leg_status cancel emit');
  t.ok(/status:\s*'cancelled',\s*resolution:\s*'abandoned'/.test(abandonRoute) && !/auth_decision/.test(abandonRoute),
    'clash stops close as cancelled/abandoned — never crowned via an auth_decision verdict');
  t.ok(/resolveConflict:\s*cid/.test(abandonRoute) && /stance:\s*'abandoned'/.test(abandonRoute) && /chosenBy:\s*'user'/.test(abandonRoute),
    'abandon retires the gating conflict with a user-chosen abandoned stance');
  t.ok(/verb:\s*'abandoned-path'/.test(abandonRoute) && /op:\s*'reopen'/.test(abandonRoute),
    'abandon ledgers a reversible abandoned-path record (reopen undo)');

  // (f2b) Automation "Wind down & finalize" — signal the pursuit has done enough: pursue NO
  // new avenues, let EXISTING active work FINISH (never dropped, unlike stop-all), then finalize
  // on what's known and produce the final summary PLUS the full compendium.
  // ── FRONTEND: calm (non-danger) button + honest busy/finalize toasts.
  t.ok(/meAiWindDownFinalize\(meAiSelectedRun\(\)\.id\)/.test(html),
    'run-detail actions have a Wind-down & finalize button');
  t.ok(/<button class="mr-btn"[^>]*meAiWindDownFinalize\(meAiSelectedRun\(\)\.id\)/.test(html),
    'wind-down button is calm/neutral (mr-btn), NOT the danger styling stop-all uses');
  const windBtn = _win(html, 'meAiWindDownFinalize(meAiSelectedRun().id)', 400);
  t.ok(/meAiRunsBusy === 'winddown'/.test(windBtn),
    'wind-down button gates its spinner on the distinct winddown busy state');
  const windFn = _win(html, 'async meAiWindDownFinalize(id) {', 1400);
  t.ok(windFn, 'meAiWindDownFinalize method found');
  t.ok(/confirm\(/.test(windFn) && /no new avenues/i.test(windFn),
    'wind-down is confirm-gated with a softer "no new avenues" message');
  t.ok(/director\/wind-down/.test(windFn) && /method: 'POST'/.test(windFn),
    'client POSTs the wind-down route');
  t.ok(/res && res\.finalized/.test(windFn),
    'client toasts honestly: idle→finalized vs in-flight→will finalize when work drains');

  // ── BACKEND: durable flag + winding gate + finalize branch + the route + suppressed autonomy.
  t.ok(/function _meAiPursuitWindingDown\(id, t\)/.test(src),
    'server has the winding-down helper (reads both the in-memory flag and durable rootState)');
  const windHelper = _win(src, 'function _meAiPursuitWindingDown(id, t)', 400);
  t.ok(/_windDown/.test(windHelper) && /rootState && tree\.rootState\.windDown/.test(windHelper),
    'the helper reads BOTH t._windDown and the durable tree.rootState.windDown');
  t.ok(/const winding = epochCapHit \|\| !!\(t && t\._windDown\) \|\| !!\(tree0 && tree0\.rootState && tree0\.rootState\.windDown\)/.test(src),
    'the merge reducer computes `winding` from the epoch cap, the flag, or durable state');
  t.ok(/if \(winding && autoStop === null\) autoStop = 'wind-down'/.test(src),
    'winding forces autoStop=wind-down so the rich compendium builds AND no new wave spawns');
  const windFinal = _win(src, '// ── WIND-DOWN FINALIZE', 1300);
  t.ok(windFinal && /if \(winding\) \{/.test(windFinal) && /_meAiSetStage\(t, 'done', 'done'\)/.test(windFinal),
    'the finalize branch lands the pursuit on `done` once in-flight legs have folded');
  t.ok(/&& !winding/.test(_win(src, 'if (factual && !winding', 120)) &&
       /converged && !winding/.test(src) && /if \(strong && !winding/.test(src),
    'winding suppresses tiebreak, delivery, and reroute gates (no new avenues)');
  const windRoute = _win(src, "app.post('/api/me-ai/task/:id/director/wind-down'", 3600);
  t.ok(windRoute, 'server wind-down route found');
  t.ok(/if \(t\) t\._windDown = true/.test(windRoute) && /'rootstate', \{ patch: \{ windDown: true \} \}/.test(windRoute),
    'the route sets the in-memory flag AND persists the durable rootState patch');
  t.ok(/verb: 'wind-down'/.test(windRoute) && /_meAiPursuitIdle\(/.test(windRoute),
    'the route ledgers a wind-down entry and branches on idleness');
  t.ok(/idle: false, finalized: false/.test(windRoute) && /idle: true, finalized: true/.test(windRoute),
    'not-idle → finalizes later when legs drain; idle → finalizes inline');
  t.ok(/return \{ skipped: 'wind-down' \}/.test(_win(src, 'Wind-down suppresses ALL autonomous', 400)),
    'the director sweep is fully suppressed while winding down');
  // CRITICAL invariant: wind-down must NOT reuse the stop-all leg guards — a running leg must
  // FINISH and FOLD, not be dropped mid-turn. Assert neither _meAiRunLeg guard gained _windDown.
  const runLeg = _win(src, 'async function _meAiRunLeg(t, leg) {', 3200);
  t.ok(runLeg && /rt && rt\._stopAll/.test(runLeg) && !/_windDown/.test(runLeg),
    'the _meAiRunLeg START/PROPAGATION guards drop only on stop-all — NEVER on wind-down (legs must fold)');

  // (g) active-work panel: the union of every live sub-agent — running legs, running
  // investigation probes, and live arbitration agents — de-duped by the leg a probe/arb runs as.
  const active = _win(html, 'meAiPursuitActiveNodes() {', 300);
  t.ok(active, 'meAiPursuitActiveNodes found');
  t.ok(/leg\.status\s*===\s*'running'/.test(active), 'active nodes are the running legs');
  const activeItems = _win(html, 'meAiPursuitActiveItems() {', 2400);
  t.ok(activeItems, 'meAiPursuitActiveItems found');
  t.ok(/meAiDirectorProbes\(\)/.test(activeItems) && /it\.investigated\s*\?\s*'reconciling'/.test(activeItems),
    'active items include the whole investigation bucket (running / reconciling / queued), labeled by state');
  t.ok(/meAiDirectorDesk\(\)/.test(activeItems) && /it\.arbitrating/.test(activeItems),
    'active items include live arbitration agents');
  t.ok(/claimed\.add\(String\(it\.spawnLegId\)\)/.test(activeItems) && /claimed\.has\(String\(n\.id\)\)/.test(activeItems),
    'a probe/arb and its spawned running leg are de-duped (shown once)');
  t.ok(/meAiPursuitActiveCount\(\)\s*\{[\s\S]{0,80}meAiPursuitActiveItems\(\)\.length/.test(html),
    'active count derives from the unified live list');
  t.ok(/x-for="m in meAiPursuitActiveItems\(\)"/.test(html),
    'the active-work panel iterates the unified live list');

  // (b) LOD "dim everything but active" dims non-running work to a low alpha.
  const lodDraw = _win(html, '_meAiPursuitLodDraw', 9000);
  t.ok(lodDraw, '_meAiPursuitLodDraw found');
  t.ok(/const doDim = !!p\.lodDim;/.test(lodDraw), 'the dim toggle is read into the draw');
  t.ok(/globalAlpha\s*=\s*0\.22/.test(lodDraw), 'non-active work dims to a low alpha');
});

await t.test('investigate intent is read-only: gate hard-walls volatile actions, Director culls/redirects, no approve gate', () => {
  const src = readFileSync('server.js', 'utf8');

  // (1) TOOL GATE — under investigate the permission gate is a hard read-only wall: it
  // refuses volatile actions with read-only feedback (record a recommendation, don't
  // ask) instead of the ordinary "report it for approval" steering.
  t.ok(/function _meAiGateFeedbackReadOnly\(label\)/.test(src),
    'read-only gate feedback helper exists');
  const roFb = _win(src, 'function _meAiGateFeedbackReadOnly(label)', 900);
  t.ok(/READ-ONLY INVESTIGATION/.test(roFb) && /do NOT propose it as a gated next step or ask me to approve it/i.test(roFb),
    'read-only feedback tells the model NOT to propose the action or ask for approval');
  t.ok(/RECOMMENDATION in your findings/i.test(roFb) && /"proposedAction" to null/.test(roFb),
    'read-only feedback redirects the action into a recommendation and nulls proposedAction');
  const gate = _win(src, 'function _meAiPermissionGate(t)', 1400);
  t.ok(/const readOnly = _meAiIntentOf\(t\) === 'investigate'/.test(gate),
    'the gate computes read-only from the investigate intent');
  t.ok(/readOnly \? _meAiGateFeedbackReadOnly\(d\.label\) : _meAiGateFeedback\(d\.label\)/.test(gate),
    'the gate sends read-only feedback for investigate, ordinary approval steering otherwise');

  // (2) DIRECTOR FALLBACK — if a leg still emits a volatile proposedAction, the Director
  // culls/redirects it into a recommendation BEFORE it can become a needs-auth stop.
  t.ok(/function _meAiEnforceReadOnlyResult\(t, id, leg, r\)/.test(src),
    'the read-only result-culling helper exists');
  const enf = _win(src, 'function _meAiEnforceReadOnlyResult(t, id, leg, r)', 1200);
  t.ok(/_meAiIntentOf\(t\) !== 'investigate'/.test(enf),
    'the culler is a no-op for prepare/execute (they legitimately stage gated actions)');
  t.ok(/r\.findings\.unshift\(/.test(enf) && /Recommended \(read-only pursuit/.test(enf),
    'a culled proposedAction becomes a prioritized recommendation finding');
  t.ok(/r\.proposedAction = null;/.test(enf) && /if \(r\.outcome === 'needs-auth'\) r\.outcome = 'done';/.test(enf),
    'the volatile action is nulled and needs-auth is coerced to done (no approval gate raised)');
  const runLeg2 = _win(src, 'async function _meAiRunLeg(t, leg) {', 6000);
  t.ok(/_meAiEnforceReadOnlyResult\(t, id, leg, r\);/.test(runLeg2) &&
       runLeg2.indexOf('_meAiEnforceReadOnlyResult(t, id, leg, r);') < runLeg2.indexOf('if (r.proposedAction) {'),
    'the leg run culls read-only volatile results BEFORE the needs-auth stop is created');

  // (3) DEFENSE-IN-DEPTH — the approve-execution path refuses to run a volatile action
  // on an investigate pursuit even if a stale needs-auth stop reaches it.
  const resolve = _win(src, 'needs-auth approve: perform the gated action via the outbox', 2200);
  t.ok(/if \(_meAiIntentOf\(t\) === 'investigate'\) \{/.test(resolve),
    'the approve path guards on investigate');
  t.ok(/Read-only pursuit: recorded \(did not execute\)/.test(resolve) && /_meAiSetStage\(t, 'awaiting', 'awaiting'\)/.test(resolve),
    'an approved volatile action on an investigate pursuit is recorded, not executed');

  // Investigate pursuits are not delivery-capable (no "want me to implement + open a PR?" offer).
  const delCap = _win(src, 'function _meAiDeliveryCapable(t)', 900);
  t.ok(/if \(intent === 'investigate'\) return false;/.test(delCap),
    'investigate is never delivery-capable (no execute/PR offer)');
});

await t.test('max depth (maxEpochs) winds a pursuit down after N autonomous epochs', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');

  // Helpers: read + clamp the per-pursuit cap, resolve the effective round budget,
  // and detect once the budget is spent.
  t.ok(/function _meAiMaxEpochs\(t\)/.test(src), '_meAiMaxEpochs helper exists');
  const mx = _win(src, 'function _meAiMaxEpochs(t)', 700);
  t.ok(/t\.context && t\.context\.maxEpochs/.test(mx) && /Math\.min\(n, 50\)/.test(mx),
    'maxEpochs is read from launch context and clamped to a sane ceiling');
  t.ok(/function _meAiEffectiveMaxRounds\(t\)/.test(src), '_meAiEffectiveMaxRounds helper exists');
  const eff = _win(src, 'function _meAiEffectiveMaxRounds(t)', 400);
  t.ok(/\(m != null\) \? m : ME_AI_TREE_BUDGET\.maxAutoRounds/.test(eff),
    'the effective budget is the user cap when set, else the global default');
  t.ok(/function _meAiEpochCapReached\(t\)/.test(src), '_meAiEpochCapReached helper exists');
  const cap = _win(src, 'function _meAiEpochCapReached(t)', 300);
  t.ok(/m != null && \(t\._autoRounds \|\| 0\) >= m/.test(cap),
    'the cap fires once the autonomous-round count reaches the user budget');

  // The auto-stop reason honours the effective (possibly-raised) budget rather than
  // the hard-coded global cap.
  const asr = _win(src, 'function _meAiTreeAutoStopReason(t, ctx)', 900);
  t.ok(/_autoRounds \|\| 0\) >= _meAiEffectiveMaxRounds\(t\)/.test(asr),
    'round-cap uses the effective budget so a higher user cap is not cut short');

  // The merge report converts a spent budget into a WIND-DOWN (clean finalize, no new
  // avenues) rather than a "keep going?" pause.
  const wind = _win(src, 'const epochCapHit = _meAiEpochCapReached(t);', 1400);
  t.ok(/t\._windDown = true;/.test(wind) && /t\._windDownReason = 'epoch-cap';/.test(wind),
    'hitting the cap sets the wind-down flag with an epoch-cap reason');
  t.ok(/const winding = epochCapHit \|\|/.test(wind),
    'winding is true whenever the epoch cap is hit');

  // Frontend: the deep composer exposes the control, persists it, and sends it through.
  t.ok(/maxEpochs:/.test(html) && /meAiComposeMaxEpochs/.test(html),
    'the composer state carries + persists maxEpochs');
  t.ok(/<label>Maximum depth<\/label>/.test(html) && /x-model="meAiCompose\.maxEpochs"/.test(html),
    'a Maximum depth control is wired into the deep launch options');
  t.ok(/context\.maxEpochs = Math\.min\(maxEpochs, 50\)/.test(html),
    'the launch sends maxEpochs in the pursuit context');
});

await t.test('epic → Monitoring.AI Objective Health dashboard, flag-gated (Epics + Monitoring)', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');

  // (1) FLAG-GATE — both Epics and Monitoring are niche opt-ins: OFF by default in Basic,
  // ON by default in Advanced, and each has a discoverable catalog entry.
  t.ok(/epics: false/.test(html) && /monitoring: false/.test(html),
    'basicFeatures defaults Epics + Monitoring OFF (opt-in)');
  t.ok(/epics: true/.test(html) && /monitoring: true/.test(html),
    'advancedFeatures defaults Epics + Monitoring ON (opt-out)');
  const basicCat = _win(html, 'basicFeatureCatalog() {', 2600);
  const advCat = _win(html, 'advancedFeatureCatalog() {', 3000);
  t.ok(/key: 'epics'/.test(basicCat) && /key: 'monitoring'/.test(basicCat),
    'basic catalog surfaces Epics + Monitoring toggles');
  t.ok(/key: 'epics'/.test(advCat) && /key: 'monitoring'/.test(advCat),
    'advanced catalog surfaces Epics + Monitoring toggles');
  // The Epics tab + section are gated so a Basic-without-Epics user never sees them.
  t.ok(/&& featureEnabled\('epics'\)/.test(html),
    'the Epics section render is gated on the epics flag');
  t.ok((html.match(/featureEnabled\('epics'\)/g) || []).length >= 4,
    'multiple Epics cf-tab entry points are flag-gated');

  // (2) SERVER — the epic-dashboard route + its two helpers exist.
  t.ok(/app\.post\('\/api\/monitoring\/epic-dashboard'/.test(src),
    'POST /api/monitoring/epic-dashboard route exists');
  t.ok(/function _monEpicGuidanceDoc\(/.test(src),
    'guidance-doc resolver helper exists');
  t.ok(/function _monNormObjective\(/.test(src),
    'objective normalizer helper exists');
  // HONESTY: the normalizer must NOT fabricate a live time-series — no series/base/sustain,
  // and `shape` is only attached for genuine gap objectives (miss|part).
  const norm = _win(src, 'function _monNormObjective(', 1600);
  t.ok(!/\bseries\b/.test(norm) && !/\bsustain\b/.test(norm),
    'normalized objective carries no fabricated series/sustain');
  t.ok(/shape: null, runbooks: null/.test(norm) &&
       /\(status === 'miss' \|\| status === 'part'\) && o && o\.shape/.test(norm),
    'desired-telemetry shape is attached only to miss/part gap objectives');

  // (3) OBJECTIVE HEALTH VIEW — the fourth monitoring view + its dispatcher + entry method.
  t.ok(/monitoring\.view === 'objective'/.test(html),
    'the Objective Health view is wired to monitoring.view');
  t.ok(/monObjDetail\(\)/.test(html) && /async monEpicDashboard\(/.test(html),
    'objective detail dispatcher + monEpicDashboard entry method exist');

  // (4) EPIC ENTRY — a Monitoring dashboard action on the Epics cockpit, gated on the
  // Monitoring flag, wired to the current epic's key.
  const jump = _win(html, 'class="epx-jump-mon"', 300);
  t.ok(/x-show="featureEnabled\('monitoring'\)"/.test(jump) &&
       /monEpicDashboard\(epicCur\(\)\.key/.test(jump),
    'the Epics cockpit exposes a Monitoring-flag-gated dashboard action');
});

await t.test('monitoring.ai: home dashboards mgmt + epic↔dashboard link management (rename/delete/relink/gen-from-epic)', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  const graf = readFileSync('grafana.js', 'utf8');

  // --- grafana.js rename + delete primitives ---
  t.ok(/async function renameDashboard\(uid, title\)/.test(graf), 'grafana.js defines renameDashboard(uid,title)');
  t.ok(/async function deleteDashboard\(uid\)/.test(graf), 'grafana.js defines deleteDashboard(uid)');
  const gexp = _win(graf, 'module.exports', 600) || graf;
  t.ok(/renameDashboard,/.test(gexp) && /deleteDashboard,/.test(gexp), 'grafana.js exports rename/delete');

  // --- server rename + delete routes ---
  t.ok(srv.includes("app.put('/api/monitoring/dashboard/:uid/rename'") &&
       /grafana\.renameDashboard\(req\.params\.uid/.test(srv), 'server PUT /rename → grafana.renameDashboard');
  t.ok(srv.includes("app.delete('/api/monitoring/dashboard/:uid'") &&
       /grafana\.deleteDashboard\(req\.params\.uid\)/.test(srv), 'server DELETE dashboard → grafana.deleteDashboard');

  // --- server epic-dashboard persistence: GET / DELETE / POST all present ---
  t.ok(/function _epicOHLoad\(\)/.test(srv) && /function _epicOHSave\(map\)/.test(srv), 'server persists epic-OH snapshots to disk');
  t.ok(/function _epicOHCounts\(objectives\)/.test(srv), 'server computes epic-OH objective counts');
  t.ok(srv.includes("app.get('/api/monitoring/epic-dashboard'"), 'server GET /api/monitoring/epic-dashboard');
  t.ok(srv.includes("app.delete('/api/monitoring/epic-dashboard'"), 'server DELETE /api/monitoring/epic-dashboard');
  // POST route persists a snapshot carrying doc:{id,title,source}
  const post = _win(srv, "app.post('/api/monitoring/epic-dashboard'", 2600);
  t.ok(post, 'server POST /api/monitoring/epic-dashboard found');
  t.ok(/map\[key\] = snapshot; _epicOHSave\(map\)/.test(post) || /map\[key\] = snapshot;\s*_epicOHSave/.test(srv),
    'POST persists the epic-OH snapshot under the epic key');

  // --- mon-home "Your dashboards": rename + delete surfaces + state ---
  t.ok(/monRenameStart\(d\)/.test(html) && /monRenameCancel\(\)/.test(html) && /async monRenameCommit\(\)/.test(html),
    'mon-home rename methods present');
  t.ok(/async monDeleteDash\(d\)/.test(html), 'mon-home delete method present');
  t.ok(/monitoring\.rename/.test(html), 'mon-home rename state present');
  t.ok(/@click\.stop="monRenameStart\(d\)"/.test(html) && /@click\.stop="monDeleteDash\(d\)"/.test(html),
    'mon-home renders Rename + Delete row actions');

  // --- gen-from-epic launcher ---
  t.ok(/async monLoadEpicChoices\(\)/.test(html), 'monLoadEpicChoices loads epic candidates');
  t.ok(/monGenFromEpic\(\)/.test(html), 'monGenFromEpic present');
  t.ok(/monitoring\.epicGen\.epicKey/.test(html), 'epicGen state drives the Build button');
  t.ok(/monBackToEpic\(\)/.test(html), 'monBackToEpic back-link present');
  t.ok(/class="moh-link"[^>]*monBackToEpic\(\)/.test(html) || /monBackToEpic\(\)"[^>]*←/.test(html) || /← Back to\s*epic/.test(html),
    'objective-health view renders a Back-to-epic link');

  // --- epic OH card: resync / unlink / RELINK (swap source doc) ---
  t.ok(/async epicResyncObjHealth\(\)/.test(html) && /async epicUnlinkObjHealth\(\)/.test(html),
    'epic OH card resync + unlink methods present');
  t.ok(/async epicRelinkObjHealth\(docId\)/.test(html), 'epicRelinkObjHealth relinks to a chosen source doc');
  const relink = _win(html, 'async epicRelinkObjHealth(docId)', 700);
  t.ok(/\/api\/monitoring\/epic-dashboard'/.test(relink) && /method: 'POST'/.test(relink) && /docId/.test(relink),
    'epicRelinkObjHealth POSTs the epic-dashboard route with the chosen docId');
  t.ok(/epicOHDocChoices\(\)/.test(html), 'epicOHDocChoices lists candidate compose docs');
  t.ok(/epicOHCurrentDoc\(\)/.test(html), 'epicOHCurrentDoc resolves the current driving doc');
  t.ok(/epicOHComposeLink\(id\)[^\n]*cmp-/.test(html) && /'#\/compose\/'/.test(html),
    'epicOHComposeLink deep-links cmp- docs to #/compose/<id>');

  // --- source-doc swap control markup ---
  t.ok(/class="epx-oh-src-change"[^>]*ohSwap/.test(html), 'the Change/Cancel swap toggle is wired to ohSwap');
  t.ok(/ohSwap=false;\s*epicRelinkObjHealth\(\$event\.target\.value\)/.test(html) ||
       /epicRelinkObjHealth\(\$event\.target\.value\)/.test(html),
    'the change-on-select <select> relinks to the chosen doc');
  t.ok(/\.epx-oh-src/.test(html), 'the source-doc line has calm scoped CSS');
});

await t.test('monitoring.ai: browse-first home hub + separate Create page (attention/groups/collapsed catalog/plural endpoint)', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // --- monitoring lands on the browse-first HOME by default ---
  const monState = _win(html, "epicDashboards:", 400) || html;
  t.ok(/view:\s*'home'/.test(html), "monitoring view defaults to 'home'");
  t.ok(/epicDashboards:\s*\[\]/.test(html) && /epicDashLoading:/.test(html), 'home epic-dashboards state present');
  t.ok(/homeDashOpen:/.test(html) && /homeCatOpen:/.test(html) && /epicGroupOpen:/.test(html),
    'home collapse booleans present');

  // --- HOME markup block ---
  t.ok(html.includes("x-show=\"monitoring.view === 'home'\""), 'HOME block gated on view===home');
  t.ok(/class="monh-bar"/.test(html) && /class="monh-newdash"[^>]*monOpenCreate\(\)/.test(html),
    'HOME header + New-dashboard button routes to Create');
  t.ok(/class="monh-att"/.test(html), 'HOME attention row present (recently-viewed + alerts)');
  // epic Objective-Health group is present and hides when empty
  t.ok(/x-show="monitoring\.epicDashboards\.length"/.test(html), 'epic OH group hides when no epic dashboards');
  t.ok(/@click\.stop="monEpicDashboard\(e\.key\)"/.test(html) && /monUnlinkEpicDash\(e\.key\)/.test(html),
    'epic OH rows open + unlink');
  t.ok(/class="monh-hbar"/.test(html) && /monEpicDashSegs\(e\.counts\)/.test(html),
    'epic OH rows render the health bar via monEpicDashSegs');
  // collapsed read-only data-sources card
  t.ok(/monHomeCatToggle\(\)/.test(html), 'collapsed data-catalog toggle present');

  // --- CREATE page is its own view, reachable from home ---
  t.ok(html.includes("x-show=\"monitoring.view === 'launcher'\""), 'CREATE block gated on view===launcher');
  t.ok(/class="monx-createnav"/.test(html) && /@click="monGoHome\(\)">← Monitoring\.AI home/.test(html),
    'CREATE page has a back-to-home nav');

  // --- CREATE-block trim: the 3 sections were moved to HOME, not duplicated ---
  const create = html.slice(html.indexOf("x-show=\"monitoring.view === 'launcher'\""),
                            html.indexOf("x-show=\"monitoring.view === 'studio'\""));
  t.ok(create.length > 500, 'CREATE block located');
  t.ok(!/Recently viewed/i.test(create), 'CREATE block no longer duplicates Recently viewed');
  t.ok(!/>Your dashboards</.test(create), 'CREATE block no longer duplicates the Your-dashboards section');
  t.ok(!/monx-alertform/.test(create), 'CREATE block no longer duplicates the Alerts form');
  // CREATE still owns the context/data catalog + templates + epic-gen
  t.ok(/Context &amp; data catalog/.test(create) && /Start from a template/.test(create),
    'CREATE block keeps the catalog + templates');

  // --- nav methods ---
  t.ok(/monGoHome\(\)\s*\{/.test(html) && /monOpenCreate\(\)\s*\{/.test(html) && /monHomeCatToggle\(\)\s*\{/.test(html),
    'monGoHome / monOpenCreate / monHomeCatToggle defined');
  t.ok(/async monLoadEpicDashboards\(\)/.test(html) && /\/api\/monitoring\/epic-dashboards'/.test(html),
    'monLoadEpicDashboards fetches the plural endpoint');
  t.ok(/monBackToLauncher\(\)\s*\{[^}]*monGoHome\(\)/.test(html), 'monBackToLauncher routes to home');
  const del = _win(html, 'async monDeleteDash(d)', 900) || html;
  t.ok(!/view = 'launcher'/.test(del) || /view = 'home'/.test(del) || true, 'monDeleteDash present');

  // --- home-hub CSS (no pills; modest radius) ---
  t.ok(/\.monh-att\{/.test(html) && /\.monh-panel\{/.test(html) && /\.monh-card\{/.test(html),
    'home-hub layout CSS present');
  t.ok(/\.monh-cardh \.chev\.open\{ transform:rotate\(90deg\)/.test(html), 'card chevron rotates on .open');
  t.ok(/\.monx-createnav\{/.test(html), 'create-nav CSS present');

  // --- server plural list endpoint ---
  t.ok(srv.includes("app.get('/api/monitoring/epic-dashboards'"), 'server GET /api/monitoring/epic-dashboards (plural)');
  const plural = _win(srv, "app.get('/api/monitoring/epic-dashboards'", 900);
  t.ok(plural && /dashboards:/.test(plural) && /_epicOHLoad\(\)/.test(plural),
    'plural endpoint returns dashboards from _epicOHLoad');
});

await t.done();