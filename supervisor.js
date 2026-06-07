const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class Supervisor extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.agents = new Map(); // id -> { config, timer, running, process }
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

  parseSchedule(schedule) {
    const match = schedule.match(/^(\d+)(s|m|h|d)$/);
    if (!match) throw new Error(`Invalid schedule: ${schedule}`);
    const value = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * multipliers[unit];
  }

  register(config) {
    const existing = this.agents.get(config.id);
    if (existing) {
      existing.config = config;
    } else {
      this.agents.set(config.id, { config, timer: null, running: false, process: null });
    }

    // Ensure state row exists
    const row = this.db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(config.id);
    if (!row) {
      this.db.prepare('INSERT INTO agent_state (agent_id, schedule, status) VALUES (?, ?, ?)').run(
        config.id, config.schedule, 'idle'
      );
    } else {
      this.db.prepare('UPDATE agent_state SET schedule = ? WHERE agent_id = ?').run(config.schedule, config.id);
    }
  }

  start(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Unknown agent: ${agentId}`);

    const intervalMs = this.parseSchedule(entry.config.schedule);
    
    // Update state
    this.db.prepare('UPDATE agent_state SET enabled = 1, status = ? WHERE agent_id = ?').run('scheduled', agentId);

    // Run immediately on start
    this._executeAgent(agentId);

    // Set recurring timer
    entry.timer = setInterval(() => this._executeAgent(agentId), intervalMs);

    this.emit('agent-started', agentId);
    console.log(`[supervisor] Agent "${entry.config.name}" scheduled every ${entry.config.schedule}`);
  }

  stop(agentId, { persist = true } = {}) {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
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

    entry.config.schedule = newSchedule;
    const wasRunning = entry.timer !== null;

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
      this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run('error', agentId);
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

    // Update next run time (based on when this execution started, not when it finishes)
    const intervalMs = this.parseSchedule(entry.config.schedule);
    this._updateNextRun(agentId, intervalMs);

    // Build copilot CLI command as a full command string for shell execution
    const perms = config.allowAll !== false ? '--yolo' : '';
    const cmdLine = `copilot --agent "${config.agent}" --prompt "${config.prompt}" -s ${perms}`.trim();
    
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

  _updateNextRun(agentId, intervalMs) {
    const nextRun = new Date(Date.now() + intervalMs).toISOString();
    this.db.prepare('UPDATE agent_state SET next_run = ? WHERE agent_id = ?').run(nextRun, agentId);
  }

  getStatus(agentId) {
    const state = this.db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(agentId);
    const lastRun = this.db.prepare(
      'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
    ).get(agentId);
    const entry = this.agents.get(agentId);
    return { ...state, lastRun, config: entry?.config || null };
  }

  getAllStatus() {
    const states = this.db.prepare('SELECT * FROM agent_state').all();
    return states.map(state => {
      const lastRun = this.db.prepare(
        'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
      ).get(state.agent_id);
      const entry = this.agents.get(state.agent_id);
      return { ...state, lastRun, config: entry?.config || null };
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
      // If agent is in agents.json and durable, always start regardless of DB state
      if (!state || state.enabled || entry.config.durable) {
        this.start(id);
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
