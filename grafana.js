'use strict';

// Monitoring.AI — Azure Managed Grafana bridge.
//
// This module is the single source of truth for talking to a Grafana instance
// (Azure Managed Grafana or any Grafana) AND for the honest sample-data fallback
// that lets the Monitoring.AI page work immediately when no Grafana is configured.
//
// Design contract:
//   * When Grafana is configured (settings.grafana.enabled + url + token), we call
//     the real REST API for the dashboard list + dashboard model.
//   * Panel data is fetched from Grafana's /api/ds/query when a panel carries usable
//     targets; if that fails or returns nothing, we synthesize representative series
//     locally and mark them { sample:true } so the UI and the AI copilot stay honest.
//   * When Grafana is NOT configured, everything comes from the local sample generators
//     so the experience is fully explorable out of the box.
//
// No AI lives here — the routes in server.js own the LLM calls (spin-up + analyze) and
// fall back to the deterministic helpers exported below.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');
const settings = require('./settings');

const MON_DIR = dataPath('monitoring');
try { fs.mkdirSync(MON_DIR, { recursive: true }); } catch {}
const LOCAL_DASH_FILE = path.join(MON_DIR, 'dashboards.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function cfg() {
  const s = settings.getSettings() || {};
  const g = (s.grafana && typeof s.grafana === 'object') ? s.grafana : {};
  return {
    url: String(g.url || '').replace(/\/+$/, ''),
    token: String(g.token || ''),
    orgId: String(g.orgId || ''),
    enabled: !!g.enabled,
    // 'aad' = authenticate with Azure identity (DefaultAzureCredential); 'token' = service-account PAT.
    authMode: (g.authMode === 'token') ? 'token' : 'aad',
    // Push spun-up dashboards to Grafana by default (can be turned off per dashboard).
    pushByDefault: g.pushByDefault !== false,
  };
}

function configured() {
  const c = cfg();
  if (!c.enabled || !c.url) return false;
  // Azure identity needs only a URL; token mode needs a token.
  return c.authMode === 'aad' ? true : !!c.token;
}

// ---------------------------------------------------------------------------
// Azure identity — Azure Managed Grafana accepts Azure AD bearer tokens
// (scope https://grafana.azure.com/.default). DefaultAzureCredential lets the
// same identity that runs the app (az login / VS / managed identity) authorize
// Grafana, so there is no service-account token to store or rotate.
// ---------------------------------------------------------------------------
const AMG_SCOPE = 'https://grafana.azure.com/.default';
let _aadCred = null, _aadTok = '', _aadExp = 0;
async function _aadBearer() {
  const now = Date.now();
  if (_aadTok && now < _aadExp - 60000) return _aadTok;
  if (!_aadCred) {
    let DefaultAzureCredential;
    try { ({ DefaultAzureCredential } = require('@azure/identity')); }
    catch { const e = new Error('azure-identity module unavailable'); e.code = 'NO_AAD_SDK'; throw e; }
    _aadCred = new DefaultAzureCredential();
  }
  const t = await _aadCred.getToken(AMG_SCOPE);
  if (!t || !t.token) { const e = new Error('Azure identity returned no token — run `az login` or assign a Grafana role'); e.code = 'NO_AAD'; throw e; }
  _aadTok = t.token;
  _aadExp = t.expiresOnTimestamp || (now + 50 * 60000);
  return _aadTok;
}

// ---------------------------------------------------------------------------
// Low-level REST
// ---------------------------------------------------------------------------
async function _api(apiPath, { method = 'GET', body = null, timeoutMs = 12000 } = {}) {
  const c = cfg();
  if (!c.url) { const e = new Error('grafana-not-configured'); e.code = 'NO_CONFIG'; throw e; }
  if (typeof fetch !== 'function') { const e = new Error('fetch-unavailable'); e.code = 'NO_FETCH'; throw e; }
  let bearer;
  if (c.authMode === 'aad') {
    bearer = await _aadBearer();
  } else {
    if (!c.token) { const e = new Error('grafana-not-configured'); e.code = 'NO_CONFIG'; throw e; }
    bearer = c.token;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
    if (c.orgId) headers['X-Grafana-Org-Id'] = c.orgId;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(c.url + apiPath, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const e = new Error(`grafana-http-${res.status}`);
      e.status = res.status;
      e.body = json || text;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Deterministic sample-data generators (seeded so a given panel is stable)
// ---------------------------------------------------------------------------
function _seed(str) {
  let h = 2166136261;
  const s = String(str || 'x');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}

// A time series of `n` points across the trailing `hours` hours.
function sampleSeries(key, { n = 48, base = 50, amp = 20, drift = 0, noise = 8, min = 0, hours = 6 } = {}) {
  const rnd = _seed(key);
  const now = Date.now();
  const step = (hours * 3600 * 1000) / (n - 1);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = now - (n - 1 - i) * step;
    const wave = Math.sin((i / n) * Math.PI * 3) * amp;
    const dv = drift * (i / n);
    let v = base + wave + dv + (rnd() - 0.5) * 2 * noise;
    if (min != null && v < min) v = min;
    pts.push([Math.round(t), Math.round(v * 100) / 100]);
  }
  return pts;
}

function _lastVal(series) {
  return (series && series.length) ? series[series.length - 1][1] : 0;
}
function _trend(series) {
  if (!series || series.length < 4) return { dir: 'flat', pct: 0 };
  const head = series.slice(0, Math.max(2, Math.floor(series.length / 4)));
  const tail = series.slice(-Math.max(2, Math.floor(series.length / 4)));
  const avg = a => a.reduce((s, p) => s + p[1], 0) / a.length;
  const a = avg(head), b = avg(tail);
  const pct = a === 0 ? 0 : Math.round(((b - a) / Math.abs(a)) * 100);
  return { dir: pct > 6 ? 'up' : pct < -6 ? 'down' : 'flat', pct };
}

// Build a set of sample panels for a given dashboard "kind".
function _samplePanels(kind, uid) {
  const p = (id, title, type, unit, seriesSpecs, extra = {}) => {
    const series = seriesSpecs.map(sp => ({
      name: sp.name,
      unit,
      data: sampleSeries(`${uid}:${id}:${sp.name}`, sp.opts || {}),
      sample: true,
    }));
    return { id, title, type, unit, series, sample: true, ...extra };
  };
  if (kind === 'api') {
    return [
      p(1, 'Request rate', 'timeseries', 'req/s', [{ name: 'total', opts: { base: 320, amp: 60, noise: 22, drift: 40 } }]),
      p(2, 'Error rate', 'timeseries', '%', [{ name: '5xx', opts: { base: 1.4, amp: 0.8, noise: 0.5, drift: 1.6, min: 0 } }], { alert: 'warn' }),
      p(3, 'p95 latency', 'timeseries', 'ms', [{ name: 'p95', opts: { base: 240, amp: 60, noise: 30, drift: 90 } }, { name: 'p50', opts: { base: 90, amp: 20, noise: 10 } }]),
      p(4, 'Availability', 'gauge', '%', [{ name: 'uptime', opts: { base: 99.7, amp: 0.2, noise: 0.1, min: 95 } }]),
      p(5, 'Saturation (CPU)', 'timeseries', '%', [{ name: 'cpu', opts: { base: 46, amp: 18, noise: 8, drift: 20, min: 0 } }]),
    ];
  }
  if (kind === 'db') {
    return [
      p(1, 'Connections', 'timeseries', 'conn', [{ name: 'active', opts: { base: 120, amp: 30, noise: 12, drift: 20 } }]),
      p(2, 'Query duration p99', 'timeseries', 'ms', [{ name: 'p99', opts: { base: 42, amp: 18, noise: 8, drift: 30 } }], { alert: 'warn' }),
      p(3, 'Cache hit ratio', 'gauge', '%', [{ name: 'hit', opts: { base: 96.5, amp: 1.5, noise: 0.6, min: 80 } }]),
      p(4, 'Deadlocks', 'timeseries', '/min', [{ name: 'deadlocks', opts: { base: 0.4, amp: 0.5, noise: 0.4, min: 0 } }]),
      p(5, 'Replication lag', 'timeseries', 's', [{ name: 'lag', opts: { base: 1.1, amp: 0.6, noise: 0.4, min: 0 } }]),
    ];
  }
  // default "host" fleet
  return [
    p(1, 'CPU utilisation', 'timeseries', '%', [{ name: 'avg', opts: { base: 38, amp: 16, noise: 8, drift: 12, min: 0 } }]),
    p(2, 'Memory used', 'timeseries', '%', [{ name: 'mem', opts: { base: 62, amp: 8, noise: 4, drift: 10, min: 0 } }]),
    p(3, 'Disk I/O', 'timeseries', 'MB/s', [{ name: 'read', opts: { base: 18, amp: 10, noise: 6, min: 0 } }, { name: 'write', opts: { base: 12, amp: 8, noise: 5, min: 0 } }]),
    p(4, 'Network', 'timeseries', 'Mb/s', [{ name: 'in', opts: { base: 240, amp: 80, noise: 30 } }, { name: 'out', opts: { base: 180, amp: 60, noise: 25 } }]),
    p(5, 'Load average', 'gauge', '', [{ name: 'load', opts: { base: 2.1, amp: 0.8, noise: 0.4, min: 0 } }]),
  ];
}

const SAMPLE_DASHBOARDS = [
  { uid: 'sample-api', title: 'API Gateway — golden signals', kind: 'api', tags: ['api', 'sre'], folder: 'Production' },
  { uid: 'sample-host', title: 'Fleet health — hosts', kind: 'host', tags: ['infra'], folder: 'Production' },
  { uid: 'sample-db', title: 'Postgres — primary', kind: 'db', tags: ['db'], folder: 'Data' },
];

function _sampleDashboardList() {
  const local = _readLocalDashboards();
  const base = SAMPLE_DASHBOARDS.map(d => {
    const panels = _samplePanels(d.kind, d.uid);
    const key = panels[0];
    return {
      uid: d.uid,
      title: d.title,
      tags: d.tags,
      folder: d.folder,
      panelCount: panels.length,
      sample: true,
      spark: key ? key.series[0].data.map(pt => pt[1]) : [],
      updated: new Date(Date.now() - (SAMPLE_DASHBOARDS.indexOf(d) + 1) * 3600 * 1000).toISOString(),
    };
  });
  // Locally-generated (spun-up) dashboards appear first.
  return [...local.map(_localToListItem), ...base];
}

// ---------------------------------------------------------------------------
// Local (spun-up) dashboards
// ---------------------------------------------------------------------------
function _readLocalDashboards() {
  try {
    const raw = fs.readFileSync(LOCAL_DASH_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function _writeLocalDashboards(arr) {
  try { fs.writeFileSync(LOCAL_DASH_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.warn('[monitoring] save failed:', e.message); }
}
function _saveLocalDash(dash) {
  _writeLocalDashboards(_readLocalDashboards().map(d => d.uid === dash.uid ? dash : d));
}
function _localToListItem(d) {
  const first = (d.panels || [])[0];
  return {
    uid: d.uid,
    title: d.title,
    tags: d.tags || [],
    folder: d.folder || 'Local',
    panelCount: (d.panels || []).length,
    sample: true,
    local: true,
    pushed: !!d.pushed,
    autoPush: !!d.autoPush,
    pushedAt: d.pushedAt || '',
    spark: first ? (first.series[0] ? first.series[0].data.map(pt => pt[1]) : []) : [],
    updated: d.updated || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — status / dashboards / dashboard / query
// ---------------------------------------------------------------------------
// Turn a low-level _api()/AAD error into an actionable, human-readable reason
// so the UI never shows a bare "health check failed".
function _authErrorMessage(e, c) {
  if (!e) return '';
  if (e.code === 'NO_AAD_SDK') return 'Azure identity SDK unavailable — reinstall dependencies or switch to a service-account token.';
  if (e.code === 'NO_AAD') return 'No Azure identity available — run `az login` (or assign a managed identity), then reconnect.';
  if (e.status === 401 || e.status === 403) {
    return c.authMode === 'aad'
      ? `Signed in to Azure, but Grafana rejected the request (HTTP ${e.status}). Your identity needs a Grafana role (Viewer/Editor/Admin) on this Managed Grafana workspace — assign it in the Azure portal, then reconnect.`
      : `Grafana rejected the token (HTTP ${e.status}). Check the service-account token and that its role is still valid.`;
  }
  if (e.status) return `Grafana returned HTTP ${e.status}.`;
  if (e.name === 'AbortError') return 'Grafana did not respond in time (timeout). Check the URL and that the workspace is reachable from here.';
  return e.message || 'Could not reach Grafana.';
}

async function status() {
  const c = cfg();
  if (!configured()) {
    return {
      configured: false,
      url: c.url || '',
      note: 'Not connected to Grafana — showing sample data. Connect Azure Managed Grafana to see live dashboards.',
      sources: [
        { name: 'Sample metrics', type: 'sample', status: 'ok' },
      ],
    };
  }
  let health = null, sources = [], authError = '';
  try { health = await _api('/api/health', { timeoutMs: 6000 }); }
  catch (e) { authError = _authErrorMessage(e, c); }
  try {
    const ds = await _api('/api/datasources', { timeoutMs: 8000 });
    if (Array.isArray(ds)) sources = ds.map(d => ({ name: d.name, type: d.type, status: 'ok', default: !!d.isDefault }));
  } catch (e) { /* datasource listing may be forbidden for the identity */ }
  return {
    configured: true,
    url: c.url,
    orgId: c.orgId || '',
    authMode: c.authMode,
    authError,
    version: health && health.version ? health.version : '',
    healthy: !!health,
    sources: sources.length ? sources : [{ name: 'Grafana', type: 'grafana', status: health ? 'ok' : (authError ? 'error' : 'unknown') }],
  };
}

async function listDashboards() {
  if (!configured()) return { configured: false, dashboards: _sampleDashboardList() };
  try {
    const rows = await _api('/api/search?type=dash-db&limit=200', { timeoutMs: 10000 });
    const dashboards = (Array.isArray(rows) ? rows : []).map(r => ({
      uid: r.uid,
      title: r.title,
      tags: r.tags || [],
      folder: r.folderTitle || 'General',
      panelCount: null,
      sample: false,
      spark: [],
      updated: '',
    }));
    // Surface local spun-up dashboards alongside live ones.
    const local = _readLocalDashboards().map(_localToListItem);
    return { configured: true, dashboards: [...local, ...dashboards] };
  } catch (e) {
    return { configured: true, error: e.message, dashboards: [..._readLocalDashboards().map(_localToListItem), ..._sampleDashboardList().filter(d => !d.local)] };
  }
}

// Extract a normalized panel list from a real Grafana dashboard model, attaching
// query results (or sample series when a live query isn't possible).
async function _panelsFromModel(model, uid) {
  const panels = [];
  const raw = (model && model.panels) || [];
  for (const gp of raw) {
    if (!gp || gp.type === 'row') continue;
    const unit = (gp.fieldConfig && gp.fieldConfig.defaults && gp.fieldConfig.defaults.unit) || '';
    let series = [];
    let sample = false;
    // Live query would require datasource-specific target models; attempt only when
    // targets carry a raw expression we can pass through. Otherwise synthesize.
    try {
      series = await _queryPanel(gp, model);
    } catch { series = []; }
    if (!series || !series.length) {
      const gen = _samplePanels(_kindFromTitle(gp.title), uid);
      const match = gen.find(x => x.title.toLowerCase() === String(gp.title || '').toLowerCase()) || gen[panels.length % gen.length];
      series = match.series;
      sample = true;
    }
    panels.push({
      id: gp.id,
      title: gp.title || `Panel ${gp.id}`,
      type: (gp.type === 'stat' || gp.type === 'gauge') ? 'gauge' : 'timeseries',
      unit,
      series,
      sample,
    });
  }
  return panels;
}

function _kindFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/latency|request|error|5xx|throughput|qps|rps/.test(t)) return 'api';
  if (/query|connection|cache|deadlock|replica|sql|db/.test(t)) return 'db';
  return 'host';
}

// Best-effort live query for a single panel; returns [] when not feasible.
async function _queryPanel(gp, model) {
  const targets = (gp.targets || []).filter(Boolean);
  if (!targets.length) return [];
  const ds = gp.datasource || (targets[0] && targets[0].datasource) || null;
  const queries = targets.map((t, i) => ({
    ...t,
    refId: t.refId || String.fromCharCode(65 + i),
    datasource: t.datasource || ds || undefined,
  }));
  const body = { queries, from: 'now-6h', to: 'now' };
  let out;
  try { out = await _api('/api/ds/query', { method: 'POST', body, timeoutMs: 12000 }); } catch { return []; }
  const series = [];
  const results = (out && out.results) || {};
  for (const refId of Object.keys(results)) {
    const frames = (results[refId] && results[refId].frames) || [];
    for (const f of frames) {
      const values = (f.data && f.data.values) || [];
      if (values.length < 2) continue;
      const times = values[0], vals = values[1];
      const data = [];
      for (let i = 0; i < times.length; i++) data.push([Number(times[i]), Number(vals[i])]);
      if (data.length) series.push({ name: (f.schema && f.schema.name) || refId, unit: '', data, sample: false });
    }
  }
  return series;
}

async function getDashboard(uid) {
  // Local (spun-up) dashboard?
  const local = _readLocalDashboards().find(d => d.uid === uid);
  if (local) {
    return { configured: configured(), uid, title: local.title, tags: local.tags || [], panels: local.panels, sample: true, local: true, pushed: !!local.pushed, autoPush: !!local.autoPush, grafanaUid: local.grafanaUid || '', pushedAt: local.pushedAt || '' };
  }
  // Sample dashboards are always available.
  const samp = SAMPLE_DASHBOARDS.find(d => d.uid === uid);
  if (samp) {
    return { configured: configured(), uid, title: samp.title, tags: samp.tags, panels: _samplePanels(samp.kind, uid), sample: true };
  }
  if (!configured()) {
    // Unknown uid + no Grafana → best-effort host sample.
    return { configured: false, uid, title: 'Dashboard', tags: [], panels: _samplePanels('host', uid), sample: true };
  }
  const doc = await _api(`/api/dashboards/uid/${encodeURIComponent(uid)}`, { timeoutMs: 12000 });
  const model = (doc && doc.dashboard) || {};
  const panels = await _panelsFromModel(model, uid);
  return { configured: true, uid, title: model.title || 'Dashboard', tags: model.tags || [], panels, sample: panels.every(p => p.sample) };
}

// ---------------------------------------------------------------------------
// Spin-up: turn a spec into a stored (and optionally pushed) dashboard
// ---------------------------------------------------------------------------
function _specToPanels(spec, uid) {
  const list = (spec.panels || []).slice(0, 12);
  return list.map((pn, i) => {
    const type = (pn.type === 'gauge' || pn.type === 'stat') ? 'gauge' : 'timeseries';
    const unit = pn.unit || '';
    const kind = _kindFromTitle(pn.title);
    const gen = _samplePanels(kind, uid);
    const proto = gen[i % gen.length];
    return {
      id: i + 1,
      title: pn.title || `Panel ${i + 1}`,
      type,
      unit,
      series: proto.series.map(s => ({ ...s, unit })),
      sample: true,
      alert: pn.alert || null,
    };
  });
}

async function createDashboard(spec) {
  const c = cfg();
  const uid = 'mon-' + Math.random().toString(36).slice(2, 9);
  const autoPush = (typeof spec.autoPush === 'boolean') ? spec.autoPush : c.pushByDefault;
  const dash = {
    uid,
    title: spec.title || 'New dashboard',
    tags: Array.isArray(spec.tags) ? spec.tags : ['monitoring.ai'],
    folder: 'Local',
    panels: _specToPanels(spec, uid),
    updated: new Date().toISOString(),
    pushed: false,
    autoPush,
    prompt: spec.prompt || '',
  };
  const all = _readLocalDashboards();
  all.unshift(dash);
  _writeLocalDashboards(all.slice(0, 100));
  // Push to Grafana by default (unless this dashboard opted out of auto-push).
  let pushed = false, pushError = '';
  if (configured() && autoPush) {
    try {
      const r = await _pushToGrafana(dash, { overwrite: false });
      pushed = r.ok;
      if (pushed) { dash.pushed = true; if (r.grafanaUid) dash.grafanaUid = r.grafanaUid; dash.pushedAt = new Date().toISOString(); _saveLocalDash(dash); }
    } catch (e) { pushError = e.message; }
  }
  return { uid, title: dash.title, panelCount: dash.panels.length, pushed, pushError, autoPush, local: true };
}

// Best-effort push of a local dashboard's model to Grafana.
async function _pushToGrafana(dash, { overwrite = true } = {}) {
  const model = _toGrafanaModel(dash);
  const r = await _api('/api/dashboards/db', { method: 'POST', body: { dashboard: model, overwrite, message: 'Synced by Monitoring.AI' }, timeoutMs: 12000 });
  return { ok: !!(r && (r.status === 'success' || r.uid)), grafanaUid: (r && r.uid) || dash.grafanaUid || '' };
}

// Manual push of a local dashboard to Grafana (used by the "Push to Grafana" action).
async function pushDashboard(uid) {
  const dash = _readLocalDashboards().find(d => d.uid === uid);
  if (!dash) { const e = new Error('Not a local dashboard'); e.code = 'NOT_LOCAL'; throw e; }
  if (!configured()) { const e = new Error('grafana-not-configured'); e.code = 'NO_CONFIG'; throw e; }
  const r = await _pushToGrafana(dash, { overwrite: true });
  if (r.ok) { dash.pushed = true; if (r.grafanaUid) dash.grafanaUid = r.grafanaUid; dash.pushedAt = new Date().toISOString(); _saveLocalDash(dash); }
  return { ok: r.ok, uid, pushed: !!dash.pushed, autoPush: !!dash.autoPush, grafanaUid: dash.grafanaUid || '', pushedAt: dash.pushedAt || '' };
}

// Update per-dashboard options (currently just autoPush). Turning auto-push ON
// while connected syncs the dashboard immediately if it hasn't been pushed yet.
async function setDashboardOptions(uid, opts = {}) {
  const dash = _readLocalDashboards().find(d => d.uid === uid);
  if (!dash) { const e = new Error('Not a local dashboard'); e.code = 'NOT_LOCAL'; throw e; }
  if (typeof opts.autoPush === 'boolean') dash.autoPush = opts.autoPush;
  _saveLocalDash(dash);
  let pushError = '';
  if (dash.autoPush && configured() && !dash.pushed) {
    try {
      const r = await _pushToGrafana(dash, { overwrite: true });
      if (r.ok) { dash.pushed = true; if (r.grafanaUid) dash.grafanaUid = r.grafanaUid; dash.pushedAt = new Date().toISOString(); _saveLocalDash(dash); }
    } catch (e) { pushError = e.message; }
  }
  return { ok: true, uid, autoPush: !!dash.autoPush, pushed: !!dash.pushed, pushError, pushedAt: dash.pushedAt || '' };
}

function _toGrafanaModel(dash) {
  const panels = (dash.panels || []).map((p, i) => ({
    id: p.id || i + 1,
    title: p.title,
    type: p.type === 'gauge' ? 'gauge' : 'timeseries',
    gridPos: { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 },
    fieldConfig: { defaults: { unit: p.unit || '' } },
    targets: [],
  }));
  return { uid: undefined, title: dash.title, tags: dash.tags, schemaVersion: 39, panels, time: { from: 'now-6h', to: 'now' } };
}

// ---------------------------------------------------------------------------
// Deterministic analysis + spec generation (fallbacks for the AI routes)
// ---------------------------------------------------------------------------
function panelSummary(p) {
  const s0 = (p.series || [])[0];
  const last = _lastVal(s0 && s0.data);
  const tr = _trend(s0 && s0.data);
  return {
    title: p.title,
    type: p.type,
    unit: p.unit || '',
    last,
    trend: tr.dir,
    changePct: tr.pct,
    sample: !!p.sample,
    seriesNames: (p.series || []).map(s => s.name),
  };
}

function deterministicAnalysis(panels, question) {
  const sums = (panels || []).map(panelSummary);
  const findings = [];
  const suggestions = [];
  let worst = 'ok';
  for (const s of sums) {
    const isErr = /error|5xx|deadlock|lag|saturation|cpu|latency|duration/i.test(s.title);
    const rising = s.trend === 'up';
    if (isErr && rising && Math.abs(s.changePct) >= 15) {
      worst = /error|5xx/i.test(s.title) ? 'critical' : (worst === 'critical' ? 'critical' : 'warn');
      findings.push(`${s.title} is trending up ${s.changePct}% over the window (now ${s.last}${s.unit}).`);
      suggestions.push(`Investigate what changed upstream of "${s.title}" around the inflection; correlate with a recent deploy or traffic shift.`);
    } else if (rising && Math.abs(s.changePct) >= 20) {
      findings.push(`${s.title} rose ${s.changePct}% (now ${s.last}${s.unit}) — watch for headroom.`);
    } else if (s.trend === 'down' && /availability|cache|hit|uptime/i.test(s.title)) {
      worst = worst === 'critical' ? 'critical' : 'warn';
      findings.push(`${s.title} slipped ${s.changePct}% (now ${s.last}${s.unit}).`);
      suggestions.push(`"${s.title}" moving the wrong way — check capacity / eviction / dependency health.`);
    }
  }
  if (!findings.length) findings.push('All grabbed panels are within their normal band for the window — no significant trend.');
  if (!suggestions.length) suggestions.push('Nothing actionable right now. Keep an eye on the panels trending up if traffic grows.');
  const statusText = worst === 'critical' ? 'Needs attention' : worst === 'warn' ? 'Watch' : 'Healthy';
  return {
    status: worst,
    statusText,
    headline: `${sums.length} panel${sums.length === 1 ? '' : 's'} analysed — ${statusText.toLowerCase()}.`,
    findings,
    suggestions,
    metrics: sums,
    ai: false,
    question: question || '',
  };
}

function deterministicSpec(prompt) {
  const t = String(prompt || '').toLowerCase();
  let kind = 'host', title = 'Fleet health';
  if (/api|latency|request|endpoint|gateway|service|http/.test(t)) { kind = 'api'; title = 'Service golden signals'; }
  else if (/db|sql|postgres|database|query|cache/.test(t)) { kind = 'db'; title = 'Database health'; }
  const proto = _samplePanels(kind, 'spec');
  return {
    title,
    tags: ['monitoring.ai', kind],
    panels: proto.map(p => ({ title: p.title, type: p.type, unit: p.unit })),
    ai: false,
    prompt,
  };
}

module.exports = {
  cfg,
  configured,
  status,
  listDashboards,
  getDashboard,
  createDashboard,
  pushDashboard,
  setDashboardOptions,
  panelSummary,
  deterministicAnalysis,
  deterministicSpec,
  // exposed for tests
  _internal: { sampleSeries, _trend, _samplePanels, _sampleDashboardList, SAMPLE_DASHBOARDS },
};
