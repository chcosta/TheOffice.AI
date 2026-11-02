'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const operations = {
  github: { module: './github', methods: ['getStatus'] },
  azdo: { module: './azdo', methods: ['getSignInStatus'] },
  agentDeps: { module: './agentDeps', methods: ['list', 'check', 'install'] },
  sessions: { module: './session-signals', methods: ['list'] },
};

if (!isMainThread && workerData && workerData.statusProbe) {
  const operation = operations[workerData.statusProbe];
  if (!operation) throw new Error('Unknown status probe');
  const target = require(operation.module);
  parentPort.on('message', async ({ id, method, args }) => {
    try {
      if (!operation.methods.includes(method)) throw new Error('Unknown status probe method');
      const value = await target[method](...args);
      parentPort.postMessage({ id, value });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message || String(error) });
    }
  });
} else {
  const workers = new Map();
  let nextId = 0;

  function runProbe(kind, method, ...args) {
    if (!operations[kind] || !operations[kind].methods.includes(method)) {
      return Promise.reject(new Error('Unknown status probe operation'));
    }
    let entry = workers.get(kind);
    if (!entry) {
      const worker = new Worker(__filename, { workerData: { statusProbe: kind } });
      entry = { worker, pending: new Map() };
      workers.set(kind, entry);
      const fail = error => {
        if (workers.get(kind) === entry) workers.delete(kind);
        for (const pending of entry.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        entry.pending.clear();
        worker.unref();
      };
      worker.on('message', message => {
        const pending = entry.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        entry.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
        if (!entry.pending.size) {
          worker.unref();
          // Auth probes must see newly selected accounts/credentials rather than
          // retaining another thread's cached settings or token after a switch.
          if (kind === 'github' || kind === 'azdo') {
            if (workers.get(kind) === entry) workers.delete(kind);
            worker.terminate().catch(error => console.error('[status-probes] worker termination failed:', error.message));
          }
        }
      });
      worker.on('error', fail);
      worker.on('exit', code => fail(new Error(`${kind} probe worker exited (${code})`)));
    }
    // Share concurrent read probes, but never combine separate install actions.
    const key = JSON.stringify([method, args]);
    if (method !== 'install') {
      for (const pending of entry.pending.values()) {
        if (pending.key === key) return pending.promise;
      }
    }
    const id = ++nextId;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      if (workers.get(kind) === entry) workers.delete(kind);
      for (const pending of entry.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${kind} ${method} probe timed out`));
      }
      entry.pending.clear();
      entry.worker.terminate().catch(error => console.error('[status-probes] worker termination failed:', error.message));
    }, method === 'install' ? 360000 : 60000);
    entry.pending.set(id, { key, promise, resolve, reject, timer });
    entry.worker.ref();
    entry.worker.postMessage({ id, method, args });
    return promise;
  }

  module.exports = { runProbe };
}
