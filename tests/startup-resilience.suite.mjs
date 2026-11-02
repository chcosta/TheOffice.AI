import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('startup-resilience');
const server = readFileSync('server.js', 'utf8');
const supervisor = readFileSync('supervisor.js', 'utf8');
const html = readFileSync('public/app.html', 'utf8');

await t.test('unchanged agent registrations perform no database writes', () => {
  const method = supervisor.slice(supervisor.indexOf('  register(config) {'), supervisor.indexOf('  start(agentId,'));
  const register = vm.runInNewContext(`({ ${method} }).register`, { process: { env: {} } });
  let writes = 0;
  let row = { schedule: 'never' };
  const context = {
    agents: new Map(),
    db: { prepare: () => ({ get: () => row, run: () => { writes++; } }) },
  };
  register.call(context, { id: 'one', schedule: 'never', name: 'Initial' });
  register.call(context, { id: 'one', schedule: 'never', name: 'Changed name' });
  t.eq(writes, 0);
  t.eq(context.agents.get('one').config.name, 'Changed name');
  row = null;
  register.call(context, { id: 'two', schedule: 'never' });
  t.eq(writes, 1, 'a new agent still persists its state');
  row = { schedule: 'daily' };
  const config = { id: 'two', schedule: 'never' };
  register.call(context, config);
  t.eq(config.schedule, 'daily', 'persisted schedule still takes precedence');
});

await t.test('agent watcher ignores metadata and unrelated database events but detects atomic replacements', async () => {
  const start = server.indexOf('let _reloadTimer = null;');
  const end = server.indexOf('// Express app', start);
  let notify;
  let scheduled;
  let reloads = 0;
  let agents = [{ id: 'one', schedule: 'never' }];
  const sandbox = {
    path,
    AGENTS_PATH: path.join('data', 'agents.json'),
    _loadedAgentsSignature: JSON.stringify(agents),
    fs: { watch: (dir, callback) => {
      t.eq(dir, 'data', 'watch the directory so atomic rename does not detach the watcher');
      notify = callback;
    } },
    setTimeout: callback => { scheduled = callback; return 1; },
    clearTimeout: () => {},
    readAgentsFileAsync: async () => agents,
    loadAgents: value => { reloads++; sandbox._loadedAgentsSignature = JSON.stringify(value); },
    configSync: { enabled: false },
    console: { log() {}, error: (...args) => t.fail(args.join(' ')) },
  };
  vm.runInNewContext(server.slice(start, end), sandbox);
  notify('change', 'supervisor.db');
  t.eq(scheduled, undefined, 'database writes never schedule agent reloads');
  notify('change', 'agents.json');
  await scheduled();
  t.eq(reloads, 0, 'unchanged content never re-registers agents');
  agents = [{ id: 'two', schedule: 'never' }];
  notify('rename', 'agents.json');
  await scheduled();
  t.eq(reloads, 1, 'a replacement with changed content reloads');
  notify('change', 'agents.json');
  await scheduled();
  t.eq(reloads, 1, 'duplicate replacement notifications are harmless');
});

function refreshMethods() {
  const start = html.indexOf('        async loadVersion() {');
  const end = html.indexOf('        normalizeAgent(agent) {', start);
  return vm.runInNewContext(`({${html.slice(start, end)}})`, { console: { warn() {} } });
}

await t.test('installed version loads even when an unrelated bootstrap request fails', async () => {
  const methods = refreshMethods();
  let updater = 0;
  const context = {
    ...methods,
    data: {},
    requestResilient: async url => {
      t.eq(url, '/api/version');
      return { version: '1.0.5-preview.769', desktop: true };
    },
    request: async () => { throw new Error('agents timed out'); },
    initUpdater: () => { updater++; },
    maybeShowWhatsNew() {},
    showToast() {},
  };
  await context.refreshAll();
  t.eq(context.data.version.version, '1.0.5-preview.769');
  t.eq(updater, 1);
  t.eq(context.errorMessage, 'agents timed out', 'bootstrap failure remains visible');
});

await t.test('failed version refresh preserves the last verified version and reports the error', async () => {
  const methods = refreshMethods();
  const messages = [];
  const context = {
    ...methods,
    data: { version: { version: '1.0.5-preview.769' } },
    requestResilient: async () => { throw new Error('timed out'); },
    showToast: (...args) => messages.push(args),
  };
  await context.loadVersion();
  t.eq(context.data.version.version, '1.0.5-preview.769');
  t.eq(messages[0][0], 'Version check failed');
});

await t.test('cached desktop provisioning checks actual content, including its manifest', () => {
  const rust = readFileSync('desktop/src-tauri/src/main.rs', 'utf8');
  t.ok(rust.includes('let manifest = file_fp(&server_dir.join("server-manifest.json"));'));
  t.ok(rust.includes('&& server_fingerprint(&dir.join("server")) == want_fp'),
    'a matching .provisioned marker cannot hide stale runtime files');
});

await t.test('slow CLI status probes run off-thread, coalesce reads, and preserve explicit failures', async () => {
  const workers = [];
  class ProbeWorker extends EventEmitter {
    constructor() { super(); this.messages = []; workers.push(this); }
    ref() {}
    unref() {}
    postMessage(message) { this.messages.push(message); }
    async terminate() { this.emit('exit', 0); }
  }
  const sandbox = {
    module: { exports: {} },
    __filename: 'status-probes.js',
    require: name => {
      t.eq(name, 'worker_threads');
      return { Worker: ProbeWorker, isMainThread: true };
    },
    setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(readFileSync('status-probes.js', 'utf8'), sandbox);
  const { runProbe } = sandbox.module.exports;
  const first = runProbe('azdo', 'getSignInStatus');
  const second = runProbe('azdo', 'getSignInStatus');
  t.eq(first, second, 'concurrent reads share one CLI check');
  t.eq(workers[0].messages.length, 1);
  workers[0].emit('message', { id: workers[0].messages[0].id, value: { connected: true } });
  t.ok((await first).connected);
  const changedAccount = runProbe('azdo', 'getSignInStatus');
  t.eq(workers.length, 2, 'next auth check gets fresh credentials/settings');
  const failed = changedAccount.then(() => t.fail('expected a probe error'), error => error.message);
  workers[1].emit('message', { id: workers[1].messages[0].id, error: 'CLI unavailable' });
  t.eq(await failed, 'CLI unavailable');
  t.ok(server.includes("await runProbe('github', 'getStatus')") &&
       server.includes("await runProbe('azdo', 'getSignInStatus')") &&
       server.includes("await runProbe('agentDeps', 'list')"),
    'all three measured blocking status endpoints use workers');
});

await t.test('Pixel scans session files asynchronously and keeps its eight-session bound', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stats = 0;
  let closed = 0;
  const code = readFileSync('session-signals.js', 'utf8');
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => 'name: Session\nclient_name: github/autopilot\n',
    promises: {
      readdir: async () => Array.from({ length: 12 }, (_, i) => ({ name: String(i), isDirectory: () => true })),
      stat: async () => {
        stats++;
        if (stats === 1) await gate;
        const mtime = new Date(Date.now() - 1000);
        return { mtime, mtimeMs: +mtime, size: 2 };
      },
      open: async () => ({ read: async () => ({ bytesRead: 0 }), close: async () => { closed++; } }),
    },
  };
  const sandbox = {
    module: { exports: {} }, Date, Buffer,
    require: name => name === 'fs' ? fakeFs : path,
  };
  vm.runInNewContext(code, sandbox);
  const pending = sandbox.module.exports.list('sessions');
  await new Promise(resolve => setImmediate(resolve));
  t.eq(stats, 12, 'a pending filesystem scan yields control to other requests');
  release();
  const signals = await pending;
  t.eq(signals.length, 8);
  t.eq(closed, 8, 'all tail-reading handles are closed');
  await sandbox.module.exports.list('sessions');
  t.eq(stats, 12, 'repeated polling uses the worker scan cache');
  t.ok(server.includes('signals.push(...await _devBuddySessionSignals(signalSnapshot))'),
    'Pixel awaits the nonblocking scan');
  t.ok(server.includes("await runProbe('sessions', 'list', SESSION_STATE_DIR)"),
    'session enumeration runs outside the HTTP request thread');
});

const result = await t.done();
if (result.fail) process.exitCode = 1;
