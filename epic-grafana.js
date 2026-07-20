// ---------------------------------------------------------------------------
// epic-grafana.js — Objective Health → Azure Managed Grafana dashboard model.
//
// The aggregation layer (epic-telemetry.js) emits each epic objective's RECORDED
// readings into a shared App Insights instance as `EpicObjectiveReading` custom
// events. This module turns a persisted Objective-Health snapshot into a Grafana
// dashboard MODEL whose panels read that sink back via the Azure Monitor Logs
// datasource (real KQL targets). Grafana is a dumb front-end portal over data we
// own and shape.
//
// The model is importable JSON (paste into Grafana → Import, or download). When a
// Grafana workspace URL + service-account token are configured we also push it
// over the HTTP API — best-effort; the importable JSON is always returned.
//
// Everything here is pure except pushDashboard(); no SDK / global state.
// ---------------------------------------------------------------------------
'use strict';

const https = require('https');
const { URL } = require('url');

function _kqlEscape(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// KQL that reads one objective's recorded readings back out of App Insights as a
// time series. Matches the envelope shape emitted by epic-telemetry.js.
function epicObjectiveKql(epicKey, objectiveTitle) {
  const k = _kqlEscape(epicKey), o = _kqlEscape(objectiveTitle);
  return [
    'customEvents',
    '| where name == "EpicObjectiveReading"',
    `| where tostring(customDimensions.epicKey) == "${k}"`,
    `| where tostring(customDimensions.objective) == "${o}"`,
    '| where isnotnull(customMeasurements.value)',
    '| project timestamp, value = todouble(customMeasurements.value)',
    '| order by timestamp asc',
  ].join('\n');
}

// Build a Grafana Azure Monitor Logs target from a KQL query + resource binding.
function _azureMonitorTarget(kql, azureMonitor, refId = 'A') {
  const am = azureMonitor || {};
  return {
    refId,
    datasource: { type: 'grafana-azure-monitor-datasource', uid: am.datasourceUid || '${DS_AZURE_MONITOR}' },
    queryType: 'Azure Log Analytics',
    azureLogAnalytics: {
      resources: am.resourceId ? [am.resourceId] : [],
      query: kql,
      resultFormat: 'time_series',
      dashboardTime: true,
    },
  };
}

// Turn a persisted epic Objective-Health snapshot into a Grafana dashboard model.
// One panel per objective; objectives with numeric readings render as a
// timeseries, the rest as a table (honest "no series yet"). Each panel's target
// reads the shared App Insights sink via Azure Monitor Logs. Pure.
function buildEpicGrafanaModel(snapshot, opts = {}) {
  const s = snapshot || {};
  const objectives = Array.isArray(s.objectives) ? s.objectives : [];
  const am = { resourceId: opts.resourceId || '', datasourceUid: opts.datasourceUid || '' };
  const panels = objectives.map((o, i) => {
    const numeric = Array.isArray(o.history) && o.history.some(p => p && p.v != null && Number.isFinite(Number(p.v)));
    return {
      id: i + 1,
      title: o.title || ('Objective ' + (i + 1)),
      type: numeric ? 'timeseries' : 'table',
      gridPos: { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 },
      fieldConfig: { defaults: { unit: '' } },
      targets: [_azureMonitorTarget(epicObjectiveKql(s.key, o.title), am)],
    };
  });
  return {
    uid: null,
    title: (s.title || s.epicTitle || 'Epic') + ' — Objective Health',
    tags: ['theoffice.ai', 'epic', 'objective-health'],
    schemaVersion: 39,
    panels,
    time: { from: 'now-90d', to: 'now' },
  };
}

// Optional best-effort push to Azure Managed Grafana via its HTTP API using a
// service-account token. Resolves { ok, uid?, url?, status?, error? }; never
// throws. When url/token are absent it resolves { ok:false, reason:'not-configured' }.
function pushDashboard(model, opts = {}) {
  return new Promise((resolve) => {
    const base = String(opts.url || '').trim().replace(/\/$/, '');
    const token = String(opts.token || '').trim();
    if (!base || !token) { resolve({ ok: false, reason: 'not-configured' }); return; }
    let u;
    try { u = new URL('/api/dashboards/db', base); } catch (e) { resolve({ ok: false, error: 'bad-grafana-url' }); return; }
    const payload = Buffer.from(JSON.stringify({ dashboard: model, overwrite: true, message: 'Epic Objective Health published by TheOffice.AI' }), 'utf8');
    const req = https.request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
        Authorization: 'Bearer ' + token,
      },
      timeout: 15000,
    }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        let j = null; try { j = JSON.parse(body); } catch { /* non-JSON */ }
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        const uid = (j && j.uid) || '';
        const url = (ok && uid) ? (base + '/d/' + uid) : '';
        resolve({ ok, status: r.statusCode, uid, url, error: ok ? '' : (body.slice(0, 300) || ('HTTP ' + r.statusCode)) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  buildEpicGrafanaModel, epicObjectiveKql, pushDashboard,
  _internal: { _kqlEscape, _azureMonitorTarget },
};
