import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  t.ok(/class="work-layout"/.test(html) && /id="itemDetail"/.test(html),
    'work items use navigation and detail panes');
  t.ok(/id="workSort"/.test(html) && /value="urgency"/.test(html) && /value="arrival"/.test(html),
    'work list exposes urgency and arrival sorting');
  t.ok(/id="hoverPreview"/.test(html) && /slice\(0, 5\)/.test(html),
    'hover preview is limited to the next five items');
  t.ok(!/data-view-target="catchup"/.test(html) && !/data-action="dismiss"/.test(html),
    'Catch up and work-item dismissal are removed');
});

await t.test('memory items persist, reprioritize, snooze, and complete', () => {
  const item = buddy.addItem({ title: 'Finish the review', detail: 'Two threads remain', priority: 'high' });
  t.eq(buddy.listItems()[0].title, 'Finish the review', 'new memory is returned from durable storage');
  buddy.updateItem(item.id, { priority: 'low', snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
  const snoozed = buddy.listItems().find(entry => entry.id === item.id);
  t.eq(snoozed.priority, 'low', 'priority update persists');
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

try { rmSync(dir, { recursive: true, force: true }); } catch {}
t.done();
