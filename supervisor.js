const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Cron } = require('croner');
const { parseSchedule, getNextRun } = require('./scheduler');
const sdkRunner = require('./sdk-runner');
const settings = require('./settings');

class Supervisor extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.agents = new Map(); // id -> { config, timer/cronJob, running, process }
    this._leaderCheck = null; // optional: () => boolean, set by config-sync
    this._initDb();
  }

  /** Set a leader check function. If set, scheduled executions only fire when it returns true. */
  setLeaderCheck(fn) { this._leaderCheck = fn; }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        output TEXT,
        error TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        schedule TEXT,
        last_run TEXT,
        next_run TEXT,
        status TEXT DEFAULT 'idle'
      );
    `);
    // Migration: add session_id column if missing
    try { this.db.exec('ALTER TABLE agent_runs ADD COLUMN session_id TEXT'); } catch {}
    // Migration: add triggered_by column if missing
    try { this.db.exec('ALTER TABLE agent_runs ADD COLUMN triggered_by TEXT'); } catch {}
    // Migration: add task_id column so task-triggered runs can be tracked
    // separately from an agent's own (manual/scheduled) runs.
    try { this.db.exec('ALTER TABLE agent_runs ADD COLUMN task_id TEXT'); } catch {}
  }


  register(config) {
    // Auto-fill copilotPath if not set
    if (!config.copilotPath && process.env.COPILOT_PATH) {
      config.copilotPath = process.env.COPILOT_PATH;
    }

    const existing = this.agents.get(config.id);
    if (existing) {
      existing.config = config;
    } else {
      this.agents.set(config.id, { config, timer: null, cronJob: null, running: false, process: null });
    }

    // Ensure state row exists; restore persisted schedule if dashboard changed it
    const row = this.db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(config.id);
    if (!row) {
      this.db.prepare('INSERT INTO agent_state (agent_id, schedule, enabled, status) VALUES (?, ?, ?, ?)')
        .run(config.id, config.schedule, config.enabled !== false ? 1 : 0, 'idle');
    } else {
      // DB schedule takes precedence over agents.json (user may have changed it in dashboard)
      if (row.schedule && row.schedule !== config.schedule) {
        config.schedule = row.schedule;
      } else {
        this.db.prepare('UPDATE agent_state SET schedule = ? WHERE agent_id = ?').run(config.schedule, config.id);
      }
    }
  }

  start(agentId, { runImmediately } = {}) {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Unknown agent: ${agentId}`);

    const schedule = parseSchedule(entry.config.schedule);
    
    // Update state
    this.db.prepare('UPDATE agent_state SET enabled = 1, status = ? WHERE agent_id = ?').run('scheduled', agentId);

    // Only run immediately if explicitly requested or autoStart is not false
    const shouldRunNow = runImmediately !== undefined ? runImmediately : entry.config.autoStart !== false;
    if (shouldRunNow) {
      this._executeAgent(agentId);
    }

    // Policy: agents never run on their own saved schedule. Recurring execution
    // comes from scheduled Tasks (server-side cron), Flows, or triggers. We keep
    // manual/autoStart and trigger paths, but no longer create cron/interval jobs
    // from config.schedule, even if a stray value is present in agents.json.
    // (schedule.type === 'cron' | 'interval' is intentionally ignored.)

    this._updateNextRun(agentId);
    this.emit('agent-started', agentId);
    console.log(`[supervisor] Agent "${entry.config.name}" scheduled: ${schedule.description}${shouldRunNow ? ' (running now)' : ' (waiting for schedule)'}`);
  }

  stop(agentId, { persist = true } = {}) {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    if (entry.cronJob) {
      entry.cronJob.stop();
      entry.cronJob = null;
    }
    if (entry.process) {
      entry.process.kill();
      entry.process = null;
    }
    entry.running = false;

    if (persist) {
      this.db.prepare('UPDATE agent_state SET enabled = 0, status = ? WHERE agent_id = ?').run('stopped', agentId);
    }
    this.emit('agent-stopped', agentId);
    console.log(`[supervisor] Agent "${entry.config.name}" stopped`);
  }

  updateSchedule(agentId, newSchedule) {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Unknown agent: ${agentId}`);

    // Validate the new schedule
    parseSchedule(newSchedule);

    entry.config.schedule = newSchedule;
    const wasRunning = entry.timer !== null || entry.cronJob !== null;

    if (wasRunning) {
      this.stop(agentId);
      this.start(agentId);
    }

    this.db.prepare('UPDATE agent_state SET schedule = ? WHERE agent_id = ?').run(newSchedule, agentId);
  }

  _executeAgent(agentId, triggerContext) {
    try {
      this.__executeAgent(agentId, triggerContext);
    } catch (err) {
      console.error(`[supervisor] Failed to execute agent "${agentId}": ${err.message}`);
      const entry = this.agents.get(agentId);
      if (entry) entry.running = false;
      const now = new Date().toISOString();
      this.db.prepare(
        'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agentId, now, now, -1, '', err.message + (err.stack ? '\n' + err.stack : ''));
      this.db.prepare('UPDATE agent_state SET status = ?, last_run = ? WHERE agent_id = ?').run('error', now, agentId);
    }
  }

  __executeAgent(agentId, triggerContext) {
    const entry = this.agents.get(agentId);
    if (!entry || entry.running) return;

    entry.running = true;
    entry._triggeredBy = triggerContext?.trigger?.id || null;
    // Consume a one-shot task id stamped by executeTask() so this run is
    // attributed to the task that fired it (cleared immediately so a later
    // manual/scheduled run of the same agent isn't mis-attributed).
    const taskId = entry._taskId || null;
    entry._taskId = null;
    const { config } = entry;
    const startedAt = new Date().toISOString();

    this.db.prepare('UPDATE agent_state SET status = ?, last_run = ? WHERE agent_id = ?')
      .run('running', startedAt, agentId);
    this.emit('agent-running', agentId);

    // Update next run time
    this._updateNextRun(agentId);

    // Interpolate template variables in prompt if trigger context provided
    // Large values are written to temp files to avoid Windows 8191-char cmd limit
    let triggerFiles = [];
    let prompt = triggerContext ? this._interpolatePrompt(config.prompt, triggerContext, agentId, triggerFiles) : (config.prompt || '');

    // Pin the copilot session UUID so the session is deterministically
    // addressable. Chat threads reuse their id to resume natively; regular runs
    // get a fresh id so the SDK read/run layers (and the scraper) can fetch
    // output by id instead of guessing the session-state dir by name + recency.
    const pinnedSessionId = entry._chatSessionId || crypto.randomUUID();

    // Validate CWD exists
    if (config.cwd && !fs.existsSync(config.cwd)) {
      const errMsg = `Working directory does not exist: ${config.cwd}`;
      console.error(`[supervisor] Agent "${config.name}" failed: ${errMsg}`);
      entry.status = 'error';
      entry.lastRun = { started_at: startedAt, ended_at: new Date().toISOString(), exit_code: 1, error: errMsg, output: '' };
      this._saveRun(agentId, entry.lastRun);
      for (const f of triggerFiles) { try { fs.unlinkSync(f); } catch {} }
      return;
    }

    const ctx = { agentId, entry, config, startedAt, prompt, pinnedSessionId, triggerFiles, taskId };

    // The @github/copilot-sdk runner is the sole agent runtime. Any
    // resolution/start/run failure is recorded as a failed run by _executeViaSdk.
    this._executeViaSdk(ctx);
  }

  /**
   * Run an agent via the @github/copilot-sdk — the sole runtime. Streams
   * assistant deltas as agent-output events to preserve the live SSE contract,
   * then records the completion through the shared path. A resolution/start
   * failure (res.fallback) or an unexpected runner error is recorded as a failed
   * run (exit 1) — there is no longer a CLI fallback.
   */
  _executeViaSdk(ctx) {
    const { agentId, entry, config, startedAt, prompt, pinnedSessionId } = ctx;
    console.log(`[supervisor] Executing agent "${config.name}" via SDK runner at ${startedAt}`);
    entry.process = null; // no child process under the SDK runtime

    // Live accumulator for the pull-based getLiveOutput endpoint (the SDK flushes
    // events.jsonl only on disconnect, so disk can't serve in-flight output).
    entry._live = { acc: '', startedAt: Date.now(), lastUpdate: Date.now(), sessionId: pinnedSessionId };

    const onChunk = (chunk) => {
      entry._live.acc += chunk;
      entry._live.lastUpdate = Date.now();
      this.emit('agent-output', { agentId, stream: 'stdout', chunk });
    };

    sdkRunner.runAgent({ config, prompt, sessionId: pinnedSessionId, onChunk, model: settings.resolveModel('execution', config) })
      .then((res) => {
        if (res.fallback) {
          const msg = res.error || 'agent could not be resolved/started via the SDK runner';
          console.error(`[supervisor] SDK runner could not run "${config.name}": ${msg}`);
          this._recordCompletion(ctx, {
            finishedAt: new Date().toISOString(),
            code: 1,
            output: res.output || '',
            error: msg,
            sessionId: pinnedSessionId,
            origin: 'sdk',
            steps: [],
          });
          return;
        }
        this._recordCompletion(ctx, {
          finishedAt: new Date().toISOString(),
          code: res.code,
          output: res.output || '',
          error: res.error || '',
          sessionId: res.sessionId || pinnedSessionId,
          origin: 'sdk',
          steps: Array.isArray(res.steps) ? res.steps : [],
        });
      })
      .catch((err) => {
        console.error(`[supervisor] SDK runner threw for "${config.name}": ${err.message}`);
        this._recordCompletion(ctx, {
          finishedAt: new Date().toISOString(),
          code: 1,
          output: '',
          error: err.message,
          sessionId: pinnedSessionId,
          origin: 'sdk',
          steps: [],
        });
      });
  }

  /**
   * Shared run-completion path used by the SDK runner.
   * Cleans up temp files, persists the agent_runs row, updates status, and emits
   * agent-completed. Keeps the mobile/activity/SSE contract identical for both
   * runtimes.
   */
  _recordCompletion(ctx, { finishedAt, code, output, error, sessionId, steps }) {
    const { agentId, entry, config, startedAt, triggerFiles, taskId } = ctx;
    entry.running = false;
    entry.process = null;
    entry._live = null;

    // Clean up trigger/prompt temp files now that the run is done.
    for (const f of triggerFiles) {
      try { fs.unlinkSync(f); } catch {}
    }

    const fullOutput = output || '';
    this.db.prepare(
      'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error, session_id, triggered_by, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(agentId, startedAt, finishedAt, code, fullOutput.slice(-50000), (error || '').slice(-5000), sessionId || null, entry._triggeredBy || null, taskId);

    // Set status: 'scheduled' if scheduler is active, 'idle' if not, 'error' on failure
    let status;
    if (code !== 0) status = 'error';
    else if (entry.cronJob || entry.timer) status = 'scheduled';
    else status = 'idle';
    this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run(status, agentId);

    this.emit('agent-completed', { agentId, code, output: fullOutput, error: error || '', sessionId, steps: Array.isArray(steps) ? steps : [] });
    console.log(`[supervisor] Agent "${config.name}" finished (exit ${code})`);

    // Durable restart on failure
    if (code !== 0 && config.durable) {
      console.log(`[supervisor] Durable agent "${config.name}" failed, will retry next cycle`);
    }
  }

  _updateNextRun(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const nextRun = getNextRun(entry.config.schedule);
    if (nextRun) {
      this.db.prepare('UPDATE agent_state SET next_run = ? WHERE agent_id = ?').run(nextRun.toISOString(), agentId);
    }
  }

  _interpolatePrompt(template, context, agentId, triggerFiles) {
    // Replace {{ variable }} patterns with values from trigger context
    // Supports: trigger.output, trigger.name, trigger.id, trigger.exitCode,
    //           trigger.prompt, trigger.startedAt, trigger.finishedAt
    //           chain[N].output, chain[N].name, etc.
    //           chain.length
    // Large values (>2000 chars) are written to temp files and replaced with
    // a file reference to avoid exceeding Windows' 8191-char command line limit.
    const os = require('os');
    const VAR_INLINE_LIMIT = 2000;
    let fileCounter = 0;

    return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (match, expr) => {
      try {
        // Parse dot/bracket notation safely
        const parts = expr.split(/\.|\[|\]/).filter(Boolean);
        let value = context;
        for (const part of parts) {
          if (value == null) return match;
          value = value[part];
        }
        if (value == null) return match;
        const strValue = String(value);

        // If value is small enough, inline it directly
        if (strValue.length <= VAR_INLINE_LIMIT) {
          return strValue;
        }

        // Write large value to a temp file and return a reference
        fileCounter++;
        const filePath = path.join(os.tmpdir(), `agent-trigger-${agentId}-${Date.now()}-${fileCounter}.md`);
        fs.writeFileSync(filePath, strValue, 'utf-8');
        triggerFiles.push(filePath);
        console.log(`[supervisor] Variable {{${expr}}} too long (${strValue.length} chars), wrote to ${filePath}`);
        return `[content in file: ${filePath}]`;
      } catch {
        return match;
      }
    });
  }

  getStatus(agentId) {
    const state = this.db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(agentId);
    const lastRun = this.db.prepare(
      'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
    ).get(agentId);
    const entry = this.agents.get(agentId);
    let scheduleDescription = '';
    try { scheduleDescription = parseSchedule(entry?.config?.schedule || state.schedule).description; } catch {}
    return { ...state, lastRun, config: entry?.config || null, scheduleDescription };
  }

  getAllStatus() {
    const states = this.db.prepare('SELECT * FROM agent_state').all();
    return states.map(state => {
      const lastRun = this.db.prepare(
        'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
      ).get(state.agent_id);
      const entry = this.agents.get(state.agent_id);
      let scheduleDescription = '';
      try { scheduleDescription = parseSchedule(entry?.config?.schedule || state.schedule).description; } catch {}
      return { ...state, lastRun, config: entry?.config || null, scheduleDescription };
    });
  }

  getRunHistory(agentId, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
    ).all(agentId, limit);
  }

  // Live output for a running agent, served from the in-memory accumulator the
  // SDK runner streams into (see _executeViaSdk). The SDK flushes events.jsonl
  // to disk only on session disconnect, so there is no disk to scrape mid-run.
  getLiveOutput(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.running) return null;
    const live = entry._live;
    if (!live) return null;
    const out = live.acc || '';
    return {
      output: out,
      messageCount: out ? 1 : 0,
      lastModified: new Date(live.lastUpdate || live.startedAt).toISOString(),
      isActive: true,
      sessionId: live.sessionId || null,
    };
  }

  startAll() {
    // Recover agents that were killed mid-run (status stuck at 'running')
    const staleRunning = this.db.prepare("SELECT agent_id FROM agent_state WHERE status = 'running'").all();
    for (const { agent_id } of staleRunning) {
      console.log(`[supervisor] Recovering stale running state for "${agent_id}"`);
      this.db.prepare("UPDATE agent_state SET status = 'idle' WHERE agent_id = ?").run(agent_id);
      this._recoverLastRun(agent_id);
    }

    // Hydrate agents with no run history from session files
    for (const [id] of this.agents) {
      const hasRuns = this.db.prepare('SELECT 1 FROM agent_runs WHERE agent_id = ? LIMIT 1').get(id);
      if (!hasRuns) {
        this._recoverLastRun(id);
      }
    }

    for (const [id, entry] of this.agents) {
      const state = this.db.prepare('SELECT enabled FROM agent_state WHERE agent_id = ?').get(id);
      const isEnabled = !state || state.enabled;
      
      if (isEnabled) {
        try {
          this.start(id, { runImmediately: entry.config.autoStart !== false });
        } catch (err) {
          console.error(`[supervisor] Failed to start agent "${entry.config.name}": ${err.message}`);
          this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run('error', id);
        }
      } else if (entry.config.durable) {
        console.log(`[supervisor] Durable agent "${entry.config.name}" is disabled, skipping`);
      }
    }
  }

  _recoverLastRun(agentId) {
    // Historically this scanned ~/.copilot/session-state for the most recent
    // session whose name/agent matched, to backfill run history. That heuristic
    // correlation was removed in Phase 6: the SDK runner records a real
    // session_id into agent_runs for every run, so run history is authoritative
    // in the DB and needs no disk scraping. Retained as a no-op so existing
    // callers (startAll recovery/hydration) stay valid.
    return;
  }

  stopAll() {
    for (const [id] of this.agents) {
      this.stop(id, { persist: false });
    }
  }
}

module.exports = Supervisor;
