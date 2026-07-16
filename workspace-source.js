'use strict';

// Monitoring.AI — Workspace data-source provider.
//
// This module makes TheOffice.AI's OWN internal collections queryable through the
// same interface Monitoring.AI uses for external Grafana datasources (Kusto, Prom,
// Azure Monitor). Every collection is a "source" with up to three roles:
//
//   * GROUND  — the AI reads it as context for goals/thresholds/what-matters. Not charted.
//   * CHART   — the AI queries/aggregates it into native timeseries panels.
//   * ALERT   — a chartable source can also carry threshold alert rules.
//
// The provider reads the on-disk stores directly (via data-paths) and is fully
// defensive: a missing/empty store yields an empty result, never a throw, so the
// catalog and query path stay honest ("no data yet") instead of fabricating.
//
// No AI and no network live here. server.js owns the LLM calls; grafana.js owns the
// external bridge. This is purely the internal "data source" surface.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');

// ---------------------------------------------------------------------------
// Small safe readers
// ---------------------------------------------------------------------------
function _readJson(p, fallback) {
  try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v; } catch { return fallback; }
}
function _readDirEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function _fileTime(p) {
  try { const s = fs.statSync(p); return (s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs) || s.mtimeMs; } catch { return 0; }
}
// Pull the first usable epoch-ms out of an object's common timestamp fields.
function _tsOf(o) {
  if (!o || typeof o !== 'object') return 0;
  const fields = ['createdAt', 'created', 'created_at', 'ts', 'time', 'timestamp', 'date', 'day', 'startedAt', 'finishedAt', 'completedAt', 'updatedAt', 'updated', 'lastRun', 'lastRunAt'];
  for (const f of fields) {
    const v = o[f];
    if (v == null) continue;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // seconds vs ms
    const t = Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Time window + bucketing
// ---------------------------------------------------------------------------
// Normalize a window spec into { fromMs, toMs, binMs, bins, label }.
function _window(opts = {}) {
  const now = Date.now();
  let days = Number(opts.days);
  if (!Number.isFinite(days) || days <= 0) days = 30;
  days = Math.min(days, 365);
  const toMs = Number.isFinite(opts.toMs) ? opts.toMs : now;
  const fromMs = Number.isFinite(opts.fromMs) ? opts.fromMs : (toMs - days * 86400000);
  const span = Math.max(1, toMs - fromMs);
  // Auto bin: hourly for <= 2 days, else daily.
  const bin = opts.bin || (span <= 2 * 86400000 ? 'hour' : 'day');
  const binMs = bin === 'hour' ? 3600000 : 86400000;
  const bins = Math.max(1, Math.min(400, Math.ceil(span / binMs)));
  return { fromMs, toMs, binMs, bins, bin, label: bin === 'hour' ? 'per hour' : 'per day' };
}

// Bucket a list of { t, value?, key? } events into one or more series.
// - When events carry `key`, we split into a series per distinct key (stacked view).
// - `value` (if present) is SUMMED per bin; otherwise each event counts as 1.
function _bucket(events, w, { splitKey = false, topKeys = 6 } = {}) {
  const inRange = (events || []).filter(e => e && e.t >= w.fromMs && e.t <= w.toMs);
  const base = () => new Array(w.bins).fill(0);
  const idxOf = (t) => Math.min(w.bins - 1, Math.max(0, Math.floor((t - w.fromMs) / w.binMs)));
  const stampAt = (i) => Math.round(w.fromMs + i * w.binMs);

  if (splitKey) {
    const byKey = new Map();
    for (const e of inRange) {
      const k = String(e.key || 'other');
      if (!byKey.has(k)) byKey.set(k, base());
      byKey.get(k)[idxOf(e.t)] += (typeof e.value === 'number' ? e.value : 1);
    }
    // Keep the busiest keys.
    const ranked = [...byKey.entries()].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, topKeys);
    return ranked.map(([name, arr]) => ({ name, data: arr.map((v, i) => [stampAt(i), v]) }));
  }

  const arr = base();
  for (const e of inRange) arr[idxOf(e.t)] += (typeof e.value === 'number' ? e.value : 1);
  return [{ name: 'count', data: arr.map((v, i) => [stampAt(i), v]) }];
}

// ---------------------------------------------------------------------------
// Collection readers — each returns { events:[{t,value?,key?,status?}], count,
// ground:string[] }. Never throws.
// ---------------------------------------------------------------------------
function _readTasks() {
  const arr = _readJson(dataPath('tasks.json'), []);
  if (!Array.isArray(arr)) return { events: [], count: 0, ground: [] };
  const events = arr.map(t => ({ t: _tsOf(t), key: t.status || t.state || 'task', status: t.status || t.state })).filter(e => e.t > 0);
  const ground = arr.slice(0, 40).map(t => `• ${t.title || t.name || t.prompt || t.id || 'task'}${t.status ? ` [${t.status}]` : ''}`);
  return { events, count: arr.length, ground };
}

function _readAgents() {
  const arr = _readJson(dataPath('agents.json'), []);
  if (!Array.isArray(arr)) return { events: [], count: 0, ground: [] };
  const events = arr.map(a => ({ t: _tsOf(a), key: a.type || a.category || 'agent' })).filter(e => e.t > 0);
  const ground = arr.slice(0, 40).map(a => `• ${a.name || a.id}${a.description ? ` — ${String(a.description).slice(0, 120)}` : ''}`);
  return { events, count: arr.length, ground };
}

function _readBoards() {
  const arr = _readJson(dataPath('boards.json'), []);
  if (!Array.isArray(arr)) return { events: [], count: 0, ground: [] };
  const events = [];
  for (const b of arr) {
    const bt = _tsOf(b);
    if (bt > 0) events.push({ t: bt, key: b.name || 'board' });
    for (const it of (Array.isArray(b.items) ? b.items : [])) { const t = _tsOf(it); if (t > 0) events.push({ t, key: b.name || 'board' }); }
    for (const n of (Array.isArray(b.notes) ? b.notes : [])) { const t = _tsOf(n); if (t > 0) events.push({ t, key: b.name || 'board' }); }
  }
  const ground = arr.slice(0, 30).map(b => `• ${b.name || b.id} (${(b.items || []).length} items, ${(b.notes || []).length} notes)`);
  return { events, count: arr.length, ground };
}

// Me.AI runs live as per-run directories under me-ai/runs.
function _readMeAiRuns() {
  const dir = path.join(dataPath('me-ai'), 'runs');
  const ents = _readDirEntries(dir).filter(e => e.isDirectory());
  const events = [];
  const ground = [];
  for (const e of ents) {
    const runDir = path.join(dir, e.name);
    // Prefer a structured run record if one exists.
    let rec = null;
    for (const fn of ['run.json', 'task.json', 'meta.json', 'index.json']) {
      const rp = path.join(runDir, fn);
      if (fs.existsSync(rp)) { rec = _readJson(rp, null); if (rec) break; }
    }
    const t = (rec && _tsOf(rec)) || _fileTime(runDir);
    if (t > 0) {
      const status = (rec && (rec.status || rec.state || rec.result)) || 'run';
      events.push({ t, key: String(status), status });
      if (ground.length < 30) ground.push(`• ${(rec && (rec.title || rec.name || rec.prompt)) || e.name}${status ? ` [${status}]` : ''}`);
    }
  }
  return { events, count: ents.length, ground };
}

// Agenda is stored as per-day JSON under me-ai/agenda; each file is one day's plan.
function _readAgenda() {
  const dir = path.join(dataPath('me-ai'), 'agenda');
  const ents = _readDirEntries(dir).filter(e => e.isFile() && e.name.endsWith('.json'));
  const events = [];
  const ground = [];
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    const day = _readJson(fp, null);
    // Day filename is often YYYY-MM-DD.json.
    const m = e.name.match(/(\d{4}-\d{2}-\d{2})/);
    const t = m ? Date.parse(m[1] + 'T12:00:00') : _fileTime(fp);
    const items = day && (Array.isArray(day.items) ? day.items : Array.isArray(day.blocks) ? day.blocks : Array.isArray(day.agenda) ? day.agenda : Array.isArray(day) ? day : []);
    const n = Array.isArray(items) ? items.length : 0;
    if (t > 0) events.push({ t, value: n || 1, key: 'agenda' });
    if (ground.length < 20 && m) ground.push(`• ${m[1]}: ${n} agenda item${n === 1 ? '' : 's'}`);
  }
  return { events, count: ents.length, ground };
}

// Connect diary — the living impact/Connect diary (consent-gated). Stored under
// the connect plugin dir. Each entry file is one diary evidence item.
function _readDiary() {
  const roots = [dataPath('connect'), path.join(dataPath('connect'), 'diary'), path.join(dataPath('connect'), 'entries')];
  const events = [];
  const ground = [];
  let count = 0;
  for (const root of roots) {
    for (const e of _readDirEntries(root)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const fp = path.join(root, e.name);
      const rec = _readJson(fp, null);
      const t = (rec && _tsOf(rec)) || _fileTime(fp);
      if (t > 0) { events.push({ t, key: (rec && (rec.area || rec.category)) || 'diary' }); count++; if (ground.length < 25 && rec) ground.push(`• ${rec.headline || rec.title || rec.summary || e.name}`); }
    }
  }
  return { events, count, ground };
}

// Documents (Compose.AI library) — ground-only prose context.
function _readDocs() {
  const roots = [dataPath('compose'), path.join(dataPath('compose'), 'documents'), dataPath('docs')];
  const ground = [];
  let count = 0;
  for (const root of roots) {
    for (const e of _readDirEntries(root)) {
      if (e.isDirectory()) continue;
      count++;
      if (ground.length < 30) ground.push(`• ${e.name}`);
    }
  }
  return { events: [], count, ground };
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------
// group: 'workspace' (ours) | grafana datasources are added by grafana.js.
// role flags describe what the source SUPPORTS (the user still opts a role on/off).
const SOURCES = [
  { id: 'ws.tasks',    name: 'Tasks',            icon: '✅', group: 'workspace', ground: true, chart: true,  alertable: true,  read: _readTasks,   chartLabel: 'Tasks over time by status' },
  { id: 'ws.meai',     name: 'Me.AI runs',       icon: '⚙️', group: 'workspace', ground: true, chart: true,  alertable: true,  read: _readMeAiRuns, chartLabel: 'Me.AI runs over time by outcome' },
  { id: 'ws.agenda',   name: 'Agenda',           icon: '🗓️', group: 'workspace', ground: true, chart: true,  alertable: true,  read: _readAgenda,  chartLabel: 'Agenda item density per day' },
  { id: 'ws.diary',    name: 'Connect diary',    icon: '📔', group: 'workspace', ground: true, chart: true,  alertable: false, read: _readDiary,   chartLabel: 'Diary evidence cadence' },
  { id: 'ws.activity', name: 'Activity feed',    icon: '📈', group: 'workspace', ground: true, chart: true,  alertable: true,  read: _readBoards,  chartLabel: 'Board activity over time' },
  { id: 'ws.agents',   name: 'Agents',           icon: '🤖', group: 'workspace', ground: true, chart: true,  alertable: true,  read: _readAgents,  chartLabel: 'Agents by type' },
  { id: 'ws.docs',     name: 'Docs & runbooks',  icon: '📄', group: 'workspace', ground: true, chart: false, alertable: false, read: _readDocs,    chartLabel: '' },
];

function _source(id) { return SOURCES.find(s => s.id === id) || null; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// The catalog descriptor for every internal source, with a live best-effort count.
function catalog() {
  return SOURCES.map(s => {
    let count = 0;
    try { count = s.read().count || 0; } catch { count = 0; }
    return {
      id: s.id,
      name: s.name,
      icon: s.icon,
      group: s.group,
      provider: 'workspace',
      roles: { ground: !!s.ground, chart: !!s.chart, alert: !!s.alertable },
      chartable: !!s.chart,
      alertable: !!s.alertable,
      count,
      chartLabel: s.chartLabel || '',
    };
  });
}

// Ground context text for a source (the AI reads this — it is NOT charted).
function groundContext(id) {
  const s = _source(id);
  if (!s) return { id, name: id, text: '' };
  let ground = [];
  try { ground = s.read().ground || []; } catch { ground = []; }
  return { id: s.id, name: s.name, count: (() => { try { return s.read().count; } catch { return 0; } })(), text: ground.join('\n') };
}

// Query a chartable internal source into native timeseries panels.
// opts: { days, bin, split } — split=true yields a series per status/key.
function query(id, opts = {}) {
  const s = _source(id);
  if (!s || !s.chart) return { id, series: [], sample: false, empty: true, source: 'workspace' };
  const w = _window(opts);
  let events = [];
  try { events = s.read().events || []; } catch { events = []; }
  const series = _bucket(events, w, { splitKey: !!opts.split, topKeys: opts.topKeys || 6 });
  const total = series.reduce((acc, ser) => acc + ser.data.reduce((a, p) => a + p[1], 0), 0);
  return {
    id: s.id,
    name: s.name,
    provider: 'workspace',
    unit: '',
    label: s.chartLabel || '',
    window: { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), bin: w.bin },
    series,
    total,
    sample: false,
    empty: total === 0,
    source: 'workspace',
  };
}

// Evaluate a threshold alert rule against a chartable source.
// rule: { sourceId, agg:'last'|'sum'|'max'|'avg', op:'>'|'>='|'<'|'<='|'==', value, window:{days} }
function evaluateAlert(rule) {
  if (!rule || !rule.sourceId) return { ok: false, error: 'rule.sourceId required' };
  const r = query(rule.sourceId, rule.window || {});
  const ser = (r.series && r.series[0]) || { data: [] };
  const vals = ser.data.map(p => p[1]);
  let actual = 0;
  switch (rule.agg) {
    case 'sum': actual = vals.reduce((a, b) => a + b, 0); break;
    case 'max': actual = vals.length ? Math.max(...vals) : 0; break;
    case 'avg': actual = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
    case 'last': default: actual = vals.length ? vals[vals.length - 1] : 0; break;
  }
  const thr = Number(rule.value);
  let fired = false;
  switch (rule.op) {
    case '>': fired = actual > thr; break;
    case '>=': fired = actual >= thr; break;
    case '<': fired = actual < thr; break;
    case '<=': fired = actual <= thr; break;
    case '==': fired = actual === thr; break;
    default: fired = actual > thr;
  }
  return { ok: true, fired, actual, threshold: thr, agg: rule.agg || 'last', op: rule.op || '>', sourceId: rule.sourceId, name: (r.name || rule.sourceId) };
}

module.exports = {
  catalog,
  groundContext,
  query,
  evaluateAlert,
  isWorkspaceSource: (id) => !!_source(id),
  // exposed for tests
  _internal: { _bucket, _window, _tsOf, SOURCES },
};
