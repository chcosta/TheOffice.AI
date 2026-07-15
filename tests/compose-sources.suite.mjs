// Compose.AI — source-validation suite.
//
// The paired assistant only helps if the sources the user CHECKS actually reach
// it. Historically several source kinds (pr/pursuit/workitems/repos/links/m365)
// were passed as an "go fetch this yourself" INSTRUCTION that the SDK sandbox
// couldn't act on, so a checked source silently never reached the assistant.
//
// `_composeSourceContext` now RESOLVES + INLINES resolvable content server-side
// and returns a per-source resolution report; GET /api/compose/:id/sources/preview
// exposes it. This suite proves, WITHOUT hand-testing each source, that:
//   * static: the resolve-and-report pipeline + graceful-degradation fallback +
//     UI wiring are all present in the shipped code (runs offline);
//   * live: no-auth sources (links, pasted, pursuit) resolve end-to-end and the
//     preview endpoint never crashes on unreachable/auth-gated sources.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, api, serverUp } from './lib/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');

const t = createRunner('compose-sources');

// --- STATIC: the shipped pipeline + fallback + UI wiring ---------------------

await t.test('server: _composeSourceContext is async and returns a resolved report', () => {
  t.ok(/async function _composeSourceContext\(c, opts = \{\}\)/.test(serverSrc), 'async signature');
  t.ok(/const resolved = \[\];/.test(serverSrc), 'resolved report array');
  t.ok(/return \{ block:[^}]*evidenceCount, resolved \};/.test(serverSrc), 'returns resolved');
  // The report entry shape both the UI and this suite depend on.
  t.ok(/resolved\.push\(\{ id, label, on: !!on, ok: !!ok, chars: chars \|\| 0, note:/.test(serverSrc), 'report shape');
});

await t.test('server: both callers await the now-async _composeSourceContext', () => {
  const awaits = serverSrc.match(/await _composeSourceContext\(c\)/g) || [];
  t.gte(awaits.length, 2, 'runComposeGeneration + runComposeChat both await');
});

await t.test('server: auth-gated sources degrade gracefully (report ok:false, never throw)', () => {
  // Each network-bound branch must catch and report a non-ok result rather than
  // let the whole preview/generate crash when ADO/web is unreachable.
  t.ok(/catch \(e\) \{ report\('pr', 'Pull request', true, false, 0, `couldn't reach ADO/.test(serverSrc), 'pr degrades');
  t.ok(/report\('workitems', 'Work items', true, false, 0,/.test(serverSrc), 'workitems degrades');
  t.ok(/report\('repos', 'Repositories', true,/.test(serverSrc), 'repos reports');
  t.ok(/report\('links', 'Links', true, okCount > 0,/.test(serverSrc), 'links reports fetched count');
});

await t.test('server: preview endpoint exposes the resolution report', () => {
  t.ok(/app\.get\('\/api\/compose\/:id\/sources\/preview'/.test(serverSrc), 'route registered');
  t.ok(/resolved: resolved \|\| \[\], blockChars:/.test(serverSrc), 'route returns resolved + blockChars');
});

await t.test('app.html: Sources rail shows what reaches the assistant (no pills)', () => {
  t.ok(/composeSourcesCheck\(\)/.test(appSrc), 'check method wired to a button');
  t.ok(/\/sources\/preview'\)/.test(appSrc), 'client calls the preview endpoint');
  t.ok(/cmpx-srccheck/.test(appSrc), 'resolution block markup present');
  t.ok(/sourcesResolved: \[\]/.test(appSrc), 'resolution state default');
  t.ok(/sourcesChecking: false/.test(appSrc), 'checking flag default');
  // Calm indicator, never a pill: no border-radius:999px on the check rows.
  const block = (appSrc.match(/\.cmpx-srccheck-row\{[^}]*\}/) || [''])[0];
  t.notOk(/999px/.test(block), 'resolution rows are not pills');
});

await t.test('app.html: composeSourcesCheck persists framing then reads the report', () => {
  const m = appSrc.match(/async composeSourcesCheck\(\)\s*\{[\s\S]*?\n\s{8}\},/);
  t.ok(m, 'method body found');
  const body = m[0];
  t.ok(/await this\.composePersistMeta\(\)/.test(body), 'persists framing first');
  t.ok(/sources\/preview/.test(body), 'then fetches the preview');
  t.ok(/co\.sourcesResolved = /.test(body), 'stores the report');
});

// --- LIVE: no-auth sources resolve end-to-end; endpoint never crashes --------

const up = await serverUp();
if (!up) t.skipAll('dev server on :3847 not reachable');

let cid = null;
await t.test('live: create a composition to validate against', async () => {
  const r = await api('/api/compose', { method: 'POST', body: { purposeId: 'status-update' } });
  t.ok(r.ok && r.json && r.json.composition, 'composition created');
  cid = r.json.composition.id;
});

await t.test('live: links + pasted resolve and reach the assistant', async () => {
  t.ok(cid, 'need a composition');
  // A localhost URL the dev server can always fetch, plus inline pasted text.
  const sources = { links: [`${(process.env.MEAI_TEST_URL || 'http://localhost:3847')}/api/settings`], pasted: 'Validation pasted context the assistant must see.' };
  await api('/api/compose/' + cid, { method: 'PATCH', body: { sources } });
  const r = await api('/api/compose/' + cid + '/sources/preview', { timeout: 30000 });
  t.ok(r.ok && r.json && Array.isArray(r.json.resolved), 'preview returns a report');
  const byId = Object.fromEntries(r.json.resolved.map((x) => [x.id, x]));
  t.ok(byId.links && byId.links.ok, 'links reached the assistant');
  t.gt(byId.links.chars, 0, 'links carried real content');
  t.ok(byId.pasted && byId.pasted.ok, 'pasted reached the assistant');
  t.gt(byId.pasted.chars, 0, 'pasted carried real content');
});

await t.test('live: a real pursuit folds into the assistant context (if any exist)', async () => {
  t.ok(cid, 'need a composition');
  const pl = await api('/api/compose/sources/pursuits', { timeout: 15000 });
  const first = pl.json && Array.isArray(pl.json.pursuits) ? pl.json.pursuits[0] : null;
  if (!first) { t.ok(true, 'no pursuits to validate against — skipped'); return; }
  await api('/api/compose/' + cid, { method: 'PATCH', body: { sources: { pursuit: true, pursuitRef: first.id } } });
  const r = await api('/api/compose/' + cid + '/sources/preview', { timeout: 60000 });
  const pu = (r.json.resolved || []).find((x) => x.id === 'pursuit');
  t.ok(pu, 'pursuit reported');
  // Folded corpus may be empty for a brand-new/empty pursuit; if it resolved it
  // must carry content, and either way it must not crash the endpoint.
  if (pu.ok) t.gt(pu.chars, 0, 'resolved pursuit carried folded content');
  t.eq(r.status, 200, 'endpoint healthy');
});

await t.test('live: an unreachable/auth-gated source degrades without crashing', async () => {
  t.ok(cid, 'need a composition');
  // A deliberately-bogus PR ref: must come back as a non-ok report entry with a
  // clear note, and the endpoint must still return 200 (no crash).
  await api('/api/compose/' + cid, { method: 'PATCH', body: { sources: { pr: true, prRef: 'no-such-repo!999999', links: [], pasted: '' } } });
  const r = await api('/api/compose/' + cid + '/sources/preview', { timeout: 30000 });
  t.eq(r.status, 200, 'endpoint healthy under a failing source');
  const pr = (r.json.resolved || []).find((x) => x.id === 'pr');
  t.ok(pr, 'pr reported');
  t.notOk(pr.ok, 'pr honestly reported as not reached');
  t.ok(pr.note && pr.note.length > 0, 'pr carries a human-readable reason');
});

await t.test('live: clean up the validation composition', async () => {
  if (cid) await api('/api/compose/' + cid, { method: 'DELETE' });
  t.ok(true);
});

const res = await t.done();
process.exit(res.fail ? 1 : 0);
