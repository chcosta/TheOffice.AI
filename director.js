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

// A checkable clash gets up to this many read-only arbitration attempts before it is
// escalated honestly to the human. The FIRST attempt fact-checks the disputed claim; if
// that attempt runs but settles nothing (a common failure: a single agent turn reasons
// poorly and punts), a SECOND, consensus-focused attempt runs — because the overwhelmingly
// likely reason an arbitration "couldn't settle" a clash is that the two sides actually
// AGREE and the standoff is a false binary (opposite affirm/deny labels on the same
// conclusion). Only after this many terminal attempts does the clash reach the desk. This
// fixes the bug where one inconclusive arbitration stranded the user with a coin-flip on two
// legs that plainly agreed. Bounded so it never loops forever.
const MAX_ARBITRATION_ATTEMPTS = 2;

// Map an AI verdict's recommended action → a director disposition. The reasoning pass
// speaks in verbs it understands ("absorb this reversible edit", "ask the user"); this
// is the only place that vocabulary crosses into the deterministic disposition set.
const _AI_ACTION_DISP = { cull: 'cull', absorb: 'absorb', resolve: 'resolve', batch: 'batch', ask: 'ask', escalate: 'ask', hold: 'ask', probe: 'probe' };

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
  paths: ['/'],             // repo path prefixes writes must fall under. Default = whole
                            // tree: the CLASS matrix + the target-external guard are the
                            // real safety gates; path is a user-narrowable SECONDARY guard.
                            // (A persisted grant overrides this, so existing narrow grants
                            //  stay narrow — only fresh grants inherit the broad default.)
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
// Even a write whose OP looks local can name an externally-observable TARGET — a
// pipeline/CI file that triggers a run, a branch/remote/PR, a specific commit, an
// infra .yml. Those are compensatable but NOT silently reversible, so they must stay
// on the desk regardless of how broad the path grant is. Deliberately does NOT match
// bare "deploy" (this domain edits a DeployQueues module in-repo — a normal reversible
// source edit that should absorb).
function _targetExternal(stop) {
  const t = _norm(_targetOf(stop)) + ' ' + _norm(stop && stop.prompt) + ' ' + _norm(stop && stop.action && stop.action.summary);
  return /azure-pipelines|\bpipelines?\b|\bbranch\b|\bremote\b|\borigin\b|pull request|\/pull\/|\bpr #|1es|hosted pool|\.ya?ml\b|\bcommit\s+[0-9a-f]{6,}/.test(t);
}
function _pathCovered(target, paths) {
  if (!target) return true;               // no path on the action → not path-scoped
  const t = String(target).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
  return (paths || []).some(p => {
    const pp = String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '').replace(/^\/+/, '');
    if (pp === '') return true;            // whole-tree grant ('/' or '')
    return t === pp || t.startsWith(pp + '/');
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

// Whether a clash is CHECKABLE — i.e. an arbitrator can settle it against a real source of
// truth (git history, `gh` PR/commit state, the working tree, the live work-item/PR content,
// tests) rather than it being a genuine matter of taste. This is AI-DRIVEN, not a regex.
// The default is FULLY flipped: a clash is checkable — and therefore ARBITRATED by a read-only
// probe — UNLESS the model EXPLICITLY marked it a genuine values call (checkable === false).
// Crucially that includes the NO-VERDICT case: an un-reasoned clash must still go to arbitration
// (which also detects when the two sides actually AGREE and culls the false binary, or verifies
// a provable fact like "does the item have this tag / link"), NOT land on the human's desk as a
// coin-flip. The old behaviour — punt un-arbitrated clashes to the human — was the exact bug the
// user kept hitting ("both sides agree, why is this my call?"; "an arbitration agent could have
// determined the tag exists"). Only an explicit values-call verdict keeps it on the desk.
function _clashCheckable(av) {
  return !av || av.checkable !== false;
}

// Human-readable recency note when two sides of a clash were observed at different times: a
// clash over the STATE of a mutable resource is usually a staleness artifact, so the arbitrator
// should prefer whichever side looked MORE RECENTLY. Returns '' when we can't tell.
function _recencyNote(conflict) {
  const ta = conflict && conflict.a && Date.parse(conflict.a.observedAt || '');
  const tb = conflict && conflict.b && Date.parse(conflict.b.observedAt || '');
  if (!ta || !tb || !isFinite(ta) || !isFinite(tb) || ta === tb) return '';
  const newer = ta > tb ? 'A' : 'B';
  const older = ta > tb ? 'B' : 'A';
  return 'RECENCY: Side ' + newer + ' observed the target more recently than Side ' + older
    + ' \u2014 if this is about the resource\u2019s current STATE, Side ' + newer
    + '\u2019s reading is likelier current and Side ' + older + '\u2019s may be stale; verify, prefer the newer, and say so.';
}

// Build the arbitration brief a forced probe carries: verify the disputed fact against
// the actual source of truth, report which side is real (or that both are wrong), so the
// losing leg is redirected and neither proceeds on a false premise — without the human.
// `opts.attempt` (1-based): on a RE-PROBE (attempt >= 2, a prior arbitration ran but did not
// settle it) the brief leads even harder with consensus-first + explicit MERGE instructions,
// because the overwhelmingly likely reason a clash "couldn't be settled" is that the two sides
// actually AGREE and the standoff is a false binary (opposite affirm/deny labels on one
// conclusion) — the exact bug the user hit (two legs at "90/90" both concluding the same thing).
function _arbitrationProbe(conflict, opts) {
  const attempt = (opts && Number(opts.attempt)) || 1;
  const reprobe = attempt >= 2;
  const subj = (conflict && conflict.subject) || 'this claim';
  const a = (conflict && conflict.a && conflict.a.claim) || '';
  const b = (conflict && conflict.b && conflict.b.claim) || '';
  const rec = _recencyNote(conflict);
  const question = reprobe
    ? ('A prior arbitration of "' + _clip(subj, 90) + '" did not settle it \u2014 do these two readings actually AGREE (and should therefore MERGE), or does one genuinely match reality'
      + (a && b ? (' \u2014 A: "' + _clip(a, 110) + '" vs B: "' + _clip(b, 110) + '"?') : '?'))
    : ('Do these two readings of "' + _clip(subj, 90) + '" actually agree, and if not which matches reality'
      + (a && b ? (' \u2014 A: "' + _clip(a, 110) + '" vs B: "' + _clip(b, 110) + '"?') : '?'));
  const consensusLead = reprobe
    ? ('A PRIOR arbitration already ran on this clash and failed to settle it. The single most likely reason is that the two sides actually AGREE \u2014 they were paired as a conflict only because their self-reported affirm/deny stance labels are opposite, not because their conclusions contradict. IGNORE the stance labels. Compare the two claims by MEANING: if they reach the SAME underlying conclusion, this is CONSENSUS \u2014 declare it, MERGE the two legs into ONE conclusion, and reconcile any incidental child-item discrepancies yourself (e.g. one side counted 8 items and the other 6 \u2014 reconcile the list so downstream child items are consistent). Do NOT hand the human a choice between two phrasings of the same answer.'
      + (a ? (' Side A claims: ' + _clip(a, 200) + '.') : '') + (b ? (' Side B claims: ' + _clip(b, 200) + '.') : ''))
    : ('FIRST check whether the two sides actually AGREE: if both reach the SAME underlying conclusion and differ only in wording, framing, or emphasis, this is CONSENSUS \u2014 report that they agree, state the one shared conclusion, MERGE them into a single result (reconciling any incidental child-item count/example discrepancies yourself), and STOP. Do not force a human choice between two phrasings of the same answer.'
      + (a ? (' Side A claims: ' + _clip(a, 160) + '.') : '') + (b ? (' Side B claims: ' + _clip(b, 160) + '.') : ''));
  const plan = [
    'ARBITRATE this clash against the real source of truth \u2014 do NOT trust either leg\'s assertion, and do NOT hand it to the human unless it is a genuine matter of taste with no factual answer.',
    consensusLead,
    (rec ? (rec + ' ') : '') + 'If they genuinely differ, verify it directly against the LIVE source of truth \u2014 not just the repo or git history: read the working tree and git history, check PR + commit state with `gh`, AND query the ACTUAL CURRENT content of the referenced work item / PR / issue (its tags, its links/relations to other items, its field values, its state) using the available tools. The existence or current value of a tag, a link between two items, a field, a file, a branch, or a PR is ALWAYS checkable \u2014 it is never a matter of opinion.',
    'Report the outcome with concrete evidence: whether the sides agree (and the single merged conclusion), or which side matches the ground truth (or that BOTH are wrong) \u2014 commit SHAs, PR merge status, branch tips, the item\'s actual tags / links / field values, timestamps.',
    'This settles the clash so the losing leg is redirected \u2014 or both legs MERGE on consensus \u2014 and neither proceeds on a false premise. The human is not the tie-breaker for a provable fact, nor for two legs that already agree.',
  ].join(' ');
  return { question, plan, attempt, consensus: reprobe };
}

// Two write stops COLLIDE when they would each mutate THE SAME resource — the same
// work-item field, the same file/path — even if their content differs. Approving more
// than one is contradictory (whichever lands last silently clobbers the rest), so a
// collision is NOT the human's tie-break: like a provable clash it is the Director's to
// arbitrate. This derives a CANONICAL collision key from a stop's target/prompt so
// differently-phrased references to one resource ("ADO Epic #10503 description" vs
// "work item #10503 description field") map to the same key. Returns null when the stop
// names no resource we can key on (so it never manufactures a phantom collision).
function _collisionKey(stop) {
  const raw = _norm(_targetOf(stop)) + ' ' + _norm(stop && stop.prompt) + ' ' + _norm(stop && stop.action && stop.action.summary);
  if (!raw.trim()) return null;
  // Strongest shared signal: a work-item / issue / PR id (ADO, GitHub). Pair it with the
  // sub-resource being written (description/title/state/…) so two edits to DIFFERENT fields
  // of the same item don't falsely collide.
  const idm = raw.match(/#?\b(\d{3,})\b/);
  if (idm) {
    const subm = raw.match(/\b(description|title|state|status|comment|body|field|tags?|assignee|priority|acceptance|repro|summary)\b/);
    const sub = subm ? subm[1].replace(/s$/, '') : '';
    return 'wi:' + idm[1] + (sub ? (':' + sub) : '');
  }
  // Otherwise key on the concrete file/path target (normalized separators).
  const t = _targetOf(stop);
  if (t) {
    const p = String(t).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '').trim();
    if (p) return 'path:' + p;
  }
  return null;
}

// Build the arbitration brief a same-target write COLLISION carries into a probe: 2+ writes
// that would each overwrite the same resource. The dispatched sub-agent must determine the
// single correct end state — pick the best write and drop the rest, MERGE them when the
// intents are complementary, or (if they turn out to be genuinely independent and do NOT
// actually clobber each other) release them — then redirect the losing/absorbed legs so
// exactly one coherent write lands. The human is never the tie-breaker for a mechanical
// collision.
function _collisionProbe(group, openStops) {
  const target = (group && group.target) || 'the same resource';
  const ids = (group && group.memberStopIds) || [];
  const legs = [];
  (openStops || []).forEach(s => {
    if (ids.indexOf(s.id) !== -1) {
      const when = s.observedAt || s.createdAt || s.at || s.updatedAt || null;
      legs.push({ legId: s.legId || null, prompt: _clip(s.prompt || '', 140), when, whenMs: when ? Date.parse(when) : NaN });
    }
  });
  const n = ids.length || legs.length;
  const question = n + ' writes all target ' + _clip(String(target), 90) + ' \u2014 which single result is correct, or should they merge?';
  const lines = legs.map((l, i) => '  ' + (i + 1) + '. ' + (l.legId ? ('[' + l.legId + '] ') : '') + (l.prompt || '(write)') + (l.when ? (' \u2014 decided ' + l.when) : ''));
  // Recency: if the candidates were decided at different times, the newest write most likely
  // reflects the current state of the target — the arbitrator should weigh it accordingly.
  const times = legs.map(l => l.whenMs).filter(t => isFinite(t));
  const hasRecency = times.length >= 2 && Math.max.apply(null, times) !== Math.min.apply(null, times);
  const plan = [
    'ARBITRATE a same-target write collision \u2014 do NOT ask the human and do NOT approve more than one blindly.',
    n + ' separate writes each mutate ' + _clip(String(target), 120) + '; applying more than one would silently clobber the others.' + (lines.length ? (' The candidates:\n' + lines.join('\n')) : ''),
    (hasRecency ? 'RECENCY: the candidates were decided at different times \u2014 a later write likely saw newer state, so treat the most recently-decided write as the likelier-current baseline (verify against the target\u2019s actual current state before trusting it). ' : '')
      + 'Read each leg\u2019s intended change and the current state of the target, then decide the SINGLE correct end state:',
    '(a) pick the best single write and DECLINE/redirect the rest; (b) MERGE them into one combined write when the intents are complementary; or (c) if they are genuinely independent and do NOT actually overwrite each other, say so and let each proceed.',
    'Redirect the losing/absorbed legs so exactly one coherent write lands, and report the chosen result with concrete reasoning so nothing is lost \u2014 the human is not the tie-breaker for a mechanical collision.',
  ].join(' ');
  return { question, plan };
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
    if (risk === 'write' && _isLocalWrite(stop) && !_targetExternal(stop)) return 'reversible-local';
    return 'external-spend-destructive'; // unknown write shape → escalate, never guess
  }
  return 'judgement-clash';
}

// Does the active standing grant cover auto-handling this node's class?
// A grant is "active" when it exists, is unexpired, and is scoped to THIS pursuit.
// This is the ONLY bar a side-effect-free cull must clear — a cull drops a redundant
// gate while the surviving twin still gates on its own class/path.
function _grantActive(grant, ctx) {
  if (!grant) return false;
  if (grant.expiresAt) {
    const exp = Date.parse(grant.expiresAt);
    const now = (ctx && ctx.now) || Date.now();
    if (isFinite(exp) && exp < now) return false;
  } else {
    return false; // no expiry set → no active grant
  }
  if (grant.pursuitId && ctx && ctx.pursuitId && grant.pursuitId !== ctx.pursuitId) return false;
  return true;
}

function grantCovers(grant, stop, cls, ctx) {
  if (!_grantActive(grant, ctx)) return false;
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

const _DESK_ORDER = { clash: 0, gap: 1, review: 2, chain: 3, batch: 4 };

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
function _pct(x) { return (typeof x === 'number' && isFinite(x)) ? Math.round(x * 100) : null; }

// Collapse the escalated stops into a handful of desk ITEMS (the whole point: turn a
// stream of stops into a few decisions). Deliverables → one batch; held writes → one
// chain; each judgement clash and each missing-info gap is its own item. Every item
// carries the RICH evidence the studio detail pane renders: the Director's own rationale
// (attributed commentary), the two sides of a clash with confidence, the individual held
// writes with their compensation, the batched deliverables with their authoring agent.
// Resolve the arbitration/probe sub-agent (if any) the Director dispatched for a set of
// stops. Prefers a LIVE agent (actively investigating) over a terminal one. Returns
// { legId, status, live, terminal } or null. Used to mark desk items "an arbitrator is on
// it / already looked" and to link a probe straight to its running agent.
function _spawnInfoFor(ctx, stopIds) {
  const map = ctx && ctx.spawnByStop;
  if (!map || !stopIds) return null;
  const rank = (o) => o ? (o.live ? 2 : (o.pending ? 1 : 0)) : -1;
  let best = null;
  for (const sid of stopIds) {
    if (!sid) continue;
    const info = map.get(sid);
    if (!info) continue;
    if (rank(info) > rank(best)) best = info;
  }
  return best;
}

function _groupDesk(deskNodes, ctx) {
  const batchStops = deskNodes.filter(n => n.cls === 'deliverable');
  const clashStops = deskNodes.filter(n => n.cls === 'judgement-clash' || n.cls === 'factual-clash');
  const gapStops = deskNodes.filter(n => n.cls === 'missing-info');
  const writeStops = deskNodes.filter(n => n.cls === 'reversible-local' || n.cls === 'external-spend-destructive' || n.cls === 'duplicate');
  const items = [];

  if (batchStops.length) {
    const writes = batchStops.map(s => ({
      stopId: s.stopId, title: _clip(s.prompt || 'Deliverable write', 80),
      agent: s.legId || null, target: s.target || null, risk: s.risk || 'write',
    }));
    items.push({
      id: 'desk-batch', kind: 'batch', title: 'Deliverables ready to approve',
      count: batchStops.length, stopIds: batchStops.map(s => s.stopId), writes,
      directorRationale: "These are the pursuit's deliverables — the reports and artifacts you'll actually read, not internal plumbing. Every write is reversible and local, and none share a target or depend on each other; publishing or sending is always a separate step that asks again. So I folded " + batchStops.length + ' separate approvals into this one.',
      detail: batchStops.length + ' user-facing ' + (batchStops.length === 1 ? 'deliverable' : 'deliverables') + ' folded into one approval.',
    });
  }

  if (writeStops.length) {
    const heldWrites = writeStops.map(s => {
      const external = s.cls === 'external-spend-destructive';
      const dup = s.cls === 'duplicate';
      return {
        stopId: s.stopId, title: _clip(s.prompt || 'Write', 90), target: s.target || null,
        agent: s.legId || null, risk: s.risk || 'write', cls: s.cls, external: (s.aiExternal != null ? s.aiExternal : external),
        confidencePct: _pct(s.aiConfidence),
        compensate: s.aiCompensate || (external
          ? 'externally observable — compensate/revert after review, not silently erasable'
          : (dup ? 'duplicate of an earlier write — safe to drop' : 'reversible in-repo edit — one-click undo')),
      };
    });
    const extN = heldWrites.filter(w => w.external).length;
    const locN = heldWrites.length - extN;
    const bits = [];
    if (extN) bits.push(extN + ' ' + (extN === 1 ? 'is' : 'are') + ' externally observable (running a pipeline, pushing, or modifying a pre-existing branch) — compensatable but not silently erasable, so I will not touch them without you');
    if (locN) bits.push(locN + ' fell outside the scope you granted me (or I could not verify), so I held ' + (locN === 1 ? 'it' : 'them') + ' rather than guess');
    const chainAiReasons = writeStops.map(w => w.aiReason).filter(Boolean);
    items.push({
      id: 'desk-chain', kind: 'chain', title: 'Held writes to review',
      count: writeStops.length, stopIds: writeStops.map(s => s.stopId), heldWrites,
      directorRationale: chainAiReasons.length
        ? ('I judged each of these ' + writeStops.length + ' writes on what it actually does, not its filename — ' + _clip(chainAiReasons[0], 200) + (bits.length ? (' Of the set, ' + bits.join('; ') + '.') : '') + ' Nothing has left the machine — approve the reversible ones together, or step through each.')
        : ('I prepared these ' + writeStops.length + ' writes but stopped short of applying them: ' + bits.join('; ') + '. Nothing has left the machine — approve the reversible ones together, or step through each.'),
      detail: writeStops.length + ' write' + (writeStops.length === 1 ? '' : 's') + ' held for review (outside the grant or unverifiable).',
    });
  }

  // Judgement clashes on the SAME subject are ONE decision: several legs independently
  // reached opposing conclusions about the same thing. The user settles the subject once
  // and the Director resolves every leg on it the same way (by STANCE, since A/B position
  // can be flipped per conflict). Each grouped item carries `members` for stance-mapped
  // resolution, plus the rich `sides` the detail pane renders.
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
    // Build the two sides from the representative conflict's stance-mapped evidence.
    const cs = first.clashSides;
    let sides = [], confidenceSplit = null, belowBar = true, aiSided = false;
    if (cs) {
      const aKey = first.affirmSide || (cs.a && cs.a.stance === 'affirm' ? 'a' : (cs.b && cs.b.stance === 'affirm' ? 'b' : 'a'));
      const bKey = first.denySide || (aKey === 'a' ? 'b' : 'a');
      const av = cs[aKey] || {}, bv = cs[bKey] || {};
      // Prefer the Director's OWN adjudication split — its confidence that each side is the
      // right call GIVEN the clash, summing to 100 (e.g. 75/25) — over each leg's self-reported
      // confidence (which is a leg's faith in its own work, not a verdict on the standoff).
      const aiSC = first.aiSideConfidence;
      aiSided = !!(aiSC && typeof aiSC[aKey] === 'number' && typeof aiSC[bKey] === 'number');
      const ap = aiSided ? aiSC[aKey] : _pct(av.confidence);
      const bp = aiSided ? aiSC[bKey] : _pct(bv.confidence);
      sides = [
        { key: 'affirm', label: 'Side A', claim: av.claim || '—', confidencePct: ap, legId: av.legId || null },
        { key: 'deny', label: 'Side B', claim: bv.claim || '—', confidencePct: bp, legId: bv.legId || null },
      ];
      if (ap != null && bp != null) confidenceSplit = ap + ' / ' + bp;
      belowBar = aiSided ? (Math.max(ap || 0, bp || 0) < 85) : (Math.max(av.confidence || 0, bv.confidence || 0) < 0.85);
    }
    const rationale = first.aiReason
      ? ((n > 1 ? (n + ' legs independently reached this same standoff. ') : '') + first.aiReason)
      : ((n > 1 ? (n + ' legs independently reached this same standoff. ') : '')
        + "I won't call this one — both sides are competent and neither is provable from the repo or history, so it's a genuine trade-off rather than a fact I can verify."
        + (confidenceSplit ? (' Confidence is split ' + confidenceSplit + (belowBar ? ', below my 85% bar,' : ',')) : ' Neither side clears my 85% confidence bar,')
        + ' with no authoritative source to corroborate either. A tie-break here would be me guessing with your name on it'
        + (n > 1 ? (', so it stays with you — settle it once and I close all ' + n + ' the same way.') : ', so it stays with you.'));
    // High-level framing shown ABOVE the two sides: what the decision is about + a neutral
    // head-to-head. Prefer the Director's AI summary; otherwise synthesize an honest one from
    // the subject and each side's claim so the block is always useful.
    const aiSum = first.aiClashSummary;
    const areaText = (aiSum && aiSum.area) || ('This decision is about ' + (first.subject || _clashTitle(first) || 'a contested finding') + '.');
    let compareText = (aiSum && aiSum.compare) || null;
    if (!compareText && sides.length === 2 && (sides[0].claim !== '—' || sides[1].claim !== '—')) {
      compareText = 'Side A holds that ' + sides[0].claim + ' Side B holds that ' + sides[1].claim
        + ' Both can\'t stand — pick the reading that matches your intent for the work.';
    }
    const summary = { area: areaText, compare: compareText, aiAuthored: !!(aiSum && (aiSum.area || aiSum.compare)) };
    items.push({
      id: 'desk-clash-' + (first.subject ? _slug(first.subject) : (first.stopId || ci)), kind: 'clash',
      title: _clashTitle(first), count: n, legCount: n, subject: first.subject || null,
      stopIds: group.map(g => g.stopId), legId: first.legId || null, members,
      nodeId: first.legId || null, target: first.target || null,
      sides, confidenceSplit, belowBar, aiSided, directorRationale: rationale, summary,
      aiUsed: !!first.aiReason,
      aiConfidencePct: (first.aiConfidence != null ? _pct(first.aiConfidence) : null),
      status: 'Open — awaiting your decision',
      detail: n > 1
        ? (n + ' legs reached opposite conclusions on this — settle it once and the Director closes all ' + n + '.')
        : 'Two legs reached opposite conclusions — not provable, so it stays your call.',
      promptFull: first.prompt || 'A clash only you can settle.',
    });
    ci++;
  }

  gapStops.forEach((s, i) => items.push({
    id: 'desk-gap-' + (s.stopId || i), kind: 'gap',
    title: _gapTitle(s), count: 1, stopIds: [s.stopId], legId: s.legId, nodeId: s.legId || null,
    directorRationale: s.aiReason || 'This leg hit a fact only you hold — something not in the repo, the history, or any source I can reach. I will not invent it or guess. Answer once and the leg picks up exactly where it paused; drafting a bounded sub-agent instead is also an option.',
    detail: 'The leg needs information only you can supply.',
    promptFull: s.prompt || 'Information the director cannot supply.',
  }));

  // Catch-all: any desk node NOT captured by a specific bucket above (e.g. a read-only step
  // the model flagged for a human OK when no grant was active, or an unrecognized class) MUST
  // still surface as a desk item. Otherwise it inflates `deskStops` while rendering nothing —
  // the header reads "N still need you" over an empty desk, the exact dishonesty the user
  // caught. Fold the remainder into one honest "review" item carrying each node's prompt + the
  // Director's reasoning, so the reduction count always reconciles with what's actually shown.
  const bucketed = new Set();
  [batchStops, writeStops, clashStops, gapStops].forEach(g => g.forEach(s => bucketed.add(s.stopId)));
  const otherStops = deskNodes.filter(n => !bucketed.has(n.stopId));
  if (otherStops.length) {
    const reviews = otherStops.map(s => ({
      stopId: s.stopId, title: _clip(s.prompt || s.target || 'Step to review', 90),
      agent: s.legId || null, target: s.target || null, cls: s.cls,
    }));
    const firstReason = otherStops.map(s => s.aiReason).filter(Boolean)[0];
    const n = otherStops.length;
    items.push({
      id: 'desk-review', kind: 'review',
      title: n === 1 ? 'A step to OK before it proceeds' : n + ' steps to OK before they proceed',
      count: n, legCount: n, stopIds: otherStops.map(s => s.stopId), reviews,
      legId: otherStops[0].legId || null, nodeId: otherStops[0].legId || null,
      target: otherStops[0].target || null,
      directorRationale: firstReason || "This step has no automatic disposition I can safely apply on its own, so I'm bringing it to you — approve it to let the leg proceed, or open the leg for the full context.",
      detail: n + ' step' + (n === 1 ? '' : 's') + ' the Director surfaced for your OK.',
      promptFull: otherStops[0].prompt || '',
    });
  }

  // Annotate each desk item with whether the Director has an arbitration/probe sub-agent on
  // it: LIVE means an arbitrator is actively checking it right now; TERMINAL means one already
  // ran (and, since the item is still on your desk, couldn't settle it — so it's honestly your
  // call). Carries the agent's legId so the desk can link straight to its chat/reasoning.
  if (ctx && ctx.spawnByStop) {
    for (const it of items) {
      const info = _spawnInfoFor(ctx, it.stopIds || (it.stopId ? [it.stopId] : []));
      if (!info) continue;
      it.arbitrating = !!info.live;
      it.arbitrated = !info.live;
      it.arbLegId = info.legId || null;
      it.arbStatus = info.status || null;
    }
  }

  items.sort((a, b) => (_DESK_ORDER[a.kind] - _DESK_ORDER[b.kind]));
  return items;
}

// §Probe — the Director's "investigate before I decide" bucket. A hard stop the model
// judged worth a bounded investigation (read code/history, run a check, draft an option)
// BEFORE it lands on the human's desk. These are OFF the desk (they don't count as "need
// you") and NOT handled — a third state. Each item carries the AI's question + plan so the
// UI can show what's being looked into and dispatch a real sub-agent to close it (D2).
function _groupProbes(probeNodes, ctx) {
  // Collapse same-collision probe stops into ONE item so a SINGLE arbitrator resolves the
  // whole collision (not one agent per colliding write — that would reproduce the conflicting-
  // conclusions problem). A collision probe carries a collisionKey; clash/other probes have
  // none and stay 1:1. Insertion order is preserved.
  const groups = [];
  const byKey = new Map();
  for (const s of probeNodes) {
    const k = s.collisionKey || null;
    if (k) {
      let g = byKey.get(k);
      if (!g) { g = { collision: true, key: k, members: [] }; byKey.set(k, g); groups.push(g); }
      g.members.push(s);
    } else {
      groups.push({ collision: false, key: null, members: [s] });
    }
  }
  return groups.map((g, gi) => {
    const s = g.members[0];
    const stopIds = g.members.map(m => m.stopId);
    const collision = g.collision && g.members.length > 1;
    const p = s.aiProbe || {};
    const question = (p.question && String(p.question).trim())
      || (collision ? (g.members.length + ' writes target ' + (s.collisionTarget || 'the same resource') + ' — which single result is correct, or should they merge?')
        : (s.subject ? ('What is the right call on ' + s.subject + '?') : 'What is the right call here?'));
    const plan = (p.plan && String(p.plan).trim()) || 'Investigate the repo, history and both sides, then report back so this can resolve without your input.';
    // Has the Director actually DISPATCHED a sub-agent for this yet? A probe is only truly
    // "investigating" once a live spawn leg points at any of its stops; before that it is queued
    // and the surface should say so (and offer Dispatch) rather than claim work is underway.
    const spawn = _spawnInfoFor(ctx, stopIds);
    const dispatched = !!(spawn && spawn.live);
    const investigated = !!(spawn && spawn.terminal);
    // A spawn stuck at 'planned' is queued, not running — say so honestly (and the panel keeps
    // offering Dispatch) instead of claiming a sub-agent is investigating. The stuck-watchdog
    // re-drives it, so this "Queued" state is transient once recovery kicks in.
    const pending = !!(spawn && spawn.pending);
    const status = dispatched
      ? 'Investigating — sub-agent running'
      : (investigated ? 'Investigation ran — reconciling the finding'
        : (pending ? 'Queued — dispatch pending (recovering)' : 'Queued — not yet dispatched'));
    const title = collision
      ? ((s.collisionTarget ? (g.members.length + ' writes collide on ' + _clip(String(s.collisionTarget), 60)) : (g.members.length + ' writes target the same resource')))
      : (_clashTitle(s) || _gapTitle(s) || (s.subject || 'A decision worth investigating'));
    return {
      id: 'probe-' + (collision ? ('col-' + _slug(g.key)) : (s.stopId || gi)), kind: 'probe',
      collision, collisionCount: collision ? g.members.length : 0,
      title,
      stopIds, stopId: s.stopId, legId: s.legId || null, nodeId: s.legId || null,
      subject: s.subject || null, target: s.target || s.collisionTarget || null,
      question, plan,
      // Dispatch/agent provenance so the panel can drop the "Dispatch" button once an agent is
      // running and link straight into that agent's node (chat, thinking, tool calls).
      dispatched, investigated, pending,
      spawnLegId: spawn ? spawn.legId : null, spawnStatus: spawn ? spawn.status : null,
      directorRationale: s.aiReason || (collision
        ? ("Two or more held writes would overwrite the same target. I won't ask you to pick between duplicates — I'm having a sub-agent settle the collision (keep the best, merge, or confirm they're independent) and redirect the rest.")
        : ("This is a hard call, but I don't think it's yours yet — a bounded investigation should resolve or sharpen it first. I'll look into it and only bring it to you if it's a genuine judgement call after.")),
      status,
      promptFull: s.prompt || '',
    };
  });
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
  const aiVerdicts = (policy.aiVerdicts && typeof policy.aiVerdicts === 'object') ? policy.aiVerdicts : null;

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
  // Same-target COLLISION detection: 2+ open write stops that would each mutate the SAME
  // resource (same work-item field, same file/path) — even with different content — collide.
  // Approving more than one silently clobbers the rest, so (like a provable clash) the
  // Director arbitrates it rather than handing the human a "pick one". Exact duplicates are
  // excluded (the cull pass already retires them, leaving one canonical write); a collision
  // is specifically DIFFERENT writes racing for one target. Groups with 2+ surviving members
  // become the arbitration set the gate below force-routes to a single probe.
  const collisionByStop = new Map();
  {
    const byKey = new Map();
    for (const s of openStops) {
      if (_norm(s.type) !== 'needs-auth' || s.delivery === true) continue;
      if (_riskOf(s) !== 'write') continue;
      if (dup.has(s.id)) continue; // an exact-dup is culled, not a collision
      // AI-FIRST collision key: the reasoning pass judges a write's canonical target by MEANING
      // (a work-item field / a path), not wording, and emits it as av.writeTarget. Prefer that;
      // fall back to the deterministic _collisionKey only when the model hasn't keyed this write
      // (mirrors the AI-first cls / deterministic-fallback pattern used everywhere else here).
      const av = aiVerdicts ? aiVerdicts[s.id] : null;
      const k = (av && typeof av.writeTarget === 'string' && av.writeTarget.trim()) ? av.writeTarget.trim() : _collisionKey(s);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
    }
    for (const [k, arr] of byKey) {
      if (arr.length < 2) continue;
      const memberStopIds = arr.map(s => s.id);
      const target = _targetOf(arr[0]) || null;
      for (const s of arr) collisionByStop.set(s.id, { key: k, target, memberStopIds });
    }
  }
  ctx.collisionByStop = collisionByStop;
  // Stops that ALREADY had an arbitration/probe sub-agent run to completion — a
  // director-spawned leg pointing back at the stop (fromStopId) that has reached a
  // terminal state. The arbitration gate below caps itself to ONE attempt per stop
  // using this set, so a clash a probe genuinely could not settle still escalates to
  // the human instead of re-arbitrating forever.
  const arbitratedStopIds = new Set();
  // How MANY terminal arbitration/probe sub-agents have run for each stop. A checkable clash
  // gets up to MAX_ARBITRATION_ATTEMPTS attempts (the gate below), so a FIRST inconclusive
  // arbitration earns a second, consensus-focused pass rather than immediately stranding the
  // human — the failure mode the user hit (two agreeing legs punted as "your call, 90/90").
  const arbitrationAttempts = new Map();
  // spawnByStop: fromStopId → { legId, status, terminal, live } for the arbitration/probe
  // sub-agent the Director dispatched against that stop. A LIVE (in-flight) spawn means an
  // agent is actively investigating it right now; a TERMINAL one means the investigation
  // already ran. The UI reads this to (a) stop offering "Dispatch" once an agent is running,
  // (b) mark a desk item that has an arbitrator on it, and (c) link straight to the agent.
  const spawnByStop = new Map();
  {
    const legsAll = (tree && tree.legs) || {};
    for (const lid of Object.keys(legsAll)) {
      const lg = legsAll[lid];
      if (!lg || !lg.directorSpawn || !lg.fromStopId) continue;
      const st = _norm(lg.status);
      const terminal = ['done', 'error', 'invalidated', 'cancelled'].indexOf(st) !== -1;
      // 'planned' is NOT live — the spawn was minted but the sub-agent never entered its run
      // (the dispatch wave was dropped by a restart, or it was created on a non-leader). It is
      // PENDING (queued), not investigating. Marking it live would make the desk claim "sub-agent
      // running" for a leg stuck at planned and hide the Dispatch button, stranding the user. Only
      // an actually-started (non-terminal, non-planned) leg is live/investigating.
      const pending = st === 'planned';
      const live = !terminal && !pending;
      if (terminal) { arbitratedStopIds.add(lg.fromStopId); arbitrationAttempts.set(lg.fromStopId, (arbitrationAttempts.get(lg.fromStopId) || 0) + 1); }
      // A live spawn beats a pending one beats a terminal one for the same stop (a re-dispatch).
      const prev = spawnByStop.get(lg.fromStopId);
      const rank = (o) => o ? (o.live ? 2 : (o.pending ? 1 : 0)) : -1;
      const cur = { legId: lg.id, status: st, terminal, live, pending };
      if (rank(cur) > rank(prev)) spawnByStop.set(lg.fromStopId, cur);
    }
  }
  ctx.arbitratedStopIds = arbitratedStopIds;
  ctx.arbitrationAttempts = arbitrationAttempts;
  ctx.spawnByStop = spawnByStop;

  let unsure = 0;
  const per = openStops.map(s => {
    // Classification is AI-first. When the reasoning pass has judged this stop we trust its
    // verb-based verdict — editing/creating a file (even azure-pipelines.yml or a *.cs) is a
    // reversible local edit; *running* a pipeline, pushing, or modifying a pre-existing branch
    // is externally observable and stays with the user. We fall back to the deterministic
    // classifier only when the model has not (yet) weighed in. The rails below apply regardless.
    const av = aiVerdicts ? aiVerdicts[s.id] : null;
    // The bounded investigation this stop carries into a probe (the AI's own probe plan, if
    // it supplied one). The arbitration gate below may SYNTHESIZE one for a provable clash the
    // model tried to punt to the human without proposing a probe. Read into the return below.
    let aiProbe = (av && av.probe && typeof av.probe === 'object' && (av.probe.question || av.probe.plan)) ? av.probe : null;
    let cls = (av && av.cls && POLICY_MATRIX[av.cls]) ? av.cls : stopClass(s, ctx);
    let disp = (POLICY_MATRIX[cls] && POLICY_MATRIX[cls][autonomy]) || 'ask';
    if (av && av.action) {
      const rec = _AI_ACTION_DISP[String(av.action).toLowerCase()];
      if (rec) disp = rec;
    }
    // Rail (C1): a deliverable is ALWAYS batched to the desk, never silently absorbed —
    // even if the model over-reaches and recommends absorbing it.
    if (cls === 'deliverable' && HANDLED.has(disp)) disp = 'batch';
    // Rail: a READ-ONLY action changes nothing. Reading data (a fetch, a lookup, a query)
    // has no side effect to review, revert, or approve — reads never gate (the doctrine).
    // Even when the model recommends "ask", PROCEEDING with a read is always safe, so like a
    // cull it is side-effect-free: it auto-absorbs under an ACTIVE grant for this pursuit (no
    // path/op coverage needed). With no active grant — or if the model flags it external, or
    // the Director is paused/offline (rails below) — it falls to the desk honestly instead of
    // being silently allowed. Gated on cls==='read-only', which only arises from an AI verdict,
    // so the deterministic-fallback fixture (whose classifier never returns read-only) is
    // unaffected.
    if (cls === 'read-only' && (!av || av.external !== true)) {
      disp = _grantActive(grant, ctx) ? 'absorb' : 'ask';
    }
    // A factual clash only auto-resolves when the judge is confident. With an AI verdict the
    // model's confidence IS the evidence bar (it reasoned over both sides); without one we fall
    // back to the deterministic evidence check. Otherwise it stays a human judgement call.
    if (disp === 'resolve') {
      const conf = (av && typeof av.confidence === 'number') ? av.confidence : null;
      const clearAI = conf != null ? (conf >= 0.66) : null;
      const clearDet = _clashEvidenceClear(conflictById[s.conflictId], grant);
      if (!(clearAI === null ? clearDet : clearAI)) { disp = 'ask'; unsure++; }
    }
    // Rail: an externally-observable action (per the model's verb judgement) is the user's
    // call — EXCEPT a pure cull, which performs nothing (it only drops a redundant gate; the
    // surviving twin still gates on its own merits).
    if (av && av.external === true && HANDLED.has(disp) && disp !== 'cull') disp = 'ask';
    // Rail: absorb/resolve require an active grant COVERING the class/path. A cull is
    // side-effect-free, so it needs only an active grant for this pursuit — not path/op
    // coverage — otherwise redundant gates outside the granted path pile up needlessly.
    if (disp === 'cull') {
      // A pure cull performs NOTHING observable — it only drops a redundant/informational gate
      // while the surviving twin still gates on its own merits. Because it has no side effect to
      // review, revert, or approve, an ENABLED Director may retire it with no standing grant at
      // all (paused/offline still holds it below). Requiring a write-grant here just manufactured
      // desk noise: every duplicate degraded to an 'ask' and was mis-filed as a "held write" the
      // user was asked to approve/decline despite the model itself saying "no action needed".
      /* no grant required — side-effect-free */
    } else if (cls === 'read-only' && HANDLED.has(disp)) {
      // A read changes nothing either, but the Director still holds an ACTIVE grant for this
      // pursuit before it silently absorbs a read-only gate — NOT path/op coverage — so it does
      // not fall through to the generic grantCovers check below (which would wrongly hold it).
      if (!_grantActive(grant, ctx)) disp = 'ask';
    } else if (cls === 'reversible-local' && av && av.external === false && HANDLED.has(disp)) {
      // A reversible-local edit the model judged non-external is undoable from the ledger — it
      // never touches a remote, runs a pipeline, or alters an already-pushed branch. So (like a
      // cull) it needs only an ACTIVE grant that ALLOWS this class+op, NOT path coverage: a safe
      // local edit shouldn't demand a click merely for landing outside the granted path. This is
      // the difference the user cares about — remote/observable vs. reversible-local — made real.
      const op = CLASS_GRANT_OP[cls];
      const allowed = _grantActive(grant, ctx)
        && (!Array.isArray(grant.classes) || grant.classes.indexOf(cls) !== -1)
        && (!Array.isArray(grant.ops) || grant.ops.indexOf(op) !== -1);
      if (!allowed) disp = 'ask';
    } else if (HANDLED.has(disp) && !grantCovers(grant, s, cls, ctx)) { disp = 'ask'; }
    // Rail: a low-confidence verdict never auto-applies — the director declines to guess.
    if (HANDLED.has(disp) && av && typeof av.confidence === 'number' && av.confidence < 0.5) { disp = 'ask'; unsure++; }
    // ── ARBITRATION GATE — a CHECKABLE clash is never the human's tie-break ─────────
    // The user's complaint: legs "keep reaching conflicting conclusions, but they are
    // for provable things" (is PR #x merged, what is main's HEAD, what does the epic say
    // NOW) and the Director punts it as "YOUR CALL" ("neither is provable from the repo") —
    // dragging the human in as a coin-flip for a fact. Checkability is now AI-DRIVEN, not a
    // brittle regex: the reasoning pass reads the full clash and marks it checkable. We FLIP
    // the default — a clash heading to the desk (disp==='ask'), not yet arbitrated, is
    // force-routed to a PROBE unless the model EXPLICITLY marked it a genuine values call
    // (av.checkable === false). NO GRANT is required to dispatch: the arbitrator is a
    // READ-ONLY investigation (verify the disputed facts, preferring the more recently-observed
    // side per the recency note) that reports which side is real and redirects the loser — a
    // fact-check + internal cull, not an external write. A grant only ever gates APPLYING a
    // write result downstream. Bounded to MAX_ARBITRATION_ATTEMPTS attempts per stop
    // (arbitrationAttempts): the FIRST attempt fact-checks; if it ran but settled nothing, a
    // SECOND, consensus-focused attempt runs (the likeliest reason an arbitration "couldn't
    // settle" a clash is that the two sides actually AGREE — a false binary from opposite
    // affirm/deny labels on the same conclusion). Only after the attempts are exhausted does a
    // clash escalate honestly to the human. Paused/offline overrides.
    if (disp === 'ask' && (cls === 'judgement-clash' || cls === 'factual-clash')
      && s.conflictId && (ctx.arbitrationAttempts.get(s.id) || 0) < MAX_ARBITRATION_ATTEMPTS
      && _clashCheckable(av)) {
      disp = 'probe';
      const priorAttempts = ctx.arbitrationAttempts.get(s.id) || 0;
      // A re-probe (a prior arbitration already ran and did not settle it) gets a sharper,
      // consensus-FIRST brief: scrutinize whether the two sides agree, and if so MERGE them into
      // one conclusion + reconcile any incidental child-item discrepancies (counts, examples)
      // rather than hand the human a coin-flip.
      if (!aiProbe || priorAttempts > 0) aiProbe = _arbitrationProbe(conflictById[s.conflictId], { attempt: priorAttempts + 1 });
    }
    // ── COLLISION ARBITRATION GATE — two writes to the SAME target are never your pick ──
    // The user's complaint: the Director asked to approve two different held writes that
    // "do the same thing" (both overwrite ADO work-item #10503's description). Approving
    // more than one silently clobbers the rest, so it is contradictory to hand the human N
    // independent approve/decline rows. Like a provable clash, a mechanical collision is the
    // Director's to arbitrate: when this write is heading to the desk (disp==='ask') and it
    // shares a target with another held write, and no probe has run for it yet — force a PROBE.
    // NO GRANT is required to dispatch: the sweep spins ONE read-only sub-agent (collision
    // probes collapse by key in _groupProbes) that only DECIDES the single correct end state —
    // pick the best, merge, or release if truly independent — and redirects the losing legs.
    // It does NOT itself land the surviving write; that write re-enters normal gating, where a
    // grant (absorb) or your approval actually APPLIES it. So the human is out of the tie-break,
    // but authority to write is preserved. Capped to one attempt per group; paused/offline overrides.
    if (disp === 'ask' && (cls === 'reversible-local' || cls === 'external-spend-destructive' || cls === 'duplicate')
      && ctx.collisionByStop && ctx.collisionByStop.has(s.id)) {
      const grp = ctx.collisionByStop.get(s.id);
      // Cap arbitration to ONE attempt per COLLISION GROUP (not per member): once any member's
      // arbitrator has run to a terminal state, a collision it couldn't settle escalates the
      // whole group honestly to the desk instead of re-probing each colliding write in turn.
      const anyArbitrated = grp.memberStopIds.some(id => ctx.arbitratedStopIds.has(id));
      if (!anyArbitrated) {
        disp = 'probe';
        if (!aiProbe) aiProbe = _collisionProbe(grp, openStops);
      }
    }
    // Paused / offline director never auto-applies: raw stops fall back to the desk. A probe
    // is a plan to DISPATCH a sub-agent, so a paused/offline Director can't run it either —
    // it becomes an honest desk item rather than a promise it can't keep.
    if ((paused || offline) && HANDLED.has(disp)) disp = 'ask';
    if ((paused || offline) && disp === 'probe') disp = 'ask';
    // A DISABLED Director dispatches nothing — a probe is a plan to spin a sub-agent, which an
    // off Director can't honor. So a clash/collision that would arbitrate falls back to an honest
    // desk ask. This keeps the default-OFF contract: the live pursuit flow is unchanged until the
    // user opts in (a clash stays "your call", not a promise to investigate we won't keep).
    if (!policy.enabled && disp === 'probe') disp = 'ask';
    const _c = conflictById[s.conflictId];
    // Map affirm/deny stance → A/B side so grouped resolution picks the right side per
    // conflict even when the A/B positions are flipped between conflicts on one subject.
    let affirmSide = null, denySide = null;
    if (_c && _c.a && _c.b) {
      if (_c.a.stance === 'affirm' || _c.b.stance === 'deny') { affirmSide = 'a'; denySide = 'b'; }
      else if (_c.b.stance === 'affirm' || _c.a.stance === 'deny') { affirmSide = 'b'; denySide = 'a'; }
    }
    // Carry the full two-sided evidence forward so the desk clash pane can show each
    // side's claim, stance and confidence without re-reading the tree.
    const _sideOf = v => v ? {
      stance: v.stance || null, claim: v.claim || '',
      confidence: (typeof v.confidence === 'number') ? v.confidence : null,
      legId: v.legId || null,
    } : null;
    const clashSides = (_c && (_c.a || _c.b)) ? { a: _sideOf(_c.a), b: _sideOf(_c.b) } : null;
    return {
      stopId: s.id, cls, disposition: disp, reason: (av && av.reasoning) || _reasonFor(cls, disp),
      legId: s.legId || null, target: _targetOf(s), prompt: s.prompt || '',
      conflictId: s.conflictId || null, risk: _riskOf(s) || null,
      subject: (av && av.group) || (_c && _c.subject) || null, affirmSide, denySide, clashSides,
      // Same-target collision membership — set when this write races another held write for one
      // resource. Carried so collision probes collapse to ONE arbitrator in _groupProbes (rather
      // than one agent per colliding write, which would reproduce the very conflict we're fixing).
      collisionKey: (ctx.collisionByStop && ctx.collisionByStop.has(s.id)) ? ctx.collisionByStop.get(s.id).key : null,
      collisionTarget: (ctx.collisionByStop && ctx.collisionByStop.has(s.id)) ? (ctx.collisionByStop.get(s.id).target || null) : null,
      collisionCount: (ctx.collisionByStop && ctx.collisionByStop.has(s.id)) ? ctx.collisionByStop.get(s.id).memberStopIds.length : 0,
      // AI provenance — carried through so the desk panes render the model's real judgement
      // (commentary, confidence, reversibility note, semantic grouping) instead of templates.
      aiUsed: !!av,
      aiReason: (av && av.reasoning) || null,
      aiConfidence: (av && typeof av.confidence === 'number') ? av.confidence : null,
      aiCompensate: (av && av.compensation) || null,
      aiGroup: (av && av.group) || null,
      aiExternal: av ? (av.external === true) : null,
      // The Director's adjudication split for a clash — confidence each side is right GIVEN
      // the standoff, summing to 100 (e.g. 75/25). Distinct from a leg's self-confidence.
      aiSideConfidence: (av && av.sideConfidence && typeof av.sideConfidence === 'object'
        && typeof av.sideConfidence.a === 'number' && typeof av.sideConfidence.b === 'number') ? av.sideConfidence : null,
      // The Director's high-level framing of a clash — what the decision is about (area) and a
      // neutral head-to-head of the two options (compare). Surfaced above the two sides so the
      // human understands the terrain before choosing.
      aiClashSummary: (av && av.clashSummary && typeof av.clashSummary === 'object'
        && (av.clashSummary.area || av.clashSummary.compare)) ? {
          area: av.clashSummary.area || null, compare: av.clashSummary.compare || null,
        } : null,
      // A bounded investigation the Director wants to run before deciding (probe disposition).
      // May be the AI's own probe plan, or the arbitration brief the gate synthesized for a
      // provable clash the model tried to hand to the human without proposing one.
      aiProbe: aiProbe,
    };
  });

  const handled = per.filter(p => HANDLED.has(p.disposition));
  // A probe is a THIRD bucket: not handled (nothing was absorbed) and NOT on the desk (the
  // whole point — the Director takes it off your desk to investigate first). Desk excludes it.
  const probeNodes = per.filter(p => p.disposition === 'probe');
  const deskNodes = per.filter(p => !HANDLED.has(p.disposition) && p.disposition !== 'probe');
  const deskItems = _groupDesk(deskNodes, ctx);
  const probeItems = _groupProbes(probeNodes, ctx);

  // AI coverage of the CURRENT open set. `aiActive` merely means some verdicts exist (possibly
  // stale from an earlier open set); `aiComplete` means every open stop has been judged by the
  // model, so what the desk shows is the AI's verdict — not the deterministic fallback. When a
  // stop lacks a verdict (new work parked since the last pass, or the pass never ran) we are
  // `aiPending`: the surface should say "judging…" rather than present fallback counts as final.
  const aiJudgedCount = per.filter(p => p.aiUsed).length;
  const aiComplete = !!aiVerdicts && openStops.length > 0 && aiJudgedCount === openStops.length;
  const aiPending = !!policy.enabled && openStops.length > 0 && !aiComplete;

  const countDisp = d => per.filter(p => p.disposition === d).length;
  const reconciliation = {
    total: openStops.length,
    culled: countDisp('cull'),
    absorbed: countDisp('absorb'),
    resolved: countDisp('resolve'),
    batched: countDisp('batch'),
    asked: countDisp('ask'),
    handled: handled.length,
    probing: probeNodes.length,
    deskStops: deskNodes.length,
  };
  // Invariant: every open stop is accounted for exactly once (handled + probing + desk = total).
  reconciliation.reconciles = (reconciliation.handled + reconciliation.probing + reconciliation.deskStops === reconciliation.total);

  let state = 'active';
  if (offline) state = 'offline';
  else if (!policy.enabled) state = 'offline';   // directing off → honest "not operating"
  else if (paused) state = 'paused';
  else if (deskItems.length === 0) state = 'nothing-needs-you';
  else if (unsure > 0 && handled.length === 0) state = 'unsure';

  // ---- diagnosis: WHY did so little (or nothing) get handled automatically? ------
  // Answers the user's "how did a complex pursuit get zero automated handling / zero
  // redundant paths?" honestly, in-product, instead of leaving a bare N→M reduction
  // with no cause. Every desk stop is bucketed by the REASON it stayed on your desk,
  // and a plain-language headline explains a zero-handled outcome.
  const _SAFE_CLASSES = new Set(['duplicate', 'reversible-local', 'factual-clash']);
  const deskWhy = { external: 0, judgement: 0, missingInfo: 0, heldForGrant: 0, lowConfidence: 0, pausedOffline: 0, deliverable: 0, other: 0 };
  for (const p of per) {
    if (HANDLED.has(p.disposition) || p.disposition === 'probe') continue; // only desk stops
    if (p.cls === 'deliverable') { deskWhy.deliverable++; continue; }
    if (paused || offline) { deskWhy.pausedOffline++; continue; }
    if (p.aiExternal === true || p.cls === 'external-spend-destructive') { deskWhy.external++; continue; }
    if (p.cls === 'judgement-clash') { deskWhy.judgement++; continue; }
    if (p.cls === 'missing-info') { deskWhy.missingInfo++; continue; }
    if (typeof p.aiConfidence === 'number' && p.aiConfidence < 0.5) { deskWhy.lowConfidence++; continue; }
    if (_SAFE_CLASSES.has(p.cls)) { deskWhy.heldForGrant++; continue; } // safe class but held for grant/path scope
    deskWhy.other++;
  }
  let whyZero = null;
  if (handled.length === 0 && openStops.length > 0) {
    if (!policy.enabled) whyZero = 'Automated handling is off. Turn the Director on and grant it scope on this pursuit so it can absorb safe, reversible stops for you.';
    else if (offline) whyZero = 'The Director is offline or stale on this machine, so nothing is auto-applied — you are seeing the raw stops.';
    else if (paused) whyZero = 'The Director is paused, so nothing is auto-applied. Resume it to let it absorb safe stops.';
    else if (aiPending) whyZero = 'The Director has not finished judging this pursuit yet. Automated handling appears once its reasoning pass completes.';
    else if (deskWhy.heldForGrant > 0) whyZero = deskWhy.heldForGrant + ' safe, reversible edit(s) were held only because they fall outside your granted paths — widen the grant to let the Director absorb them.';
    else whyZero = 'Every open stop is a genuine external action, judgement call, or missing-info ask — none was safely absorbable, so nothing was auto-handled. For a pursuit that made no redundant or reversible-local moves, zero handling is the honest, correct outcome.';
  }
  // Redundant-path accounting: exact-duplicate write gates (deterministic) + cross-leg
  // redundancies/merges the reasoning pass surfaced. Zero is explained rather than implied.
  const _ins = (policy.aiInsights && typeof policy.aiInsights === 'object') ? policy.aiInsights : null;
  const redundancyCount = dup.size
    + ((_ins && Array.isArray(_ins.redundancies)) ? _ins.redundancies.length : 0)
    + ((_ins && Array.isArray(_ins.merges)) ? _ins.merges.length : 0);
  let redundancyNote = null;
  if (redundancyCount === 0) {
    if (!policy.enabled || !aiVerdicts) redundancyNote = 'Cross-leg redundant-path detection is part of the Director\u2019s reasoning pass. With the Director off — or not yet run on this machine — only exact-duplicate write gates are checked, so redundancy reads as zero. Turn the Director on to have it look for redundant and mergeable paths.';
    else redundancyNote = 'The Director analysed the legs and found no redundant or mergeable paths — each leg pursued a distinct angle.';
  }
  const diagnosis = { whyZero, deskWhy, duplicatesFound: dup.size, redundancyCount, redundancyNote };

  return {
    autonomy, enabled: !!policy.enabled, grantId: grant.id, policyVersion: grant.policyVersion,
    total: openStops.length, handled, handledCount: handled.length,
    deskItems, deskCount: deskItems.length, unsure,
    probeItems, probeCount: probeItems.length,
    reconciliation, state, per,
    // Cross-node intelligence from the reasoning pass (redundancies / opportunities / merges /
    // new goals). Null when the model has not run — the deterministic funnel is fully usable
    // without it, insights are additive judgement on top.
    aiActive: !!aiVerdicts,
    aiJudgedCount, aiComplete, aiPending,
    insights: (policy.aiInsights && typeof policy.aiInsights === 'object') ? policy.aiInsights : null,
    diagnosis,
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

// ---- PR shepherding (CI self-healing) ------------------------------------------
// The Director can shepherd a pull request the pursuit OWNS through CI: watch the
// build, on failure spawn bounded fix legs, push the fix to ITS OWN branch, and
// re-watch until green — or give up (comment + mark stuck + a one-click desk ask
// to abandon). This module is PURE: it computes the next disposition from a
// read-only PR *observation*; server.js performs every side effect (fetch, push,
// comment, spawn) through hardened, capability-gated primitives.
//
// Two DISTINCT grant ops gate the external writes (never bundled with the edit op):
//   push-pr-branch — fast-forward push of a Director-prepared fix to the PR's own
//                    head ref (CAS on the expected old SHA; server enforces the rest).
//   pr-block       — externally-visible, ~irreversible close/abandon of the PR. NOT
//                    a standing default: absent this op, give-up = comment + desk ask.
const PR_GRANT_OPS = ['push-pr-branch', 'comment-pr', 'pr-block'];

// Attempt bounds. Attempts are counted PER head-SHA epoch (a new commit resets the
// per-SHA counter) with a pursuit-wide ceiling and a wall-clock deadline. Pending /
// still-running checks NEVER consume an attempt.
const PR_LIMITS = { maxAttemptsPerSha: 3, maxTotalAttempts: 8, deadlineMs: 24 * 60 * 60 * 1000 };

// Poll backoff for a still-building PR (exponential w/ jitter, capped). The server
// persists nextPollAt and honours a provider Retry-After when larger.
function _prBackoffMs(pollCount) {
  const base = 60 * 1000;            // 1 min
  const cap = 30 * 60 * 1000;        // 30 min
  const n = Math.max(0, pollCount | 0);
  const grow = Math.min(cap, base * Math.pow(2, Math.min(n, 5)));
  const jitter = Math.floor(grow * 0.2 * Math.random());
  return grow + jitter;
}

function prGrantHas(grant, op, ctx) {
  if (!_grantActive(grant, ctx)) return false;
  return Array.isArray(grant.ops) && grant.ops.indexOf(op) !== -1;
}

// planPrShepherd(pr, obs, ctx) — decide the next action for a shepherded PR.
//   pr  — durable Director PR record on the tree:
//         { headSha, attemptsBySha:{<sha>:n}, totalAttempts, deadlineAt, pollCount,
//           fixLegId, fixLegSha, stuck, ownership }
//   obs — PURE read-only observation for the CURRENT head SHA:
//         { headSha, ownershipOk, required:{ failed:[], pending:[], passed:[] },
//           deadlineAt } (classified over REQUIRED checks only, bound to headSha)
//   ctx — { now, grant, limits } (limits default to PR_LIMITS)
// Returns a disposition (never performs I/O):
//   { state, action, reason, epochReset, sha, attemptsForSha, giveUp, deskAsk,
//     nextPollAt, fixGoal }
// action ∈ 'none' | 'poll' | 'spawn-fix' | 'give-up'
function planPrShepherd(pr, obs, ctx) {
  ctx = ctx || {};
  const now = ctx.now || Date.now();
  const lim = ctx.limits || PR_LIMITS;
  pr = pr || {};
  obs = obs || {};

  // Ownership must be proven every pass — a stale binding must never authorize action.
  if (!obs.ownershipOk) {
    return { state: 'unowned', action: 'none', reason: 'PR ownership not established or no longer matches — shepherding is inert.', sha: obs.headSha || pr.headSha || null };
  }

  const sha = obs.headSha || pr.headSha || null;
  const req = obs.required || { failed: [], pending: [], passed: [] };
  const failed = Array.isArray(req.failed) ? req.failed : [];
  const pending = Array.isArray(req.pending) ? req.pending : [];

  // Epoch: a new head SHA (Director's own fix or a human push) resets per-SHA attempts
  // and revives shepherding even after a 'stuck'/'passed' terminal on an older SHA.
  const epochReset = !!sha && pr.headSha !== sha;
  const attemptsBySha = (pr.attemptsBySha && typeof pr.attemptsBySha === 'object') ? pr.attemptsBySha : {};
  const attemptsForSha = epochReset ? 0 : (attemptsBySha[sha] | 0);
  const totalAttempts = pr.totalAttempts | 0;
  const deadlineAt = pr.deadlineAt || obs.deadlineAt || (now + lim.deadlineMs);

  // A fix leg is already in flight for THIS SHA → wait for it (don't double-spawn).
  if (pr.fixLegId && pr.fixLegSha === sha && !epochReset) {
    return { state: 'fixing', action: 'none', reason: 'A Director fix leg is preparing a commit for this PR.', sha, attemptsForSha };
  }

  // Still building — poll only. Pending checks never consume an attempt.
  if (pending.length > 0 && failed.length === 0) {
    return { state: 'building', action: 'poll', reason: `${pending.length} required check(s) still running.`, sha, attemptsForSha, nextPollAt: now + _prBackoffMs(pr.pollCount) };
  }

  // Green (for this SHA) — terminal until the head changes again.
  if (failed.length === 0 && pending.length === 0) {
    return { state: 'passed', action: 'none', reason: 'All required checks passed for the current head.', sha, attemptsForSha };
  }

  // Failing. Have we exhausted the bounds?
  const overPerSha = attemptsForSha >= lim.maxAttemptsPerSha;
  const overTotal = totalAttempts >= lim.maxTotalAttempts;
  const overDeadline = Date.parse(deadlineAt) < now;
  if (overPerSha || overTotal || overDeadline) {
    const why = overDeadline ? 'wall-clock deadline reached'
      : overTotal ? `pursuit-wide attempt ceiling (${lim.maxTotalAttempts}) reached`
      : `per-commit attempt limit (${lim.maxAttemptsPerSha}) reached`;
    // Give up SAFELY: comment + mark stuck + a one-click desk ask to abandon. Actual
    // close/abandon is only ever done from the desk (or a distinct pr-block op) — never
    // as a silent standing default.
    const canBlock = prGrantHas(ctx.grant, 'pr-block', ctx);
    return {
      state: 'stuck', action: 'give-up', sha, attemptsForSha,
      reason: `Director gave up on this PR — ${why}. ${failed.length} required check(s) still failing.`,
      giveUp: { comment: true, why, failing: failed.slice() },
      deskAsk: { kind: 'pr-abandon', canBlock },
    };
  }

  // Within bounds and failing → spawn a bounded fix leg (a CANDIDATE commit; the
  // server serializes + fast-forward pushes it under a per-PR lease).
  return {
    state: 'failed', action: 'spawn-fix', sha, attemptsForSha: attemptsForSha + 1,
    reason: `${failed.length} required check(s) failing — dispatching a bounded fix leg (attempt ${attemptsForSha + 1}/${lim.maxAttemptsPerSha} on this commit).`,
    fixGoal: 'Investigate the failing PR checks, determine a fix, and prepare a commit on this PR\'s own branch. Do not push, deploy, or run pipelines — only edit files and stage a candidate commit; the Director integrates and pushes it.',
  };
}

module.exports = {
  AUTONOMY_LEVELS, POLICY_MATRIX, HANDLED, CLASS_GRANT_OP,
  DEFAULT_GRANT, DEFAULT_POLICY, LEDGER_STATES,
  PR_GRANT_OPS, PR_LIMITS,
  stopClass, grantCovers, planReduction, ledgerEntry,
  planPrShepherd, prGrantHas,
  _internal: { _isLocalWrite, _pathCovered, _stopSig, _clashEvidenceClear, _prBackoffMs, _clashCheckable, _recencyNote, _arbitrationProbe, _collisionKey, _collisionProbe },
};
