// ---------------------------------------------------------------------------
// epic-telemetry.js — Objective Health → App Insights ETL (aggregation layer).
//
// TheOffice.AI already records each epic objective's measurable value into its
// OWN honest history (_epicOHAppendReadings in server.js). This module is the
// TRANSLATION layer: it emits those RECORDED readings into a shared Application
// Insights instance as `EpicObjectiveReading` custom events, so a per-epic
// Grafana dashboard (Azure Monitor datasource) can read back durable, shared,
// retention-managed trend history. Grafana becomes a dumb front-end portal over
// data we own and shape.
//
// HONESTY INVARIANT: we only ever emit points that came from the recorded
// history. Objectives with no numeric reading (missing-source / manual) emit a
// status-only event (no `value` measurement) so the panel can show an honest
// "no data" / manual state — never a fabricated series.
//
// Emission is plain HTTPS to the App Insights ingestion (Breeze) endpoint using
// the connection string — no SDK dependency. Default OFF: nothing is sent until
// the user enables monitoringTelemetry + sets a connection string in Settings.
// ---------------------------------------------------------------------------
'use strict';

const https = require('https');
const { URL } = require('url');
const settings = require('./settings');

const EVENT_NAME = 'EpicObjectiveReading';
const CLOUD_ROLE = 'TheOffice.AI';
const MAX_ENVELOPES = 5000; // hard ceiling so a pathological backfill can't run away

function cfg() {
  const s = settings.getSettings() || {};
  const m = (s.monitoringTelemetry && typeof s.monitoringTelemetry === 'object') ? s.monitoringTelemetry : {};
  return {
    enabled: !!m.enabled,
    connectionString: String(m.connectionString || ''),
    resourceId: String(m.resourceId || ''),
    subscriptionId: String(m.subscriptionId || ''),
    appInsightsName: String(m.appInsightsName || ''),
    resourceGroup: String(m.resourceGroup || ''),
    datasourceUid: String(m.datasourceUid || ''),
    grafanaUrl: String(m.grafanaUrl || ''),
    grafanaToken: String(m.grafanaToken || ''),
  };
}

// Parse an App Insights connection string into its parts. Returns null when the
// instrumentation key is missing (nothing we can send). The ingestion endpoint
// defaults to the classic global endpoint when the string omits it.
function parseConnectionString(cs) {
  const str = String(cs || '').trim();
  if (!str) return null;
  const parts = {};
  for (const seg of str.split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
  }
  const iKey = parts['instrumentationkey'] || '';
  if (!iKey) return null;
  let endpoint = parts['ingestionendpoint'] || 'https://dc.services.visualstudio.com/';
  if (!/\/$/.test(endpoint)) endpoint += '/';
  return { instrumentationKey: iKey, ingestionEndpoint: endpoint };
}

function configured() {
  const c = cfg();
  return c.enabled && !!parseConnectionString(c.connectionString);
}

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build one Breeze customEvent envelope for a single reading. Pure + testable.
function _envelope(iKey, epic, obj, point) {
  const props = {
    epicKey: String(epic.key || ''),
    epicId: epic.epicId != null ? String(epic.epicId) : '',
    epicTitle: String(epic.epicTitle || ''),
    objective: String(obj.title || ''),
    status: String(obj.status || ''),
    sourceType: String(obj.srcType || obj.sourceType || ''),
    target: obj.tgt != null ? String(obj.tgt) : '',
    measurableRaw: point && point.raw != null ? String(point.raw) : '',
  };
  const baseData = { ver: 2, name: EVENT_NAME, properties: props };
  const val = point ? _num(point.v) : null;
  if (val != null) baseData.measurements = { value: val };
  const time = point && point.t ? new Date(point.t) : new Date();
  return {
    name: 'Microsoft.ApplicationInsights.Event',
    time: time.toISOString(),
    iKey,
    tags: { 'ai.cloud.role': CLOUD_ROLE, 'ai.cloud.roleInstance': String(epic.key || 'epic') },
    data: { baseType: 'EventData', baseData },
  };
}

// Build the envelopes for an epic's objectives. Emits ONLY recorded-history
// points whose timestamp is strictly after `sinceTs` (0 = full backfill on the
// first publish). Missing-source / manual objectives with no numeric history
// emit a single status-only event (no value) so the panel can show an honest
// gap/manual state. Returns { envelopes, maxTs } where maxTs is the newest point
// timestamp emitted (so the caller can advance its watermark). Pure + testable.
function buildEnvelopes(epic, objectives, opts = {}) {
  const parsed = parseConnectionString(opts.connectionString || cfg().connectionString);
  if (!parsed) return { envelopes: [], maxTs: opts.sinceTs || 0 };
  const iKey = parsed.instrumentationKey;
  const sinceTs = Number(opts.sinceTs || 0);
  const envelopes = [];
  let maxTs = sinceTs;
  for (const obj of (objectives || [])) {
    if (!obj) continue;
    const hist = Array.isArray(obj.history) ? obj.history : [];
    const newPoints = hist.filter(p => p && _num(p.v) != null && Number(new Date(p.t).getTime()) > sinceTs);
    if (newPoints.length) {
      for (const p of newPoints) {
        envelopes.push(_envelope(iKey, epic, obj, p));
        const ts = Number(new Date(p.t).getTime());
        if (ts > maxTs) maxTs = ts;
      }
    } else if (!hist.some(p => p && _num(p.v) != null)) {
      // No numeric history at all (missing-source / manual) — emit ONE honest
      // status marker (no value) only on the first publish for this epic.
      if (sinceTs === 0) envelopes.push(_envelope(iKey, epic, obj, null));
    }
    if (envelopes.length >= MAX_ENVELOPES) break;
  }
  return { envelopes: envelopes.slice(0, MAX_ENVELOPES), maxTs };
}

// POST a batch of Breeze envelopes to the ingestion endpoint. Best-effort:
// never throws — returns { ok, count, status?, error? }.
function _post(endpoint, envelopes) {
  return new Promise((resolve) => {
    if (!envelopes.length) { resolve({ ok: true, count: 0 }); return; }
    let u;
    try { u = new URL('v2.1/track', endpoint); } catch (e) { resolve({ ok: false, count: 0, error: 'bad-endpoint' }); return; }
    const payload = Buffer.from(JSON.stringify(envelopes), 'utf8');
    const req = https.request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 15000,
    }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        resolve({ ok, count: envelopes.length, status: r.statusCode, body: body.slice(0, 400) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, count: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, count: 0, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

// Emit an epic's recorded readings to App Insights. `sinceTs` is the caller's
// watermark (last emitted point time); 0 = backfill. Returns the post result +
// the advanced watermark. No-op (ok:false, reason) when not configured.
async function emit(epic, objectives, opts = {}) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled', count: 0, maxTs: opts.sinceTs || 0 };
  const parsed = parseConnectionString(c.connectionString);
  if (!parsed) return { ok: false, reason: 'no-connection-string', count: 0, maxTs: opts.sinceTs || 0 };
  const { envelopes, maxTs } = buildEnvelopes(epic, objectives, { connectionString: c.connectionString, sinceTs: opts.sinceTs || 0 });
  if (!envelopes.length) return { ok: true, reason: 'nothing-new', count: 0, maxTs };
  const r = await _post(parsed.ingestionEndpoint, envelopes);
  return { ...r, maxTs: r.ok ? maxTs : (opts.sinceTs || 0) };
}

module.exports = {
  cfg, configured, parseConnectionString, buildEnvelopes, emit,
  EVENT_NAME,
  _internal: { _envelope, _post, _num },
};
