import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('manual-todo');
const html = readFileSync('public/dev-buddy.html', 'utf8');

function todoContext(request) {
  const input = { value: '  Follow up on deployment  ', focus() {}, addEventListener() {} };
  const submit = {};
  const cancel = { addEventListener() {} };
  const message = { textContent: '', classList: { add() {}, remove() {} } };
  const form = {
    elements: { title: input },
    querySelector: selector => selector === '[type="submit"]' ? submit
      : selector === '[data-cancel-todo]' ? cancel : message,
    addEventListener() {},
  };
  const context = {
    request, todoSaving: false, pendingManualTodoId: '',
    document: { querySelectorAll: selector => selector === '[data-todo-entry]' ? [form] : [] },
    load: async () => {}, schedulePeekResize() {},
  };
  const start = html.indexOf('      function toggleTodoEntry(');
  const end = html.indexOf("      $('composer').addEventListener", start);
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return { context, form, input, submit, message, event: { preventDefault() {}, currentTarget: form } };
}

await t.test('both the embedded list and Pixel quick view expose a dedicated manual-add form', () => {
  t.ok(html.includes('data-add-todo="todoEntry"') && html.includes('data-add-todo="quickTodoEntry"'));
  t.eq((html.match(/data-todo-entry hidden/g) || []).length, 2);
  t.ok(html.includes('maxlength="160"') && html.includes("event.key === 'Escape'"));
  t.ok(html.includes('tabsHeight + entryHeight + listHeight'),
    'quick-view geometry includes the expanded form');
  t.ok(html.includes("request('/api/dev-buddy/chat'"), 'Ask Pixel remains a separate action');
});

await t.test('manual add persists directly without invoking an assistant', async () => {
  const requests = [];
  const ui = todoContext(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { item: { id: 'new-todo' } };
  });
  await ui.context.addManualTodo(ui.event);
  t.deep(requests, [{ url: '/api/dev-buddy/items', body: { title: 'Follow up on deployment', source: 'You' } }]);
  t.eq(ui.input.value, '');
  t.eq(ui.context.pendingManualTodoId, 'new-todo');
  t.eq(ui.message.textContent, 'Added to your to-do list.');
});

await t.test('manual add rejects blank input and coalesces repeated submits while saving', async () => {
  let release;
  let calls = 0;
  const ui = todoContext(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  ui.input.value = '   ';
  await ui.context.addManualTodo(ui.event);
  t.eq(calls, 0);
  ui.input.value = 'Remember this';
  const first = ui.context.addManualTodo(ui.event);
  t.ok(ui.input.disabled && ui.submit.disabled);
  await ui.context.addManualTodo(ui.event);
  t.eq(calls, 1);
  release({ item: { id: 'one' } });
  await first;
  t.notOk(ui.input.disabled);
});

await t.test('failed manual saves keep the draft, display the error, and allow retry', async () => {
  const ui = todoContext(async () => { throw new Error('Server unavailable'); });
  await ui.context.addManualTodo(ui.event);
  t.eq(ui.input.value, '  Follow up on deployment  ');
  t.eq(ui.message.textContent, 'Server unavailable');
  t.notOk(ui.submit.disabled);
  t.notOk(ui.context.todoSaving);
});

const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-task-types-'));
process.env.SUPERVISOR_DATA_DIR = dir;
const require = createRequire(import.meta.url);
const settings = require(path.join(process.cwd(), 'settings.js'));

try {
  await t.test('new task creation uses Task and leaves the initial workflow state to Azure DevOps', () => {
    t.eq(settings.DEFAULTS.meAiWorkItemType, 'Task');
    t.eq(settings.DEFAULTS.meAiWorkItemState, '');
    t.eq(settings.normalizeWorkItemType(' DNCEng Task '), 'Task');
    t.eq(settings.normalizeWorkItemType('DNCENG Task'), 'Task');
    t.eq(settings.normalizeWorkItemType('Epic'), 'Epic', 'non-task hierarchy types remain unchanged');
  });

  await t.test('persisted legacy task settings and automation rules migrate on read and save', () => {
    writeFileSync(settings.SETTINGS_PATH, JSON.stringify({
      meAiWorkItemType: 'DNCeng Task', meAiWorkItemState: 'Backlog',
      devAutoCreateRules: [{ id: 'legacy', type: 'DNCEng Task', state: 'Dev', areaPath: 'Existing area' }],
    }));
    const migrated = settings.reload();
    t.eq(migrated.meAiWorkItemType, 'Task');
    t.eq(migrated.meAiWorkItemState, '');
    t.eq(migrated.devAutoCreateRules[0].workItemType, 'Task');
    t.eq(migrated.devAutoCreateRules[0].type, 'Task');
    t.eq(migrated.devAutoCreateRules[0].state, 'Active');
    t.eq(migrated.devAutoCreateRules[0].areaPath, 'Existing area');
    settings.updateSettings({ meAiWorkItemType: 'DNCEng Task', meAiWorkItemState: 'Dev' });
    const saved = JSON.parse(readFileSync(settings.SETTINGS_PATH, 'utf8'));
    t.eq(saved.meAiWorkItemType, 'Task');
    t.eq(saved.meAiWorkItemState, '');
  });

  await t.test('the creation API canonicalizes legacy task requests before contacting Azure DevOps', async () => {
    const source = readFileSync('azdo.js', 'utf8');
    const start = source.indexOf('async function createWorkItem(');
    const end = source.indexOf("// Fetch a pull request's status.", start);
    let captured;
    const context = {
      module: { exports: {} },
      require: () => settings,
      seg: encodeURIComponent, API_VERSION: '7.1',
      workItemUrl: () => 'https://example.test/workitem/1',
      apiSend: async (org, url, options) => {
        captured = { url, body: options.body };
        return { id: 1, fields: { 'System.WorkItemType': 'Task' } };
      },
    };
    vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = createWorkItem;', context);
    const result = await context.module.exports('org', 'project', 'DNCEng Task', { title: 'A real task', state: 'Backlog' });
    t.ok(captured.url.includes('%24Task?'));
    t.notOk(captured.body.some(field => field.path === '/fields/System.State'));
    t.eq(result.type, 'Task');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const result = await t.done();
if (result.fail) process.exitCode = 1;
