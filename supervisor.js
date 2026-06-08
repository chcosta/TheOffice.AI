const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
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
    const { config } = entry;
    const startedAt = new Date().toISOString();

    this.db.prepare('UPDATE agent_state SET status = ?, last_run = ? WHERE agent_id = ?')
      .run('running', startedAt, agentId);
    this.emit('agent-running', agentId);

    // Update next run time
    this._updateNextRun(agentId);

    // Interpolate template variables in prompt if trigger context provided
    const prompt = triggerContext ? this._interpolatePrompt(config.prompt, triggerContext) : config.prompt;

    // Build copilot CLI command as a full command string for shell execution
    const copilotCmd = config.copilotPath || process.env.COPILOT_PATH || 'copilot';
    const perms = config.allowAll !== false ? '--yolo' : '';
    const pluginDir = config.pluginDir ? `--plugin-dir "${config.pluginDir}"` : '';
    let mcpConfig = '';
    if (config.mcpConfig) {
      const mcpPath = path.isAbsolute(config.mcpConfig) ? config.mcpConfig : path.resolve(config.cwd, config.mcpConfig);
      mcpConfig = `--additional-mcp-config "@${mcpPath}"`;
    }
    const cmdLine = `"${copilotCmd}" ${pluginDir} ${mcpConfig} --agent "${config.agent}" --prompt "${prompt.replace(/"/g, '\\"')}" -s ${perms}`.replace(/\s+/g, ' ').trim();
    
    console.log(`[supervisor] Executing agent "${config.name}" at ${startedAt}`);
    console.log(`[supervisor] Command: ${cmdLine}`);

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

      // Try to get full output from session events (all assistant messages)
      let fullOutput = this._getSessionOutput(config) || stdout;

      // Store result
      this.db.prepare(
        'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agentId, startedAt, finishedAt, code, fullOutput.slice(-50000), stderr.slice(-5000));

      // Set status: 'scheduled' if scheduler is active, 'idle' if not, 'error' on failure
      let status;
      if (code !== 0) status = 'error';
      else if (entry.cronJob || entry.timer) status = 'scheduled';
      else status = 'idle';
      this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run(status, agentId);

      this.emit('agent-completed', { agentId, code, output: stdout, error: stderr });
      console.log(`[supervisor] Agent "${config.name}" finished (exit ${code})`);

      // Durable restart on failure
      if (code !== 0 && config.durable) {
        console.log(`[supervisor] Durable agent "${config.name}" failed, will retry next cycle`);
      }

      // Fire conditional triggers with output context
      this._fireTriggers(agentId, code, stdout, triggerContext);
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

  _getSessionOutput(config) {
    // Find the most recent session for this agent and extract all assistant messages
    const SESSION_STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
    if (!fs.existsSync(SESSION_STATE_DIR)) return '';
    try {
      const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, mtime: fs.statSync(path.join(SESSION_STATE_DIR, d.name)).mtime }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10);

      for (const dir of dirs) {
        const eventsPath = path.join(SESSION_STATE_DIR, dir.name, 'events.jsonl');
        if (!fs.existsSync(eventsPath)) continue;
        const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
        // Check if this session matches our agent
        let isMatch = false;
        const assistantMessages = [];
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'subagent.selected' && ev.data) {
              const name = ev.data.agentDisplayName || ev.data.agentName || '';
              if (name.toLowerCase().includes((config.name || '').toLowerCase()) ||
                  (config.agent && name.toLowerCase().includes(config.agent.split(':').pop().toLowerCase()))) {
                isMatch = true;
              }
            }
            if (ev.type === 'assistant.message' && ev.data?.content) {
              assistantMessages.push(ev.data.content);
            }
          } catch { }
        }
        if (isMatch && assistantMessages.length > 0) {
          // Return all assistant messages joined (the full conversation output)
          return assistantMessages.join('\n\n---\n\n');
        }
      }
    } catch (e) {
      console.error(`[supervisor] Error reading session output: ${e.message}`);
    }
    return '';
  }

  _interpolatePrompt(template, context) {
    // Replace {{ variable }} patterns with values from trigger context
    // Supports: trigger.output, trigger.name, trigger.id, trigger.exitCode,
    //           trigger.prompt, trigger.startedAt, trigger.finishedAt
    //           chain[N].output, chain[N].name, etc.
    //           chain.length
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
        return String(value);
      } catch {
        return match;
      }
    });
  }

  _fireTriggers(agentId, exitCode, stdout, triggerContext) {
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

    // Build trigger context for downstream agents
    const lastRun = this.db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY finished_at DESC LIMIT 1').get(agentId);
    const thisAgentContext = {
      id: agentId,
      name: entry.config.name || agentId,
      output: stdout || lastRun?.output || '',
      exitCode: exitCode,
      prompt: entry.config.prompt,
      startedAt: lastRun?.started_at || '',
      finishedAt: lastRun?.finished_at || ''
    };

    // Accumulate chain: previous chain + this agent
    const chain = [...(triggerContext?.chain || [])];
    if (triggerContext?.trigger) {
      chain.push(triggerContext.trigger);
    }

    const downstreamContext = {
      trigger: thisAgentContext,
      chain: chain
    };

    for (const targetId of targets) {
      const target = this.agents.get(targetId);
      if (target) {
        console.log(`[supervisor] Trigger: "${entry.config.name}" (${succeeded ? 'success' : 'failure'}) -> "${target.config.name}"`);
        this._executeAgent(targetId, downstreamContext);
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
    // Look for the most recent copilot session matching this agent's prompt/cwd
    try {
      const entry = this.agents.get(agentId);
      if (!entry) return;
      const sessionDir = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
      const fs = require('fs');
      if (!fs.existsSync(sessionDir)) return;

      const dirs = fs.readdirSync(sessionDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, mtime: fs.statSync(path.join(sessionDir, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20); // check last 20 sessions

      for (const dir of dirs) {
        const eventsFile = path.join(sessionDir, dir.name, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) continue;
        const lines = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
        
        // Check if this session matches our agent
        let matches = false;
        let lastAssistantContent = '';
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'subagent.selected' && entry.config.agent &&
                (evt.data?.agentName === entry.config.agent || evt.data?.agentDisplayName === entry.config.name)) {
              matches = true;
            }
            if (evt.type === 'assistant.message' && evt.data?.content) {
              lastAssistantContent = evt.data.content;
            }
          } catch {}
        }
        
        if (matches && lastAssistantContent) {
          const now = new Date().toISOString();
          // Check if we already have a more recent run recorded
          const existing = this.db.prepare('SELECT started_at FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId);
          if (!existing || new Date(existing.started_at) < new Date(dir.mtime - 300000)) {
            this.db.prepare(
              'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(agentId, new Date(dir.mtime).toISOString(), new Date(dir.mtime).toISOString(), 0, lastAssistantContent, '');
            this.db.prepare('UPDATE agent_state SET last_run = ? WHERE agent_id = ?').run(new Date(dir.mtime).toISOString(), agentId);
            console.log(`[supervisor] Recovered output for "${agentId}" from session ${dir.name}`);
          }
          return;
        }
      }
    } catch (err) {
      console.error(`[supervisor] Recovery failed for "${agentId}": ${err.message}`);
    }
  }

  stopAll() {
    for (const [id] of this.agents) {
      this.stop(id, { persist: false });
    }
  }
}

module.exports = Supervisor;
