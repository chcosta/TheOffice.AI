'use strict';
// director.js — Pursuit Director core (pure, dependency-free, testable).
//
// The Director governs the legs/agents INSIDE one pursuit (a Me.AI "tree" task).
// Its job is to shrink the user's approval burden: it absorbs the gated stops that
// are provably safe (duplicate / reversible-local / factual+verified), batches
// user-facing deliverables into ONE approval, and escalates only the genuine human
// decisions to the user's desk. Everything it does is attributed to `director`
// (never the user), gated by an explicit standing grant, and recorded in a ledger.
//
// This module is PURE: it computes a plan from a folded tree + a policy. The server
// (server.js) is what actually resolves stops / spawns legs / writes the ledger,
// through the real engine paths — this module never performs I/O or impersonates
// the user, and never uses the engine's stronger-side answer fallback.

const AUTONOMY_LEVELS = ['cautious', 'balanced', 'full'];

// Dispositions the director can assign to a node (gated stop):
//   cull    — provable duplicate of an action already handled → drop the gate (0 clicks)
//   absorb  — reversible local write applied under grant (0 clicks, undoable)
//   resolve — factual + verified + reversible clash the director tie-breaks (0 clicks, undoable)
//   batch   — user-facing deliverable(s) folded into ONE desk approval
//   ask     — escalate to the user's desk (judgement / missing-info / external / spend /
//             destructive / out-of-grant / director-unsure)
const HANDLED = new Set(['cull', 'absorb', 'resolve']);

// §4 Policy matrix — node class → disposition per autonomy level. This replaces vague
// autonomy presets with a concrete map onto the engine's real stop/risk classes.
const POLICY_MATRIX = {
  'missing-info':               { cautious: 'ask',    balanced: 'ask',     full: 'ask' },
  'read-only':                  { cautious: 'absorb', balanced: 'absorb',  full: 'absorb' }, // reads never gate; here for completeness
  'duplicate':                  { cautious: 'cull',   balanced: 'cull',    full: 'cull' },
  'reversible-local':           { cautious: 'ask',    balanced: 'absorb',  full: 'absorb' },
  'deliverable':                { cautious: 'batch',  balanced: 'batch',   full: 'batch' },
  'factual-clash':              { cautious: 'ask',    balanced: 'resolve', full: 'resolve' },
  'judgement-clash':            { cautious: 'ask',    balanced: 'ask',     full: 'ask' },
  'external-spend-destructive': { cautious: 'ask',    balanced: 'ask',     full: 'ask' },
};

// Which grant op-family each auto-handled class needs. `deliverable` is always a desk
// item (batched, never absorbed) so it needs no grant. `factual-clash` needs the
// resolve-clash op; reversible writes need the edit op + a path in scope.
const CLASS_GRANT_OP = {
  'duplicate': 'cull',
  'reversible-local': 'edit',
  'factual-clash': 'resolve-clash',
};

const DEFAULT_GRANT = {
  id: 'g-none',
  pursuitId: null,          // scope: THIS pursuit only (never cross-pursuit)
  paths: ['/src'],          // repo path prefixes writes must fall under
  ops: ['cull', 'edit', 'resolve-clash'],
  classes: ['duplicate', 'reversible-local', 'factual-clash'],
  expiresAt: null,          // ISO string; null = no grant active
  policyVersion: 'v1',
  minClashConfidence: 0.85, // factual clash needs >= this AND an authoritative source
};

const DEFAULT_POLICY = {
  enabled: false,           // default OFF — the live pursuit flow is unchanged until opt-in
  autonomy: 'balanced',     // cautious | balanced | full
  paused: false,            // user paused directing (raw stops re-exposed; prior handling kept)
  grant: DEFAULT_GRANT,
};

// ---- small helpers -------------------------------------------------------------
function _norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }
function _riskOf(stop) {
  const a = stop && stop.action;
  return _norm((a && a.risk) || (stop && stop.risk) || '');
}
function _opOf(stop) {
  const a = stop && stop.action;
  return _norm(a && a.op);
}
function _targetOf(stop) {
  const a = stop && stop.action;
  return (a && (a.target || a.path)) || null;
}
// A write is "local" (reversible in-repo) when it is NOT a deliver/publish/external
// act. Real engine ops are free-form verb-noun slugs (e.g. "update-retry-tests",
// "add-force-deploy-bypass"), so we classify by a danger DENY-LIST rather than a
// positive allow-list: a write tagged risk:'write' whose op carries no external /
// irreversible signal is treated as a reversible in-repo edit. Over-escalation is the
// safe direction, and the grant's path scope is still enforced separately, so a stray
// external op mistagged risk:'write' is caught here and anything out-of-path is held.
// Unknown/missing ops stay NOT local so the director escalates rather than guessing.
function _isLocalWrite(stop) {
  const op = _opOf(stop);
  if (!op) return false;
  if (/deliver|publish|push|pr|pull|merge|comment|mail|send|post|external|deploy|release|ship|remote|destroy|spend|purchase|charge/.test(op)) return false;
  return true;
}
function _pathCovered(target, paths) {
  if (!target) return true;               // no path on the action → not path-scoped
  const t = String(target).replace(/\\/g, '/').toLowerCase();
  return (paths || []).some(p => {
    const pp = String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    return pp === '/' || pp === '' || t === pp || t.startsWith(pp + '/') || t.includes(pp + '/') || t.startsWith(pp);
  });
}
function _stopSig(stop) {
  return _opOf(stop) + '|' + _norm(_targetOf(stop)) + '|' + _norm(stop && stop.action && stop.action.summary);
}
function _conflictIndex(tree) {
  const idx = {};
  const push = (c) => { if (c && c.id) idx[c.id] = c; };
  const rs = tree && tree.rootState;
  if (rs && Array.isArray(rs.openConflicts)) rs.openConflicts.forEach(push);
  if (Array.isArray(tree && tree.conflicts)) tree.conflicts.forEach(push);
  return idx;
}
function _stanceOpposed(a, b) {
  a = _norm(a); b = _norm(b);
  return (a === 'affirm' && b === 'deny') || (a === 'deny' && b === 'affirm');
}
// A factual clash is director-RESOLVABLE only when there is clear, authoritative,
// high-confidence evidence — never by picking the stronger stated side (that is the
// engine fallback the director must NOT exploit).
function _clashEvidenceClear(conflict, grant) {
  if (!conflict) return false;
  const min = (grant && grant.minClashConfidence) || 0.85;
  const v = conflict.verdict;
  if (v && v.legId && typeof v.confidence === 'number' && v.confidence >= min && v.chosenBy !== 'user') return true;
  const ev = conflict.evidence || conflict.proof;
  if (ev && ev.authoritative === true && typeof ev.confidence === 'number' && ev.confidence >= min && ev.stance) return true;
  return false;
}

// ---- classification ------------------------------------------------------------
// Map a real engine stop onto one of the 8 policy classes.
function stopClass(stop, ctx) {
  ctx = ctx || {};
  const type = _norm(stop && stop.type);
  if (type === 'needs-info' || (stop && stop.goalAsk === true)) return 'missing-info';
  if (type === 'needs-decision') {
    const c = ctx.conflictById && stop.conflictId ? ctx.conflictById[stop.conflictId] : null;
    if (c && _stanceOpposed(c.a && c.a.stance, c.b && c.b.stance) && _clashEvidenceClear(c, ctx.grant)) return 'factual-clash';
    return 'judgement-clash';
  }
  if (type === 'needs-auth') {
    if (stop.delivery === true || _opOf(stop) === 'deliver') return 'deliverable';
    const risk = _riskOf(stop);
    if (risk === 'external' || risk === 'spend' || risk === 'destructive') return 'external-spend-destructive';
    if (ctx.duplicateStopIds && ctx.duplicateStopIds.has(stop.id)) return 'duplicate';
    if (risk === 'write' && _isLocalWrite(stop)) return 'reversible-local';
    return 'external-spend-destructive'; // unknown write shape → escalate, never guess
  }
  return 'judgement-clash';
}

// Does the active standing grant cover auto-handling this node's class?
function grantCovers(grant, stop, cls, ctx) {
  if (!grant) return false;
  if (grant.expiresAt) {
    const exp = Date.parse(grant.expiresAt);
    const now = (ctx && ctx.now) || Date.now();
    if (isFinite(exp) && exp < now) return false;
  } else {
    return false; // no expiry set → no active grant
  }
  // Scope to THIS pursuit only.
  if (grant.pursuitId && ctx && ctx.pursuitId && grant.pursuitId !== ctx.pursuitId) return false;
  const op = CLASS_GRANT_OP[cls];
  if (!op) return false;
  if (Array.isArray(grant.classes) && grant.classes.indexOf(cls) === -1) return false;
  if (Array.isArray(grant.ops) && grant.ops.indexOf(op) === -1) return false;
  // Path scoping for writes (reversible-local + duplicate writes).
  if (cls === 'reversible-local' || cls === 'duplicate') {
    if (!_pathCovered(_targetOf(stop), grant.paths)) return false;
  }
  return true;
}

// ---- reduction plan ------------------------------------------------------------
function _reasonFor(cls, disp) {
  switch (disp) {
    case 'cull': return 'Duplicate of an action already handled — redundant gate dropped.';
    case 'absorb': return 'Reversible local edit inside the granted path — applied, undoable.';
    case 'resolve': return 'Factual clash with authoritative high-confidence evidence — tie-broken by director.';
    case 'batch': return 'User-facing deliverable — folded into one approval for you.';
    case 'ask':
      if (cls === 'missing-info') return 'Missing information only you can supply.';
      if (cls === 'judgement-clash') return 'Judgement call — not a fact the director can verify.';
      if (cls === 'external-spend-destructive') return 'External / spend / destructive — always your call.';
      return 'Outside the current grant — kept on your desk.';
    default: return '';
  }
}

const _DESK_ORDER = { clash: 0, gap: 1, chain: 2, batch: 3 };

// Compact, distinct row titles. A clash prefers its conflict subject (e.g. "arm64-branch-bug");
// otherwise it pulls the quoted subject out of the prompt. A gap uses a short lead of the ask.
function _clip(str, n) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}
function _clashTitle(s) {
  if (s && s.subject) return _clip(s.subject, 52);
  const m = String((s && s.prompt) || '').match(/\bon\s+["“]([^"”]{1,60})["”]/i);
  if (m) return _clip(m[1], 52);
  return 'Judgement call';
}
function _gapTitle(s) {
  const p = String((s && s.prompt) || '').replace(/\s+/g, ' ').trim();
  if (!p) return 'Needs your input';
  const first = (p.split(/[?.]\s/)[0] || p);
  return _clip(first, 52);
}
function _slug(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

// Collapse the escalated stops into a handful of desk ITEMS (the whole point: turn a
// stream of stops into a few decisions). Deliverables → one batch; held writes → one
// chain; each judgement clash and each missing-info gap is its own item.
function _groupDesk(deskNodes) {
  const batchStops = deskNodes.filter(n => n.cls === 'deliverable');
  const clashStops = deskNodes.filter(n => n.cls === 'judgement-clash' || n.cls === 'factual-clash');
  const gapStops = deskNodes.filter(n => n.cls === 'missing-info');
  const writeStops = deskNodes.filter(n => n.cls === 'reversible-local' || n.cls === 'external-spend-destructive' || n.cls === 'duplicate');
  const items = [];
  if (batchStops.length) {
    items.push({ id: 'desk-batch', kind: 'batch', title: 'Deliverables ready to approve',
      count: batchStops.length, stopIds: batchStops.map(s => s.stopId),
      detail: batchStops.length + ' user-facing ' + (batchStops.length === 1 ? 'deliverable' : 'deliverables') + ' folded into one approval.' });
  }
  if (writeStops.length) {
    items.push({ id: 'desk-chain', kind: 'chain', title: 'Held writes to review',
      count: writeStops.length, stopIds: writeStops.map(s => s.stopId),
      detail: writeStops.length + ' write' + (writeStops.length === 1 ? '' : 's') + ' held for review (outside the grant or unverifiable).' });
  }
  // Judgement clashes on the SAME subject are ONE decision: several legs independently
  // reached opposing conclusions about the same thing. The user settles the subject once
  // and the Director resolves every leg on it the same way (by STANCE, since A/B position
  // can be flipped per conflict). Each grouped item carries `members` for stance-mapped
  // resolution and `promptFull` for the detail pane.
  const clashBySubject = new Map();
  clashStops.forEach((s, i) => {
    const key = (s.subject && String(s.subject).trim()) || ('_solo-' + (s.stopId || i));
    if (!clashBySubject.has(key)) clashBySubject.set(key, []);
    clashBySubject.get(key).push(s);
  });
  let ci = 0;
  for (const group of clashBySubject.values()) {
    const first = group[0];
    const n = group.length;
    const members = group.map(g => ({
      stopId: g.stopId, legId: g.legId || null, conflictId: g.conflictId || null,
      affirmSide: g.affirmSide || null, denySide: g.denySide || null,
    }));
    items.push({ id: 'desk-clash-' + (first.subject ? _slug(first.subject) : (first.stopId || ci)), kind: 'clash',
      title: _clashTitle(first), count: n, legCount: n, subject: first.subject || null,
      stopIds: group.map(g => g.stopId), legId: first.legId || null, members,
      detail: n > 1
        ? (n + ' legs reached opposite conclusions on this — settle it once and the Director closes all ' + n + '.')
        : 'Two legs reached opposite conclusions — not provable, so it stays your call.',
      promptFull: first.prompt || 'A clash only you can settle.' });
    ci++;
  }
  gapStops.forEach((s, i) => items.push({ id: 'desk-gap-' + (s.stopId || i), kind: 'gap',
    title: _gapTitle(s), count: 1, stopIds: [s.stopId], legId: s.legId,
    detail: 'The leg needs information only you can supply.',
    promptFull: s.prompt || 'Information the director cannot supply.' }));
  items.sort((a, b) => (_DESK_ORDER[a.kind] - _DESK_ORDER[b.kind]));
  return items;
}

// planReduction(tree, policy) → the reduced view. Pure. `handled` reconciles with
// `deskStops` to the total open-stop count exactly (no node lost or double-counted).
function planReduction(tree, policy) {
  policy = Object.assign({}, DEFAULT_POLICY, policy || {});
  const grant = Object.assign({}, DEFAULT_GRANT, policy.grant || {});
  const autonomy = AUTONOMY_LEVELS.indexOf(policy.autonomy) === -1 ? 'balanced' : policy.autonomy;
  const now = policy._now || Date.now();
  const offline = !!policy.offline;
  const paused = !!policy.paused;

  const openStops = ((tree && tree.stops) || []).filter(s => s && s.status === 'open');
  const conflictById = _conflictIndex(tree);

  // Duplicate detection: first occurrence of a write signature is canonical, later
  // identical signatures are duplicates the director can cull.
  const seen = new Map();
  const dup = new Set();
  for (const s of openStops) {
    if (_norm(s.type) !== 'needs-auth' || s.delivery === true) continue;
    if (_riskOf(s) !== 'write') continue;
    const sig = _stopSig(s);
    if (!sig.replace(/\|/g, '').trim()) continue;
    if (seen.has(sig)) dup.add(s.id); else seen.set(sig, s.id);
  }
  const ctx = { conflictById, duplicateStopIds: dup, grant, now, pursuitId: (tree && tree.id) || null };

  let unsure = 0;
  const per = openStops.map(s => {
    const cls = stopClass(s, ctx);
    let disp = (POLICY_MATRIX[cls] && POLICY_MATRIX[cls][autonomy]) || 'ask';
    // A factual clash only auto-resolves with clear evidence; otherwise the director
    // declines to guess and escalates it as a judgement call (director-unsure).
    if (disp === 'resolve') {
      const c = conflictById[s.conflictId];
      if (!_clashEvidenceClear(c, grant)) { disp = 'ask'; unsure++; }
    }
    // Handled dispositions require an active grant covering the class/path.
    if (HANDLED.has(disp) && !grantCovers(grant, s, cls, ctx)) disp = 'ask';
    // Paused / offline director never auto-applies: raw stops fall back to the desk.
    if ((paused || offline) && HANDLED.has(disp)) disp = 'ask';
    const _c = conflictById[s.conflictId];
    // Map affirm/deny stance → A/B side so grouped resolution picks the right side per
    // conflict even when the A/B positions are flipped between conflicts on one subject.
    let affirmSide = null, denySide = null;
    if (_c && _c.a && _c.b) {
      if (_c.a.stance === 'affirm' || _c.b.stance === 'deny') { affirmSide = 'a'; denySide = 'b'; }
      else if (_c.b.stance === 'affirm' || _c.a.stance === 'deny') { affirmSide = 'b'; denySide = 'a'; }
    }
    return {
      stopId: s.id, cls, disposition: disp, reason: _reasonFor(cls, disp),
      legId: s.legId || null, target: _targetOf(s), prompt: s.prompt || '',
      conflictId: s.conflictId || null, risk: _riskOf(s) || null,
      subject: (_c && _c.subject) || null, affirmSide, denySide,
    };
  });

  const handled = per.filter(p => HANDLED.has(p.disposition));
  const deskNodes = per.filter(p => !HANDLED.has(p.disposition));
  const deskItems = _groupDesk(deskNodes);

  const countDisp = d => per.filter(p => p.disposition === d).length;
  const reconciliation = {
    total: openStops.length,
    culled: countDisp('cull'),
    absorbed: countDisp('absorb'),
    resolved: countDisp('resolve'),
    batched: countDisp('batch'),
    asked: countDisp('ask'),
    handled: handled.length,
    deskStops: deskNodes.length,
  };
  // Invariant: every open stop is accounted for exactly once.
  reconciliation.reconciles = (reconciliation.handled + reconciliation.deskStops === reconciliation.total);

  let state = 'active';
  if (offline) state = 'offline';
  else if (!policy.enabled) state = 'offline';   // directing off → honest "not operating"
  else if (paused) state = 'paused';
  else if (deskItems.length === 0) state = 'nothing-needs-you';
  else if (unsure > 0 && handled.length === 0) state = 'unsure';

  return {
    autonomy, enabled: !!policy.enabled, grantId: grant.id, policyVersion: grant.policyVersion,
    total: openStops.length, handled, handledCount: handled.length,
    deskItems, deskCount: deskItems.length, unsure,
    reconciliation, state, per,
  };
}

// ---- ledger --------------------------------------------------------------------
// Execution state of a director action (§3): proposed → staged → applied →
// compensatable → irreversible (or logged for irreversible-after-the-fact).
const LEDGER_STATES = ['proposed', 'staged', 'applied', 'compensatable', 'irreversible', 'logged', 'undone'];

function ledgerEntry(o) {
  o = o || {};
  return {
    id: o.id || ('led-' + Math.random().toString(36).slice(2, 9)),
    at: o.at || new Date().toISOString(),
    verb: o.verb || 'escalated',        // culled|absorbed|resolved|batched|escalated|spawned|redirected|undone|failed
    stopId: o.stopId || null,
    legId: o.legId || null,
    conflictId: o.conflictId || null,
    cls: o.cls || null,
    why: o.why || '',
    policyVersion: o.policyVersion || null,
    grantId: o.grantId || null,
    by: 'director',                      // NEVER 'user' — the director never impersonates you
    state: LEDGER_STATES.indexOf(o.state) === -1 ? 'applied' : o.state,
    reversible: o.reversible !== false,  // reversible unless explicitly false
    undo: o.undo || null,                // {op, target} for a state-aware undo
    target: o.target || null,
  };
}

module.exports = {
  AUTONOMY_LEVELS, POLICY_MATRIX, HANDLED, CLASS_GRANT_OP,
  DEFAULT_GRANT, DEFAULT_POLICY, LEDGER_STATES,
  stopClass, grantCovers, planReduction, ledgerEntry,
  _internal: { _isLocalWrite, _pathCovered, _stopSig, _clashEvidenceClear },
};
