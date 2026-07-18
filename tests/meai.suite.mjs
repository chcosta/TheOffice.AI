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
import { readFileSync } from 'node:fs';

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
// 2b. Pin enforcement winEnd cap — a flexible block shoved past the work window
//     is DROPPED (spills to backlog), never cascaded into the evening. This is the
//     during-hours guard against the "fragmented evening mess" the owner reported.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiEnforcePins, _hmToMin } = extractFns(SERVER, ['_hmToMin', '_minToHm', '_meAiEnforcePins']);
  const M = (h, m) => h * 60 + (m || 0); // pins carry start/end as MINUTES
  const pin = (sMin, eMin, title) => ({ start: sMin, end: eMin, title, meta: {} });

  await t.test('cap: a flexible block pushed past workEnd is dropped, not evening-cascaded', () => {
    const blocks = [blk('16:00', '17:00', 'meeting', 'Locked sync'), blk('16:30', '17:30', 'focus', 'Deep work')];
    const pins = [pin(M(16), M(17), 'Locked sync')];
    const out = _meAiEnforcePins(blocks, pins, M(17)); // winEnd = 17:00
    t.eq(out.some((b) => b.title === 'Deep work'), false, 'the shoved focus block is dropped');
    t.eq(out.every((b) => (_hmToMin(b.end) <= M(17)) || b.meta.pinned), true, 'nothing flexible lands past workEnd');
  });

  await t.test('cap: without a winEnd the block still cascades (evening) — proves the cap is what fixes it', () => {
    const blocks = [blk('16:00', '17:00', 'meeting', 'Locked sync'), blk('16:30', '17:30', 'focus', 'Deep work')];
    const pins = [pin(M(16), M(17), 'Locked sync')];
    const out = _meAiEnforcePins(blocks, pins); // no cap
    const dw = out.find((b) => b.title === 'Deep work');
    t.ok(dw, 'block survives');
    t.eq(dw.start, '17:00', 'cascaded into the evening (the bug the cap prevents)');
  });

  await t.test('cap: a normal in-window reflow is untouched', () => {
    const blocks = [blk('09:00', '10:00', 'meeting', 'Standup'), blk('09:30', '10:30', 'focus', 'Deep work')];
    const pins = [pin(M(9), M(10), 'Standup')];
    const out = _meAiEnforcePins(blocks, pins, M(17));
    const dw = out.find((b) => b.title === 'Deep work');
    t.ok(dw, 'block survives (well within the window)');
    t.eq(dw.start, '10:00', 'reflowed just after the pin');
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
  // Prelude must carry every module-level regex the extracted fns reference:
  // _MEAI_EXT_SHELL_RE/_TOOLS *and* the interpreter-write regexes, since
  // _meAiClassifyPermission now delegates to _meAiInterpreterWrite.
  const prelude = sliceSource(SERVER, 'const _MEAI_EXT_SHELL_RE = new RegExp(', '// True when a shell command invokes an interpreter');
  const { _meAiClassifyPermission } = extractFns(SERVER, ['_meAiInterpreterWrite', '_meAiClassifyPermission'], { prelude, sandbox: { process } });
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
// 5c. AI-cluster decision reuse. A persisted "Group similar" cluster with a
//     resolved representative lets a new clustered arrival inherit that decision
//     without a fresh model call.
// ─────────────────────────────────────────────────────────────────────────────
{
  const prelude = [
    "const ME_AI_RESOLVED_TRIAGE = new Set(['later','today','now','dismissed','wontfix','done']);",
    sliceSource(SERVER, 'const ME_AI_TRIAGE_STOP = new Set(', 'const ME_AI_TRIAGE_STOP = new Set('),
  ].join('\n');
  const { _meAiAiClusterMatch } = extractFns(
    SERVER, ['_meAiAiClusterMatch', '_meAiTitleTokens'], { prelude });

  const store = { clusters: [{
    key: 'grp:1',
    ids: ['a', 'b'],
    tokens: ['missy', 'review', 'request', 'feedback'],
    channels: ['m365/email'],
    label: 'Missy review requests',
  }] };
  const resolved = { id: 'a', title: 'Review request from Missy', source: 'm365', kind: 'email', triage: 'dismissed', triagedAt: '2026-07-06T09:00:00Z' };
  const other = { id: 'b', title: 'Missy feedback request', source: 'm365', kind: 'email', triage: 'new' };

  await t.test('clustered arrival folds onto a resolved cluster representative', () => {
    const arrival = { id: 'c', title: 'Another Missy review feedback request', source: 'm365', kind: 'email', triage: 'new' };
    const m = _meAiAiClusterMatch(arrival, store, [resolved, other, arrival], 72);
    t.ok(m && m.item, 'matched the cluster');
    t.eq(m.item.id, 'a', 'folded onto the resolved representative');
    t.eq(m.why, 'aicluster');
  });

  await t.test('no match when the cluster has no resolved representative', () => {
    const openStore = { clusters: [{ key: 'g', ids: ['b'], tokens: ['missy', 'review', 'request', 'feedback'], channels: ['m365/email'], label: 'x' }] };
    const arrival = { id: 'c', title: 'Another Missy review feedback request', source: 'm365', kind: 'email', triage: 'new' };
    const m = _meAiAiClusterMatch(arrival, openStore, [other, arrival], 72);
    t.eq(m, null, 'un-decided cluster does not absorb');
  });

  await t.test('unrelated arrival does not drift onto a cluster', () => {
    const arrival = { id: 'c', title: 'Quarterly finance planning offsite', source: 'm365', kind: 'email', triage: 'new' };
    const m = _meAiAiClusterMatch(arrival, store, [resolved, other, arrival], 72);
    t.eq(m, null, 'disjoint vocabulary → no fold');
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
// 6b. GOALS CHURN — compound-split + fuzzy signature (audit-record fidelity).
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiGoalSig, _meAiSplitGoalTitle, _meAiSplitStoredGoals } = extractFns(SERVER, [
    '_meAiGoalSig', '_meAiSplitGoalTitle', '_meAiSplitStoredGoals',
  ]);

  await t.test('split: compound aggregate breaks into constituent goals', () => {
    t.eq(_meAiSplitGoalTitle('Note team OOFs & regenerate expired PAT').length, 2);
    t.eq(_meAiSplitGoalTitle('Review PRs: !61251 & !60668 & !59004').length, 3);
    // Prefix is carried onto each part.
    t.ok(_meAiSplitGoalTitle('Review PRs: !61251 & !60668').every(p => p.startsWith('Review PRs:')), 'prefix carried');
  });

  await t.test('split: ordinary prose titles are never butchered', () => {
    t.eq(_meAiSplitGoalTitle('Prep for self epic review').length, 1, 'no separators');
    t.eq(_meAiSplitGoalTitle('Reply to Drew').length, 1);
    // A short "a and b" that is not two discrete items stays whole (tokenish gate).
    t.eq(_meAiSplitGoalTitle('cats and dogs').length, 1, 'short non-item parts stay whole');
  });

  await t.test('goal signature is prefix- + token-insensitive', () => {
    t.eq(_meAiGoalSig('Follow-up: regenerate PAT'), _meAiGoalSig('regenerate PAT'), 'prefix stripped');
    t.eq(_meAiGoalSig('Review PR !61251'), _meAiGoalSig('Review !61251'), 'pr token stripped');
    t.ne(_meAiGoalSig('regenerate PAT'), _meAiGoalSig('rotate secret'));
  });

  await t.test('split stored: open checklist aggregates split, disposed rows untouched', () => {
    const open = { title: 'Note OOFs & regenerate PAT', kind: 'checklist', done: false, status: 'open' };
    const done = { title: 'Note OOFs & regenerate PAT', kind: 'checklist', done: true, status: 'open' };
    const outOpen = _meAiSplitStoredGoals([open]);
    t.eq(outOpen.length, 2, 'open aggregate split');
    const outDone = _meAiSplitStoredGoals([done]);
    t.eq(outDone.length, 1, 'done aggregate left whole');
    t.eq(outDone[0].title, 'Note OOFs & regenerate PAT', 'done title preserved verbatim');
  });

  await t.test('split stored: single live entity stays whole', () => {
    const pr = { title: 'Review PR !61251', kind: 'checklist', done: false, status: 'open', live: true, link: 'https://x/pr/1' };
    const out = _meAiSplitStoredGoals([pr]);
    t.eq(out.length, 1, 'single entity not split');
  });

  await t.test('split stored: idempotent (re-running yields the same set)', () => {
    const rows = [{ title: 'Note OOFs & regenerate PAT', kind: 'checklist', done: false, status: 'open' }];
    const once = _meAiSplitStoredGoals(rows);
    const twice = _meAiSplitStoredGoals(once);
    t.eq(twice.length, once.length, 'no further growth on second pass');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6c. GOALS ENTITY DEDUP — one work item surfaced under 3 labels collapses to one.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiGoalEntKey, _meAiDedupStoredGoals } = extractFns(SERVER, [
    // Order matters — dependencies (_meAiParseWorkItem/_meAiDevKey) must be defined
    // before the functions that call them in the concatenated sandbox.
    '_meAiParseWorkItem', '_meAiDevKey', '_meAiGoalEntKey', '_meAiDedupStoredGoals',
  ]);

  const WI = 'https://dev.azure.com/dnceng/internal/_workitems/edit/11499';
  const PR = 'https://dev.azure.com/dnceng/internal/_git/repo/pullrequest/61625';

  await t.test('entKey: link and meta.workItemId resolve to the SAME entity key', () => {
    const fromLink = _meAiGoalEntKey(WI, null);
    const fromMeta = _meAiGoalEntKey(PR, { workItemId: '11499', provider: 'azdo', org: 'dnceng', project: 'internal' });
    t.ok(fromLink, 'work-item link yields a key');
    t.eq(fromLink, fromMeta, 'a PR-linked dev/code-flow goal keys to the same work item');
    // A bare PR (no work item anywhere) falls back to a pr: key, distinct from the wi: key.
    t.ne(_meAiGoalEntKey(PR, { prId: '61625' }), fromLink);
    t.eq(_meAiGoalEntKey('', null), '', 'a non-entity goal has no key');
  });

  await t.test('dedup: #11499 surfaced 3 ways collapses to one, keeping the canonical row', () => {
    const rows = [
      { title: 'DNCENG Task #11499', kind: 'checklist', done: false, status: 'open', link: WI },
      { title: 'Dev: #11499', kind: 'checklist', done: false, status: 'open', link: PR, carried: true, meta: { workItemId: '11499', provider: 'azdo', org: 'dnceng', project: 'internal' } },
      { title: 'Code Flow: Add per-repo SLA rejection preview enforcement', kind: 'checklist', done: false, status: 'open', link: PR, meta: { workItemId: '11499', provider: 'azdo', org: 'dnceng', project: 'internal', repo: 'helix' } },
      // A genuinely different work item must survive untouched.
      { title: 'DNCENG Task #11247', kind: 'checklist', done: false, status: 'open', link: 'https://dev.azure.com/dnceng/internal/_workitems/edit/11247' },
    ];
    const out = _meAiDedupStoredGoals(rows);
    const titles = out.map(r => r.title);
    t.eq(out.length, 2, 'three #11499 goals collapse to one; #11247 stays');
    t.ok(titles.includes('DNCENG Task #11499'), 'kept the canonical work-item-linked row (best score)');
    t.ok(titles.includes('DNCENG Task #11247'), 'the distinct work item is untouched');
    t.ok(!titles.includes('Dev: #11499'), 'the carried duplicate is dropped');
  });

  await t.test('dedup: disposed / done rows are historical and never collapsed', () => {
    const rows = [
      { title: 'DNCENG Task #11499', kind: 'checklist', done: true, status: 'open', link: WI },
      { title: 'Dev: #11499', kind: 'checklist', done: false, status: 'open', link: WI },
    ];
    const out = _meAiDedupStoredGoals(rows);
    t.eq(out.length, 2, 'a done row and an open row for the same item both stay');
  });

  await t.test('dedup: no duplicates → identical array reference (cheap no-op)', () => {
    const rows = [
      { title: 'DNCENG Task #11499', kind: 'checklist', done: false, status: 'open', link: WI },
      { title: 'Reply to Drew', kind: 'checklist', done: false, status: 'open' },
    ];
    t.eq(_meAiDedupStoredGoals(rows), rows, 'returns the same array when nothing collapses');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6c. COMPOSITE URGENCY — deterministic due/impact/scope/effort scorer. The four
//     facets refine, never override, the collector's flat urgency (base). Feeds
//     surfacing + sorting only; the agenda is never touched by this value.
// ─────────────────────────────────────────────────────────────────────────────
{
  // The scorer references module-level regex consts; pull the REAL block as a prelude
  // so the test exercises the shipped keyword lists, not a copy.
  const prelude = sliceSource(SERVER, 'const _MEAI_URG_DUE_NOW', '_MEAI_URG_HIGHEFFORT = ');
  const { _meAiUrgencyScore } = extractFns(SERVER, ['_meAiUrgencyScore'], { prelude });

  await t.test('base is preserved as the criticality anchor', () => {
    for (const u of [0, 1, 2, 3, 4, 5]) {
      t.eq(_meAiUrgencyScore({ title: 'x', urgency: u }).base, u, `base echoes urgency ${u}`);
    }
    // Out-of-range clamps.
    t.eq(_meAiUrgencyScore({ title: 'x', urgency: 9 }).base, 5, 'clamps high');
    t.eq(_meAiUrgencyScore({ title: 'x', urgency: -2 }).base, 0, 'clamps low');
  });

  await t.test('neutral cue-free item does not regress far from its anchor', () => {
    // No keyword cues → composite stays within ±1 of the collector score.
    for (const u of [1, 2, 3, 4, 5]) {
      const s = _meAiUrgencyScore({ title: 'some plain note', urgency: u }).score;
      t.ok(Math.abs(s - u) <= 1, `score ${s} within 1 of anchor ${u}`);
    }
  });

  await t.test('a due-today blocking ask floats UP over its flat urgency', () => {
    const flat = _meAiUrgencyScore({ title: 'Look at this', urgency: 3 }).score;
    const hot = _meAiUrgencyScore({ title: 'Need your approval by EOD, you are blocking release', urgency: 3, directMention: true }).score;
    // Criticality dominates the blend (0.55), so a base-3 item rises but is not yanked to
    // the top — the facets move it by ~±1.5. The contract is: hot ranks strictly above flat.
    t.ok(hot > flat, `hot ${hot} > flat ${flat}`);
  });

  await t.test('a no-deadline FYI floats DOWN under its flat urgency', () => {
    const flat = _meAiUrgencyScore({ title: 'plain', urgency: 3 }).score;
    const cold = _meAiUrgencyScore({ title: 'FYI no action needed, whenever you get a chance', urgency: 3 }).score;
    t.ok(cold <= flat, `cold ${cold} <= flat ${flat}`);
  });

  await t.test('why phrase reflects the dominant facets', () => {
    const hot = _meAiUrgencyScore({ title: 'Approve by end of day, you are blocking', urgency: 4, directMention: true });
    t.ok(/due today/.test(hot.why), 'due today surfaced');
    t.ok(/block/.test(hot.why), 'blocking surfaced');
  });

  await t.test('facets are bounded 0..1 and score bounded 0..5', () => {
    const r = _meAiUrgencyScore({ title: 'urgent prod incident p0 outage blocking everyone by eod', urgency: 5, directMention: true, prLink: 'x' });
    t.ok(r.score >= 0 && r.score <= 5, 'score in range');
    for (const k of ['criticality', 'dueDate', 'impact', 'scope', 'effort']) {
      t.ok(r.facets[k] >= 0 && r.facets[k] <= 1, `${k} in 0..1`);
    }
  });

  await t.test('malformed input never throws', () => {
    // A cue-free / field-less item computes cleanly (base derives from a missing urgency → 0);
    // the important contract is simply that it returns a well-formed numeric result, never throws.
    t.ok(typeof _meAiUrgencyScore(null).score === 'number', 'null scores without throwing');
    t.ok(typeof _meAiUrgencyScore(undefined).score === 'number', 'undefined scores without throwing');
    t.ok(typeof _meAiUrgencyScore({}).score === 'number', 'empty object scores');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6b. Conflict auto-report ANONYMIZATION (privacy — this repo is PUBLIC). The
// auto-filed scheduling-conflict issue must never leak real block titles / links /
// authors / subjects. Exercise the leak-surface builders directly and assert the
// sensitive strings are absent + the opaque type-N tokens are stable/correlated.
// ─────────────────────────────────────────────────────────────────────────────
{
  const fns = extractFns(SERVER, [
    '_hmToMin', '_minToHm', '_maxHm', '_minHm', '_meAiFindBlock', '_meAiBlockFlags',
    '_meAiFlagRank', '_meAiAnonLabeler', '_meAiSafeMeta', '_meAiConflictWhy',
    '_meAiConflictGantt', '_meAiConflictTable',
  ]);
  const {
    _meAiAnonLabeler, _meAiSafeMeta, _meAiConflictGantt, _meAiConflictTable, _meAiConflictWhy,
  } = fns;

  // A block carrying obviously-sensitive internal content.
  const secretA = 'Review !62392 Fix OAuth token leak (drew.smith)';
  const secretB = 'Reply to Missy Messa about Q3 layoffs';
  const linkA = 'https://dev.azure.com/dnceng/internal/_git/repo/pullrequest/62392';
  const mkBlock = (start, end, type, title, link, extraMeta) => ({
    start, end, type, title, link,
    meta: Object.assign({ link, prTitle: title, author: 'drew.smith', subject: title, repo: 'secret-repo', imminent: true, urgency: 5 }, extraMeta || {}),
    urgency: 5, conflict: true,
  });
  const bA = mkBlock('10:00', '11:00', 'review', secretA, linkA);
  const bB = mkBlock('10:30', '11:30', 'comms', secretB, 'mailto:missy@corp.com');
  const agenda = { blocks: [bA, bB], meta: { conflicts: [{ a: bA, b: bB }] } };
  const pairs = agenda.meta.conflicts;
  const cfg = { workStart: '08:00', workEnd: '17:00' };

  const SENSITIVE = [secretA, secretB, linkA, 'drew.smith', 'Missy Messa', 'layoffs', 'OAuth', '62392', 'secret-repo', 'missy@corp.com'];
  const assertClean = (text, where) => {
    for (const s of SENSITIVE) t.ok(!String(text).includes(s), `${where} must not leak ${JSON.stringify(s)}`);
  };

  await t.test('_meAiSafeMeta drops all sensitive keys, keeps whitelist', () => {
    const safe = _meAiSafeMeta(bA.meta);
    t.eq(safe.imminent, true);
    t.eq(safe.urgency, 5);
    t.ok(!('link' in safe) && !('prTitle' in safe) && !('author' in safe) && !('subject' in safe) && !('repo' in safe), 'sensitive keys stripped');
    assertClean(JSON.stringify(safe), 'safeMeta');
  });

  await t.test('_meAiAnonLabeler is stable + order-independent', () => {
    const l1 = _meAiAnonLabeler();
    const a1 = l1(bA), b1 = l1(bB), a1again = l1(bA);
    t.eq(a1, a1again, 'same block → same token');
    t.ok(a1 !== b1, 'distinct blocks → distinct tokens');
    t.ok(/^review-\d+$/.test(a1), `token is type-N (${a1})`);
    t.ok(/^comms-\d+$/.test(b1), `token is type-N (${b1})`);
    // order independence: labeling B first yields the same identity mapping
    const l2 = _meAiAnonLabeler();
    const b2 = l2(bB), a2 = l2(bA);
    t.eq(a2, l2(bA), 'stable under reorder');
    t.ok(a2 !== b2);
  });

  await t.test('conflict gantt is fenced mermaid + crit-marked + leak-free', () => {
    const label = _meAiAnonLabeler();
    const g = _meAiConflictGantt(agenda, `After · 2026-07-06`, label);
    t.ok(g.startsWith('```mermaid') && g.includes('gantt'), 'fenced mermaid gantt');
    t.ok(g.includes('crit'), 'conflicting blocks marked crit');
    assertClean(g, 'gantt');
  });

  await t.test('conflict table + why are leak-free and share tokens', () => {
    const label = _meAiAnonLabeler();
    const table = _meAiConflictTable(pairs, label);
    const why = _meAiConflictWhy(agenda, pairs, cfg, label);
    assertClean(table, 'table');
    assertClean(JSON.stringify(why), 'why');
    // the shared labeler makes the table + why reference the SAME opaque tokens
    const tok = label(bA);
    t.ok(table.includes(tok), 'table uses shared token');
    t.ok(why[0].a.label === tok || why[0].b.label === tok, 'why uses shared token');
    t.ok(typeof why[0].whyUnresolved === 'string' && why[0].whyUnresolved.length > 0, 'reason present');
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Follow-up classifier — a directive / new-scope follow-up on a concluded pursuit
// must FAN OUT (investigate), report edits must revise, questions must answer.
// Guards the regression where "make the report warmer" spawned a new wave.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiClassifyFollowup } = extractFns(SERVER, ['_meAiClassifyFollowup']);
  await t.test('follow-up directive / new scope fans out (investigate)', () => {
    t.eq(_meAiClassifyFollowup('you should also investigate dotnet-helix-machines and dotnet-helix-service'), 'investigate');
    t.eq(_meAiClassifyFollowup('also look into the retry path'), 'investigate');
    t.eq(_meAiClassifyFollowup('map the dependencies between the services'), 'investigate');
  });
  await t.test('report edits classify as revise (not a new investigation)', () => {
    t.eq(_meAiClassifyFollowup('make the report warmer and shorter'), 'revise');
    t.eq(_meAiClassifyFollowup('make it shorter'), 'revise');
    t.eq(_meAiClassifyFollowup('revise the summary to tighten the intro'), 'revise');
    t.eq(_meAiClassifyFollowup('tighten the conclusion'), 'revise');
  });
  await t.test('questions classify as answer', () => {
    t.eq(_meAiClassifyFollowup('what did you find about wait times?'), 'answer');
    t.eq(_meAiClassifyFollowup('how does the retry path work?'), 'answer');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12b. BUG 3 — investigate fan-out never degrades to a single answer turn.
// When the AI planner returns no angles, _meAiFallbackFanout must synthesize real
// parallel legs straight from the steer so an "also investigate X and Y" directive
// always lights up the map instead of a lone agent narrating a plan it never ran.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { _meAiFallbackFanout } = extractFns(SERVER, ['_meAiFallbackFanout']);
  await t.test('fallback fan-out splits multiple named targets into one leg each', () => {
    const legs = _meAiFallbackFanout(
      { _steerNote: 'Follow-up from me: you should also investigate dotnet-helix-machines and dotnet-helix-service' },
      { goal: 'Helix UX effort' });
    t.ok(legs.length >= 2, 'at least two parallel legs');
    const titles = legs.map(l => l.title).join(' | ');
    t.ok(/dotnet-helix-machines/.test(titles), 'a leg targets dotnet-helix-machines');
    t.ok(/dotnet-helix-service/.test(titles), 'a leg targets dotnet-helix-service');
    t.ok(legs.every(l => l.kind === 'branch' && l.lane && l.title && l.goal), 'each leg has kind/lane/title/goal');
    t.ok(legs.every(l => l.goal.length <= 600 && l.title.length <= 80), 'legs stay within caps');
  });
  await t.test('fallback fan-out gives a vague steer two generic angles (scout + branch)', () => {
    const legs = _meAiFallbackFanout({ _steerNote: 'Take a different approach on this. dig deeper here' }, { goal: 'g' });
    t.eq(legs.length, 2, 'exactly two angles');
    const kinds = legs.map(l => l.kind).sort().join(',');
    t.eq(kinds, 'branch,scout', 'one scout to locate sources, one branch to deep-dive');
    t.ok(!/Follow-up from me:|Take a different approach/i.test(legs.map(l => l.goal).join(' ')), 'framing prefix is stripped from the goal');
  });
  await t.test('BUG 3 — investigate route forces fan-out end to end', () => {
    const src = readFileSync(SERVER, 'utf8');
    // orchestrator degradation guard consults opts.forceFanout before the single-spine answer
    t.ok(/if \(!cands\.length && opts\.forceFanout\)/.test(src), 'orchestrate calls the fallback when a forced fan-out found no angles');
    t.ok(/cands = _meAiFallbackFanout\(t, spine\)/.test(src), 'it uses the deterministic fallback');
    // reAct threads forceFanout down into orchestrate
    const react = sliceSource(SERVER, 'function _meAiTreeReAct(t, intent, text, label, opts) {', '\n// via _meAiTreeReAct');
    t.ok(/const forceFanout = !!\(opts && opts\.forceFanout\)/.test(react), 'reAct reads opts.forceFanout');
    t.ok(/forceFanout: forceFanout/.test(react), 'reAct passes it to orchestrate');
    // the classified-investigate route requests it
    t.ok(/_meAiTreeReAct\(t, 'continue', b\.text, b\.label \|\| 'New direction', \{ forceFanout: true \}\)/.test(src),
      'the investigate branch fires a forced fan-out');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12c. BUG 2 — resume re-drives stalled legs even while the pursuit reads "running".
// The recurring "2 to resume → 0 resumed" was the running-branch bailing with
// resumed:0; it must now re-run the orphaned blocked legs directly.
// ─────────────────────────────────────────────────────────────────────────────
{
  await t.test('resume running-branch re-drives stalled legs instead of bailing', () => {
    // slice the stalled-exists RUNNING branch of the resume core (AFTER the `if (!stalled.length)`
    // block, whose own running bail with resumed:0 is legitimate — nothing to re-drive there).
    const run = sliceSource(SERVER, 'let rerunR = 0, culledR = 0;', '// Idle + stuck.');
    t.ok(run.length > 0, 'resume stalled+running branch found');
    t.ok(/for \(const sl of stalled\)/.test(run), 'it iterates the stalled legs');
    t.ok(/driveOrphan\(leg\) === 'rerun'/.test(run), 'it re-drives (or culls) each stalled leg via driveOrphan while running');
    t.ok(/return \{ ok: true, resumed: rerunR, rerun: rerunR, culled: culledR, running: true, stalled \}/.test(run), 'it reports the real re-driven count, not 0');
    t.ok(/resumed-stalled/.test(run), 'a ledger entry records the direct re-runs');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Director resume honesty — the /director/resume route must flip the task out of
// its error/idle state SYNCHRONOUSLY (clear error + _meAiSetStage 'working' +
// emit a stage event) BEFORE scheduling the leg reruns / spine re-engagement.
// Otherwise the stage-flip queues behind the reruns and the card sits at
// "error · Interrupted repeatedly" for minutes → reads as "Resume did nothing".
// Source-slice guard (the effect is async + scheduler-gated, hard to assert live).
// ─────────────────────────────────────────────────────────────────────────────
{
  const route = sliceSource(SERVER, 'function _meAiResumeStalled(id, opts) {', "// Resume legs stalled by an interruption");
  await t.test('resume flips stage to working synchronously before scheduling reruns', () => {
    t.ok(route.length > 0, 'resume core found');
    // both recovery branches (stalled legs + idle nudge) must clear the error…
    const clears = (route.match(/t\.error = null;\s*t\._lastError = null;/g) || []).length;
    t.ok(clears >= 2, `error cleared in both branches (found ${clears})`);
    // …and flip the stage to working + broadcast it
    const stages = (route.match(/_meAiSetStage\(t, 'working', 'running'\)/g) || []).length;
    t.ok(stages >= 2, `stage flipped to working in both branches (found ${stages})`);
    const emits = (route.match(/_meAiTreeEmit\(id, 'stage', \{ stage: 'working' \}\)/g) || []).length;
    t.ok(emits >= 2, `stage event emitted in both branches (found ${emits})`);
    // the stalled branch must set the stage BEFORE looping the reruns
    const stalledIdx = route.indexOf("_meAiSetStage(t, 'working', 'running')");
    const namesIdx = route.indexOf('const names = stalled.map');
    t.ok(stalledIdx > -1 && namesIdx > -1 && stalledIdx < namesIdx, 'stage flip precedes the rerun loop');
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Resume "N → 0 resumed" fix — the stalled detector must catch EVERY restart/crash
// orphan on an idle pursuit: scout-waiting legs left claiming 'running' AND 'planned'
// fan-out legs the wave created but never dispatched (the "parallel explore agents
// that never appear on the map"). It stays blocked-only on a live pursuit. The resume
// route picks the opts up front from live-ness; the state routes surface the same count
// so the desk badge and Resume agree; a DONE run is nudgeable (not walled off); and a
// resumed run gets a fresh restart-recovery budget so it can't immediately re-error.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(SERVER, 'utf8');
  const detector = sliceSource(SERVER, 'function _meAiDirectorStalledLegs(tree, opts) {', 'const ME_AI_STALE_RUNNING_MS');
  await t.test('stalled detector opts-in to stale-running AND planned orphans', () => {
    t.ok(detector.length > 0, 'detector found');
    t.ok(/const includeStale = !!\(opts && opts\.includeStaleRunning\)/.test(detector), 'reads the includeStaleRunning opt');
    t.ok(/const includePlanned = !!\(opts && opts\.includePlanned\)/.test(detector), 'reads the includePlanned opt');
    t.ok(/leg\.status === 'running'/.test(detector) && /ME_AI_STALE_RUNNING_MS/.test(detector), 'counts a stale running leg past the threshold');
    t.ok(/includePlanned && leg\.status === 'planned'/.test(detector), 'counts an orphaned planned leg when opted in');
    // default (no opts) must stay blocked-only so live pursuits are unaffected
    t.ok(/let stalled = leg\.status === 'blocked'/.test(detector), 'blocked is still the base case');
  });
  await t.test('resume widens to stale-running + planned orphans up front when idle', () => {
    // The recovery logic lives in the reusable core _meAiResumeStalled (the route is a thin wrapper).
    const core = sliceSource(SERVER, 'function _meAiResumeStalled(id, opts) {', "// Resume legs stalled by an interruption");
    t.ok(core.length > 0, '_meAiResumeStalled core found');
    // opts chosen up front from live-NESS (not the raw flag): blocked-only while a real loop is
    // alive, the full orphan set (stale-running + planned) when idle-but-stuck.
    t.ok(/const idle = _meAiPursuitIdle\(id, fresh\)/.test(core), 'branches on liveness (idle), not the raw task flag');
    t.ok(/const detOpts = idle \? \{ includeStaleRunning: true, includePlanned: true \} : \{\}/.test(core),
      'idle pursuits scan for stale-running + planned orphans, live pursuits stay blocked-only');
    t.ok(/_meAiDirectorStalledLegs\(fresh, detOpts\)/.test(core), 'the fold is scanned with the idle-aware opts');
    // a DONE run is no longer dead-ended — it falls through to the nudge so the user can reopen it
    t.ok(!/if \(treeDone\) return res\.json\(\{ ok: true, resumed: 0, done: true/.test(core),
      'a finished run is not walled off — it can be nudged back into progress');
  });
  await t.test('resume resets the restart-recovery budget so it cannot re-error', () => {
    const core = sliceSource(SERVER, 'function _meAiResumeStalled(id, opts) {', "// Resume legs stalled by an interruption");
    const resets = (core.match(/_meAiTreeEmit\(id, 'rootstate', \{ patch: \{ recoveries: 0 \} \}\)/g) || []).length;
    t.ok(resets >= 2, `recovery counter reset in both recovery branches (found ${resets})`);
  });
  await t.test('state routes surface the idle-aware stalled count (stale + planned)', () => {
    const n = (src.match(/_meAiDirectorStalledLegs\(tree, \{ includeStaleRunning: _meAiPursuitIdle\(id, tree\), includePlanned: _meAiPursuitIdle\(id, tree\) \}\)/g) || []).length;
    t.ok(n >= 2, `both GET /director and /director/reason use the idle-aware count (found ${n})`);
    t.ok(/function _meAiPursuitIdle\(id, tree\)/.test(src), '_meAiPursuitIdle helper exists');
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Pursuit map — node run-duration (Feature C). The fold reducer must stamp
// startedAt when a leg enters 'running' and endedAt + durationMs on a terminal
// transition, so the map / tooltip / export can report how long a node ran.
// Reducer effect is stamped inside _meAiFoldJournal; assert via a source slice.
// ─────────────────────────────────────────────────────────────────────────────
{
  const foldSrc = sliceSource(SERVER, 'case \'leg_status\': {', 'case \'leg_invalidate\':');
  await t.test('fold reducer stamps run timing on status transitions', () => {
    t.ok(foldSrc.length > 0, 'leg_status reducer case found');
    // entering running (re)starts the clock and clears any prior end
    t.ok(/if \(r\.status === 'running'\) \{ leg\.startedAt = r\.at; leg\.endedAt = null; leg\.durationMs = null; \}/.test(foldSrc),
      'running transition (re)starts the run clock');
    // a terminal transition closes the clock and records elapsed wall-clock
    t.ok(/\['done', 'error', 'invalidated', 'cancelled'\]\.includes\(r\.status\)/.test(foldSrc),
      'terminal statuses close the clock');
    t.ok(/leg\.durationMs = Math\.max\(0, Date\.parse\(r\.at\) - Date\.parse\(s\)\)/.test(foldSrc),
      'durationMs is computed from startedAt→endedAt');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Crash-loop cull (auto-recover from a stuck state). A leg that keeps ERRORING
  // on its own runs must accumulate a durable failCount (reset on a genuine done),
  // and after MEAI_LEG_MAX_FAILS the Director culls the path + auto-converges so
  // the pursuit never parks forever on a leg that will only crash again.
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('fold reducer tracks consecutive leg crashes (failCount)', () => {
    t.ok(/if \(r\.status === 'error'\) leg\.failCount = \(leg\.failCount \|\| 0\) \+ 1;/.test(foldSrc),
      'an error increments the durable failCount');
    t.ok(/else if \(r\.status === 'done'\) \{ leg\.failCount = 0; leg\.stallCount = 0; \}/.test(foldSrc),
      'a genuine done clears the failCount and stallCount (only consecutive crashes/stalls count)');
  });

  await t.test('crash-loop cull threshold + helper exist', () => {
    const src = readFileSync(SERVER, 'utf8');
    t.ok(/const MEAI_LEG_MAX_FAILS = 3;/.test(src), 'MEAI_LEG_MAX_FAILS threshold defined');
    t.ok(/function _meAiAutoCullCrashLoop\(t, leg, fails, err\) \{/.test(src), 'cull helper defined');
    const cull = sliceSource(SERVER, 'function _meAiAutoCullCrashLoop(t, leg, fails, err) {', 'async function _meAiRunLeg(t, leg) {');
    t.ok(/_meAiTreeEmit\(id, 'leg_invalidate', \{ legId: leg\.id \}\)/.test(cull), 'it culls (invalidates) the doomed leg');
    t.ok(/culled-crash-loop/.test(cull), 'it records a director ledger entry');
    // auto-recover: only when this machine leads + the pursuit is idle + nothing else is live
    t.ok(/_meAiDirectorLeaderOk\(\)/.test(cull) && /_meAiPursuitIdle\(id\)/.test(cull), 'auto-converge is leader- + idle-gated');
    t.ok(/l\.status === 'running' \|\| l\.status === 'blocked'/.test(cull), 'it only converges when no other leg is live');
    t.ok(/_meAiTreeReAct\(tk, 'continue'/.test(cull), 'it re-engages the spine to converge on a deliverable');
  });

  await t.test('_meAiRunLeg culls after repeated crashes', () => {
    const runLeg = sliceSource(SERVER, 'async function _meAiRunLeg(t, leg) {', '// The sub-agent');
    // the error branch reads the just-folded failCount and culls past the threshold
    t.ok(/const st2 = _meAiTreeEmit\(id, 'leg_status', \{ legId: leg\.id, status: 'error' \}\)/.test(runLeg),
      'it captures the folded state after emitting error');
    t.ok(/if \(fails >= MEAI_LEG_MAX_FAILS && !\(fl && \(fl\.invalidated \|\| fl\.status === 'invalidated'\)\)\)/.test(runLeg),
      'it culls only past the threshold and not twice');
    t.ok(/_meAiAutoCullCrashLoop\(t, leg, fails, err\)/.test(runLeg), 'it delegates to the cull helper');
  });

  await t.test('resume culls crash-loopers instead of re-driving them', () => {
    const core = sliceSource(SERVER, 'function _meAiResumeStalled(id, opts) {', "// Resume legs stalled by an interruption");
    // Both re-drive loops delegate to a single driveOrphan closure that culls a doomed leg rather
    // than re-driving it toward another crash (failCount) OR endless orphaning (stallCount).
    t.ok(/const driveOrphan = \(leg\) =>/.test(core), 'a driveOrphan closure centralizes re-drive-vs-cull');
    t.ok(/\(leg\.failCount \|\| 0\) >= MEAI_LEG_MAX_FAILS && !leg\.invalidated/.test(core),
      'driveOrphan culls a crash-looper (failCount ceiling)');
    t.ok(/sc >= MEAI_LEG_MAX_STALLS && !leg\.invalidated/.test(core),
      'driveOrphan culls a stall-looper (stallCount ceiling) — the never-crash-never-complete case');
    // both the running-branch and the idle-branch loops route each orphan through driveOrphan
    const uses = (core.match(/driveOrphan\(leg\)/g) || []).length;
    t.ok(uses >= 2, `both re-drive loops go through driveOrphan (found ${uses})`);
    t.ok(/culled: culledR/.test(core) && /culled,/.test(core), 'the response reports the culled count honestly');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Durable stuck-state fix — the recurring "Resume all N → 0 resumed / still
  // stuck" loop. THREE new invariants: (1) a running leg heartbeats updatedAt on
  // every substep so the stale detector only flags TRUE silence; (2) idle is a
  // LIVENESS judgement, not the raw task flag, so a flag-says-running-but-all-
  // stale pursuit is treated as idle+stuck and its orphans become recoverable;
  // (3) a leg that never crashes and never completes (stallCount) is culled so
  // the pursuit converges; and a leader-gated watchdog auto-recovers with no click.
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('a running leg heartbeats updatedAt on every substep (stale detector honesty)', () => {
    const ev = sliceSource(SERVER, "case 'leg_event': {", "case 'leg_stall': {");
    t.ok(ev.length > 0, 'leg_event reducer case found');
    t.ok(/if \(leg\.status === 'running'\) leg\.updatedAt = r\.at;/.test(ev),
      'a substep stamps updatedAt while running — a genuinely-busy leg never looks stale');
  });

  await t.test('leg_stall fold increments a durable stallCount', () => {
    const st = sliceSource(SERVER, "case 'leg_stall': {", "case 'checkpoint':");
    t.ok(st.length > 0, 'leg_stall reducer case found');
    t.ok(/leg\.stallCount = \(leg\.stallCount \|\| 0\) \+ 1; leg\.updatedAt = r\.at;/.test(st),
      'each re-drive of an un-terminal orphan bumps the durable stallCount + stamps updatedAt');
  });

  await t.test('_meAiPursuitIdle is liveness-based, not the raw task flag', () => {
    const idle = sliceSource(SERVER, 'function _meAiPursuitIdle(id, tree) {', '// ---- AI reasoning pass');
    t.ok(idle.length > 0, '_meAiPursuitIdle found');
    // errored/paused/parked → idle
    t.ok(/if \(!\(t\.status === 'running' \|\| t\.stage === 'working'\)\) return true;/.test(idle),
      'a task not flagged running/working is idle');
    // the subtle case: flag says live but every running leg is stale → still idle
    t.ok(/const anyFresh = /.test(idle) && /l\.status !== 'running'/.test(idle) && /ME_AI_STALE_RUNNING_MS/.test(idle),
      'a flag-says-running pursuit with only STALE running legs is treated as idle+stuck');
    t.ok(/return !anyFresh;/.test(idle), 'a single genuinely-fresh running leg means a real loop is alive → not idle');
  });

  await t.test('stall-cull helper exists + is opt-in on auto-converge', () => {
    const src = readFileSync(SERVER, 'utf8');
    t.ok(/const MEAI_LEG_MAX_STALLS = 3;/.test(src), 'MEAI_LEG_MAX_STALLS threshold defined');
    t.ok(/function _meAiCullStalled\(t, leg, stalls, opts\) \{/.test(src), 'stall-cull helper defined');
    const cull = sliceSource(SERVER, 'function _meAiCullStalled(t, leg, stalls, opts) {', 'async function _meAiRunLeg(t, leg) {');
    t.ok(/_meAiTreeEmit\(id, 'leg_invalidate', \{ legId: leg\.id \}\)/.test(cull), 'it culls (invalidates) the stalled leg');
    t.ok(/culled-stalled/.test(cull), 'it records a director ledger entry');
    // default OFF so a batch cull in the resume core does not fire N redundant spine waves
    t.ok(/const converge = !!\(opts && opts\.converge\)/.test(cull) && /if \(!converge\) return;/.test(cull),
      'auto-converge is opt-in (the resume core re-engages the spine once for the whole batch)');
  });

  await t.test('stuck-pursuit watchdog auto-recovers idle+stuck pursuits, leader-gated', () => {
    const wd = sliceSource(SERVER, 'const ME_AI_STUCK_WATCHDOG_MS', '// REQ-8 Proactive attention poller');
    t.ok(wd.length > 0, 'watchdog block found');
    t.ok(/if \(!leaderCheck\(\)\) return;/.test(wd), 'leader-gated (executes work, per I1)');
    t.ok(/if \(!featureEnabled\('me-ai'\)\) return;/.test(wd), 'feature-gated');
    t.ok(/t\.mode !== 'tree'/.test(wd), 'only tree-mode pursuits');
    t.ok(/if \(!_meAiPursuitIdle\(id\)\) continue;/.test(wd), 'only touches effectively-idle pursuits — never a live wave');
    t.ok(/_meAiResumeStalled\(id, \{ stalledOnly: true \}\)/.test(wd),
      'uses the SAME core the manual button uses, with stalledOnly so it never nudges a merely-unfinished pursuit');
    t.ok(/_meAiStuckLastRecover/.test(wd), 'throttles per task');
  });

  await t.test('resume core stalledOnly suppresses the generic idle-nudge (watchdog quiet)', () => {
    const core = sliceSource(SERVER, 'function _meAiResumeStalled(id, opts) {', "// Resume legs stalled by an interruption");
    t.ok(/if \(opts\.stalledOnly\) return \{ ok: true, resumed: 0, noop: true, stalled: \[\] \}/.test(core),
      'with nothing stalled + stalledOnly, it noops instead of nudging every idle pursuit on a timer');
  });

  const { _meAiFmtDurMs } = extractFns(SERVER, ['_meAiFmtDurMs']);
  await t.test('_meAiFmtDurMs is compact + human, guards bad input', () => {
    t.eq(_meAiFmtDurMs(45000), '45s');
    t.eq(_meAiFmtDurMs(90000), '1m 30s');
    t.eq(_meAiFmtDurMs(120000), '2m');
    t.eq(_meAiFmtDurMs(3600000), '1h');
    t.eq(_meAiFmtDurMs(3660000), '1h 1m');
    t.eq(_meAiFmtDurMs(null), '');
    t.eq(_meAiFmtDurMs(-5), '');
    t.eq(_meAiFmtDurMs(Infinity), '');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Director auto-merge (Bug B) — the "Legs worth merging" insight must fold the
// redundant leg(s) into the survivor with ONE CLICK and NO prompt. It used to
// reuse the single-leg Redirect action, which pops a window.prompt for a new goal
// — confusing, because if the Director judges legs redundant it should just
// consolidate them. Dedicated server function + route + reducer/undo support, and
// a no-prompt SPA action.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(SERVER, 'utf8');
  const app = readFileSync('public/app.html', 'utf8');

  await t.test('server _meAiDirectorMerge retires redundant legs into a survivor', () => {
    const fn = sliceSource(SERVER, 'function _meAiDirectorMerge(t, legIds, into, why) {', '// Drafted by default');
    t.ok(fn.length > 0, '_meAiDirectorMerge found');
    // survivor resolution + guards
    t.ok(/if \(!into && legIds\.length\) into = legIds\[0\]/.test(fn), 'falls back to the first leg as survivor');
    t.ok(/return \{ ok: false, error: 'no-survivor-leg' \}/.test(fn), 'guards a missing survivor');
    t.ok(/return \{ ok: false, error: 'nothing-to-merge' \}/.test(fn), 'guards an empty merge set');
    // redundant = the OTHER named legs that still exist and are not already retired
    t.ok(/lid !== into && legs\[lid\] && !legs\[lid\]\.invalidated/.test(fn), 'redundant excludes the survivor + already-invalidated legs');
    // each redundant leg is invalidated (folded), stamped with mergedInto, + ledgered reversibly
    t.ok(/_meAiTreeEmit\(id, 'leg_invalidate', \{ legId: lid, mergedInto: into \}\)/.test(fn), 'invalidates each redundant leg, tagged with the survivor');
    t.ok(/verb: 'merged'/.test(fn) && /cls: 'merge'/.test(fn), 'records a merge ledger entry');
    t.ok(/reversible: true/.test(fn) && /undo: \{ op: 'restore-leg', target: lid \}/.test(fn), 'the merge is undoable via restore-leg');
    t.ok(/return \{ ok: true, into, merged, mergedCount: merged\.length \}/.test(fn), 'reports what it folded');
  });

  await t.test('reducer + undo support un-merging a leg', () => {
    const reducer = sliceSource(SERVER, "case 'leg_invalidate': {", "case 'leg_redirect': {");
    t.ok(/if \(r\.restore\)/.test(reducer), 'the leg_invalidate reducer handles restore (un-merge)');
    t.ok(/leg\.invalidated = false; leg\.mergedInto = null/.test(reducer), 'restore clears the invalidated + mergedInto flags');
    t.ok(/if \(r\.mergedInto\) leg\.mergedInto = r\.mergedInto/.test(reducer), 'invalidate stamps mergedInto for the merge case');
    const undo = sliceSource(SERVER, 'function _meAiDirectorUndo', '// ── D1: redirect');
    t.ok(/u\.op === 'restore-leg' && u\.target/.test(undo), 'restore-leg undo op exists');
    t.ok(/_meAiTreeEmit\(id, 'leg_invalidate', \{ legId: u\.target, restore: true \}\)/.test(undo), 'restore-leg re-emits leg_invalidate with restore');
  });

  await t.test('POST /director/merge route wires the function + returns the plan', () => {
    const route = sliceSource(SERVER, "app.post('/api/me-ai/task/:id/director/merge'", "app.post('/api/me-ai/task/:id/director/spawn'");
    t.ok(route.length > 0, 'merge route found');
    t.ok(/_meAiDirectorMerge\(t, b\.legIds, b\.into, b\.why\)/.test(route), 'calls the merge function with the request body');
    t.ok(/if \(result\.ok === false\) return res\.status\(400\)/.test(route), '400 on a failed merge');
    t.ok(/res\.json\(Object\.assign\(\{\}, result, \{ plan \}\)\)/.test(route), 'returns the recomputed plan');
  });

  await t.test('SPA offers a one-click merge — NO prompt', () => {
    // the insight row carries the survivor + all legIds and uses the Merge action
    t.ok(/key: 'mrg-' \+ i/.test(app) && /action: \(into && legIds\.length > 1\) \? 'Merge them' : ''/.test(app),
      'the merge insight row uses the Merge them action with into + legIds');
    // the act dispatcher routes Merge them to the merge method (not redirect)
    t.ok(/if \(ins\.action === 'Merge them'\) return this\.meAiDirectorMerge\(ins\)/.test(app), 'act dispatches to meAiDirectorMerge');
    // the client method POSTs to /director/merge and never prompts
    const method = sliceSource('public/app.html', 'async meAiDirectorMerge(ins) {', 'async meAiDirectorSpawn(fromStopId) {');
    t.ok(method.length > 0, 'meAiDirectorMerge method found');
    t.ok(!/window\.prompt/.test(method), 'the merge method does NOT prompt (that was the whole point)');
    t.ok(/director\/merge/.test(method) && /legIds: ins\.legIds, into: ins\.into/.test(method), 'POSTs legIds + survivor to /director/merge');
    t.ok(/meAiPursuitDirectorLoad\(\)/.test(method) && /meAiPursuitLoad\(\)/.test(method), 'reloads the Director + pursuit after merging');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG A — "I chose Side A, the judgement went away, then came back with the same
// question." Resolving a conflict must (Part A) record a DURABLE constraint +
// resolved verdict on the crowned subject, and (Part B) a later re-eval leg that
// re-derives the same unverifiable ambiguity must fold in as subordinate context
// instead of re-raising the settled clash as a brand-new conflict.
// ─────────────────────────────────────────────────────────────────────────────
{
  const resolveFn = sliceSource(SERVER, 'function _meAiTreeResolveStop(t, stopId, decision, note) {', 'function _meAiTreeCommentStop');
  const mergeFn = sliceSource(SERVER, 'function _meAiMergeInto(rootState, cand) {', 'function _meAiNewSideEffectIntent');

  await t.test('BUG A Part A — resolving a conflict crowns a verdict AND records a durable constraint', () => {
    t.ok(resolveFn.length > 0, '_meAiTreeResolveStop found');
    // the crowned side becomes a resolved verdict (chosenBy the user)
    t.ok(/resolveConflict: c\.id, verdict, resolvedBy: 'user'/.test(resolveFn), 'emits the resolved verdict crowned by the user');
    t.ok(/chosenBy: 'user'/.test(resolveFn), 'the verdict is attributed to the user, not an engine fallback');
    // AND a durable constraint so a later leg cannot resurrect the same clash
    t.ok(/patch: \{ constraint: 'User decided/.test(resolveFn), 'records the decision as a durable rootState constraint');
    t.ok(/do not re-open it as a conflict\./.test(resolveFn), 'the constraint tells later legs the subject is settled');
  });

  await t.test('BUG A Part B — a re-derived clash on a settled subject folds in subordinate, no new conflict', () => {
    t.ok(mergeFn.length > 0, '_meAiMergeInto found');
    // an already-resolved verdict on the subject is detected before raising a clash
    t.ok(/const decided = rs\.openConflicts\.find\(c => c && c\.subject === subject && c\.status === 'resolved' && c\.verdict\)/.test(mergeFn),
      'detects a subject the user already decided (resolved verdict)');
    // when decided, the finding is subordinated + no conflict is pushed for this finding
    t.ok(/finding\.subordinateTo = decided\.id/.test(mergeFn), 'the re-derived finding is subordinated to the settled decision');
    // structural: the decided-branch continue MUST come before the conflict-push
    const decidedIdx = mergeFn.indexOf('finding.subordinateTo = decided.id');
    const conflictIdx = mergeFn.indexOf('rs.openConflicts.push(conflict)');
    t.ok(decidedIdx > 0 && conflictIdx > decidedIdx, 'the subordinate short-circuit precedes the conflict-raise path');
  });

  await t.test('BUG A — the reducer marks a resolved conflict resolved + stores the verdict (survives reload)', () => {
    const reducer = sliceSource(SERVER, 'if (patch.resolveConflict) {', 'const rest = Object.assign({}, patch);');
    t.ok(reducer.length > 0, 'resolveConflict reducer branch found');
    t.ok(/c\.status = 'resolved'/.test(reducer), 'marks the conflict resolved');
    t.ok(/c\.verdict = patch\.verdict/.test(reducer), 'stores the crowning verdict durably');
  });
}

// final report + earlier reports + every non-spine agent transcript + the main
// thread + other artifacts — into a self-contained, navigable .zip.
// ─────────────────────────────────────────────────────────────────────────────
{
  const B = extractFns(SERVER, ['_meAiBundleEsc', '_meAiBundleSlug', '_meAiFmtDurMs', '_meAiBundleEventsHtml', '_meAiBundlePage']);
  await t.test('bundle page wrapper is a self-contained, script-free HTML doc', () => {
    const page = B._meAiBundlePage('My <Report>', 'a subtitle', '<p>inner</p>', '../index.html');
    t.ok(/^<!doctype html><html>/.test(page), 'is a full HTML document');
    t.ok(/<\/html>$/.test(page), 'document is closed');
    t.ok(!/<script/i.test(page), 'no script (sandbox-safe / self-contained)');
    t.ok(page.includes('My &lt;Report&gt;'), 'title is HTML-escaped');
    t.ok(page.includes('← Back to index'), 'renders the back link when a href is given');
    t.ok(!/prefers-color-scheme[^}]*undefined/.test(page) && /prefers-color-scheme/.test(page), 'ships light+dark styling');
    // no back link when no href
    t.ok(!B._meAiBundlePage('t', '', '<p>x</p>', null).includes('← Back to index'), 'omits back link without an href');
  });
  await t.test('bundle event renderer escapes text + labels kinds, no leaks', () => {
    const h = B._meAiBundleEventsHtml([
      { kind: 'thinking', text: 'plan <x>' },
      { kind: 'tool.run', tool: 'grep', text: 'searched' },
      { kind: 'response', text: 'done & dusted' },
    ]);
    t.ok(h.includes('plan &lt;x&gt;'), 'escapes angle brackets');
    t.ok(h.includes('done &amp; dusted'), 'escapes ampersands');
    t.ok(h.includes('Tool · grep'), 'labels a tool call with its tool name');
    t.ok(!/<script/i.test(h), 'no script leaks through');
    t.eq(B._meAiBundleEventsHtml([]), '<p class="muted">No captured transcript.</p>');
  });
  await t.test('BUG 1 — bundle transcript captures tool args + results, not bare labels', () => {
    const h = B._meAiBundleEventsHtml([
      { kind: 'tool_start', tool: 'grep', args: { pattern: 'wait-time', glob: '*.cs' } },
      { kind: 'tool_complete', tool: 'grep', result: 'src/Queue.cs:42 matched', success: true },
      { kind: 'tool_complete', tool: 'run', error: 'exit 1', success: false },
    ]);
    t.ok(/<pre class="io">/.test(h), 'renders tool I/O in a pre block');
    t.ok(h.includes('wait-time') && h.includes('pattern'), 'tool args JSON is surfaced');
    t.ok(h.includes('src/Queue.cs:42 matched'), 'tool result is surfaced');
    t.ok(h.includes('exit 1'), 'a failed tool falls back to its error text');
    t.ok(/Tool result · grep/.test(h), 'a completed tool is labelled with its name');
    t.ok(/Tool result · run · failed/.test(h), 'a failed tool is marked failed');
    // an empty-but-typed tool event still gets skipped (no bare label noise)
    t.eq(B._meAiBundleEventsHtml([{ kind: 'tool_start', tool: '' }]), '<p class="muted">No captured transcript.</p>');
  });

  const bundleSrc = sliceSource(SERVER, 'function _meAiExportBundle(id) {', '\napp.get(\'/api/me-ai/task/:id/export/bundle.zip\'');
  await t.test('_meAiExportBundle partitions the whole record + names the final report', () => {
    t.ok(bundleSrc.length > 0, 'bundle builder found');
    t.ok(/const reportArts = allArts\.filter\(a => a && a\.kind === 'report'\)/.test(bundleSrc), 'reports are gathered');
    t.ok(/isFinal \? '00-final'/.test(bundleSrc), 'the newest report is the 00-final deliverable');
    t.ok(/if \(leg\.kind === 'spine'\) continue/.test(bundleSrc), 'the spine is excluded from transcripts');
    t.ok(/'transcripts\/'/.test(bundleSrc) && /'chat\/main-thread\.html'/.test(bundleSrc) && /'artifacts\/'/.test(bundleSrc),
      'transcripts / main chat / artifacts each get their own folder');
    // navigable landing page + machine manifest bookend the archive
    t.ok(/entries\.unshift\(\{ name: 'index\.html'/.test(bundleSrc), 'a navigable index.html leads the bundle');
    t.ok(/entries\.push\(\{ name: 'manifest\.json'/.test(bundleSrc), 'a manifest.json closes the bundle');
    t.ok(/Agent investigations · '/.test(bundleSrc), 'index deep-links the agent investigations');
  });
  await t.test('bundle.zip route streams an attachment, guards empty pursuits', () => {
    const route = sliceSource(SERVER, "app.get('/api/me-ai/task/:id/export/bundle.zip'", "// ─");
    t.ok(route.length > 0, 'bundle route found');
    t.ok(/res\.status\(404\)\.json\(\{ ok: false, error: 'no-pursuit' \}\)/.test(route), 'a pursuit with no legs 404s');
    t.ok(/res\.status\(422\)\.json\(\{ ok: false, error: 'no-material' \}\)/.test(route), 'a pursuit with no material 422s');
    t.ok(/res\.setHeader\('Content-Type', 'application\/zip'\)/.test(route), 'serves application/zip');
    t.ok(/attachment; filename="' \+ slug \+ '-bundle\.zip"/.test(route), 'downloads as <slug>-bundle.zip');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep recovers restart-orphaned director-spawn probe legs (Q2 "Queued — not
// yet dispatched"). The _meAiSchedule queue is in-memory, so a restart wipes it
// and leaves run:true spawns durably at 'planned' with no closure — nothing polls
// 'planned', so they stick forever. The sweep must re-drive them.
// ─────────────────────────────────────────────────────────────────────────────
await t.test('_meAiDirectorSweep recovers orphaned planned director-spawn probes', () => {
  const src = readFileSync(SERVER, 'utf8');
  const i = src.indexOf('// ── Recover orphaned probe legs');
  t.ok(i > 0, 'recovery block present in _meAiDirectorSweep');
  const blk = src.slice(i, i + 3800);
  t.ok(/let recovered = 0, retiredOrphans = 0;/.test(blk), 'tracks recovered + retiredOrphans counts');
  t.ok(/const meantToRun = \(legId\) => ledger\.some\(e => e && e\.legId === legId && e\.verb === 'spawned' && e\.state === 'applied'\);/.test(blk), 'only re-drives run:true spawns (applied-ledger discriminator, not drafted proposals)');
  t.ok(/if \(!lg \|\| !lg\.directorSpawn \|\| lg\.status !== 'planned'\) continue;/.test(blk), 'targets only planned director-spawn legs');
  t.ok(/if \(!meantToRun\(lg\.id\)\) continue;/.test(blk), 'a drafted proposal (proposed-only ledger) is left for the user');
  t.ok(/if \(born && \(nowMs - born\) < 8000\) continue;/.test(blk), 'skips a spawn born moments ago (avoids racing a live dispatch)');
  t.ok(/status: 'cancelled'[\s\S]{0,40}retiredOrphans\+\+;/.test(blk), 'retires an orphan whose gating stop is no longer open');
  t.ok(/if \(!fresh \|\| fresh\.status !== 'planned'\) return;[\s\S]{0,60}await _meAiRunLeg\(t, fresh\);/.test(blk), 're-reads fresh status before running (idempotent re-drive)');
  // priority:true — a stuck probe re-drive must BYPASS the concurrency cap so a saturated
  // scheduler (hung/heavy legs) can never starve the self-heal (the bug that stranded it).
  t.ok(/await _meAiRunLeg\(t, fresh\);[\s\S]{0,40}\}, \{ priority: true \}\);/.test(blk), 'probe re-drive bypasses the concurrency cap (priority) so it is never starved');
  // the emit guard + return object must surface the new counts
  t.ok(/if \(handled \|\| probed \|\| reconciled \|\| recovered \|\| retiredOrphans\) \{/.test(src), 'sweep emits/reconciles when only recovery fired');
  t.ok(/return \{ handled, probed, recovered, retiredOrphans, reconciled,/.test(src), 'sweep return object surfaces recovered + retiredOrphans');
});


await t.test('_meAiRunTurn idle/stall watchdog fails a hung turn so its slot frees (resilience)', () => {
  const src = readFileSync(SERVER, 'utf8');
  // Bounds are defined near the concurrency cap.
  t.ok(/const ME_AI_TURN_IDLE_LIMIT_MS = 6 \* 60 \* 1000;/.test(src), 'a per-turn INACTIVITY limit is defined (idle = hung)');
  t.ok(/const ME_AI_TURN_HARD_LIMIT_MS = 30 \* 60 \* 1000;/.test(src), 'an absolute per-turn ceiling backstops the idle limit');
  const i = src.indexOf('async function _meAiRunTurn(');
  t.ok(i > 0, '_meAiRunTurn present');
  const blk = src.slice(i, i + 6000);
  // The SDK turn is raced against an inactivity/ceiling timer; on trip we reject so the
  // leg errors and the scheduler slot frees (a hung runChat can no longer pin it forever).
  t.ok(/result = await new Promise\(\(resolve, reject\)/.test(blk), 'the SDK turn is raced against a timeout so a hang cannot await forever');
  t.ok(/const idle = Date\.now\(\) - _lastActivity;/.test(blk) && /const total = Date\.now\(\) - _runStart;/.test(blk),
    'the watchdog measures both inactivity (idle) and total elapsed');
  t.ok(/if \(idle < ME_AI_TURN_IDLE_LIMIT_MS && total < ME_AI_TURN_HARD_LIMIT_MS\) return;/.test(blk),
    'a live (actively-streaming) turn keeps resetting idle and is never killed');
  t.ok(/reject\(new Error\(stalled/.test(blk), 'a stalled/over-ceiling turn rejects with a clear reason');
  // A _settled guard makes the hung runChat promise settling late (or its late callbacks) a no-op.
  t.ok(/let _settled = false;/.test(blk) && /if \(_settled\) return;/.test(blk) && /_settled = true;/.test(blk),
    'a _settled guard neutralizes the hung turn settling late');
  // onChunk/onStep still stamp _lastActivity so real progress defers the watchdog.
  t.ok(/onChunk: \(c\) => \{ _lastActivity = Date\.now\(\); acc \+= c; \}/.test(blk), 'onChunk stamps activity (defers the idle trip)');
});


await t.test('_meAiDirectorSweep re-arms a bounded follow-up so newly-surfaced probes converge', () => {
  const src = readFileSync(SERVER, 'utf8');
  // Externally-triggered sweeps get a fresh budget; re-armed follow-ups keep the chain count.
  t.ok(/function _meAiDirectorSweep\(t, _rearm\) \{/.test(src), 'sweep takes an internal _rearm flag');
  t.ok(/if \(!_rearm\) t\._directorSweepChain = 0;/.test(src), 'a non-re-armed sweep resets the convergence budget');
  const i = src.indexOf('// ── Converge: re-arm a bounded follow-up sweep');
  t.ok(i > 0, 'convergence re-arm block present');
  const blk = src.slice(i, i + 2000);
  t.ok(/const progressed = !!\(handled \|\| probed \|\| reconciled \|\| recovered \|\| retiredOrphans\);/.test(blk), 'progress = any desk-advancing outcome this pass');
  t.ok(/SWEEP_MAX_CHAIN = 12/.test(blk), 'bounded chain cap');
  t.ok(/if \(progressed\) \{[\s\S]{0,400}t\._directorSweepChain = chain \+ 1;/.test(blk), 'progress re-arms and increments the chain');
  t.ok(/_meAiDirectorSweep\(lt3, true\)/.test(blk), 're-armed follow-up passes _rearm=true');
  t.ok(/\} else \{[\s\S]{0,60}t\._directorSweepChain = 0;/.test(blk), 'a no-progress pass is the fixed point and resets the chain (guarantees termination)');
});


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
