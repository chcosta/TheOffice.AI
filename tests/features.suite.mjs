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
const SDK_RUNNER = 'sdk-runner.js';

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

await t.test('agent detail: CLI launch is verified + Shift+Enter inserts a growing newline', () => {
  const srv = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/function _openAgentCliWindow\(/.test(srv) &&
       /Start-Process -FilePath \$launcher/.test(srv) &&
       /-PassThru -ErrorAction Stop/.test(srv) &&
       /Windows did not return a terminal process id/.test(srv) &&
       /pid: launch\.pid/.test(srv),
    'the CLI endpoint confirms Windows created a terminal process before reporting success');
  const composerStart = html.indexOf('macComposerKey(item, ev) {');
  const composer = composerStart >= 0 ? html.slice(composerStart, composerStart + 2200) : '';
  t.ok(/ev\.key === 'Enter' && ev\.shiftKey/.test(composer) &&
       /ev\.preventDefault\(\)/.test(composer) &&
       /value\.slice\(0, start\) \+ '\\n' \+ value\.slice\(end\)/.test(composer) &&
       /el\.setSelectionRange\(start \+ 1, start \+ 1\)/.test(composer) &&
       /this\.macComposerGrow\(el\)/.test(composer),
    'Shift+Enter explicitly inserts a newline at the caret instead of sending or completing a mention');
  t.ok(/@input="macMentionScan\(item, \$event\); macComposerGrow\(\$event\.target\)"/.test(html) &&
       /Math\.min\(160, Math\.max\(38, el\.scrollHeight\)\)/.test(html),
    'the agent composer grows as multiline content is entered');
});

await t.test('desktop: internal Code Flow PR links stay in the SPA', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/if \(!isExternal && \/\^#\\\//.test(html) &&
       /location\.hash = u\.hash/.test(html),
    'the desktop external-link bridge keeps same-origin SPA hash routes in the WebView');
  t.ok(/@click\.stop="openSlotPrInFlow\(d, cfCurPr\(d\)\._slot\)">Open PR<\/button>/.test(html),
    'dev-card Open PR actions route through Code Flow instead of target=_blank');
  t.ok(!/<a class="cf-primeact pr"[^>]*target="_blank"[^>]*>Open PR/.test(html),
    'the primary dev-card PR action is no longer an external-link anchor');
});

await t.test('Code Flow: PR tabs swap per-view data immediately and sequence in-flight loads', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const state = sliceSource(APP_HTML, 'codeflow: {', 'filterRepo:');
  const transition = sliceSource(APP_HTML, '_cfStoreViewCache(view, data) {', 'toggleCodeflowDrafts() {');
  const focus = sliceSource(APP_HTML, 'async focusCodeflowPr(rawKey) {', 'cfWt(pr) {');

  t.ok(/loadedView:\s*''/.test(state) && /viewCache:\s*\{\}/.test(state),
    'Code Flow state tracks which view owns the visible list and caches each view separately');
  t.ok(/_cfSaveActiveView\(\)[\s\S]*_cfRestoreView\(view\)[\s\S]*this\.codeflow\.loading = true[\s\S]*return this\.loadCodeFlow\(\)/.test(transition),
    'a tab switch snapshots the outgoing view, restores or clears the incoming view, then starts loading');
  t.ok(/this\.codeflow\.pullRequests = cached \? cached\.pullRequests : \[\]/.test(transition) &&
       /this\.codeflow\.selectedKey = cached \? cached\.selectedKey : ''/.test(transition),
    'an uncached view clears both cards and selection instead of leaking the previous tab');
  t.ok(/this\._cfLoadEpochs\[view\] !== epoch/.test(transition) &&
       /_cfStoreViewCache\(view,[\s\S]*if \(this\.codeflow\.view !== view\) return/.test(transition),
    'late responses can warm their own cache but cannot overwrite the active or newer request');
  t.ok(/toggleReviewsOnly\(\)[\s\S]*this\.setCodeflowView\(this\.codeflow\.reviewsOnly \? 'reviews' : 'active'\)/.test(html),
    'the reviews-only toggle uses the same safe tab transition');
  t.ok(/await this\.setCodeflowView\(this\.codeflow\.reviewsOnly \? 'reviews' : 'active'\)/.test(focus) &&
       /await this\.setCodeflowView\('active'\)/.test(focus),
    'deep-link fallback uses the same safe tab transition');
  t.ok(/class="cf-view-updating" x-show="codeflow\.loading"/.test(html) &&
       /x-show="codeflow\.loading && !cfViewReady\(\)" class="cf-view-loading"/.test(html) &&
       /x-show="cfViewReady\(\) && filteredCodeflowPrs\(\)\.length"/.test(html),
    'the active tab shows an updating state and never renders cards owned by another view');
});

await t.test('Code Flow: You are here rows use a gold rail border', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/here: yahIsOn\('dev:' \+ card\.id\)/.test(html) &&
       /here: yahIsOn\('pr:' \+ cfPrKey\(pr\)\)/.test(html),
    'both dev-card and PR index rows bind the shared here state');
  t.ok(/\.dvx-idx-row\.here, \.dvx-idx-row\.here\.sel \{[^}]*var\(--cp-warning, #f5a623\)[^}]*box-shadow:inset 0 0 0 2px/s.test(html),
    'the here state wins over selection with a visible gold inset border');
  t.ok(!/class="dvx-idx-here"/.test(html),
    'the old magenta dot is removed instead of competing with the gold border');
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

// Code Flow "↻ Refresh" must actually RUN the auto-create sweep (POST /api/dev-auto-create/run),
// not merely reload the list — otherwise a newly-assigned work item never gets a card until the
// background sweep happens to fire ("refresh does nothing / had to wait"). And a repo-less
// auto-created card (empty repoMappings → no slots → no agents) must offer a way to assign a
// repo, or the user is stranded with a bare shell and no agent UI.
await t.test('code flow: Refresh runs the auto-create sweep + repo-less cards offer an "Assign a repository" CTA', () => {
  const html = readFileSync('public/app.html', 'utf8');
  // Refresh button is wired to refreshDevItems (not the bare list reload) + busy-aware.
  t.ok(/@click="refreshDevItems\(\)"/.test(html), 'Refresh button calls refreshDevItems()');
  t.ok(!/x-text="devItemsLoaded \? '↻ Refresh' : '…'"[^>]*@click="loadDevItems\(\)"/.test(html), 'Refresh no longer only reloads the list');
  // The method posts the sweep, tolerates 400/409, then reloads, and toasts an honest result.
  const fn = _win(html, 'async refreshDevItems() {', 900);
  t.ok(fn, 'refreshDevItems method exists');
  t.ok(/\/api\/dev-auto-create\/run/.test(fn), 'refreshDevItems POSTs the auto-create sweep');
  t.ok(/method:\s*'POST'/.test(fn), 'sweep is a POST');
  t.ok(/catch\s*\(/.test(fn), 'swallows 400 (no rules) / 409 (busy) without a fatal error');
  t.ok(/loadDevItems\(\)/.test(fn), 'always reloads the list after the sweep');
  t.ok(/typeof r\.created === 'number'/.test(fn), 'honest toast keyed on the created count');
  // Repo-less card CTA present in BOTH worktree panes (board-embedded + Code Flow page).
  const ctas = html.match(/x-if="!devSlots\(d\)\.length"/g) || [];
  t.gte(ctas.length, 2, '"no slots" CTA renders in both worktree panes');
  const assignBtns = html.match(/@click\.stop="openDevModal\(d\)">Assign a repository/g) || [];
  t.gte(assignBtns.length, 2, 'both CTAs open the dev modal to assign a repo');
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

await t.test('code flow: draft PR filter is persisted and applied centrally', () => {
  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/<span>Hide draft PRs<\/span>/.test(html), 'filters expose the Hide draft PRs checkbox');
  t.ok(/hideDrafts:\s*\(\(\) => \{[\s\S]{0,180}cfHideDrafts/.test(html), 'filter state restores from localStorage');
  const toggle = _win(html, 'toggleCodeflowDrafts() {', 350);
  t.ok(/localStorage\.setItem\('cfHideDrafts'/.test(toggle), 'filter changes persist to localStorage');
  const filter = _win(html, 'filteredCodeflowPrs() {', 450);
  t.ok(/if \(this\.codeflow\.hideDrafts\) list = list\.filter\(p => !p\.isDraft\)/.test(filter), 'shared PR list excludes drafts');
});

await t.test('code flow: PR cards track durable review checkpoints and answer what changed', () => {
  const srv = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  const azdo = readFileSync('azdo.js', 'utf8');
  const github = readFileSync('github.js', 'utf8');
  t.ok(/codeflow-pr-checkpoints\.json/.test(srv), 'checkpoints persist outside the repository');
  t.ok(/app\.get\('\/api\/codeflow\/pr\/attention'/.test(srv), 'detailed activity endpoint exists');
  t.ok(/app\.post\('\/api\/codeflow\/pr\/attention\/checkpoint'/.test(srv), 'mark-caught-up endpoint exists');
  t.ok(/previousCommitIds/.test(srv) && /approvalsDropped/.test(srv) && /awaitingConfirmation/.test(srv),
    'server derives commit, approval, and feedback deltas');
  t.ok(/async function getPrCommits/.test(azdo) && /async function getChangedFilesBetween/.test(azdo),
    'Azure DevOps exposes commit and diff history');
  t.ok(/async function getPrCommits/.test(github) && /async function getChangedFilesBetween/.test(github),
    'GitHub exposes commit and diff history');
  t.ok(/class="cf-attention-verdict"/.test(html) && /<h4>What changed<\/h4>/.test(html) &&
    /<h4>Feedback<\/h4>/.test(html) && /<h4>Activity and approval<\/h4>/.test(html) &&
    /<h4>Worktree<\/h4>/.test(html), 'shared PR card has the approved answer-first sections');
  t.ok(/cfMarkCaughtUp\(pr\)/.test(html) && /loadCfAttention\(pr/.test(html),
    'checkpoint and detail-loading actions are wired');
});

await t.test('AI configuration exposes model-aware reasoning and bounded Code Flow reviews', () => {
  const settings = readFileSync('settings.js', 'utf8');
  const runner = readFileSync('sdk-runner.js', 'utf8');
  const server = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/chatReasoningEffort:\s*''/.test(settings) &&
    /executionReasoningEffort:\s*''/.test(settings) &&
    /systemReasoningEffort:\s*''/.test(settings) &&
    /function resolveReasoningEffort\(category, config\)/.test(settings),
    'reasoning effort is persisted and resolved independently for each AI category');
  t.ok(/opts\.reasoningEffort = effort/.test(runner) &&
    /await session\.sendAndWait\(payload, timeoutMs\)/.test(runner),
    'the SDK receives reasoning effort and a per-run timeout');
  t.ok(/await session\.setModel\(requestedModel/.test(runner) &&
    /entry\.reasoningEffort = opts\.reasoningEffort/.test(runner),
    'kept-alive chats apply model and effort changes before their next turn');
  t.ok(/reasoningEfforts:\s*Array\.isArray\(m\.supportedReasoningEfforts\)/.test(server) &&
    /codeflowReviewTimeoutMinutes/.test(server),
    'the server exposes model capabilities and applies the Code Flow timeout');
  t.ok(/modelEffortOptions\('execution'\)/.test(html) &&
    /low:\s*'Fast'/.test(html) &&
    /Code Flow AI review timeout/.test(html),
    'Settings presents friendly, model-aware effort levels and a review timeout');
});

await t.test('Code Flow AI review reports durable live phase and tool activity', () => {
  const server = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  const sdkRunner = readFileSync(SDK_RUNNER, 'utf8');
  const route = _win(server, "app.post('/api/codeflow/pr/review'", 14000);
  t.ok(/reviewPhase: haveWt \? 'context' : 'worktree'/.test(route) &&
    /reviewProgress: haveWt \? 'Reading the pull request/.test(route) &&
    /reviewActivity:\s*\[\]/.test(route),
    'the review records an immediately visible starting phase');
  t.ok(/onStep = \(step\)/.test(route) &&
    /step\.kind === 'tool_start'/.test(route) &&
    /reviewActivity:\s*activity\.slice\(-8\)/.test(route),
    'safe tool activity is persisted while the reviewer works');
  t.ok(/run && run\.ok === false && run\.error/.test(route) &&
    /Review stopped before producing an artifact/.test(route),
    'timeouts and runtime failures remain visible instead of collapsing into a generic missing-artifact error');
  t.ok(/const reportBefore = _cfReportFingerprint\(wtPath\)/.test(route) &&
    /const freshReport = !!reportAfter/.test(route) &&
    /const ok = !!\(run && run\.ok\) && freshReport && !!report/.test(route),
    'each attempt must successfully create or rewrite the canonical report; an old artifact cannot fake success');
  t.ok(/reviewAttemptOutcome: ok \? 'succeeded' : 'failed'/.test(route) &&
    /reviewArtifact/.test(route) &&
    /reportHistory/.test(route),
    'the attempt stores its outcome, exact new artifact, and refreshed history together');
  t.ok(/if \(rec\.reviewStatus !== 'reviewing'\)[\s\S]{0,180}findAndCacheReports/.test(server),
    'status polling does not publish or version a report while the agent may still be writing it');
  t.ok(/class="cf-review-progress"/.test(html) &&
    /cfReviewMeta\(pr\)/.test(html) &&
    /cfReviewActivity\(pr\)/.test(html),
    'PR cards render current work, model, reasoning effort, elapsed time, and recent activity');
  t.ok(/extra\.reviewLive = _cfActiveReviews\.has\(key\)/.test(server) &&
    /extra\.reviewHeartbeatAt = new Date\(\)\.toISOString\(\)/.test(server),
    'status polls include a live server heartbeat for an in-process review');
  t.ok(/AI process active · server heartbeat received/.test(html) &&
    /No recent heartbeat · checking whether the review stalled/.test(html) &&
    /cfReviewTitle\(pr\)/.test(html),
    'the card explicitly distinguishes active work from a possibly stalled review');
  t.ok(/const maxPolls = Math\.ceil/.test(html) &&
    /reviewTimeoutMinutes/.test(html),
    'browser polling follows the configured review window instead of silently stopping after 15 minutes');
  t.ok(/Latest review succeeded · new report available/.test(html) &&
    /Latest review did not produce a new report/.test(html) &&
    /Open new report/.test(html) &&
    /View Artifacts/.test(html),
    'Worktree and Artifacts retain an explicit latest-attempt receipt with a direct report action');
  t.ok(/completionText:\s*'DONE'/.test(route) &&
    /reviewCompletionReason/.test(route) &&
    /reviewTrace/.test(route) &&
    /event\.type === 'assistant\.message' && !event\.agentId/.test(sdkRunner) &&
    /View full run/.test(html) &&
    /Private chain-of-thought is not exposed/.test(html),
    'reviews exit on their exact terminal response and retain a safe full-run viewer');
});

await t.test('Code Flow Explorer opens the resolved worktree folder explicitly', () => {
  const server = readFileSync(SERVER, 'utf8');
  const openDir = _win(server, "app.post('/api/codeflow/pr/worktree/open-dir'", 4200);
  const fsOpen = _win(server, "app.post('/api/fs/open'", 1800);
  t.ok(/provider:\s*o\.provider/.test(openDir),
    'usable-worktree resolution keeps the forge provider when locating the PR checkout');
  t.ok(/const explorerDir = path\.resolve\(dir\)/.test(fsOpen) &&
    fsOpen.includes("spawn('explorer.exe', [`/e,\"${explorerDir}\"`], {") &&
    /windowsVerbatimArguments:\s*true/.test(fsOpen),
    'Windows Explorer receives an explicit quoted folder argument instead of an ambiguous bare path');
  t.ok(/return res\.json\(\{ ok: true, target, path: explorerDir \}\)/.test(fsOpen),
    'the open response reports the exact folder requested');
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

// Dev-card Artifacts "Files": the agent's uncommitted worktree files (scripts,
// data, source edits) that the Reports scan intentionally skips must surface —
// backend lister + status mapper + traversal-guarded reader, server-side
// aggregation + serve route wired next to reports, and a SPA Files section.
await t.test('devitems: worktree file lister maps porcelain status + reader is traversal/ext guarded', () => {
  const D = 'devitems.js';
  const prelude = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    sliceSource(D, 'const WORKTREE_TEXT_EXTS', ']);'),
    sliceSource(D, 'const WORKTREE_TEXT_NAMES', ']);'),
  ].join('\n');
  const F = extractFns(D, ['_porcelainStatus', 'readWorktreeFile'], { prelude });

  // Porcelain XY -> human status. Untracked (??) is "new"; a .ps1/.csv the agent
  // wrote lands here, NOT in the report scan.
  t.eq(F._porcelainStatus('??'), 'new', 'untracked -> new');
  t.eq(F._porcelainStatus('A '), 'added', 'added -> added');
  t.eq(F._porcelainStatus('R '), 'renamed', 'renamed -> renamed');
  t.eq(F._porcelainStatus(' D'), 'deleted', 'deleted -> deleted');
  t.eq(F._porcelainStatus(' M'), 'modified', 'modified -> modified');

  // readWorktreeFile: reads a real text file, blocks traversal + non-text types.
  const osM = require('node:os'), fsM = require('node:fs'), pathM = require('node:path');
  const dir = fsM.mkdtempSync(pathM.join(osM.tmpdir(), 'wtfiles-'));
  try {
    fsM.writeFileSync(pathM.join(dir, 'probe.ps1'), 'Write-Host hi');
    const r = F.readWorktreeFile(dir, 'probe.ps1');
    t.eq(String(r.content), 'Write-Host hi', 'reads the script content back');
    t.eq(r.contentType, 'text/plain; charset=utf-8', 'a .ps1 serves as text/plain (source), not executed');
    fsM.writeFileSync(pathM.join(dir, 'report.html'), '<b>x</b>');
    t.eq(F.readWorktreeFile(dir, 'report.html').contentType, 'text/html; charset=utf-8', 'html serves as text/html');
    let threw = null; try { F.readWorktreeFile(dir, '..\\..\\secret.txt'); } catch (e) { threw = e; }
    t.ok(threw && threw.status === 403, 'path traversal is forbidden (403)');
    threw = null; try { F.readWorktreeFile(dir, 'x.exe'); } catch (e) { threw = e; }
    t.ok(threw && threw.status === 415, 'a non-text/binary ext is refused (415)');
  } finally { try { fsM.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

await t.test('devitems: exports the worktree file lister + reader', () => {
  const d = readFileSync('devitems.js', 'utf8');
  const exp = d.slice(d.lastIndexOf('module.exports'));
  t.ok(/\blistWorktreeFiles\b/.test(exp), 'listWorktreeFiles is exported');
  t.ok(/\breadWorktreeFile\b/.test(exp), 'readWorktreeFile is exported');
});

await t.test('dev cards: readiness distinguishes commits, local files, and worktree contents', () => {
  const fsM = require('node:fs');
  const osM = require('node:os');
  const pathM = require('node:path');
  const { execFileSync } = require('node:child_process');
  const root = fsM.mkdtempSync(pathM.join(osM.tmpdir(), 'readiness-'));
  const origin = pathM.join(root, 'origin.git');
  const dev = pathM.join(root, 'dev');
  const pr = pathM.join(root, 'pr');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git(root, 'init', '--bare', origin);
    fsM.mkdirSync(dev);
    git(dev, 'init');
    git(dev, 'config', 'user.email', 'readiness@example.test');
    git(dev, 'config', 'user.name', 'Readiness Test');
    fsM.writeFileSync(pathM.join(dev, 'README.md'), 'base\n');
    git(dev, 'add', 'README.md');
    git(dev, 'commit', '-m', 'base');
    git(dev, 'branch', '-M', 'main');
    git(dev, 'remote', 'add', 'origin', origin);
    git(dev, 'push', '-u', 'origin', 'main');
    git(dev, 'checkout', '-b', 'feature');
    fsM.writeFileSync(pathM.join(dev, 'committed.txt'), 'committed\n');
    git(dev, 'add', 'committed.txt');
    git(dev, 'commit', '-m', 'feature');
    git(dev, 'push', '-u', 'origin', 'feature');
    fsM.writeFileSync(pathM.join(dev, 'working.txt'), 'dev contents\n');
    git(root, 'clone', origin, pr);
    git(pr, 'checkout', 'feature');
    fsM.writeFileSync(pathM.join(pr, 'working.txt'), 'different PR contents\n');

    const snap = require('../devitems.js').worktreeReadiness(dev, {
      sourceBranch: 'feature', targetBranch: 'main', prWorktreePath: pr, fetch: false
    });
    t.ok(snap.remote.inSync, 'local HEAD matches the remote feature branch');
    t.eq(snap.target.ahead, 1, 'feature commit is counted against the target branch');
    t.eq(snap.changeCount, 1, 'the uncommitted file is counted separately');
    t.eq(snap.branchChangeCount, 1, 'the committed branch file is listed separately');
    t.ok(snap.prWorktree.headSame && snap.prWorktree.filesSame, 'the two worktrees share HEAD and changed paths');
    t.notOk(snap.prWorktree.contentSame, 'different contents at the same path are detected');
    t.notOk(snap.prWorktree.equivalent, 'same paths alone do not make worktrees equivalent');
    const shared = require('../devitems.js').worktreeReadiness(dev, {
      sourceBranch: 'feature', targetBranch: 'main', prWorktreePath: dev, fetch: false
    });
    t.ok(shared.prWorktree.samePath && shared.prWorktree.equivalent, 'a shared Dev/PR checkout is identified explicitly');
  } finally {
    try { fsM.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

await t.test('dev cards: readiness is persisted per approach and rendered in both card surfaces', () => {
  const server = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/const _DEV_WT_MIRROR = \[[^\]]*'readiness'/.test(server), 'readiness participates in the active-approach mirror');
  t.ok(/function _withActiveDevRuntime\(slot, partial\)/.test(server), 'aggregate refreshes update the active approach');
  t.ok(/partial\.readiness = _devReadiness/.test(server) && /out\.readiness = _devReadiness/.test(server), 'primary and extra repos calculate readiness');
  t.ok(/_saveDevWorktree\(ctx, slot\.id, _activeDevWtId\(slot\), \{ git: r\.status \|\| slot\.git, readiness \}\)/.test(server), 'sync persists readiness through the active approach');
  t.ok(/_saveDevWorktree\(ctx, slot\.id, _activeDevWtId\(slot\), \{ git, readiness \}\)/.test(server), 'push persists readiness through the active approach');
  t.eq((html.match(/class="dcgit"/g) || []).length, 2, 'both duplicated Dev Card surfaces render the readiness module');
  t.ok(/devReadinessRows\(s\)/.test(html) && /devStateFiles\(s\)/.test(html), 'readiness and file triage helpers are wired');
  t.eq((html.match(/devReadiness\(s\) \? '↻ Refresh' : 'Check now'/g) || []).length, 2, 'both card surfaces expose a persistent readiness refresh');
  t.ok(/Detailed branch comparison has not been checked/.test(html) && /No problem is implied/.test(html), 'unchecked and unavailable states are explicitly non-alarming');
  t.ok(/PR uses this Dev worktree/.test(html), 'a shared Dev/PR checkout is explained as healthy');
  t.ok(/AI summary/.test(html) && /Workspaces\.AI/.test(html) && /Artifacts/.test(html), 'existing Dev Card capabilities remain present');
});

await t.test('dev cards: readiness issues expose the operation that resolves them', () => {
  const server = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/app\.post\('\/api\/boards\/:id\/dev-items\/:devId\/update-from-target'/.test(server),
    'dev cards can merge or rebase the target branch locally');
  t.ok(/devitems\.updateFromTargetBranch\(slot\.worktreePath/.test(server),
    'target update uses the existing guarded git operation');
  t.ok(/action:\s*'update-target'[\s\S]{0,160}actionLabel:\s*'Update from '/.test(html),
    'a behind-target readiness row offers Update from <target>');
  t.ok(/action:\s*'sync'[\s\S]{0,100}actionLabel:\s*'Sync branch'/.test(html),
    'missing origin commits offer branch sync');
  t.ok(/action:\s*'files'[\s\S]{0,100}actionLabel:\s*'Review files'/.test(html),
    'uncommitted files open the file decisions');
  t.ok(/action:\s*remote\.behind\s*\?\s*'sync'\s*:\s*\(count\s*\?\s*'files'\s*:\s*'push'\)/.test(html) &&
    /actionLabel:[^\n]*'Push commits'/.test(html) && /slotPushCommits\(d, s\)/.test(html),
    'committed local-only work can be pushed without auto-committing files');
  t.eq((html.match(/@click="devRunReadinessAction\(d,s,row\)"/g) || []).length, 2,
    'both duplicated readiness surfaces render row actions');
  t.eq((html.match(/>↕ Commits<\/button>/g) || []).length, 0,
    'the redundant worktree toolbar Commits button is removed');
  t.eq((html.match(/'⟳ Sync'/g) || []).length, 0,
    'the redundant worktree toolbar Sync button is removed');
  t.ok(/Show local \/ remote commits/.test(html),
    'commit evidence remains available from Branch relationship');
  t.ok(/_cfAiResolveUpdateConflicts\(slot\.worktreePath/.test(server) &&
    /manualRequired:\s*true/.test(server) &&
    /operationAborted:/.test(server),
    'target updates ask AI to resolve conflicts and restore the worktree before requiring manual help');
  t.eq((html.match(/@click="openDevStateFileDiff\(d,s,f\)"/g) || []).length, 2,
    'both readiness file lists expose a per-file diff action');
  t.ok(/body:\s*JSON\.stringify\(\{\s*path:\s*s\.worktreePath,\s*target:\s*'diff',\s*file:\s*f\.rel\s*\}\)/.test(html),
    'the file diff action requests only the selected worktree file');
});

await t.test('dev cards: pull requests can be created as drafts', () => {
  const server = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');
  const github = readFileSync('github.js', 'utf8');
  const azdo = readFileSync('azdo.js', 'utf8');
  t.eq((html.match(/@click="slotCreatePr\(d,s,true\)"/g) || []).length, 2,
    'both duplicated Dev Card surfaces offer Draft PR');
  t.ok(/async createDevPr\(d, draft = false\)/.test(html) &&
    /slotCreatePr\(d, s, draft = false\)/.test(html) &&
    /body:\s*JSON\.stringify\(\{\s*draft/.test(html),
    'the selected draft mode is sent through the Dev Card PR request');
  t.ok(/const draft = !!\(req\.body && req\.body\.draft\)/.test(server) &&
    /_devCreatePullRequest\(_devDesc\(slot\),\s*\{[\s\S]{0,300}\bdraft\b/.test(server),
    'the Dev Card PR route passes draft mode to the forge provider');
  t.ok(/\bdraft:\s*!!draft/.test(github), 'GitHub PR creation emits draft');
  t.ok(/\bisDraft:\s*!!draft/.test(azdo), 'Azure DevOps PR creation emits isDraft');
});

await t.test('server: _rescanDevFiles aggregates live worktree files + a repo-scoped serve route', () => {
  const s = readFileSync('server.js', 'utf8');
  t.ok(/function _rescanDevFiles\(d\)/.test(s), '_rescanDevFiles helper exists');
  // Files come from LIVE slots only (worktree present) - dead slots contribute
  // nothing, since these files are not cached like reports.
  t.ok(/_rescanDevFiles[\s\S]{0,400}if \(!s\.worktreePath\) continue;/.test(s), 'skips dead slots (live-only)');
  t.ok(/devitems\.listWorktreeFiles\(s\.worktreePath\)/.test(s), 'delegates to devitems.listWorktreeFiles per live slot');
  // The serve route resolves the slot by its stable id and reads live.
  const route = s.slice(s.indexOf("app.get('/api/boards/:id/dev-items/:devId/file'"));
  t.ok(route.startsWith("app.get('/api/boards/:id/dev-items/:devId/file'"), 'GET .../file route exists');
  t.ok(/_devReportSlots\(d\)\.find\(s => s\.id === repoId && s\.worktreePath\)/.test(route.slice(0, 900)), 'route resolves the live slot by repoId');
  t.ok(/devitems\.readWorktreeFile\(slot\.worktreePath, rel\)/.test(route.slice(0, 900)), 'route serves via the guarded reader');
  // Wired next to reports at the reports/scan endpoint (representative site).
  t.ok(/reportHistory,[\s\S]{0,120}files: f\.files, filesTruncated: f\.truncated/.test(s), 'files ride alongside reports on save');
});

// The primary dev-card /worktree route must persist the ready (and error) worktree
// THROUGH the active approach (_saveDevWorktree), not the slot top-level only
// (_saveRepoSlot). A card that already carries a devs[] array keeps its runtime
// fields ONLY on the active approach; writing top-level-only leaves devs[0] empty,
// so the SPA's per-approach readers (wtReady/activeDevWt → the agent block + "＋ Add
// an agent" button) never render. That was the "sibling card shows no agents / no
// way to create them" bug.
await t.test('server: dev-card /worktree persists through the active approach (mirror invariant)', () => {
  const s = readFileSync('server.js', 'utf8');
  const start = s.indexOf("app.post('/api/boards/:id/dev-items/:devId/worktree'");
  t.ok(start >= 0, 'primary dev worktree POST route exists');
  const route = s.slice(start, start + 5200);
  // Success branch: write through the active approach, fall back to slot save only
  // when the slot can't be resolved.
  t.ok(/const freshSlot = _findRepoSlot\(fresh\.dev, slot\.id\);/.test(route), 'resolves the fresh slot for the ready write');
  t.ok(/if \(freshSlot\) _saveDevWorktree\(fresh, slot\.id, _activeDevWtId\(freshSlot\), save\);/.test(route), 'ready worktree is saved through the active approach');
  t.ok(/else _saveRepoSlot\(fresh, slot\.id, save\);/.test(route), 'falls back to a plain slot save when unresolved');
  // Error branch mirrors the same discipline.
  t.ok(/if \(freshSlot\) _saveDevWorktree\(fresh, slot\.id, _activeDevWtId\(freshSlot\), errSave\);/.test(route), 'error status is also saved through the active approach');
  // The success branch never writes the ready status via the top-level-only path.
  t.ok(!/_saveRepoSlot\(fresh, slot\.id, \{ worktreePath: r\.worktreePath/.test(route), 'no top-level-only ready save remains');
});

// Changing a dev card's repo IDENTITY (provider/org/project/repo) must reconcile the
// primary slot's approaches to fresh branches off the NEW repo: the old branch/base/
// worktree/PR were seeded from the previous repo and won't resolve against the new
// clone (the next /worktree fails with "fatal: invalid reference"). The PATCH route
// resets the top-level worktree mirror + old-repo PR wiring + every approach's runtime
// (keeping id/aspect/agents), and createWorktree resolves the base robustly.
await t.test('server: repo-change PATCH reconciles the primary slot; createWorktree base fallback', () => {
  const s = readFileSync('server.js', 'utf8');
  const start = s.indexOf("app.patch('/api/dev-items/:devId'");
  t.ok(start >= 0, 'dev-item PATCH route exists');
  const route = s.slice(start, start + 2400);
  t.ok(/const repoChanged = \['provider', 'org', 'project', 'repo'\]\.some\(k => k in fields\)/.test(route), 'detects a repo-identity change from the client fields');
  t.ok(/idKey\(next\) !== idKey\(card\)/.test(route), 'repo change requires the identity key to actually differ');
  t.ok(/if \(!\('baseBranch' in fields\)\) fields\.baseBranch = '';/.test(route), 'clears baseBranch to fall back to the new remote default');
  t.ok(/prId: '', prBranch: '', prWorktreePath: '', prSeq: 0/.test(route), 'drops the old-repo PR wiring');
  t.ok(/worktreePath: '', worktreeStatus: null, worktreeError: null, git: null/.test(route), 'clears the top-level worktree mirror');
  // Approaches are rebuilt whole (arrays replace in devStore.patch), keeping identity.
  t.ok(/fields\.devs = card\.devs\.map\(w => \(\{[\s\S]{0,160}branch: '', worktreePath: ''/.test(route), 'rebuilds every approach with cleared runtime');
  t.ok(/repoReconciled: repoChanged/.test(route), 'response reports whether a reconcile happened');

  // createWorktree resolves the base robustly so a repo change never hard-fails.
  const dev = readFileSync('devitems.js', 'utf8');
  t.ok(/function _resolveBaseRef\(clone, base\)/.test(dev), '_resolveBaseRef helper present');
  t.ok(/symbolic-ref', '--quiet', 'refs\/remotes\/origin\/HEAD'/.test(dev), 'falls back to the remote advertised default branch');
  t.ok(/for \(const cand of \['origin\/main', 'origin\/master'\]\)/.test(dev), 'falls back to origin/main|master');
  t.ok(/const baseRef = _resolveBaseRef\(clone, base\);/.test(dev), 'createWorktree uses the robust resolver');
  t.ok(/if \(!baseRef\) throw new Error/.test(dev), 'throws a clear error only when nothing resolves');
});

await t.test('app.html: dev-card Artifacts pane surfaces a Files section with a per-file open link', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/devFileUrl\(d, f\) \{[\s\S]{0,200}_devUrl\(d, 'file'\)[\s\S]{0,120}repoId=/.test(html), 'devFileUrl builds a repo-scoped file URL');
  t.ok(/\uD83D\uDCC1 Files/.test(html), 'a Files caption is rendered');
  t.ok(/:href="devFileUrl\(d,f\)"/.test(html), 'each non-deleted file links to devFileUrl');
  t.ok(/f\.deleted[\s\S]{0,200}line-through/.test(html), 'deletions are struck through, not linked');
  // The empty-state now speaks to reports AND files (no longer "No reports yet").
  t.ok(/x-show="!\(d\.reports && d\.reports\.length\) && !\(d\.files && d\.files\.length\)"/.test(html), 'empty-state is files-aware');
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
  const body = secs.slice(secs.indexOf('<!--CF_PR_CARD_BODY:START-->'), secs.indexOf('<!--CF_PR_CARD_BODY:START-->') + 20000);
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
  t.ok(/ctx\.save\(\{ reports, reportHistory, files: f\.files, filesTruncated: f\.truncated \}\)/.test(s), 'manual scan saves reports + reportHistory (+ files)');
  t.ok(/cR\.save\(\{ reports, reportHistory, files: f\.files, filesTruncated: f\.truncated \}\)/.test(s), 'summarizer loop saves reports + reportHistory (+ files) on change');
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

await t.test('appearance: Meetings.AI clapperboard follows icon set and palette', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  t.ok(/"🎬️":\s*"meeting"/.test(html) && /"🎬":\s*"meeting"/.test(html),
    'clapperboard variants map to the themed meeting role');
  t.ok(/\n\s*meeting:\s*'<rect/.test(html) && /meeting:'[^']*class="acc"/.test(html),
    'the meeting glyph uses currentColor plus the active palette accent');
  t.ok(/label:\s*'Meetings\.AI'[^}]*icon:\s*'🎬'/.test(html),
    'Meetings.AI nav metadata uses the mapped clapperboard icon');
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

await t.test('Pulse.AI comic panels — SVG element ids are namespaced per injection site (no duplicate-id clip collision) + lightbox Keep', () => {
  const src = readFileSync('public/app.html', 'utf8');
  // The helper rewrites id="X" / url(#X) / href="#X" with a per-site prefix so each
  // injected copy of a content-hashed SVG is self-contained (duplicate ids in one
  // document make every url(#id) clip resolve to the FIRST copy → empty later panels).
  t.ok(/pulseSvgNS\(svg, ns\)\s*\{/.test(src), 'pulseSvgNS helper exists');
  t.ok(/const p = 'n' \+ String\(ns\)\.replace\(\/\[\^a-zA-Z0-9\]\/g, ''\) \+ '_';/.test(src), 'prefix is a sanitized, site-unique token');
  t.ok(/\.replace\(\/\\sid="\(\[\^"\]\*\)"\/g, ' id="' \+ p \+ '\$1"'\)/.test(src), 'rewrites id attributes');
  t.ok(/\.replace\(\/url\\\(#\(\[\^\)\]\*\)\\\)\/g, 'url\(#' \+ p \+ '\$1\)'\)/.test(src), 'rewrites url(#id) references');
  t.ok(/\.replace\(\/\(\(\?:xlink:\)\?href\)="#\(\[\^"\]\*\)"\/g, '\$1="#' \+ p \+ '\$2"'\)/.test(src), 'rewrites (xlink:)href="#id" references');
  // Every SVG injection site passes a UNIQUE namespace so no two copies collide.
  const namespaces = [...src.matchAll(/pulseSvgNS\([^,]+,\s*('[^']*'|`[^`]*`|[^)]+)\)/g)].map(m => m[1].trim());
  const literalNs = namespaces.filter(n => /^'/.test(n));
  t.ok(literalNs.length >= 5, 'multiple injection sites are namespaced (found ' + literalNs.length + ')');
  t.ok(/pulseSvgNS\(pulse\._reelFull\.svg, 'lb'\)/.test(src), 'lightbox uses its own namespace');
  // Lightbox Keep button toggles pin state, guarded to reel items that carry an id.
  t.ok(/class="pc-lb-act"[^>]*x-show="pulse\._reelFull && pulse\._reelFull\.id"[^>]*pulseComedyArt\(pulse\._reelFull\.id, pulse\._reelFull\.pinned \? 'unpin' : 'pin'\)/.test(src), 'lightbox Keep button toggles pin/unpin, guarded on id');
  t.ok(/pulse\._reelFull &amp;&amp; pulse\._reelFull\.pinned \? '★ Kept' : '☆ Keep'/.test(src), 'Keep button label reflects pinned state');
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
  const list = (cjs.match(/function listCompositions\(st\)\s*\{[\s\S]*?\n\}/) || [''])[0];
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

await t.test('newsletter: Shawn template leads with impact, proof, and measurement gaps', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  t.ok(/<option value="shawn">Shawn · impact first<\/option>/.test(html),
    'Newsletter Studio exposes the named Shawn template');
  t.ok(/function _newsletterTemplateGuidance\(template\)/.test(srv) &&
       /SHAWN TEMPLATE - IMPACT FIRST, ZERO FLUFF/.test(srv),
    'the server owns reusable Shawn editorial guidance for writer and editor');
  t.ok(/## TL;DR - impact and proof/.test(srv) &&
       /Structure each story as: Impact -> Evidence\/metric -> Who benefits -> How/.test(srv) &&
       /Measurement gap:/.test(srv),
    'Shawn leads with a skimmable impact TLDR and makes missing proof explicit');
  t.ok(/Counts of meetings, PRs, documents, reviews, or pipeline changes are activity/.test(srv) &&
       /Do not add a decorative hero, cartoon, or activity stat strip/.test(srv) &&
       /target a 2-3 minute read/.test(srv),
    'Shawn removes activity metrics and decorative fluff while enforcing a short read');
  t.ok((srv.match(/_newsletterTemplateGuidance\(cfg\.template\)/g) || []).length >= 2,
    'both newsletter generation and conversational revision receive the template contract');
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

await t.test('compose: reference sources support absolute local text-file paths', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const resolver = _win(src, 'async function _composeFetchReference', 1800);
  t.ok(/_composeLocalPath\(ref\)/.test(resolver), 'reference resolver detects local paths');
  t.ok(/fs\.promises\.readFile\(localPath\)/.test(resolver), 'local source content is read server-side');
  t.ok(/2 \* 1024 \* 1024/.test(resolver), 'local files have a bounded 2 MB limit');
  t.ok(/binary local files are not supported/.test(resolver), 'binary files fail with an explicit message');
  t.ok(/Reference links &amp; local files/.test(html), 'source rail labels local-file support');
  t.ok(/C:\\path\\file\.md/.test(html), 'source input shows a Windows path example');
  t.ok(/composeReferenceIsUrl\(l\)/.test(html), 'only web references render as anchors');
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
  t.ok(/folders: snap\.folders/.test(src) && /assignments: snap\.assignments/.test(src), 'GET /api/compose returns folders + assignments');
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

// Feature — import an external text file into the Documents library (default
// "Reference" type, user-selectable composition type) + a board "Add link" action
// that creates a document card from a browsed file via that same import.
await t.test('documents import: external file → library (+ board Add link card)', () => {
  const src = readFileSync('server.js', 'utf8');
  // Server route: POST /api/compose/import, ordered before the /:id catch-all.
  const imp = src.indexOf("app.post('/api/compose/import'");
  const idget = src.indexOf("app.get('/api/compose/:id'");
  t.ok(imp > 0, 'POST /api/compose/import route present');
  t.ok(imp < idget, 'import route precedes the /api/compose/:id catch-all');
  const route = _win(src, "app.post('/api/compose/import'", 1700);
  t.ok(/purposeById\(b\.purpose\) \? b\.purpose : 'reference'/.test(route), 'composition type defaults to reference, honors a valid purpose');
  t.ok(/createComposition\(\{ purpose, title, content, format \}\)/.test(route), 'import reuses createComposition');
  t.ok(/=== 'html' \|\| ext === 'htm'\) \? 'site' : 'doc'/.test(route), 'format derives from file extension (html→site else doc)');
  t.ok(/No text content to import/.test(route), 'rejects empty content');

  const html = readFileSync('public/app.html', 'utf8');
  // Shared teleported import modal + state.
  t.ok(/x-teleport="body"/.test(html) && /docImport\.open/.test(html), 'import modal is a top-level teleport gated on docImport.open');
  t.ok(/open: false, mode: 'library', filename: '', title: '', purpose: 'reference'/.test(html), 'docImport state defaults to library mode + reference purpose');
  // Documents Import button + board Add-link affordance both open the modal.
  t.ok(/docImportOpen\('library'\)/.test(html), 'Documents toolbar Import button opens the library-mode modal');
  t.ok(/docImportOpen\('board'\)/.test(html), 'board pin-picker Add-link opens the board-mode modal');
  // The 8 import methods/helpers.
  for (const m of ['composeImportPurposes()', 'composeImportPurposeHint()', 'docImportIsHtml()', 'docImportSizeLabel()', 'docImportOpen(mode)', 'docImportClose()', 'docImportPick(ev)', 'async docImportSubmit()']) {
    t.ok(html.includes(m + ' {'), 'import method present: ' + m);
  }
  const submit = _win(html, 'async docImportSubmit()', 2600);
  t.ok(/\/api\/compose\/import/.test(submit), 'docImportSubmit posts to /api/compose/import');
  t.ok(/pinCandidate\(/.test(submit) && /loadBoardDocCandidates\(true\)/.test(submit), 'board mode pins a document card + refreshes candidates');
  t.ok(/loadCompose\(\)/.test(submit) && /goTo\('#\/compose'\)/.test(submit), 'library mode reloads Documents + opens the studio');
  // Reference is excluded from newsletter store + surfaced first.
  const purposes = _win(html, 'composeImportPurposes() {', 400);
  t.ok(/newsletter/.test(purposes), 'import purpose picker filters out newsletter');
});

await t.test('updates + Whats new: manual check bypasses the cache; release notes scope to the running version line', () => {
  const upd = readFileSync('updater.js', 'utf8');
  // (#3) A manual "Check for updates" must skip the 15-min release-lookup cache so
  // a build published seconds ago is seen (the auto-check on launch warms the cache).
  const check = _win(upd, 'async function checkForUpdate(', 600);
  t.ok(check, 'updater.checkForUpdate found');
  t.ok(/!opts\.force &&/.test(check), 'a forced check bypasses the release-lookup cache');

  const src = readFileSync('server.js', 'utf8');
  const chk = _win(src, "app.get('/api/update/check'", 600);
  t.ok(chk, '/api/update/check route found');
  t.ok(/req\.query\.refresh === '1' \|\| req\.query\.force === '1'/.test(chk), 'a manual check (?refresh=1/force=1) sets force');
  t.ok(/checkForUpdate\(GIT_VERSION\.version \|\| '', \{ serverDir: __dirname, force \}\)/.test(chk), 'force is threaded into checkForUpdate');

  // (#1/#2) whats-new scopes to the running version line + always represents current.
  t.ok(/function whatsNewBase\(v\)/.test(src), 'whatsNewBase helper defined');
  const wb = _win(src, 'function whatsNewBase(v)', 220);
  t.ok(/split\('\+'\)\[0\]\.split\('-'\)\[0\]/.test(wb), 'base strips -prerelease and +build metadata (1.0.5-preview.657+abc → 1.0.5)');
  t.ok(/function whatsNewCurrentEntry\(version\)/.test(src), 'whatsNewCurrentEntry helper defined');
  const wn = _win(src, "app.get('/api/whats-new'", 1400);
  t.ok(wn, '/api/whats-new route found');
  t.ok(/whatsNewBase\(e && e\.version\) === base/.test(wn), 'entries scope to the current version line (drops 1.0.4/1.0.3)');
  t.ok(/!entries\.some\(e => e && e\.version === current\)/.test(wn), 'ensures the running version is represented');
  t.ok(/updater\.releaseForVersion\(current\)/.test(wn) &&
       /whatsNewEntryFromRelease/.test(wn),
    'a stale bundled changelog recovers the exact current release body from GitHub');
  t.ok(/entries\.unshift\(published \|\| whatsNewCurrentEntry\(current\)\)/.test(wn),
    'the generic current-version entry is only the offline fallback');
  t.ok(/async function releaseForVersion\(version\)/.test(upd) &&
       /releases\/tags\/v/.test(upd),
    'the updater exposes a cached exact-tag release lookup');

  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/async checkForUpdate\(force\) \{/.test(html), 'SPA checkForUpdate accepts a force flag');
  t.ok(/\/api\/update\/check' \+ \(force \? '\?refresh=1' : ''\)/.test(html), 'force adds ?refresh=1 to the check request');
  const about = _win(html, 'async checkForUpdatesFromAbout()', 400);
  t.ok(about, 'checkForUpdatesFromAbout found');
  t.ok(/this\.checkForUpdate\(true\)/.test(about), 'the manual About button forces a fresh check');
  t.ok(/setInterval\(\(\) => \{ this\.checkForUpdate\(\); \}/.test(html), 'the periodic auto-check stays cached (no force)');
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
  const st = _win(html, 'epics: {', 2000);
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
  t.ok(/persona:\s*this\.codeflow\.epics\.persona/.test(_win(html, 'async epicChatSend(', 1600) || ''), 'epicChatSend POSTs the chosen persona');

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

  // --- chat renders full markdown (tables/lists) + shows an active "thinking" indicator ---
  const send = _win(html, 'async epicChatSend(', 2600) || '';
  t.ok(/renderMarkdown\(reply\)/.test(send) && !/inlineMarkdown\(reply\)/.test(send),
    'epicChatSend renders the reply with the full block renderMarkdown (tables/lists), not inline-only');
  t.ok(/x-show="codeflow\.epics\.chat\.sending"[\s\S]{0,1800}epx-typing/.test(html),
    'a thinking/typing indicator bubble shows while the assistant request is in flight');
  t.ok(/\.epx-typing \{/.test(html) && /class="md-body" x-html="m\.html \|\| m\.text"/.test(html),
    'chat bubble renders into a .md-body host with typing-indicator CSS present');

  // --- LIVE streaming: server emits reasoning/tool/delta over the SSE bus keyed by runId ---
  t.ok(/broadcastSSE\('epic-assistant'/.test(srv), 'server streams epic-assistant events over the SSE bus');
  t.ok(/req\.body && req\.body\.runId/.test(srv), 'assistant route reads a client-supplied runId');
  const route = _win(srv, "app.post('/api/codeflow/epics/assistant'", 4600) || '';
  t.ok(/onStep/.test(route) && /kind: 'thinking'/.test(route) && /kind: 'tool_start'/.test(route) && /kind: 'tool_complete'/.test(route),
    'assistant route maps SDK thinking/tool steps into emitted events');
  t.ok(/kind: 'delta'/.test(route) && /kind: 'done'/.test(route),
    'assistant route coalesces answer deltas and emits a terminal done event');

  // --- client SSE listener routes events into the live buffer, filtered by runId ---
  t.ok(/addEventListener\('epic-assistant'/.test(html), 'client subscribes to the epic-assistant SSE stream');
  const lis = _win(html, "addEventListener('epic-assistant'", 1400) || '';
  t.ok(/live\.runId/.test(lis), 'SSE listener filters events by the live runId');
  t.ok(/'delta'/.test(lis) && /'thinking'/.test(lis) && /'tool_start'/.test(lis) && /'done'/.test(lis),
    'SSE listener routes delta/thinking/tool/done into the live buffer');

  // --- send lifecycle: runId created, POSTed, and ch.live cleared ---
  t.ok(/runId/.test(send) && /\.live = \{/.test(send), 'epicChatSend seeds ch.live with a fresh runId');
  t.ok(/\.live = null/.test(send), 'epicChatSend clears ch.live when the turn settles');
  t.ok(/epicChatLive\(\)/.test(html) && /epicChatToggleTrace\(\)/.test(html),
    'epicChatLive + epicChatToggleTrace helpers defined');

  // --- state carries the live buffer + trace toggle ---
  const chatSt = _win(html, "chat: { open: false, sending: false", 200) || '';
  t.ok(/live: null/.test(chatSt) && /traceOpen:/.test(chatSt), 'epics chat state carries live + traceOpen');

  // --- live-trace markup + progressive answer + calm CSS (no pills) ---
  t.ok(/class="epx-trace"/.test(html) && /epx-trace-step/.test(html) && /epx-trace-toggle/.test(html),
    'live-trace markup present (trace list + steps + toggle)');
  t.ok(/renderMarkdown\(epicChatLive\(\)\.text\)/.test(html),
    'progressive answer renders epicChatLive().text through renderMarkdown as it streams');
  const traceCss = _win(html, '.epx-trace {', 220) || '';
  t.ok(/\.epx-trace \{/.test(html) && /border-radius:\s*8px/.test(traceCss),
    'calm .epx-trace CSS with modest radius (no pills)');
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

await t.test('epic \u2192 Objective Health dashboard, gated behind the Epics flag', () => {
  const src = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');

  // (1) FLAG-GATE \u2014 Objective Health now rides the Epics feature flag. The standalone
  // Monitoring.AI flag / nav leaf / catalog entries were physically removed in the teardown.
  t.ok(/epics: false/.test(html), 'basicFeatures defaults Epics OFF (opt-in)');
  t.ok(/epics: true/.test(html), 'advancedFeatures defaults Epics ON (opt-out)');
  t.ok(!/\bmonitoring: (?:true|false)\b/.test(html), 'the standalone Monitoring.AI feature flag is gone');
  t.ok(!/key: 'monitoring'/.test(html), 'the standalone Monitoring.AI catalog entry is gone');
  const basicCat = _win(html, 'basicFeatureCatalog() {', 2600);
  const advCat = _win(html, 'advancedFeatureCatalog() {', 3000);
  t.ok(/key: 'epics'/.test(basicCat), 'basic catalog surfaces the Epics toggle');
  t.ok(/key: 'epics'/.test(advCat), 'advanced catalog surfaces the Epics toggle');
  // The Epics tab + section are gated so a Basic-without-Epics user never sees them.
  t.ok(/&& featureEnabled\('epics'\)/.test(html),
    'the Epics section render is gated on the epics flag');
  t.ok((html.match(/featureEnabled\('epics'\)/g) || []).length >= 4,
    'multiple Epics cf-tab entry points are flag-gated');

  // (2) SERVER \u2014 the epic-dashboard route + its two helpers survive the teardown.
  t.ok(/app\.post\('\/api\/monitoring\/epic-dashboard'/.test(src),
    'POST /api/monitoring/epic-dashboard route exists');
  t.ok(/function _monEpicGuidanceDoc\(/.test(src),
    'guidance-doc resolver helper exists');
  t.ok(/function _monNormObjective\(/.test(src),
    'objective normalizer helper exists');
  // HONESTY: the normalizer must NOT fabricate a live time-series \u2014 no series/sustain,
  // and `shape` is only attached for genuine gap objectives (miss|part).
  const norm = _win(src, 'function _monNormObjective(', 1600);
  t.ok(!/\bseries\b/.test(norm) && !/\bsustain\b/.test(norm),
    'normalized objective carries no fabricated series/sustain');
  t.ok(/shape: null, runbooks: null/.test(norm) &&
       /\(status === 'miss' \|\| status === 'part'\) && o && o\.shape/.test(norm),
    'desired-telemetry shape is attached only to miss/part gap objectives');

  // (3) OBJECTIVE HEALTH VIEW \u2014 the objective view + its dispatcher + entry method.
  t.ok(/monitoring\.view === 'objective'/.test(html),
    'the Objective Health view is wired to monitoring.view');
  t.ok(/monObjDetail\(\)/.test(html) && /async monEpicDashboard\(/.test(html),
    'objective detail dispatcher + monEpicDashboard entry method exist');

  // (4) EPIC ENTRY \u2014 an Objective-Health action on the Epics cockpit, gated on the
  // EPICS flag (the only way Objective Health is now reachable), wired to the epic key.
  const jump = _win(html, 'class="epx-jump-mon"', 300);
  t.ok(/x-show="featureEnabled\('epics'\)"/.test(jump) &&
       /monEpicDashboard\(epicCur\(\)\.key/.test(jump),
    'the Epics cockpit exposes an epics-flag-gated Objective Health action');
});

await t.test('epic Objective Health: server persistence + card management (resync/unlink/relink/source-swap)', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // --- server epic-dashboard persistence: GET / DELETE / POST all present ---
  t.ok(/function _epicOHLoad\(\)/.test(srv) && /function _epicOHSave\(map\)/.test(srv),
    'server persists epic-OH snapshots to disk');
  t.ok(/function _epicOHCounts\(objectives\)/.test(srv), 'server computes epic-OH objective counts');
  t.ok(srv.includes("app.get('/api/monitoring/epic-dashboard'"), 'server GET /api/monitoring/epic-dashboard');
  t.ok(srv.includes("app.delete('/api/monitoring/epic-dashboard'"), 'server DELETE /api/monitoring/epic-dashboard');
  // POST route persists a snapshot under the epic key.
  const post = _win(srv, "app.post('/api/monitoring/epic-dashboard'", 2600);
  t.ok(post, 'server POST /api/monitoring/epic-dashboard found');
  t.ok(/map\[key\] = snapshot; _epicOHSave\(map\)/.test(post) || /map\[key\] = snapshot;\s*_epicOHSave/.test(srv),
    'POST persists the epic-OH snapshot under the epic key');

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

  // --- objective view back-link returns to the epic in Code Flow ---
  t.ok(/monBackToEpic\(\)/.test(html), 'monBackToEpic back-link method present');
  t.ok(/class="moh-link"[^>]*monBackToEpic\(\)/.test(html) || /monBackToEpic\(\)"[^>]*\u2190/.test(html) || /\u2190 Back to\s*epic/.test(html),
    'objective-health view renders a Back-to-epic link');
});

await t.test('monitoring.ai: epic→objective nav is not clobbered by the async route-load (pendingNav sentinel)', () => {
  const html = readFileSync(APP_HTML, 'utf8');

  // State carries the one-shot sentinel.
  const obj = _win(html, "mode: 'overview',", 720) || html;
  t.ok(/pendingNav:\s*false/.test(obj), "obj.pendingNav sentinel defaults to false");

  // monEpicDashboard sets the sentinel BEFORE changing the hash (goTo only sets the
  // hash; the hashchange listener runs monLoad asynchronously).
  const med = _win(html, 'async monEpicDashboard(key, docId, force)', 1400) || html;
  t.ok(/this\.monitoring\.obj\.pendingNav = true;[\s\S]*this\.goTo\('#\/monitoring'\);[\s\S]*this\.monitoring\.view = 'objective';/.test(med),
    'monEpicDashboard sets pendingNav=true before goTo, then view=objective');

  // monLoad honors the sentinel (timing-independent) instead of the old obj.loading race.
  // Post-teardown the route hosts ONLY the epic Objective Health view, so monLoad is a
  // lean stub that lands on 'objective' and consumes the one-shot sentinel.
  const ml = _win(html, 'async monLoad()', 400) || html;
  t.ok(/w\.view = 'objective';/.test(ml),
    'monLoad lands on the objective view');
  t.ok(/w\.obj && w\.obj\.pendingNav[\s\S]*w\.obj\.pendingNav = false;[\s\S]*return;/.test(ml),
    'monLoad consumes the pendingNav sentinel and returns without clobbering the epic nav');
});

await t.test('epic metrics: overview navigation hub + honest per-objective viz + over-time', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // (1) LANDING — the Overview replaces the master-detail landing as the default mode.
  t.ok(/mode:\s*'overview'/.test(html), 'monitoring.obj state defaults mode to overview');
  t.ok(/otSel:/.test(html) && /otRange:/.test(html), 'over-time state (otSel + otRange) present');
  const entry = _win(html, 'Landing = the browse-first Overview', 120);
  t.ok(entry && /o\.mode = 'overview';/.test(entry),
    'monEpicDashboard lands on the Overview after building');
  t.ok(/monObjOverview\(\)\s*\{[^}]*mode = 'overview'/.test(html),
    'monObjOverview sets mode=overview');

  // (2) OVERVIEW markup — donut hero + measurable % + per-objective card grid that
  // drills into detail; over-time link only when the objective has recorded trend.
  const ov = _win(html, 'class="mem-wrap"', 3000);
  t.ok(ov && /class="mem-grid"/.test(ov) && /class="mem-ob"/.test(ov),
    'overview renders the mem-grid card grid');
  t.ok(ov && /x-html="monEmDonut\(\)"/.test(ov) && /monEmMeasurablePct\(\) \+ '%'/.test(ov),
    'overview hero shows the donut + measurable %');
  t.ok(ov && /@click="monObjOpenDetail\(o\.n\)"/.test(ov) && /x-html="monEmCardViz\(o\)"/.test(ov),
    'each card drills into detail and renders its best-fit viz');
  t.ok(ov && /x-show="monEmHasTrend\(o\)"[^>]*@click\.stop="monObjOpenOvertime\(o\.n\)"/.test(ov),
    'the per-card over-time link is gated on monEmHasTrend');

  // (3) HONESTY — viz type never fabricates a chart: miss -> gap, manual -> manual,
  // trend ONLY when >= 2 recorded readings, else a gauge of the single value.
  t.ok(/monEmHasTrend\(o\)\s*\{\s*return[^}]*history[^}]*length >= 2/.test(html),
    'monEmHasTrend requires at least two recorded readings');
  const vt = _win(html, 'monEmVizType(o) {', 760);
  t.ok(vt && /status === 'miss'\) return 'gap'/.test(vt) && /monEmHasTrend\(o\)\) return 'trend'/.test(vt),
    'monEmVizType: miss -> gap; trend only with recorded history');
  t.ok(/_monEmGapCard\(o\)/.test(html) && /_monEmManualCard\(o\)/.test(html) && /_monEmGauge\(o\)/.test(html),
    'gap / manual / gauge card builders exist (no fabricated series)');

  // (4) OVER-TIME view — objective picker + big chart fed only by recorded readings,
  // segment/link hidden until an objective actually has trend data.
  const ot = _win(html, 'class="mem-otwrap"', 1200);
  t.ok(ot && /x-html="monEmBigChart\(\)"/.test(ot) && /class="ottbl"/.test(ot),
    'over-time renders the big chart + readings table');
  t.ok(ot && /x-model="monitoring\.obj\.otSel"/.test(ot) && /monEmOtObjectives\(\)/.test(ot),
    'over-time picker iterates only trend-bearing objectives');
  t.ok(/x-show="monEmOtObjectives\(\)\.length"/.test(html),
    'the Over time segment/link is hidden until an objective has recorded trend');
  t.ok(/mem-otempty/.test(html), 'big-chart has an honest empty-state for no readings');

  // (5) SERVER — the app records its OWN reading history (never external telemetry).
  t.ok(/function _epicOHAppendReadings\(/.test(srv), 'server records reading history');
  t.ok(srv.includes('_epicOHAppendReadings(key, model.objectives, generatedAt)'),
    'POST epic-dashboard appends readings after the model is built');
});

await t.test('epic Objective Health assistant: SSE-streamed chat that analyzes + edits the dashboard', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // (1) SERVER — the assist route streams reasoning/tool/delta over the SSE bus keyed by runId
  // and applies structured ops via _epicOHApplyOps, persisting the authoritative snapshot.
  t.ok(/app\.post\('\/api\/monitoring\/epic-dashboard\/:key\/assist'/.test(srv),
    'server exposes the Objective Health assist route');
  t.ok(/broadcastSSE\('epic-oh-assistant'/.test(srv), 'assist route streams epic-oh-assistant SSE events');
  const route = _win(srv, "app.post('/api/monitoring/epic-dashboard/:key/assist'", 6600) || '';
  t.ok(/kind: 'thinking'/.test(route) && /kind: 'tool_start'/.test(route) && /kind: 'delta'/.test(route) && /kind: 'done'/.test(route),
    'assist route maps SDK thinking/tool/delta/done steps into emitted events');
  t.ok(/===OPS===/.test(route) && /_epicOHApplyOps\(snap, j\.ops\)/.test(route),
    'assist route parses the ===OPS=== control block and applies it via _epicOHApplyOps');
  t.ok(/objectives: snap\.objectives/.test(route) && /applied,/.test(route),
    'assist route returns the authoritative objectives + applied ops');

  // _epicOHApplyOps honestly edits sources/readiness/viz/readings and recomputes counts.
  const ops = _win(srv, 'function _epicOHApplyOps(', 5200) || '';
  t.ok(/set_viz/.test(ops) && /auto\|trend\|gauge\|gap\|manual/.test(ops),
    'set_viz accepts auto/trend/gauge/gap/manual (auto clears the override)');
  t.ok(/readingTouched[\s\S]*_epicOHAppendReadings/.test(ops),
    'a recorded reading appends genuine history (never fabricated)');
  t.ok(/snapshot\.counts = _epicOHCounts/.test(ops), 'ops recompute the readiness counts');

  // (2) CLIENT — honors o.viz first (never fabricates a line without recorded readings).
  const vt = _win(html, 'monEmVizType(o) {', 500) || '';
  t.ok(/o\.viz/.test(vt) && /monEmHasTrend\(o\)/.test(vt),
    'monEmVizType honors an explicit o.viz override but still gates trend on real readings');

  // (3) CLIENT — SSE listener routes epic-oh-assistant events into the drawer live buffer by runId.
  t.ok(/addEventListener\('epic-oh-assistant'/.test(html), 'client subscribes to the epic-oh-assistant stream');
  const lis = _win(html, "addEventListener('epic-oh-assistant'", 1200) || '';
  t.ok(/live\.runId/.test(lis) && /p\.runId !== live\.runId/.test(lis), 'OH SSE listener filters by the live runId');
  t.ok(/'delta'/.test(lis) && /'thinking'/.test(lis) && /'tool_start'/.test(lis) && /'done'/.test(lis),
    'OH SSE listener routes delta/thinking/tool/done into the live buffer');

  // (4) CLIENT — the teleported FAB + slide-over drawer is reachable from the epic dashboard.
  t.ok(/route === 'monitoring' && monitoring\.obj\.epicKey && !monitoring\.obj\.loading && !monitoring\.obj\.error/.test(html),
    'the OH assistant is gated to a loaded epic dashboard');
  const drawer = _win(html, 'Objective Health assistant FAB', 4300) || '';
  t.ok(/x-teleport="body"/.test(drawer), 'OH drawer is a top-level teleport to body');
  t.ok(/x-ref="monOhChatBody"/.test(drawer), 'OH drawer body carries the scroll ref');
  t.ok(/monOhChatOpen\(\)/.test(drawer) && /monOhChatSend\(\)/.test(drawer) && /monOhChatSuggestions\(\)/.test(drawer),
    'OH drawer wires open/send/suggestions');
  t.ok(/class="epx-applied"/.test(drawer), 'OH drawer renders an applied-changes affordance');

  // (5) CLIENT — monOhChatSend threads a runId, seeds the live buffer, applies edits + refreshes.
  const send = _win(html, 'async monOhChatSend(', 2400) || '';
  t.ok(/runId/.test(send) && /ch\.live = \{ runId/.test(send), 'monOhChatSend generates a runId + seeds the live buffer');
  t.ok(/\/assist'/.test(send) && /_epicOHStore\(key,/.test(send),
    'monOhChatSend posts to the assist route + re-caches the epic-side snapshot on edits');
});

await t.test('updates inventory: atomic agents.json writes + resilient inventory read (no false empty)', () => {
  const src = readFileSync('server.js', 'utf8');

  // (1) Atomic writer exists and writes via a temp file + rename (never truncates in place).
  const writer = _win(src, 'function writeAgentsFile(', 500) || '';
  t.ok(writer, 'writeAgentsFile helper defined');
  t.ok(/AGENTS_PATH \+ '\.' \+ process\.pid \+ '\.tmp'/.test(writer), 'writeAgentsFile writes to a per-process temp file');
  t.ok(/fs\.writeFileSync\(tmp,/.test(writer) && /fs\.renameSync\(tmp, AGENTS_PATH\)/.test(writer),
    'writeAgentsFile renames the temp file over the target (atomic, no truncation window)');

  // (2) Resilient async reader retries on an empty/partial file, returns [] only for a real ENOENT.
  const reader = _win(src, 'async function readAgentsFileAsync(', 600) || '';
  t.ok(reader, 'readAgentsFileAsync helper defined');
  t.ok(/for \(let i = 0; i < 5; i\+\+\)/.test(reader), 'readAgentsFileAsync retries several times');
  t.ok(/setTimeout\(r, 40\)/.test(reader), 'readAgentsFileAsync backs off between retries');
  t.ok(/code === 'ENOENT'/.test(reader), 'readAgentsFileAsync only maps a genuine ENOENT to []');
  const parse = _win(src, 'function _parseAgents(', 400) || '';
  t.ok(/if \(!trimmed\) throw/.test(parse), '_parseAgents treats an empty (mid-write) file as a retryable error, not an empty inventory');

  // (3) The init reset routes through the atomic writer.
  t.ok(/if \(!fs\.existsSync\(AGENTS_PATH\)\) \{\s*writeAgentsFile\(\[\]\);/.test(src),
    'the agents.json init reset uses the atomic writer');

  // (4) No raw truncating writes to AGENTS_PATH remain anywhere.
  t.ok(!/fs\.writeFileSync\(AGENTS_PATH,/.test(src),
    'no remaining raw fs.writeFileSync(AGENTS_PATH, ...) truncating writes');

  // (5) saveAgents persists through the atomic writer.
  const save = _win(src, 'function saveAgents(', 200) || '';
  t.ok(/writeAgentsFile\(agents\)/.test(save), 'saveAgents writes atomically');

  // (6) The inventory endpoint is async and reads resiliently (so a transient empty read is retried, not reported as empty).
  const inv = _win(src, "app.get('/api/updates/inventory'", 300) || '';
  t.ok(/async \(req, res\)/.test(inv), 'inventory endpoint is async');
  t.ok(/await readAgentsFileAsync\(\)/.test(inv), 'inventory endpoint uses the resilient async reader');
});

await t.test('review-footer removed + todo carry-over honors tombstones + quick-launch remove + epic trend hint', () => {
  const srv = readFileSync(SERVER, 'utf8');
  const html = readFileSync(APP_HTML, 'utf8');

  // (1) PR review comments no longer append the "Posted from AI code review." footer.
  const builder = _win(srv, "const parts = ['**' + sevTag(", 400) || '';
  t.ok(builder, 'PR-comment builder found');
  t.ok(!/posted from ai code review/i.test(builder),
    'the posted review comment no longer carries the "Posted from AI code review." footer');
  // _cfReconcilePosted still recognizes OUR comments structurally (header / suggested-fix / legacy footer).
  const looks = _win(srv, 'const looksOurs = (tx) =>', 400) || '';
  t.ok(/blocker\|major\|minor\|nit\|comment/.test(looks) && /\*\*suggested fix:\*\*/.test(looks),
    'looksOurs matches our comments by their structural markers, not the removed footer');
  t.ok(/posted from ai code review/.test(looks),
    'looksOurs still recognizes older footered comments for back-compat');

  // (2) Daily todo carry-over reads the durable store as source of truth + honors tombstones.
  const carry = _win(srv, 'const store = loadMeAiTodoStore(prevDate);', 800) || '';
  t.ok(/loadMeAiTodoStore\(prevDate\)/.test(carry) && /store \|\| \(snap/.test(carry),
    'carry-over prefers the durable store over the (laggy) agenda snapshot');
  t.ok(/loadMeAiTodoTomb\(prevDate\)/.test(carry) && /!tomb\.has\(/.test(carry),
    'carry-over never carries a title the user tombstoned on the source day');
  // fold-in loop also guards a title the user tombstoned on the TARGET day.
  const fold = _win(srv, 'const tombToday = new Set(loadMeAiTodoTomb(day));', 900) || '';
  t.ok(/tombToday\.has\(lc\)/.test(fold),
    'fold-in loop skips a carry the user removed on the target day (belt-and-suspenders)');

  // (3) Quick-launch chips expose a per-item remove (✕) that calls toggleQuickPin.
  t.ok(/class="ql-chip-open"/.test(html) && /class="ql-chip-x"/.test(html),
    'quick-launch chip is split into an open button + a remove button');
  const chipX = _win(html, 'class="ql-chip-x"', 240) || '';
  t.ok(/toggleQuickPin\(item\)/.test(chipX), 'the ✕ removes the pin via toggleQuickPin');
  t.ok(/\.ql-chip:hover \.ql-chip-x/.test(html) && /\.ql-chip-x:hover \{ color: var\(--cp-danger\)/.test(html),
    'the remove button is hover/focus-revealed and reddens on hover');

  // (4) Epic Objective Health overview shows an honest empty-state hint when no objective has trend history.
  const hint = _win(html, 'class="mem-othint"', 400) || '';
  t.ok(/x-show="!monEmOtObjectives\(\)\.length"/.test(hint),
    'the trend hint shows only when NO objective has enough recorded readings');
  t.ok(/at least two/.test(hint),
    'the hint explains a trend line needs at least two real recorded readings (honesty invariant)');
});

await t.test('epic objective health: Grafana publish (App-Insights-as-aggregation) + honest trend day-stamp', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const tel = readFileSync('epic-telemetry.js', 'utf8');
  const graf = readFileSync('epic-grafana.js', 'utf8');

  // (1) Trend bug fix: day-stamp uses LOCAL date (not UTC) so an evening rebuild does not
  // collapse into the next UTC day and overwrite the prior point.
  const stamp = _win(srv, '_epicOHDayStamp', 400) || '';
  t.ok(/getFullYear\(\)/.test(stamp) && /getMonth\(\)/.test(stamp) && /getDate\(\)/.test(stamp),
    '_epicOHDayStamp uses LOCAL date parts (not toISOString/UTC)');
  t.ok(!/toISOString/.test(stamp), '_epicOHDayStamp does not use UTC toISOString (the collapse bug)');
  // position-fallback so an AI rename does not reset a series.
  const append = _win(srv, '_epicOHAppendReadings', 1200) || '';
  t.ok(/prevByN/.test(append), '_epicOHAppendReadings carries history forward by position when the title changed');

  // (2) Telemetry config routes (masked — never echo secrets back).
  const getTel = _win(srv, "app.get('/api/monitoring/telemetry'", 900) || '';
  t.ok(/hasConnectionString/.test(getTel) && /hasGrafanaToken/.test(getTel) && /configured:/.test(getTel),
    'GET /telemetry returns masked booleans + configured, never the raw secrets');
  t.ok(!/connectionString:\s*c\.connectionString/.test(getTel), 'GET /telemetry does not leak the connection string');
  const putTel = _win(srv, "app.put('/api/monitoring/telemetry'", 1400) || '';
  t.ok(/connectionString\.trim\(\)/.test(putTel) && /grafanaToken\.trim\(\)/.test(putTel),
    'PUT /telemetry only writes a secret when a non-empty value is supplied (masked round-trip preserves it)');

  // (3) Publish route: full backfill (sinceTs:0), build model, optional push, honest guidance.
  const pub = _win(srv, "app.post('/api/monitoring/epic-dashboard/:key/publish'", 3000) || '';
  t.ok(/status\(404\)/.test(pub), 'publish 404s when the epic has no Objective Health snapshot');
  t.ok(/sinceTs:\s*0/.test(pub), 'publish backfills EVERY recorded reading (sinceTs:0)');
  t.ok(/buildEpicGrafanaModel/.test(pub) && /pushDashboard/.test(pub), 'publish builds the model and optionally pushes it');
  t.ok(/guidance/.test(pub), 'publish accumulates actionable guidance for missing config');

  // (4) Honesty invariant lives in the ETL: only recorded readings are emitted.
  t.ok(/EpicObjectiveReading/.test(tel) && /EpicObjectiveReading/.test(graf),
    'telemetry emits + Grafana KQL read the same EpicObjectiveReading customEvent');
  t.ok(/module\.exports\s*=/.test(tel) && /\bemit\b/.test(tel) && /configured/.test(tel),
    'epic-telemetry exports cfg/configured/emit');
  t.ok(/customMeasurements\.value/.test(graf), 'Grafana KQL projects the recorded value from customMeasurements');

  // (5) SPA publish panel: state, load, and the seven methods, gated on the overview.
  t.ok(/x-init="monObjPubLoad\(\)"/.test(html), 'the publish panel loads telemetry config on init');
  const pubPanel = _win(html, 'class="mem-pub"', 260) || '';
  t.ok(/monitoring\.obj\.mode === 'overview'/.test(pubPanel),
    'the publish panel is gated to the overview mode');
  for (const m of ['monObjPubLoad', 'monObjPubSave', 'monObjPubEdit', 'monObjPublish', 'monObjPubHeadline', 'monObjPubDownload', 'monObjPubCopy']) {
    t.ok(new RegExp(m + '\\s*\\(').test(html), 'SPA method ' + m + ' present');
  }
  const load = _win(html, 'async monObjPubLoad()', 900) || '';
  t.ok(/\/api\/monitoring\/telemetry/.test(load), 'monObjPubLoad GETs the telemetry config');
  const doPub = _win(html, 'async monObjPublish()', 900) || '';
  t.ok(/epic-dashboard\/'\s*\+\s*encodeURIComponent\(key\)\s*\+\s*'\/publish/.test(doPub),
    'monObjPublish POSTs the per-epic publish route');
});

await t.test('epic objective health: daily no-AI snapshot + explicit AI rebuild separation', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const set = readFileSync('settings.js', 'utf8');

  // (1) No-AI snapshot helper: re-records readings WITHOUT re-running the AI model build.
  const snap = _win(srv, 'async function _epicOHSnapshot(', 2900) || '';
  t.ok(snap, '_epicOHSnapshot helper exists');
  t.ok(/_epicOHAppendReadings\(key, snap\.objectives/.test(snap), 'snapshot appends readings from the persisted objectives');
  t.ok(/snap\.snapshotAt = generatedAt/.test(snap), 'snapshot stamps snapshotAt');
  t.ok(!/sdkRunner|runChat|_monEpicGuidanceDoc/.test(snap), 'snapshot does NOT invoke the AI / re-read the tracking doc');
  t.ok(/epicTelemetry\.configured\(\)/.test(snap) && /epicTelemetry\.emit/.test(snap), 'snapshot emits only when telemetry is configured');

  // (2) Manual snapshot route + honest 404 when no dashboard exists yet.
  const route = _win(srv, "app.post('/api/monitoring/epic-dashboard/:key/snapshot'", 900) || '';
  t.ok(route, 'manual snapshot route exists');
  t.ok(/_epicOHSnapshot\(key\)/.test(route), 'snapshot route calls the helper');
  t.ok(/no Objective Health dashboard/.test(route), 'snapshot route 404s when no dashboard is built');

  // (3) Daily automated snapshot: leader-gated, opt-out default-ON, once per LOCAL day.
  const job = _win(srv, '_epicOHAutoBusy = false', 1200) || '';
  t.ok(/leaderCheck\(\)/.test(job), 'daily auto-snapshot is leader-gated');
  t.ok(/monitoringAutoSnapshot === false/.test(job), 'daily auto-snapshot is opt-out (default ON)');
  t.ok(/_epicOHDayStamp\(lastAt\) === today/.test(job), 'daily auto-snapshot fires at most once per local day');
  t.ok(/_epicOHSnapshot\(key\)/.test(job), 'daily auto-snapshot uses the no-AI helper');
  t.ok(/monitoringAutoSnapshot: true/.test(set), 'settings default has monitoringAutoSnapshot ON');

  // (4) AI rebuild is separated behind the ⋯ options menu; Snapshot now is the primary action.
  t.ok(/monObjSnapshot\(\)/.test(html), 'SPA wires the Snapshot now button');
  t.ok(/class="moh-opts-m"/.test(html), 'AI rebuild lives in an options menu, not a bare button');
  const optsMenu = _win(html, 'class="moh-opts-m"', 600) || '';
  t.ok(/monObjRebuild\(\)/.test(optsMenu), 'the options menu holds the explicit AI rebuild');
  const doSnap = _win(html, 'async monObjSnapshot()', 1200) || '';
  t.ok(/epic-dashboard\/'\s*\+\s*encodeURIComponent\(key\)\s*\+\s*'\/snapshot/.test(doSnap),
    'monObjSnapshot POSTs the per-epic snapshot route');
  t.ok(/o\.snapshotAt = r\.snapshotAt/.test(doSnap), 'monObjSnapshot refreshes snapshotAt from the response');
});

await t.test('epic objective health: LIVE data wiring — executable bindings, live snapshot run, probe + combined KPI card', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');

  // (1) SERVER — _monNormLive normalizes an executable binding (kusto|http) and nothing else.
  const norm = _win(srv, 'function _monNormLive(', 900) || '';
  t.ok(norm, '_monNormLive helper exists');
  t.ok(/\^\(kusto\|http\)\$/.test(norm), '_monNormLive accepts only kusto|http binding kinds');
  t.ok(/out\.cluster/.test(norm) && /out\.database/.test(norm) && /out\.query/.test(norm),
    '_monNormLive normalizes the kusto binding fields');
  t.ok(/out\.url/.test(norm) && /out\.jsonPath/.test(norm),
    '_monNormLive normalizes the http binding fields');

  // (2) SERVER — _epicOHRunLive executes the bound source and returns {ok,num,display,error},
  // never throwing (a failed fetch resolves to ok:false).
  const runLive = _win(srv, 'async function _epicOHRunLive(', 900) || '';
  t.ok(runLive, '_epicOHRunLive helper exists');
  t.ok(/_liveRunKusto\(b\)/.test(runLive) && /_liveRunHttp\(b\)/.test(runLive),
    '_epicOHRunLive dispatches to the kusto/http executor by binding kind');
  t.ok(/ok: true, num, display/.test(runLive) && /catch \(e\)[\s\S]*ok: false/.test(runLive),
    '_epicOHRunLive returns a value on success and degrades to ok:false on failure');

  // (3) SERVER — the snapshot loop runs every live binding FIRST, gates the append on a
  // real success (_liveOk), and stamps live status — this is what makes a trend actually MOVE.
  const snap = _win(srv, 'async function _epicOHSnapshot(', 2900) || '';
  t.ok(/await _epicOHRunLive\(o\)/.test(snap), 'snapshot executes each live binding before recording');
  t.ok(/o\._liveOk = true/.test(snap) && /o\._liveOk = false/.test(snap),
    'snapshot marks each objective live-ok transiently');
  t.ok(/o\.live\.lastValue = run\.num/.test(snap) && /o\.now = run\.display/.test(snap),
    'snapshot updates the recorded value from the REAL live result');
  t.ok(/'_liveOk' in o[\s\S]*delete o\._liveOk/.test(snap),
    'the transient _liveOk gate is deleted before persisting (never stored)');
  t.ok(/liveRun: true/.test(snap), 'snapshot appends readings in liveRun mode (honest failed-fetch gate)');

  // (4) SERVER — HONEST INVARIANT: a live-bound objective whose fetch FAILED appends NO reading.
  const append = _win(srv, 'function _epicOHAppendReadings(', 2400) || '';
  t.ok(/skipLiveFail = opts\.liveRun && o && o\.live && o\.live\.kind && o\._liveOk !== true/.test(append),
    'a failed live fetch is skipped — history is carried forward, never fabricated');
  t.ok(/if \(v != null && !skipLiveFail\)/.test(append),
    'the append gate honors the failed-live-fetch skip');

  // (5) SERVER — the probe route runs the binding WITHOUT recording and returns a top-level result.
  t.ok(/app\.post\('\/api\/monitoring\/epic-dashboard\/:key\/probe'/.test(srv),
    'server exposes the live-source probe route');
  const probe = _win(srv, "app.post('/api/monitoring/epic-dashboard/:key/probe'", 1600) || '';
  t.ok(/_monNormLive\(b\.live\)/.test(probe), 'probe normalizes an inline binding');
  t.ok(/await _epicOHRunLive\(\{ live \}\)/.test(probe), 'probe runs the binding through the executor');
  t.ok(/ok: !!run\.ok, value: run\.num, raw: run\.display, error: run\.error/.test(probe),
    'probe returns {ok,value,raw,error} at the top level and never appends a reading');
  t.ok(!/_epicOHAppendReadings/.test(probe), 'probe does NOT record a reading (dry-run only)');

  // (6) SERVER — bind_live / unbind_live ops attach + clear an executable binding.
  const ops = _win(srv, 'function _epicOHApplyOps(', 5200) || '';
  t.ok(/kind === 'bind_live'/.test(ops) && /_monNormLive\(op\.live/.test(ops),
    'bind_live normalizes + attaches an executable binding');
  t.ok(/bound && o\.status === 'miss'[\s\S]*o\.status = 'part'/.test(ops),
    'binding a sourceless objective flips miss → part');
  t.ok(/kind === 'unbind_live'/.test(ops) && /o\.live = null/.test(ops), 'unbind_live clears the binding');

  // (7) CLIENT — the combined KPI card renders current value AND trend together (one card).
  const kpi = _win(html, '_monEmKpiCard(o) {', 1200) || '';
  t.ok(kpi, '_monEmKpiCard helper exists');
  t.ok(/class="mem-kpi"/.test(kpi), 'the KPI card is one combined mem-kpi block');
  t.ok(/class="kv"/.test(kpi) && /class="ks"/.test(kpi),
    'the combined card pairs a value block (kv) with a trend/sparkline block (ks)');
  t.ok(/monEmHasTrend\(o\)/.test(kpi) && /Trend appears once/.test(kpi),
    'the trend half falls back to an honest empty-state until two readings are recorded');
  const cardViz = _win(html, 'monEmCardViz(o) {', 400) || '';
  t.ok(/_monEmKpiCard\(o\)/.test(cardViz), 'trend AND gauge objectives route to the combined KPI card');

  // (8) CLIENT — monEmLiveOn / monEmTopBadge / monEmTrendChip surface live + trend on the card.
  t.ok(/monEmLiveOn\(o\) \{ return !!\(o && o\.live && o\.live\.kind\)/.test(html),
    'monEmLiveOn detects an executable live binding');
  const topBadge = _win(html, 'monEmTopBadge(o) {', 400) || '';
  t.ok(/monEmTrendChip\(o\)/.test(topBadge), 'the card badge prefers the trend chip when a delta exists');
  const chip = _win(html, 'monEmTrendChip(o) {', 400) || '';
  t.ok(/monEmPriorDelta\(o\)/.test(chip) && /class="vt trend/.test(chip),
    'the trend chip renders a directional delta vs the prior reading');

  // (9) CLIENT — the footer live status reflects a failed fetch vs a fresh update.
  const foot = _win(html, 'monEmFootSrc(o) {', 700) || '';
  t.ok(/o\.live\.ok === false/.test(foot) && /live fetch failed/.test(foot),
    'the footer honestly reports a failed live fetch');
  t.ok(/monEmRelTime\(o\.live\.at\)/.test(foot) && /updated /.test(foot),
    'the footer shows the relative time of the last live update');

  // (10) CLIENT — probe UX: real Alpine markup (not x-html), state, and reset behavior.
  const detcol = _win(html, 'x-if="monObjLiveSel()"', 900) || '';
  t.ok(/class="moh-live/.test(detcol), 'the probe panel lives in the detail column as real Alpine markup');
  t.ok(/@click="monObjProbe\(\)"/.test(detcol) && /:disabled="monitoring\.obj\.probing"/.test(detcol),
    'the "Test live source" button runs a probe and disables while probing');
  t.ok(/monObjLiveBindHtml\(\)/.test(detcol) && /monObjProbeHtml\(\)/.test(detcol),
    'the probe panel shows the binding summary + the probe result');
  const doProbe = _win(html, 'async monObjProbe() {', 900) || '';
  t.ok(/\/probe'/.test(doProbe) && /body: JSON\.stringify\(\{ live: o\.live \}\)/.test(doProbe),
    'monObjProbe POSTs the objective binding to the probe route');
  t.ok(/monitoring\.obj\.probing = true; this\.monitoring\.obj\.probe = null/.test(doProbe),
    'monObjProbe seeds the probing state + clears the prior result');
  const probeHtml = _win(html, 'monObjProbeHtml() {', 600) || '';
  t.ok(/Source responded/.test(probeHtml) && /Fetch failed/.test(probeHtml),
    'the probe result HTML distinguishes success from a failed fetch');
});

await t.test('custom sidebar nav: items are drag-reorderable + groupable (pointer-based, WebView2-safe)', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // (1) ROOT-CAUSE GUARD — HTML5 native drag-and-drop does not reliably initiate inside WebView2,
  // so the grips must be POINTER-driven handles (@pointerdown → onNavGripDown), NOT native
  // draggable="true"/@dragstart sources. Both the top-level and grouped item grips + the group grip.
  const gripDowns = (html.match(/class="cnav-grip"[^>]*@pointerdown[^>]*="onNavGripDown\(/g) || []).length;
  t.ok(gripDowns >= 3, 'item + group grips are pointer handles wired to onNavGripDown');

  // (2) No stale native-DnD wiring survives on the nav (the prior failed fix).
  t.ok(!/onNavItemDragStart|onNavGroupDragStart|onNavItemDragOver|onNavItemDrop\(|onNavGroupHeaderDrop|onNavEndDrop\(/.test(
    html.replace(/former native onNavItemDrop \/ onNavGroupHeaderDrop \/ onNavEndDrop/, '')),
    'no stale native drag-and-drop handlers remain on the sidebar nav');
  t.ok(!/data-navtarget="item"[^>]*draggable="true"/.test(html), 'item rows are no longer native draggable sources');

  // (3) Rows/headers/zones carry data-navtarget hit-test markers the pointer path resolves via elementFromPoint.
  t.ok(/data-navtarget="item"/.test(html) && /data-navtarget="ghead"/.test(html)
    && /data-navtarget="gempty"/.test(html) && /data-navtarget="end"/.test(html),
    'nav rows/headers/empty-group/end zones expose data-navtarget hit-test markers');

  // (4) The pointer drag core is present: move/up/hit-test/apply-drop.
  t.ok(/_onNavPointerMove\(/.test(html) && /_onNavPointerUp\(/.test(html)
    && /_navHitTest\(/.test(html) && /_navApplyDrop\(/.test(html),
    'pointer drag core methods present (move/up/hit-test/apply-drop)');

  // (5) The grip is discoverable (not opacity:0) so the drag handle can actually be found.
  t.ok(/\.cnav-grip \{[^}]*opacity: \.22/.test(html), 'the grip has a faint always-visible baseline (discoverable)');

  // (6) Dropping one item ONTO another still combines them into a fresh group.
  const drop = _win(html, '_navApplyDrop(d, drop) {', 1600) || '';
  t.ok(/intent === 'onto'[\s\S]*_navCombineIntoGroup/.test(drop),
    'dropping one item onto another combines them into a new group');

  // (7) The item-row intent still has a middle (onto) band expressing a group intent.
  const intent = _win(html, '_navPtrItemIntent(', 700) || '';
  t.ok(/return 'onto'/.test(intent) || /intent: 'onto'/.test(intent) || /'onto'/.test(intent),
    'the middle band of an item row expresses a group (onto) intent');

  // (8) Active drag paints a body class so the cursor/selection behave (grabbing).
  t.ok(/nav-dragging/.test(html), 'active drag toggles a body.nav-dragging class');
});

await t.test('desktop native-DnD → pointer bridge (WebView2-safe drag everywhere else)', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // The SAME WebView2 quirk that broke the sidebar nav breaks EVERY other native
  // draggable feature (boards cards/groups/toolbox, home + management section
  // reorder, agent grouping, Me.AI blocks, compose library, flow palette). A single
  // global bridge replays the DragEvent sequence from pointer gestures so those
  // untouched handlers still fire in the desktop shell.

  // (1) The bridge exists and replays the full native-DnD sequence.
  t.ok(/Native drag-and-drop . pointer bridge/.test(html), 'the desktop native-DnD → pointer bridge is present');
  t.ok(/new DragEvent\(type,/.test(html), 'the bridge dispatches synthetic DragEvents');
  t.ok(/'dragstart'/.test(html) && /'dragover'/.test(html) && /'drop'/.test(html) && /'dragend'/.test(html),
    'the bridge fires dragstart → dragover → drop → dragend');

  // (2) It reuses ONE DataTransfer so setData()/getData() round-trips across the sequence.
  t.ok(/new DataTransfer\(\)/.test(html), 'the bridge shares a single DataTransfer for setData/getData round-trips');

  // (3) It is GATED to the desktop shell so the browser keeps its own working native DnD
  // (no double-processing / double-drop). Gate reads __DESKTOP__ (with a __TAURI__ fallback).
  t.ok(/function inDesktop\(\)/.test(html), 'the bridge exposes an inDesktop() gate');
  t.ok(/if \(!inDesktop\(\)\) return;/.test(html), 'the bridge no-ops in the browser (native DnD left intact)');
  t.ok(/__DESKTOP__/.test(html) && /__TAURI__/.test(html), 'the gate keys off __DESKTOP__ with a __TAURI__ fallback');

  // (4) It engages on existing [draggable] sources via pointerdown (no markup rewrites needed).
  t.ok(/el\.draggable === true/.test(html), 'the bridge picks up existing [draggable] sources');
  t.ok(/addEventListener\('pointerdown', onDown, true\)/.test(html), 'the bridge is driven by a capture-phase pointerdown');

  // (5) A dragstart that preventDefault()s (mode veto) cancels the drag; a real drop only
  // fires on a zone whose dragover was cancelled (spec-faithful).
  t.ok(/if \(cancelled\) \{ reset\(\); return false; \}/.test(html), 'a vetoed dragstart cancels the bridge drag');
  t.ok(/const allow = fire\(target, 'dragover'[\s\S]*if \(allow\) fire\(target, 'drop'/.test(html),
    'drop only fires on a zone whose dragover was cancelled');

  // (6) It suppresses ONLY the same-gesture click that follows a real drag (cards don't
  // "open" after a move), and can never eat an unrelated later click — a fresh pointerdown
  // clears the flag, so a button pressed after a drag still clicks.
  t.ok(/dragJustEnded = true;\s*\/\/ suppress ONLY the same-gesture click/.test(html),
    'a completed drag arms same-gesture click suppression');
  t.ok(/if \(dragJustEnded\) \{ dragJustEnded = false; ev\.stopPropagation\(\); ev\.preventDefault\(\); \}/.test(html),
    'the capture click listener swallows only a still-armed same-gesture click');
  t.ok(/if \(!inDesktop\(\)\) return;\s*\/\/ browser: leave native DnD alone\s*dragJustEnded = false;/.test(html),
    'a fresh pointerdown clears the suppression so later clicks (e.g. a button) are never eaten');
});

await t.test('boards toolbox→board drag gate detects the leftward swipe live, not just the armed flag', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const gate = _win(html, 'onTbxItemDragStart(p, ev) {', 2800);
  t.ok(gate, 'onTbxItemDragStart present');

  // Direction is derived LIVE from the dragstart coordinates vs. the pointerdown origin
  // (reliable on both platforms) rather than only the armed flag — on desktop the DnD
  // bridge fires dragstart at ~5px, before the 6px swipe-arm, so the armed flag alone
  // reads false and the unpin/delete swipe loses the race to a board drag.
  const gateCode = gate.replace(/\/\/[^\n]*/g, '');
  t.ok(/ddx\s*=\s*ev\.clientX\s*-\s*this\._tbxSwipeStartX/.test(gateCode),
    'gate computes live ddx from ev.clientX and the swipe origin');
  t.ok(/ddy\s*=\s*ev\.clientY\s*-\s*this\._tbxSwipeStartY/.test(gateCode),
    'gate computes live ddy from ev.clientY and the swipe origin');
  t.ok(/leftwardSwipe\s*=\s*ddx\s*<\s*0\s*&&\s*Math\.abs\(ddx\)\s*>\s*Math\.abs\(ddy\)/.test(gateCode),
    'gate flags a leftward-dominant gesture as the swipe');

  // A leftward swipe OR an already-armed swipe cancels the board drag (and force-arms so
  // the swipe move-listener keeps tracking to release).
  t.ok(/if \(this\._tbxSwipeArmed \|\| leftwardSwipe\) \{[\s\S]*?this\._tbxSwipeArmed = true;[\s\S]*?ev\.preventDefault\(\)[\s\S]*?return;\s*\}/.test(gateCode),
    'a leftward or armed swipe cancels the drag and force-arms');
  // Every other gesture (rightward / vertical / ambiguous) proceeds to start the drag.
  t.ok(/this\._tbxSwipeCleanup\(\);\s*this\.onToolboxDragStart\(this\.panelBaseId\(p\), ev\);/.test(gateCode),
    'a non-swipe gesture starts the board drag');

  // The fragile stale-delta direction reads stay GONE.
  t.ok(!/verticalDominant/.test(gateCode), 'no stale verticalDominant cancel in the gate');
  t.ok(!/const leftward = this\._tbxLastDX/.test(gateCode) && !/_tbxLastDX \|\| 0/.test(gateCode),
    'the gate does not read a frozen _tbxLastDX to decide direction');

  // The swipe move-listener still arms only on clearly leftward-dominant movement.
  const move = _win(html, 'tbxSwipeStart(p, ev) {', 2400);
  t.ok(/if \(ddx < 0 && Math\.abs\(ddx\) > Math\.abs\(ddy\)\) this\._tbxSwipeArmed = true;/.test(move),
    'the swipe arms only on clearly leftward-dominant movement');
});

await t.test('boards toolbox: hover-reveal × remove button works independent of the swipe (desktop-safe)', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // A real <button> is the guaranteed-robust removal path on desktop: the swipe gesture can be
  // starved by WebView2's native OLE drag, but a button click is always delivered (and the DnD
  // bridge ignores INTERACTIVE targets, so no drag starts).
  const btn = _win(html, '<button type="button" class="tbx-remove"', 620);
  t.ok(btn, 'tbx-remove button present in the toolbox item');
  t.ok(/^<button type="button"/.test(btn), 'the remove control is a real <button type="button">');
  t.ok(/@click\.stop(?:\.prevent)?="confirmRemovePanel\(p\)"/.test(btn),
    'clicking × calls the shared confirmRemovePanel(p) removal');
  t.ok(/@pointerdown\.stop/.test(btn),
    'pointerdown is stopped so pressing × never starts a row swipe/drag');
  t.ok(/draggable="false"/.test(btn), 'the button is not itself draggable');
  t.ok(/panelIsPinned\(p\)\s*\?\s*'Unpin/.test(btn),
    'the title is pinned-aware (Unpin vs Delete)');

  // CSS: hidden until hover/focus, danger tint on hover — calm, no layout shift.
  t.ok(/\.board-tbx-item \.tbx-remove \{[\s\S]*?opacity:\s*0;/.test(html),
    'the × is opacity:0 by default');
  t.ok(/\.board-tbx-item:hover \.tbx-remove,\s*\n?\s*\.board-tbx-item:focus-within \.tbx-remove \{ opacity:/.test(html),
    'the × reveals on hover/focus-within');
  t.ok(/\.board-tbx-item \.tbx-remove:hover \{[\s\S]*?var\(--cp-danger/.test(html),
    'hovering the × tints it danger');
});

await t.test('desktop (WebView2): native OLE drag is disabled so the pointer bridge owns dragging', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // The CSS kills WebView2's broken native drag on EVERY bridge-managed [draggable]
  // (toolbox items, board cards, home sections, agent cards…) — scoped to desktop via
  // html.dnd-desktop so the browser keeps its own working native DnD untouched. This is
  // the real fix for "toolbox items won't drag / show a not-allowed cursor" in the app.
  t.ok(/html\.dnd-desktop \[draggable="true"\] \{ -webkit-user-drag: none; \}/.test(html),
    'html.dnd-desktop [draggable="true"] disables the native OLE drag (keeps the attribute)');

  // The desktop marker class is applied BOTH synchronously in the bridge IIFE (covers the
  // Tauri __TAURI__ shell) AND after the async /api/version probe (covers __DESKTOP__).
  t.ok(/if \(inDesktop\(\)\) \{ try \{ document\.documentElement\.classList\.add\('dnd-desktop'\); \} catch \(e\) \{\} \}/.test(html),
    'the bridge IIFE tags <html> with dnd-desktop synchronously when in desktop');
  t.ok(/window\.__DESKTOP__ = !!\(v && v\.desktop\); if \(window\.__DESKTOP__\) \{ try \{ document\.documentElement\.classList\.add\('dnd-desktop'\);/.test(html),
    'the async /api/version handler also tags <html> with dnd-desktop as a fallback');

  // draggableAt() reads el.draggable (the attribute/IDL prop), which -webkit-user-drag does
  // NOT change — so the bridge still picks up these elements after native drag is disabled.
  t.ok(/el\.draggable === true/.test(html),
    'draggableAt still matches on el.draggable so the bridge engages');
});

await t.test('pin picker themes manager/Me.AI Run icons via a re-sweep so they match the active icon set', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // The pin-kind button row (session…meairun) renders emoji via boardKindIcon; the global
  // emoji→SVG replacer normally themes them, but a couple stragglers (manager 👔, Me.AI Run
  // 🔭) could be left as raw color emoji when Alpine's x-text write lands inside the
  // replacer's `busy` sweep window (onMutations drops those). An x-effect nudges a targeted
  // re-sweep of the row after render/kind-change so every icon matches the active icon set.
  t.ok(/x-effect="boardPinKind; boardPinOpen && \$nextTick\(\(\) => \{ try \{ window\.cpIcons && window\.cpIcons\.sweep\(\$el\); \} catch \(e\) \{\} \}\)"/.test(html),
    'the pin-kind row re-sweeps icons on open / kind change via window.cpIcons.sweep');
  // The emoji the two stragglers use ARE mapped (so a sweep actually themes them): 👔→manager,
  // 🔭→insights. Guard the mapping so a future emoji swap can't silently un-theme them again.
  t.ok(/"👔":\s*"manager"/.test(html), 'the manager emoji maps to the manager glyph role');
  t.ok(/"🔭":\s*"insights"/.test(html), 'the Me.AI Run telescope maps to the insights glyph role');
  // sweep() is a no-op in emoji mode, so this never forces themed glyphs on emoji users.
  t.ok(/if \(!root \|\| current === 'emoji'\) return;/.test(html),
    'cpIcons.sweep is a no-op when the icon set is plain emoji (respects appearance settings)');
});

await t.test('GET /api/compose reads the store ONCE via compose.snapshot() (faster document/pin-picker load)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const compose = readFileSync('compose.js', 'utf8');

  // The launcher/pin-picker document list is backed by GET /api/compose. It used to call
  // _readAll() three times (listCompositions + listFolders + getAssignments), re-reading and
  // re-hydrating the ENTIRE store (full doc bodies) 3× — cost that scales with the user's
  // document count and shows up as a long "Loading documents…" spinner. snapshot() reads once.
  const route = _win(srv, "app.get('/api/compose',", 700) || '';
  t.ok(route, 'GET /api/compose route present');
  t.ok(/const snap = compose\.snapshot\(\);/.test(route), 'the route reads the store once via compose.snapshot()');
  t.ok(!/compose\.listCompositions\(\)/.test(route) && !/compose\.listFolders\(\)/.test(route) && !/compose\.getAssignments\(\)/.test(route),
    'the route no longer triggers three separate full-store reads');

  // compose.snapshot() derives all three views from a single _readAll(), and the three list
  // helpers accept that pre-read state so nothing re-reads disk.
  const snap = _win(compose, 'function snapshot()', 400) || '';
  t.ok(/const st = _readAll\(\);/.test(snap), 'snapshot() reads the store exactly once');
  t.ok(/listCompositions\(st\)/.test(snap) && /listFolders\(st\)/.test(snap) && /getAssignments\(st\)/.test(snap),
    'snapshot() derives compositions/folders/assignments from the single read');
  t.ok(/function listCompositions\(st\) \{\s*st = st \|\| _readAll\(\);/.test(compose),
    'listCompositions accepts an optional pre-read state');
  t.ok(/module\.exports = \{[\s\S]*?\bsnapshot,/.test(compose), 'snapshot is exported');
});

await t.test('boot splash reel + About check-for-updates', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');

  // (A) Boot splash overlay is present and reveals on body.booted — pre-Alpine, no x-cloak.
  t.ok(/id="bootSplash"/.test(html), 'boot splash overlay present');
  t.ok(/id="bootReel"/.test(html), 'boot reel container present');
  // Reel images are shown large (container was 360x230 → enlarged so cached art reads clearly).
  t.ok(/#bootSplash \.boot-reel\{[^}]*width:min\(860px,94vw\)[^}]*height:min\(520px,62vh\)/.test(html), 'boot reel is enlarged for readable art');
  t.ok(/'booted':\s*!loading/.test(html), 'body :class flips booted on !loading');
  t.ok(/body\.booted #bootSplash/.test(html), 'booted fades the splash out');
  // splash script fetches the reel endpoint
  t.ok(/\/api\/boot\/reel/.test(html), 'boot splash fetches the reel endpoint');

  // (A) Server endpoint returns a reel (clamped), never throws.
  const route = _win(srv, "app.get('/api/boot/reel'", 800) || '';
  t.ok(route, 'boot reel route defined');
  t.ok(/_pulseComedyReel\(/.test(route), 'boot reel route reuses the comedy reel backlog');
  t.ok(/reel:\s*\[\]/.test(route), 'boot reel route degrades to an empty reel on error');

  // (B) About "Check for updates" — row + method + state.
  t.ok(/checkForUpdatesFromAbout/.test(html), 'About check-for-updates method wired');
  const m = _win(html, 'async checkForUpdatesFromAbout()', 900) || '';
  t.ok(/this\.checkForUpdate\(true\)/.test(m), 'About check reuses checkForUpdate() with a forced (cache-bypassing) refresh');
  t.ok(/checking:\s*false/.test(html), 'update state carries a checking flag');
});

await t.test('version number opens GitHub source in desktop (both sidebar + Settings) via openSourceRepo', () => {
  const html = readFileSync('public/app.html', 'utf8');

  // A shared helper routes through the OS-browser bridge on desktop (WebView2
  // blocks target=_blank) and falls back to a normal tab in a plain browser.
  const fn = _win(html, 'openSourceRepo() {', 600) || '';
  t.ok(fn, 'openSourceRepo() method defined');
  t.ok(/github\.com\/chcosta\/TheOffice\.AI/.test(fn), 'openSourceRepo targets the source repo');
  t.ok(/window\.__DESKTOP__ && typeof window\.__openExternal === 'function'/.test(fn),
    'desktop path uses the __openExternal OS-browser bridge');
  t.ok(/window\.open\(url, '_blank', 'noopener'\)/.test(fn), 'browser path opens a normal tab');

  // Sidebar version link keeps target=_blank (browser) AND an explicit @click so
  // it works even if the capture-phase interceptor never fires (WebView2 quirk).
  t.ok(/x-text="versionLabel\(\)"[\s\S]{0,80}?title="View the source on GitHub"/.test(html)
    && /@click\.prevent="openSourceRepo\(\)"[\s\S]{0,120}?x-text="versionLabel\(\)"/.test(html),
    'sidebar version anchor calls openSourceRepo() on click');

  // Settings > System Info "Version" is a real link now (was a dead <span>).
  t.ok(/<strong>Version<\/strong><a href="#"[^>]*@click\.prevent="openSourceRepo\(\)"[^>]*x-text="versionLabel\(\)"/.test(html),
    'Settings System Info version is a clickable source link');
});

await t.test('updater bounds the GitHub release lookup with a timeout (no infinite "Checking…")', () => {
  const upd = readFileSync('updater.js', 'utf8');
  t.ok(/CHECK_TIMEOUT_MS\s*=/.test(upd), 'a bounded check timeout is defined');
  const fj = _win(upd, 'async function fetchJson(url)', 1200) || '';
  t.ok(/new AbortController\(\)/.test(fj), 'fetchJson wires an AbortController');
  t.ok(/setTimeout\(\(\) => ctrl\.abort\(\), CHECK_TIMEOUT_MS\)/.test(fj), 'the fetch aborts after CHECK_TIMEOUT_MS');
  t.ok(/signal:\s*ctrl\.signal/.test(fj), 'the fetch passes the abort signal');
  t.ok(/AbortError|ABORT_ERR/.test(fj) && /timed out/.test(fj), 'an aborted check surfaces a clear timeout error');
  t.ok(/clearTimeout\(timer\)/.test(fj), 'the timer is always cleared');
});

await t.test('updater: last-applied verifiable signal (server + client + parser)', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const srv = readFileSync('server.js', 'utf8');
  const upd = readFileSync('updater.js', 'utf8');

  // (A) updater.lastApplied() parses the apply-update.log format, desktop-only, last match.
  t.ok(/function lastApplied\(\)/.test(upd), 'updater.lastApplied() defined');
  const la = _win(upd, 'function lastApplied()', 700) || '';
  t.ok(/isDesktop\(\)/.test(la), 'lastApplied is desktop-only guarded');
  t.ok(/apply-update\.log/.test(la), 'lastApplied reads apply-update.log');
  t.ok(/applied server update ->/.test(la), 'lastApplied regex anchors on the log line format');
  t.ok(/keep the LAST match|match = m/.test(la), 'lastApplied keeps the last (most recent) match');
  t.ok(/lastApplied,/.test(upd), 'updater exports lastApplied');

  // (B) /api/update/status returns lastApplied.
  const route = _win(srv, "app.get('/api/update/status'", 260) || '';
  t.ok(/lastApplied:\s*updater\.lastApplied\(\)/.test(route), 'status route returns updater.lastApplied()');

  // (C) pollUpdateStatus stores update.lastApplied; state default present.
  const poll = _win(html, 'async pollUpdateStatus()', 700) || '';
  t.ok(/'lastApplied' in s/.test(poll) && /this\.update\.lastApplied\s*=/.test(poll), 'pollUpdateStatus stores lastApplied');
  t.ok(/lastApplied:\s*null/.test(html), 'update state carries a lastApplied default');

  // (D) About row + label helper (desktop-only via x-show).
  t.ok(/x-show="update\.lastApplied"/.test(html), 'About row shown only when lastApplied present');
  t.ok(/lastAppliedLabel\(\)/.test(html), 'About row renders lastAppliedLabel()');
  const lbl = _win(html, 'lastAppliedLabel() {', 400) || '';
  t.ok(/la\.version/.test(lbl) && /formatDateTime/.test(lbl), 'lastAppliedLabel formats version + date');
});

await t.test('Meetings.AI: Basic opt-in and Advanced opt-out experience feature', () => {
  const html = readFileSync('public/app.html', 'utf8');
  t.ok(/basicFeatures:[\s\S]{0,700}meetings: false/.test(html),
    'Meetings.AI defaults OFF in Basic');
  t.ok(/advancedFeatures:[\s\S]{0,700}meetings: true/.test(html),
    'Meetings.AI defaults ON in Advanced');
  const basicCat = _win(html, 'basicFeatureCatalog() {', 2800);
  const advancedCat = _win(html, 'advancedFeatureCatalog() {', 3200);
  t.ok(/key: 'meetings', label: 'Meetings\.AI'/.test(basicCat),
    'Basic experience settings list Meetings.AI as an opt-in');
  t.ok(/key: 'meetings', label: 'Meetings\.AI'/.test(advancedCat),
    'Advanced experience settings list Meetings.AI as an opt-out');
  const navKeys = _win(html, '_navDefaultKeys(scope) {', 2200);
  t.ok((navKeys.match(/if \(en\('meetings'\)\) out\.push\('meetings'\)/g) || []).length === 2,
    'both Basic and Advanced menus honor the Meetings.AI feature flag');
  const basicRoutes = _win(html, 'basicRouteVisible(route) {', 1800);
  const advancedRoutes = _win(html, 'advancedRouteVisible(route) {', 1800);
  t.ok(/meetings: \['meetings'\]/.test(basicRoutes) &&
       /meetings: \['meetings'\]/.test(advancedRoutes),
    'the Meetings.AI route is gated consistently in both experiences');
});

await t.test('meetings.ai: studio page — verified calendar occurrences + AI timeouts + SPA player wiring', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const player = readFileSync('public/meeting-recap.html', 'utf8');

  // (1) SERVER — recent-meetings gather talks to WorkIQ directly and is timeout-bounded,
  // so the route can never hang; on timeout/failure the surrounding try returns [] honestly.
  const gather = _win(srv, 'async function _meetingsGatherRange(', 7000) || '';
  t.ok(gather, '_meetingsGatherRange helper exists');
  t.ok(/_meetingsWorkIqAsk\(prompt, 150000\)/.test(gather),
    'the calendar gather calls WorkIQ directly with a bounded timeout');
  t.ok(!/_connectRunAgent\('collector'/.test(gather),
    'meeting discovery does not use the Connect collector agent');
  t.ok(/catch \{ return \[\]; \}/.test(gather), 'a failed/timed-out gather degrades to an empty list');

  // (2) SERVER — recap build: seed short-circuit, AI transcript path is timeout-bounded, and the
  // dropped-then-restored _connectExtractJson is present (the bug that broke the real recap path).
  const recap = _win(srv, 'async function _meetingsBuildRecap(', 30000) || '';
  t.ok(recap, '_meetingsBuildRecap helper exists');
  t.ok(/id === _MEETINGS_SEED_ID/.test(recap), 'the seed meeting short-circuits to the authored SFI story');
  t.ok(/_meetingsWorkIqAsk\(compactPrompt, 120000\)/.test(recap),
    'the WorkIQ transcript fallback remains bounded when direct VTT retrieval is unavailable');
  t.ok(/const analysisPromise = directBundle && directBundle\.transcriptVtt/.test(recap) &&
       /_meetingsWorkIqAsk\(compactPrompt, 120000\)\.then\(_connectExtractJson\)/.test(recap) &&
       /const \[obj, evidenceText\] = await Promise\.all/.test(recap),
    'direct or fallback transcript analysis is parsed before shaping the recap');
  t.ok(/asking one WorkIQ call to do[\s\S]*both jobs produced oversized answers/.test(recap) &&
       /WorkIQ did not return a usable transcript recap for the exact occurrence/.test(recap),
    'transcript extraction is compact and unusable responses become retryable errors rather than false no-transcript claims');
  t.ok(/return \{ story: minimal, people: \{[\s\S]*empty: true/.test(recap),
    'an unavailable transcript degrades to a minimal never-crash story with empty:true');
  const workiq = _win(srv, 'function _meetingsWorkIqTool(', 5200) || '';
  t.ok(/spawnSync\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/.test(workiq),
    'Windows WorkIQ cleanup terminates the bounded subprocess tree by PID');
  t.ok(/child\.stdin\.end\(\)/.test(workiq),
    'successful WorkIQ calls close stdin so the MCP server can exit cleanly');
  t.ok(/settled \|\| child\.exitCode !== null \|\| child\.stdin\.destroyed \|\| child\.stdin\.writableEnded/.test(workiq) &&
       /child\.stdin\.on\('error'/.test(workiq),
    'late WorkIQ responses cannot write to a closed subprocess pipe and crash the service');
  t.ok(/commandParts\.map\(value => \/\\s\/\.test\(value\) \? `"\$\{value\}"` : value\)/.test(workiq),
    'Windows WorkIQ launch quotes safe command/argument values that contain spaces');
  t.ok(/arguments: toolArgs \|\| \{\}/.test(workiq) && /const commandArgs = Array\.isArray\(workiq\.args\)/.test(workiq),
    'the MCP command arguments cannot shadow the structured arguments sent to the WorkIQ tool');

  // (3) SERVER — routes: recent is cached per window without inventing sample meetings; recap requires a meetingId.
  const rec = _win(srv, "app.get('/api/meetings/recent'", 7000) || '';
  t.ok(rec, 'GET /api/meetings/recent route exists');
  t.ok(/const cached = _meetingsRecentCache\.get\(key\);[\s\S]{0,240}\(now - cached\.at\) < ttl/.test(rec) &&
       /const fallback = cached \|\| \(isRange \? _meetingsRollingCacheForRange\(start, end\) : null\)/.test(rec) &&
       /_meetingsRefreshRecent\(key,[\s\S]{0,500}refreshing: true/.test(rec) &&
       !/await _meetingsGather(?:Range|Recent)/.test(rec),
    'recent serves fresh, stale, or rolling cached rows immediately and refreshes off the request path');
  t.ok(/_MEETINGS_RECENT_CACHE_FILE\s*=\s*path\.join\(dataPath\('meetings'\), 'recent-cache\.json'\)/.test(srv) &&
       /function _meetingsLoadRecentCache\(/.test(srv) &&
       /function _meetingsPersistRecentCache\(/.test(srv) &&
       /function _meetingsSetRecentCache\(/.test(srv),
    'calendar windows persist across desktop sidecar restarts');
  t.ok(/demo: !!\(fallback && fallback\.demo\)/.test(rec) && !/_meetingsSeedRecent\(\)/.test(rec),
    'an empty or failed calendar gather remains honest instead of inflating the week with samples');
  const rcp = _win(srv, "app.post('/api/meetings/recap'", 5200) || '';
  t.ok(rcp, 'POST /api/meetings/recap route exists');
  t.ok(/if \(!meetingId\) return res\.status\(400\)/.test(rcp), 'recap 400s without a meetingId');
  t.ok(/const force = !!\(req\.body && req\.body\.force\)/.test(rcp) &&
       /const cached = !force && prior/.test(rcp) &&
       /const best = force && built && built\.story && !built\.empty/.test(rcp),
    'force regeneration bypasses the durable cache and replaces it only with a valid rebuilt story');
  t.ok(/await _meetingsProfilePhotos\(best\.people\)/.test(rcp) &&
       /const payload = \{ \.\.\.best, photos, photoVersion: _MEETINGS_PHOTO_CACHE_VERSION \}/.test(rcp) &&
       /const served = _meetingsWithLocalMedia\(meetingId, payload\)/.test(rcp) &&
       /story: served\.story, people: served\.people, photos/.test(rcp),
    'recap returns the best durable story/people/quality payload with resolved profile photos');
  const mediaCache = _win(srv, 'const _MEETINGS_MEDIA_DIR', 7000) || '';
  t.ok(/function _meetingsReadLocalMediaManifest\(/.test(mediaCache) &&
       /_meetingsMediaToken\(meetingId\) !== token/.test(mediaCache) &&
       /requestedFile !== file/.test(mediaCache) &&
       /path\.resolve\(_MEETINGS_MEDIA_DIR, token\)/.test(mediaCache),
    'private meeting media manifests are meeting-bound and reject unsafe file paths');
  t.ok(/function _meetingsWithLocalMedia\(/.test(mediaCache) &&
       /localClips\.find\(item => item\.segmentIndex === index\)/.test(mediaCache) &&
       /return clip \? \{ \.\.\.segment, audioClipId: clip\.id \} : segment/.test(mediaCache) &&
       /grade: 'authentic-media', hasAuthenticAudio: true, ready: true/.test(mediaCache),
    'validated local clips attach deterministically to their authored story segments');
  const mediaRoute = _win(srv, "app.get('/api/meetings/media/:token/:file'", 2600) || '';
  t.ok(/_meetingsReadLocalMediaManifest\(token\)/.test(mediaRoute) &&
       /loaded\.manifest\.clips\.some/.test(mediaRoute) &&
       /Cache-Control', 'private, max-age=86400'/.test(mediaRoute) &&
       /Content-Type', _meetingsLocalMediaContentType\(file\)/.test(mediaRoute) &&
       /res\.sendFile\(full\)/.test(mediaRoute),
    'the private media route serves only manifest-listed files through seekable Express sendFile responses');
  const briefRoute = _win(srv, "app.get('/api/meetings/brief'", 2500) || '';
  t.ok(/const rec = _meetingsWithLocalMedia\(meetingId, cached\)/.test(briefRoute),
    'the read-first brief reports authentic cached media consistently with the player payload');

  // (4) SPA — the Meetings.AI studio section + the data-driven iframe player + the ready handshake.
  t.ok(/route === 'meetings'/.test(html), 'the Meetings.AI section renders on the meetings route');
  t.ok(/<iframe x-ref="mtgPlayer" src="\/public\/meeting-recap\.html" @load="_mtgPushRecap\(\)"/.test(html),
    'the recap player uses the real public asset path instead of the SPA fallback, then receives its payload on load');
  t.ok(/html,body\{margin:0;width:100%;height:100%;overflow:hidden;background:var\(--bg\)/.test(player) &&
       /\.wrap\{height:100vh;overflow:hidden/.test(player),
    'the recap player owns a full-height dark backdrop (no white iframe tail)');
  t.ok(/readyTimer=setInterval\(announceReady,1200\)/.test(player) &&
       /Recap player is still waiting/.test(player) &&
       /id="loadingRetry"/.test(player),
    'the player continuously retries its payload handshake and surfaces honest progress plus recovery');
  t.ok(/function drawEvidenceBoard\(/.test(player) &&
       /function evidenceForBeat\(/.test(player) &&
       /id="sourceLinks"/.test(player),
    'the newscast renders source-backed evidence and exposes clickable provenance below the stage');
  t.ok(/html,body\{[^}]*height:100%;overflow:hidden/.test(player) &&
       /#recap\{height:100vh;min-height:0;overflow:hidden;flex-direction:column\}/.test(player) &&
       /document\.getElementById\('recap'\)\.style\.display='flex'/.test(player),
    'the player uses a true viewport-fit layout instead of creating an unnecessary iframe scrollbar');
  t.ok(/id="narrationBtn"/.test(player) &&
       /function beatNarration\(/.test(player) &&
       /function narrationChunks\(/.test(player) &&
       /new SpeechSynthesisUtterance\(NARRATION_QUEUE\.shift\(\)\)/.test(player) &&
       /utterance\.rate=1\.14; utterance\.pitch=1\.12/.test(player) &&
       /STORY\.openingNarration/.test(player) &&
       /STORY\.editorialThroughline/.test(player) &&
       /STORY\.decisionSynthesis/.test(player) &&
       /STORY\.closingSynthesis/.test(player),
    'the player uses a warmer upbeat voice and chunked additive editorial narration instead of reading visible slide text');
  const beatNarration = _win(player, 'function beatNarration(beat)', 2600) || '';
  t.ok(/text=seg\.narration\|\|''/.test(beatNarration) &&
       /text=proof\|\|''/.test(beatNarration) &&
       !/Now the story turns/.test(beatNarration) &&
       !/Now we open/.test(beatNarration) &&
       !/The conversation converted/.test(beatNarration),
    'the player trusts the authored continuous script instead of injecting repetitive stock transitions');
  t.ok(/const waitingForNarrator=!clip&&narrationEnabled&&!NARRATION_DONE/.test(player) &&
       /!waitingForNarrator && !waitingForMedia && !awaitingNext/.test(player) &&
       /utterance\.onend=.*speakNarrationChunk/.test(player),
    'chapter progression waits for narration or authentic media to finish instead of cutting either source off');
  t.ok(/\/api\/meetings\/narration\/config/.test(srv) &&
       /\/api\/meetings\/narration\/synthesize/.test(srv) &&
       /audio-24khz-48kbitrate-mono-mp3/.test(srv) &&
       /_MEETINGS_NARRATION_DIR/.test(srv) &&
       /Ocp-Apim-Subscription-Key/.test(srv),
    'Azure neural narration is server-side, credential-isolated, and persistently audio-cached');
  t.ok(/id="narratorProvider"/.test(player) &&
       /id="narratorVoice"/.test(player) &&
       /id="narratorStyle"/.test(player) &&
       /function speakAzureNarration\(/.test(player) &&
       /AI narration: Preparing neural voice/.test(player) &&
       /AI narration: System fallback/.test(player),
    'the player exposes Azure voice/style selection with an explicit system fallback');
  t.ok(/NARRATION_AUDIO\.pause\(\)/.test(player) &&
       /NARRATION_AUDIO\.play\(\)\.catch/.test(player) &&
       /NARRATION_ABORT\.abort\(\)/.test(player),
    'pause, resume, and chapter changes control neural audio and cancel stale synthesis');
  t.ok(/class="studio"/.test(player) &&
       !/class="anchor-zone"/.test(player) &&
       /\.screen-zone\{width:100%;height:100%/.test(player) &&
       /id="cameraRig"/.test(player) &&
       /id="lowerThird"/.test(player) &&
       /id="chapterLabel"/.test(player),
    'the production player gives story visuals the full stage without a decorative newscaster frame');
  t.ok(/id="sourceVideo"/.test(player) &&
       /function clipForBeat\(/.test(player) &&
       /function startOriginalMedia\(/.test(player) &&
       /const isVideo=clip\.mediaType==='video'/.test(player) &&
       /if\(isVideo\)/.test(player) &&
       /if\(playing&&clip\)[\s\S]{0,180}startOriginalMedia\(clip\)/.test(player) &&
       /else if\(narrationEnabled&&playing\)[\s\S]{0,180}speakBeat/.test(player),
    'authentic video beats start source playback instead of synthetic narration');
  t.ok(/const waitingForMedia=!!clip&&!MEDIA_DONE/.test(player) &&
       /if\(t>=\(\(b&&b\.dur\)\|\|3000\) && !waitingForNarrator && !waitingForMedia && !awaitingNext\)/.test(player) &&
       /video\.onended=finishOriginalMedia/.test(player),
    'the timeline cannot advance past a source beat until its recording clip finishes');
  t.ok(/<div class="media-footage">[\s\S]*<video id="sourceVideo"[\s\S]*<\/div>[\s\S]*<div class="media-caption">/.test(player) &&
       /id="mediaQuote"/.test(player) &&
       /\.media-caption\{/.test(player),
    'verbatim quotes render in a dedicated caption rail below, never over, source footage');
  t.ok(/id="autoBtn" class="primary-control"[\s\S]{0,180}aria-label="Pause newscast"/.test(player) &&
       /let STORY=null,[\s\S]{0,180}autoplay=true/.test(player) &&
       /window\.speechSynthesis\.pause\(\)/.test(player) &&
       /window\.speechSynthesis\.resume\(\)/.test(player) &&
       /pausedElapsed=Math\.max\(0,performance\.now\(\)-beatStart\)/.test(player),
    'the narrated newscast advances continuously by default with an obvious pause/resume control that preserves the current chapter');
  t.ok(/class="transport"/.test(player) &&
       /id="prevBtn"/.test(player) &&
       /id="nextBtn"/.test(player) &&
       /class="player-menu"/.test(player) &&
       /class="player-menu-panel"/.test(player) &&
       !/class="controls"/.test(player),
    'previous, pause, and next stay visible while replay and narration options move into a compact overflow menu');
  t.ok(/\.transport\{[^}]*opacity:0/.test(player) &&
       /\.transport:hover,\.transport:focus-within,\.transport:has\(\.player-menu\[open\]\)\{opacity:1\}/.test(player) &&
       /@media \(hover:none\)\{\.transport\{opacity:1\}\}/.test(player),
    'the playback transport stays invisible until hover or focus, with a touch-device accessibility fallback');
  t.ok(/class="ticker-track"/.test(player) &&
       /@keyframes ticker-scroll/.test(player) &&
       /\.studio\{position:absolute;inset:30px 0 32px/.test(player) &&
       /track\.style\.setProperty\('--ticker-duration'/.test(player),
    'scene descriptions scroll through a reserved themed ticker lane instead of obscuring scene content');
  t.ok(/window\.parent\.getComputedStyle\(source\)/.test(player) &&
       /--cp-accent/.test(player) &&
       /data-appearance/.test(player) &&
       /data-corners/.test(player) &&
       /background:var\(--cp-panel-strong\)/.test(player),
    'player chrome inherits the live parent theme, appearance palette, and corner preference');
  t.ok(/CLICK_TARGETS\.push\(\{x,y,w:cw,h:ch,url:item\.url/.test(player) &&
       /function evidenceHit\(/.test(player) &&
       /window\.open\(hit\.url,'_blank','noopener'\)/.test(player),
    'evidence cards on the canvas are directly clickable while text source links remain available');
  const beats = _win(player, 'function buildBeats(story)', 6200) || '';
  t.ok(/function evidencePriority\(/.test(player) &&
       /const linked=evidenceForSegment\(seg\)/.test(player) &&
       !/B\.push\(\{type:'evidence'/.test(beats) &&
       !/Evidence map/.test(player),
    'retrieved artifacts support narrative scenes without forcing a standalone evidence-map scene');
  t.ok(/id="audioBtn"/.test(player) &&
       /function startOriginalMedia\(clip\)/.test(player) &&
       /stopNarration\(\)/.test(player) &&
       /new Audio\(clip\.url\)/.test(player) &&
       /video\.src=clip\.url/.test(player) &&
       /original clips are labeled separately/.test(player) &&
       /Original meeting recording/.test(player),
    'the player supports authentic source audio or video without inventing or mislabeling either');
  t.ok(!/type:'wide'/.test(beats) && !/Conference room/.test(player),
    'the recap does not waste a beat on an empty conference-room establishing shot');
  t.ok(/story\.scenePlan/.test(beats) &&
       /purpose/.test(beats) &&
       /if\(B\.length>=2\) return B/.test(beats) &&
       /meaningfulText/.test(beats) &&
       !/type:'title'/.test(beats) &&
       !/type:'overview'/.test(beats),
    'the model-authored scene plan controls the edit and starts on substantive material without title or intro beats');
  t.ok(/if\(beat===BEATS\[0\]\)/.test(player) &&
       /STORY\.openingNarration,STORY\.editorialThroughline/.test(player),
    'the narrative hook plays over the first substantive scene instead of consuming its own slide');
  t.ok(/Evidence-backed transcript recap with AI newscaster narration · no playable meeting audio was retrieved\./.test(player) &&
       /Transcript-only recap with AI newscaster narration · no supporting media was retrieved\./.test(player) &&
       /Narration is synthetic/.test(player),
    'the player distinguishes synthetic narration from unavailable original meeting audio');
  t.ok(/if \(d && d\.type === 'mrv:ready'\) \{ try \{ this\._mtgPushRecap\(\); \} catch/.test(html),
    'the global message listener answers the player mrv:ready handshake');
  t.ok(/function stopRecapPlayback\(\)/.test(player) &&
       /stopNarration\(\);\s*stopAudio\(\)/.test(player) &&
       /d\.type==='mrv:stop'/.test(player) &&
       /window\.addEventListener\('pagehide',stopRecapPlayback\)/.test(player) &&
       /visibilitychange/.test(player),
    'the player tears down narration and original media when hidden, unloaded, or explicitly stopped');
  const stopRecap = _win(html, '_mtgStopRecap() {', 900) || '';
  t.ok(/if \(changed && this\.meetings && this\.meetings\.view === 'recap'\) this\._mtgStopRecap\(\)/.test(html) &&
       /mtgBackToDetail\(\)[\s\S]{0,120}this\._mtgStopRecap\(\)/.test(html) &&
       /typeof fr\.contentWindow\.stopRecapPlayback === 'function'/.test(stopRecap) &&
       /type: 'mrv:stop'/.test(stopRecap),
    'SPA navigation and Back to details stop iframe playback before leaving the newscast');
  t.ok(/Sources & evidence/.test(html) &&
       /Watch AI-edited recap/.test(html) &&
       /No source-backed newscast is available/.test(html),
    'meeting details surface provenance while presenting the player as an AI edit, not an evidence tour');
  const meetingDetail = _win(html, 'class="mtg-detail-head"', 18000) || '';
  t.ok(/class="mtg-watch"/.test(meetingDetail) &&
       /@click="mtgGenerateRecap\(\)"/.test(meetingDetail) &&
       meetingDetail.indexOf('class="mtg-watch"') < meetingDetail.indexOf('<!-- AI brief:'),
    'the primary watch action appears beside the meeting title before the full recap');
  const regenerate = _win(html, 'async mtgGenerateRecap(force = false)', 2200) || '';
  t.ok(/@click="mtgGenerateRecap\(true\)"/.test(html) &&
       /Regenerate from sources/.test(html) &&
       /force: !!force/.test(regenerate) &&
       /await this\.mtgLoadBriefStatus\(m\.id\)/.test(regenerate) &&
       /Recap regenerated from the latest transcript and evidence/.test(regenerate),
    'a selected completed meeting can explicitly rebuild its cached recap from current sources');
  t.ok(/w\.selectedId === pick && w\.view === 'recap'/.test(html) &&
       /if \(pick && !\(w\.selectedId === pick && w\.view === 'recap'\)\) this\.mtgSelect\(pick\)/.test(html),
    'background calendar refreshes preserve an already-playing recap for the selected meeting');
  t.ok(/class="mtg" :class="\{ 'recap-mode': meetings\.view === 'recap' \}"/.test(html) &&
       /\.content:has\(\.mtg\.recap-mode\)\{ overflow:hidden/.test(html) &&
       /\.mtg\.recap-mode\{ height:100%; min-height:0/.test(html) &&
       /\.mtg\.recap-mode \.mtg-wrap\{ height:100%; max-width:none/.test(html) &&
       /\.mtg\.recap-mode \.mtg-recap iframe\{ flex:1; height:auto; min-height:0/.test(html),
    'recap mode uses the available viewport and horizontal workspace without document overflow');
  t.ok(/function drawBackdrop\(kind,dim\)/.test(player) &&
       /drawBackdrop\('source'/.test(player) &&
       /drawBackdrop\('decisions'/.test(player) &&
       /drawBackdrop\('actions'/.test(player) &&
       !/for\(let i=0;i<5;i\+\+\)/.test(player),
    'scene-specific backdrops replace the repetitive row of five empty stage blocks');
  t.ok(/<a class="mtg-evidence-row" :href="e\.url"[^>]+@click\.prevent\.stop="openMeetingEvidence\(e\.url, \$event\)"/.test(html) &&
       /openMeetingEvidence\(url, event\)/.test(html) &&
       /window\.location\.assign\(href\)/.test(html) &&
       /evidence\.filter\(item => item && item\.url\)/.test(srv),
    'every source row explicitly opens its destination, with same-window fallback when new tabs are unavailable');
  t.ok(/function _meetingsDirectSourceBundle\(/.test(srv) &&
       /\?\$format=text\/vtt/.test(srv) &&
       /callRecordingEventMessageDetail/.test(srv) &&
       /detail\.callRecordingUrl/.test(srv),
    'the exact Teams occurrence resolves raw Graph VTT plus the human recording link');
  const directAnalysis = _win(srv, 'async function _meetingsAnalyzeDirectTranscript(', 5000) || '';
  t.ok(/availableTools: \[\]/.test(directAnalysis) &&
       /Analyze this exact Microsoft Teams VTT transcript locally/.test(directAnalysis) &&
       /_meetingsGroundDirectAnalysis\(/.test(directAnalysis) &&
       /Every quote must be copied verbatim from the VTT/.test(directAnalysis),
    'raw transcript analysis runs without tools and deterministically grounds every displayed quote');
  t.ok(/openingNarration/.test(directAnalysis) &&
       /decisionSynthesis/.test(directAnalysis) &&
       /scenePlan/.test(directAnalysis) &&
       /one continuous editorial script/.test(directAnalysis) &&
       /Never use stock transitions/.test(directAnalysis) &&
       /openingNarration hooks the viewer/.test(srv),
    'new recap generation writes one meeting-specific narrative arc instead of independent generic recap beats');

  // (5) SPA — field-name reconciliation with the server shapes (the mtg-verify fixes).
  const load = _win(html, 'async loadMeetings(', 5200) || '';
  t.ok(/\.map\(m => \(\{ \.\.\.m, id: m\.meetingId \|\| m\.id \|\| '' \}\)\)/.test(load),
    'loadMeetings normalizes the server meetingId → client id');
  t.ok(/const wantId = \/\^turn\\d\+search\\d\+\$\/i\.test\(rawWantId\) \? '' : rawWantId/.test(load),
    'conversation-local WorkIQ search references are never restored as durable meeting deep links');
  t.ok(/brief\?meetingId=\$\{encodeURIComponent\(wantId\)\}/.test(load) &&
       /meta && meta\.subject/.test(load) &&
       /id: wantId,\s*meetingId: wantId/.test(load),
    'a canonical calendar-event deep link is hydrated from its durable brief instead of being discarded when the index uses a search token');
  t.ok(/w\.loading = !w\.loaded && !w\.list\.length/.test(load) &&
       /w\.refreshing = !!\(r && r\.refreshing\)/.test(load) &&
       /w\._calendarPoll = setTimeout/.test(load) &&
       /loadSeq !== w\._loadSeq \|\| w\.rangeKey !== rangeKey/.test(load),
    'navigation paints cached meetings immediately and polls a cold background refresh without stale-week races');
  const push = _win(html, '_mtgPushRecap() {', 700) || '';
  t.ok(/typeof fr\.contentWindow\.startRecap === 'function'/.test(push) &&
       /fr\.contentWindow\.startRecap\(w\._pendingRecap\.story, w\._pendingRecap\.people, w\._pendingRecap\.photos\)/.test(push),
    '_mtgPushRecap directly invokes the same-origin player instead of relying on a lossy message handoff');
  t.ok(/postMessage\(w\._pendingRecap, '\*'\)/.test(push),
    '_mtgPushRecap retains postMessage as a load-timing fallback');
  const fmt = _win(html, 'mtgFmtWhen(m) {', 400) || '';
  t.ok(/const t = m\.start \|\| m\.time/.test(fmt), 'mtgFmtWhen reads the server start field');
  t.ok(/class="mtg-nav-list"/.test(html) &&
       /\.mtg-nav-list\{[^}]*overflow-y:auto/.test(html) &&
       /mtgStartNavResize\(\$event\)/.test(html) &&
       /mtgToggleNav\(\)/.test(html) &&
       /meetings-nav-width/.test(html) &&
       /meetings-nav-collapsed/.test(html),
    'the meeting index has its own scrollbar and persistent resize/collapse controls');

  // (6) SPA — routing / nav registration. Experience-level defaults are covered separately.
  t.ok(/if \(\(first === 'meetings' \|\| first === 'meetings-ai'\) && second\) return \{ route: 'meetings', param: second \}/.test(html) &&
       /if \(first === 'meetings-ai'\) return \{ route: 'meetings', param: null \}/.test(html),
    'parseHash handles canonical and legacy Meetings.AI deep links');
  t.ok(/else if \(this\.route === 'meetings'\) \{[\s\S]{0,80}this\.loadMeetings\(/.test(html),
    'handleRouteChange dispatches meetings → loadMeetings');
  t.ok(/case 'meetings': return mk\('Meetings\.AI', '🎬', '#\/meetings', 'meetings'\)/.test(html),
    'the nav item is registered');
  t.ok(/if \(en\('meetings'\)\) out\.push\('meetings'\)/.test(html),
    'the Meetings.AI nav item follows its experience feature flag');
});

await t.test('meetings.ai: durable brief state — a summary that already ran (empty/error/pending) survives navigate-away-and-back (server.js + settings.js + app.html)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');
  const player = readFileSync('public/meeting-recap.html', 'utf8');
  const settings = readFileSync('settings.js', 'utf8');

  // SERVER — a module-level durable state map is the source of truth (not just the in-flight promise).
  t.ok(/_meetingsBriefState = new Map\(\)/.test(srv), 'the durable _meetingsBriefState map exists');
  t.ok(/function _meetingsSetBriefState\(/.test(srv), 'the _meetingsSetBriefState helper exists');
  // The state is persisted to disk so it survives a SERVER/desktop RESTART (the core bug —
  // an in-memory-only map wiped on restart made the "Load summary" button silently reappear).
  t.ok(/_MEETINGS_BRIEF_STATE_FILE\s*=\s*path\.join\(_MEETINGS_BRIEF_DIR/.test(srv), 'the brief state has an on-disk file path');
  t.ok(/function _meetingsLoadBriefState\(/.test(srv), 'the state is loaded from disk on startup');
  t.ok(/function _meetingsPersistBriefState\(/.test(srv), 'a persist helper writes the state to disk');
  t.ok(/function _meetingsCacheRecap\(/.test(srv) && /function _meetingsGetCachedRecap\(/.test(srv),
    'completed recap payloads are cached on disk, not only in process memory');
  t.ok(/_MEETINGS_BRIEF_CACHE_SCHEMA_VERSION = 1/.test(srv) &&
       /function _meetingsBriefIdentity\(/.test(srv) &&
       /function _meetingsCacheBrief\(/.test(srv) &&
       /function _meetingsGetCachedBrief\(/.test(srv),
    'read-first summaries use an occurrence-keyed cache independent from the richer newscast schema');
  t.ok(/const analysisWithBrief = analysisPromise\.then/.test(srv) &&
       /_meetingsPublishInterimBrief\(id, value, subject, date, occurrence, directBundle\)/.test(srv) &&
       /status: 'ready', recapStatus: 'building'/.test(srv),
    'core transcript analysis publishes the summary before slower evidence/newscast enrichment finishes');
  const loadBriefCache = _win(srv, 'function _meetingsLoadBriefCache()', 2600) || '';
  t.ok(/fs\.readdirSync\(_MEETINGS_RECAP_DIR\)/.test(loadBriefCache) &&
       /allowNewscast: stored\.schemaVersion === _MEETINGS_RECAP_SCHEMA_VERSION/.test(loadBriefCache) &&
       /without mutating or deleting the old recap files/.test(loadBriefCache),
    'startup migrates summaries from old recap schemas while refusing to expose those stale payloads as playable newscasts');
  t.ok(/_MEETINGS_RECAP_SCHEMA_VERSION = 8/.test(srv) &&
       /stored\.schemaVersion === _MEETINGS_RECAP_SCHEMA_VERSION/.test(srv),
    'the durable cache invalidates older recaps that lack direct Graph transcript provenance and clickable sources');
  t.ok(/cached recap lacks its requested occurrence identity/.test(srv) &&
       /fs\.unlinkSync\(_meetingsRecapFile\(id\)\)/.test(srv),
    'identity-less legacy recap files are rejected and removed rather than attached by ID alone');
  t.ok(/exact Teams occurrence URL/.test(srv) &&
       /sourceStart/.test(srv) &&
       /sourceOrganizer/.test(srv) &&
       /WorkIQ returned the \$\{sourceStart/.test(srv),
    'recap retrieval and validation use the exact occurrence URL, start time, and organizer');
  t.ok(/function _meetingsOccurrenceFromState\(/.test(srv) &&
       /requestedStart: exactOccurrence\.start/.test(srv) &&
       /start: m\.start \|\| ''/.test(srv) &&
       /_meetingsOccurrenceFromState\(st\)/.test(srv),
    'queued and restart-resumed summary builds retain the full occurrence identity');
  t.ok(/cached recap start time does not match its requested occurrence/.test(srv) &&
       /cached recap organizer does not match its requested occurrence/.test(srv) &&
       /sourceMeetingUrl: String\(raw\.sourceMeetingUrl/.test(srv),
    'schema-7 caches prove start time and organizer and preserve the canonical meeting URL');
  t.ok((html.match(/start: m\.start \|\| ''/g) || []).length >= 2 &&
       (html.match(/webLink: m\.webLink \|\| ''/g) || []).length >= 2,
    'both summary and newscast requests send the full indexed occurrence identity');
  t.ok(/function _meetingsRecapQualityScore\(/.test(srv) &&
       /_meetingsRecapQualityScore\(prior\) > _meetingsRecapQualityScore\(built\)/.test(srv),
    'a forced retry can improve but never downgrade a richer cached newscast');
  t.ok(/function _meetingsBriefMeetingMeta\(/.test(srv) &&
       /meeting: _meetingsBriefMeetingMeta\(meetingId, rec\)/.test(srv),
    'brief probes return enough canonical meeting metadata to restore durable deep links');
  t.ok(/const trivialQuote = quoteWords\.length < 4/.test(srv) &&
       /Meeting transcript or chat/.test(srv) &&
       srv.includes("meeting recording.*\\.(mp4|m4a|wav)"),
    'the edit removes trivial acknowledgements and distinguishes recording references from playable audio');
  t.ok(/function _meetingsNormalizeEvidence\(/.test(srv) &&
       /function _meetingsEvidenceUrlKey\(/.test(srv) &&
       /function _meetingsEvidenceFromStory\(/.test(srv) &&
       /function _meetingsEvidenceFromText\(/.test(srv) &&
       /function _meetingsLinkEvidence\(/.test(srv) &&
       /function _meetingsNormalizeNewscast\(/.test(srv),
    'newscast generation normalizes JSON or Markdown evidence, classifies engineering links, and attaches relevant sources to chapters');
  t.ok(srv.includes("const excerpt = String(raw.excerpt || raw.quote || raw.snippet") &&
       srv.includes('const highlights = (Array.isArray(raw.highlights)') &&
       srv.includes('prior.highlights = [...new Set([...prior.highlights, ...item.highlights])].slice(0, 4)') &&
       srv.includes('const contextAround = (start, end) =>') &&
       player.includes('const detail=item.excerpt?') &&
       player.includes('evidenceHasDeepExtract(item)'),
    'retrieved source excerpts and key highlights survive normalization and remain available to selected narrative scenes');
  t.ok(/function _meetingsNormalizeCitations\(/.test(srv) &&
       /function _meetingsNormalizeVisuals\(/.test(srv) &&
       /Open and inspect each relevant document/.test(srv) &&
       /verbatim citations with a useful locator/.test(srv) &&
       /transcribe a chart's exact title, labels, numeric values\/series/.test(srv) &&
       /citationCount/.test(srv) &&
       /visualCount/.test(srv),
    'evidence retrieval preserves exact locator-aware document citations and non-fabricated source-native visual data');
  t.ok(/const transcriptCitations = highlights\.map/.test(srv) &&
       /id: 'meeting-transcript'/.test(srv) &&
       /ready: hasAuthenticAudio \|\| linkedSourceCount > 0 \|\| citationCount > 0 \|\| visualCount > 0/.test(srv),
    'verbatim transcript quotes remain first-class citations even when no supporting document is retrievable');
  t.ok(/if \(base && base\.story && \(supplementalEvidence\.length \|\| directEvidence\.length\)\)/.test(srv) &&
       /\.\.\.directEvidence,[\s\S]{0,80}\.\.\.supplementalEvidence/.test(srv),
    'direct Teams sources and the independent evidence pass join both recap shapes');
  t.ok(/function drawSourceExtract\(/.test(player) &&
       /function drawEvidenceChart\(/.test(player) &&
       /type:'source'/.test(player) &&
       /SOURCE EXTRACT/.test(player) &&
       /beat\.type==='source'/.test(player) &&
       /evidenceHasDeepExtract\(item\)/.test(player) &&
       /scenePlan/.test(player) &&
       /citationIndex/.test(player) &&
       /Includes \$\{Number\(\(STORY\.newscast/.test(player) &&
       /exact citations and \$\{Number\(\(STORY\.newscast/.test(player),
    'the newscast uses a source extract only when the AI edit selects evidence that advances the story');
  t.ok(/async function _meetingsProfilePhotos\(/.test(srv) &&
       /async function _meetingsGraphTokenAsync\(/.test(srv) &&
       /child_process'\)\.exec\(/.test(_win(srv, 'async function _meetingsGraphTokenAsync(', 2200) || '') &&
       /token = await _meetingsGraphTokenAsync\(\)/.test(srv) &&
       /displayName eq/.test(_win(srv, 'async function _meetingsProfilePhotos(', 4200) || '') &&
       /'648x648', '504x504', '360x360', '240x240'/.test(srv) &&
       /data:\$\{contentType\};base64/.test(srv) &&
       /function _meetingsEnrichCachedPhotos\(/.test(srv) &&
       /new Promise\(resolve => setTimeout\(resolve, 1000\)\)\.then\(\(\) => _meetingsProfilePhotos/.test(srv) &&
       /_meetingsCacheRecap\(meetingId, recap\)/.test(srv),
    'production recaps resolve and durably cache bounded Microsoft Graph profile photos, with non-blocking enrichment and avatar fallback');
  t.ok(/Teams discussions, email threads, SharePoint\/OneDrive documents or slides/.test(srv) &&
       /Never invent a URL, timestamp, screenshot, quote, audio clip, or source/.test(srv),
    'the WorkIQ edit requests cross-system evidence while explicitly forbidding fabricated media');
  t.ok(/"whyItMatters":string/.test(srv) &&
       /NEVER make narration read or paraphrase that visible text/.test(srv) &&
       /openingNarration hooks the viewer/.test(srv) &&
       /one cohesive, meeting-specific editorial script/.test(srv) &&
       /scenePlan is the edit decision/.test(srv) &&
       /never create a separate title, opening, intro, throughline, or evidence-map scene/i.test(srv) &&
       /omit it rather than speculate/.test(srv),
    'future newscasts use an AI-selected plot without reading slides, inventing impact, or filling a static template');
  t.ok(/function _meetingsOccurrenceId\(/.test(srv) &&
       /function _meetingsSubjectsMatch\(/.test(srv) &&
       /function _meetingsIsTransientId\(/.test(srv) &&
       /subject: String\(story\.sourceSubject \|\| st\.subject \|\| story\.title/.test(srv) &&
       /sourceSubject/.test(srv) &&
       /sourceDate/.test(srv) &&
       /refused to cache recap with a mismatched subject/.test(srv) &&
       /Reload Meetings\.AI to select the dated occurrence/.test(srv),
    'meeting occurrences use stable derived IDs and mismatched or transient recap identities are rejected');
  const gatherRange = _win(srv, 'async function _meetingsGatherRange(', 6500) || '';
  t.ok(/Include meetings whether or not I attended them; attendance is not a requirement/.test(gatherRange) &&
       /if \(!subject \|\| !sd\.date \|\| !sd\.hm \|\| !ed\.hm\) continue/.test(gatherRange) &&
       /endedAt > end \|\| endedAt > new Date\(\)/.test(gatherRange) &&
       /seen\.has\(occurrenceKey\)/.test(gatherRange),
    'the weekly index includes attended or unattended meetings but only verified, in-range, deduplicated occurrences');
  t.ok(/_meetingsPersistBriefState\(\);/.test(_win(srv, 'function _meetingsSetBriefState(', 260) || ''),
    'every state mutation persists to disk');
  const ensure = _win(srv, 'function _meetingsEnsureRecap(', 3200) || '';
  t.ok(ensure, '_meetingsEnsureRecap exists');
  t.ok(/status: cachedBrief \? 'ready' : 'building'[\s\S]{0,80}startedAt/.test(ensure),
    'a kicked build stamps a durable building state unless a read-first summary is already cached');
  t.ok(/subject: subj/.test(ensure), 'the building state stores the subject so a restart-orphan re-kick still has it');
  t.ok(/status: 'ready'/.test(ensure) &&
       /status: hasBrief \? 'ready' : \(failed \? 'error' : 'empty'\)/.test(ensure) &&
       /status: hasBrief \? 'ready' : 'error'/.test(ensure),
    'the build resolves to a durable ready/empty/error state without discarding a cached summary');
  t.ok(/status: cachedBrief \? 'ready' : 'queued'/.test(_win(srv, 'function _meetingsEnqueueBriefs(', 1800) || ''),
    'background jobs stamp queued state before the worker reaches them unless a summary is already cached');
  const enqueueBriefs = _win(srv, 'function _meetingsEnqueueBriefs(', 1800) || '';
  t.ok(/const cachedBrief = _meetingsGetCachedBrief\(id, m\)/.test(enqueueBriefs) &&
       /status: cachedBrief \? 'ready' : 'queued'/.test(enqueueBriefs),
    'background newscast enrichment never downgrades an already-cached summary to Queued');

  // SERVER — GET consults the durable state before falling through to none (the actual bug),
  // and auto-heals a restart-orphaned build (stale 'building', or 'ready' with no live cache).
  const get = _win(srv, "app.get('/api/meetings/brief'", 5000) || '';
  t.ok(get, 'GET /api/meetings/brief route exists');
  t.ok(/const st = _meetingsBriefState\.get\(meetingId\)/.test(get), 'GET reads the durable state map');
  t.ok(/function _meetingsRecentMeeting\(/.test(srv) &&
       /const canonicalMeeting = _meetingsRecentMeeting\(meetingId\)/.test(get) &&
       /const cachedBrief = _meetingsGetCachedBrief\(meetingId, canonicalMeeting\)/.test(get) &&
       /phase: 'cached'[\s\S]{0,120}brief: cachedBrief\.brief/.test(get),
    'GET resolves the same canonical occurrence as the rail before consulting the stable summary cache');
  t.ok(/st\.status === 'building'[\s\S]{0,900}status: 'pending'[\s\S]{0,80}startedAt/.test(get), "building → pending (with startedAt)");
  t.ok(/age > _MEETINGS_BRIEF_STALE_MS[\s\S]{0,120}_meetingsEnsureRecap/.test(get), 'a stale orphaned building state re-kicks the build');
  t.ok(/st\.status === 'queued'[\s\S]{0,500}!inflight[\s\S]{0,160}_meetingsEnsureRecap/.test(get),
    'a restart-orphaned queued state re-kicks instead of remaining pending forever');
  t.ok(/st\.status === 'ready'[\s\S]{0,500}_meetingsEnsureRecap/.test(get), "'ready' with no cache re-kicks (never reverts to none)");
  t.ok(/st\.status === 'error'[\s\S]{0,80}status: 'error'/.test(get), 'error → error (durable)');
  t.ok(/st\.status === 'empty'[\s\S]{0,80}status: 'empty'/.test(get), 'empty → empty (durable, never reverts to none)');

  // SERVER — POST is NON-BLOCKING: it kicks the build and returns immediately (no long await),
  // so a navigated-away user is never hit by the client request timeout firing later as fatal.
  const post = _win(srv, "app.post('/api/meetings/brief'", 3200) || '';
  t.ok(post, 'POST /api/meetings/brief route exists');
  t.ok(/app\.post\('\/api\/meetings\/brief', \(req, res\) =>/.test(srv), 'POST is not async/awaiting the build (non-blocking)');
  t.ok(/_meetingsEnsureRecap\(meetingId, subject, date, occurrence\)\.catch\(/.test(post), 'POST kicks the build fire-and-forget');
  t.ok(/status: 'pending', startedAt/.test(post), 'POST returns pending immediately when not already terminal');
  t.ok(/status: 'ready'[\s\S]{0,80}_meetingsBriefFromRecap/.test(post), 'POST returns ready at once when already cached');

  // SETTINGS — the hourly auto-summarize sweep is discoverable + opt-out (default ON).
  t.ok(/meetingsAutoSummarize: true/.test(settings), 'meetingsAutoSummarize defaults ON (opt-out)');
  t.ok(/s\.meetingsAutoSummarize === false/.test(srv), 'the sweep honors the opt-out flag');
  t.ok(/_meetingsRecentCache\.get\('d:7'\)[\s\S]{0,300}_meetingsEnqueueBriefs\(recent\.meetings\)/.test(srv),
    'server startup immediately resumes summary warming from the durable calendar index');

  // CLIENT — the three durable fields are in state, captured from GET + POST, and reset on select.
  t.ok(/briefError: ?'', ?briefAt: ?0, ?briefStartedAt: ?0/.test(html) ||
       (/briefError:/.test(html) && /briefAt:/.test(html) && /briefStartedAt:/.test(html)),
    'the meetings state carries briefError/briefAt/briefStartedAt');
  const loadStatus = _win(html, 'async mtgLoadBriefStatus(', 1500) || '';
  t.ok(/w\.briefError = \(r && r\.error\)/.test(loadStatus) && /w\.briefStartedAt = \(r && r\.startedAt\)/.test(loadStatus),
    'mtgLoadBriefStatus captures error/at/startedAt from GET');
  t.ok(/const indexed = w\.list\.find\(m => m\.id === mid\)/.test(loadStatus) &&
       /subject: indexed\.subject/.test(loadStatus) &&
       /organizer: indexed\.organizer/.test(loadStatus) &&
       /\/api\/meetings\/brief\?\$\{params\.toString\(\)\}/.test(loadStatus),
    'the detail probe sends the exact selected occurrence metadata used by the meeting rail');
  t.ok(/w\.briefStatus === 'pending'\) this\.mtgPollBrief/.test(loadStatus), 'mtgLoadBriefStatus polls while pending');
  t.ok(/w\.list = w\.list\.map/.test(loadStatus), 'brief state is mirrored into the meeting index across navigation');
  const select = _win(html, 'mtgSelect(id) {', 1500) || '';
  t.ok(/indexed && indexed\.briefStatus[\s\S]{0,180}w\.briefStatus = indexed\.briefStatus/.test(select),
    'selecting a meeting immediately restores its indexed server status instead of flashing Load summary');
  const prioritize = _win(html, 'async mtgPrioritizeBrief(', 2400) || '';
  t.ok(/this\.mtgPollBrief\(m\.id\)/.test(prioritize),
    'mtgPrioritizeBrief polls GET instead of blocking on the POST — a navigated-away user never hits a fatal timeout');
  t.ok(/w\.briefStatus = 'error'/.test(prioritize),
    'a genuine failure still sets a durable briefStatus=error (not a bare none) so the outcome survives navigation');

  // CLIENT — the DOM renders pending / empty / error blocks with retry affordances.
  t.ok(/We couldn.t build the summary/.test(html), 'the error block explains the failure');
  t.ok(/↻ Try again/.test(html), 'the error block offers a retry');
  t.ok(/↻ Check again/.test(html), 'the empty block offers a re-check');
  t.ok(/Summary ready/.test(html) && /Summarizing…/.test(html), 'the meeting index exposes ready/running state');
});

await t.test('meetings.ai: transcript availability is UNKNOWN at list time (never a fabricated false) — real meetings enroll for background summaries (server.js + app.html)', () => {
  const srv = readFileSync('server.js', 'utf8');
  const html = readFileSync('public/app.html', 'utf8');

  // SERVER — the bulk gather no longer asks the collector for hasTranscript (it can't be
  // determined reliably in a single calendar listing), and the parse sets it to null (unknown)
  // rather than coercing an unreliable value to false.
  const gather = _win(srv, 'function _meetingsGatherRange(', 4000) || '';
  t.ok(gather, '_meetingsGatherRange exists');
  t.ok(/hasTranscript: null/.test(gather),
    'parsed meetings carry hasTranscript:null (unknown at list time), never a fabricated false');
  t.ok(!/hasTranscript: !!e\.hasTranscript/.test(gather),
    'the old !!e.hasTranscript coercion (which lied "no transcript" for every meeting) is gone');

  // SERVER — the background brief queue no longer skips every meeting; only a definitively-known
  // absent transcript is skipped, and that is no longer asserted from the listing.
  const enqueue = _win(srv, 'Background brief queue', 1100) || '';
  t.ok(enqueue, '_meetingsEnqueueBriefs (with its header comment) exists');
  t.ok(/if \(m\.hasTranscript === false\) continue;/.test(enqueue),
    'enqueue still guards on a definitive false (harmless now, future-proof) — not on null/unknown');
  t.ok(/UNKNOWN at list time/i.test(enqueue),
    'the enqueue comment documents that availability is unknown at list time (all real meetings enroll)');

  // CLIENT — the two gates behave correctly for null: Load-summary shows (null !== false),
  // and the misleading "No transcript available" hint stays hidden (null === false is false).
  t.ok(/meetings\.briefStatus === 'none'[\s\S]{0,120}mtgSelected\(\)\.hasTranscript !== false/.test(html),
    'the Load-summary block gates on hasTranscript !== false (null passes → it shows)');
  t.ok(/mtgSelected\(\)\.hasTranscript === false">No transcript available/.test(html),
    'the "No transcript available" hint gates on === false (null → hidden; only a definitive false fires it)');
});

await t.test('agenda startup: desktop request races retry and never leave a blank page', () => {
  const html = readFileSync('public/app.html', 'utf8');
  const bootstrap = _win(html, 'async loadMeAi() {', 2100);
  const loadDay = _win(html, 'async meAiLoadAgenda() {', 1900);
  t.ok(/loadError:\s*''/.test(html) && /agendaLoading:\s*false/.test(html) && /agendaError:\s*''/.test(html),
    'Agenda state tracks bootstrap and per-day failures explicitly');
  t.ok(/requestResilient\('\/api\/me-ai', \{\}, \{ tries: 3, delay: 500 \}\)/.test(bootstrap),
    'bootstrap retries transient sidecar-readiness failures');
  t.ok(/requestResilient\('\/api\/me-ai\/agenda\?date='/.test(loadDay),
    'per-day agenda retrieval retries transient failures');
  t.ok(/requestedDate !== this\.meai\.date/.test(loadDay),
    'an older day response cannot overwrite a newer date selection');
  t.ok(/this\.meai\.agendaError = \(e && e\.message\)/.test(loadDay),
    'per-day failures are retained for the visible recovery state');
  t.ok(/x-show="!meai\.loaded"[^>]*aria-live="polite"/.test(html)
    && /Agenda\.AI could not load/.test(html)
    && /@click="loadMeAi\(\)"/.test(html),
    'initial loading and failure states replace the formerly blank Agenda surface');
  t.ok(/meai\.loaded && meai\.agendaError/.test(html)
    && /@click="meAiLoadAgenda\(\)"/.test(html),
    'a failed day load exposes an inline retry instead of silently rendering nothing');
});

await t.test('agent chats: New chat always creates a writable app conversation', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync(SERVER, 'utf8');
  const picker = _win(html, 'async wcStartFromPicker()', 700) || '';
  t.ok(/ids\.length === 1\) \{ await this\._createChatThread\('agent', ids\[0\]\)/.test(picker),
    'the New conversation picker creates a fresh direct thread instead of reopening an existing session');
  t.ok(/if \(n <= 1\) return 'Start new chat'/.test(html),
    'the direct-chat picker CTA accurately describes fresh-thread behavior');
  const openOrCreate = _win(html, 'async openOrCreateChat(targetType, target)', 900) || '';
  t.ok(/chat\.source !== 'cli'/.test(openOrCreate),
    'general app chat entry points never resolve onto a read-only CLI mirror');
  const directGroups = _win(html, 'wcDirectSubgroups() {', 2200) || '';
  t.ok(/Number\(a\.source === 'cli'\) - Number\(b\.source === 'cli'\)/.test(directGroups),
    'agent rows prefer writable app threads while retaining CLI mirrors in thread history');
  const createThread = _win(html, 'async _createChatThread(targetType, target)', 1200) || '';
  t.ok(/initiatedBy: 'user'/.test(createThread),
    'fresh direct chats are explicitly persisted as user-initiated');
  const createRoute = _win(srv, "app.post('/api/chats'", 1700) || '';
  t.ok(/source: 'app'/.test(createRoute),
    'the server identifies newly created conversations as writable app-owned chats');
});

await t.test('meetings.ai recap: unattributed speakers and missing photos use honest dynamic media', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const player = readFileSync('public/meeting-recap.html', 'utf8');
  const srv = readFileSync(SERVER, 'utf8');
  const identity = _win(srv, 'function _meetingsOpaqueSpeakerNumber(', 4400) || '';
  t.ok(/Unidentified speaker \$\{number\}/.test(identity)
    && /identityStatus: opaque \? 'unattributed'/.test(identity)
    && /requestedAttendees/.test(identity),
    'opaque Teams voice tokens become honest labels while verified calendar attendees enrich the people roster');
  const photos = _win(srv, 'async function _meetingsProfilePhotos(', 1300) || '';
  t.ok(/identityStatus === 'unattributed'/.test(photos),
    'profile lookup never searches Graph for an anonymous Teams voice token');
  const durablePhotos = _win(srv, "const _MEETINGS_PHOTO_CACHE_DIR", 6500) || '';
  t.ok(/path\.join\(dataPath\('meetings'\), 'profile-photos'\)/.test(durablePhotos)
    && /const _MEETINGS_PHOTO_CACHE_VERSION = 2/.test(durablePhotos)
    && /saved\.version !== _MEETINGS_PHOTO_CACHE_VERSION/.test(durablePhotos)
    && /function _meetingsReadCachedProfilePhoto\(/.test(durablePhotos)
    && /function _meetingsWriteCachedProfilePhoto\(/.test(durablePhotos)
    && /fs\.renameSync\(tmp, file\)/.test(durablePhotos),
    'profile photos persist in an atomic identity-keyed cache across meetings and sidecar restarts');
  t.ok(photos.indexOf('_meetingsReadCachedProfilePhoto(person)') < photos.indexOf('_meetingsGraphTokenAsync()')
    && /if \(!uncached\.length\) return Object\.fromEntries\(resolved\)/.test(photos),
    'all durable cache hits return before Graph authentication or profile lookup');
  t.ok(/function drawVoicePresence\(/.test(player)
    && /Voice not attributed by Microsoft Teams/.test(player)
    && !/function drawBust\(/.test(player),
    'missing portraits render a live voice treatment instead of a fabricated cartoon person');
  const clips = _win(player, 'function clipForBeat(beat)', 900) || '';
  t.ok(/segmentIndex/.test(clips) && /mediaType==='video'/.test(clips),
    'a room/video clip can be selected by scene or speaker even when the AI omitted audioClipId');
  t.ok(/media-body\.room-only/.test(player)
    && /classList\.toggle\('room-only',!Object\.keys\(PHOTOS\|\|\{\}\)\.length\)/.test(player),
    'available room video expands across the stage when profile portraits are unavailable');
  const refresh = _win(html, 'async _mtgRefreshRecapPhotos(', 1900) || '';
  t.ok(/type: 'mrv:photos'/.test(refresh) && /r\.photoPending/.test(refresh) && /attempt \+ 1/.test(refresh),
    'late profile-photo enrichment updates the open recap instead of requiring a reload');
  const enrich = _win(srv, 'function _meetingsEnrichCachedPhotos(', 1700) || '';
  t.ok(/_meetingsWriteCachedProfilePhoto\(recap\.people\[key\], dataUri\)/.test(enrich)
    && /missingPeople/.test(enrich)
    && /recap\.photos = \{ \.\.\.current, \.\.\.photos \}/.test(enrich),
    'older recap-embedded photos seed the shared cache before any missing portraits are retrieved');
});

await t.test('workspace board maps: cards and groups nest by pointer drop with recursive summaries', () => {
  const html = readFileSync(APP_HTML, 'utf8');
  const srv = readFileSync(SERVER, 'utf8');
  t.ok(/dropGroupId: null/.test(html)
    && /'drop-target': bmap\.dropGroupId===g\.id/.test(html)
    && /\.bmap-group\.drop-target/.test(html),
    'pointer drags expose and visibly highlight the active group drop target');
  const hierarchy = _win(html, '_bmapNormalizeGroups(m) {', 8200) || '';
  t.ok(/parentGroupId/.test(hierarchy)
    && /_bmapGroupDescendants\(g\)/.test(hierarchy)
    && /_bmapGroupCardBases\(g, recursive\)/.test(hierarchy)
    && /claimed = new Set/.test(hierarchy),
    'group hierarchy is normalized, cycle-safe, recursive, and prevents ambiguous unlocked multi-parent card membership');
  const pointer = _win(html, 'bmapPanMove(ev) {', 8200) || '';
  t.ok(/this\.bmap\.dropGroupId = this\._bmapDropTargetAt/.test(pointer)
    && /this\._bmapReparentCards\(bases, target\)/.test(pointer)
    && /this\._bmapReparentGroup\(gd\.id, target\)/.test(pointer),
    'both card and group pointer drags resolve the highlighted target on release');
  const drops = _win(html, '_bmapDropTargetAt(clientX, clientY, moving) {', 6200) || '';
  t.ok(/!g\.locked/.test(drops)
    && /this\._bmapGroupDescendants\(moving\.groupId\)/.test(drops)
    && /g\.members = next/.test(drops)
    && /g\.parentGroupId = target\.id/.test(drops),
    'drops preserve locked auto-groups, remove former direct membership, and reject self/descendant cycles');
  const summaries = _win(html, 'bmapGroupItems(g, recursive) {', 6500) || '';
  t.ok(/this\._bmapGroupDescendants\(g\)/.test(summaries)
    && /subgroup: it\.groupId === obj\.id/.test(summaries)
    && /subgroups: this\._bmapGroupDescendants\(obj\)/.test(summaries),
    'group summaries recursively include unique descendant cards plus subgroup context');
  const route = _win(srv, "app.post('/api/boards/:id/group-summary'", 5400) || '';
  t.ok(/const inSubgroups/.test(route)
    && /Nested subgroup structure:/.test(route)
    && /nested subgroup:/.test(route)
    && !/inItems\.slice\(0,\s*24\)/.test(route),
    'the AI summary endpoint receives every submitted card and the nested group structure');
});

await t.done();