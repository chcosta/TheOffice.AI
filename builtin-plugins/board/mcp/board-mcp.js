#!/usr/bin/env node
// board-mcp.js
//
// A zero-dependency Model Context Protocol (MCP) stdio server that wraps the
// TheOffice.AI board HTTP API (/api/boards...). It lets any agent that has this
// MCP attached read and update boards: list boards, read a board's pinned
// resources / notes / checklists, add notes & checklists, check items off, and
// pin a resource to a board.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
// convention). No SDK dependency — the framing is small and stable.
//
// Configuration (env):
//   BOARD_API_BASE   base URL of the running supervisor server.
//                    Defaults to http://127.0.0.1:3847.
//
// The note/checklist/item shapes produced here mirror exactly what the SPA's own
// board mutators create, so anything this server writes renders and round-trips
// identically through the normal PUT /api/boards/:id path.

'use strict';

const BASE = (process.env.BOARD_API_BASE || 'http://127.0.0.1:3847').replace(/\/+$/, '');
const SERVER_INFO = { name: 'board', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

// ---- HTTP helpers --------------------------------------------------------

async function api(pathname, { method = 'GET', body } = {}) {
  const url = BASE + pathname;
  const opts = { method, headers: { 'accept': 'application/json' } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Cannot reach board API at ${BASE} (${e.message}). Is the server running?`);
  }
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
    throw new Error(`${method} ${pathname} failed: ${msg}`);
  }
  return data;
}

async function getBoard(boardId) {
  if (!boardId) throw new Error('boardId is required');
  return api('/api/boards/' + encodeURIComponent(boardId));
}

const nowIso = () => new Date().toISOString();
const rid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function mkChecklistItem(t) {
  const o = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
  const it = { id: rid('ci'), text: o.text || '', done: !!o.done, createdAt: nowIso() };
  if (o.ref && o.ref.kind && o.ref.refId) {
    it.ref = { kind: o.ref.kind, refId: o.ref.refId, label: o.ref.label || o.ref.refId };
  }
  return it;
}

// Compact view of a board for the model.
function summarizeBoard(b) {
  return {
    id: b.id,
    name: b.name,
    emoji: b.emoji,
    teamId: b.teamId || null,
    archived: !!b.archived,
    counts: {
      pins: (b.items || []).length,
      notes: (b.notes || []).length,
      checklists: (b.checklists || []).length,
    },
  };
}

function detailBoard(b) {
  return {
    id: b.id,
    name: b.name,
    emoji: b.emoji,
    teamId: b.teamId || null,
    archived: !!b.archived,
    pins: (b.items || []).map(it => ({ id: it.id, kind: it.kind, refId: it.refId, label: it.label, sublabel: it.sublabel || '' })),
    notes: (b.notes || []).map(n => ({ id: n.id, text: n.text || '' })),
    checklists: (b.checklists || []).map(cl => ({
      id: cl.id,
      title: cl.title || '',
      items: (cl.items || []).map(i => ({ id: i.id, text: i.text || '', done: !!i.done, ref: i.ref || null })),
    })),
  };
}

// ---- Tools ---------------------------------------------------------------

const BOARD_KINDS = ['agent', 'manager', 'task', 'assignment', 'flow', 'chat', 'session', 'location'];

const TOOLS = {
  list_boards: {
    description: 'List all boards with their id, name, emoji, team scope, and counts of pins/notes/checklists. Call this first to discover a boardId.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const boards = await api('/api/boards');
      return { boards: (boards || []).map(summarizeBoard) };
    },
  },

  get_board: {
    description: "Read a single board's full contents: its pinned resources, notes, and checklists (with item ids and done state). Use the ids returned here when adding to or checking off a checklist.",
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string', description: 'The board id (from list_boards).' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    async run({ boardId }) {
      return { board: detailBoard(await getBoard(boardId)) };
    },
  },

  add_note: {
    description: 'Add a free-text note to a board. Notes support markdown and clickable URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        text: { type: 'string', description: 'The note body (markdown allowed).' },
      },
      required: ['boardId', 'text'],
      additionalProperties: false,
    },
    async run({ boardId, text }) {
      if (!text || !String(text).trim()) throw new Error('text is required');
      const b = await getBoard(boardId);
      const note = { id: rid('note'), text: String(text), createdAt: nowIso() };
      const notes = [...(b.notes || []), note];
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { notes } });
      return { ok: true, noteId: note.id };
    },
  },

  add_checklist: {
    description: 'Create a checklist on a board, optionally pre-filled with items. Each item may be a plain string or an object { text, done, ref:{kind,refId,label} } where ref links the item to a resource already pinned to the board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        title: { type: 'string' },
        items: {
          type: 'array',
          description: 'Optional initial items (strings or { text, done, ref } objects).',
          items: {},
        },
      },
      required: ['boardId', 'title'],
      additionalProperties: false,
    },
    async run({ boardId, title, items }) {
      if (!title || !String(title).trim()) throw new Error('title is required');
      const b = await getBoard(boardId);
      const cl = {
        id: rid('cl'),
        title: String(title),
        items: (Array.isArray(items) ? items : []).map(mkChecklistItem),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const checklists = [...(b.checklists || []), cl];
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { checklists } });
      return { ok: true, checklistId: cl.id, itemIds: cl.items.map(i => i.id) };
    },
  },

  add_checklist_items: {
    description: 'Append one or more items to an existing checklist. Items may be strings or { text, done, ref } objects.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        checklistId: { type: 'string', description: 'The checklist id (from get_board).' },
        items: { type: 'array', items: {} },
      },
      required: ['boardId', 'checklistId', 'items'],
      additionalProperties: false,
    },
    async run({ boardId, checklistId, items }) {
      if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array');
      const b = await getBoard(boardId);
      const existing = (b.checklists || []).find(c => c.id === checklistId);
      if (!existing) throw new Error('checklist not found: ' + checklistId);
      const added = items.map(mkChecklistItem);
      const checklists = (b.checklists || []).map(c => c.id === checklistId
        ? { ...c, items: [...(c.items || []), ...added], updatedAt: nowIso() }
        : c);
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { checklists } });
      return { ok: true, itemIds: added.map(i => i.id) };
    },
  },

  set_checklist_item: {
    description: 'Mark a checklist item done or not-done.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        checklistId: { type: 'string' },
        itemId: { type: 'string' },
        done: { type: 'boolean', description: 'true to check, false to uncheck. Defaults to true.' },
      },
      required: ['boardId', 'checklistId', 'itemId'],
      additionalProperties: false,
    },
    async run({ boardId, checklistId, itemId, done }) {
      const want = done === undefined ? true : !!done;
      const b = await getBoard(boardId);
      const cl = (b.checklists || []).find(c => c.id === checklistId);
      if (!cl) throw new Error('checklist not found: ' + checklistId);
      if (!(cl.items || []).some(i => i.id === itemId)) throw new Error('item not found: ' + itemId);
      const checklists = (b.checklists || []).map(c => c.id !== checklistId ? c : {
        ...c,
        items: (c.items || []).map(i => i.id === itemId ? { ...i, done: want } : i),
        updatedAt: nowIso(),
      });
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { checklists } });
      return { ok: true, itemId, done: want };
    },
  },

  pin_to_board: {
    description: 'Pin a resource to a board so it appears as a panel. kind is one of: ' + BOARD_KINDS.join(', ') + '. refId is the resource id (e.g. an agent id, or "task-<id>" for a task).',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        kind: { type: 'string', enum: BOARD_KINDS },
        refId: { type: 'string' },
        label: { type: 'string' },
        sublabel: { type: 'string' },
      },
      required: ['boardId', 'kind', 'refId'],
      additionalProperties: false,
    },
    async run({ boardId, kind, refId, label, sublabel }) {
      if (!BOARD_KINDS.includes(kind)) throw new Error('invalid kind: ' + kind);
      if (!refId) throw new Error('refId is required');
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/items', {
        method: 'POST',
        body: { kind, refId, label: label || refId, sublabel: sublabel || '' },
      });
      return { ok: true, alreadyPinned: !!r.alreadyPinned };
    },
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// ---- JSON-RPC plumbing ---------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) never get a response.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return; // no response
  }
  if (method === 'ping') {
    return reply(id, {});
  }
  if (method === 'tools/list') {
    return reply(id, { tools: toolList() });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) return replyError(id, -32601, 'Unknown tool: ' + name);
    try {
      const result = await tool.run(args);
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      // Tool-level error: report through the result channel with isError so the
      // model sees the message and can recover, rather than killing the call.
      return reply(id, {
        content: [{ type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) }],
        isError: true,
      });
    }
  }
  if (!isNotification) {
    return replyError(id, -32601, 'Method not found: ' + method);
  }
}

// Line-buffered stdin reader (newline-delimited JSON).
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id != null) replyError(msg.id, -32603, 'Internal error: ' + (e && e.message ? e.message : String(e)));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
