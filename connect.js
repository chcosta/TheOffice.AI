'use strict';

// connect.js
// Local storage + domain logic for the "Connect" feature: a living, private,
// AI-assisted impact/performance diary.
//
// The backing data is PER-USER runtime state and can contain sensitive work
// details (Teams posts, email subjects, meeting notes, ADO items). It therefore
// lives under the profile data dir by default — NEVER in the repo — and can be
// redirected to a OneDrive-synced folder via the connectStorageDir setting.
//
// Two files:
//   state.json     — { profile, draft, guidance, meta }   (the Connect itself)
//   evidence.json  — { items:[ ... ] }                     (the daily diary/log)
//
// Design guardrail (Microsoft HR policy): the AI is a DRAFTING ASSISTANT, never
// the author or a performance rater. Every generated draft is stored as an
// editable draft the user personalizes in their own voice. Automated collection
// is inert until the user explicitly consents (enforced by the caller/settings).

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');

let _settings = null;
function settings() {
  if (!_settings) _settings = require('./settings');
  return _settings;
}

// Resolve the storage directory, honoring the connectStorageDir setting (e.g. a
// OneDrive-synced folder) and falling back to the per-user data dir. Always
// ensures the directory exists.
function storageDir() {
  let dir = '';
  try {
    const s = settings().getSettings();
    dir = (s.connectStorageDir || '').trim();
  } catch { /* settings not ready */ }
  if (!dir) dir = dataPath('connect');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function _statePath() { return path.join(storageDir(), 'state.json'); }
function _evidencePath() { return path.join(storageDir(), 'evidence.json'); }
function _versionsPath() { return path.join(storageDir(), 'draft-versions.json'); }
function _memoriesPath() { return path.join(storageDir(), 'memories.json'); }

// How many prior draft revisions to retain (newest kept, oldest pruned).
const MAX_DRAFT_VERSIONS = 40;
// How many guiding memories to retain (newest kept, oldest pruned).
const MAX_MEMORIES = 120;

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
    console.error('[connect] failed to write', path.basename(file) + ':', e.message);
    return false;
  }
}

function _id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- State (profile + draft + guidance) -------------------------------------

const DEFAULT_STATE = {
  // "My current role" — user-owned context that steers the draft. Not collected.
  profile: {
    role: '',
    level: '',
    summary: '',
    responsibilities: '',
    priorities: '',
  },
  // The Connect draft itself. `markdown` is the single editable body the user
  // personalizes; `sections` is an optional structured mirror the generator may
  // populate. `source` records whether the current body was AI-drafted or hand-
  // edited so the UI can badge it honestly.
  draft: {
    markdown: '',
    sections: {
      impact: '',
      how: '',
      reflection: '',
      goals: '',
      growth: '',
    },
    source: 'manual',      // 'manual' | 'ai'
    generatedAt: null,
    updatedAt: null,
  },
  // User controls that steer AI drafting tone/direction.
  guidance: {
    tone: 'professional',        // freeform label
    positivity: 'balanced',      // 'balanced' | 'confident' | 'humble'
    instructions: '',            // freeform "steer the AI" prompt
    focusAreas: [],              // things to emphasize
  },
  meta: {
    createdAt: null,
    lastCollectedAt: null,
  },
};

function _mergeState(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    profile: { ...DEFAULT_STATE.profile, ...(s.profile || {}) },
    draft: {
      ...DEFAULT_STATE.draft,
      ...(s.draft || {}),
      sections: { ...DEFAULT_STATE.draft.sections, ...((s.draft && s.draft.sections) || {}) },
    },
    guidance: { ...DEFAULT_STATE.guidance, ...(s.guidance || {}) },
    meta: { ...DEFAULT_STATE.meta, ...(s.meta || {}) },
  };
}

function getState() {
  const st = _mergeState(_readJson(_statePath(), null));
  if (!st.meta.createdAt) {
    st.meta.createdAt = new Date().toISOString();
    _writeJson(_statePath(), st);
  }
  return st;
}

function saveProfile(patch) {
  const st = getState();
  st.profile = { ...st.profile, ..._pick(patch, Object.keys(DEFAULT_STATE.profile)) };
  _writeJson(_statePath(), st);
  return st;
}

function saveGuidance(patch) {
  const st = getState();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...st.guidance };
  if (typeof p.tone === 'string') next.tone = p.tone;
  if (typeof p.positivity === 'string') next.positivity = p.positivity;
  if (typeof p.instructions === 'string') next.instructions = p.instructions;
  if (Array.isArray(p.focusAreas)) next.focusAreas = p.focusAreas.map(String).filter(Boolean);
  st.guidance = next;
  _writeJson(_statePath(), st);
  return st;
}

// Save the draft body. `source` marks who authored this revision. Any user edit
// of the body should pass source:'manual' so the draft is honestly labeled.
//
// Before overwriting a non-empty draft with different content, the prior body is
// snapshotted into draft-versions.json so the user can view / restore an earlier
// revision (e.g. if an AI regeneration replaced wording they liked).
function saveDraft(patch, { source } = {}) {
  const st = getState();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...st.draft };
  if (typeof p.markdown === 'string') next.markdown = p.markdown;
  if (p.sections && typeof p.sections === 'object') {
    next.sections = { ...next.sections, ..._pick(p.sections, Object.keys(DEFAULT_STATE.draft.sections)) };
  }
  // Snapshot the outgoing draft if it had real content and the body is changing.
  const prevBody = (st.draft && st.draft.markdown || '').trim();
  const nextBody = (next.markdown || '').trim();
  if (prevBody && prevBody !== nextBody) {
    _pushDraftVersion(st.draft, { reason: source === 'ai' ? 'replaced-by-ai' : 'edited' });
  }
  if (source === 'ai') {
    next.source = 'ai';
    next.generatedAt = new Date().toISOString();
  } else if (source === 'manual') {
    next.source = 'manual';
  }
  next.updatedAt = new Date().toISOString();
  st.draft = next;
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

// Push a draft snapshot to the front of the history (newest-first), de-duping an
// identical consecutive body and pruning to MAX_DRAFT_VERSIONS.
function _pushDraftVersion(draft, { reason } = {}) {
  const body = (draft && draft.markdown || '');
  if (!body.trim()) return null;
  const items = _readVersions();
  if (items.length && (items[0].markdown || '').trim() === body.trim()) return items[0];
  const entry = {
    id: _id('cv'),
    markdown: body,
    source: draft && draft.source === 'ai' ? 'ai' : 'manual',
    reason: reason || 'edited',
    // When this revision was originally created (best-effort), and when archived.
    createdAt: (draft && (draft.updatedAt || draft.generatedAt)) || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  items.unshift(entry);
  if (items.length > MAX_DRAFT_VERSIONS) items.length = MAX_DRAFT_VERSIONS;
  _writeVersions(items);
  return entry;
}

// List saved draft revisions, newest-first. Bodies are included (drafts are small).
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

// ---- Guiding memories -------------------------------------------------------
// Durable, user-visible preferences that steer future drafting: tone rules,
// framing choices, work areas to emphasize, phrasings to prefer/avoid. Distilled
// by the AI when the user saves a draft from Ask-AI, or added by hand. Injected
// into both the "Generate from diary" and Ask-AI prompts. Fully user-managed
// (view/edit/delete) so the system is never steered in a way the user can't undo.

function _readMemories() {
  const obj = _readJson(_memoriesPath(), { items: [] });
  return Array.isArray(obj.items) ? obj.items : [];
}

function _writeMemories(items) {
  return _writeJson(_memoriesPath(), { items });
}

function _normMemoryText(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
}

// List memories, newest-first.
function listMemories() {
  return _readMemories();
}

// Add a memory. De-dupes case-insensitively against existing text and returns
// the existing entry when a duplicate is found (never creating a second copy).
function addMemory(text, { source } = {}) {
  const body = _normMemoryText(text);
  if (!body) return null;
  const items = _readMemories();
  const dup = items.find(m => _normMemoryText(m.text).toLowerCase() === body.toLowerCase());
  if (dup) return dup;
  const now = new Date().toISOString();
  const entry = {
    id: _id('cm'),
    text: body,
    source: source === 'ai' ? 'ai' : 'manual',
    createdAt: now,
    updatedAt: now,
  };
  items.unshift(entry);
  if (items.length > MAX_MEMORIES) items.length = MAX_MEMORIES;
  _writeMemories(items);
  return entry;
}

// Add several memories at once (used by AI distillation on save). Returns the
// list of entries that were newly created (duplicates skipped).
function addMemoryBatch(list, { source } = {}) {
  const added = [];
  for (const t of (Array.isArray(list) ? list : [])) {
    const body = _normMemoryText(t);
    if (!body) continue;
    const before = _readMemories().length;
    const entry = addMemory(body, { source });
    if (entry && _readMemories().length > before) added.push(entry);
  }
  return added;
}

function updateMemory(id, patch = {}) {
  const items = _readMemories();
  const idx = items.findIndex(m => m.id === id);
  if (idx < 0) return null;
  const body = _normMemoryText(patch.text);
  if (body) items[idx].text = body;
  items[idx].updatedAt = new Date().toISOString();
  _writeMemories(items);
  return items[idx];
}

function deleteMemory(id) {
  const items = _readMemories();
  const next = items.filter(m => m.id !== id);
  if (next.length === items.length) return false;
  _writeMemories(next);
  return true;
}

function _pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

// ---- Evidence (the diary) ---------------------------------------------------

const EVIDENCE_SOURCES = ['teams', 'email', 'meeting', 'ado', 'pr', 'manual', 'other'];

function _readEvidence() {
  const obj = _readJson(_evidencePath(), { items: [] });
  return Array.isArray(obj.items) ? obj.items : [];
}

function _writeEvidence(items) {
  return _writeJson(_evidencePath(), { items });
}

function _normalizeEvidence(raw, { origin } = {}) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const src = EVIDENCE_SOURCES.includes(e.source) ? e.source : 'other';
  let date = typeof e.date === 'string' && e.date ? e.date : '';
  if (!date) date = new Date().toISOString().slice(0, 10);
  return {
    id: e.id && typeof e.id === 'string' ? e.id : _id('ev'),
    date,
    source: src,
    title: typeof e.title === 'string' ? e.title : '',
    detail: typeof e.detail === 'string' ? e.detail : '',
    impact: typeof e.impact === 'string' ? e.impact : '',
    links: Array.isArray(e.links) ? e.links.map(String).filter(Boolean) : [],
    tags: Array.isArray(e.tags) ? e.tags.map(String).filter(Boolean) : [],
    hidden: e.hidden === true,
    pinned: e.pinned === true,
    origin: origin || (e.origin === 'auto' ? 'auto' : 'manual'),
    createdAt: e.createdAt && typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
  };
}

// List evidence, newest-first, with optional filters.
function listEvidence({ source, includeHidden = true, since } = {}) {
  let items = _readEvidence().map(x => _normalizeEvidence(x));
  if (source) items = items.filter(x => x.source === source);
  if (!includeHidden) items = items.filter(x => !x.hidden);
  if (since) items = items.filter(x => x.date >= since);
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.createdAt < b.createdAt) ? 1 : -1;
  });
  return items;
}

function addEvidence(raw, { origin } = {}) {
  const items = _readEvidence();
  const item = _normalizeEvidence(raw, { origin: origin || 'manual' });
  items.push(item);
  _writeEvidence(items);
  return item;
}

// Bulk-append (used by the collector). De-dupes against an optional externalId
// carried in tags as `ext:<id>` to avoid re-adding the same signal each run.
function addEvidenceBatch(list, { origin = 'auto' } = {}) {
  if (!Array.isArray(list) || !list.length) return { added: 0, skipped: 0 };
  const items = _readEvidence();
  const seen = new Set();
  for (const it of items) {
    for (const t of (it.tags || [])) if (String(t).startsWith('ext:')) seen.add(String(t));
  }
  let added = 0, skipped = 0;
  for (const raw of list) {
    const norm = _normalizeEvidence(raw, { origin });
    const ext = (norm.tags || []).find(t => String(t).startsWith('ext:'));
    if (ext && seen.has(ext)) { skipped++; continue; }
    if (ext) seen.add(ext);
    items.push(norm);
    added++;
  }
  if (added) _writeEvidence(items);
  return { added, skipped };
}

function updateEvidence(id, patch) {
  const items = _readEvidence();
  const idx = items.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const cur = _normalizeEvidence(items[idx]);
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = _normalizeEvidence({
    ...cur,
    ..._pick(p, ['date', 'source', 'title', 'detail', 'impact', 'links', 'tags', 'hidden', 'pinned']),
    id: cur.id,
    origin: cur.origin,
    createdAt: cur.createdAt,
  });
  items[idx] = merged;
  _writeEvidence(items);
  return merged;
}

function deleteEvidence(id) {
  const items = _readEvidence();
  const next = items.filter(x => x.id !== id);
  if (next.length === items.length) return false;
  _writeEvidence(next);
  return true;
}

function markCollected() {
  const st = getState();
  st.meta.lastCollectedAt = new Date().toISOString();
  _writeJson(_statePath(), st);
  return st.meta.lastCollectedAt;
}

// ---- Export -----------------------------------------------------------------

// Full backing-data export (state + evidence) for the "Export data" action.
function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    state: getState(),
    evidence: _readEvidence().map(x => _normalizeEvidence(x)),
    draftVersions: _readVersions(),
    memories: _readMemories(),
  };
}

module.exports = {
  storageDir,
  DEFAULT_STATE,
  EVIDENCE_SOURCES,
  getState,
  saveProfile,
  saveGuidance,
  saveDraft,
  listDraftVersions,
  getDraftVersion,
  deleteDraftVersion,
  listMemories,
  addMemory,
  addMemoryBatch,
  updateMemory,
  deleteMemory,
  listEvidence,
  addEvidence,
  addEvidenceBatch,
  updateEvidence,
  deleteEvidence,
  markCollected,
  exportAll,
};
