'use strict';

// compose-publish.js — "Make it real": publish a Compose.AI prototype (a
// self-contained `site` draft) to REAL Azure with restricted (Microsoft Entra)
// access and per-user persistent storage.
//
// Design doctrine (matches the rest of this codebase's cost/side-effecting ops):
//   * DEFAULT OFF / opt-in. Nothing here runs unless the user enables
//     `settings.composePublish.enabled` and explicitly triggers a publish.
//   * REAL provisioning via the Azure CLI (`az`) — the same machine identity the
//     Grafana + Graph integrations already use. No credentials are stored here.
//   * plan() is a pure DRY-RUN: it computes every resource name + the exact `az`
//     command list WITHOUT touching Azure, so the wizard can review it safely and
//     the whole shape is unit-testable.
//   * publish()/unpublish() perform the real steps with progress callbacks and
//     durable records; they NEVER throw to the caller — failures resolve to
//     { ok:false, code, message } with honest, actionable guidance.
//
// Hosting target (az-native, serverless — no dedicated App Service VM quota):
//   Azure Container Apps (Consumption) running a small Node container that serves
//   the prototype HTML and a per-user /api/state/* API backed by Azure Table
//   Storage. The image is built in the cloud with `az acr build` (no local Docker)
//   and pushed to a per-prototype Azure Container Registry. Restricted access =
//   Entra Easy Auth with "require authentication"; only assigned users can sign in.
//
// Auth is keyless (Entra only) end-to-end: the storage account is created with
// --allow-shared-key-access false (shared keys are disabled by org policy); the
// container app gets a system-assigned managed identity granted AcrPull on the
// registry + "Storage Table Data Contributor" on the account; and the wrapper
// reads/writes the table with DefaultAzureCredential. No keys / connection
// strings are ever used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dataPath } = require('./data-paths');

let settings = null;
try { settings = require('./settings'); } catch { settings = null; }

const STORE_DIR = dataPath('compose-publish');
const RECORDS_FILE = path.join(STORE_DIR, 'published.json');

const SKUS = { F1: 'Free (F1) — 1 GB, no custom domain, good for demos', B1: 'Basic (B1) — always-on, ~$13/mo' };
const DEFAULT_LOCATION = 'eastus2';

function _now() { return new Date().toISOString(); }

function _cfg() {
  const s = (settings && typeof settings.getSettings === 'function') ? settings.getSettings() : {};
  const c = (s && s.composePublish) || {};
  return {
    enabled: !!c.enabled,
    location: (c.location || DEFAULT_LOCATION).trim(),
    resourceGroup: (c.resourceGroup || '').trim(),
    sku: (c.sku === 'B1' ? 'B1' : 'F1'),
    subscription: (c.subscription || '').trim(),
    // Some tenants require a Service Management Reference (a Service Tree /
    // service id) on every app registration created via `az ad app create`.
    // The user can supply one in Settings → Compose.AI or the publish wizard.
    serviceManagementReference: (c.serviceManagementReference || '').trim(),
  };
}

// ---- record store ----------------------------------------------------------

function _readRecords() {
  try {
    const raw = fs.readFileSync(RECORDS_FILE, 'utf8');
    const j = JSON.parse(raw);
    return (j && typeof j === 'object' && j.byComposition) ? j : { byComposition: {} };
  } catch { return { byComposition: {} }; }
}

function _writeRecords(store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = RECORDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, RECORDS_FILE);
    return true;
  } catch { return false; }
}

function getRecord(compId) {
  if (!compId) return null;
  return _readRecords().byComposition[compId] || null;
}

function listRecords() {
  const store = _readRecords();
  return Object.values(store.byComposition).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function _saveRecord(rec) {
  const store = _readRecords();
  rec.updatedAt = _now();
  store.byComposition[rec.compositionId] = rec;
  _writeRecords(store);
  return rec;
}

function _deleteRecord(compId) {
  const store = _readRecords();
  if (store.byComposition[compId]) { delete store.byComposition[compId]; _writeRecords(store); }
}

// ---- pure helpers (unit-tested) --------------------------------------------

// A DNS-label-safe site name derived from the composition title. Azure web-app
// names are globally unique, 2–60 chars, lowercase alphanumeric + hyphens, and
// cannot start/end with a hyphen. We slugify the title and append a short hash
// of the composition id for uniqueness.
function sanitizeSiteName(title, compId) {
  let base = String(title || 'prototype').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!base) base = 'prototype';
  const hash = crypto.createHash('sha1').update(String(compId || title || '')).digest('hex').slice(0, 6);
  let name = `${base}-${hash}`;
  if (name.length > 60) name = `${base.slice(0, 60 - 7)}-${hash}`;
  name = name.replace(/^-+|-+$/g, '');
  if (name.length < 2) name = `app-${hash}`;
  return name;
}

// Storage account names are 3–24 chars, lowercase alphanumeric ONLY (no hyphens).
function sanitizeStorageName(siteName, compId) {
  const hash = crypto.createHash('sha1').update(String(compId || siteName || '')).digest('hex').slice(0, 8);
  let base = String(siteName || 'proto').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base) base = 'proto';
  let name = (base + hash).slice(0, 24);
  if (name.length < 3) name = ('st' + hash).slice(0, 24);
  return name;
}

// Container Apps app names: 2–32 chars, lowercase alphanumeric + hyphens, must
// start with a letter and end alphanumeric, no consecutive hyphens.
function sanitizeAppName(title, compId) {
  let name = sanitizeSiteName(title, compId); // slug + short hash, hyphen-safe
  if (!/^[a-z]/.test(name)) name = 'app-' + name;
  if (name.length > 32) {
    const hash = name.slice(-7); // "-xxxxxx"
    name = (name.slice(0, 32 - 7).replace(/-+$/, '') + hash);
  }
  name = name.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (name.length < 2) name = ('app-' + crypto.createHash('sha1').update(String(compId || title || '')).digest('hex').slice(0, 6));
  return name.slice(0, 32).replace(/-+$/, '');
}

// Container registry names are 5–50 chars, lowercase alphanumeric ONLY (no
// hyphens), and GLOBALLY unique. Prefixed with a letter so they always start
// alphanumeric and clear the 5-char minimum.
function sanitizeAcrName(siteName, compId) {
  const hash = crypto.createHash('sha1').update(String(compId || siteName || '')).digest('hex').slice(0, 8);
  let base = String(siteName || 'proto').toLowerCase().replace(/[^a-z0-9]/g, '');
  let name = ('acr' + base + hash).slice(0, 50);
  if (name.length < 5) name = ('acr' + hash).slice(0, 50);
  return name;
}

// Scan a prototype's HTML for the localStorage keys it reads/writes so each one
// can become per-user server state. Matches getItem/setItem/removeItem('key').
function detectStorageKeys(html) {
  const keys = new Set();
  const src = String(html || '');
  const re = /localStorage\s*\.\s*(?:get|set|remove)Item\s*\(\s*(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = re.exec(src))) { if (m[2]) keys.add(m[2]); }
  // Bracket access: localStorage['key'] / localStorage["key"]
  const re2 = /localStorage\s*\[\s*(['"`])([^'"`]+)\1\s*\]/g;
  while ((m = re2.exec(src))) { if (m[2]) keys.add(m[2]); }
  return Array.from(keys).sort();
}

// Normalize the list of people granted access. Each entry → { email, role }.
function normalizeAccess(people) {
  const out = [];
  const seen = new Set();
  for (const p of (Array.isArray(people) ? people : [])) {
    const email = String((p && (p.email || p.upn || p)) || '').trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    let role = String((p && p.role) || 'viewer').toLowerCase();
    if (!['owner', 'editor', 'viewer'].includes(role)) role = 'viewer';
    out.push({ email, role });
  }
  return out;
}

// Inject a tiny shim that swaps window.localStorage for a same-API object backed
// by the deployed /api/state/* endpoint (per signed-in user). Writes are
// debounced+queued; the first paint hydrates from a bootstrap the wrapper inlines.
function injectRemoteStorageShim(html, keys) {
  const src = String(html || '');
  const shim = `\n<script>(function(){\n  var KEYS=${JSON.stringify(Array.isArray(keys) ? keys : [])};\n  if(!KEYS.length) return;\n  var cache={}, boot=(window.__PROTO_STATE__||{});\n  KEYS.forEach(function(k){ cache[k]=(k in boot)?boot[k]:null; });\n  function push(k){ try{ fetch('/api/state/'+encodeURIComponent(k),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:cache[k]})}); }catch(e){} }\n  var real=window.localStorage;\n  var shim={\n    getItem:function(k){ return (k in cache)?cache[k]:(real?real.getItem(k):null); },\n    setItem:function(k,v){ v=String(v); if(k in cache){ cache[k]=v; push(k); } else if(real){ real.setItem(k,v);} },\n    removeItem:function(k){ if(k in cache){ cache[k]=null; push(k);} else if(real){ real.removeItem(k);} },\n    clear:function(){ KEYS.forEach(function(k){ cache[k]=null; push(k); }); },\n    key:function(i){ return KEYS[i]||null; },\n    get length(){ return KEYS.length; }\n  };\n  try{ Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return shim;}}); }catch(e){ window.localStorage=shim; }\n})();</script>\n`;
  if (/<\/head>/i.test(src)) return src.replace(/<\/head>/i, shim + '</head>');
  if (/<body[^>]*>/i.test(src)) return src.replace(/<body([^>]*)>/i, '<body$1>' + shim);
  return shim + src;
}

// ---- az / graph plumbing ---------------------------------------------------

function _az(args, { json = true, timeout = 180000, env = null } = {}) {
  return new Promise((resolve) => {
    const full = json ? args.concat(['-o', 'json']) : args.slice();
    const childEnv = env ? Object.assign({}, process.env, env) : process.env;
    execFile('az', full, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32', env: childEnv }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim();
        return resolve({ ok: false, code: (/not recognized|ENOENT|command not found/i.test(msg) ? 'NO_AZ' : 'AZ_ERROR'), message: msg || 'az command failed' });
      }
      if (!json) return resolve({ ok: true, out: String(stdout || '') });
      try { return resolve({ ok: true, data: stdout && stdout.trim() ? JSON.parse(stdout) : null }); }
      catch { return resolve({ ok: true, data: null, out: String(stdout || '') }); }
    });
  });
}

// Well-known Azure RBAC role definition GUIDs. We assign by GUID, never by
// display name: with `shell:true` on Windows (required to spawn az.cmd), execFile
// concatenates argv WITHOUT escaping, so a multi-word role like "Storage Table
// Data Contributor" would split into four tokens and the assignment would fail.
const ROLE_ACR_PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3';
// The default app-role id used when assigning a user to an app that requires
// assignment (the built-in "default access" role).
const DEFAULT_APP_ROLE_ID = '00000000-0000-0000-0000-000000000000';

// Report the connected identity/subscription without provisioning anything.
async function status() {
  const cfg = _cfg();
  const base = { enabled: cfg.enabled, location: cfg.location, sku: cfg.sku, subscription: cfg.subscription };
  const acct = await _az(['account', 'show']);
  if (!acct.ok) {
    if (acct.code === 'NO_AZ') return { ...base, ready: false, code: 'NO_AZ', message: 'The Azure CLI (`az`) was not found. Install it and run `az login`.' };
    return { ...base, ready: false, code: 'NOT_LOGGED_IN', message: 'Not signed in to Azure. Run `az login`, then reload.' };
  }
  const a = acct.data || {};
  // Enumerate the signed-in identity's subscriptions so the wizard can pick one.
  let subscriptions = [];
  const list = await _az(['account', 'list', '--all']);
  if (list.ok && Array.isArray(list.data)) {
    subscriptions = list.data
      .filter(s => (s.state || 'Enabled') === 'Enabled')
      .map(s => ({ id: s.id, name: s.name, isDefault: !!s.isDefault, tenantId: s.tenantId || '' }))
      .sort((x, y) => (y.isDefault - x.isDefault) || String(x.name).localeCompare(String(y.name)));
  }
  if (!subscriptions.length && a.id) subscriptions = [{ id: a.id, name: a.name || a.id, isDefault: true, tenantId: a.tenantId || '' }];
  return {
    ...base,
    ready: true,
    account: { user: (a.user && a.user.name) || '', subscriptionId: a.id || '', subscriptionName: a.name || '', tenantId: a.tenantId || '' },
    subscriptions,
  };
}

// Create (or reuse) an Entra app registration + client secret + service principal
// so Container Apps Easy Auth has a real Microsoft identity provider. Container
// Apps has NO auto-registration — without a client id the provider is incomplete
// and "require authentication" bricks the site with a 401. Uses a space-free
// display name so the Windows shell:true `_az` invocation doesn't split it.
// Returns { appId, secret, spId } or { error }.
async function _ensureAppRegistration(r, st) {
  try {
    const displayName = `composeai-${r.siteName}`;
    const redirectUri = `${r.url}/.auth/login/aad/callback`;
    // Some tenants enforce a policy requiring a Service Management Reference
    // (a Service Tree / service id) on every new app registration. Pass it
    // through when supplied so `az ad app create` doesn't fail the policy.
    const smr = String((r && r.serviceManagementReference) || '').trim();
    const smrArgs = smr ? ['--service-management-reference', smr] : [];
    let appId = '';
    const found = await _az(['ad', 'app', 'list', '--display-name', displayName, '--query', '[0].appId', '-o', 'tsv'], { json: false });
    if (found.ok) appId = String(found.out || '').trim();
    if (appId) {
      await _az(['ad', 'app', 'update', '--id', appId, '--web-redirect-uris', redirectUri, '--enable-id-token-issuance', 'true'].concat(smrArgs), { json: false });
    } else {
      const created = await _az(['ad', 'app', 'create', '--display-name', displayName, '--sign-in-audience', 'AzureADMyOrg', '--web-redirect-uris', redirectUri, '--enable-id-token-issuance', 'true'].concat(smrArgs, ['--query', 'appId', '-o', 'tsv']), { json: false });
      if (!created.ok) {
        const raw = String(created.message || 'app registration failed');
        // Surface the tenant's Service Management Reference policy as an
        // actionable message instead of a raw Graph error.
        if (/ServiceManagementReference|service-management-reference/i.test(raw)) {
          return { error: 'Your tenant requires a Service Management Reference (a Service Tree / service id) on new app registrations. Enter one in the Hosting & storage step (or Settings → Compose.AI) and re-run.', needsServiceManagementReference: true };
        }
        return { error: raw.split('\n')[0] };
      }
      appId = String(created.out || '').trim();
    }
    if (!appId) return { error: 'Could not resolve the app registration id.' };
    const secretRes = await _az(['ad', 'app', 'credential', 'reset', '--id', appId, '--years', '1', '--query', 'password', '-o', 'tsv'], { json: false });
    const secret = secretRes.ok ? String(secretRes.out || '').trim() : '';
    if (!secret) {
      const raw = String(secretRes.message || 'could not create a client secret');
      // Many managed tenants (e.g. the Microsoft corp tenant) enforce an app
      // management policy that forbids PASSWORD credentials (client secrets) on
      // app registrations — "Credential type not allowed as per assigned policy".
      // Container Apps EasyAuth needs a client secret for the confidential-client
      // code flow, so sign-in genuinely can't be wired in such a tenant. Surface
      // that clearly instead of the misleading "get Application Administrator rights".
      if (/credential type not allowed|as per assigned policy|app management policy/i.test(raw)) {
        return { error: 'Your tenant blocks client secrets on app registrations (app-management policy), which Entra sign-in requires.', credentialPolicyBlocked: true };
      }
      return { error: raw.split('\n')[0] };
    }
    let spId = '';
    const spShow = await _az(['ad', 'sp', 'show', '--id', appId, '--query', 'id', '-o', 'tsv'], { json: false });
    if (spShow.ok) spId = String(spShow.out || '').trim();
    if (!spId) {
      const spCreate = await _az(['ad', 'sp', 'create', '--id', appId, '--query', 'id', '-o', 'tsv'], { json: false });
      if (spCreate.ok) spId = String(spCreate.out || '').trim();
    }
    return { appId, secret, spId };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

// Fully remove a container app's EasyAuth config so the site is reachable
// without sign-in. Deleting the `authConfigs/current` sub-resource is the ONLY
// reliable unbrick when a prior run left an enabled-but-incomplete Microsoft
// provider: an enabled auth platform with a broken provider fails closed (401)
// on every request regardless of `--unauthenticated-client-action AllowAnonymous`.
// The delete is idempotent (no auth config → 204). Falls back to AllowAnonymous
// if the delete can't run (e.g. no subscription id to build the ARM URL). Never throws.
async function _disableContainerAppAuth(r) {
  const subArgs = r.subscription ? ['--subscription', r.subscription] : [];
  try {
    if (r.subscription) {
      const url = `https://management.azure.com/subscriptions/${r.subscription}/resourceGroups/${r.resourceGroup}/providers/Microsoft.App/containerApps/${r.siteName}/authConfigs/current?api-version=2024-03-01`;
      const del = await _az(['rest', '--method', 'delete', '--url', url], { json: false });
      if (del.ok) return { ok: true, via: 'delete' };
    }
  } catch (_) { /* fall through */ }
  // Best-effort fallback: at least flip require-auth off.
  try {
    await _az(['containerapp', 'auth', 'update', '--name', r.siteName, '--resource-group', r.resourceGroup, '--unauthenticated-client-action', 'AllowAnonymous'].concat(subArgs), { json: false });
    return { ok: true, via: 'allow-anonymous' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Resolve a user's object id, then grant them the app's default app-role so they
// can sign in to an assignment-required app. Idempotent (an existing assignment
// counts as success). The Graph body is written to a temp file and passed as
// `@file` to dodge Windows command-line JSON quoting. Returns { ok, assignmentId }.
async function _grantUser(spId, email) {
  const addr = String(email || '').trim();
  if (!spId || !addr) return { ok: false };
  let bodyFile = '';
  try {
    const uidRes = await _az(['ad', 'user', 'show', '--id', addr, '--query', 'id', '-o', 'tsv'], { json: false });
    const userObjId = uidRes.ok ? String(uidRes.out || '').trim() : '';
    if (!userObjId) return { ok: false };
    const body = JSON.stringify({ principalId: userObjId, resourceId: spId, appRoleId: DEFAULT_APP_ROLE_ID });
    bodyFile = path.join(os.tmpdir(), `grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(bodyFile, body, 'utf8');
    const res = await _az(['rest', '--method', 'POST', '--uri', `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo`, '--headers', 'Content-Type=application/json', '--body', `@${bodyFile}`]);
    if (res.ok) return { ok: true, assignmentId: (res.data && res.data.id) || '' };
    if (/already exists|assigned already exists|conflicting/i.test(res.message || '')) return { ok: true, assignmentId: '' };
    return { ok: false };
  } catch { return { ok: false }; }
  finally { if (bodyFile) { try { fs.rmSync(bodyFile, { force: true }); } catch {} } }
}

// Revoke a previously-recorded app-role assignment (used when access is removed
// from the Live step). Returns { ok }.
async function _revokeAssignment(spId, assignmentId) {
  if (!spId || !assignmentId) return { ok: false };
  const res = await _az(['rest', '--method', 'DELETE', '--uri', `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo/${assignmentId}`], { json: false });
  return { ok: res.ok };
}

// ---- deploy bundle ----------------------------------------------------------

// The Node wrapper deployed to App Service. Serves the prototype at / and a
// per-user state API. It reads the signed-in user from the Easy Auth
// `X-MS-CLIENT-PRINCIPAL` header and stores each key in Azure Table Storage
// (PartitionKey = the user's object id, RowKey = the storage key). Table access
// is keyless — it uses the web app's managed identity via DefaultAzureCredential.
function _wrapperServerJs() {
  return `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');

const PORT = process.env.PORT || 8080;
const ACCOUNT = process.env.STATE_STORAGE_ACCOUNT || '';
const TABLE = process.env.STATE_TABLE || 'protostate';
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const KEYS = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-keys.json'), 'utf8') || '[]');

let table = null;
let cred = null;
function tbl() {
  if (!ACCOUNT) return null;
  if (!table) {
    try {
      if (!cred) cred = new DefaultAzureCredential();
      const endpoint = 'https://' + ACCOUNT + '.table.core.windows.net';
      table = new TableClient(endpoint, TABLE, cred);
      table.createTable().catch(() => {});
    } catch { table = null; }
  }
  return table;
}
function userId(req) {
  const h = req.headers['x-ms-client-principal'];
  if (!h) return 'anon';
  try {
    const p = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    const claims = p.claims || [];
    const oid = claims.find(c => (c.typ || '').endsWith('/objectidentifier') || c.typ === 'oid');
    if (oid && oid.val) return oid.val;
    return (p.userId || p.userDetails || 'anon').replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch { return 'anon'; }
}
async function loadState(uid) {
  const t = tbl(); const out = {};
  if (!t) return out;
  try { for await (const e of t.listEntities({ queryOptions: { filter: "PartitionKey eq '" + uid + "'" } })) { out[e.rowKey] = (e.value === undefined ? null : e.value); } } catch {}
  return out;
}
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const uid = userId(req);
  const u = req.url || '/';
  if (u.startsWith('/api/state')) {
    const t = tbl();
    if (u === '/api/state' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(await loadState(uid))); }
    const m = u.match(/^\\/api\\/state\\/([^/?]+)/);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (!key || !KEYS.includes(key)) { res.writeHead(404); return res.end('unknown key'); }
    if (req.method === 'PUT') {
      let val = null; try { val = JSON.parse(await readBody(req)).value; } catch {}
      if (t) { try { await t.upsertEntity({ partitionKey: uid, rowKey: key, value: val === null ? '' : String(val) }, 'Replace'); } catch {} }
      res.writeHead(204); return res.end();
    }
    if (req.method === 'GET') { const s = await loadState(uid); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ value: s[key] == null ? null : s[key] })); }
    res.writeHead(405); return res.end();
  }
  // Everything else → the prototype, with this user's state inlined for hydration.
  const boot = await loadState(uid);
  const html = HTML.replace('</head>', '<script>window.__PROTO_STATE__=' + JSON.stringify(boot) + ';</script></head>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
server.listen(PORT, () => console.log('prototype listening on ' + PORT));
`;
}

function _wrapperPackageJson(siteName) {
  return JSON.stringify({
    name: siteName || 'compose-prototype',
    version: '1.0.0',
    private: true,
    engines: { node: '>=18' },
    scripts: { start: 'node server.js' },
    dependencies: { '@azure/data-tables': '^13.3.1', '@azure/identity': '^4.5.0' },
  }, null, 2);
}

// The container image definition. Built in the cloud by `az acr build` (ACR
// Tasks) — no local Docker required. Listens on 8080 (the container app's
// ingress target port).
function _dockerfile() {
  return [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package.json ./',
    'RUN npm install --omit=dev',
    'COPY . ./',
    'ENV PORT=8080',
    'EXPOSE 8080',
    'CMD ["node","server.js"]',
    '',
  ].join('\n');
}

// Write the deployable bundle to `dir`. Returns { keys, files }.
function buildDeployBundle(dir, html, siteName) {
  const keys = detectStorageKeys(html);
  const wrapped = injectRemoteStorageShim(html, keys);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), wrapped, 'utf8');
  fs.writeFileSync(path.join(dir, 'server.js'), _wrapperServerJs(), 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), _wrapperPackageJson(siteName), 'utf8');
  fs.writeFileSync(path.join(dir, 'state-keys.json'), JSON.stringify(keys), 'utf8');
  fs.writeFileSync(path.join(dir, 'Dockerfile'), _dockerfile(), 'utf8');
  fs.writeFileSync(path.join(dir, '.dockerignore'), 'deploy.zip\nnode_modules\n', 'utf8');
  return { keys, files: ['index.html', 'server.js', 'package.json', 'state-keys.json', 'Dockerfile', '.dockerignore'] };
}

// ---- plan (pure dry-run) ----------------------------------------------------

// Compute the full provisioning plan for a composition WITHOUT touching Azure.
// `opts`: { access:'restricted'|'tenant', people:[{email,role}], location, sku,
//           resourceGroup }.
function plan(composition, opts = {}) {
  const cfg = _cfg();
  const comp = composition || {};
  const draft = comp.draft || {};
  const html = draft.content || '';
  const isSite = (draft.contentFormat === 'html') || (comp.format === 'site') || /<!doctype|<html/i.test(html);
  const siteName = sanitizeAppName(comp.title, comp.id);
  const storageName = sanitizeStorageName(siteName, comp.id);
  const acrName = sanitizeAcrName(siteName, comp.id);
  const envName = `cae-${crypto.createHash('sha1').update(String(comp.id || comp.title || '')).digest('hex').slice(0, 8)}`;
  const location = (opts.location || cfg.location || DEFAULT_LOCATION).trim();
  const rg = (opts.resourceGroup || cfg.resourceGroup || `rg-proto-${siteName}`).trim();
  const subscription = (opts.subscription || cfg.subscription || '').trim();
  const serviceManagementReference = (opts.serviceManagementReference || cfg.serviceManagementReference || '').trim();
  const access = (opts.access === 'tenant') ? 'tenant' : 'restricted';
  const people = normalizeAccess(opts.people);
  const keys = detectStorageKeys(html);
  const image = `${acrName}.azurecr.io/proto:latest`;
  // Container Apps assigns a per-environment FQDN with a random segment, so the
  // real URL is resolved after the environment is created (during publish).
  const url = '';

  const steps = [
    { id: 'snapshot', title: 'Snapshot the prototype release', detail: `Freeze the current draft (${html.length.toLocaleString()} chars), wrap it with the per-user state shim, and add a Dockerfile.` },
    { id: 'group', title: 'Create the resource group', detail: `az group create --name ${rg} --location ${location}` },
    { id: 'storage', title: 'Provision Table Storage for per-user state', detail: `az storage account create --name ${storageName} --allow-shared-key-access false … + a "protostate" table (${keys.length} key${keys.length === 1 ? '' : 's'}), keyless Entra access` },
    { id: 'registry', title: 'Create the container registry', detail: `az acr create --name ${acrName} --sku Basic --admin-enabled false` },
    { id: 'image', title: 'Build the container image', detail: `az acr build --registry ${acrName} --image proto:… (cloud build via ACR Tasks — no local Docker)` },
    { id: 'env', title: 'Create the Container Apps environment', detail: `az containerapp env create --name ${envName} (Consumption; auto-creates Log Analytics)` },
    { id: 'app', title: 'Create the container app', detail: `az containerapp create --name ${siteName} --ingress external --target-port 8080 + managed identity (AcrPull + "Storage Table Data Contributor")` },
    { id: 'auth', title: 'Wire Microsoft Entra sign-in', detail: access === 'restricted' ? 'Create an Entra app registration + client secret, then Easy Auth with "require authentication" — only assigned users can sign in.' : 'Create an Entra app registration + client secret, then Easy Auth — anyone in your tenant can sign in.' },
  ];
  if (access === 'restricted') steps.push({ id: 'assign', title: 'Grant access', detail: `Assign the publisher${people.length ? ` + ${people.length} listed user${people.length === 1 ? '' : 's'}` : ''} to the app. Add or remove people anytime from the Live step.` });

  return {
    ok: true,
    canPublish: isSite && !!html.trim(),
    reason: !html.trim() ? 'This composition has no draft to publish.' : (!isSite ? 'Publishing is only available for prototype (interactive site) drafts.' : ''),
    composition: { id: comp.id, title: comp.title || 'Prototype', purpose: comp.purpose || '', format: comp.format || '' },
    hosting: 'containerapps',
    resources: { resourceGroup: rg, siteName, storageName, acrName, envName, image, location, sku: 'Consumption', skuLabel: 'Consumption — scales to zero when idle', url, table: 'protostate', subscription, serviceManagementReference },
    access, people, storageKeys: keys,
    steps,
    cost: 'Azure Container Apps (Consumption — scales to zero, pay only while serving) + a Basic container registry (~$5/mo) + pay-per-use Table Storage (typically pennies/month).',
  };
}

// ---- publish / unpublish (real) --------------------------------------------

// Translate a raw `az` error into an honest, actionable one-liner. Falls back to
// a trimmed version of the original when no known pattern matches.
function _friendlyAzError(message, step, r) {
  const raw = String(message || '').trim();
  const loc = (r && r.location) || 'this region';
  // Compute quota exhausted (App Service style; rare for Container Apps but possible).
  if (/quota/i.test(raw) && /(Total VMs|SubscriptionIsOverQuota|additional quota|current limit|cores)/i.test(raw)) {
    return `This subscription has no spare compute quota in ${loc}, so the container app can't be created here. Pick a different region or subscription in the Hosting step, or request a quota increase at https://aka.ms/antquotahelp and retry.`;
  }
  // Resource provider not registered (Container Apps / Log Analytics / ACR).
  if (/MissingSubscriptionRegistration|not registered (with|for) the resource provider|register.*(Microsoft\.App|Microsoft\.OperationalInsights|Microsoft\.ContainerRegistry)/i.test(raw)) {
    return `A required Azure resource provider isn't registered on this subscription yet (Microsoft.App / Microsoft.OperationalInsights / Microsoft.ContainerRegistry). Registration can take a few minutes — retry shortly, or register them in the Azure portal and retry.`;
  }
  // Registry name already taken globally.
  if (/registry.*(already (in use|exists)|not available)|ALREADY_EXISTS|RegistryNameAlreadyExists/i.test(raw)) {
    return `The container registry name is already taken globally. Retry — publishing will pick a fresh unique name automatically.`;
  }
  // containerapp CLI extension missing / dynamic-install prompt.
  if (/is not in the .*extension|az extension add|containerapp.*extension|command group '?containerapp'? is (not|in preview)/i.test(raw)) {
    return `The Azure CLI "containerapp" extension isn't installed. Run \`az extension add --name containerapp\` and retry (publishing also attempts this automatically).`;
  }
  // Region/SKU not available.
  if (/not available in (the )?location|LocationNotAvailable|SkuNotAvailable/i.test(raw)) {
    return `The chosen configuration isn't available in ${loc}. Pick a different region in the Hosting step and retry.`;
  }
  // Missing az CLI.
  if (/not recognized|command not found|ENOENT/i.test(raw)) {
    return 'The Azure CLI (az) was not found on this machine. Install it and sign in with `az login`, then retry.';
  }
  // Auth expired / not signed in.
  if (/az login|AADSTS|not logged in|refresh token|please run 'az login'/i.test(raw)) {
    return 'Your Azure sign-in has expired. Run `az login` and retry.';
  }
  // Otherwise keep the original but trimmed to a sane length.
  return raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
}

// Resolve a globally-unique resource name (storage accounts, container registries).
// Prefer a name we already own in this resource group (idempotent re-publish);
// otherwise use the planned name if globally available; otherwise derive a fresh
// unique name. `owned`/`available` are async predicates. Returns { name, existing }.
async function _resolveUniqueName(planned, prior, owned, available, fallbackPrefix) {
  if (prior && prior !== planned && await owned(prior)) return { name: prior, existing: true };
  if (await owned(planned)) return { name: planned, existing: true };
  if (await available(planned)) return { name: planned, existing: false };
  const base = String(planned || fallbackPrefix || 'x').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || (fallbackPrefix || 'x');
  for (let i = 0; i < 6; i++) {
    const suffix = crypto.randomBytes(3).toString('hex'); // 6 lowercase hex chars
    const cand = (base + suffix).slice(0, 24);
    if (await available(cand)) return { name: cand, existing: false };
  }
  return { name: planned, existing: false }; // give up — the create will surface the real error
}

async function _resolveStorageName(planned, prior, resourceGroup, subArgs) {
  const owned = async (name) => {
    if (!name) return false;
    const r = await _az(['storage', 'account', 'show', '--name', name, '--resource-group', resourceGroup].concat(subArgs));
    return !!(r.ok && r.data);
  };
  const available = async (name) => {
    const c = await _az(['storage', 'account', 'check-name', '--name', name].concat(subArgs));
    return !!(c.ok && c.data && c.data.nameAvailable);
  };
  return _resolveUniqueName(planned, prior, owned, available, 'st');
}

async function _resolveAcrName(planned, prior, resourceGroup, subArgs) {
  const owned = async (name) => {
    if (!name) return false;
    const r = await _az(['acr', 'show', '--name', name, '--resource-group', resourceGroup].concat(subArgs));
    return !!(r.ok && r.data);
  };
  const available = async (name) => {
    const c = await _az(['acr', 'check-name', '--name', name].concat(subArgs));
    return !!(c.ok && c.data && c.data.nameAvailable);
  };
  return _resolveUniqueName(planned, prior, owned, available, 'acr');
}

// Ensure the CLI `containerapp` extension is installed (best-effort; never throws).
async function _ensureContainerappExt() {
  await _az(['extension', 'add', '--name', 'containerapp', '--upgrade', '--only-show-errors'], { json: false });
}

// Register the resource providers Container Apps needs and briefly wait for the
// critical one (Microsoft.App) to finish. Best-effort — never throws.
async function _ensureProviders(subArgs) {
  const need = ['Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.ContainerRegistry'];
  for (const ns of need) {
    const s = await _az(['provider', 'show', '--namespace', ns, '--query', 'registrationState', '-o', 'tsv'].concat(subArgs), { json: false });
    if (s.ok && /Registered/i.test(String(s.out || ''))) continue;
    await _az(['provider', 'register', '--namespace', ns].concat(subArgs), { json: false });
  }
  for (let i = 0; i < 20; i++) {
    const s = await _az(['provider', 'show', '--namespace', 'Microsoft.App', '--query', 'registrationState', '-o', 'tsv'].concat(subArgs), { json: false });
    if (s.ok && /Registered/i.test(String(s.out || ''))) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

async function publish(composition, opts = {}, hooks = {}) {
  const extOnStep = typeof hooks.onStep === 'function' ? hooks.onStep : () => {};
  const cfg = _cfg();
  if (!cfg.enabled) return { ok: false, code: 'DISABLED', message: 'Prototype publishing is off. Enable it in Settings → Compose.AI first.' };

  const pl = plan(composition, opts);
  if (!pl.canPublish) return { ok: false, code: 'NOT_PUBLISHABLE', message: pl.reason || 'This composition cannot be published.' };

  const st = await status();
  if (!st.ready) return { ok: false, code: st.code, message: st.message };

  // Always grant the publisher access to their own site — whoever clicks
  // "Publish to Azure" should never be locked out. Seed their signed-in identity
  // into the restricted allow-list if it isn't already there.
  if (pl.access === 'restricted') {
    const publisher = String((st.account && st.account.user) || '').trim();
    if (publisher && /@/.test(publisher) && !pl.people.some(p => String(p.email).toLowerCase() === publisher.toLowerCase())) {
      pl.people = pl.people.concat([{ email: publisher, role: 'owner' }]);
    }
  }

  const r = pl.resources;
  const comp = composition;
  const html = (comp.draft && comp.draft.content) || '';
  const subArgs = r.subscription ? ['--subscription', r.subscription] : [];
  const rec = getRecord(comp.id) || { compositionId: comp.id, title: comp.title || 'Prototype', releases: [] };
  const priorStorageName = (rec.resources && rec.resources.storageName) || '';
  const priorAcrName = (rec.resources && rec.resources.acrName) || '';
  rec.status = 'publishing';
  rec.resources = r; rec.access = pl.access; rec.people = pl.people; rec.storageKeys = pl.storageKeys;
  rec.startedAt = _now();
  rec.updatedAt = _now();
  rec.runId = 'run-' + Date.now().toString(36);
  // Seed the step ledger so a reconnecting client (or a reopened wizard) can
  // rehydrate live progress straight from the persisted record.
  rec.steps = pl.steps.map(s => ({ id: s.id, title: s.title, state: 'wait', note: '' }));
  // Clear terminal state + stale warnings from any prior run so old messages
  // (e.g. a pre-fix role warning or a resolved auth error) never linger on a
  // fresh publish and mislead the user.
  delete rec.error;
  delete rec.roleWarning;
  delete rec.authWarning;
  delete rec.assignWarning;
  _saveRecord(rec);

  // Persist every step transition into the record BEFORE surfacing it over SSE.
  // The record is the durable source of truth: the SSE stream can drop (client
  // reload, 300s fetch abort, tab close) but the job keeps running server-side,
  // and status polling recovers the exact progress + terminal result.
  const onStep = (ev) => {
    try {
      if (ev && ev.id) {
        const row = (rec.steps || []).find(s => s.id === ev.id);
        if (row) { if (ev.state) row.state = ev.state; if (ev.message) row.note = ev.message; }
      }
      rec.updatedAt = _now();
      _saveRecord(rec);
    } catch (_) {}
    try { extOnStep(ev); } catch (_) {}
  };

  const fail = (code, message, step) => { const friendly = _friendlyAzError(message, step, r); rec.status = 'error'; rec.error = { code, message: friendly, step, raw: message }; _saveRecord(rec); onStep({ id: step, state: 'error', message: friendly }); return { ok: false, code, message: friendly, step, record: rec }; };
  const done = (id, message) => onStep({ id, state: 'done', message: message || '' });

  let tmp = '';
  try {
    // 1) snapshot
    onStep({ id: 'snapshot', state: 'running' });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-'));
    const bundle = buildDeployBundle(tmp, html, r.siteName);
    rec.releases.unshift({ id: 'rel-' + Date.now().toString(36), at: _now(), chars: html.length, keys: bundle.keys.length });
    done('snapshot', `Wrapped ${bundle.keys.length} state key(s).`);

    // 2) resource group
    onStep({ id: 'group', state: 'running' });
    let res = await _az(['group', 'create', '--name', r.resourceGroup, '--location', r.location].concat(subArgs));
    if (!res.ok) return fail(res.code, res.message, 'group');
    done('group');

    // 3) storage + table (keyless — shared keys disabled per org policy)
    onStep({ id: 'storage', state: 'running' });
    // Storage account names are globally unique. Reuse an account we already own,
    // or derive a fresh unique name if the planned one is taken elsewhere.
    const plannedStorageName = r.storageName;
    const resolved = await _resolveStorageName(r.storageName, priorStorageName, r.resourceGroup, subArgs);
    if (resolved.name !== r.storageName) { r.storageName = resolved.name; rec.resources = r; _saveRecord(rec); }
    if (resolved.existing) {
      // Ensure the existing account is keyless (in case it predates the policy).
      await _az(['storage', 'account', 'update', '--name', r.storageName, '--resource-group', r.resourceGroup, '--allow-shared-key-access', 'false'].concat(subArgs), { json: false });
    } else {
      res = await _az(['storage', 'account', 'create', '--name', r.storageName, '--resource-group', r.resourceGroup, '--location', r.location, '--sku', 'Standard_LRS', '--kind', 'StorageV2', '--allow-shared-key-access', 'false', '--allow-blob-public-access', 'false', '--min-tls-version', 'TLS1_2'].concat(subArgs));
      if (!res.ok) return fail(res.code, res.message, 'storage');
    }
    // Best-effort table create using the signed-in principal's Entra token. If the
    // caller lacks a data-plane role yet, this is a no-op — the wrapper creates the
    // table at runtime via its managed identity.
    await _az(['storage', 'table', 'create', '--name', r.table, '--account-name', r.storageName, '--auth-mode', 'login'], { json: false });
    done('storage', resolved.name !== plannedStorageName ? `Using storage account "${r.storageName}".` : '');

    // 4) container registry (globally-unique name; keyless — admin creds off per policy)
    onStep({ id: 'registry', state: 'running' });
    await _ensureContainerappExt();
    await _ensureProviders(subArgs);
    const plannedAcrName = r.acrName;
    const acrResolved = await _resolveAcrName(r.acrName, priorAcrName, r.resourceGroup, subArgs);
    if (acrResolved.name !== r.acrName) { r.acrName = acrResolved.name; r.image = `${r.acrName}.azurecr.io/proto:latest`; rec.resources = r; _saveRecord(rec); }
    if (!acrResolved.existing) {
      res = await _az(['acr', 'create', '--name', r.acrName, '--resource-group', r.resourceGroup, '--location', r.location, '--sku', 'Basic', '--admin-enabled', 'false'].concat(subArgs));
      if (!res.ok) return fail(res.code, res.message, 'registry');
    }
    done('registry', acrResolved.name !== plannedAcrName ? `Using registry "${r.acrName}".` : '');

    // 5) build the image in the cloud (ACR Tasks — no local Docker)
    onStep({ id: 'image', state: 'running' });
    const tag = 'v' + Date.now().toString(36);
    const taggedImage = `${r.acrName}.azurecr.io/proto:${tag}`;
    res = await _az(['acr', 'build', '--registry', r.acrName, '--image', `proto:${tag}`, '--image', 'proto:latest', tmp].concat(subArgs), { json: false, timeout: 600000 });
    if (!res.ok) return fail(res.code, res.message, 'image');
    r.image = taggedImage; rec.resources = r; _saveRecord(rec);
    done('image', `Built proto:${tag}.`);

    // 6) Container Apps environment (auto-creates Log Analytics)
    onStep({ id: 'env', state: 'running' });
    res = await _az(['containerapp', 'env', 'create', '--name', r.envName, '--resource-group', r.resourceGroup, '--location', r.location].concat(subArgs));
    if (!res.ok) return fail(res.code, res.message, 'env');
    // The environment owns the default domain; the app URL is deterministic once known.
    const domRes = await _az(['containerapp', 'env', 'show', '--name', r.envName, '--resource-group', r.resourceGroup, '--query', 'properties.defaultDomain', '-o', 'tsv'].concat(subArgs), { json: false });
    const defaultDomain = (domRes.ok && String(domRes.out || '').trim()) || '';
    if (defaultDomain) { r.url = `https://${r.siteName}.${defaultDomain}`; rec.resources = r; rec.url = r.url; _saveRecord(rec); }
    done('env');

    // 7) container app — create with a PUBLIC placeholder image first (the managed
    // identity can't pull the private image until AcrPull is granted), then grant
    // roles and swap to the real image.
    onStep({ id: 'app', state: 'running' });
    res = await _az(['containerapp', 'create', '--name', r.siteName, '--resource-group', r.resourceGroup,
      '--environment', r.envName, '--image', 'mcr.microsoft.com/k8se/quickstart:latest',
      '--system-assigned', '--ingress', 'external', '--target-port', '8080',
      '--min-replicas', '0', '--max-replicas', '3',
      '--env-vars', `STATE_STORAGE_ACCOUNT=${r.storageName}`, `STATE_TABLE=${r.table}`].concat(subArgs));
    if (!res.ok) return fail(res.code, res.message, 'app');
    const principalId = (res.data && res.data.identity && (res.data.identity.principalId || res.data.identity.PrincipalId)) || '';
    // Confirm the real URL from the app's ingress FQDN (authoritative).
    const fqdnRes = await _az(['containerapp', 'show', '--name', r.siteName, '--resource-group', r.resourceGroup, '--query', 'properties.configuration.ingress.fqdn', '-o', 'tsv'].concat(subArgs), { json: false });
    const fqdn = (fqdnRes.ok && String(fqdnRes.out || '').trim()) || '';
    if (fqdn) { r.url = `https://${fqdn}`; rec.resources = r; rec.url = r.url; _saveRecord(rec); }

    // Grant the app's managed identity AcrPull on the registry + table access.
    const acrIdRes = await _az(['acr', 'show', '--name', r.acrName, '--resource-group', r.resourceGroup, '--query', 'id', '-o', 'tsv'].concat(subArgs), { json: false });
    const acrId = (acrIdRes.ok && String(acrIdRes.out || '').trim()) || '';
    const acctRes = await _az(['storage', 'account', 'show', '--name', r.storageName, '--resource-group', r.resourceGroup, '--query', 'id', '-o', 'tsv'].concat(subArgs), { json: false });
    const storageId = (acctRes.ok && String(acctRes.out || '').trim()) || '';
    if (principalId && acrId) {
      const pullRes = await _az(['role', 'assignment', 'create', '--assignee-object-id', principalId, '--assignee-principal-type', 'ServicePrincipal', '--role', ROLE_ACR_PULL, '--scope', acrId].concat(subArgs), { json: false });
      if (!pullRes.ok) rec.roleWarning = pullRes.message;
    }
    if (principalId && storageId) {
      const roleRes = await _az(['role', 'assignment', 'create', '--assignee-object-id', principalId, '--assignee-principal-type', 'ServicePrincipal', '--role', ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR, '--scope', storageId].concat(subArgs), { json: false });
      if (!roleRes.ok) rec.roleWarning = (rec.roleWarning ? rec.roleWarning + ' ' : '') + roleRes.message;
    } else if (!principalId) {
      rec.roleWarning = 'Could not resolve the managed identity — grant AcrPull + "Storage Table Data Contributor" to the container app manually.';
    }
    // Point the app at the registry via its managed identity, then swap to the real image.
    await _az(['containerapp', 'registry', 'set', '--name', r.siteName, '--resource-group', r.resourceGroup, '--identity', 'system', '--server', `${r.acrName}.azurecr.io`].concat(subArgs), { json: false });
    res = await _az(['containerapp', 'update', '--name', r.siteName, '--resource-group', r.resourceGroup, '--image', r.image].concat(subArgs));
    if (!res.ok) return fail(res.code, res.message, 'app');
    _saveRecord(rec);
    done('app');

    // 8) auth (Entra Easy Auth) — create a real app registration + client secret
    // and wire it in. Container Apps has NO auto-registration; without a client
    // id the Microsoft provider is incomplete and "require authentication" bricks
    // the site with a 401. So only enforce sign-in once a registration is wired;
    // otherwise leave the app reachable and surface a clear warning.
    onStep({ id: 'auth', state: 'running' });
    const reg = await _ensureAppRegistration(r, st);
    if (reg.error || !reg.appId) {
      rec.appRegistration = null;
      // Tailor the guidance to the actual cause. A tenant secret-block policy is
      // NOT fixable by re-running or by gaining more rights — the credential type
      // itself is disallowed — so don't send the user chasing "Application
      // Administrator rights". Only the generic (unknown) failure suggests a re-run.
      let hint;
      if (reg.credentialPolicyBlocked) {
        hint = 'The site is published and reachable by anyone with the link. To add Entra sign-in you\'d need to publish from a subscription whose tenant permits client secrets, or add a certificate credential and configure authentication manually in the Azure portal.';
      } else if (reg.needsServiceManagementReference) {
        hint = 'Enter a Service Management Reference in the Hosting & storage step and re-run to wire sign-in. The site is reachable meanwhile.';
      } else {
        hint = 'Published WITHOUT sign-in (reachable by anyone with the link). Re-run once you have Application Administrator rights, or secure it in the Azure portal.';
      }
      rec.authWarning = (reg.error ? reg.error + ' — ' : '') + hint;
      // Idempotency: a PRIOR publish run may have wired require-authentication
      // (RedirectToLoginPage) with a Microsoft provider. Publish reuses the same
      // container app, so if we now can't wire a registration we must remove the
      // leftover auth config entirely — otherwise the enabled-but-incomplete
      // (provider-less / secret-less) EasyAuth platform 401-bricks EVERY request
      // and "reachable by anyone with the link" is a lie. Just flipping the
      // unauthenticated action to AllowAnonymous is NOT enough: an enabled
      // platform with a broken provider still fails closed. Deleting the
      // authConfig sub-resource genuinely unbricks it (verified live). The delete
      // is idempotent (no auth config → 204). Fall back to AllowAnonymous only if
      // the delete fails for some reason.
      await _disableContainerAppAuth(r);
      _saveRecord(rec);
      done('auth', 'Published without sign-in — the app registration could not be created (see the note on the Live step).');
    } else {
      rec.appRegistration = { appId: reg.appId, spId: reg.spId };
      delete rec.authWarning;
      _saveRecord(rec);
      const authRes = await _az(['containerapp', 'auth', 'microsoft', 'update', '--name', r.siteName, '--resource-group', r.resourceGroup, '--client-id', reg.appId, '--client-secret', reg.secret, '--issuer', `https://sts.windows.net/${st.account.tenantId}/`, '--yes'].concat(subArgs), { json: false });
      if (!authRes.ok) rec.authWarning = authRes.message;
      // Require authentication so anonymous hits are redirected to sign-in.
      await _az(['containerapp', 'auth', 'update', '--name', r.siteName, '--resource-group', r.resourceGroup, '--unauthenticated-client-action', 'RedirectToLoginPage', '--redirect-provider', 'azureactivedirectory'].concat(subArgs), { json: false });
      _saveRecord(rec);
      done('auth', pl.access === 'restricted' ? 'Entra sign-in wired — restricting to assigned users.' : 'Entra sign-in wired for your tenant.');
    }

    // 9) grant access (restricted) — require an explicit assignment, then assign
    // the publisher + everyone on the allow-list. Without this the app requires
    // assignment but nobody is assigned → everyone (including the owner) gets 401.
    if (pl.access === 'restricted' && rec.appRegistration && rec.appRegistration.spId) {
      onStep({ id: 'assign', state: 'running' });
      await _az(['ad', 'sp', 'update', '--id', rec.appRegistration.appId, '--set', 'appRoleAssignmentRequired=true'], { json: false });
      const granted = []; const failed = []; rec.assignments = rec.assignments || {};
      for (const person of pl.people) {
        const g = await _grantUser(rec.appRegistration.spId, person.email);
        if (g.ok) { granted.push(person.email); if (g.assignmentId) rec.assignments[String(person.email).toLowerCase()] = g.assignmentId; }
        else failed.push(person.email);
      }
      rec.grantedAccess = granted;
      if (failed.length) rec.assignWarning = `Couldn't auto-assign: ${failed.join(', ')}. Add them under the app's "Users and groups" in the Azure portal.`;
      else delete rec.assignWarning;
      _saveRecord(rec);
      done('assign', granted.length ? `Granted access to ${granted.length} user${granted.length === 1 ? '' : 's'}${failed.length ? ` (${failed.length} pending)` : ''}.` : 'No users could be auto-assigned — grant access in the portal.');
    } else if (pl.access === 'restricted') {
      // Auth couldn't be wired, so there's nothing to assign against.
      onStep({ id: 'assign', state: 'done', message: 'Skipped — sign-in was not configured.' });
    }

    rec.status = 'live';
    rec.url = r.url;
    rec.liveAt = _now();
    delete rec.error;
    _saveRecord(rec);
    return { ok: true, url: r.url, record: rec };
  } catch (e) {
    return fail('EXCEPTION', String(e && e.message || e), 'unknown');
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

// In-flight publish jobs, keyed by composition id. Guards against a second
// "Publish to Azure" click (or a duplicate request from a reconnecting client)
// spawning a parallel provision over the same resource group.
const _running = new Map();

function isPublishing(compId) { return _running.has(compId); }

// A publish job lives only in this process's in-memory `_running` map. If the
// server restarts (or crashes) mid-provision, the persisted record is stranded
// at status:"publishing" forever — the client then polls a job that no longer
// exists and shows "Publishing…" with no activity. Detect that orphan on read:
// a record marked "publishing" that ISN'T actually running here (and whose last
// heartbeat is stale) was interrupted. Flip it to a recoverable error so the UI
// unsticks and the user can re-run (publish is idempotent — it reuses whatever
// was already created). Never touch a job that is genuinely running in-process.
const STALE_PUBLISH_MS = 2 * 60 * 1000;
function reconcileStale(compId) {
  const rec = getRecord(compId);
  if (!rec || rec.status !== 'publishing' || isPublishing(compId)) return rec || null;
  const stamp = Date.parse(rec.updatedAt || rec.startedAt || '');
  const age = Number.isFinite(stamp) ? (Date.now() - stamp) : Infinity;
  // Small grace so a record just seeded by startPublish (before the async
  // publish() body first heartbeats) isn't mistaken for an orphan.
  if (age < 10000) return rec;
  rec.status = 'error';
  rec.error = {
    code: 'INTERRUPTED',
    step: 'unknown',
    message: 'The publish was interrupted before it finished — the server may have restarted. Re-run "Publish to Azure": it reuses whatever was already created and picks up where it left off.',
  };
  rec.updatedAt = _now();
  _saveRecord(rec);
  return rec;
}

// Kick off publish() as a background job and return immediately. The provision
// keeps running server-side regardless of what the caller's HTTP request does
// (a 300s fetch abort, a page reload, or a closed tab won't cancel it). Progress
// is streamed over hooks.onStep AND persisted to the durable record so a client
// can reconnect via GET .../publish/status and pick up exactly where it left off.
function startPublish(composition, opts = {}, hooks = {}) {
  const id = composition && composition.id;
  if (!id) return { ok: false, code: 'NO_ID', message: 'No composition id.' };
  if (_running.has(id)) {
    // Already provisioning — hand back the live record instead of starting again.
    return { ok: true, started: false, running: true, record: getRecord(id) || null };
  }
  const onDone = typeof hooks.onDone === 'function' ? hooks.onDone : () => {};
  // Seed a publishing record synchronously so an immediate status read reflects
  // the in-flight job (publish() re-seeds authoritatively once it starts).
  try {
    const pl = plan(composition, opts);
    if (pl && pl.canPublish) {
      const rec = getRecord(id) || { compositionId: id, title: composition.title || 'Prototype', releases: [] };
      rec.status = 'publishing';
      rec.startedAt = _now();
      rec.updatedAt = _now();
      rec.steps = (pl.steps || []).map(s => ({ id: s.id, title: s.title, state: 'wait', note: '' }));
      delete rec.error;
      _saveRecord(rec);
    }
  } catch (_) {}
  _running.set(id, true);
  Promise.resolve()
    .then(() => publish(composition, opts, { onStep: hooks.onStep }))
    .then((result) => { _running.delete(id); try { onDone(result || { ok: false }); } catch (_) {} })
    .catch((e) => {
      _running.delete(id);
      try {
        const rec = getRecord(id) || { compositionId: id };
        rec.status = 'error';
        rec.error = { code: 'EXCEPTION', message: String((e && e.message) || e), step: 'unknown' };
        rec.updatedAt = _now();
        _saveRecord(rec);
      } catch (_) {}
      try { onDone({ ok: false, message: String((e && e.message) || e) }); } catch (_) {}
    });
  return { ok: true, started: true, running: true, record: getRecord(id) || null };
}

// Tear down a published prototype by deleting its resource group.
async function unpublish(compId, hooks = {}) {
  const onStep = typeof hooks.onStep === 'function' ? hooks.onStep : () => {};
  const rec = getRecord(compId);
  if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'No published prototype for this composition.' };
  const cfg = _cfg();
  const sub = (rec.resources && rec.resources.subscription) || cfg.subscription;
  const subArgs = sub ? ['--subscription', sub] : [];
  onStep({ id: 'teardown', state: 'running' });
  const rg = rec.resources && rec.resources.resourceGroup;
  if (!rg) { _deleteRecord(compId); return { ok: true, note: 'No resource group recorded; cleared the local record.' }; }
  const res = await _az(['group', 'delete', '--name', rg, '--yes', '--no-wait'].concat(subArgs), { json: false });
  if (!res.ok) { rec.status = 'error'; rec.error = { code: res.code, message: res.message, step: 'teardown' }; _saveRecord(rec); onStep({ id: 'teardown', state: 'error', message: res.message }); return { ok: false, code: res.code, message: res.message }; }
  onStep({ id: 'teardown', state: 'done' });
  _deleteRecord(compId);
  return { ok: true, note: `Deleting resource group ${rg} (runs in the background).` };
}

// Update the access allow-list on a live prototype: grant newly-added people and
// revoke removed ones against the app's service principal, then persist the list.
// Degrades gracefully when the site was published without a registration (record
// only). Never throws.
async function setAccess(compId, people) {
  const rec = getRecord(compId);
  if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'No published prototype for this composition.' };
  const next = normalizeAccess(people);
  const reg = rec.appRegistration;
  if (!reg || !reg.spId) {
    // No app registration (published without sign-in) — just record the intent.
    rec.people = next; _saveRecord(rec);
    return { ok: true, people: rec.people, note: 'This site was published without Entra sign-in, so access is not enforced. Re-publish to wire sign-in.' };
  }
  rec.assignments = rec.assignments || {};
  const prev = normalizeAccess(rec.people);
  const nextEmails = new Set(next.map(p => String(p.email).toLowerCase()));
  const prevEmails = new Set(prev.map(p => String(p.email).toLowerCase()));
  const granted = []; const revoked = []; const failed = [];
  for (const p of next) {
    const key = String(p.email).toLowerCase();
    if (prevEmails.has(key) && rec.assignments[key]) continue; // already assigned
    const g = await _grantUser(reg.spId, p.email);
    if (g.ok) { granted.push(p.email); if (g.assignmentId) rec.assignments[key] = g.assignmentId; }
    else failed.push(p.email);
  }
  for (const p of prev) {
    const key = String(p.email).toLowerCase();
    if (nextEmails.has(key)) continue;
    const aid = rec.assignments[key];
    if (aid) { const rv = await _revokeAssignment(reg.spId, aid); if (rv.ok) { revoked.push(p.email); delete rec.assignments[key]; } }
    else delete rec.assignments[key];
  }
  rec.people = next;
  _saveRecord(rec);
  return { ok: true, people: rec.people, granted, revoked, failed, message: failed.length ? `Couldn't assign: ${failed.join(', ')}. Add them in the Azure portal.` : '' };
}

// ---- minimal zip (no external dep) -----------------------------------------
// Deploys are small (a few files); use the system zipper for a portable archive.
function _zipDir(dir, zipPath) {
  const cp = require('child_process');
  try {
    if (process.platform === 'win32') {
      cp.execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`], { windowsHide: true });
    } else {
      cp.execFileSync('sh', ['-c', `cd '${dir}' && zip -qr '${zipPath}' .`]);
    }
  } catch (e) { throw new Error('failed to build deploy zip: ' + (e && e.message || e)); }
}

module.exports = {
  status, plan, publish, startPublish, isPublishing, reconcileStale, unpublish, setAccess,
  getRecord, listRecords,
  _internal: {
    sanitizeSiteName, sanitizeStorageName, sanitizeAppName, sanitizeAcrName,
    detectStorageKeys, normalizeAccess,
    injectRemoteStorageShim, buildDeployBundle, _dockerfile, _cfg, SKUS, _friendlyAzError,
    _resolveStorageName, _resolveAcrName, _resolveUniqueName, _ensureProviders, _ensureContainerappExt,
    _ensureAppRegistration, _grantUser, _revokeAssignment, _disableContainerAppAuth,
    ROLE_ACR_PULL, ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR, DEFAULT_APP_ROLE_ID,
  },
};
