// resilience.js — transient-failure retry engine for tasks and flows.
//
// When a task or flow run fails, an AI classifier decides whether the failure is
// EXTERNAL / TRANSIENT (e.g. "server restarted", network congestion, rate limit —
// NOT a run-specific error like a bad prompt or a logic bug). If it is transient,
// the run is retried — either immediately or on an AI-chosen delayed schedule
// (e.g. "reschedule in 15 minutes because of network congestion"). The AI's
// reasoning is persisted + broadcast so the user can see WHY a retry was scheduled.
//
// Retries are PERSISTED in SQLite (not in-memory setTimeout) because a server
// restart is the flagship transient failure — an in-memory timer would be lost on
// exactly the case we most want to recover from. A leader-gated poller fires due
// retries.

const crypto = require('crypto');

const DEFAULT_MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 30 * 1000;

class ResilienceManager {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {object} opts.sdkRunner   sdk-runner module (runChat)
   * @param {function} opts.broadcast broadcastSSE(eventType, data)
   * @param {function} opts.leaderCheck () => bool
   * @param {string}  [opts.cwd]
   */
  constructor({ db, sdkRunner, broadcast, leaderCheck, cwd }) {
    this.db = db;
    this.sdkRunner = sdkRunner;
    this.broadcast = broadcast || (() => {});
    this.leaderCheck = leaderCheck || (() => true);
    this.cwd = cwd || process.cwd();
    // Fired by server.js: how to re-run a task / flow.
    this._runTask = null;   // (refId) => truthy on started
    this._runFlow = null;   // (refId) => runId | throws
    this._poller = null;
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resilience_retries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        kind           TEXT    NOT NULL,   -- 'task' | 'flow'
        ref_id         TEXT    NOT NULL,   -- task id or chain id
        name           TEXT,
        attempt        INTEGER NOT NULL,   -- which retry this is (1 = first retry)
        max_retries    INTEGER NOT NULL,
        error          TEXT,
        reason         TEXT,               -- AI reasoning (human readable)
        classification TEXT,               -- JSON of the full AI decision
        due_at         TEXT    NOT NULL,   -- ISO time to fire
        status         TEXT    NOT NULL,   -- pending | fired | cancelled | gaveup | exhausted
        created_at     TEXT    NOT NULL,
        fired_at       TEXT
      )
    `);
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_resilience_status ON resilience_retries(status, due_at)`); } catch {}
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_resilience_ref ON resilience_retries(kind, ref_id)`); } catch {}
  }

  /** Wire the actual re-run callbacks (server owns executeTask + chainEngine). */
  setRunners({ runTask, runFlow }) {
    if (runTask) this._runTask = runTask;
    if (runFlow) this._runFlow = runFlow;
  }

  start() {
    if (this._poller) return;
    this._poller = setInterval(() => { this._tick().catch(() => {}); }, POLL_INTERVAL_MS);
    if (this._poller.unref) this._poller.unref();
    // Fire an early tick so retries that came due while the server was down get
    // picked up shortly after startup instead of waiting a full interval.
    setTimeout(() => { this._tick().catch(() => {}); }, 8 * 1000);
  }

  stop() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }

  // --------------------------------------------------------------------------
  // Failure entry point — called on every task/flow completion.
  // --------------------------------------------------------------------------

  /**
   * Called when a resilient run finishes. On success it clears any pending
   * retry bookkeeping; on failure it asks the AI whether to retry and enqueues.
   *
   * @param {object} p
   * @param {'task'|'flow'} p.kind
   * @param {string} p.refId
   * @param {string} [p.name]
   * @param {boolean} p.ok              true when the run succeeded
   * @param {string} [p.error]
   * @param {string} [p.output]
   * @param {number} [p.maxRetries]
   */
  async onCompletion({ kind, refId, name, ok, error, output, maxRetries }) {
    if (!kind || !refId) return;
    const key = `${kind}:${refId}`;
    const cap = Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : DEFAULT_MAX_RETRIES;

    if (ok) {
      // Success — a resilient run recovered. Clear any pending retries.
      this._resolvePending(kind, refId, 'cancelled');
      return;
    }

    // How many retries have already fired for this ref in the current failure
    // streak? Count 'fired' rows since the last resolved/cancelled marker.
    const priorRetries = this._firedRetryCount(kind, refId);
    if (priorRetries >= cap) {
      this._insertRow({
        kind, refId, name, attempt: priorRetries, maxRetries: cap,
        error, reason: `Retry budget exhausted (${priorRetries}/${cap} retries used).`,
        classification: { transient: null, action: 'give_up', reason: 'max retries reached' },
        dueAt: new Date().toISOString(), status: 'exhausted'
      });
      this.broadcast('resilience-decision', {
        kind, refId, name: name || refId, transient: null, action: 'give_up',
        reason: `Retry budget exhausted (${priorRetries}/${cap} retries used).`,
        attempt: priorRetries, maxRetries: cap, dueAt: null
      });
      return;
    }

    let decision;
    try {
      decision = await this._classify({ kind, name: name || refId, error, output });
    } catch (e) {
      decision = { transient: false, action: 'give_up', delayMinutes: 0, reason: `Classifier unavailable: ${e.message}` };
    }

    const attempt = priorRetries + 1;

    if (!decision.transient || decision.action === 'give_up') {
      this._insertRow({
        kind, refId, name, attempt, maxRetries: cap, error,
        reason: decision.reason || 'Failure looks specific to this run — not retrying.',
        classification: decision, dueAt: new Date().toISOString(), status: 'gaveup'
      });
      this.broadcast('resilience-decision', {
        kind, refId, name: name || refId, transient: !!decision.transient, action: 'give_up',
        reason: decision.reason || 'Failure looks specific to this run — not retrying.',
        attempt, maxRetries: cap, dueAt: null
      });
      return;
    }

    const delayMin = decision.action === 'retry_delayed'
      ? Math.max(1, Math.min(1440, Math.round(Number(decision.delayMinutes) || 15)))
      : 0;
    const dueAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();

    this._insertRow({
      kind, refId, name, attempt, maxRetries: cap, error,
      reason: decision.reason || (delayMin ? `Transient failure — retrying in ${delayMin} min.` : 'Transient failure — retrying now.'),
      classification: decision, dueAt, status: 'pending'
    });

    this.broadcast('resilience-decision', {
      kind, refId, name: name || refId, transient: true,
      action: delayMin ? 'retry_delayed' : 'retry_now',
      delayMinutes: delayMin, reason: decision.reason || '',
      attempt, maxRetries: cap, dueAt
    });

    // Fire an immediate poll so retry_now runs promptly (leader-gated inside).
    if (delayMin === 0) setTimeout(() => { this._tick().catch(() => {}); }, 250);
  }

  // --------------------------------------------------------------------------
  // AI classifier
  // --------------------------------------------------------------------------

  async _classify({ kind, name, error, output }) {
    const errTxt = (error || '').slice(-4000);
    const outTxt = (output || '').slice(-2000);
    const prompt = [
      `You are a reliability engineer deciding whether a failed ${kind} run should be automatically retried.`,
      ``,
      `A retry is ONLY appropriate when the failure is caused by a TRANSIENT / EXTERNAL condition that is`,
      `NOT specific to the work itself — for example: the server or a service restarted, a network`,
      `timeout, connection reset, rate limiting / throttling (429), a temporary 5xx from a dependency,`,
      `capacity/congestion, or a transient auth-token refresh. In those cases a retry (immediately, or`,
      `after a short delay if the condition needs time to clear) is likely to succeed.`,
      ``,
      `A retry is NOT appropriate when the failure is intrinsic to this run — a bad prompt, a logic/`,
      `assertion error, invalid input, a permissions/config problem, a 4xx (other than 429), a compile`,
      `error, or anything a plain re-run would just reproduce.`,
      ``,
      `Run name: ${name}`,
      `--- ERROR OUTPUT (most recent) ---`,
      errTxt || '(none)',
      `--- STDOUT/RESULT TAIL ---`,
      outTxt || '(none)',
      `----------------------------------`,
      ``,
      `Respond with ONLY a JSON object (no prose, no code fence) of the shape:`,
      `{"transient": true|false, "action": "retry_now"|"retry_delayed"|"give_up", "delayMinutes": <int>, "reason": "<one or two sentences explaining the decision>"}`,
      ``,
      `Rules: if transient is false, action MUST be "give_up". If the condition needs time to clear`,
      `(congestion, rate limit, a service coming back up), prefer "retry_delayed" with a sensible`,
      `delayMinutes (5–30 typical, up to 1440). If it should just be re-run right away, use "retry_now"`,
      `with delayMinutes 0. Always fill "reason".`
    ].join('\n');

    let acc = '';
    const result = await this.sdkRunner.runChat({
      config: null, prompt, sessionId: crypto.randomUUID(),
      resume: false, cwd: this.cwd, availableTools: [], onChunk: (c) => { acc += c; },
      modelCategory: 'system', meta: { source: 'system', category: 'resilience' }
    });
    let raw = (acc.trim() || (result && result.output) || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      return { transient: false, action: 'give_up', delayMinutes: 0, reason: 'Could not classify the failure; not retrying.' };
    }
    const transient = !!parsed.transient;
    let action = String(parsed.action || '').toLowerCase();
    if (!transient) action = 'give_up';
    if (!['retry_now', 'retry_delayed', 'give_up'].includes(action)) action = transient ? 'retry_now' : 'give_up';
    return {
      transient,
      action,
      delayMinutes: Number(parsed.delayMinutes) || 0,
      reason: String(parsed.reason || '').slice(0, 600)
    };
  }

  // --------------------------------------------------------------------------
  // Poller — fires due pending retries.
  // --------------------------------------------------------------------------

  async _tick() {
    if (!this.leaderCheck()) return;
    const now = new Date().toISOString();
    let due;
    try {
      due = this.db.prepare(
        `SELECT * FROM resilience_retries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 20`
      ).all(now);
    } catch { return; }
    for (const row of due) {
      // Re-check leadership per-row (cheap, avoids a long batch after losing lease).
      if (!this.leaderCheck()) return;
      await this._fire(row);
    }
  }

  async _fire(row) {
    // Mark fired first so a crash mid-run can't double-fire.
    try {
      this.db.prepare(`UPDATE resilience_retries SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'`)
        .run(new Date().toISOString(), row.id);
    } catch { return; }
    // If the UPDATE affected nothing (already fired/cancelled) skip.
    const cur = this.db.prepare(`SELECT status FROM resilience_retries WHERE id = ?`).get(row.id);
    if (!cur || cur.status !== 'fired') return;

    this.broadcast('resilience-retry-fired', {
      id: row.id, kind: row.kind, refId: row.ref_id, name: row.name || row.ref_id,
      attempt: row.attempt, maxRetries: row.max_retries, reason: row.reason || ''
    });

    try {
      if (row.kind === 'task' && this._runTask) {
        this._runTask(row.ref_id);
      } else if (row.kind === 'flow' && this._runFlow) {
        this._runFlow(row.ref_id);
      }
    } catch (e) {
      // Firing itself failed (e.g. agent busy) — leave a note; the next
      // completion cycle (or a future failure) will re-evaluate.
      console.warn(`[resilience] failed to fire ${row.kind} ${row.ref_id}: ${e.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Bookkeeping helpers
  // --------------------------------------------------------------------------

  // Count retries fired since the last resolved/cancelled boundary — i.e. the
  // length of the current failure streak.
  _firedRetryCount(kind, refId) {
    try {
      const lastReset = this.db.prepare(
        `SELECT MAX(id) AS mid FROM resilience_retries WHERE kind = ? AND ref_id = ? AND status IN ('cancelled','exhausted','gaveup')`
      ).get(kind, refId);
      const boundary = lastReset && lastReset.mid ? lastReset.mid : 0;
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM resilience_retries WHERE kind = ? AND ref_id = ? AND status = 'fired' AND id > ?`
      ).get(kind, refId, boundary);
      return (row && row.n) || 0;
    } catch { return 0; }
  }

  _resolvePending(kind, refId, status) {
    try {
      this.db.prepare(`UPDATE resilience_retries SET status = ? WHERE kind = ? AND ref_id = ? AND status = 'pending'`)
        .run(status, kind, refId);
    } catch {}
  }

  _insertRow({ kind, refId, name, attempt, maxRetries, error, reason, classification, dueAt, status }) {
    let cj = null;
    try { cj = classification ? JSON.stringify(classification).slice(0, 8000) : null; } catch { cj = null; }
    try {
      const info = this.db.prepare(
        `INSERT INTO resilience_retries (kind, ref_id, name, attempt, max_retries, error, reason, classification, due_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(kind, refId, name || null, attempt, maxRetries, (error || '').slice(-4000), (reason || '').slice(-2000), cj, dueAt, status, new Date().toISOString());
      return info.lastInsertRowid;
    } catch (e) {
      console.warn('[resilience] insert failed:', e.message);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Query API (server routes)
  // --------------------------------------------------------------------------

  listRetries({ kind, refId, limit } = {}) {
    let sql = `SELECT * FROM resilience_retries`;
    const where = [];
    const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (refId) { where.push('ref_id = ?'); args.push(refId); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(Math.min(Number(limit) || 50, 200));
    try {
      return this.db.prepare(sql).all(...args).map(r => this._public(r));
    } catch { return []; }
  }

  /** Latest resilience decision for a ref (for inline display under a failed run). */
  latestFor(kind, refId) {
    try {
      const r = this.db.prepare(
        `SELECT * FROM resilience_retries WHERE kind = ? AND ref_id = ? ORDER BY id DESC LIMIT 1`
      ).get(kind, refId);
      return r ? this._public(r) : null;
    } catch { return null; }
  }

  cancelRetry(id) {
    try {
      const info = this.db.prepare(`UPDATE resilience_retries SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(id);
      if (info.changes) this.broadcast('resilience-retry-cancelled', { id: Number(id) });
      return !!info.changes;
    } catch { return false; }
  }

  _public(r) {
    let classification = null;
    try { classification = r.classification ? JSON.parse(r.classification) : null; } catch {}
    return {
      id: r.id, kind: r.kind, refId: r.ref_id, name: r.name,
      attempt: r.attempt, maxRetries: r.max_retries,
      error: r.error, reason: r.reason, classification,
      dueAt: r.due_at, status: r.status, createdAt: r.created_at, firedAt: r.fired_at
    };
  }
}

module.exports = { ResilienceManager, DEFAULT_MAX_RETRIES };
