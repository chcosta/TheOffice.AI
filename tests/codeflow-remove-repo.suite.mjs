import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('codeflow-remove-repo');
const html = readFileSync('public/app.html', 'utf8');
const server = readFileSync('server.js', 'utf8');
const removed = { id: 'deleted', provider: 'azdo', org: 'org', project: 'project', repo: 'deleted-repo' };
const kept = { id: 'kept', provider: 'github', org: 'owner', repo: 'kept-repo' };
const oldPr = { id: 1, repoId: removed.id, attention: true };
const keptPr = { id: 2, repoId: kept.id, attention: true };

function client(request) {
  const methods = {};
  for (const [name, end] of [
    ['async removeCodeflowRepo(', '        async loadCodeflowAttention('],
    ['async codeflowAutoRefresh(', '        async loadCodeflowAi('],
  ]) {
    const start = html.indexOf('        ' + name);
    Object.assign(methods, vm.runInNewContext(`({${html.slice(start, html.indexOf(end, start))}})`));
  }
  const cache = () => ({
    pullRequests: [oldPr, keptPr],
    errors: [{ repoId: removed.id, repo: removed.repo, error: '404' }, { repo: kept.repo, error: 'other' }],
    attentionCount: 2, selectedKey: '1',
  });
  return {
    ...methods,
    codeflow: {
      ...cache(), repos: [removed, kept], view: 'mine', filterRepo: removed.id, loading: true,
      viewCache: { mine: cache(), reviews: cache(), other: cache() },
    },
    codeflowReposBusy: {}, _cfLoadEpochs: { mine: 3, reviews: 7 }, toasts: [],
    request, cfPrKey: pr => String(pr.id),
    _cfStoreViewCache(view, value) { Object.assign(this.codeflow.viewCache[view], value); },
    _codeflowSeedSnap() {},
    loadCodeflowAttention() {},
    loadCodeFlow() { throw new Error('Removal must not wait on remote PRs'); },
    showToast(...args) { this.toasts.push(args); },
  };
}

await t.test('removed repo disappears immediately after local DELETE, without a remote reload', async () => {
  const requests = [];
  const c = client(async (url, opts) => { requests.push([url, opts]); return { ok: true }; });
  await c.removeCodeflowRepo(removed);
  t.eq(requests.length, 1);
  t.eq(requests[0][0], '/api/codeflow/repos/deleted');
  t.eq(requests[0][1].method, 'DELETE');
  t.eq(requests[0][1].timeoutMs, 15000);
  t.deep(c.codeflow.repos.map(r => r.id), ['kept']);
  for (const view of [c.codeflow, ...Object.values(c.codeflow.viewCache)]) {
    t.deep(view.pullRequests.map(pr => pr.id), [2]);
    t.eq(view.errors.length, 1);
    t.eq(view.attentionCount, 1);
    t.eq(view.selectedKey, '');
  }
  t.eq(c.codeflow.filterRepo, '');
  t.notOk(c.codeflow.loading);
  t.eq(c.codeflowReposBusy.deleted, undefined);
  t.eq(c.toasts[0][0], 'Repository removed');
});

await t.test('failed deletion keeps the watch, surfaces an error, and enables retry', async () => {
  const c = client(async () => { throw new Error('Could not save watch list'); });
  await c.removeCodeflowRepo(removed);
  t.eq(c.codeflow.repos.length, 2);
  t.eq(c.codeflow.viewCache.mine.pullRequests.length, 2);
  t.eq(c.codeflowReposBusy.deleted, undefined);
  t.eq(c.toasts[0][2], 'error');
  t.eq(c.toasts[0][1], 'Could not save watch list');
});

await t.test('repeat clicks do not send multiple DELETE requests', async () => {
  let release, calls = 0;
  const c = client(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = c.removeCodeflowRepo(removed);
  await c.removeCodeflowRepo(removed);
  t.eq(calls, 1);
  release({ ok: true });
  await first;
});

await t.test('a poll started before removal cannot resurrect its PRs', async () => {
  let release;
  const c = client(async (url, options) => {
    if (options?.method === 'DELETE') return { ok: true };
    return new Promise(resolve => { release = resolve; });
  });
  c.codeflow.loading = false;
  const poll = c.codeflowAutoRefresh();
  await c.removeCodeflowRepo(removed);
  release({ pullRequests: [oldPr, keptPr], errors: [] });
  await poll;
  t.deep(c.codeflow.viewCache.mine.pullRequests.map(pr => pr.id), [2]);
});

await t.test('server DELETE only changes local watches, even for an inaccessible remote repo', () => {
  let saved, handler, cleared = false;
  vm.runInNewContext(
    server.slice(server.indexOf("app.delete('/api/codeflow/repos/:id'"), server.indexOf('// The signed-in identity (per org).')),
    {
      app: { delete: (_, fn) => { handler = fn; } },
      loadCodeflowRepos: () => [removed, kept],
      saveCodeflowRepos: value => { saved = value; },
      _codeflowCache: { clear: () => { cleared = true; } },
    },
  );
  let result;
  handler({ params: { id: removed.id } }, { json: value => { result = value; } });
  t.deep(saved.map(r => r.id), ['kept']);
  t.ok(result.ok && cleared);
});

await t.test('remote gather finishing after removal does not repopulate cached PRs or 404 errors', async () => {
  let watches = [removed, kept];
  const start = server.indexOf('async function _gatherCodeflow(');
  const end = server.indexOf("app.get('/api/codeflow/pullrequests'", start);
  const _gatherCodeflow = vm.runInNewContext(
    server.slice(start, end) + '\n_gatherCodeflow;',
    {
      loadCodeflowRepos: () => watches,
      providerOf: r => r.provider,
      _buildDevCardIndex: () => ({}), loadCodeflowNotes: () => ({}), loadCodeflowDismissed: () => ({}),
      settings: { getSettings: () => ({}) }, _cfApproverIndex: async () => [],
      _cfWtKey: pr => String(pr.prId), _enrichCodeflowPr: async pr => pr,
      _codeflowAttention: () => ({ attention: true, reason: 'review' }),
      forge: repo => ({
        getCurrentUser: async () => ({ id: 'viewer' }),
        getRepoContributors: async () => [],
        listPullRequests: async () => {
          if (repo.id === removed.id) {
            watches = [kept];
            throw new Error('Repository no longer exists (404)');
          }
          return [{ id: 2, createdBy: { id: 'author' } }];
        },
      }),
    },
  );
  const result = await _gatherCodeflow('active');
  t.deep(result.repos.map(r => r.id), ['kept']);
  t.eq(result.errors.length, 0);
  t.deep(result.pullRequests.map(pr => pr.repoId), ['kept']);
  t.eq(result.attentionCount, 1);
});

const result = await t.done();
if (result.fail) process.exitCode = 1;
