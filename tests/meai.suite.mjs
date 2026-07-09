// Me.AI unit + integration suite.
//
// UNIT: extracts the REAL shipped server.js helper bodies into a vm sandbox
// (extractFns / sliceSource) and exercises them directly — a pass proves the
// production code, not a copy. Covers the pieces the owner's "rock solid" ask
// leans on hardest: the agenda-change validation gate (part a), the triage
// permission gate + topic memory (part b), the pursuit merge reducer, and the
// small deterministic identity/parsing helpers.
//
// INTEGRATION: a few read-only /api/me-ai/* probes that SKIP (not fail) when the
// dev server on :3847 is down, so `npm test` yields a meaningful unit-only pass
// offline.

import { createRunner, extractFns, sliceSource, api, serverUp } from './lib/harness.mjs';

const SERVER = 'server.js';
const t = createRunner('meai');

// cheap agenda block builder (mirrors the agenda-validate scratch test)
const blk = (start, end, type, title, link) => ({ start, end, type, title, detail: '', link, meta: {}, urgency: 3 });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Time helpers — the arithmetic backbone every scheduler call sits on.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _hmToMin, _minToHm } = extractFns(SERVER, ['_hmToMin', '_minToHm']);
  await t.test('_hmToMin parses HH:MM', () => {
    t.eq(_hmToMin('08:00'), 480);
    t.eq(_hmToMin('00:00'), 0);
    t.eq(_hmToMin('13:30'), 810);
  });
  await t.test('_minToHm is the inverse', () => {
    t.eq(_minToHm(480), '08:00');
    t.eq(_minToHm(810), '13:30');
    t.eq(_minToHm(0), '00:00');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Agenda-change validation gate (part a). Ported from the 21/21 scratch test.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiValidateAgendaChange, _meAiMaxWorkStretch } = extractFns(SERVER, [
    '_hmToMin', '_meAiScheduleMap', '_meAiDiffAgenda', '_meAiMaxWorkStretch', '_meAiValidateAgendaChange',
  ]);
  const cfg = { workStart: '08:00', workEnd: '17:00' };
  const noonish = 12 * 60;

  await t.test('gate: non-auto causes are never policed', () => {
    for (const cause of ['manual', 'mode', 'timeprefs', 'triage', 'todo', 'hours']) {
      const v = _meAiValidateAgendaChange(
        { blocks: [blk('09:00', '11:00', 'focus', 'Deep work')] }, { blocks: [] },
        { cause, nowMin: noonish, cfg });
      t.eq(v.policed, false, `${cause} should pass through`);
      t.eq(v.ok, true);
    }
  });

  await t.test('gate: no prior / no next build → not policed', () => {
    t.eq(_meAiValidateAgendaChange(null, { blocks: [blk('09:00', '10:00', 'focus', 'x')] }, { cause: 'auto', nowMin: noonish, cfg }).policed, false);
    t.eq(_meAiValidateAgendaChange({ blocks: [blk('09:00', '10:00', 'focus', 'x')] }, null, { cause: 'auto', nowMin: noonish, cfg }).policed, false);
  });

  await t.test('_meAiMaxWorkStretch measures the longest focus run', () => {
    t.eq(_meAiMaxWorkStretch([blk('09:00', '11:00', 'focus', 'a')]), 120);
    t.eq(_meAiMaxWorkStretch([blk('09:00', '10:00', 'focus', 'a'), blk('10:00', '11:30', 'review', 'b')]), 150, 'adjacent focus+review chain');
    t.eq(_meAiMaxWorkStretch([blk('09:00', '10:00', 'focus', 'a'), blk('10:00', '10:30', 'meeting', 'm'), blk('10:30', '11:00', 'focus', 'b')]), 60, 'meeting breaks the stretch');
    t.eq(_meAiMaxWorkStretch([blk('12:00', '13:00', 'lunch', 'L'), blk('13:00', '14:00', 'open', 'O')]), 0, 'lunch/open excluded');
  });

  await t.test('gate R2: shattering a protected focus block is vetoed', () => {
    const prev = { blocks: [blk('13:00', '16:00', 'focus', 'Protected deep work')] };
    const next = { blocks: [
      blk('13:00', '13:30', 'focus', 'Deep work'),
      blk('13:30', '14:00', 'meeting', 'Sync'),
      blk('14:00', '14:30', 'focus', 'Deep work'),
      blk('14:30', '15:00', 'comms', 'Replies'),
      blk('15:00', '15:30', 'focus', 'Deep work'),
    ] };
    const v = _meAiValidateAgendaChange(prev, next, { cause: 'auto', nowMin: 11 * 60, cfg });
    t.eq(v.policed, true);
    t.eq(v.ok, false, 'fragmentation vetoed');
    t.ok(v.violations.some((x) => x.rule === 'fragmentation'), 'fragmentation violation present');
  });

  await t.test('gate R1: many late-day moves exceed the churn budget', () => {
    const prev = { blocks: Array.from({ length: 10 }, (_, i) =>
      blk(String(14 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00'),
          String(14 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '59' : '29'),
          'review', 'PR ' + i, 'pr://' + i)) };
    const next = { blocks: prev.blocks.map((b) => ({ ...b, start: b.start.replace(/(\d\d)$/, (m) => String((+m + 1) % 60).padStart(2, '0')) })) };
    const v = _meAiValidateAgendaChange(prev, next, { cause: 'auto', nowMin: 16 * 60, cfg });
    t.eq(v.policed, true);
    t.lte(v.budget, 3, 'late-day budget is small');
    if (v.moves > v.budget) t.eq(v.ok, false, 'vetoed when moves exceed budget');
  });

  await t.test('gate: a benign single add passes', () => {
    const prev = { blocks: [blk('09:00', '11:00', 'focus', 'Deep work'), blk('11:00', '12:00', 'review', 'PR a', 'pr://a')] };
    const next = { blocks: [...prev.blocks, blk('15:00', '15:30', 'comms', 'New reply', 'mail://z')] };
    const v = _meAiValidateAgendaChange(prev, next, { cause: 'auto', nowMin: 11 * 60, cfg });
    t.eq(v.policed, true);
    t.eq(v.ok, true);
  });

  await t.test('gate: past/imminent moves are ignored (freeze layer owns them)', () => {
    const prev = { blocks: [blk('09:00', '10:00', 'review', 'PR a', 'pr://a')] };
    const next = { blocks: [blk('09:30', '10:30', 'review', 'PR a', 'pr://a')] };
    const v = _meAiValidateAgendaChange(prev, next, { cause: 'auto', nowMin: 14 * 60, cfg });
    t.eq(v.moves, 0, 'the past move is not counted');
    t.eq(v.ok, true);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pursuit merge reducer. Ported from the 15/15 scratch test.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiMergeInto } = extractFns(SERVER, [
    '_meAiSubjectSlug', '_meAiNormStance', '_meAiStanceOpposed', '_meAiMergeInto',
  ]);
  const oppo = (a, b) => (a === 'affirm' && b === 'deny') || (a === 'deny' && b === 'affirm');

  await t.test('merge: distinct subjects append, no conflicts', () => {
    const rs = { constraints: [], answers: [], findings: [], openConflicts: [] };
    const r = _meAiMergeInto(rs, { legId: 'L1', findings: [
      { subject: 'CI is green', stance: 'affirm', claim: 'CI passes on main', confidence: 'high' },
      { subject: 'Reviewer approved', stance: 'affirm', claim: 'One approval present', confidence: 'medium' },
    ] });
    t.eq(r.rootState.findings.length, 2);
    t.eq(r.events.filter((e) => e.patch && e.patch.finding).length, 2);
    t.eq(r.rootState.openConflicts.length, 0);
  });

  await t.test('merge: same subject + same stance dedups + unions sources, no patch', () => {
    let r = _meAiMergeInto({ constraints: [], answers: [], findings: [], openConflicts: [] },
      { legId: 'L1', findings: [{ subject: 'CI is green', stance: 'affirm', claim: 'CI passes', confidence: 'high' }] });
    r = _meAiMergeInto(r.rootState, { legId: 'L2', findings: [{ subject: 'CI is green', stance: 'affirm', claim: 'CI passes (all 12 jobs)', confidence: 'high' }] });
    const ci = r.rootState.findings.find((f) => f.subject === 'ci-is-green');
    t.eq(r.rootState.findings.length, 1);
    t.ok(ci && ci.sources.includes('L1') && ci.sources.includes('L2'), 'sources unioned');
    t.eq(r.events.filter((e) => e.patch && e.patch.finding).length, 0, 'agreement emits no finding patch');
  });

  await t.test('merge: lower-confidence claim never overwrites the higher one', () => {
    let r = _meAiMergeInto({ constraints: [], answers: [], findings: [], openConflicts: [] },
      { legId: 'L1', findings: [{ subject: 'CI is green', stance: 'affirm', claim: 'CI passes', confidence: 'high' }] });
    r = _meAiMergeInto(r.rootState, { legId: 'L3', findings: [{ subject: 'CI is green', stance: 'affirm', claim: 'stale', confidence: 0.1 }] });
    const ci = r.rootState.findings.find((f) => f.subject === 'ci-is-green');
    t.ne(ci.claim, 'stale');
    t.eq(ci.confidence, 0.9, 'kept high→0.9');
  });

  await t.test('merge: opposite stance keeps BOTH + raises one open conflict', () => {
    let r = _meAiMergeInto({ constraints: [], answers: [], findings: [], openConflicts: [] },
      { legId: 'L1', findings: [{ subject: 'CI is green', stance: 'affirm', claim: 'CI passes', confidence: 'high' }] });
    r = _meAiMergeInto(r.rootState, { legId: 'L4', findings: [{ subject: 'CI is green', stance: 'deny', claim: 'CI is failing', confidence: 'high' }] });
    t.eq(r.rootState.findings.length, 2, 'both sides kept');
    t.eq(r.rootState.openConflicts.length, 1);
    const cf = r.rootState.openConflicts[0];
    t.eq(cf.subject, 'ci-is-green');
    t.eq(cf.status, 'open');
    t.ok(oppo(cf.a.stance, cf.b.stance), 'sides are opposed');
    t.ok(r.events.every((e) => e.kind === 'rootstate'), 'reducer emits only rootstate events');
  });

  await t.test('merge: same-leg opposite stance is NOT a conflict', () => {
    let r = _meAiMergeInto({ constraints: [], answers: [], findings: [], openConflicts: [] },
      { legId: 'LX', findings: [{ subject: 'flaky', stance: 'affirm', claim: 'yes', confidence: 'high' }] });
    r = _meAiMergeInto(r.rootState, { legId: 'LX', findings: [{ subject: 'flaky', stance: 'deny', claim: 'no', confidence: 'high' }] });
    t.eq(r.rootState.openConflicts.length, 0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SDK permission gate (part b). The structural block that stops a background
//    me-agent from posting/pushing/sending without approval. Prelude injects the
//    two real module-level regex consts the classifier reads.
// ─────────────────────────────────────────────────────────────────────────────
{
  const prelude = sliceSource(SERVER, 'const _MEAI_EXT_SHELL_RE = new RegExp(', 'const _MEAI_EXT_TOOLS =');
  const { _meAiClassifyPermission } = extractFns(SERVER, ['_meAiClassifyPermission'], { prelude });
  const g = (req) => _meAiClassifyPermission(req).gate;

  await t.test('gate allows read-only investigation', () => {
    t.eq(g({ kind: 'read', path: '/x' }), false);
    t.eq(g({ kind: 'memory' }), false);
    t.eq(g({ kind: 'url', url: 'https://api.github.com/x' }), false, 'web fetch/research GET');
    t.eq(g({ kind: 'write', fileName: 'scratch/notes.md' }), false, 'local FS write');
    t.eq(g({ kind: 'mcp', serverName: 'azdo', toolName: 'get_pull_request_details', readOnly: true }), false);
  });

  await t.test('gate blocks external MCP mutations', () => {
    t.eq(g({ kind: 'mcp', serverName: 'azdo', toolName: 'add_pull_request_comment', readOnly: false }), true);
    t.eq(g({ kind: 'mcp', serverName: 'workiq', toolName: 'do_action', readOnly: false }), true);
  });

  await t.test('gate allows read-only shells, blocks publish/destructive', () => {
    // allowed:
    t.eq(g({ kind: 'shell', fullCommandText: 'gh pr view 123 --json state', commands: [{ identifier: 'gh', readOnly: true }] }), false);
    t.eq(g({ kind: 'shell', fullCommandText: 'git status', commands: [{ identifier: 'git', readOnly: true }] }), false);
    t.eq(g({ kind: 'shell', fullCommandText: 'git add -A && git commit -m wip', commands: [{ identifier: 'git', readOnly: false }] }), false, 'local commit is fine');
    t.eq(g({ kind: 'shell', fullCommandText: 'curl -s https://api.github.com/x', commands: [{ identifier: 'curl', readOnly: true }] }), false, 'curl GET');
    // gated:
    t.eq(g({ kind: 'shell', fullCommandText: 'gh pr comment 123 --body "lgtm"', commands: [{ identifier: 'gh', readOnly: false }] }), true);
    t.eq(g({ kind: 'shell', fullCommandText: 'gh pr merge 123 --squash', commands: [{ identifier: 'gh', readOnly: false }] }), true);
    t.eq(g({ kind: 'shell', fullCommandText: 'git push origin HEAD', commands: [{ identifier: 'git', readOnly: false }] }), true);
    t.eq(g({ kind: 'shell', fullCommandText: 'git push --force', commands: [{ identifier: 'git', readOnly: false }] }), true);
    t.eq(g({ kind: 'shell', fullCommandText: 'npm publish', commands: [{ identifier: 'npm', readOnly: false }] }), true);
    t.eq(g({ kind: 'shell', fullCommandText: 'curl -X POST https://hooks.x/y -d @body.json', commands: [{ identifier: 'curl', readOnly: false }] }), true, 'curl POST');
  });

  await t.test('gate tokenizes snake/camel custom tool names (the boundary bug)', () => {
    t.eq(g({ kind: 'custom-tool', toolName: 'get_file_contents' }), false);
    t.eq(g({ kind: 'custom-tool', toolName: 'list_pull_requests' }), false);
    t.eq(g({ kind: 'custom-tool', toolName: 'create_pull_request' }), true, 'snake_case write must gate');
    t.eq(g({ kind: 'custom-tool', toolName: 'createPullRequest' }), true, 'camelCase write must gate');
    t.eq(g({ kind: 'custom-tool', toolName: 'send_mail' }), true);
  });

  await t.test('gate defaults unknown/powerful kinds to blocked', () => {
    t.eq(g({ kind: 'hook' }), true);
    t.eq(g({ kind: 'extension-management' }), true);
    t.eq(g({ kind: 'weird-new-kind' }), true, 'unknown kind → safe gate');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Triage topic memory (part b). The durable fuzzy fingerprint that stops a
//    dismissed topic from re-surfacing under a slightly different subject.
// ─────────────────────────────────────────────────────────────────────────────
{
  const prelude = [
    sliceSource(SERVER, 'const ME_AI_TRIAGE_STOP = new Set(', 'const ME_AI_TRIAGE_STOP = new Set('),
    sliceSource(SERVER, 'const ME_AI_TOPIC_SUPPRESS = new Set(', 'const ME_AI_TOPIC_MATCH_MIN_X'),
  ].join('\n');
  const { _meAiTitleTokens, _meAiTopicAction, _meAiTopicMatch } = extractFns(
    SERVER, ['_meAiTitleTokens', '_meAiTopicAction', '_meAiTopicMatch'], { prelude });

  await t.test('title tokens drop stopwords/numbers/urls', () => {
    const toks = _meAiTitleTokens('Please review the agent catalog marketplace #1234');
    t.ok(toks.includes('agent'), 'kept distinctive token');
    t.ok(toks.includes('catalog'), 'kept distinctive token');
    t.notOk(toks.includes('the'), 'dropped stopword "the"');
    t.notOk(toks.includes('please'), 'dropped stopword "please"');
    t.notOk(toks.includes('1234'), 'dropped the digit run');
  });

  await t.test('topic action canonicalizes suppressive verbs only', () => {
    t.eq(_meAiTopicAction('dismissed'), 'dismiss');
    t.eq(_meAiTopicAction('dismiss'), 'dismiss');
    t.eq(_meAiTopicAction('wontfix'), 'wontfix');
    t.eq(_meAiTopicAction('later'), '', 'park is not suppressive');
    t.eq(_meAiTopicAction('today'), '', 'agenda-fit is not suppressive');
  });

  await t.test('topic match: same-channel variant re-hits a remembered topic', () => {
    const store = { topics: [{
      id: 'tm:test', action: 'dismiss',
      tokens: ['agent', 'catalog', 'marketplace', 'skills'],
      sources: ['m365', 'teams'], kinds: ['teams', 'email'],
    }] };
    const hit = _meAiTopicMatch({ title: 'New agent catalog marketplace update', source: 'teams', kind: 'teams' }, store);
    t.ok(hit && hit.topic.id === 'tm:test', 'a same-topic variant matches');
    const miss = _meAiTopicMatch({ title: 'Quarterly finance planning offsite', source: 'teams', kind: 'teams' }, store);
    t.eq(miss, null, 'an unrelated subject does not match');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Deterministic identity + parsing helpers (dedupe / cache keys).
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiInboxId, _meAiSignalFingerprint, _meAiParseWorkItem, _meAiDevKey, _meAiJaccard } = extractFns(
    SERVER, ['_meAiInboxId', '_meAiSignalFingerprint', '_meAiParseWorkItem', '_meAiDevKey', '_meAiJaccard']);

  await t.test('inbox id is stable + case-insensitive on the basis', () => {
    const a = _meAiInboxId({ link: 'https://X/PR/1' });
    const b = _meAiInboxId({ link: 'https://x/pr/1' });
    t.eq(a, b, 'lowercased basis → same id');
    t.eq(a.length, 16);
    t.ne(a, _meAiInboxId({ link: 'https://x/pr/2' }));
  });

  await t.test('signal fingerprint is order-independent + urgency-sensitive', () => {
    const s1 = _meAiSignalFingerprint([{ link: 'a', urgency: 3 }, { link: 'b', urgency: 4 }]);
    const s2 = _meAiSignalFingerprint([{ link: 'b', urgency: 4 }, { link: 'a', urgency: 3 }]);
    t.eq(s1, s2, 'sorted → order independent');
    const s3 = _meAiSignalFingerprint([{ link: 'a', urgency: 5 }, { link: 'b', urgency: 4 }]);
    t.ne(s1, s3, 'urgency change flips the fingerprint');
  });

  await t.test('work-item link parsing (azdo + github)', () => {
    const az = _meAiParseWorkItem('https://dev.azure.com/dnceng/internal/_workitems/edit/9674');
    t.eq(az.provider, 'azdo');
    t.eq(az.org, 'dnceng');
    t.eq(az.workItemId, '9674');
    const gh = _meAiParseWorkItem('https://github.com/dotnet/arcade/issues/42');
    t.eq(gh.provider, 'github');
    t.eq(gh.repo, 'arcade');
    t.eq(gh.workItemId, '42');
    t.eq(_meAiParseWorkItem('https://example.com/nope'), null);
  });

  await t.test('dev key collapses the same work item to one identity', () => {
    t.eq(_meAiDevKey('azdo', 'dnceng', 'internal', '9674'), _meAiDevKey('AzDO', 'DncEng', 'Internal', '9674'), 'case-insensitive');
    t.ne(_meAiDevKey('azdo', 'dnceng', 'internal', '9674'), _meAiDevKey('azdo', 'dnceng', 'internal', '9675'));
  });

  await t.test('jaccard overlap', () => {
    t.eq(_meAiJaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    t.eq(_meAiJaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
    t.eq(_meAiJaccard(new Set(), new Set(['a'])), 0, 'empty guard');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. INTEGRATION — live /api/me-ai/* probes. SKIP the rest when server is down.
// ─────────────────────────────────────────────────────────────────────────────
if (!(await serverUp())) {
  t.skipAll('dev server not running on :3847 (unit tests above still ran)');
}

await t.test('GET /api/me-ai returns a config', async () => {
  const r = await api('/api/me-ai');
  t.eq(r.ok, true, `status ${r.status}`);
  t.ok(r.json && typeof r.json === 'object', 'json body');
});

await t.test('GET /api/me-ai/agenda?date= responds (may be empty)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await api(`/api/me-ai/agenda?date=${today}`);
  t.ok(r.status > 0 && r.status < 500, `status ${r.status}`);
});

await t.done();
