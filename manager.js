const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { parseSchedule, getNextRun } = require('./scheduler');
const { Cron } = require('croner');

/**
 * ManagerAgent - Orchestrates multiple sub-agents to complete complex tasks.
 * 
 * A manager:
 * - Has an "org" of assigned agents it can invoke
 * - Runs assignments (saved prompts on schedules)  
 * - Can be interacted with ad-hoc
 * - Analyzes agent output and decides next steps
 * - Chains agents together based on results
 */
class ManagerAgent extends EventEmitter {
  constructor(db, supervisor) {
    super();
    this.db = db;
    this.supervisor = supervisor;
    this.managers = new Map(); // id -> { config, cronJobs, running }
    this._initDb();
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manager_state (
        manager_id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'idle',
        last_active TEXT
      );
      CREATE TABLE IF NOT EXISTS manager_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manager_id TEXT NOT NULL,
        assignment_id TEXT,
        prompt TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        steps TEXT,
        result TEXT,
        status TEXT DEFAULT 'running'
      );
      CREATE TABLE IF NOT EXISTS manager_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manager_id TEXT NOT NULL,
        run_id INTEGER,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);

    // Clean up orphaned runs from previous server instance
    const orphaned = this.db.prepare("SELECT id, manager_id FROM manager_runs WHERE status = 'running'").all();
    if (orphaned.length > 0) {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE manager_runs SET status = 'error', result = 'Server restarted — run was interrupted', finished_at = ? WHERE status = 'running'").run(now);
      this.db.prepare("UPDATE manager_state SET status = 'idle'").run();
      console.log(`[manager] Cleaned up ${orphaned.length} orphaned runs from previous session`);
    }
  }

  register(config) {
    const existing = this.managers.get(config.id);
    if (existing) {
      existing.config = config;
    } else {
      this.managers.set(config.id, { config, cronJobs: [], running: false, activeRuns: new Map() });
    }

    // Ensure state row
    const row = this.db.prepare('SELECT * FROM manager_state WHERE manager_id = ?').get(config.id);
    if (!row) {
      this.db.prepare('INSERT INTO manager_state (manager_id, status) VALUES (?, ?)').run(config.id, 'idle');
    }
  }

  /**
   * Start all assignment schedules for a manager
   */
  startSchedules(managerId) {
    const entry = this.managers.get(managerId);
    if (!entry) throw new Error(`Unknown manager: ${managerId}`);

    // Clear existing schedules
    this.stopSchedules(managerId);

    const assignments = entry.config.assignments || [];
    for (const assignment of assignments) {
      if (assignment.enabled === false) continue;
      if (!assignment.schedule || assignment.schedule.toLowerCase() === 'never') continue;

      const schedule = parseSchedule(assignment.schedule);
      if (schedule.type === 'cron') {
        const job = new Cron(schedule.cron, () => {
          this.runAssignment(managerId, assignment.id);
        });
        entry.cronJobs.push({ assignmentId: assignment.id, job });
      } else if (schedule.type === 'interval') {
        const timer = setInterval(() => {
          this.runAssignment(managerId, assignment.id);
        }, schedule.ms);
        entry.cronJobs.push({ assignmentId: assignment.id, timer });
      }
    }

    this.db.prepare('UPDATE manager_state SET status = ? WHERE manager_id = ?').run('scheduled', managerId);
    this.emit('manager-started', managerId);
  }

  stopSchedules(managerId) {
    const entry = this.managers.get(managerId);
    if (!entry) return;

    for (const sched of entry.cronJobs) {
      if (sched.job) sched.job.stop();
      if (sched.timer) clearInterval(sched.timer);
    }
    entry.cronJobs = [];
    this.db.prepare('UPDATE manager_state SET status = ? WHERE manager_id = ?').run('idle', managerId);
    this.emit('manager-stopped', managerId);
  }

  /**
   * Run an assignment by ID
   */
  async runAssignment(managerId, assignmentId) {
    const entry = this.managers.get(managerId);
    if (!entry) throw new Error(`Unknown manager: ${managerId}`);

    const assignment = (entry.config.assignments || []).find(a => a.id === assignmentId);
    if (!assignment) throw new Error(`Unknown assignment: ${assignmentId}`);

    return this.executePrompt(managerId, assignment.prompt, assignmentId);
  }

  /**
   * Execute an ad-hoc or assignment prompt.
   * Returns immediately with runId. Orchestration runs in background.
   * Poll /api/managers/:id/runs/:runId for live status.
   */
  executePrompt(managerId, prompt, assignmentId = null, { sync = false } = {}) {
    const entry = this.managers.get(managerId);
    if (!entry) throw new Error(`Unknown manager: ${managerId}`);

    // Concurrency control: check if manager is already running
    const concurrencyPolicy = entry.config.concurrency || 'reject_if_running';
    const activeRuns = this.db.prepare(
      "SELECT COUNT(*) as count FROM manager_runs WHERE manager_id = ? AND status = 'running'"
    ).get(managerId);

    if (activeRuns.count > 0) {
      if (concurrencyPolicy === 'reject_if_running') {
        throw new Error(`Manager "${managerId}" is already running (policy: reject_if_running). Wait for the current run to complete.`);
      }
      // 'allow_parallel' falls through; future: 'queue' could defer
    }

    const startedAt = new Date().toISOString();
    const runId = this.db.prepare(
      'INSERT INTO manager_runs (manager_id, assignment_id, prompt, started_at, steps, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(managerId, assignmentId, prompt, startedAt, '[]', 'running').lastInsertRowid;

    this.db.prepare('UPDATE manager_state SET status = ?, last_active = ? WHERE manager_id = ?')
      .run('running', startedAt, managerId);
    this.emit('manager-running', { managerId, runId });

    // Store the user prompt as a message
    this._addMessage(managerId, runId, 'user', prompt);

    // Run orchestration in background
    const orchestrationPromise = this._runOrchestration(managerId, runId, entry, prompt);

    if (sync) {
      return orchestrationPromise;
    }
    // Fire-and-forget for async mode
    orchestrationPromise.catch(() => {}); 
    return { runId, status: 'running' };
  }

  async _runOrchestration(managerId, runId, entry, prompt) {
    const steps = [];
    try {
      console.log(`[manager] Starting orchestration run ${runId} for ${managerId}`);
      const orgAgents = this._getOrgAgentDetails(managerId);
      const orchestrationResult = await this._orchestrate(entry.config, prompt, orgAgents, runId, steps);

      const finishedAt = new Date().toISOString();
      this.db.prepare(
        'UPDATE manager_runs SET finished_at = ?, steps = ?, result = ?, status = ? WHERE id = ?'
      ).run(finishedAt, JSON.stringify(steps), orchestrationResult, 'completed', runId);

      // Only mark idle if no other runs are still active
      const otherActive = this.db.prepare(
        "SELECT COUNT(*) as count FROM manager_runs WHERE manager_id = ? AND status = 'running' AND id != ?"
      ).get(managerId, runId);
      const newStatus = otherActive.count > 0 ? 'running' : 'idle';
      this.db.prepare('UPDATE manager_state SET status = ?, last_active = ? WHERE manager_id = ?')
        .run(newStatus, finishedAt, managerId);

      this._addMessage(managerId, runId, 'assistant', orchestrationResult);
      this.emit('manager-completed', { managerId, runId, result: orchestrationResult });
      console.log(`[manager] Orchestration run ${runId} completed`);

      return { runId, result: orchestrationResult, steps };
    } catch (err) {
      console.error(`[manager] Orchestration run ${runId} failed:`, err.message);
      const finishedAt = new Date().toISOString();
      this.db.prepare(
        'UPDATE manager_runs SET finished_at = ?, steps = ?, result = ?, status = ? WHERE id = ?'
      ).run(finishedAt, JSON.stringify(steps), err.message, 'error', runId);

      const otherActive = this.db.prepare(
        "SELECT COUNT(*) as count FROM manager_runs WHERE manager_id = ? AND status = 'running' AND id != ?"
      ).get(managerId, runId);
      const newStatus = otherActive.count > 0 ? 'running' : 'error';
      this.db.prepare('UPDATE manager_state SET status = ?, last_active = ? WHERE manager_id = ?')
        .run(newStatus, finishedAt, managerId);

      this._addMessage(managerId, runId, 'assistant', `Error: ${err.message}`);
      this.emit('manager-error', { managerId, runId, error: err });
      return { runId, error: err.message, steps };
    }
  }

  /**
   * Core orchestration loop. Uses the copilot CLI as the manager's "brain"
   * to decide which agents to run and how to interpret results.
   */
  async _orchestrate(managerConfig, userPrompt, orgAgents, runId, steps) {
    const maxIterations = 10;
    let iteration = 0;
    let context = '';
    let finalResult = '';

    // Build system context for the manager
    const systemPrompt = this._buildManagerSystemPrompt(managerConfig, orgAgents);
    let currentPrompt = `${systemPrompt}\n\n## User Request\n${userPrompt}`;

    while (iteration < maxIterations) {
      iteration++;

      // Ask the manager agent to decide what to do next
      steps.push({ iteration, action: 'thinking', timestamp: new Date().toISOString() });
      this._persistSteps(runId, steps);
      this.emit('manager-step', { managerId: managerConfig.id, runId, step: steps[steps.length - 1] });

      const decision = await this._askManager(managerConfig, currentPrompt);
      
      // Parse the decision
      const action = this._parseDecision(decision);

      if (action.type === 'complete') {
        finalResult = action.result;
        steps.push({ iteration, action: 'complete', result: action.result, timestamp: new Date().toISOString() });
        this._persistSteps(runId, steps);
        this.emit('manager-step', { managerId: managerConfig.id, runId, step: steps[steps.length - 1] });
        break;
      }

      if (action.type === 'run_agent') {
        // SECURITY: Enforce org boundaries — reject agents not in this manager's org
        const orgAgents = managerConfig.org || [];
        if (!orgAgents.includes(action.agentId)) {
          steps.push({ iteration, action: 'org_rejected', agentId: action.agentId, timestamp: new Date().toISOString() });
          this._persistSteps(runId, steps);
          context += `\n\n## Rejected: Agent "${action.agentId}" is not in your organization. Available agents: ${orgAgents.join(', ')}`;
          currentPrompt = `${systemPrompt}\n\n## User Request\n${userPrompt}\n\n## Execution History\n${context}\n\n## Next Step\nThe agent you requested is not authorized. Use only agents in your org: ${orgAgents.join(', ')}. What should you do next?`;
          continue;
        }

        steps.push({ iteration, action: 'run_agent', agentId: action.agentId, prompt: action.prompt, timestamp: new Date().toISOString() });
        this._persistSteps(runId, steps);
        this.emit('manager-step', { managerId: managerConfig.id, runId, step: steps[steps.length - 1] });

        // Execute the sub-agent and gather output
        const agentResult = await this._runSubAgent(action.agentId, action.prompt);
        steps.push({ iteration, action: 'agent_result', agentId: action.agentId, exitCode: agentResult.exitCode, outputLength: agentResult.output.length, output: agentResult.output.substring(0, 5000), timestamp: new Date().toISOString() });
        this._persistSteps(runId, steps);
        this.emit('manager-step', { managerId: managerConfig.id, runId, step: steps[steps.length - 1] });

        // Feed result back to manager for next decision — include full output so manager can pass it forward
        context += `\n\n## Result from "${action.agentId}" (exit code: ${agentResult.exitCode})\n\`\`\`\n${agentResult.output}\n\`\`\``;
        currentPrompt = `${systemPrompt}\n\n## User Request\n${userPrompt}\n\n## Execution History\n${context}\n\n## Next Step\nReview the results above. Remember: if you need to pass information to another agent, include the relevant data directly in YOUR prompt to that agent. What should you do next?`;
      }

      if (action.type === 'request_agent') {
        steps.push({ iteration, action: 'request_agent', agentId: action.agentId, reason: action.reason, timestamp: new Date().toISOString() });
        this._persistSteps(runId, steps);
        this.emit('manager-request-agent', { managerId: managerConfig.id, runId, agentId: action.agentId, reason: action.reason });
        
        context += `\n\n## Note: Agent "${action.agentId}" was requested but is not available in your org.`;
        currentPrompt = `${systemPrompt}\n\n## User Request\n${userPrompt}\n\n## Previous Results\n${context}\n\n## Next Step\nThe requested agent is not available. Decide what to do next with your available agents.`;
      }

      if (action.type === 'error') {
        steps.push({ iteration, action: 'error', message: action.message, timestamp: new Date().toISOString() });
        this._persistSteps(runId, steps);
        finalResult = `Error during orchestration: ${action.message}`;
        break;
      }
    }

    if (iteration >= maxIterations && !finalResult) {
      finalResult = 'Manager reached maximum iteration limit. Last context:\n' + context.slice(-2000);
    }

    return finalResult;
  }

  _persistSteps(runId, steps) {
    this.db.prepare('UPDATE manager_runs SET steps = ? WHERE id = ?')
      .run(JSON.stringify(steps), runId);
  }

  _buildManagerSystemPrompt(managerConfig, orgAgents) {
    const agentList = orgAgents.map(a => 
      `- **${a.id}** (${a.name}): ${a.capability || 'General purpose agent'}`
    ).join('\n');

    return `You are "${managerConfig.name}", an orchestrating manager agent.
${managerConfig.description || ''}

## Your Organization (Available Agents)
${agentList}

## CRITICAL RULES
1. **ALWAYS delegate to your agents.** You are an ORCHESTRATOR, not an answerer. NEVER answer questions from your own knowledge. ALWAYS run the appropriate agent to get real, accurate, up-to-date data. Your job is to coordinate agents, not to be one.
2. **Think step-by-step.** Plan the correct ORDER of operations BEFORE acting. If task A depends on output from task B, run task B FIRST.
3. **Never use an agent's default/saved prompt.** Always compose YOUR OWN prompt based on what you need the agent to do right now.
4. **Pass context forward.** When one agent's output is needed by another, include the relevant output directly in your prompt to the second agent.
5. **One action per turn.** Run only ONE agent at a time, wait for results, then decide next steps.
6. **Don't repeat yourself.** If an agent already succeeded, don't re-run it. Analyze the result and move to the next step.
7. **Gather before acting.** If you need information before sending notifications/emails, ALWAYS gather the information first.
8. **Never guess or speculate.** If you don't have data, run an agent to get it. If no agent can provide what's needed, say so explicitly rather than making something up.

## Instructions
For each turn, decide what to do next:
1. If you need ANY information (work items, status, health, etc.) → run the appropriate agent to gather it
2. If you have information and need to act on it → run the action agent WITH the gathered information in the prompt
3. ONLY mark complete after you have actually gathered data from your agents and have a real answer
4. If NO agent in your org can handle the request → complete with an explanation of what's missing

## Response Format
Respond with EXACTLY ONE of these action blocks:

**To run an agent (compose YOUR OWN prompt — do NOT copy the agent's saved description):**
\`\`\`action
RUN_AGENT: <agent_id>
PROMPT: <your custom prompt with full context for what you need this agent to do>
\`\`\`

**To complete the task:**
\`\`\`action
COMPLETE
RESULT: <your final summary/response to the user>
\`\`\`

**To request an agent not in your org:**
\`\`\`action
REQUEST_AGENT: <agent_id>
REASON: <why you need this agent>
\`\`\``;
  }

  _parseDecision(text) {
    // Extract action block
    const actionMatch = text.match(/```action\s*\n([\s\S]*?)```/);
    if (!actionMatch) {
      // If no action block, treat the whole response as a completion
      return { type: 'complete', result: text };
    }

    const block = actionMatch[1].trim();

    if (block.startsWith('RUN_AGENT:')) {
      const agentLine = block.match(/RUN_AGENT:\s*(.+)/);
      // PROMPT captures everything after "PROMPT:" to end of block (multi-line)
      const promptMatch = block.match(/PROMPT:\s*([\s\S]*)/);
      if (agentLine && promptMatch) {
        return { type: 'run_agent', agentId: agentLine[1].trim(), prompt: promptMatch[1].trim() };
      }
    }

    if (block.startsWith('COMPLETE')) {
      const resultMatch = block.match(/RESULT:\s*([\s\S]*)/);
      return { type: 'complete', result: resultMatch ? resultMatch[1].trim() : text };
    }

    if (block.startsWith('REQUEST_AGENT:')) {
      const agentLine = block.match(/REQUEST_AGENT:\s*(.+)/);
      const reasonMatch = block.match(/REASON:\s*([\s\S]*)/);
      return { type: 'request_agent', agentId: agentLine?.[1]?.trim() || '', reason: reasonMatch?.[1]?.trim() || '' };
    }

    return { type: 'error', message: 'Could not parse manager decision' };
  }

  /**
   * Ask the manager agent (copilot CLI) to make a decision
   */
  async _askManager(managerConfig, prompt) {
    return new Promise((resolve, reject) => {
      const copilotCmd = managerConfig.copilotPath || process.env.COPILOT_PATH || 'copilot';
      // Write prompt to temp file to avoid command line length limits
      const os = require('os');
      const promptFile = path.join(os.tmpdir(), `manager-prompt-${managerConfig.id}-${Date.now()}.md`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
      
      // Use configured agent or default to the built-in manager plugin
      const agentName = managerConfig.agent || 'manager:manager';
      const cmdLine = `"${copilotCmd}" --agent "${agentName}" -p "Follow instructions in file: ${promptFile.replace(/\\/g, '/')}" --yolo`;

      const shellPath = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\system32\\cmd.exe' : '/bin/sh');
      const proc = spawn(cmdLine, [], {
        cwd: managerConfig.cwd || __dirname,
        shell: shellPath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        // Clean up prompt file
        try { fs.unlinkSync(promptFile); } catch {}
        if (code === 0) {
          // Prefer stdout, fall back to stderr if stdout is empty
          resolve(stdout || stderr || '(no output from copilot process)');
        } else {
          const errDetail = stderr || stdout || '(no output)';
          reject(new Error(`Manager agent exited with code ${code}: ${errDetail.substring(0, 2000)}`));
        }
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(promptFile); } catch {}
        reject(err);
      });

      // Timeout after 5 minutes per step
      setTimeout(() => {
        proc.kill();
        try { fs.unlinkSync(promptFile); } catch {}
        reject(new Error('Manager decision timed out (5min)'));
      }, 300000);
    });
  }

  /**
   * Run a sub-agent and return its output
   */
  async _runSubAgent(agentId, prompt) {
    return new Promise((resolve) => {
      const entry = this.supervisor.agents.get(agentId);
      if (!entry) {
        resolve({ exitCode: -1, output: `Agent "${agentId}" not found in supervisor` });
        return;
      }

      const config = entry.config;
      const copilotCmd = config.copilotPath || process.env.COPILOT_PATH || 'copilot';

      // Write prompt to temp file to avoid command line length limits
      const os = require('os');
      const promptFile = path.join(os.tmpdir(), `mgr-subagent-${agentId}-${Date.now()}.md`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');

      // Build args array safely (no shell interpolation)
      const argParts = [];
      if (config.mcpConfig) {
        const mcpPath = path.isAbsolute(config.mcpConfig) ? config.mcpConfig : path.resolve(config.cwd, config.mcpConfig);
        argParts.push(`--additional-mcp-config "@${mcpPath}"`);
      }
      argParts.push(`--agent "${config.agent}"`);
      argParts.push(`-p "Follow instructions in file: ${promptFile.replace(/\\/g, '/')}"`);
      argParts.push('--yolo');

      const cmdLine = `"${copilotCmd}" ${argParts.join(' ')}`;
      console.log(`[manager] Running sub-agent "${agentId}": ${prompt.substring(0, 150)}...`);

      const shellPath = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\system32\\cmd.exe' : '/bin/sh');
      const proc = spawn(cmdLine, [], {
        cwd: config.cwd,
        shell: shellPath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        try { fs.unlinkSync(promptFile); } catch {}
        // Try to get session output (richer than stdout)
        setTimeout(() => {
          const sessionResult = this.supervisor._getSessionOutput(config);
          let output = sessionResult.output || stdout;
          // If output is empty and we have stderr (common on failure), include it
          if (!output && stderr) {
            output = `[stderr] ${stderr}`;
          } else if (code !== 0 && stderr && !output.includes(stderr)) {
            output = `${output}\n[stderr] ${stderr}`;
          }
          resolve({ exitCode: code, output, stderr });
        }, 1000);
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(promptFile); } catch {}
        resolve({ exitCode: -1, output: '', stderr: err.message });
      });

      // Timeout after 10 minutes per agent run
      setTimeout(() => {
        proc.kill();
        try { fs.unlinkSync(promptFile); } catch {}
        resolve({ exitCode: -1, output: stdout, stderr: 'Timed out after 10 minutes' });
      }, 600000);
    });
  }

  /**
   * Get details about agents in a manager's org
   */
  _getOrgAgentDetails(managerId) {
    const entry = this.managers.get(managerId);
    if (!entry) return [];

    return (entry.config.org || []).map(agentId => {
      const agentEntry = this.supervisor.agents.get(agentId);
      if (agentEntry) {
        // Only show a brief capability description, NOT the agent's saved prompt
        const capability = agentEntry.config.description || agentEntry.config.name || agentId;
        return {
          id: agentId,
          name: agentEntry.config.name,
          capability: capability.split('\n')[0].substring(0, 100), // First line, max 100 chars
          status: agentEntry.running ? 'running' : 'idle'
        };
      }
      return { id: agentId, name: agentId, capability: 'Not registered', status: 'unknown' };
    });
  }

  /**
   * Get available agents not in this manager's org (for REQUEST_AGENT)
   */
  getAvailableAgents(managerId) {
    const entry = this.managers.get(managerId);
    if (!entry) return [];

    const orgSet = new Set(entry.config.org || []);
    const available = [];
    for (const [id, agentEntry] of this.supervisor.agents) {
      if (!orgSet.has(id)) {
        available.push({ id, name: agentEntry.config.name, group: agentEntry.config.group });
      }
    }
    return available;
  }

  /**
   * Add an agent to a manager's org
   */
  addToOrg(managerId, agentId) {
    const entry = this.managers.get(managerId);
    if (!entry) throw new Error(`Unknown manager: ${managerId}`);
    if (!entry.config.org) entry.config.org = [];
    if (!entry.config.org.includes(agentId)) {
      entry.config.org.push(agentId);
    }
  }

  /**
   * Remove an agent from a manager's org
   */
  removeFromOrg(managerId, agentId) {
    const entry = this.managers.get(managerId);
    if (!entry) throw new Error(`Unknown manager: ${managerId}`);
    entry.config.org = (entry.config.org || []).filter(id => id !== agentId);
  }

  _addMessage(managerId, runId, role, content) {
    this.db.prepare(
      'INSERT INTO manager_messages (manager_id, run_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(managerId, runId, role, content, new Date().toISOString());
  }

  // Status methods
  getStatus(managerId) {
    const state = this.db.prepare('SELECT * FROM manager_state WHERE manager_id = ?').get(managerId);
    const entry = this.managers.get(managerId);
    const lastRun = this.db.prepare(
      'SELECT * FROM manager_runs WHERE manager_id = ? ORDER BY id DESC LIMIT 1'
    ).get(managerId);
    return { ...state, config: entry?.config || null, lastRun };
  }

  getAllStatus() {
    const results = [];
    for (const [id, entry] of this.managers) {
      const state = this.db.prepare('SELECT * FROM manager_state WHERE manager_id = ?').get(id);
      const lastRun = this.db.prepare(
        'SELECT * FROM manager_runs WHERE manager_id = ? ORDER BY id DESC LIMIT 1'
      ).get(id);
      const orgDetails = this._getOrgAgentDetails(id);

      // Enrich assignments with schedule descriptions
      const assignments = (entry.config.assignments || []).map(a => {
        let scheduleDescription = '';
        let nextRun = null;
        if (a.schedule && a.schedule.toLowerCase() !== 'never') {
          try {
            const parsed = parseSchedule(a.schedule);
            scheduleDescription = parsed.description;
            nextRun = getNextRun(a.schedule);
          } catch (e) { /* ignore parse errors */ }
        }
        return { ...a, scheduleDescription, nextRun };
      });

      // Count active schedule jobs
      const activeSchedules = entry.cronJobs?.length || 0;

      results.push({
        ...(state || { manager_id: id, status: 'idle' }),
        config: { ...entry.config, assignments },
        lastRun,
        orgDetails,
        activeSchedules
      });
    }
    return results;
  }

  getRunHistory(managerId, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM manager_runs WHERE manager_id = ? ORDER BY id DESC LIMIT ?'
    ).all(managerId, limit);
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM manager_runs WHERE id = ?').get(runId);
  }

  getMessages(managerId, limit = 50) {
    return this.db.prepare(
      'SELECT * FROM manager_messages WHERE manager_id = ? ORDER BY id DESC LIMIT ?'
    ).all(managerId, limit).reverse();
  }

  getRunMessages(managerId, runId) {
    return this.db.prepare(
      'SELECT * FROM manager_messages WHERE manager_id = ? AND run_id = ? ORDER BY id ASC'
    ).all(managerId, runId);
  }
}

module.exports = ManagerAgent;
