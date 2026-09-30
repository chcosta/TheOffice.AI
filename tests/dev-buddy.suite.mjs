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
  const app = readFileSync(path.join(process.cwd(), 'public', 'app.html'), 'utf8');
  const desktop = readFileSync(path.join(process.cwd(), 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const desktopPermissions = readFileSync(
    path.join(process.cwd(), 'desktop', 'src-tauri', 'permissions', 'app-commands.toml'),
    'utf8');
  t.ok(/class="work-layout"/.test(html) && /id="itemDetail"/.test(html),
    'work items use navigation and detail panes');
  t.ok(/id="workSort"/.test(html) && /value="urgency"/.test(html) && /value="arrival"/.test(html),
    'work list exposes urgency and arrival sorting');
  t.ok(/id="hoverPreview"/.test(html) && /class="preview-list"/.test(html),
    'quick view exposes the complete scrollable list');
  t.ok(/collapsedWorkSections = new Set/.test(html) &&
    /data-work-section="\$\{key\}"/.test(html) &&
    /dev-buddy-collapsed-sections/.test(html) &&
    /renderSection\('starred', 'Starred', starred\)[\s\S]*renderSection\('attention', 'Needs attention', active\)[\s\S]*renderSection\('ongoing', 'Ongoing', ongoing\)/.test(html),
  'full To-do list duplicates starred items into a leading section and remembers collapsed sections');
  t.ok(/id="previewTabs"/.test(html) &&
    /data-preview-tab="\$\{key\}"/.test(html) &&
    /dev-buddy-preview-tab/.test(html) &&
    /current\.entries\.map\(renderItem\)/.test(html),
  'quick To-do list separates attention, starred, and ongoing work into remembered tabs');
  t.ok(/repeat\(var\(--preview-action-count\), max-content\)/.test(html) &&
    /--preview-action-count: \$\{3 \+ Number\(item\.priority !== 'low'\) \+ Number\(!!item\.link\) \+ Number\(!!item\.route\)\}/.test(html),
  'quick To-do rows size their action grid dynamically so controls remain on one line');
  t.ok(/data-action="open-source"/.test(html) &&
    /data-action="open-office"/.test(html) &&
    /data-preview-action="open-source"/.test(html) &&
    /data-preview-action="open-office"/.test(html) &&
    /openItem\(item, 'source'\)/.test(html) &&
    /openItem\(item, 'office'\)/.test(html),
  'source URLs and TheOffice.AI routes have distinct actions in full and quick views');
  t.ok(/function resetPeekAfterAction\(\)/.test(html) &&
    /if \(action === 'done'\) await resetPeekAfterAction\(\)/.test(html),
  'completing a quick-view item resets the native peek window for its next opening');
  t.ok(/function renderWorkNotes\(item\)/.test(html) &&
    /function renderNotesMarkdown\(markdown, interactiveTasks = true\)/.test(html) &&
    /data-note-task-line/.test(html) &&
    /await saveItemNotes\(item/.test(html),
  'work items expose persistent Markdown notes with interactive task checkboxes');
  t.ok(/function renderNotesMarkdown\(markdown, interactiveTasks = true\)/.test(html) &&
    /class="context-text markdown"/.test(html) &&
    /renderNotesMarkdown\(section\.text, false\)/.test(html) &&
    /interactiveTasks \? `data-note-task-line/.test(html),
  'rich source context safely renders Markdown without turning source checkboxes into editable notes');
  t.ok(/"peek"\s*=>\s*\(peek_width\.unwrap_or\(400\)\.clamp\(340,\s*720\),\s*u32::MAX\)/.test(desktop) &&
    /max-height:\s*calc\(100vh - var\(--buddy-top\) - 242px\)/.test(html),
  'quick view uses the available monitor height');
  t.ok(/const pendingStarStates = new Map\(\)/.test(html) &&
    /const pendingOngoingStates = new Map\(\)/.test(html) &&
    /const pendingPriorityStates = new Map\(\)/.test(html) &&
    /preservePendingStates/.test(html),
  'status refreshes preserve optimistic stars, ongoing decisions, and priority until persistence is confirmed');
  t.ok(/class="buddy-window-control" id="minimizePixel"/.test(html) &&
    /class="buddy-window-control" id="closePixel"/.test(html) &&
    !/class="panel-minimize"/.test(html) &&
    /minimize_dev_buddy/.test(desktop) &&
    /"minimize_dev_buddy"/.test(desktopPermissions) &&
    /set_skip_taskbar\(false\)/.test(desktop),
  'Pixel exposes conventional hover minimize and close controls on the character');
  t.ok(!/id="quickPixel"/.test(html) &&
    !/id="fullPixel"/.test(html) &&
    /toggleQuickView\(\)/.test(html) &&
    /else \{\s*toggleQuickView\(\);\s*\}/.test(html) &&
    /openTodoAi\(item\.id\)/.test(html) &&
    !/addEventListener\('mouseenter', schedulePeek\)/.test(html) &&
    !/\$\('stage'\)\.addEventListener\('mouseleave'/.test(html),
  'Pixel itself opens the quick view and quick items deep-link to ToDo.AI');
  t.ok(/enableAndShowDevBuddy\(\)/.test(app) &&
    /'Show Pixel'/.test(app) &&
    /window\.unminimize\(\)/.test(desktop) &&
    /window\.set_focus\(\)/.test(desktop),
  'the SPA can enable and restore a minimized Pixel in one click');
  t.ok(/id="buddyContextMenu"/.test(html) &&
    /data-context-action="open"/.test(html) &&
    /data-context-action="scratchpad"/.test(html) &&
    /data-context-action="exit"/.test(html) &&
    /now - contextClickAt < 420/.test(html) &&
    /enabled: false/.test(html) &&
    /move_dev_buddy_aside/.test(desktop) &&
    /"move_dev_buddy_aside"/.test(desktopPermissions) &&
    /monitor_containing_anchor/.test(desktop),
  'right-click opens Pixel actions while double right-click moves Pixel aside');
  t.ok(/"scratchpad"\s*=>\s*\(560,\s*scratchpad_height\.unwrap_or\(560\)\.clamp\(420,\s*1200\)\)/.test(desktop) &&
    /scratchpad_height: Option<u32>/.test(desktop) &&
    /set_resizable\(mode != "peek" && mode != "scratchpad"\)/.test(desktop) &&
    /function openScratchpadFlyout\(\)/.test(html) &&
    /setMode\('scratchpad'\)/.test(html) &&
    /function scheduleScratchpadFlyoutResize\(delay = 60\)/.test(html) &&
    /setMode\('scratchpad', null, desiredHeight\)/.test(html) &&
    /input\.style\.overflowY = input\.scrollHeight > 360 \? 'auto' : 'hidden'/.test(html) &&
    /classList\.add\('open', 'scratchpad-flyout'\)/.test(html) &&
    /if \(!embedded\) return openTodoAi\(\)/.test(html) &&
    /restore_dev_buddy_floating', \{ workspace: panelOpen && !scratchpadFlyout \}/.test(html),
  'detached Scratchpad is a compact flyout while the full workspace remains exclusive to ToDo.AI');
  t.ok(/function finishBuddyDrag\(\)[\s\S]{0,180}buddyGesture = null;[\s\S]{0,180}manipulatingWindow = false;/.test(html) &&
    /\.then\(finishBuddyDrag\)/.test(html) &&
    /if \(wasDragging\) finishBuddyDrag\(\)/.test(html),
  'Pixel becomes interactive immediately when native dragging finishes');
  t.ok(/pageParams\.get\('embedded'\) === '1'/.test(html) &&
    /pageParams\.get\('item'\)/.test(html) &&
    /html\.embedded \.panel/.test(html) &&
    /if \(shouldHide && !embedded\)/.test(html) &&
    /id="embeddedLoading" hidden>Loading ToDo\.AI/.test(html) &&
    /if \(embedded\) \{[\s\S]{0,220}\$\('panel'\)\.classList\.add\('open'\)/.test(html) &&
    /load\(!embedded\)\.then/.test(html) &&
    /route === 'todo-ai'/.test(app) &&
    /dev-buddy\.html\?embedded=1&item=/.test(app) &&
    /class="todo-ai-frame-loading">Loading ToDo\.AI/.test(app) &&
    /onload="this\.parentElement\.classList\.add\('loaded'\)"/.test(app) &&
    /case 'todo-ai'/.test(app) &&
    /devbuddy: \['todo-ai'\]/.test(app),
  'ToDo.AI hosts the full Pixel workspace with direct item selection');
  t.ok(/id="peekNarrower"/.test(html) &&
    /id="peekAutoWidth"/.test(html) &&
    /id="peekWider"/.test(html) &&
    /function automaticPeekWidth/.test(html) &&
    /dev-buddy-peek-width-mode/.test(html) &&
    /peek_width: Option<u32>/.test(desktop) &&
    /set_resizable\(mode != "peek" && mode != "scratchpad"\)/.test(desktop) &&
    !/"start_dev_buddy_resize"/.test(desktopPermissions),
  'the quick view offers persistent narrower, auto-width, and wider controls instead of manual edge resizing');
  t.ok(/set_dev_buddy_topmost\(&window, !workspace\)/.test(desktop) &&
    /set_dev_buddy_topmost\(&window, true\)/.test(desktop) &&
    /if topmost \{ -1isize \} else \{ -2isize \}/.test(desktop) &&
    /set_skip_taskbar\(!workspace\)/.test(desktop) &&
    /restore_dev_buddy_floating', \{ workspace: panelOpen && !scratchpadFlyout \}/.test(html),
  'detached Pixel flyouts remain always on top without restoring as a full workspace');
  t.ok(!/data-view-target="catchup"/.test(html) && !/data-action="dismiss"/.test(html),
    'Catch up and work-item dismissal are removed');
});

await t.test('reading pane builds grounded dossiers and optional AI plans', () => {
  const html = readFileSync(path.join(process.cwd(), 'public', 'dev-buddy.html'), 'utf8');
  const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const github = readFileSync(path.join(process.cwd(), 'github.js'), 'utf8');
  t.ok(/data-detail-tab="details"/.test(html) &&
    /data-detail-tab="tracking"/.test(html) &&
    /data-detail-tab="evidence"/.test(html) &&
    /renderSourceContext/.test(html) &&
    /renderSourceContext\(selected, 'details'\)/.test(html),
  'rich source context and Pixel guidance share Details while tracking and grouped evidence remain separate');
  t.ok(/data-view-target="work">To-do<\/button>/.test(html) &&
    /hover-preview-head">To-do/.test(html) &&
    /quick-ongoing/.test(html) &&
    /data-preview-action="ongoing"/.test(html) &&
    /data-preview-action="priority-down"/.test(html),
  'the To-do navigation and quick flyout expose ongoing and lower-priority actions');
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

await t.test('Outlook compose coaching is live, local, and user-controlled', () => {
  const pane = readFileSync(path.join(process.cwd(), 'public', 'outlook-compose.html'), 'utf8');
  const manifest = readFileSync(path.join(process.cwd(), 'outlook-addin', 'manifest.xml'), 'utf8');
  const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const composeWorker = readFileSync(path.join(process.cwd(), 'compose-coach-worker.js'), 'utf8');
  t.ok(/Office\.onReady/.test(pane) &&
    /mailbox\.item/.test(pane) &&
    /Office\.CoercionType\.Text/.test(pane) &&
    /setInterval\(poll, 1000\)/.test(pane),
  'the task pane watches only the active Outlook compose draft');
  t.ok(/\/api\/dev-buddy\/compose\/rewrite/.test(pane) &&
    /Apply rewrite/.test(pane) &&
    /Copy rewrite/.test(pane) &&
    /Strengthen this message before sending/.test(pane) &&
    /result\.gaps/.test(pane) &&
    /draftSections\(draft\.html, draft\.body\)/.test(pane) &&
    /body\.setAsync/.test(pane) &&
    /range\.setStartBefore\(boundary\)/.test(pane) &&
    /range\.cloneContents\(\)/.test(pane) &&
    /#_MailAutoSig/.test(pane) &&
    /#divRplyFwdMsg/.test(pane) &&
    /The draft changed after this suggestion/.test(pane),
  'live suggestions replace authored content, preserve marked signatures and threads, and refuse stale updates');
  t.ok(/app\.post\('\/api\/dev-buddy\/compose\/rewrite'/.test(server) &&
    /_devBuddyIsLoopbackRequest/.test(server) &&
    /category: 'compose-coach'/.test(composeWorker) &&
    /unsupported conclusions/.test(server) &&
    /missing rationale or examples/.test(server) &&
    /gaps:\s*\(Array\.isArray\(parsed\.gaps\)/.test(server) &&
    /record: false/.test(composeWorker),
  'draft coaching evaluates message strength, stays local, and is excluded from recorded chat history');
  t.ok(/<Permissions>ReadWriteMailbox<\/Permissions>/.test(manifest) &&
    /https:\/\/localhost:3849\/public\/outlook-compose\.html/.test(manifest) &&
    /VersionOverridesV1_1/.test(manifest) &&
    /MessageComposeCommandSurface/.test(manifest) &&
    /SupportsPinning>true/.test(manifest),
  'the Outlook add-in is compose-only, pinnable, and requests read-only item access');
  t.ok(/bindOutlookAddinHttps/.test(server) &&
    /\.office-addin-dev-certs/.test(server) &&
    /createServer/.test(server),
  'the desktop sidecar exposes the task pane through trusted loopback HTTPS');
  const pixel = readFileSync(path.join(process.cwd(), 'public', 'dev-buddy.html'), 'utf8');
  t.ok(/data-view-target="setup"/.test(pixel) &&
    /Install or update automatically/.test(pixel) &&
    /copyOutlookManifest/.test(pixel) &&
    /app\.get\('\/api\/dev-buddy\/compose\/setup'/.test(server) &&
    /app\.post\('\/api\/dev-buddy\/compose\/install'/.test(server) &&
    !/uninstall -i false --mode manifest-id/.test(server) &&
    /@microsoft\/m365agentstoolkit-cli@1\.1\.17/.test(server),
  'Pixel keeps a discoverable New Outlook walkthrough with automatic and manual installation');
  t.ok(/data-view-target="scratchpad"/.test(pixel) &&
    /id="scratchpadInput"/.test(pixel) &&
    /Strengthen this message/.test(pixel) &&
    /\/api\/dev-buddy\/compose\/rewrite/.test(pixel) &&
    /dev-buddy-scratchpad/.test(pixel) &&
    /Copy plain text/.test(pixel),
  'Pixel exposes a persistent scratchpad that reuses the full Outlook coaching contract');
  t.ok(/function scheduleScratchpadReview\(delay = 900\)/.test(pixel) &&
    /new AbortController\(\)/.test(pixel) &&
    /signal: controller\.signal/.test(pixel) &&
    /mode: 'scratchpad'/.test(pixel) &&
    /scheduleScratchpadReview\(350\)/.test(pixel) &&
    /quickScratchpadReview\(body\)/.test(pixel) &&
    /new Worker\(path\.join\(__dirname, 'compose-coach-worker\.js'\)/.test(server) &&
    /worker\.terminate\(\)/.test(server),
  'the scratchpad shows an immediate scan, reviews automatically, and isolates deeper coaching');
  t.ok(/id="scratchpadCopyFormat"/.test(pixel) &&
    /markdownToPlainText\(scratchpadRewrite\)/.test(pixel) &&
    /scratchpadRewriteHtml\(\)/.test(pixel) &&
    /renderNotesMarkdown\(scratchpadRewrite\)/.test(pixel) &&
    /replace\(\/\\r\?\\n\/g, '\\r\\n'\)/.test(pixel) &&
    /message-strength-v3-markdown/.test(server) &&
    /Preserve meaningful paragraph breaks/.test(server),
  'Scratchpad renders Markdown and copies plain text, Markdown, or HTML without collapsing paragraphs');
});

await t.test('memory items persist, reprioritize, snooze, and complete', () => {
  const item = buddy.addItem({ title: 'Finish the review', detail: 'Two threads remain', priority: 'high' });
  t.eq(buddy.listItems()[0].title, 'Finish the review', 'new memory is returned from durable storage');
  buddy.updateItem(item.id, { priority: 'low', starred: true, snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
  const snoozed = buddy.listItems().find(entry => entry.id === item.id);
  t.eq(snoozed.priority, 'low', 'priority update persists');
  t.ok(snoozed.starred, 'starred state persists');
  t.ok(snoozed.snoozed, 'future snooze is active');
  buddy.updateItem(item.id, { notes: '# Progress\n- [ ] Verify the fix' });
  t.eq(buddy.listItems()[0].notes, '# Progress\n- [ ] Verify the fix',
    'work-item Markdown notes persist verbatim');
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
    message: 'Could you confirm whether the launch is still scheduled for Friday?\n\nThanks,\nAdele',
    sender: 'Adele <adele@example.com>',
    subject: 'Launch timing',
    sentAt: '2026-09-25T09:58:00Z',
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
  t.ok(item.message.includes('launch is still scheduled') && item.message.includes('\n\nThanks'),
    'email message text is retained with readable paragraph breaks');
  t.eq(item.sender, 'Adele <adele@example.com>', 'email sender metadata survives a weaker refresh');
  t.eq(item.subject, 'Launch timing', 'email subject survives a weaker refresh');
  buddy.enrichCommitment(item.id, {
    message: 'Updated source message.\n\nPlease reply today.',
    sender: 'Adele <adele@example.com>',
  });
  t.ok(buddy.listCommitments().find(entry => entry.id === item.id).message.includes('Please reply today'),
    'lazy source retrieval can enrich an existing commitment');
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
    priority: 'high',
    urgency: buddy.deriveUrgency({ priority: 'high' }),
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
  t.eq(effort.urgency.level, 'high', 'high-priority evidence initially surfaces high urgency');

  buddy.updateEffort(effort.id, { priority: 'normal', urgencyScore: 1 });
  const lowered = buddy.syncEffortObservations([first, second]).efforts.find(entry => entry.id === effort.id);
  t.eq(lowered.urgency.level, 'medium', 'lowering priority immediately lowers visible urgency by one level');
  t.eq(lowered.urgencyOverrideScore, 1, 'materialized efforts identify explicit user urgency overrides');
  t.eq(lowered.urgency.reason, 'Lowered by you.', 'the user urgency choice survives observation synchronization');
  const stalePriorityStore = JSON.parse(readFileSync(path.join(dir, 'dev-buddy.json'), 'utf8'));
  const stalePriorityEffort = stalePriorityStore.efforts.find(entry => entry.id === effort.id);
  stalePriorityEffort.priority = 'high';
  stalePriorityEffort.urgencyOverrideScore = null;
  delete stalePriorityEffort.priorityUpdatedAt;
  writeFileSync(path.join(dir, 'dev-buddy.json'), JSON.stringify(stalePriorityStore, null, 2));
  t.eq(
    buddy.syncEffortObservations([first, second]).efforts.find(entry => entry.id === effort.id).urgency.level,
    'medium',
    'a stale concurrent server write cannot erase the separate durable priority decision'
  );

  buddy.updateEffort(effort.id, { ongoing: true, starred: true });
  const ongoing = buddy.syncEffortObservations([first, second]).efforts.find(entry => entry.id === effort.id);
  t.ok(ongoing.ongoing, 'ongoing acknowledgement survives observation synchronization');
  t.ok(!ongoing.semanticAttention, 'ongoing work remains visible without requesting Pixel attention');
  t.ok(ongoing.starred, 'ongoing work can remain pinned');
  const persistedOngoing = JSON.parse(readFileSync(path.join(dir, 'dev-buddy.json'), 'utf8'))
    .efforts.find(entry => entry.id === effort.id);
  t.ok(persistedOngoing.ongoingUpdatedAt,
    'ongoing acknowledgement records a durable decision timestamp for concurrent refreshes');
  const staleStore = JSON.parse(readFileSync(path.join(dir, 'dev-buddy.json'), 'utf8'));
  const staleEffort = staleStore.efforts.find(entry => entry.id === effort.id);
  staleEffort.ongoing = false;
  delete staleEffort.ongoingUpdatedAt;
  writeFileSync(path.join(dir, 'dev-buddy.json'), JSON.stringify(staleStore, null, 2));
  t.ok(buddy.syncEffortObservations([first, second]).efforts.find(entry => entry.id === effort.id).ongoing,
    'a stale concurrent server write cannot erase the separate durable ongoing decision');
  buddy.updateEffort(effort.id, { ongoing: false });
  t.ok(!buddy.syncEffortObservations([first, second]).efforts.find(entry => entry.id === effort.id).ongoing,
    'ongoing work can return to the attention list');

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

await t.test('user-separated evidence is re-triaged without being regrouped', () => {
  const observations = [
    {
      id: 'separation-pr-a',
      reminderKey: 'separation-pr-a',
      kind: 'pull-request',
      title: 'Review queue depth anomaly alert',
      detail: 'Review the queue depth alert change.',
      source: 'Code Flow',
      trackedAt: '2026-09-27T08:00:00Z',
    },
    {
      id: 'separation-pr-b',
      reminderKey: 'separation-pr-b',
      kind: 'pull-request',
      title: 'Reject duplicate JSON properties',
      detail: 'Review an unrelated test utility change.',
      source: 'Code Flow',
      trackedAt: '2026-09-27T08:05:00Z',
    },
  ];
  let state = buddy.syncEffortObservations(observations);
  const ids = observations.map(observation => state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observation.reminderKey)).id);
  buddy.applyEffortClassification([{
    provisionalIds: ids,
    targetEffortId: '',
    title: 'Review queue depth changes',
    summary: 'Review both proposed changes.',
    confidence: 0.95,
    reason: 'Initially classified together.',
  }]);
  state = buddy.syncEffortObservations(observations);
  const grouped = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observations[0].reminderKey));
  t.eq(grouped.observations.length, 2, 'setup groups both observations');

  const separated = buddy.detachEffortObservation(grouped.id, observations[1].reminderKey);
  t.eq(separated.effort.observations.length, 1, 'unrelated evidence leaves the original effort');
  t.eq(separated.detached.observations.length, 1, 'unrelated evidence becomes a separate provisional effort');
  t.ok(separated.effort.provisional && separated.detached.provisional,
    'both sides return to classification for corrected titles and summaries');
  t.eq(separated.effort.title, observations[0].title,
    'the original effort immediately drops the stale combined title');

  const keptPending = buddy.getEffortClassificationState().pending.find(entry =>
    entry.id === separated.effort.id);
  buddy.applyEffortClassification([{
    provisionalIds: [separated.effort.id],
    targetEffortId: '',
    title: 'Stale title from the removed evidence',
    summary: 'Stale summary from an in-flight classification.',
    confidence: 0.98,
    reason: 'Old model response.',
  }], [{
    id: separated.effort.id,
    evidenceEpoch: keptPending.evidenceEpoch - 1,
  }]);
  state = buddy.syncEffortObservations(observations);
  const afterStaleResult = state.efforts.find(effort => effort.id === separated.effort.id);
  t.ok(afterStaleResult.provisional, 'a classification started before separation cannot cancel re-triage');
  t.eq(afterStaleResult.title, observations[0].title, 'a stale classification cannot restore the removed title');

  buddy.applyEffortClassification([{
    provisionalIds: [separated.effort.id, separated.detached.id],
    targetEffortId: '',
    title: 'Incorrectly regrouped reviews',
    summary: 'The classifier tried to restore the old association.',
    confidence: 0.99,
    reason: 'Model retry.',
  }]);
  state = buddy.syncEffortObservations(observations);
  const first = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observations[0].reminderKey));
  const second = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observations[1].reminderKey));
  t.ok(first.id !== second.id, 'a user-marked unrelated pair cannot be merged again');
  t.eq(first.context.classificationReason, 'Kept separate because you marked this evidence unrelated.',
    'the retained effort explains why the classifier kept the evidence separate');
});

await t.test('users can manually combine duplicate efforts', () => {
  const observations = [
    {
      id: 'manual-merge-pr',
      reminderKey: 'manual-merge-pr',
      kind: 'pull-request',
      title: 'Autoscaler rollout change',
      detail: 'Review the rollout PR.',
      source: 'Code Flow',
      trackedAt: '2026-09-28T08:00:00Z',
    },
    {
      id: 'manual-merge-email',
      reminderKey: 'manual-merge-email',
      kind: 'email',
      title: 'Coordinate autoscaler rollout',
      detail: 'Coordinate deployment timing.',
      source: 'Outlook',
      trackedAt: '2026-09-28T08:10:00Z',
    },
  ];
  let state = buddy.syncEffortObservations(observations);
  const source = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === 'manual-merge-email'));
  const target = state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === 'manual-merge-pr'));
  buddy.updateEffort(source.id, { notes: '- [ ] Follow up with deployment owners', starred: true });
  const result = buddy.mergeEfforts(source.id, target.id);
  t.eq(result.target.id, target.id, 'the drop target keeps its identity');
  t.eq(result.target.observations.length, 2, 'source evidence moves into the target');
  t.ok(result.target.notes.includes('Follow up with deployment owners') && result.target.starred,
    'source notes and star state survive the merge');
  state = buddy.syncEffortObservations(observations);
  t.eq(state.efforts.filter(effort =>
    effort.observations.some(entry => ['manual-merge-pr', 'manual-merge-email'].includes(entry.key))).length, 1,
  'future observation sync preserves the manual grouping');
});

await t.test('established efforts with equivalent objectives are reconciled', () => {
  const observations = [
    {
      id: 'equivalent-rca-long',
      reminderKey: 'equivalent-rca-long',
      kind: 'meeting',
      title: 'Formalize the root cause analysis process',
      detail: 'Update the RCA process documentation.',
      source: 'Meeting',
      trackedAt: '2026-09-28T08:00:00Z',
    },
    {
      id: 'equivalent-rca-short',
      reminderKey: 'equivalent-rca-short',
      kind: 'teams',
      title: 'Formalize the team RCA process',
      detail: 'Get team agreement on the updated process.',
      source: 'Teams',
      trackedAt: '2026-09-28T08:10:00Z',
    },
  ];
  let state = buddy.syncEffortObservations(observations);
  const ids = observations.map(observation => state.efforts.find(effort =>
    effort.observations.some(entry => entry.key === observation.reminderKey)).id);
  buddy.applyEffortClassification(ids.map((id, index) => ({
    provisionalIds: [id],
    targetEffortId: '',
    title: observations[index].title,
    summary: observations[index].detail,
    confidence: 1,
    reason: 'Initially classified in separate batches.',
  })));
  const merged = buddy.reconcileEquivalentEfforts();
  t.ok(merged.some(result => ids.includes(result.sourceId) || ids.includes(result.target.id)),
    'equivalent established objectives are reconsidered and merged');
  state = buddy.syncEffortObservations(observations);
  t.eq(state.efforts.filter(effort =>
    effort.observations.some(entry => entry.key.startsWith('equivalent-rca-'))).length, 1,
  'RCA and root cause analysis remain grouped after synchronization');
});

await t.test('completed efforts ignore refresh-only presentation changes', () => {
  const observation = {
    id: 'sticky-completion-build',
    reminderKey: 'sticky-completion-build',
    kind: 'build',
    title: 'Validate the deployment build',
    detail: 'The build needs review.',
    source: 'Builds',
    link: 'https://example.test/build/1',
    trackedAt: '2026-09-28T08:00:00Z',
    context: { state: 'running', buildId: 'build-1' },
  };
  let state = buddy.syncEffortObservations([observation]);
  const effort = state.efforts.find(entry =>
    entry.observations.some(item => item.key === observation.reminderKey));
  buddy.applyEffortClassification([{
    provisionalIds: [effort.id],
    targetEffortId: '',
    title: observation.title,
    summary: observation.detail,
    confidence: 1,
    reason: 'Keep as a distinct build effort.',
  }]);
  buddy.updateEffort(effort.id, { status: 'done' });
  state = buddy.syncEffortObservations([{
    ...observation,
    title: 'Validate the refreshed deployment build',
    detail: 'Required: Review the same build. Why now: Tracked for one week.',
    link: 'https://example.test/build/1?refreshed=1',
  }]);
  t.ok(!state.efforts.some(entry => entry.id === effort.id),
    'refreshed wording and links do not reopen user-completed work');
  state = buddy.syncEffortObservations([{
    ...observation,
    context: { state: 'failed', buildId: 'build-1' },
  }]);
  t.ok(state.efforts.some(entry => entry.id === effort.id),
    'a real lifecycle change can reopen completed work');

  buddy.updateEffort(effort.id, { status: 'done' });
  const storePath = path.join(dir, 'dev-buddy.json');
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const storedEffort = store.efforts.find(entry => entry.id === effort.id);
  storedEffort.status = 'open';
  delete storedEffort.completionReopenPolicyVersion;
  delete storedEffort.completedAt;
  writeFileSync(storePath, JSON.stringify(store, null, 2));
  state = buddy.syncEffortObservations([{
    ...observation,
    detail: 'Required: Review the same failed build. Why now: Refreshed just now.',
    context: { state: 'failed', buildId: 'build-1' },
  }]);
  t.ok(!state.efforts.some(entry => entry.id === effort.id),
    'legacy refresh-reopened work is repaired from its completion activity');
});

await t.test('efforts preserve urgency, reconcile cleared evidence, and complete source records', () => {
  const critical = {
    id: 'effort-critical-signal',
    reminderKey: 'effort-critical-signal',
    kind: 'pull-request',
    title: 'Restore blocked production rollout',
    detail: 'Required checks are failing.',
    source: 'GitHub',
    route: '#/codeflow',
    trackedAt: new Date().toISOString(),
    urgency: { score: 1, level: 'medium', label: 'Medium', reason: 'Waiting for semantic analysis.' },
    semanticAttention: true,
    context: {
      provider: 'azdo',
      org: 'dnceng',
      project: 'internal',
      repo: 'example',
      prNumber: 42,
    },
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
  t.eq(criticalEffort.route, '#/codeflow/dnceng%7Cinternal%7Cexample%7C42',
    'PR efforts derive an exact Code Flow route from source identity');
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
  const collector = readFileSync(
    path.join(process.cwd(), 'builtin-plugins', 'connect', 'agents', 'dev-buddy-collector.agent.md'),
    'utf8');
  t.ok(/app\.put\('\/api\/dev-buddy\/efforts\/:id'/.test(server) &&
    /syncEffortObservations\(observations\)/.test(server) &&
    /const hasUrgencyOverride = Number\.isFinite/.test(server),
  'status materializes durable efforts and exposes an effort update route');
  t.ok(/route: `#\/codeflow\/\$\{encodeURIComponent\(_cfWtKey/.test(server) &&
    /fn\('open_main_window', \{ target: item\.route \}\)/.test(html),
  'PR work opens the exact Code Flow card through the native TheOffice.AI window');
  t.ok(/item\.effortId/.test(html) &&
    /\/api\/dev-buddy\/efforts\//.test(html) &&
    /status\?\.efforts/.test(html),
  'work-list actions and optimistic state updates include effort records');
  t.ok(/data-evidence-unrelated/.test(html) &&
    /evidence\/unrelated/.test(html) &&
    /app\.post\('\/api\/dev-buddy\/efforts\/:id\/evidence\/unrelated'/.test(server),
  'connected evidence can be marked unrelated and sent back through triage');
  t.ok(/function mergeWorkItems\(sourceId, targetId\)/.test(html) &&
    /classList\.add\('merge-target'\)/.test(html) &&
    /class="drag-bar"/.test(html) &&
    /classList\.add\('drag-ghost'\)/.test(html) &&
    /function optimisticMerge\(sourceId, targetId, mergedEffort\)/.test(html) &&
    /setTimeout\(\(\) => load\(\), 900\)/.test(html) &&
    !/mergeWorkItems[\s\S]{0,1200}await load\(true\)/.test(html) &&
    /app\.post\('\/api\/dev-buddy\/efforts\/:id\/merge'/.test(server),
  'dragging one work item onto another uses a grab bar and completes optimistically without a full refresh');
  t.ok(/reconcileEquivalentEfforts\(\)/.test(server) &&
    /RCA and root cause analysis/.test(server),
  'established effort duplicates are reconciled and the classifier recognizes acronym paraphrases');
  t.ok(/resolveModel\('execution', null\)/.test(server) &&
    /category: 'effort-classification'/.test(server),
  'effort classification uses the configured execution model');
  t.ok(/title: 'Email message'/.test(server) &&
    /context\.message/.test(server) &&
    /_devBuddyHydrateCommitmentMessage/.test(server) &&
    /value = await _devBuddyCommitmentContext\(item\)/.test(server) &&
    /Every returned item MUST include `message`/.test(collector),
  'email evidence retains, lazily retrieves, and displays the source message instead of relying on its link');
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
t.done();
