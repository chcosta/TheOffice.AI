#!/usr/bin/env node
// board-mcp.js
//
// A zero-dependency Model Context Protocol (MCP) stdio server that wraps the
// TheOffice.AI board HTTP API (/api/boards...). It lets any agent that has this
// MCP attached read and update boards: list boards, read a board's pinned
// resources / notes / checklists, add notes & checklists, check items off,
// pin a resource to a board, and fully manage Dev items (work item + PR +
// git worktree trackers) — create/update/remove them and drive their
// worktree / refresh / sync / summary / dev-agent / PR / cleanup actions.
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
    devItems: (b.devItems || []).map(devItemSummary),
  };
}

// ---- Dev items -----------------------------------------------------------
// A dev item groups an Azure DevOps work item + PR + a local git worktree.

function devItemSummary(d) {
  return {
    id: d.id,
    title: d.title || '',
    org: d.org || '', project: d.project || '', repo: d.repo || '',
    baseBranch: d.baseBranch || '', branch: d.branch || '',
    workItemId: d.workItemId || '',
    workItemState: (d.workItem && d.workItem.state) || '',
    prId: d.prId || '',
    prStatus: (d.pr && d.pr.status) || '',
    worktreeStatus: d.worktreePath ? (d.worktreeStatus || 'ready') : 'none',
    devAgent: d.devAgentName || '',
    links: Array.isArray(d.links) ? d.links.length : 0,
    extraRepos: Array.isArray(d.repos) ? d.repos.length : 0,
    reports: Array.isArray(d.reports) ? d.reports.length : 0,
  };
}

function devItemLinks(d) {
  return (Array.isArray(d.links) ? d.links : []).map(l => ({
    id: l.id || '', label: l.label || '', url: l.url || '', addedAt: l.addedAt || null,
  }));
}

function devItemRepos(d) {
  return (Array.isArray(d.repos) ? d.repos : []).map(r => ({
    id: r.id || '', org: r.org || '', project: r.project || '', repo: r.repo || '',
    branch: r.branch || '', baseBranch: r.baseBranch || '',
    worktreeStatus: r.worktreeStatus || (r.worktreePath ? 'ready' : 'none'),
    git: r.git || null,
  }));
}

function devItemReports(d) {
  return (Array.isArray(d.reports) ? d.reports : []).map(r => ({
    name: r.name || r.rel || '', rel: r.rel || '', kind: r.kind || '',
    size: r.size || 0, mtime: r.mtime || null,
  }));
}

function devItemDetail(d) {
  return {
    ...devItemSummary(d),
    worktreePath: d.worktreePath || '',
    worktreeError: d.worktreeError || null,
    git: d.git || null,
    workItem: d.workItem || null,
    pr: d.pr || null,
    summary: d.summary || null,
    devAgentFile: d.devAgentFile || '',
    linkList: devItemLinks(d),
    repoList: devItemRepos(d),
    reportList: devItemReports(d),
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

async function getDevItem(boardId, devId) {
  const b = await getBoard(boardId);
  const d = (b.devItems || []).find(x => x.id === devId);
  if (!d) throw new Error(`dev item "${devId}" not found on board "${boardId}"`);
  return { board: b, dev: d };
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

  get_board_layout: {
    description: "Read a board's layout digest: every panel's id, kind, title, and current state (collapsed, chip, hidden/stashed, grid x/y/w/h on a 12-column grid, and which aspects are locked — vis/size/pos). Panel ids are 'wherewasi' (the summary), 'pin:<itemId>', 'note:<noteId>', 'cl:<checklistId>'. Use these ids as the target of set_board_layout intents.",
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    async run({ boardId }) {
      if (!boardId) throw new Error('boardId is required');
      const d = await api('/api/boards/' + encodeURIComponent(boardId) + '/layout');
      return { version: d.version, cols: d.cols, panels: d.panels };
    },
  },

  set_board_layout: {
    description: "Apply a batch of layout intents to a board. Each intent is { type, target, ...args }. type is one of: collapse, expand, stash, unstash, move (args x,y), resize (args w,h; 2..12 grid columns wide). target is a panel id from get_board_layout. Locks are enforced server-side: an intent against a locked aspect (vis/size/pos) is REFUSED, not applied — the response lists every applied and refused intent (with a reason) so you can see what stuck. Use get_board_layout first to learn panel ids and lock state.",
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        intents: {
          type: 'array',
          description: 'Layout intents to apply, in order.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['collapse', 'expand', 'stash', 'unstash', 'move', 'resize'] },
              target: { type: 'string', description: 'Panel id (from get_board_layout).' },
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' },
            },
            required: ['type', 'target'],
            additionalProperties: false,
          },
        },
      },
      required: ['boardId', 'intents'],
      additionalProperties: false,
    },
    async run({ boardId, intents }) {
      if (!boardId) throw new Error('boardId is required');
      if (!Array.isArray(intents) || !intents.length) throw new Error('intents must be a non-empty array');
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/layout/intents', {
        method: 'POST',
        body: { version: 1, actor: 'mcp', intents },
      });
      return { ok: true, applied: r.applied, refused: r.refused, summary: r.summary, changed: r.changed, txnId: r.txnId };
    },
  },

  undo_board_layout: {
    description: "Undo the most recent layout change made through set_board_layout — but only if the user has not edited the board layout since (the server refuses with 409 if a conflicting edit landed). Pass the txnId returned by set_board_layout to undo a specific transaction.",
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        txnId: { type: 'string', description: 'Optional: the transaction id to undo (from set_board_layout).' },
      },
      required: ['boardId'],
      additionalProperties: false,
    },
    async run({ boardId, txnId }) {
      if (!boardId) throw new Error('boardId is required');
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/layout/undo', {
        method: 'POST',
        body: txnId ? { txnId } : {},
      });
      return { ok: true, undone: r.undone };
    },
  },

  // ---- Dev item tools ----------------------------------------------------

  list_dev_items: {
    description: 'List the Dev items on a board. A Dev item groups an Azure DevOps work item + PR + a local git worktree. Returns a compact summary (work item id/state, PR id/status, worktree status, dev agent) for each.',
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    async run({ boardId }) {
      const b = await getBoard(boardId);
      return { devItems: (b.devItems || []).map(devItemSummary) };
    },
  },

  get_dev_item: {
    description: 'Read one Dev item in full: its work item, PR, git ahead/behind state, AI summary, worktree path, dev agent, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string', description: 'The dev item id (from list_dev_items).' },
      },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId }) {
      const { dev } = await getDevItem(boardId, devId);
      return { devItem: devItemDetail(dev) };
    },
  },

  create_dev_item: {
    description: 'Add a new Dev item (Azure DevOps work item + PR + git worktree tracker) to a board. org, project and repo are required; baseBranch/branch/workItemId/prId are optional. Set createWorktree:true to also kick off the worktree right away (async); otherwise call dev_item_action with action "create-worktree" afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        title: { type: 'string' },
        org: { type: 'string', description: 'Azure DevOps organization.' },
        project: { type: 'string', description: 'Azure DevOps project.' },
        repo: { type: 'string', description: 'Repository name.' },
        baseBranch: { type: 'string' },
        branch: { type: 'string' },
        workItemId: { type: 'string' },
        prId: { type: 'string' },
        createWorktree: { type: 'boolean', description: 'When true, also start creating the git worktree immediately after the item is saved.' },
      },
      required: ['boardId', 'org', 'project', 'repo'],
      additionalProperties: false,
    },
    async run({ boardId, title, org, project, repo, baseBranch, branch, workItemId, prId, createWorktree }) {
      if (!org || !project || !repo) throw new Error('org, project and repo are required');
      const b = await getBoard(boardId);
      const now = nowIso();
      const item = {
        id: rid('dev'),
        title: String(title || repo), org: String(org), project: String(project), repo: String(repo),
        baseBranch: String(baseBranch || ''), branch: String(branch || ''),
        workItemId: workItemId != null ? String(workItemId).trim() : '',
        prId: prId != null ? String(prId).trim() : '',
        worktreePath: '', worktreeStatus: null, worktreeError: null,
        git: null, workItem: null, pr: null, summary: null,
        createdAt: now, updatedAt: now,
      };
      const devItems = [...(b.devItems || []), item];
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { devItems } });
      let worktree = 'not started';
      if (createWorktree) {
        try {
          await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(item.id) + '/worktree', { method: 'POST', body: {} });
          worktree = 'creating (async — poll get_dev_item for status)';
        } catch (e) {
          worktree = 'failed to start: ' + (e && e.message || e);
        }
      }
      return { ok: true, devId: item.id, devItem: devItemSummary(item), worktree };
    },
  },

  update_dev_item: {
    description: "Update a Dev item's metadata (title, work item link, PR link, base/feature branch). Only the provided fields are changed.",
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        title: { type: 'string' },
        org: { type: 'string' },
        project: { type: 'string' },
        repo: { type: 'string' },
        baseBranch: { type: 'string' },
        branch: { type: 'string' },
        workItemId: { type: 'string' },
        prId: { type: 'string' },
      },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run(args) {
      const { boardId, devId } = args;
      const b = await getBoard(boardId);
      if (!(b.devItems || []).some(d => d.id === devId)) throw new Error(`dev item "${devId}" not found`);
      const patch = {};
      for (const k of ['title', 'org', 'project', 'repo', 'baseBranch', 'branch']) {
        if (args[k] !== undefined) patch[k] = String(args[k]);
      }
      if (args.workItemId !== undefined) patch.workItemId = args.workItemId != null ? String(args.workItemId).trim() : '';
      if (args.prId !== undefined) patch.prId = args.prId != null ? String(args.prId).trim() : '';
      if (!Object.keys(patch).length) throw new Error('no updatable fields provided');
      const devItems = (b.devItems || []).map(d => d.id === devId ? { ...d, ...patch, updatedAt: nowIso() } : d);
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { devItems } });
      return { ok: true, devId };
    },
  },

  remove_dev_item: {
    description: 'Remove a Dev item from a board. Best-effort cleans up its on-disk worktree first, then deletes the tracker. Destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
      },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId }) {
      const { dev } = await getDevItem(boardId, devId);
      if (dev.worktreePath) {
        try { await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/remove-worktree', { method: 'POST', body: {} }); } catch { /* best effort */ }
      }
      const b = await getBoard(boardId);
      const devItems = (b.devItems || []).filter(d => d.id !== devId);
      await api('/api/boards/' + encodeURIComponent(boardId), { method: 'PUT', body: { devItems } });
      return { ok: true, removed: devId };
    },
  },

  dev_item_action: {
    description: 'Operate on an existing Dev item. Actions: "refresh" (re-read live work item/PR/git state), "sync" (pull worktree up to date with origin), "create-worktree" (clone + checkout the branch — async, then poll get_dev_item), "summary" (regenerate the AI state summary), "create-dev-agent" (write a focused agent file into the worktree), "create-pr" (push the branch and open an AI-authored PR), "cleanup-worktree" (remove the on-disk worktree but keep the tracker). summary/create-pr/create-dev-agent use AI and take longer.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['refresh', 'sync', 'create-worktree', 'summary', 'create-dev-agent', 'create-pr', 'cleanup-worktree'],
        },
      },
      required: ['boardId', 'devId', 'action'],
      additionalProperties: false,
    },
    async run({ boardId, devId, action }) {
      const OPS = {
        refresh: 'refresh', sync: 'sync', 'create-worktree': 'worktree',
        summary: 'summary', 'create-dev-agent': 'dev-agent', 'create-pr': 'pr',
        'cleanup-worktree': 'remove-worktree',
      };
      const op = OPS[String(action || '')];
      if (!op) throw new Error(`unknown action "${action}"`);
      // Validate the dev item exists up front for a clear error.
      await getDevItem(boardId, devId);
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/' + op, { method: 'POST', body: {} });
      if (op === 'worktree') {
        return { ok: true, status: r.status || 'creating', note: 'Worktree creation is async — poll get_dev_item for worktreeStatus.' };
      }
      return { ok: true, devItem: r.dev ? devItemSummary(r.dev) : null, result: r.message || r.status || null };
    },
  },

  list_dev_links: {
    description: "List the saved Links on a Dev card (the card's Links section — quick links to docs, dashboards, files). Returns each link's id, label and url. These are NOT the work item or PR (those are dev_item metadata).",
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string' }, devId: { type: 'string' } },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId }) {
      const { dev } = await getDevItem(boardId, devId);
      return { links: devItemLinks(dev) };
    },
  },

  add_dev_link: {
    description: "Add a link to a Dev card's Links section. url is required (http(s):, file:, mailto:, vscode:, or an absolute path); label is optional (derived from the filename when omitted).",
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        url: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['boardId', 'devId', 'url'],
      additionalProperties: false,
    },
    async run({ boardId, devId, url, label }) {
      if (!url) throw new Error('url is required');
      await getDevItem(boardId, devId);
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/links', { method: 'POST', body: { url: String(url), label: String(label || '') } });
      return { ok: true, links: r.dev ? devItemLinks(r.dev) : null };
    },
  },

  remove_dev_link: {
    description: "Remove a link from a Dev card's Links section. Identify the link by its id (from list_dev_links) or by its exact url. Destructive.",
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        linkId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId, linkId, url }) {
      if (!linkId && !url) throw new Error('linkId or url is required');
      await getDevItem(boardId, devId);
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/links/delete', { method: 'POST', body: { id: String(linkId || ''), url: String(url || '') } });
      return { ok: true, links: r.dev ? devItemLinks(r.dev) : null };
    },
  },

  list_dev_repos: {
    description: 'List the additional (non-primary) repos attached to a Dev card. The primary repo is the dev_item org/project/repo; these are extra repos with their own worktree/branch. Returns each repo id, org/project/repo, branch and worktree status.',
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string' }, devId: { type: 'string' } },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId }) {
      const { dev } = await getDevItem(boardId, devId);
      return { repos: devItemRepos(dev) };
    },
  },

  add_dev_repo: {
    description: 'Attach an additional repo to a Dev card (beyond the primary repo). org, project and repo are required; baseBranch/branch optional. Returns the updated repo list including the new repoId.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        org: { type: 'string' },
        project: { type: 'string' },
        repo: { type: 'string' },
        baseBranch: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['boardId', 'devId', 'org', 'project', 'repo'],
      additionalProperties: false,
    },
    async run({ boardId, devId, org, project, repo, baseBranch, branch }) {
      if (!org || !project || !repo) throw new Error('org, project and repo are required');
      await getDevItem(boardId, devId);
      const body = { org: String(org), project: String(project), repo: String(repo) };
      if (baseBranch !== undefined) body.baseBranch = String(baseBranch);
      if (branch !== undefined) body.branch = String(branch);
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/repos', { method: 'POST', body });
      return { ok: true, repos: r.dev ? devItemRepos(r.dev) : null };
    },
  },

  remove_dev_repo: {
    description: 'Remove an additional repo from a Dev card by its repoId (from list_dev_repos). The primary repo cannot be removed. Best-effort cleans up its worktree. Destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        devId: { type: 'string' },
        repoId: { type: 'string' },
      },
      required: ['boardId', 'devId', 'repoId'],
      additionalProperties: false,
    },
    async run({ boardId, devId, repoId }) {
      if (!repoId) throw new Error('repoId is required');
      await getDevItem(boardId, devId);
      const r = await api('/api/boards/' + encodeURIComponent(boardId) + '/dev-items/' + encodeURIComponent(devId) + '/repos/remove', { method: 'POST', body: { repoId: String(repoId) } });
      return { ok: true, repos: r.dev ? devItemRepos(r.dev) : null };
    },
  },

  list_dev_reports: {
    description: "List the read-only Reports captured for a Dev card (generated artifacts — HTML/markdown/text). Returns each report's name, rel path and kind. Reports are read-only from here; they're produced by the dev workflow, not added via this API.",
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string' }, devId: { type: 'string' } },
      required: ['boardId', 'devId'],
      additionalProperties: false,
    },
    async run({ boardId, devId }) {
      const { dev } = await getDevItem(boardId, devId);
      return { reports: devItemReports(dev) };
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
