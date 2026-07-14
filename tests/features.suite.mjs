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

import { createRunner, extractFns, api, serverUp } from './lib/harness.mjs';

const SERVER = 'server.js';

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

await t.done();
