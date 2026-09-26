import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('dev-buddy.suite');
const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-dev-buddy-'));
process.env.SUPERVISOR_DATA_DIR = dir;
const require = createRequire(import.meta.url);
const buddy = require(path.join(process.cwd(), 'dev-buddy.js'));

await t.test('work UI uses a compact list-detail workspace and one completion action', () => {
  const html = readFileSync(path.join(process.cwd(), 'public', 'dev-buddy.html'), 'utf8');
  const desktop = readFileSync(path.join(process.cwd(), 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const desktopPermissions = readFileSync(
    path.join(process.cwd(), 'desktop', 'src-tauri', 'permissions', 'app-commands.toml'),
    'utf8');
  t.ok(/class="work-layout"/.test(html) && /id="itemDetail"/.test(html),
    'work items use navigation and detail panes');
  t.ok(/id="workSort"/.test(html) && /value="urgency"/.test(html) && /value="arrival"/.test(html),
    'work list exposes urgency and arrival sorting');
  t.ok(/id="hoverPreview"/.test(html) && /class="preview-list"/.test(html),
    'hover preview exposes the complete scrollable list');
  t.ok(/"peek"\s*=>\s*\(400,\s*u32::MAX\)/.test(desktop) &&
    /max-height:\s*calc\(100vh - var\(--buddy-top\) - 208px\)/.test(html),
  'hover preview uses the available monitor height');
  t.ok(/const pendingStarStates = new Map\(\)/.test(html) &&
    /preservePendingStars/.test(html),
  'status refreshes preserve optimistic stars until persistence is confirmed');
  t.ok(/id="minimizePixel"/.test(html) &&
    /minimize_dev_buddy/.test(desktop) &&
    /"minimize_dev_buddy"/.test(desktopPermissions) &&
    /set_skip_taskbar\(false\)/.test(desktop),
  'Pixel can be minimized to the taskbar');
  t.ok(/contextmenu/.test(html) &&
    /move_dev_buddy_aside/.test(desktop) &&
    /"move_dev_buddy_aside"/.test(desktopPermissions) &&
    /monitor_containing_anchor/.test(desktop),
  'right-click moves Pixel aside without leaving the current monitor');
  t.ok(!/data-view-target="catchup"/.test(html) && !/data-action="dismiss"/.test(html),
    'Catch up and work-item dismissal are removed');
});

await t.test('reading pane builds grounded dossiers and optional AI plans', () => {
  const html = readFileSync(path.join(process.cwd(), 'public', 'dev-buddy.html'), 'utf8');
  const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const github = readFileSync(path.join(process.cwd(), 'github.js'), 'utf8');
  t.ok(/data-detail-tab="context"/.test(html) &&
    /data-detail-tab="tracking"/.test(html) &&
    /renderSourceContext/.test(html),
  'source context is the default reading view and tracking has a separate tab');
  t.ok(/function dossierFor\(item\)/.test(html) &&
    /State and path/.test(html) &&
    /Suggested next moves/.test(html) &&
    /Observed history/.test(html),
  'reading pane includes state, next-step, signal, and history sections');
  t.ok(/item\.kind === 'pull-request'/.test(html) &&
    /item\.kind === 'build'/.test(html) &&
    /\['email', 'teams', 'meeting', 'calendar'\]/.test(html),
  'dossiers adapt to engineering, collaboration, and personal work types');
  t.ok(/\/api\/dev-buddy\/insight/.test(html) &&
    /app\.post\('\/api\/dev-buddy\/insight'/.test(server) &&
    /_devBuddyGenerateInsight/.test(server),
  'Pixel can request a cached grounded AI execution brief');
  t.ok(/app\.post\('\/api\/dev-buddy\/context'/.test(server) &&
    /_devBuddyPrContext/.test(server) &&
    /_devBuddyBuildContext/.test(server) &&
    /_devBuddySessionContext/.test(server) &&
    /getWorkflowRunContext/.test(github),
  'context endpoint retrieves source-specific PR, build, and session evidence');
  t.ok(/configured\.org/.test(server) &&
    /configured\.project/.test(server) &&
    /jobsNotice/.test(server),
  'source context preserves repository identity and reports incomplete workflow evidence');
  t.ok(/page <= 100/.test(github) &&
    /pageJobs\.length < pageSize/.test(github) &&
    /Workflow jobs could not be retrieved/.test(github),
  'GitHub workflow evidence follows pagination and exposes partial retrieval failures');
  t.ok(/failedChecks: failed/.test(server) &&
    /buildNumber: build\.buildNumber/.test(server) &&
    /lastActivityAt: lastModified/.test(server),
  'PR, build, and session items carry factual workflow context');
});

await t.test('memory items persist, reprioritize, snooze, and complete', () => {
  const item = buddy.addItem({ title: 'Finish the review', detail: 'Two threads remain', priority: 'high' });
  t.eq(buddy.listItems()[0].title, 'Finish the review', 'new memory is returned from durable storage');
  buddy.updateItem(item.id, { priority: 'low', starred: true, snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
  const snoozed = buddy.listItems().find(entry => entry.id === item.id);
  t.eq(snoozed.priority, 'low', 'priority update persists');
  t.ok(snoozed.starred, 'starred state persists');
  t.ok(snoozed.snoozed, 'future snooze is active');
  buddy.updateItem(item.id, { status: 'done' });
  t.ok(!buddy.listItems().some(entry => entry.id === item.id), 'completed memory leaves the open list');
});

await t.test('attention signals can be silenced until a deadline', () => {
  const fingerprint = 'pr|github|owner|repo|42';
  t.ok(!buddy.isSignalDismissed(fingerprint), 'new signal is initially visible');
  buddy.dismissSignal(fingerprint, new Date(Date.now() + 60_000).toISOString());
  t.ok(buddy.isSignalDismissed(fingerprint), 'dismissal remains active before its deadline');
});

await t.test('mood reflects attention and day pressure', () => {
  t.eq(buddy.deriveMood({}).id, 'calm', 'quiet state is calm');
  t.eq(buddy.deriveMood({ tracking: 1 }).id, 'focused', 'active work produces a focused mood');
  t.eq(buddy.deriveMood({ tracking: 1, completedToday: 1, lastCompletedAt: new Date().toISOString() }).id, 'happy', 'a recent completion produces a happy mood');
  t.eq(buddy.deriveMood({ attention: 1, day: { pressure: 7 } }).id, 'concerned', 'attention plus a busy day produces concern');
  t.eq(buddy.deriveMood({ attention: 3 }).id, 'overloaded', 'several urgent items produce an overloaded mood');
  t.eq(buddy.deriveMood({ day: { conflicts: 1 } }).id, 'overloaded', 'an agenda conflict produces an overloaded mood');
});

await t.test('urgency ages review requests in business time', () => {
  const fridayNoon = '2026-09-25T12:00:00-07:00';
  const mondayNoon = '2026-09-28T12:00:00-07:00';
  t.eq(Math.round(buddy.businessHoursBetween(fridayNoon, mondayNoon)), 24, 'weekend hours do not consume the review SLA');
  const beforeSla = buddy.deriveUrgency(
    { priority: 'normal', trackedAt: fridayNoon, slaBusinessHours: 24 },
    '2026-09-28T11:00:00-07:00'
  );
  t.eq(beforeSla.level, 'high', 'review request rises before its one-business-day target');
  const breached = buddy.deriveUrgency(
    { priority: 'normal', trackedAt: fridayNoon, slaBusinessHours: 24 },
    mondayNoon
  );
  t.eq(breached.level, 'critical', 'review request becomes critical at one business day');
});

await t.test('explicit due dates take precedence over general age', () => {
  const urgency = buddy.deriveUrgency(
    { priority: 'low', trackedAt: '2026-09-01T09:00:00Z', dueAt: '2026-09-24T17:00:00Z' },
    '2026-09-24T18:00:00Z'
  );
  t.eq(urgency.level, 'critical', 'overdue work is critical even when manually marked low');
  t.eq(buddy.describeAge('2026-09-22T18:00:00Z', '2026-09-24T18:00:00Z'), '2d', 'tracked age is concise');
});

await t.test('manual ordering persists across inferred and remembered work', () => {
  const items = [
    { id: 'signal-a', urgency: { score: 3 }, trackedAt: '2026-09-24T10:00:00Z' },
    { id: 'memory-b', urgency: { score: 1 }, trackedAt: '2026-09-24T11:00:00Z' },
    { id: 'signal-c', urgency: { score: 2 }, trackedAt: '2026-09-24T12:00:00Z' },
  ];
  buddy.setManualOrder(['memory-b', 'signal-c', 'signal-a']);
  t.deep(
    buddy.applyManualOrder(items).map(item => item.id),
    ['memory-b', 'signal-c', 'signal-a'],
    'manual list order overrides computed urgency'
  );
});

await t.test('collected commitments remain completed after later collection', () => {
  buddy.upsertCommitments([{
    externalId: 'mail-42',
    source: 'email',
    title: 'Send the rollout plan',
    observedAt: '2026-09-24T10:00:00Z',
  }]);
  const item = buddy.listCommitments().find(entry => entry.externalId === 'mail-42');
  t.ok(item, 'new commitment is persisted');
  buddy.completeCommitment(item.id);
  buddy.upsertCommitments([{
    externalId: 'mail-42',
    source: 'email',
    title: 'Send the revised rollout plan',
    observedAt: '2026-09-24T10:00:00Z',
  }]);
  t.ok(!buddy.listCommitments().some(entry => entry.externalId === 'mail-42'), 'completed commitment is not reopened by collection');
});

await t.test('cross-source versions of one commitment are merged', () => {
  const result = buddy.upsertCommitments([
    {
      externalId: 'meeting-77',
      source: 'meeting',
      title: 'Restore the staging autoscaler to a healthy state',
      detail: 'Fix the unhealthy staging autoscaler before rollout.',
      observedAt: '2026-09-24T10:00:00Z',
    },
    {
      externalId: 'mail-77',
      source: 'email',
      title: 'Restore staging autoscaler health',
      detail: 'Please fix the unhealthy staging autoscaler before rollout.',
      observedAt: '2026-09-24T11:00:00Z',
    },
  ]);
  const merged = buddy.listCommitments().find(entry => entry.externalIds?.includes('meeting-77'));
  t.ok(merged, 'the commitment is retained');
  t.ok(merged.externalIds.includes('mail-77'), 'both source identities are retained');
  t.deep(merged.sources.sort(), ['email', 'meeting'], 'both sources are represented');
  t.eq(result.deduplicated, 1, 'the duplicate is reported');
});

await t.test('commitment source links survive weaker collection refreshes', () => {
  const externalId = 'email:message-99:reply';
  const outlookUrl = 'https://outlook.office365.com/owa/?ItemID=message-99&viewmodel=ReadMessageItem';
  buddy.upsertCommitments([{
    externalId,
    source: 'email',
    title: 'Reply to the launch question',
    link: outlookUrl,
    observedAt: '2026-09-25T10:00:00Z',
  }]);
  buddy.upsertCommitments([{
    externalId,
    source: 'email',
    title: 'Reply to the launch question',
    link: '',
    observedAt: '2026-09-25T11:00:00Z',
  }]);
  const item = buddy.listCommitments().find(entry => entry.externalId === externalId);
  t.eq(item.link, outlookUrl, 'an empty refresh cannot erase the direct Outlook link');
});

await t.test('signals support lower priority, dismissal, and completion rewards', () => {
  const before = buddy.getProgress(2);
  const snoozed = 'pr-reminder|github|owner|repo|42';
  buddy.updateSignal(snoozed, { snoozedUntil: new Date(Date.now() + 60_000).toISOString() }, {
    title: 'Review the change later',
    source: 'Code Flow',
  });

  t.ok(buddy.isSignalDismissed(snoozed), 'reminded-later signal leaves the list until its deadline');

  const dismissed = 'build|dismiss-me';
  buddy.updateSignal(dismissed, { priority: 'low', status: 'dismissed' }, { title: 'Old build', source: 'Builds' });
  t.eq(buddy.getSignalState(dismissed).priority, 'low', 'lowered signal priority persists');
  t.ok(buddy.isSignalDismissed(dismissed), 'dismissed signal leaves the list');

  const completed = 'pr|complete-me';
  buddy.updateSignal(completed, { status: 'done' }, { title: 'Review the change', source: 'Code Flow' });
  const progress = buddy.getProgress(2);
  t.eq(progress.addressedToday, before.addressedToday + 2, 'dismissed and completed work contribute to the green bar');
  t.eq(progress.completedToday, progress.addressedToday, 'legacy completion count mirrors addressed work');
  t.eq(progress.deferredToday, before.deferredToday + 2, 'snoozed and reprioritized work contribute to the yellow bar');
  t.ok(progress.completionPercent > 0, 'completion balance includes finished work');

  buddy.updateSignal(dismissed, { priority: 'low', status: 'dismissed' }, { title: 'Old build', source: 'Builds' });
  buddy.updateSignal(completed, { status: 'done' }, { title: 'Review the change', source: 'Code Flow' });
  const repeated = buddy.getProgress(2);
  t.eq(repeated.addressedToday, progress.addressedToday, 'repeated actions do not double-count addressed items');
  t.eq(repeated.deferredToday, progress.deferredToday, 'repeated actions do not double-count deferred items');
});

await t.test('signals and commitments preserve starred state', () => {
  const signal = 'starred-signal';
  buddy.updateSignal(signal, { starred: true }, { title: 'Starred signal', source: 'Test' });
  t.ok(buddy.getSignalState(signal).starred, 'signal star persists');

  buddy.upsertCommitments([{
    externalId: 'starred-commitment',
    source: 'email',
    title: 'Starred commitment',
    observedAt: '2026-09-25T12:00:00Z',
  }]);
  const commitment = buddy.listCommitments().find(entry => entry.externalId === 'starred-commitment');
  buddy.updateCommitment(commitment.id, { starred: true });
  buddy.upsertCommitments([{
    externalId: 'starred-commitment',
    source: 'email',
    title: 'Starred commitment updated',
    observedAt: '2026-09-25T13:00:00Z',
  }]);
  t.ok(buddy.listCommitments().find(entry => entry.id === commitment.id).starred,
    'commitment star survives collection refreshes');
});

await t.test('daily progress uses unique tracked work as its denominator', () => {
  const id = 'daily-progress-union';
  buddy.updateSignal(id, { priority: 'low' }, { title: 'Daily denominator item', source: 'Test' });
  const withoutOpen = buddy.getProgress([]);
  const withSameItemOpen = buddy.getProgress([{ id }]);
  t.eq(
    withSameItemOpen.totalTrackedToday,
    withoutOpen.totalTrackedToday,
    'an acted-on item still open is counted only once'
  );
  const withNewOpen = buddy.getProgress([{ id }, { id: 'new-open-item' }]);
  t.eq(
    withNewOpen.totalTrackedToday,
    withSameItemOpen.totalTrackedToday + 1,
    'new open work increases the daily denominator'
  );
});

await t.test('recent activity can restore hidden work and priority', () => {
  const item = buddy.addItem({ title: 'Accidentally completed task', priority: 'high' });
  buddy.updateItem(item.id, { priority: 'low', status: 'done' });
  t.ok(!buddy.listItems().some(entry => entry.id === item.id), 'completed work is hidden');
  const recent = buddy.listRecentActivity(24).find(entry => entry.id === item.id);
  t.ok(recent?.canPutBack, 'completed work can be put back');
  t.ok(recent?.canRestorePriority, 'lowered priority can be restored');

  buddy.restoreRecentActivity(item.id, 'put-back');
  t.ok(buddy.listItems().some(entry => entry.id === item.id), 'restored work returns to the list');
  buddy.restoreRecentActivity(item.id, 'restore-priority');
  t.eq(buddy.listItems().find(entry => entry.id === item.id).priority, 'normal', 'priority restores to normal');
  t.ok(!buddy.listRecentActivity(24).some(entry => entry.id === item.id), 'undone actions leave recent activity');
});

await t.test('efforts durably group related observations and preserve user state', () => {
  const first = {
    id: 'effort-test-pr',
    reminderKey: 'effort-test-pr',
    kind: 'pull-request',
    title: 'Roll out autoscaler safeguards',
    detail: 'PR adds staged rollout safeguards',
    source: 'GitHub',
    trackedAt: '2026-09-26T08:00:00Z',
    context: { repository: 'example/autoscaler', state: 'open', headSha: 'abc123' },
  };
  const second = {
    id: 'effort-test-build',
    reminderKey: 'effort-test-build',
    kind: 'build',
    title: 'Autoscaler rollout validation',
    detail: 'Canary validation failed in the rollout pipeline',
    source: 'Azure Pipelines',
    starred: true,
    trackedAt: '2026-09-26T08:10:00Z',
    context: { repository: 'example/autoscaler', status: 'failed', buildId: '867' },
  };
  const initial = buddy.syncEffortObservations([first, second]);
  const firstEffort = initial.efforts.find(effort =>
    effort.observations.some(observation => observation.key === first.reminderKey));
  const secondEffort = initial.efforts.find(effort =>
    effort.observations.some(observation => observation.key === second.reminderKey));
  t.ok(firstEffort && secondEffort && firstEffort.id !== secondEffort.id,
    'new observations begin as separate provisional efforts');

  buddy.applyEffortClassification([{
    provisionalIds: [firstEffort.id, secondEffort.id],
    targetEffortId: '',
    title: 'Stabilize the autoscaler rollout',
    summary: 'Ship safeguards and recover canary validation.',
    confidence: 0.94,
    reason: 'Both signals concern the same rollout outcome.',
  }]);
  const grouped = buddy.syncEffortObservations([first, second]);
  const effort = grouped.efforts.find(entry =>
    entry.observations.some(observation => observation.key === first.reminderKey));
  t.eq(effort.observations.length, 2, 'related observations are retained as evidence on one effort');
  t.eq(effort.title, 'Stabilize the autoscaler rollout', 'AI-derived effort title persists');
  t.ok(effort.starred, 'a star on merged evidence promotes to the effort');
  t.ok(!effort.provisional, 'classified effort remains established across refreshes');

  buddy.updateEffort(effort.id, { status: 'done' });
  const unchanged = buddy.syncEffortObservations([first, second]);
  t.ok(!unchanged.efforts.some(entry => entry.id === effort.id),
    'completed efforts stay hidden when their evidence is unchanged');
  const changed = buddy.syncEffortObservations([{ ...first, context: { ...first.context, state: 'merged' } }, second]);
  const reopened = changed.efforts.find(entry => entry.id === effort.id);
  t.ok(reopened?.provisional && reopened.observations.length === 2,
    'materially changed evidence reopens the complete effort for reclassification');

  buddy.updateEffort(effort.id, { status: 'done' });
  buddy.restoreRecentActivity(effort.id, 'put-back');
  t.ok(buddy.syncEffortObservations([first, second]).efforts.some(entry => entry.id === effort.id),
    'recent activity can restore a completed effort');
});

await t.test('effort classification gates uncertain and established merges', () => {
  const makeObservation = (key, title) => ({
    id: key,
    reminderKey: key,
    kind: 'email',
    title,
    detail: `${title} details`,
    source: 'Outlook',
    trackedAt: '2026-09-26T09:00:00Z',
  });
  const unrelated = [
    makeObservation('effort-low-confidence-a', 'Review autoscaler telemetry'),
    makeObservation('effort-low-confidence-b', 'Prepare quarterly planning notes'),
  ];
  let state = buddy.syncEffortObservations(unrelated);
  const ids = unrelated.map(observation => state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observation.reminderKey)).id);
  buddy.applyEffortClassification([{
    provisionalIds: ids,
    targetEffortId: '',
    title: 'Handle operational planning',
    summary: 'Potentially related work.',
    confidence: 0.4,
    reason: 'The relationship is uncertain.',
  }]);
  state = buddy.syncEffortObservations(unrelated);
  const classifiedIds = unrelated.map(observation => state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observation.reminderKey)).id);
  t.ok(classifiedIds[0] !== classifiedIds[1], 'low-confidence provisional work is not merged');
  t.ok(classifiedIds.every(id => !state.efforts.find(effort => effort.id === id).provisional),
    'uncertain items become separate established efforts instead of retrying forever');

  const established = state.efforts.find(effort => effort.id === classifiedIds[0]);
  const followup = makeObservation('effort-established-followup', 'Autoscaler telemetry follow-up');
  state = buddy.syncEffortObservations([...unrelated, followup]);
  const followupEffort = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === followup.reminderKey));
  buddy.applyEffortClassification([{
    provisionalIds: [followupEffort.id],
    targetEffortId: established.id,
    title: 'Review autoscaler telemetry',
    summary: 'Review the telemetry and its follow-up.',
    confidence: 0.6,
    reason: 'The evidence may be related.',
  }]);
  state = buddy.syncEffortObservations([...unrelated, followup]);
  const resolvedFollowup = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === followup.reminderKey));
  t.ok(resolvedFollowup.id !== established.id, 'low-confidence match does not merge into an established effort');

  const omitted = makeObservation('effort-unclassified', 'Investigate an ambiguous signal');
  state = buddy.syncEffortObservations([...unrelated, followup, omitted]);
  const omittedId = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === omitted.reminderKey)).id;
  buddy.applyEffortClassification([], [omittedId]);
  buddy.applyEffortClassification([], [omittedId]);
  buddy.applyEffortClassification([], [omittedId]);
  state = buddy.syncEffortObservations([...unrelated, followup, omitted]);
  t.ok(!state.efforts.find(effort => effort.id === omittedId).provisional,
    'repeatedly omitted work is kept separate instead of retried forever');
});

await t.test('efforts preserve urgency, reconcile cleared evidence, and complete source records', () => {
  const critical = {
    id: 'effort-critical-signal',
    reminderKey: 'effort-critical-signal',
    kind: 'pull-request',
    title: 'Restore blocked production rollout',
    detail: 'Required checks are failing.',
    source: 'GitHub',
    trackedAt: new Date().toISOString(),
    urgency: { score: 1, level: 'medium', label: 'Medium', reason: 'Waiting for semantic analysis.' },
    semanticAttention: true,
  };
  let state = buddy.syncEffortObservations([critical]);
  let criticalEffort = state.efforts.find(effort =>
    effort.observations.some(observation => observation.key === critical.reminderKey));
  state = buddy.syncEffortObservations([{
    ...critical,
    urgency: { score: 4, level: 'critical', label: 'Critical', reason: 'Production rollout is blocked.' },
    attentionBlurb: 'The blocked rollout needs immediate attention.',
  }]);
  criticalEffort = state.efforts.find(effort => effort.id === criticalEffort.id);
  t.eq(criticalEffort.urgency.score, 4, 'effort keeps the highest urgency from its evidence');
  t.eq(criticalEffort.attentionBlurb, 'The blocked rollout needs immediate attention.',
    'semantic presentation updates without changing effort assignment');

  buddy.syncEffortObservations([]);
  const storePath = path.join(dir, 'dev-buddy.json');
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const storedCritical = store.efforts.find(effort => effort.id === criticalEffort.id);
  storedCritical.observations.forEach(observation => {
    observation.missingSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  });
  writeFileSync(storePath, JSON.stringify(store, null, 2));
  state = buddy.syncEffortObservations([]);
  t.ok(!state.efforts.some(effort => effort.id === criticalEffort.id),
    'an effort auto-resolves after all evidence clears beyond the grace period');
  state = buddy.syncEffortObservations([critical]);
  t.ok(state.efforts.some(effort => effort.id === criticalEffort.id),
    'an automatically resolved effort reopens if its evidence returns');

  const memory = buddy.addItem({ title: 'Complete the rollout notes', detail: 'Capture the final outcome.' });
  state = buddy.syncEffortObservations([memory]);
  const memoryEffort = state.efforts.find(effort =>
    effort.observations.some(observation => observation.id === memory.id));
  buddy.updateEffort(memoryEffort.id, { status: 'done' });
  t.ok(!buddy.listItems().some(item => item.id === memory.id),
    'completing an effort also completes its underlying memory');
});

await t.test('effort APIs and UI route work-list actions through durable efforts', () => {
  const html = readFileSync(path.join(process.cwd(), 'public', 'dev-buddy.html'), 'utf8');
  const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  t.ok(/app\.put\('\/api\/dev-buddy\/efforts\/:id'/.test(server) &&
    /syncEffortObservations\(observations\)/.test(server),
  'status materializes durable efforts and exposes an effort update route');
  t.ok(/item\.effortId/.test(html) &&
    /\/api\/dev-buddy\/efforts\//.test(html) &&
    /status\?\.efforts/.test(html),
  'work-list actions and optimistic state updates include effort records');
  t.ok(/resolveModel\('execution', null\)/.test(server) &&
    /category: 'effort-classification'/.test(server),
  'effort classification uses the configured execution model');
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
t.done();
