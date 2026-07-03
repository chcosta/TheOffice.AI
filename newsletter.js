'use strict';

// newsletter.js
// Local storage + domain logic for the "Newsletter" feature: a polished,
// emailable newsletter synthesized from the user's Connect impact diary.
//
// Newsletter is a companion to Connect and REQUIRES Connect to be enabled — it
// does NOT collect anything itself. It reads the shared Connect diary evidence
// (via ./connect) over a chosen timeframe and produces a nicely formatted
// newsletter that highlights accomplishments, impact, charts and screenshots.
//
// Like Connect, the backing data is PER-USER runtime state that can reference
// sensitive work details, so it lives under the profile data dir by default —
// NEVER in the repo — and can be redirected to a OneDrive-synced folder via the
// newsletterStorageDir setting.
//
// Files:
//   state.json          — { config, draft, meta }
//   draft-versions.json — { items:[ ... ] }   (prior newsletter revisions)
//
// Design guardrail (same as Connect): the AI is a DRAFTING ASSISTANT. Every
// generated newsletter is stored as an editable draft the user reviews before
// it is ever emailed.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');

let _settings = null;
function settings() {
  if (!_settings) _settings = require('./settings');
  return _settings;
}

let _connect = null;
function connect() {
  if (!_connect) _connect = require('./connect');
  return _connect;
}

// Resolve the storage directory, honoring the newsletterStorageDir setting and
// falling back to the per-user data dir. Always ensures the directory exists.
function storageDir() {
  let dir = '';
  try {
    const s = settings().getSettings();
    dir = (s.newsletterStorageDir || '').trim();
  } catch { /* settings not ready */ }
  if (!dir) dir = dataPath('newsletter');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

// Where generated/captured assets (charts, screenshots) are written. The
// newsletter agent saves images here and references them by relative name; the
// email builder inlines them as data URIs when present.
function assetsDir() {
  const dir = path.join(storageDir(), 'assets');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function _statePath() { return path.join(storageDir(), 'state.json'); }
function _versionsPath() { return path.join(storageDir(), 'draft-versions.json'); }

// How many prior newsletter revisions to retain (newest kept, oldest pruned).
const MAX_DRAFT_VERSIONS = 40;

function _readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    return fallback;
  }
}

function _writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error('[newsletter] failed to write', path.basename(file) + ':', e.message);
    return false;
  }
}

function _id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- State (config + draft) -------------------------------------------------

const DEFAULT_STATE = {
  // User-owned newsletter settings that steer generation and delivery.
  config: {
    // A recognizable masthead title, e.g. "Weekly Impact Digest".
    title: 'My Impact Digest',
    // A short subtitle/dek shown under the title.
    subtitle: '',
    // How far back to pull diary evidence when generating (in days).
    timeframeDays: 7,
    // Visual template preset the writer targets. See newsletter-standards skill.
    template: 'digest',
    // Optional cadence hint shown in the UI (purely descriptive here; the
    // scheduler wiring lives in settings/server if enabled later).
    cadence: 'weekly',
    // Optional accent color for the masthead/hero (hex). Empty = theme default.
    accent: '',
    // Default recipient for the "Email newsletter" action.
    emailTo: '',
  },
  // The newsletter draft. `markdown` is the single editable body (Markdown that
  // MAY contain inline HTML/SVG for charts and image references).
  draft: {
    markdown: '',
    // A generated/edited display title for THIS issue (falls back to config.title).
    title: '',
    // 'manual' (user typed) | 'ai' (generated). Steers the source badge.
    source: 'manual',
    generatedAt: '',
    updatedAt: '',
    // The timeframe window the last generation covered, for display.
    coveredFrom: '',
    coveredTo: '',
    // How many diary items informed the last generation.
    evidenceCount: 0,
  },
  meta: {
    createdAt: '',
    lastGeneratedAt: null,
    lastEmailedAt: null,
  },
};

function _clone(o) { return JSON.parse(JSON.stringify(o)); }

function _pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function getState() {
  const raw = _readJson(_statePath(), null);
  if (!raw) {
    const seeded = _clone(DEFAULT_STATE);
    seeded.meta.createdAt = new Date().toISOString();
    _writeJson(_statePath(), seeded);
    return seeded;
  }
  // Merge onto defaults so newly-added fields are always present.
  const st = _clone(DEFAULT_STATE);
  st.config = { ...st.config, ...(raw.config || {}) };
  st.draft = { ...st.draft, ...(raw.draft || {}) };
  st.meta = { ...st.meta, ...(raw.meta || {}) };
  return st;
}

// Persist user-owned config (title, timeframe, template, recipient, …).
function saveConfig(patch) {
  const st = getState();
  const p = patch && typeof patch === 'object' ? patch : {};
  st.config = {
    ...st.config,
    ..._pick(p, Object.keys(DEFAULT_STATE.config)),
  };
  // Coerce numeric timeframe.
  const d = parseInt(st.config.timeframeDays, 10);
  st.config.timeframeDays = Number.isFinite(d) && d > 0 ? Math.min(d, 400) : 7;
  _writeJson(_statePath(), st);
  return st;
}

// Persist the newsletter draft. Snapshots the outgoing draft to history when the
// body meaningfully changes, exactly like Connect.
function saveDraft(patch, { source } = {}) {
  const st = getState();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...st.draft };
  if (typeof p.markdown === 'string') next.markdown = p.markdown;
  if (typeof p.title === 'string') next.title = p.title;
  if (typeof p.coveredFrom === 'string') next.coveredFrom = p.coveredFrom;
  if (typeof p.coveredTo === 'string') next.coveredTo = p.coveredTo;
  if (Number.isFinite(p.evidenceCount)) next.evidenceCount = p.evidenceCount;

  const prevBody = (st.draft && st.draft.markdown || '').trim();
  const nextBody = (next.markdown || '').trim();
  if (prevBody && prevBody !== nextBody) {
    _pushDraftVersion(st.draft, { reason: source === 'ai' ? 'replaced-by-ai' : 'edited' });
  }
  if (source === 'ai') {
    next.source = 'ai';
    next.generatedAt = new Date().toISOString();
    st.meta.lastGeneratedAt = next.generatedAt;
  } else if (source === 'manual') {
    next.source = 'manual';
  }
  next.updatedAt = new Date().toISOString();
  st.draft = next;
  _writeJson(_statePath(), st);
  return st;
}

function markEmailed() {
  const st = getState();
  st.meta.lastEmailedAt = new Date().toISOString();
  _writeJson(_statePath(), st);
  return st;
}

// ---- Draft version history --------------------------------------------------

function _readVersions() {
  const obj = _readJson(_versionsPath(), { items: [] });
  return Array.isArray(obj.items) ? obj.items : [];
}

function _writeVersions(items) {
  return _writeJson(_versionsPath(), { items });
}

function _pushDraftVersion(draft, { reason } = {}) {
  const body = (draft && draft.markdown || '');
  if (!body.trim()) return null;
  const items = _readVersions();
  if (items.length && (items[0].markdown || '').trim() === body.trim()) return items[0];
  const entry = {
    id: _id('nv'),
    markdown: body,
    title: (draft && draft.title) || '',
    source: draft && draft.source === 'ai' ? 'ai' : 'manual',
    reason: reason || 'edited',
    createdAt: (draft && (draft.updatedAt || draft.generatedAt)) || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  items.unshift(entry);
  if (items.length > MAX_DRAFT_VERSIONS) items.length = MAX_DRAFT_VERSIONS;
  _writeVersions(items);
  return entry;
}

function listDraftVersions() {
  return _readVersions();
}

function getDraftVersion(id) {
  return _readVersions().find(v => v.id === id) || null;
}

function deleteDraftVersion(id) {
  const items = _readVersions();
  const next = items.filter(v => v.id !== id);
  if (next.length === items.length) return false;
  _writeVersions(next);
  return true;
}

// ---- Evidence window (delegates to Connect) ---------------------------------

// Compute the YYYY-MM-DD lower bound for a timeframe in days (inclusive).
function sinceForDays(days) {
  const d = parseInt(days, 10);
  const n = Number.isFinite(d) && d > 0 ? d : 7;
  const dt = new Date();
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - (n - 1));
  return dt.toISOString().slice(0, 10);
}

// Pull the Connect diary evidence that falls inside the timeframe. Returns
// newest-first (Connect's listEvidence ordering) with visible items only.
function evidenceForTimeframe(days) {
  const since = sinceForDays(days);
  let items = [];
  try {
    items = connect().listEvidence({ since, includeHidden: false }) || [];
  } catch (e) {
    console.error('[newsletter] failed to read Connect evidence:', e.message);
    items = [];
  }
  return { since, until: new Date().toISOString().slice(0, 10), items };
}

// ---- Export -----------------------------------------------------------------

function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    state: getState(),
    versions: _readVersions(),
  };
}

module.exports = {
  storageDir,
  assetsDir,
  getState,
  saveConfig,
  saveDraft,
  markEmailed,
  listDraftVersions,
  getDraftVersion,
  deleteDraftVersion,
  sinceForDays,
  evidenceForTimeframe,
  exportAll,
  DEFAULT_STATE,
};
