'use strict';

// ---------------------------------------------------------------------------
// Global dev-card store.
//
// Dev cards used to be OWNED per-board (boards.json -> b.devItems[]). They are
// now first-class objects in their OWN global store (dev-items.json), so a card
// can exist independently of any board, show up on a dedicated "Dev" page, and
// be pinned to one or more boards.
//
// Migration strategy (strangler-fig): the server keeps `board.devItems` as a raw
// backup and projects the store's cards into each board via `_normalizeBoard`, so
// the existing SPA render path keeps working unchanged while storage moves here.
//
// Each card carries the original dev-card fields plus:
//   teamId       scope (copied from the origin board; null = global)
//   homeBoardId  provenance + report-cache namespace (cache dirs live under it)
//   createdAt / updatedAt
// Server-owned runtime fields (worktreePath, git, pr, summary, notes, links,
// repos, …) live on the card and are only mutated by the dedicated dev routes.
// ---------------------------------------------------------------------------

const fs = require('fs');
const { dataPath } = require('./data-paths');

const STORE_PATH = dataPath('dev-items.json');

function _now() { return new Date().toISOString(); }

// Wrapper shape: { items: [...], _boardsMigratedAt: ISO|null }. Kept as an object
// (not a bare array) so we can stamp a one-time migration marker.
//
// `_normalizeBoard` (server) projects the store into every board it shapes, so a
// single GET /api/boards would re-read this file once per board. A tiny mtime
// cache keeps that to one disk read until the file actually changes.
let _cache = null;      // last-parsed wrapper (deep copy handed out per call)
let _cacheMtime = -1;

function _parse(text) {
  const v = JSON.parse(text);
  if (Array.isArray(v)) return { items: v, _boardsMigratedAt: null };
  if (v && typeof v === 'object') {
    return { items: Array.isArray(v.items) ? v.items : [], _boardsMigratedAt: v._boardsMigratedAt || null };
  }
  return { items: [], _boardsMigratedAt: null };
}

function loadRaw() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { items: [], _boardsMigratedAt: null };
    const mt = fs.statSync(STORE_PATH).mtimeMs;
    if (!_cache || mt !== _cacheMtime) {
      _cache = _parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      _cacheMtime = mt;
    }
    // Hand out a shallow-cloned wrapper + cloned array so callers can't mutate the
    // cache in place (they persist via saveRaw, which refreshes the cache).
    return { items: _cache.items.slice(), _boardsMigratedAt: _cache._boardsMigratedAt };
  } catch { /* fall through to empty */ }
  return { items: [], _boardsMigratedAt: null };
}

function saveRaw(raw) {
  const out = { items: Array.isArray(raw.items) ? raw.items : [], _boardsMigratedAt: raw._boardsMigratedAt || null };
  fs.writeFileSync(STORE_PATH, JSON.stringify(out, null, 2));
  _cache = { items: out.items.slice(), _boardsMigratedAt: out._boardsMigratedAt };
  try { _cacheMtime = fs.statSync(STORE_PATH).mtimeMs; } catch { _cacheMtime = -1; }
}

function all() { return loadRaw().items; }

function find(devId) {
  if (!devId) return null;
  return loadRaw().items.find(d => d && d.id === devId) || null;
}

// Cards that belong to a board. Phase 1: membership is provenance (homeBoardId).
// `pinnedIds` (Phase 3) lets a board additionally show cards pinned to it.
function forBoard(boardId, pinnedIds) {
  if (!boardId) return [];
  const pins = pinnedIds instanceof Set ? pinnedIds : new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  return loadRaw().items.filter(d => d && (d.homeBoardId === boardId || pins.has(d.id)));
}

// Replace (or insert) a whole card by id. Stamps updatedAt.
function upsert(card) {
  if (!card || !card.id) return null;
  const raw = loadRaw();
  const i = raw.items.findIndex(d => d && d.id === card.id);
  const next = { ...card, updatedAt: _now() };
  if (!next.createdAt) next.createdAt = next.updatedAt;
  if (i >= 0) raw.items[i] = next; else raw.items.push(next);
  saveRaw(raw);
  return next;
}

// Merge a partial onto an existing card. Returns the updated card or null.
function patch(devId, partial) {
  const raw = loadRaw();
  const i = raw.items.findIndex(d => d && d.id === devId);
  if (i < 0) return null;
  const next = { ...raw.items[i], ...(partial || {}), updatedAt: _now() };
  raw.items[i] = next;
  saveRaw(raw);
  return next;
}

function remove(devId) {
  const raw = loadRaw();
  const i = raw.items.findIndex(d => d && d.id === devId);
  if (i < 0) return null;
  const [gone] = raw.items.splice(i, 1);
  saveRaw(raw);
  return gone || null;
}

function _genId() {
  return 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Create a brand-new card. Caller supplies client-editable metadata.
function create(fields) {
  const f = fields || {};
  const id = (typeof f.id === 'string' && f.id.trim()) ? f.id.trim() : _genId();
  const card = {
    ...f,
    id,
    teamId: f.teamId !== undefined ? (f.teamId || null) : null,
    homeBoardId: f.homeBoardId || null,
    archived: !!f.archived,
    createdAt: _now(),
    updatedAt: _now(),
  };
  return upsert(card);
}

// Overwrite the whole items array (used by admin/sync paths). Keeps the marker.
function setAll(items) {
  const raw = loadRaw();
  raw.items = Array.isArray(items) ? items : [];
  saveRaw(raw);
  return raw.items;
}

// One-time, idempotent import of every board's devItems[] into the store.
// READ-ONLY against boards (Phase 1 never mutates boards.json): cards are copied,
// not moved, so `board.devItems` stays as a raw backup. Cards already present in
// the store (matched by id) are left untouched.
function migrateFromBoards(loadBoards) {
  const raw = loadRaw();
  const known = new Set(raw.items.map(d => d && d.id).filter(Boolean));
  let boards = [];
  try { boards = loadBoards() || []; } catch { return { imported: 0 }; }
  let imported = 0;
  for (const b of boards) {
    if (!b || !b.id) continue;
    const list = Array.isArray(b.devItems) ? b.devItems : [];
    for (const d of list) {
      if (!d || !d.id || known.has(d.id)) continue;
      raw.items.push({
        ...d,
        teamId: d.teamId !== undefined ? (d.teamId || null) : (b.teamId || null),
        homeBoardId: d.homeBoardId || b.id,
        createdAt: d.createdAt || _now(),
        updatedAt: d.updatedAt || _now(),
      });
      known.add(d.id);
      imported++;
    }
  }
  if (imported > 0 || !raw._boardsMigratedAt) {
    if (!raw._boardsMigratedAt) raw._boardsMigratedAt = _now();
    saveRaw(raw);
  }
  return { imported };
}

module.exports = {
  STORE_PATH,
  all, find, forBoard, upsert, patch, remove, create, setAll,
  migrateFromBoards,
};
