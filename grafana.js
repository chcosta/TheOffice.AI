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
// Internal "Workspace" data-source provider — makes TheOffice.AI's own collections
// (tasks, Me.AI runs, agenda, diary, activity, agents, docs) queryable/chartable.
const workspace = require('./workspace-source');

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
// Azure identity — Azure Managed Grafana accepts Azure AD bearer tokens for the
// audience https://dashboard.azure.com (scope .../.default). AMG rejects the
// older https://grafana.azure.com audience with a 401, so we must request this
// one. DefaultAzureCredential lets the same identity that runs the app (az login
// / VS / managed identity) authorize Grafana, so there is no service-account
// token to store or rotate.
// ---------------------------------------------------------------------------
const AMG_SCOPE = 'https://dashboard.azure.com/.default';
let _aadCred = null, _aadTok = '', _aadExp = 0;
// Drop the cached Azure identity + token so the next call re-mints. Needed after
// a Grafana role is assigned: the role is baked into the token at mint time, so a
// stale cached token would keep failing until it expired on its own.
function resetAuthCache() { _aadCred = null; _aadTok = ''; _aadExp = 0; }
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
    return { id, title, type, unit, series, sample: true, origin: 'sample', source: 'sample', query: 'Synthesized sample series (demo data)', ...extra };
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
    if (Array.isArray(ds)) sources = ds.map(d => ({ name: d.name, type: d.type, uid: d.uid || '', status: 'ok', default: !!d.isDefault }));
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

// Extract the dashboard's template variables into a simple list the UI can render
// as filters, with the current value(s) and any selectable options.
function _dashboardVariables(model) {
  const list = (model && model.templating && model.templating.list) || [];
  const out = [];
  for (const v of list) {
    if (!v || !v.name) continue;
    if (v.type === 'constant' || v.type === 'datasource' || v.hide === 2) continue;
    const cur = v.current || {};
    const options = (v.options || []).map(o => ({ text: o.text, value: o.value })).slice(0, 200);
    out.push({
      name: v.name,
      label: v.label || v.name,
      type: v.type || 'query',
      multi: !!v.multi,
      current: Array.isArray(cur.value) ? cur.value : (cur.value != null ? [cur.value] : []),
      currentText: Array.isArray(cur.text) ? cur.text.join(' + ') : (cur.text || ''),
      options,
    });
  }
  return out;
}

// The set of variables usable for substitution — like _dashboardVariables but INCLUDING
// hidden ones (hide:2) and textbox/constant types. Grafana interpolates hidden variables
// into queries even though they never appear in the dashboard's variable picker, so the
// substitution map must know about them or their $name literal reaches the datasource and
// errors (e.g. a hidden textbox $UntrackedQueues → Kusto SEM0100). Only datasource-type
// variables (which select a datasource, not a query value) are excluded.
function _substitutableVariables(model) {
  const list = (model && model.templating && model.templating.list) || [];
  const out = [];
  for (const v of list) {
    if (!v || !v.name) continue;
    if (v.type === 'datasource') continue;
    const cur = v.current || {};
    let current;
    if (Array.isArray(cur.value)) current = cur.value;
    else if (cur.value != null) current = [cur.value];
    else if (v.query != null && (v.type === 'textbox' || v.type === 'constant')) {
      current = [typeof v.query === 'string' ? v.query : (v.query && v.query.query) || ''];
    } else current = [];
    out.push({ name: v.name, multi: !!v.multi, current });
  }
  return out;
}

// Build a { name -> { values, multi } } substitution map from the model's variables,
// applying any user overrides. Formatting is applied at substitution time (see
// _applyVars) so it can mirror Grafana: a multi-value variable interpolates to a
// single-quoted CSV list ('a','b','c'), a single-value variable to its raw value.
// The datasource backend still expands $__ macros and applies the time range itself.
function _varMap(model, overrides) {
  const map = {};
  for (const v of _substitutableVariables(model)) {
    let val = v.current;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, v.name)) {
      val = Array.isArray(overrides[v.name]) ? overrides[v.name] : [overrides[v.name]];
    }
    val = (val || []).map(x => (x == null ? '' : String(x))).filter(x => x !== '');
    // $__all with no explicit options → drop the filter (let the query match everything)
    if (val.length === 1 && val[0].toLowerCase() === '$__all') val = [];
    map[v.name] = { values: val, multi: !!v.multi };
  }
  return map;
}

// Format a variable's value(s) for injection into a KQL/query string, mirroring
// Grafana: multi-value → single-quoted CSV ('a','b'), single-value → raw text.
function _formatVarValue(entry) {
  if (Array.isArray(entry)) entry = { values: entry, multi: entry.length > 1 };
  const values = (entry && entry.values) || [];
  if (!values.length) return '';
  if (entry.multi || values.length > 1) {
    return values.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
  }
  return String(values[0]);
}

// Parse a Grafana relative ("now-24h"), absolute (ISO), or epoch-ms time expression
// to epoch milliseconds. Falls back to now on anything unrecognized.
function _timeToMs(expr, nowMs) {
  if (expr == null) return nowMs;
  const s = String(expr).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  if (s === 'now') return nowMs;
  const m = s.match(/^now\s*([+-])\s*(\d+)\s*([smhdwMy])$/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const mult = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8, M: 2.592e9, y: 3.1536e10 }[m[3]] || 0;
    return nowMs + sign * Number(m[2]) * mult;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : nowMs;
}

// Format a millisecond span as a Grafana-style interval duration string (e.g. 30s, 5m, 1h).
function _grafanaDuration(ms) {
  if (ms % 3.6e6 === 0 && ms >= 3.6e6) return (ms / 3.6e6) + 'h';
  if (ms % 6e4 === 0 && ms >= 6e4) return (ms / 6e4) + 'm';
  if (ms % 1e3 === 0 && ms >= 1e3) return (ms / 1e3) + 's';
  if (ms < 1e3) return '1s';
  if (ms < 6e4) return Math.round(ms / 1e3) + 's';
  if (ms < 3.6e6) return Math.round(ms / 6e4) + 'm';
  return Math.round(ms / 3.6e6) + 'h';
}

// Compute the auto interval (ms) for a time range + max data points, snapping up to a
// "nice" bucket the way Grafana's frontend does.
function _computeIntervalMs(from, to, maxDataPoints) {
  const now = Date.now();
  const span = Math.max(1, _timeToMs(to, now) - _timeToMs(from, now));
  let iv = Math.floor(span / (maxDataPoints || 300));
  const nice = [1e3, 5e3, 1e4, 3e4, 6e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5];
  for (const n of nice) { if (iv <= n) { iv = n; break; } }
  if (iv < 1e3) iv = 6e4;
  return iv;
}

// Expand the built-in $__interval / $__interval_ms macros that the Grafana frontend
// normally interpolates before dispatch. The ADX (Kusto) datasource backend does NOT
// expand these (it errors "Failed to resolve scalar expression '$__interval'"), so we
// substitute them ourselves. $__timeFilter / $__from / $__to stay for the backend.
function _expandMacros(queries, intervalMs) {
  const ms = intervalMs || 60000;
  const dur = _grafanaDuration(ms);
  let s;
  try { s = JSON.stringify(queries); } catch { return queries; }
  s = s.split('$__interval_ms').join(String(ms))
       .replace(/\$__interval(?![A-Za-z0-9_])/g, dur);
  try { return JSON.parse(s); } catch { return queries; }
}

// Deep-substitute $var / ${var} / [[var]] inside a JSON-serializable target object.
// When a var reference is immediately wrapped in matching single quotes by the
// query author (e.g. == '$QueueName'), the raw value is injected so we don't produce
// doubled quotes; otherwise the Grafana-style formatted value is used.
function _applyVars(obj, varMap) {
  if (!varMap || !Object.keys(varMap).length) return obj;
  let s;
  try { s = JSON.stringify(obj); } catch { return obj; }
  for (const name of Object.keys(varMap)) {
    const entry = varMap[name];
    const values = (entry && entry.values) || (Array.isArray(entry) ? entry : []);
    const rawVal = values.join(',');
    const fmtVal = _formatVarValue(entry);
    const escRaw = rawVal.replace(/[\\"]/g, m => '\\' + m);
    const escFmt = fmtVal.replace(/[\\"]/g, m => '\\' + m);
    // author-quoted single: '$name' → inject raw (avoid doubled quotes)
    s = s.replace(new RegExp("'\\$" + name + "'(?![A-Za-z0-9_])", 'g'), "'" + escRaw + "'")
         .replace(new RegExp("'\\$\\{" + name + "\\}'", 'g'), "'" + escRaw + "'");
    // everything else → Grafana-style formatted value
    s = s.split('${' + name + '}').join(escFmt)
         .split('[[' + name + ']]').join(escFmt)
         .replace(new RegExp('\\$' + name + '(?![A-Za-z0-9_])', 'g'), escFmt);
  }
  try { return JSON.parse(s); } catch { return obj; }
}

// Extract a normalized panel list from a real Grafana dashboard model, attaching
// live query results. When connected we stay honest: an empty result renders as
// "No data" (like Grafana) rather than fabricated series.
async function _panelsFromModel(model, uid, ctx = {}) {
  const panels = [];
  const raw = (model && model.panels) || [];
  for (const gp of raw) {
    if (!gp || gp.type === 'row') continue;
    const unit = (gp.fieldConfig && gp.fieldConfig.defaults && gp.fieldConfig.defaults.unit) || '';
    let res = { series: [], table: null };
    try { res = await _queryPanel(gp, model, ctx); } catch { res = { series: [], table: null }; }
    const type = _panelType(gp, res);
    panels.push({
      id: gp.id,
      title: gp.title || `Panel ${gp.id}`,
      type,
      unit,
      series: res.series || [],
      table: res.table || null,
      noData: !(res.series && res.series.length) && !(res.table && res.table.rows && res.table.rows.length),
      sample: false,
      source: _panelSourceText(gp),
      query: _panelQueryText(gp),
    });
  }
  return panels;
}

// The datasource/source label for a live Grafana panel (from its targets/datasource).
function _panelSourceText(gp) {
  const ds = (gp && gp.datasource) || (gp && gp.targets && gp.targets[0] && gp.targets[0].datasource) || null;
  if (ds && typeof ds === 'object') return ds.type || ds.uid || 'grafana';
  if (typeof ds === 'string' && ds) return ds;
  return 'grafana';
}

// The honest query text for a live Grafana panel, pulled from the first target that carries one.
function _panelQueryText(gp) {
  const targets = (gp && gp.targets) || [];
  for (const t of targets) {
    if (!t) continue;
    const q = t.expr || t.rawSql || t.query || (t.azureLogAnalytics && t.azureLogAnalytics.query);
    if (q) return String(q);
  }
  return 'Query not exposed by this panel';
}

// Map a Grafana panel type to the renderer's supported kinds.
function _panelType(gp, res) {
  const t = String((gp && gp.type) || '').toLowerCase();
  if (res && res.table && res.table.rows) return 'table';
  if (t === 'table') return 'table';
  if (t === 'stat' || t === 'gauge' || t === 'bargauge') return 'gauge';
  if (t === 'barchart') return 'bar';
  return 'timeseries';
}

function _kindFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/latency|request|error|5xx|throughput|qps|rps/.test(t)) return 'api';
  if (/query|connection|cache|deadlock|replica|sql|db/.test(t)) return 'db';
  return 'host';
}

// Best-effort live query for a single panel. Substitutes dashboard template
// variables into the targets and honors the requested time range; returns
// { series, table } (either may be empty). Returns empty on any failure.
async function _queryPanel(gp, model, ctx = {}) {
  let targets = (gp.targets || []).filter(Boolean);
  if (!targets.length) return { series: [], table: null };
  const ds = gp.datasource || (targets[0] && targets[0].datasource) || null;
  const varMap = ctx.varMap || {};
  const maxDataPoints = (targets[0] && targets[0].maxDataPoints) || 300;
  const intervalMs = _computeIntervalMs(ctx.from, ctx.to, maxDataPoints);
  const queries = targets.map((t, i) => _applyVars({
    ...t,
    refId: t.refId || String.fromCharCode(65 + i),
    datasource: t.datasource || ds || undefined,
    intervalMs: t.intervalMs || intervalMs,
    maxDataPoints: t.maxDataPoints || 300,
  }, varMap));
  const body = { queries: _expandMacros(queries, intervalMs), from: ctx.from || 'now-6h', to: ctx.to || 'now' };
  let out;
  try { out = await _api('/api/ds/query', { method: 'POST', body, timeoutMs: 15000 }); } catch { return { series: [], table: null }; }
  const wantTable = String((gp && gp.type) || '').toLowerCase() === 'table';
  return _framesToSeriesTable(out, wantTable);
}

// Parse a Grafana /api/ds/query response (dataframes) into the renderer's
// { series, table } shape. Shared by live-Grafana panels (_queryPanel) and
// generated external ds.* panels (queryExternal) so both read identically.
function _framesToSeriesTable(out, wantTable) {
  const series = [];
  let table = null;
  const results = (out && out.results) || {};
  for (const refId of Object.keys(results)) {
    const frames = (results[refId] && results[refId].frames) || [];
    for (const f of frames) {
      const fields = (f.schema && f.schema.fields) || [];
      const values = (f.data && f.data.values) || [];
      if (!fields.length || !values.length) continue;
      const timeIdx = fields.findIndex(fl => (fl.type === 'time') || /^time$/i.test(fl.name || ''));
      if (wantTable || timeIdx < 0) {
        // Table-shaped result: emit rows across all fields.
        if (!table) table = { columns: fields.map(fl => fl.name || ''), rows: [] };
        const rowCount = values.reduce((m, col) => Math.max(m, col.length), 0);
        for (let r = 0; r < Math.min(rowCount, 200); r++) {
          table.rows.push(values.map(col => col[r]));
        }
      } else {
        const times = values[timeIdx];
        fields.forEach((fl, ci) => {
          if (ci === timeIdx || fl.type === 'time') return;
          if (fl.type && fl.type !== 'number') return;
          const col = values[ci] || [];
          const data = [];
          for (let i = 0; i < times.length; i++) {
            const y = Number(col[i]);
            if (Number.isFinite(y)) data.push([Number(times[i]), y]);
          }
          if (data.length) series.push({ name: fl.name || refId, unit: (fl.config && fl.config.unit) || '', data, sample: false });
        });
      }
    }
  }
  return { series, table };
}

async function getDashboard(uid, opts = {}) {
  // Local (spun-up) dashboard?
  const local = _readLocalDashboards().find(d => d.uid === uid);
  if (local) {
    // Re-query any Workspace-backed panels so internal series are live, not stale.
    // External (Grafana datasource) panels are live-queried through the proxy so
    // they show REAL data when connected — and stay honest-empty when not.
    const panels = await Promise.all((local.panels || []).map(async (p) => {
      if (p && typeof p.source === 'string' && workspace.isWorkspaceSource(p.source)) {
        const q = workspace.query(p.source, { days: 30, split: p.split !== false, groupBy: p.dimension || p.groupBy || null, metric: p.metric || null });
        return { ...p, series: (q.series || []).map(s => ({ ...s, unit: p.unit || '' })), query: q.label || p.query, empty: !!q.empty, sample: false, provider: 'workspace', origin: 'workspace' };
      }
      if (p && (p.provider === 'external' || (typeof p.source === 'string' && /^ds\./.test(p.source)))) {
        const q = await queryExternal(p, { from: opts.from || 'now-6h', to: opts.to || 'now' });
        return { ...p, series: (q.series || []).map(s => ({ ...s, unit: p.unit || '' })), table: q.table || null, empty: !!q.empty, sample: false, provider: 'external', origin: 'external' };
      }
      return p;
    }));
    return { configured: configured(), uid, title: local.title, tags: local.tags || [], panels, variables: [], time: { from: 'now-6h', to: 'now' }, sample: true, local: true, pushed: !!local.pushed, autoPush: !!local.autoPush, grafanaUid: local.grafanaUid || '', pushedAt: local.pushedAt || '' };
  }
  // Sample dashboards are always available.
  const samp = SAMPLE_DASHBOARDS.find(d => d.uid === uid);
  if (samp) {
    return { configured: configured(), uid, title: samp.title, tags: samp.tags, panels: _samplePanels(samp.kind, uid), variables: [], time: { from: 'now-6h', to: 'now' }, sample: true };
  }
  if (!configured()) {
    // Unknown uid + no Grafana → best-effort host sample.
    return { configured: false, uid, title: 'Dashboard', tags: [], panels: _samplePanels('host', uid), variables: [], time: { from: 'now-6h', to: 'now' }, sample: true };
  }
  const doc = await _api(`/api/dashboards/uid/${encodeURIComponent(uid)}`, { timeoutMs: 12000 });
  const model = (doc && doc.dashboard) || {};
  const variables = _dashboardVariables(model);
  const from = opts.from || (model.time && model.time.from) || 'now-6h';
  const to = opts.to || (model.time && model.time.to) || 'now';
  const varMap = _varMap(model, opts.vars || {});
  const panels = await _panelsFromModel(model, uid, { varMap, from, to });
  return { configured: true, uid, title: model.title || 'Dashboard', tags: model.tags || [], variables, time: { from, to }, panels, sample: false };
}

// AMG's image renderer caps concurrent renders. Firing one request per panel
// (a dozen at once) trips "Concurrent server side render limit reached", and
// Grafana bakes that message into the returned PNG (HTTP 200, image/png) — so
// we can't detect it after the fact. The only reliable fix is to never exceed
// the limit: serialize upstream renders through a small semaphore, and cache
// results briefly so scroll / view-toggle / refresh don't re-hit the renderer.
const _RENDER_MAX = 2;
let _renderActive = 0;
const _renderWaiters = [];
function _acquireRenderSlot() {
  if (_renderActive < _RENDER_MAX) { _renderActive++; return Promise.resolve(); }
  return new Promise((resolve) => _renderWaiters.push(resolve));
}
function _releaseRenderSlot() {
  const next = _renderWaiters.shift();
  if (next) next(); // hand the still-held slot straight to the next waiter
  else _renderActive = Math.max(0, _renderActive - 1);
}
const _renderCache = new Map(); // apiPath -> { at, buffer, contentType }
const _RENDER_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Server-side PNG render of a single panel via Grafana's image renderer.
//
// Why this exists: a client-side <iframe> pointed at Azure Managed Grafana
// can't authenticate — AMG redirects to login.microsoftonline.com, which sends
// X-Frame-Options: DENY, so the browser refuses to frame it ("refused to
// connect"). Instead we render server-side: the SAME Azure bearer token we use
// for queries hits Grafana's /render/d-solo endpoint (AMG installs the image
// renderer automatically) and we stream the PNG back. The browser only ever
// loads a same-origin <img>, so there is no cross-origin framing or cookie/AAD
// dance at all.
// ---------------------------------------------------------------------------
async function renderPanel(uid, opts = {}) {
  const c = cfg();
  if (!c.url) { const e = new Error('grafana-not-configured'); e.code = 'NO_CONFIG'; throw e; }
  if (typeof fetch !== 'function') { const e = new Error('fetch-unavailable'); e.code = 'NO_FETCH'; throw e; }

  // A whole-dashboard render (one PNG for the entire dashboard) via /render/d,
  // vs a single panel via /render/d-solo. One dashboard request is far cheaper
  // than N per-panel requests and never trips the concurrent-render limit.
  const whole = !!opts.whole || opts.panelId == null || opts.panelId === '';
  const params = new URLSearchParams();
  if (!whole) params.set('panelId', String(opts.panelId));
  params.set('orgId', String(c.orgId || 1));
  params.set('from', String(opts.from || 'now-6h'));
  params.set('to', String(opts.to || 'now'));
  params.set('width', String(Math.max(240, Math.min(2400, parseInt(opts.width, 10) || (whole ? 1400 : 1000)))));
  const maxH = whole ? 8000 : 1200;
  params.set('height', String(Math.max(120, Math.min(maxH, parseInt(opts.height, 10) || (whole ? 1600 : 300)))));
  params.set('theme', opts.theme === 'light' ? 'light' : 'dark');
  params.set('tz', opts.tz || 'UTC');
  const vars = opts.vars || {};
  for (const [name, val] of Object.entries(vars)) {
    const arr = Array.isArray(val) ? val : [val];
    for (const v of arr) params.append('var-' + name, String(v));
  }
  const slug = opts.slug ? String(opts.slug).replace(/[^a-z0-9-]/gi, '') || '_' : '_';
  const apiPath = `/render/${whole ? 'd' : 'd-solo'}/${encodeURIComponent(uid)}/${slug}?${params.toString()}`;

  // Serve a fresh cached render if we have one (keyed on the exact request).
  const cached = _renderCache.get(apiPath);
  if (cached && (Date.now() - cached.at) < _RENDER_TTL_MS) {
    return { buffer: cached.buffer, contentType: cached.contentType };
  }

  let bearer;
  if (c.authMode === 'aad') bearer = await _aadBearer();
  else { if (!c.token) { const e = new Error('grafana-not-configured'); e.code = 'NO_CONFIG'; throw e; } bearer = c.token; }

  await _acquireRenderSlot();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || (whole ? 110000 : 45000));
  try {
    const headers = { Authorization: `Bearer ${bearer}`, Accept: 'image/png' };
    if (c.orgId) headers['X-Grafana-Org-Id'] = String(c.orgId);
    const res = await fetch(c.url + apiPath, { headers, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//i.test(ct)) {
      const txt = await res.text().catch(() => '');
      const e = new Error(`grafana-render-${res.status}`);
      e.status = res.status;
      e.contentType = ct;
      e.body = (txt || '').slice(0, 400);
      throw e;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const out = { buffer: buf, contentType: ct || 'image/png' };
    _renderCache.set(apiPath, { at: Date.now(), buffer: buf, contentType: out.contentType });
    return out;
  } finally {
    clearTimeout(timer);
    _releaseRenderSlot();
  }
}

// ---------------------------------------------------------------------------
// Spin-up: turn a spec into a stored (and optionally pushed) dashboard
// ---------------------------------------------------------------------------
// Build a native panel backed by an internal Workspace source (tasks, Me.AI runs,
// agenda, diary, activity, agents). The panel carries { source } so getDashboard
// can re-query live series each time it's opened, and provenance shows it's ours.
function _workspacePanel(pn, i) {
  const src = pn.source;
  const groupBy = pn.dimension || pn.groupBy || null;
  const metric = pn.metric || null;
  const q = workspace.query(src, { days: 30, split: pn.split !== false, groupBy, metric });
  return {
    id: i + 1,
    title: pn.title || q.name || `Panel ${i + 1}`,
    type: (pn.type === 'gauge' || pn.type === 'stat') ? 'gauge' : 'timeseries',
    unit: pn.unit || q.unit || '',
    source: src,
    dimension: groupBy || '',
    metric: metric || '',
    provider: 'workspace',
    origin: 'workspace',
    query: q.label || 'Internal workspace collection (direct aggregate)',
    split: pn.split !== false,
    series: (q.series || []).map(s => ({ ...s, unit: pn.unit || '' })),
    sample: false,
    empty: !!q.empty,
    alert: pn.alert || null,
  };
}

function _specToPanels(spec, uid) {
  const list = (spec.panels || []).slice(0, 12);
  return list.map((pn, i) => {
    // Internal Workspace source? Resolve live series instead of synthesizing.
    if (pn && typeof pn.source === 'string' && workspace.isWorkspaceSource(pn.source)) {
      return _workspacePanel(pn, i);
    }
    const type = (pn.type === 'gauge' || pn.type === 'stat') ? 'gauge' : 'timeseries';
    const unit = pn.unit || '';
    // External (Grafana datasource) source? Do NOT synthesize demo data. Carry
    // the AI-authored query + datasource identity so the panel is live-queried
    // at render time; until then it is honest-empty (never a fake sample).
    const isExternal = typeof pn.source === 'string' && /^ds\./.test(pn.source);
    if (isExternal) {
      const hasQuery = !!(pn.query && pn.datasourceUid);
      return {
        id: i + 1,
        title: pn.title || `Panel ${i + 1}`,
        type,
        unit,
        source: pn.source,
        provider: 'external',
        origin: 'external',
        dsType: pn.dsType || '',
        datasourceUid: pn.datasourceUid || '',
        database: pn.database || '',
        dimension: pn.dimension || '',
        metric: pn.metric || '',
        query: pn.query || '',
        series: [],
        table: null,
        sample: false,
        empty: true,
        note: hasQuery
          ? 'Live data loads from the connected data source at render time.'
          : 'No query was provided for this source — connect the data source and add a query to see live data.',
        alert: pn.alert || null,
      };
    }
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
      origin: 'sample',
      source: pn.source || 'sample',
      query: pn.query || 'Synthesized sample series (demo data)',
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

// ---------------------------------------------------------------------------
// Context & data catalog — the unified list of sources the AI can GROUND on or
// CHART from. Internal Workspace sources come from workspace-source.js; external
// sources are the connected Grafana datasources (queried directly where we have a
// connector, else via the AMG MCP fallback).
// ---------------------------------------------------------------------------
async function catalog() {
  const internal = workspace.catalog();
  let external = [];
  try {
    const st = await status();
    external = (st.sources || [])
      .filter(s => s.type && s.type !== 'sample')
      .map(s => ({
        id: 'ds.' + String(s.name || s.type).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: s.name || s.type,
        icon: /kusto|adx|data ?explorer/i.test(s.type) ? '🔷' : /prom/i.test(s.type) ? '📈' : /insight|log/i.test(s.type) ? '🧠' : '☁️',
        group: 'grafana',
        provider: 'grafana',
        dsType: s.type,
        uid: s.uid || '',
        roles: { ground: true, chart: true, alert: true },
        chartable: true,
        alertable: true,
        // Direct connector today = Kusto/ADX; everything else falls back to AMG MCP.
        access: /kusto|adx|data ?explorer/i.test(s.type) ? 'direct' : 'amg-mcp',
        count: null,
      }));
  } catch { external = []; }
  return { workspace: internal, external, configured: configured() };
}

// Query a chartable source by catalog id (internal 'ws.*' → workspace provider).
function queryWorkspace(id, opts) { return workspace.query(id, opts || {}); }
function groundContext(id) { return workspace.groundContext(id); }
function evaluateWorkspaceAlert(rule) { return workspace.evaluateAlert(rule); }
function isWorkspaceSource(id) { return workspace.isWorkspaceSource(id); }

// Discovery: profile what a source actually contains (time field, real
// categorical dimensions + top values, numeric metrics, a sample). Used to
// build an honest brief for the dashboard designer so panels bind to REAL
// discovered signals, not synthesized demo data. Internal ws.* sources profile
// live records synchronously; external ds.* are profiled asynchronously against
// the connected Grafana datasource (see discoverExternal).
function discover(id) {
  if (isWorkspaceSource(id)) return workspace.discover(id);
  return null;
}

// ---- External (Grafana datasource) discovery + query — Phase 2 -------------
// External sources are the datasources registered in the connected Azure
// Managed Grafana. We query them through Grafana's own /api/ds/query proxy (the
// same path _queryPanel uses for live dashboards), so ANY datasource type works
// uniformly and we never synthesize demo data for a real source.

// Resolve a catalog id (ds.*) back to its Grafana datasource identity.
async function _resolveExternal(id) {
  try {
    const cat = await catalog();
    return (cat.external || []).find(s => s.id === id) || null;
  } catch { return null; }
}

// Classify an ADX/Kusto column type into our discovery shape.
function _adxRole(cslType) {
  const t = String(cslType || '').toLowerCase();
  if (/datetime|timespan/.test(t)) return 'time';
  if (/real|long|int|decimal|double/.test(t)) return 'metric';
  return 'dimension'; // string, guid, bool, dynamic → group-by candidate
}

// Parse the ADX Grafana plugin's schema resource payload into tables→columns.
// Shape: { Databases: { <db>: { Tables: { <t>: { OrderedColumns: [{Name,CslType}] } } } } }
function _parseAdxSchema(schema) {
  const tables = [];
  const dbs = (schema && schema.Databases) || {};
  for (const dbName of Object.keys(dbs)) {
    const tbls = (dbs[dbName] && dbs[dbName].Tables) || {};
    for (const tName of Object.keys(tbls)) {
      const cols = (tbls[tName] && tbls[tName].OrderedColumns) || [];
      if (!cols.length) continue;
      tables.push({
        database: dbName,
        table: tName,
        columns: cols.map(c => ({ name: c.Name, type: c.CslType, role: _adxRole(c.CslType) })),
      });
    }
  }
  return tables;
}

// Build a uniform discovery brief (mirrors workspace.discover) from a chosen
// ADX table's columns, so the AI designer + _monValidatePanel treat external and
// internal sources identically.
function _adxTableToDiscovery(id, name, uid, dsType, tbl) {
  const cols = tbl.columns || [];
  const timeField = (cols.find(c => c.role === 'time') || {}).name || '';
  const dimensions = cols.filter(c => c.role === 'dimension').slice(0, 8)
    .map(c => ({ field: c.name, cardinality: null, present: null, values: [] }));
  const metrics = [{ field: 'count', agg: 'count', label: 'Record count over time' }]
    .concat(cols.filter(c => c.role === 'metric').slice(0, 5).map(c => ({ field: c.name, agg: 'sum', label: `${c.name} (sum)` })));
  return {
    id, name, external: true, dsType, uid,
    database: tbl.database, table: tbl.table,
    count: null, timeField, dimensions, metrics, sample: [],
    tables: undefined,
  };
}

// Probe a connected external datasource's real schema. Returns a uniform
// discovery object when we can profile it, or { id, name, profiled:false, ... }
// (honest — the AI may still target it with a query, but nothing is fabricated).
// Only ADX/Kusto is profiled today; other datasource types report profiled:false.
async function discoverExternal(id) {
  const src = await _resolveExternal(id);
  if (!src) return { id, name: id, external: true, profiled: false, reason: 'unknown-source' };
  if (!configured()) return { id, name: src.name, external: true, dsType: src.dsType, uid: src.uid, profiled: false, reason: 'grafana-not-configured' };
  const base = { id, name: src.name, external: true, dsType: src.dsType, uid: src.uid, access: src.access };
  if (src.access !== 'direct') return { ...base, profiled: false, reason: 'no-profiler-for-type' };
  // ADX/Kusto: fetch the schema via the plugin's resource proxy.
  let tables = [];
  try {
    const schema = await _api(`/api/datasources/uid/${encodeURIComponent(src.uid)}/resources/schema`, { timeoutMs: 12000 });
    tables = _parseAdxSchema(schema && schema.Databases ? schema : (schema && schema.schema) || schema);
  } catch { tables = []; }
  if (!tables.length) return { ...base, profiled: false, reason: 'schema-unavailable' };
  // Represent the source by the table with a time column and the most columns
  // (best charting candidate); surface the rest as alternatives for the AI.
  const ranked = tables.slice().sort((a, b) => {
    const at = a.columns.some(c => c.role === 'time') ? 1 : 0;
    const bt = b.columns.some(c => c.role === 'time') ? 1 : 0;
    if (at !== bt) return bt - at;
    return (b.columns.length) - (a.columns.length);
  });
  const chosen = ranked[0];
  const d = _adxTableToDiscovery(id, src.name, src.uid, src.dsType, chosen);
  d.profiled = true;
  d.tables = ranked.slice(0, 12).map(t => ({ database: t.database, table: t.table, columns: t.columns.map(c => ({ name: c.name, type: c.type, role: c.role })) }));
  return d;
}

// Build a Grafana /api/ds/query target for an external panel from an
// AI-authored query string + the datasource identity. Query language is the
// datasource's own (KQL for ADX, PromQL for Prometheus, etc.).
function _externalTarget(panel, refId) {
  const uid = panel.datasourceUid || '';
  const dsType = String(panel.dsType || '');
  const query = String(panel.query || '');
  const ds = uid ? { uid, type: dsType } : undefined;
  const t = { refId: refId || 'A', datasource: ds };
  if (/kusto|adx|data ?explorer/i.test(dsType)) {
    if (panel.database) t.database = panel.database;
    t.query = query;
    t.resultFormat = 'time_series';
    t.querySource = 'raw';
    t.pluginVersion = t.pluginVersion || undefined;
  } else if (/prometheus/i.test(dsType)) {
    t.expr = query;
    t.range = true;
  } else {
    // Generic: most SQL-like plugins accept rawSql; keep the raw query too.
    t.rawSql = query;
    t.query = query;
  }
  return t;
}

// Execute an external panel's query live against Grafana's datasource proxy.
// Returns { series, table, empty }. Best-effort: any failure (not configured,
// no query, proxy error) yields an honest-empty result — never fabricated data.
async function queryExternal(panel, ctx = {}) {
  if (!configured()) return { series: [], table: null, empty: true, reason: 'grafana-not-configured' };
  if (!panel || !panel.query || !panel.datasourceUid) return { series: [], table: null, empty: true, reason: 'no-query' };
  const from = ctx.from || 'now-6h';
  const to = ctx.to || 'now';
  const intervalMs = _computeIntervalMs(from, to, 300);
  const target = _externalTarget(panel, 'A');
  target.intervalMs = intervalMs;
  target.maxDataPoints = 300;
  const body = { queries: _expandMacros([target], intervalMs), from, to };
  let out;
  try { out = await _api('/api/ds/query', { method: 'POST', body, timeoutMs: 15000 }); }
  catch (e) { return { series: [], table: null, empty: true, reason: 'query-failed', error: e.message }; }
  const wantTable = String((panel && panel.type) || '').toLowerCase() === 'table';
  const parsed = _framesToSeriesTable(out, wantTable);
  const total = (parsed.series || []).reduce((a, s) => a + (s.data || []).reduce((b, p) => b + (p[1] || 0), 0), 0);
  return { series: parsed.series, table: parsed.table, empty: !(parsed.series && parsed.series.length) && !(parsed.table && parsed.table.rows && parsed.table.rows.length), total };
}

// ---- Alert rules on Workspace collections ---------------------------------
// Persisted threshold rules over internal ws.* sources (tasks/Me.AI/agenda/…).
// Rule: { id, sourceId, name, agg, op, value, window:{days}, enabled, lastFired,
//         lastState, lastValue, createdAt, updatedAt }. Evaluation is pure (reads
//         live workspace series); firing/notification is the caller's concern.
const ALERTS_FILE = path.join(MON_DIR, 'alerts.json');
function _readAlerts() {
  try { const j = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function _writeAlerts(arr) {
  try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.warn('[monitoring] alerts save failed:', e.message); }
}
function listAlerts() { return _readAlerts(); }
function saveAlert(rule) {
  const r = rule || {};
  if (!isWorkspaceSource(r.sourceId)) throw new Error('Alerts are supported on internal Workspace sources only.');
  const src = (workspace.catalog() || []).find(s => s.id === r.sourceId);
  if (!src || !src.alertable) throw new Error('That source is not alertable.');
  const all = _readAlerts();
  const now = new Date().toISOString();
  const clean = {
    id: r.id || ('al-' + Math.random().toString(36).slice(2, 9)),
    sourceId: r.sourceId,
    name: String(r.name || src.name || r.sourceId).slice(0, 120),
    agg: ['last', 'sum', 'max', 'avg'].includes(r.agg) ? r.agg : 'sum',
    op: ['>', '>=', '<', '<=', '=='].includes(r.op) ? r.op : '>',
    value: Number.isFinite(Number(r.value)) ? Number(r.value) : 0,
    window: { days: Math.max(1, Math.min(90, Number(r.window && r.window.days) || 7)) },
    enabled: r.enabled !== false,
    target: ['app', 'email'].includes(r.target) ? r.target : 'app',
    lastFired: null, lastState: 'ok', lastValue: null,
    createdAt: now, updatedAt: now,
  };
  const idx = all.findIndex(a => a.id === clean.id);
  if (idx >= 0) { clean.createdAt = all[idx].createdAt || now; clean.lastFired = all[idx].lastFired || null; all[idx] = { ...all[idx], ...clean }; }
  else all.unshift(clean);
  _writeAlerts(all.slice(0, 200));
  return clean;
}
function deleteAlert(id) {
  const all = _readAlerts();
  const next = all.filter(a => a.id !== id);
  _writeAlerts(next);
  return { ok: true, removed: all.length - next.length };
}
// Evaluate every enabled rule; persist state transitions; return the rules that
// crossed from ok→firing on THIS pass (so the caller notifies exactly once).
function evaluateAlerts() {
  const all = _readAlerts();
  const fired = [];
  let changed = false;
  for (const a of all) {
    if (!a.enabled) continue;
    let ev;
    try { ev = workspace.evaluateAlert(a); } catch { ev = null; }
    if (!ev) continue;
    const state = ev.fired ? 'firing' : 'ok';
    const wasFiring = a.lastState === 'firing';
    a.lastValue = ev.actual; a.lastState = state; a.updatedAt = new Date().toISOString();
    if (state === 'firing' && !wasFiring) { a.lastFired = a.updatedAt; fired.push({ ...a, observed: ev.actual, threshold: ev.threshold }); }
    changed = true;
  }
  if (changed) _writeAlerts(all);
  return { fired, evaluated: all.filter(a => a.enabled).length };
}

module.exports = {
  cfg,
  configured,
  resetAuthCache,
  status,
  listDashboards,
  getDashboard,
  renderPanel,
  createDashboard,
  pushDashboard,
  setDashboardOptions,
  panelSummary,
  deterministicAnalysis,
  deterministicSpec,
  catalog,
  discover,
  discoverExternal,
  queryExternal,
  queryWorkspace,
  groundContext,
  evaluateWorkspaceAlert,
  isWorkspaceSource,
  listAlerts,
  saveAlert,
  deleteAlert,
  evaluateAlerts,
  // exposed for tests
  _internal: { sampleSeries, _trend, _samplePanels, _sampleDashboardList, SAMPLE_DASHBOARDS, _api, _dashboardVariables, _varMap, _formatVarValue, _applyVars, _queryPanel, _timeToMs, _grafanaDuration, _computeIntervalMs, _expandMacros, _panelSourceText, _panelQueryText, _framesToSeriesTable, _parseAdxSchema, _adxTableToDiscovery, _externalTarget, _adxRole, _specToPanels },
};
