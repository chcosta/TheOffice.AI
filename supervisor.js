const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const { Cron } = require('croner');
const { parseSchedule, getNextRun } = require('./scheduler');

class Supervisor extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.agents = new Map(); // id -> { config, timer/cronJob, running, process }
    this._initDb();
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        output TEXT,
        error TEXT
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

    // Set up recurring schedule
    if (schedule.type === 'cron') {
      entry.cronJob = new Cron(schedule.cron, () => this._executeAgent(agentId));
    } else {
      entry.timer = setInterval(() => this._executeAgent(agentId), schedule.ms);
    }

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

  _executeAgent(agentId) {
    try {
      this.__executeAgent(agentId);
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

  __executeAgent(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry || entry.running) return;

    entry.running = true;
    const { config } = entry;
    const startedAt = new Date().toISOString();

    this.db.prepare('UPDATE agent_state SET status = ?, last_run = ? WHERE agent_id = ?')
      .run('running', startedAt, agentId);
    this.emit('agent-running', agentId);

    // Update next run time
    this._updateNextRun(agentId);

    // Build copilot CLI command as a full command string for shell execution
    const copilotCmd = config.copilotPath || process.env.COPILOT_PATH || 'copilot';
    const perms = config.allowAll !== false ? '--yolo' : '';
    const cmdLine = `"${copilotCmd}" --agent "${config.agent}" --prompt "${config.prompt}" -s ${perms}`.trim();
    
    console.log(`[supervisor] Executing agent "${config.name}" at ${startedAt}`);

    // On Windows, shell:true is required to spawn .cmd shims
    const proc = spawn(cmdLine, [], {
      cwd: config.cwd,
      shell: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    entry.process = proc;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      entry.running = false;
      entry.process = null;
      const finishedAt = new Date().toISOString();

      // Store result
      this.db.prepare(
        'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agentId, startedAt, finishedAt, code, stdout.slice(-10000), stderr.slice(-5000));

      const status = code === 0 ? 'idle' : 'error';
      this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run(status, agentId);

      this.emit('agent-completed', { agentId, code, output: stdout, error: stderr });
      console.log(`[supervisor] Agent "${config.name}" finished (exit ${code})`);

      // Durable restart on failure
      if (code !== 0 && config.durable) {
        console.log(`[supervisor] Durable agent "${config.name}" failed, will retry next cycle`);
      }

      // Fire conditional triggers
      this._fireTriggers(agentId, code);
    });

    proc.on('error', (err) => {
      entry.running = false;
      entry.process = null;
      const finishedAt = new Date().toISOString();

      this.db.prepare(
        'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agentId, startedAt, finishedAt, -1, '', err.message);

      this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run('error', agentId);
      this.emit('agent-error', { agentId, error: err });
      console.error(`[supervisor] Agent "${config.name}" spawn error: ${err.message}`);
    });
  }

  _updateNextRun(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const nextRun = getNextRun(entry.config.schedule);
    if (nextRun) {
      this.db.prepare('UPDATE agent_state SET next_run = ? WHERE agent_id = ?').run(nextRun.toISOString(), agentId);
    }
  }

  _fireTriggers(agentId, exitCode) {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.config.triggers) return;

    const triggers = entry.config.triggers;
    const succeeded = exitCode === 0;

    const targets = [];
    if (succeeded && triggers.onSuccess) {
      targets.push(...(Array.isArray(triggers.onSuccess) ? triggers.onSuccess : [triggers.onSuccess]));
    }
    if (!succeeded && triggers.onFailure) {
      targets.push(...(Array.isArray(triggers.onFailure) ? triggers.onFailure : [triggers.onFailure]));
    }
    if (triggers.onComplete) {
      targets.push(...(Array.isArray(triggers.onComplete) ? triggers.onComplete : [triggers.onComplete]));
    }

    for (const targetId of targets) {
      const target = this.agents.get(targetId);
      if (target) {
        console.log(`[supervisor] Trigger: "${entry.config.name}" (${succeeded ? 'success' : 'failure'}) -> "${target.config.name}"`);
        this._executeAgent(targetId);
      } else {
        console.warn(`[supervisor] Trigger target "${targetId}" not found`);
      }
    }
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

  startAll() {
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

  stopAll() {
    for (const [id] of this.agents) {
      this.stop(id, { persist: false });
    }
  }
}

module.exports = Supervisor;
