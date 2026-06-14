const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Cron } = require('croner');
const { parseSchedule, getNextRun } = require('./scheduler');
const { repairConsoleMojibake } = require('./mojibake');
const sdkReader = require('./sdk-reader');
const sdkRunner = require('./sdk-runner');

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
    let prompt = triggerContext ? this._interpolatePrompt(config.prompt, triggerContext, agentId, triggerFiles) : config.prompt;

    // Pin the copilot session UUID so the session is deterministically
    // addressable. Chat threads reuse their id to resume natively; regular runs
    // get a fresh id so the SDK read/run layers (and the scraper) can fetch
    // output by id instead of guessing the session-state dir by name + recency.
    const pinnedSessionId = entry._chatSessionId || crypto.randomUUID();

    // Validate CWD exists (applies to both the CLI spawn and SDK runner paths)
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

    // Phase 2 migration: run via the @github/copilot-sdk when this agent opts in
    // (SDK_RUN_MODE=canary + opt-in, or =all). Any resolution failure transparently
    // falls back to the CLI spawn so behaviour can never regress.
    if (sdkRunner.shouldUse(config)) {
      this._executeViaSdk(ctx);
    } else {
      this._spawnCliRun(ctx);
    }
  }

  /**
   * Run an agent via the @github/copilot-sdk (Phase 2). Streams assistant deltas
   * as agent-output events to preserve the live SSE contract, then records the
   * completion through the shared path. Falls back to the CLI spawn if the SDK
   * runner can't resolve/start the agent.
   */
  _executeViaSdk(ctx) {
    const { agentId, entry, config, startedAt, prompt, pinnedSessionId } = ctx;
    console.log(`[supervisor] Executing agent "${config.name}" via SDK runner at ${startedAt}`);
    entry.process = null; // no child process under the SDK path

    const onChunk = (chunk) => {
      this.emit('agent-output', { agentId, stream: 'stdout', chunk: repairConsoleMojibake(chunk) });
    };

    sdkRunner.runAgent({ config, prompt, sessionId: pinnedSessionId, onChunk })
      .then((res) => {
        if (res.fallback) {
          // Could not resolve/start the agent via the SDK - run the CLI instead.
          console.warn(`[supervisor] SDK runner fell back to CLI for "${config.name}": ${res.error}`);
          this._spawnCliRun(ctx);
          return;
        }
        this._recordCompletion(ctx, {
          finishedAt: new Date().toISOString(),
          code: res.code,
          output: repairConsoleMojibake(res.output || ''),
          error: res.error || '',
          sessionId: res.sessionId || pinnedSessionId,
          origin: 'sdk',
          steps: Array.isArray(res.steps) ? res.steps : [],
        });
      })
      .catch((err) => {
        // Unexpected runner error - fall back to the CLI spawn for safety.
        console.error(`[supervisor] SDK runner threw for "${config.name}", falling back to CLI: ${err.message}`);
        this._spawnCliRun(ctx);
      });
  }

  /** Spawn the copilot CLI (the original runner). */
  _spawnCliRun(ctx) {
    const { agentId, entry, config, startedAt, prompt, pinnedSessionId, triggerFiles, taskId } = ctx;

    // Build copilot CLI command safely using args array
    const copilotCmd = config.copilotPath || process.env.COPILOT_PATH || 'copilot';
    const perms = config.allowAll !== false ? '--yolo' : '';
    // On Windows, shell:true is required to spawn .cmd shims (npm-installed binaries)
    const useShell = process.platform === 'win32';

    const args = [];
    if (config.mcpConfig) {
      const mcpPath = path.isAbsolute(config.mcpConfig) ? config.mcpConfig : path.resolve(config.cwd, config.mcpConfig);
      const mcpArg = `@${mcpPath}`;
      args.push('--additional-mcp-config', useShell ? `"${mcpArg}"` : mcpArg);
    }
    args.push('--agent', useShell ? `"${config.agent}"` : config.agent);

    // For prompts with newlines or very long prompts, write to a temp file
    // to avoid Windows cmd.exe limitations with special characters
    let promptTempFile = null;
    if (useShell && (prompt.includes('\n') || prompt.includes('\r') || prompt.length > 4000)) {
      const os = require('os');
      promptTempFile = path.join(os.tmpdir(), `copilot-prompt-${agentId}-${Date.now()}.txt`);
      fs.writeFileSync(promptTempFile, prompt, 'utf8');
      triggerFiles.push(promptTempFile);
      // Read prompt from file using cmd substitution isn't reliable;
      // Use a simple approach: replace newlines with spaces for the CLI arg
      const flatPrompt = prompt.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"');
      const safePrompt = `"${flatPrompt}"`;
      args.push('--prompt', safePrompt);
    } else {
      const safePrompt = useShell ? `"${prompt.replace(/"/g, '\\"')}"` : prompt;
      args.push('--prompt', safePrompt);
    }
    args.push('--session-id', useShell ? `"${pinnedSessionId}"` : pinnedSessionId);
    args.push('-s');
    if (perms) args.push(perms);

    console.log(`[supervisor] Executing agent "${config.name}" at ${startedAt}`);
    console.log(`[supervisor] Command: ${copilotCmd} ${args.map(a => a.length > 80 ? a.substring(0, 80) + '...' : a).join(' ')}`);

    const proc = spawn(copilotCmd, args, {
      cwd: config.cwd,
      shell: useShell,
      env: { ...process.env, PATH: process.env.PATH || 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    entry.process = proc;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const raw = data.toString();
      stdout += raw;
      this.emit('agent-output', { agentId, stream: 'stdout', chunk: repairConsoleMojibake(raw) });
    });
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      this.emit('agent-output', { agentId, stream: 'stderr', chunk });
    });

    proc.on('close', (code) => {
      const finishedAt = new Date().toISOString();
      // Small delay to let session state flush to disk before reading
      setTimeout(async () => {
        // Scraper path (still authoritative by default).
        const sessionResult = this._getSessionOutput(config);
        const scraperOutput = repairConsoleMojibake(sessionResult.output || stdout);
        let fullOutput = scraperOutput;
        // Prefer the pinned session id (the real copilot session) over the
        // scraper's display-name guess; fall back to the guess if unset.
        let sessionId = pinnedSessionId || sessionResult.sessionId || null;

        // SDK read layer (Phase 1). Shadow mode logs a parity record but keeps
        // the scraper output; authoritative mode uses the SDK output when the
        // read succeeds. Any failure falls back to the scraper.
        if (sdkReader.enabled && pinnedSessionId) {
          try {
            const sdk = await sdkReader.getSessionOutput(pinnedSessionId);
            const cmp = sdkReader.comparison(scraperOutput, sdk);
            sdkReader.logParity({ agentId, agent: config.name, sessionId: pinnedSessionId, mode: sdkReader.mode, ...cmp });
            if (sdkReader.mode === 'authoritative' && sdk.ok) {
              fullOutput = sdk.output;
            }
          } catch (e) {
            console.error(`[supervisor] sdk-reader error for "${config.name}": ${e.message}`);
          }
        }

        if (fullOutput === stdout && stdout.length < 200) {
          console.log(`[supervisor] Warning: "${config.name}" session output not found, using stdout (${stdout.length} chars)`);
        }

        this._recordCompletion(ctx, { finishedAt, code, output: fullOutput, error: stderr, sessionId, origin: 'cli' });
      }, 1000); // 1s delay to let session state flush
    });

    proc.on('error', (err) => {
      entry.running = false;
      entry.process = null;
      const finishedAt = new Date().toISOString();

      this.db.prepare(
        'INSERT INTO agent_runs (agent_id, started_at, finished_at, exit_code, output, error, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(agentId, startedAt, finishedAt, -1, '', err.message, taskId);

      this.db.prepare('UPDATE agent_state SET status = ? WHERE agent_id = ?').run('error', agentId);
      this.emit('agent-error', { agentId, error: err });
      console.error(`[supervisor] Agent "${config.name}" spawn error: ${err.message}`);
    });
  }

  /**
   * Shared run-completion path used by both the CLI spawn and the SDK runner.
   * Cleans up temp files, persists the agent_runs row, updates status, and emits
   * agent-completed. Keeps the mobile/activity/SSE contract identical for both
   * runtimes.
   */
  _recordCompletion(ctx, { finishedAt, code, output, error, sessionId, steps }) {
    const { agentId, entry, config, startedAt, triggerFiles, taskId } = ctx;
    entry.running = false;
    entry.process = null;

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

  _getSessionOutput(config) {
    // Find the most recent session for this agent and extract the full conversation
    // Returns { output, sessionId } or { output: '', sessionId: null }
    const SESSION_STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
    if (!fs.existsSync(SESSION_STATE_DIR)) return { output: '', sessionId: null };
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
        const turns = [];
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
            if (ev.type === 'user.message' && ev.data?.content) {
              turns.push({ role: 'user', content: ev.data.content });
            }
            if (ev.type === 'assistant.message' && ev.data?.content) {
              turns.push({ role: 'assistant', content: ev.data.content });
            }
          } catch { }
        }
        if (isMatch && turns.length > 0) {
          const parts = [];
          for (const turn of turns) {
            if (turn.role === 'assistant') {
              parts.push(turn.content);
            }
          }
          return { output: parts.join('\n\n---\n\n'), sessionId: dir.name };
        }
      }
    } catch (e) {
      console.error(`[supervisor] Error reading session output: ${e.message}`);
    }
    return { output: '', sessionId: null };
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

  // Get latest run per trigger source for trigger-only agents
  getLiveOutput(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.running) return null;
    
    // Find the most recent session that's actively being written
    const SESSION_STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
    if (!fs.existsSync(SESSION_STATE_DIR)) return null;
    
    try {
      const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, mtime: fs.statSync(path.join(SESSION_STATE_DIR, d.name)).mtime }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5);

      for (const dir of dirs) {
        const eventsPath = path.join(SESSION_STATE_DIR, dir.name, 'events.jsonl');
        if (!fs.existsSync(eventsPath)) continue;
        
        const stat = fs.statSync(eventsPath);
        // Only consider sessions modified within last 60 seconds (actively running)
        if (Date.now() - stat.mtime.getTime() > 60000) continue;
        
        const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
        let isMatch = false;
        const assistantMessages = [];
        
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'subagent.selected' && ev.data) {
              const name = ev.data.agentDisplayName || ev.data.agentName || '';
              if (name.toLowerCase().includes((entry.config.name || '').toLowerCase()) ||
                  (entry.config.agent && name.toLowerCase().includes(entry.config.agent.split(':').pop().toLowerCase()))) {
                isMatch = true;
              }
            }
            if (ev.type === 'assistant.message' && ev.data?.content) {
              assistantMessages.push(ev.data.content);
            }
          } catch { }
        }
        
        if (isMatch && assistantMessages.length > 0) {
          return {
            output: assistantMessages.join('\n\n---\n\n'),
            messageCount: assistantMessages.length,
            lastModified: stat.mtime.toISOString(),
            isActive: (Date.now() - stat.mtime.getTime()) < 15000,
            sessionId: dir.name
          };
        }
      }
    } catch { }
    return null;
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
