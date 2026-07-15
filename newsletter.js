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
    // Appearance / visual-format controls (Design panel). Empty string / defaults
    // mean "use the built-in light look". These drive both the preview paper and
    // the sent email so the two stay in visual sync.
    bg: '#ffffff',
    textColor: '#1f2430',
    headingColor: '#111827',
    linkColor: '#1d4ed8',
    fontFamily: '',
    fontScale: 1,
    width: 760,
  },
  // The newsletter draft. `markdown` is the single editable body (Markdown that
  // MAY contain inline HTML/SVG for charts and image references).
  draft: {
    markdown: '',
    // Stable identity of the newsletter DOCUMENT this draft belongs to. A newsletter
    // is a document (like a composition): iterating over the same timeframe produces
    // revisions of the SAME docId; generating over a materially different timeframe (or
    // an explicit "New newsletter") mints a fresh docId. Legacy state is migrated by
    // grouping the flat version log into documents by contiguous title runs.
    docId: '',
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
    // Scheduled auto-generation bookkeeping. `lastAutoGeneratedAt` drives the
    // startup catch-up (did we miss a scheduled run?); `reviewPending` lights the
    // in-app "new newsletter ready" banner until the user opens it.
    lastAutoGeneratedAt: null,
    reviewPending: false,
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

// ---- Document identity (revision vs new newsletter) -------------------------

// Mint a fresh newsletter-document id.
function _mintDocId() { return _id('nd'); }

// Normalize a title for run-grouping: strip markup, collapse space, lowercase.
function _normTitle(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Lazily assign docIds to legacy state that predates the document model. The flat
// version log (newest-first) plus the live draft (its head) form one timeline; we
// group it into documents by contiguous title runs — a change in the H1 title starts
// a new document. Runs idempotent: once everything carries a docId it is a no-op.
// Persists both state + versions when it migrates. Returns { st, items }.
function _ensureMigrated() {
  const st = getState();
  const items = _readVersions();
  const draftBody = (st.draft && st.draft.markdown || '').trim();
  const versionsNeed = items.some(v => (v.markdown || '').trim() && !v.docId);
  const draftNeed = !!draftBody && !(st.draft && st.draft.docId);
  if (!versionsNeed && !draftNeed) return { st, items };

  let curDoc = null, prevKey = null;
  if (draftBody) {
    curDoc = st.draft.docId || _mintDocId();
    st.draft.docId = curDoc;
    prevKey = _normTitle(extractTitle(st.draft.markdown) || st.draft.title || '');
  }
  for (const v of items) {
    if (!(v.markdown || '').trim()) continue;
    const k = _normTitle(v.title || extractTitle(v.markdown));
    if (v.docId) { curDoc = v.docId; prevKey = k; continue; }
    if (curDoc && k && prevKey === k) {
      v.docId = curDoc;              // same title as the entry above → same newsletter
    } else {
      curDoc = _mintDocId();         // title changed → a distinct newsletter
      v.docId = curDoc;
    }
    prevKey = k;
  }
  _writeJson(_statePath(), st);
  _writeVersions(items);
  return { st, items };
}

// Persist the newsletter draft. Snapshots the outgoing draft to history when the
// body meaningfully changes, exactly like Connect.
//
// `docMode` steers the DOCUMENT identity of the new head:
//   'new'  → mint a fresh docId (this generation starts a NEW newsletter)
//   (else) → keep the active docId (a revision of the current newsletter); a
//            first-ever draft with no docId gets one minted.
function saveDraft(patch, { source, docMode } = {}) {
  const { st } = _ensureMigrated();
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
  // Decide the new head's document identity.
  if (docMode === 'new') next.docId = _mintDocId();
  else if (!next.docId) next.docId = _mintDocId();

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

// Record a scheduled auto-generation. Sets the review-pending flag so the UI can
// surface a "new newsletter ready" banner until the user opens it.
function markAutoGenerated() {
  const st = getState();
  const now = new Date().toISOString();
  st.meta.lastAutoGeneratedAt = now;
  st.meta.reviewPending = true;
  _writeJson(_statePath(), st);
  return st;
}

// Clear the review-pending flag once the user has looked at the auto-draft.
function clearReviewPending() {
  const st = getState();
  st.meta.reviewPending = false;
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

// Pull the issue title from the body the reader actually sees — the first ATX
// `# Heading` or inline <h1>. The stored draft.title goes stale (a regeneration
// or edit rewrites the markdown but not that field), so the H1 is the reliable
// source of truth for the version-history label and email subject. Returns ''.
function extractTitle(md) {
  const src = String(md || '');
  if (!src.trim()) return '';
  const clean = (s) => String(s)
    .replace(/<[^>]+>/g, '')                 // strip any inline tags
    .replace(/[*_`]/g, '')                   // strip markdown emphasis marks
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const atx = lines[i].match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);   // H1 only (not ##)
    if (atx) { const t = clean(atx[1]); if (t) return t; }
  }
  const h1 = src.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) { const t = clean(h1[1]); if (t) return t; }
  return '';
}

function _pushDraftVersion(draft, { reason } = {}) {
  const body = (draft && draft.markdown || '');
  if (!body.trim()) return null;
  const items = _readVersions();
  if (items.length && (items[0].markdown || '').trim() === body.trim()) return items[0];
  const entry = {
    id: _id('nv'),
    // The document this revision belongs to (empty on pre-migration entries; filled
    // by _ensureMigrated). Lets the history list scope to a single newsletter.
    docId: (draft && draft.docId) || '',
    markdown: body,
    // Prefer the visible H1 over the (often stale) draft.title.
    title: extractTitle(body) || (draft && draft.title) || '',
    source: draft && draft.source === 'ai' ? 'ai' : 'manual',
    reason: reason || 'edited',
    coveredFrom: (draft && draft.coveredFrom) || '',
    coveredTo: (draft && draft.coveredTo) || '',
    evidenceCount: (draft && Number(draft.evidenceCount)) || 0,
    createdAt: (draft && (draft.updatedAt || draft.generatedAt)) || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  items.unshift(entry);
  if (items.length > MAX_DRAFT_VERSIONS) items.length = MAX_DRAFT_VERSIONS;
  _writeVersions(items);
  return entry;
}

// Return the prior revisions for ONE newsletter document (defaults to the active
// draft's docId), newest-first, with a display title derived from the body H1
// unless the user has manually renamed the entry (titleEdited). Scoping to a docId
// is what makes each newsletter show only its OWN history — legacy state is grouped
// into documents first by _ensureMigrated.
function listDraftVersions(docId) {
  const { st, items } = _ensureMigrated();
  const active = docId || (st.draft && st.draft.docId) || null;
  return items
    .filter(v => (v.markdown || '').trim())
    .filter(v => !active || v.docId === active)
    .map(v => {
      if (v && v.titleEdited) return v;
      const t = extractTitle(v && v.markdown || '');
      return t ? { ...v, title: t } : v;
    });
}

// ---- Newsletter documents (revision vs new) ---------------------------------

// Group the draft head + version log into distinct newsletter documents. One row
// per docId: the newest entry supplies title/size/window/updatedAt; the oldest
// supplies createdAt. `active` marks the document currently loaded in the studio.
function listDocuments() {
  const { st, items } = _ensureMigrated();
  const draft = st.draft || {};
  const draftBody = (draft.markdown || '').trim();
  const map = new Map();
  const add = (docId, e, isHead) => {
    if (!docId) return;
    if (!map.has(docId)) map.set(docId, []);
    map.get(docId).push({ ...e, __head: !!isHead });
  };
  if (draftBody) add(draft.docId, {
    markdown: draft.markdown,
    title: extractTitle(draft.markdown) || draft.title || '',
    coveredFrom: draft.coveredFrom || '', coveredTo: draft.coveredTo || '',
    source: draft.source, savedAt: draft.updatedAt || draft.generatedAt || '',
    createdAt: draft.generatedAt || draft.updatedAt || '',
  }, true);
  for (const v of items) {
    if (!(v.markdown || '').trim()) continue;
    add(v.docId, {
      markdown: v.markdown,
      title: (v.titleEdited && v.title) || extractTitle(v.markdown) || v.title || '',
      coveredFrom: v.coveredFrom || '', coveredTo: v.coveredTo || '',
      source: v.source, savedAt: v.savedAt || v.createdAt || '',
      createdAt: v.createdAt || v.savedAt || '',
    }, false);
  }
  const out = [];
  for (const [docId, entries] of map) {
    entries.sort((a, b) => {
      const h = (b.__head ? 1 : 0) - (a.__head ? 1 : 0);
      return h !== 0 ? h : String(b.savedAt).localeCompare(String(a.savedAt));
    });
    const newest = entries[0];
    const oldest = entries[entries.length - 1];
    out.push({
      docId,
      title: newest.title || 'Untitled newsletter',
      coveredFrom: newest.coveredFrom || '', coveredTo: newest.coveredTo || '',
      size: Buffer.byteLength(newest.markdown || '', 'utf8'),
      revisions: entries.length,
      createdAt: oldest.createdAt || oldest.savedAt || '',
      updatedAt: newest.savedAt || newest.createdAt || '',
      active: docId === draft.docId,
      source: newest.source === 'ai' ? 'ai' : 'manual',
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

// Make `docId` the active document: snapshot the current head into its own doc's
// history (so nothing is lost), then promote that document's newest revision to be
// the live draft. Returns { state, opened }.
function openDocument(docId) {
  const { st } = _ensureMigrated();
  if (!docId) return { state: st, opened: false };
  if ((st.draft && st.draft.docId) === docId) return { state: st, opened: true };
  const curBody = (st.draft && st.draft.markdown || '').trim();
  if (curBody) _pushDraftVersion(st.draft, { reason: 'switch-doc' });
  const list = _readVersions();
  const idx = list.findIndex(v => v.docId === docId && (v.markdown || '').trim());
  if (idx < 0) { _writeJson(_statePath(), st); return { state: st, opened: false }; }
  const top = list.splice(idx, 1)[0];
  _writeVersions(list);
  st.draft = {
    ..._clone(DEFAULT_STATE.draft),
    markdown: top.markdown || '',
    title: extractTitle(top.markdown || '') || top.title || '',
    source: top.source === 'ai' ? 'ai' : 'manual',
    generatedAt: top.createdAt || '',
    updatedAt: new Date().toISOString(),
    docId,
    coveredFrom: top.coveredFrom || '', coveredTo: top.coveredTo || '',
    evidenceCount: Number(top.evidenceCount) || 0,
  };
  _writeJson(_statePath(), st);
  return { state: st, opened: true };
}

// Start a brand-new newsletter: snapshot the current head into its own doc's
// history, then clear the draft to an empty head under a fresh docId.
function newDocument() {
  const { st } = _ensureMigrated();
  const curBody = (st.draft && st.draft.markdown || '').trim();
  if (curBody) _pushDraftVersion(st.draft, { reason: 'new-doc' });
  st.draft = { ..._clone(DEFAULT_STATE.draft), docId: _mintDocId(), updatedAt: new Date().toISOString() };
  _writeJson(_statePath(), st);
  return st;
}

// Does the prospective evidence window differ from what the active draft covers?
// A meaningful difference means the next generation is really a NEW newsletter,
// not a revision — so the UI can offer a calm "new vs revise" choice. When there
// is no current body, there is nothing to revise, so `changed` is false.
function windowChanged(win) {
  const { st } = _ensureMigrated();
  const d = st.draft || {};
  const cf = d.coveredFrom || '', ct = d.coveredTo || '';
  const nf = (win && win.since) || '', nt = (win && win.until) || '';
  const has = !!(d.markdown && String(d.markdown).trim());
  return {
    changed: has && (cf !== nf || ct !== nt),
    current: { from: cf, to: ct },
    prospective: { from: nf, to: nt },
  };
}

// Manually override a version's title. An empty title resets to auto-derivation
// (clears titleEdited) so the entry falls back to the body H1; a non-empty title
// marks titleEdited so the derived-title logic never clobbers the user's choice.
function renameDraftVersion(id, title) {
  const items = _readVersions();
  const idx = items.findIndex(v => v.id === id);
  if (idx < 0) return null;
  const clean = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) {
    const { titleEdited, ...rest } = items[idx];
    items[idx] = { ...rest, title: extractTitle(rest.markdown || '') || '' };
  } else {
    items[idx] = { ...items[idx], title: clean, titleEdited: true };
  }
  _writeVersions(items);
  return items[idx];
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

// Delete the CURRENT newsletter (draft) outright and promote the newest history
// version to become current — so "delete the current issue" behaves like a proper
// version manager. The deleted current is discarded (NOT snapshotted, or it would
// just reappear in history). If no earlier versions exist, the draft is cleared to
// its empty default. Returns { state, promoted } where `promoted` is the version
// metadata that became current (or null when there was nothing to promote).
function deleteCurrentPromoteLatest() {
  const { st, items } = _ensureMigrated();
  const active = (st.draft && st.draft.docId) || null;
  let promoted = null;
  // Promote the newest EARLIER revision of the SAME document (not some other
  // newsletter's version). If this document has no earlier revisions, it's gone —
  // clear the draft to its empty default.
  const idx = items.findIndex(v => (v.markdown || '').trim() && (!active || v.docId === active));
  if (idx >= 0) {
    const top = items.splice(idx, 1)[0];
    _writeVersions(items);
    const title = extractTitle(top.markdown || '') || top.title || '';
    st.draft = {
      ..._clone(DEFAULT_STATE.draft),
      markdown: top.markdown || '',
      title,
      source: top.source === 'ai' ? 'ai' : 'manual',
      generatedAt: top.createdAt || '',
      updatedAt: new Date().toISOString(),
      docId: top.docId || active || _mintDocId(),
      coveredFrom: top.coveredFrom || '', coveredTo: top.coveredTo || '',
      evidenceCount: Number(top.evidenceCount) || 0,
    };
    promoted = { id: top.id, title, source: st.draft.source, savedAt: top.savedAt || null };
  } else {
    st.draft = _clone(DEFAULT_STATE.draft);
  }
  _writeJson(_statePath(), st);
  return { state: st, promoted };
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
  markAutoGenerated,
  clearReviewPending,
  listDraftVersions,
  listDocuments,
  openDocument,
  newDocument,
  windowChanged,
  getDraftVersion,
  deleteDraftVersion,
  deleteCurrentPromoteLatest,
  renameDraftVersion,
  extractTitle,
  sinceForDays,
  evidenceForTimeframe,
  exportAll,
  DEFAULT_STATE,
};
