'use strict';

const { EventEmitter } = require('events');

/**
 * Mobile Command Handler
 * 
 * Processes structured JSON messages from the mobile app (React Native)
 * and returns responses via the event listener's reply queue.
 * 
 * Message types (inbound from phone):
 *   list-managers    → list all managers with metadata
 *   list-agents      → list all agents with status
 *   list-assignments → list all assignments across managers
 *   list-tasks       → list running/recent tasks
 *   run-assignment   → execute an assignment
 *   run-agent        → execute an agent directly
 *   chat             → send a conversational message to a manager/agent
 *   get-activity     → get activity log (paginated)
 *   get-status       → get system status overview
 * 
 * Reply types (outbound to phone):
 *   result           → final complete result
 *   streaming-chunk  → incremental text for live output
 *   status-update    → progress notification (e.g., "Running agent X...")
 *   error            → error response
 */
class MobileHandler extends EventEmitter {
  constructor(supervisor, managerAgent, db, eventListener) {
    super();
    this.supervisor = supervisor;
    this.managerAgent = managerAgent;
    this.db = db;
    this.eventListener = eventListener;
    // Track active mobile chat sessions: sessionId → { target, targetType, messages[] }
    this.chatSessions = new Map();
    this._ensureDb();
  }

  _ensureDb() {
    // No custom tables needed — we use agent_runs from the supervisor
  }

  /**
   * Check if a message body is a mobile protocol message (has a 'type' field)
   */
  isMobileMessage(body) {
    return body && typeof body === 'object' && typeof body.type === 'string';
  }

  /**
   * Handle a mobile protocol message. Returns true if handled.
   */
  async handle(body, replier) {
    const { type, correlationId, sessionId, payload } = body;

    switch (type) {
      case 'list-managers':
        return this._listManagers(correlationId, replier);
      case 'list-agents':
        return this._listAgents(correlationId, replier);
      case 'list-assignments':
        return this._listAssignments(correlationId, replier);
      case 'list-tasks':
        return this._listTasks(correlationId, replier);
      case 'run-assignment':
        return this._runAssignment(correlationId, sessionId, payload, replier);
      case 'run-agent':
        return this._runAgent(correlationId, sessionId, payload, replier);
      case 'chat':
        return this._chat(correlationId, sessionId, payload, replier);
      case 'get-chat-history':
        return this._getChatHistory(correlationId, sessionId, payload, replier);
      case 'get-activity':
        return this._getActivity(correlationId, payload, replier);
      case 'get-status':
        return this._getStatus(correlationId, replier);
      default:
        await replier(correlationId, { type: 'error', error: `Unknown message type: ${type}` });
        return true;
    }
  }

  // --- List Handlers ---

  async _listManagers(correlationId, replier) {
    const managers = [];
    for (const [id, entry] of this.managerAgent.managers) {
      const config = entry.config;
      const assignments = config.assignments || [];
      const agents = config.agents || [];
      const lastRun = this._getLastManagerRun(id);

      managers.push({
        id,
        name: config.name || id,
        icon: config.icon || '🤖',
        agentCount: agents.length,
        assignmentCount: assignments.length,
        lastRun: lastRun ? lastRun.created_at : null,
        status: entry.running ? 'running' : 'idle'
      });
    }

    await replier(correlationId, { type: 'result', payload: { managers } });
    return true;
  }

  async _listAgents(correlationId, replier) {
    const agents = [];
    for (const [id, entry] of this.supervisor.agents) {
      const config = entry.config;
      agents.push({
        id,
        name: config.name || id,
        icon: config.icon || '🕵️',
        schedule: config.schedule || null,
        status: entry.running ? 'running' : 'idle',
        lastRun: entry.lastRun || null,
        lastResult: entry.lastResult ? (entry.lastResult.substring(0, 100)) : null
      });
    }

    await replier(correlationId, { type: 'result', payload: { agents } });
    return true;
  }

  async _listAssignments(correlationId, replier) {
    const assignments = [];
    for (const [managerId, entry] of this.managerAgent.managers) {
      const config = entry.config;
      for (const assignment of (config.assignments || [])) {
        const lastRun = this._getLastAssignmentRun(managerId, assignment.id);
        assignments.push({
          id: `${managerId}/${assignment.id}`,
          name: assignment.name || assignment.id,
          managerId,
          managerName: config.name || managerId,
          schedule: assignment.schedule || null,
          enabled: assignment.enabled !== false,
          lastRun: lastRun ? {
            status: lastRun.status,
            time: lastRun.created_at,
            durationMs: lastRun.duration_ms
          } : null
        });
      }
    }

    await replier(correlationId, { type: 'result', payload: { assignments } });
    return true;
  }

  async _listTasks(correlationId, replier) {
    // Tasks are running agent executions + recent completions
    const tasks = [];
    
    // Currently running
    for (const [id, entry] of this.supervisor.agents) {
      if (entry.running) {
        tasks.push({
          id,
          name: entry.config.name || id,
          status: 'running',
          startedAt: entry.startedAt || null,
          source: 'agent'
        });
      }
    }

    // Recent completions from agent_runs
    if (this.db) {
      try {
        const recent = this.db.prepare(`
          SELECT id, agent_id, exit_code, output, error, started_at, finished_at, triggered_by
          FROM agent_runs ORDER BY id DESC LIMIT 20
        `).all();
        
        for (const row of recent) {
          if (!tasks.find(t => t.id === row.agent_id && t.status === 'running')) {
            const entry = this.supervisor?.agents?.get(row.agent_id);
            const durationMs = (row.started_at && row.finished_at)
              ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
              : null;
            tasks.push({
              id: row.agent_id,
              name: entry?.config?.name || row.agent_id,
              status: row.exit_code === 0 ? 'completed' : 'failed',
              completedAt: row.finished_at,
              durationMs,
              source: row.triggered_by || 'direct',
              outputPreview: (row.output || row.error || '').substring(0, 150)
            });
          }
        }
      } catch {}
    }

    await replier(correlationId, { type: 'result', payload: { tasks } });
    return true;
  }

  // --- Execution Handlers ---

  async _runAssignment(correlationId, sessionId, payload, replier) {
    const { managerId, assignmentId } = payload || {};
    if (!managerId || !assignmentId) {
      await replier(correlationId, { type: 'error', error: 'managerId and assignmentId are required' });
      return true;
    }

    // Send status update
    await replier(correlationId, {
      type: 'status-update',
      payload: { status: 'running', message: `Starting assignment: ${assignmentId}...` }
    });

    try {
      const result = await this.managerAgent.runAssignment(managerId, assignmentId, {
        onProgress: async (msg) => {
          await replier(correlationId, {
            type: 'streaming-chunk',
            payload: { text: msg, idx: Date.now() }
          });
        }
      });

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: 'completed',
          output: result?.result || result?.output || '(no output)',
          outputFormat: 'markdown',
          durationMs: result?.durationMs || null,
          agentsUsed: result?.agentsUsed || []
        }
      });
    } catch (err) {
      await replier(correlationId, {
        type: 'error',
        payload: { status: 'failed', error: err.message }
      });
    }

    return true;
  }

  async _runAgent(correlationId, sessionId, payload, replier) {
    const { agentId, prompt } = payload || {};
    if (!agentId) {
      await replier(correlationId, { type: 'error', error: 'agentId is required' });
      return true;
    }

    const entry = this.supervisor.agents.get(agentId);
    if (!entry) {
      await replier(correlationId, { type: 'error', error: `Agent "${agentId}" not found` });
      return true;
    }

    await replier(correlationId, {
      type: 'status-update',
      payload: { status: 'running', message: `Running ${entry.config.name || agentId}...` }
    });

    try {
      // Use custom prompt if provided, otherwise agent's configured prompt
      const execPrompt = prompt || entry.config.prompt;
      const result = await this._executeAgentWithStreaming(agentId, execPrompt, correlationId, replier);

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: 'completed',
          output: result,
          outputFormat: 'markdown',
          complete: true
        }
      });
    } catch (err) {
      await replier(correlationId, {
        type: 'error',
        payload: { status: 'failed', error: err.message }
      });
    }

    return true;
  }

  // --- Chat Handler ---

  async _chat(correlationId, sessionId, payload, replier) {
    const { targetId, targetType, message } = payload || {};
    if (!targetId || !message) {
      await replier(correlationId, { type: 'error', error: 'targetId and message are required' });
      return true;
    }

    // Get or create chat session
    const chatKey = `${sessionId || 'default'}:${targetId}`;
    if (!this.chatSessions.has(chatKey)) {
      this.chatSessions.set(chatKey, {
        target: targetId,
        targetType: targetType || 'agent',
        messages: [],
        startedAt: new Date().toISOString()
      });
    }

    const session = this.chatSessions.get(chatKey);
    session.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

    // Send typing indicator
    await replier(correlationId, {
      type: 'status-update',
      payload: { status: 'processing', message: 'Thinking...' }
    });

    try {
      let result;
      if (session.targetType === 'manager') {
        result = await this.managerAgent.executePrompt(targetId, message, null, { sync: true });
        result = result?.result || result?.output || '(no output)';
      } else {
        // Build prompt with conversation history for context
        let fullPrompt = message;
        if (session.messages.length > 1) {
          const history = session.messages.slice(-10, -1); // last 10 msgs excluding current
          const historyText = history.map(m => 
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
          ).join('\n\n');
          fullPrompt = `Previous conversation:\n${historyText}\n\nUser: ${message}\n\nRespond to the user's latest message, using the conversation history for context.`;
        }
        result = await this._executeAgentWithStreaming(targetId, fullPrompt, correlationId, replier);
      }

      session.messages.push({ role: 'assistant', content: result, timestamp: new Date().toISOString() });

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: 'completed',
          output: result,
          outputFormat: 'markdown',
          complete: true
        }
      });
    } catch (err) {
      await replier(correlationId, {
        type: 'error',
        payload: { status: 'failed', error: err.message }
      });
    }

    return true;
  }

  async _getChatHistory(correlationId, sessionId, payload, replier) {
    const { targetId } = payload || {};
    if (!targetId) {
      await replier(correlationId, { type: 'error', error: 'targetId is required' });
      return true;
    }

    const chatKey = `${sessionId || 'default'}:${targetId}`;
    const session = this.chatSessions.get(chatKey);

    await replier(correlationId, {
      type: 'result',
      payload: {
        messages: session ? session.messages : [],
        targetId,
        targetType: session?.targetType || 'agent',
        startedAt: session?.startedAt || null
      }
    });
    return true;
  }

  // --- Activity Handler ---

  async _getActivity(correlationId, payload, replier) {
    const { limit = 50, offset = 0, status: filterStatus } = payload || {};
    
    if (!this.db) {
      await replier(correlationId, { type: 'result', payload: { activity: [], total: 0 } });
      return true;
    }

    // Query from agent_runs (the canonical run history table used by the SPA too)
    let query, countQuery;
    const params = [];

    if (filterStatus) {
      // Map mobile status names to exit_code filter
      const exitCodeFilter = filterStatus === 'completed' ? '= 0' : '!= 0';
      query = `SELECT * FROM agent_runs WHERE exit_code ${exitCodeFilter} ORDER BY id DESC LIMIT ? OFFSET ?`;
      countQuery = `SELECT COUNT(*) as total FROM agent_runs WHERE exit_code ${exitCodeFilter}`;
    } else {
      query = 'SELECT * FROM agent_runs ORDER BY id DESC LIMIT ? OFFSET ?';
      countQuery = 'SELECT COUNT(*) as total FROM agent_runs';
    }

    const total = this.db.prepare(countQuery).get()?.total || 0;
    const rows = this.db.prepare(query).all(...params, limit, offset);

    const activity = rows.map(row => {
      const entry = this.supervisor?.agents?.get(row.agent_id);
      const name = entry?.config?.name || row.agent_id;
      const status = row.exit_code === 0 ? 'completed' : 'failed';
      const durationMs = (row.started_at && row.finished_at)
        ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
        : null;
      return {
        id: row.id,
        agentId: row.agent_id,
        name,
        status,
        output: row.output || row.error || null,
        outputFormat: 'markdown',
        createdAt: row.started_at,
        durationMs,
        trigger: row.triggered_by || 'direct'
      };
    });

    await replier(correlationId, { type: 'result', payload: { activity, total, limit, offset } });
    return true;
  }

  // --- Status Handler ---

  async _getStatus(correlationId, replier) {
    const runningAgents = [];
    for (const [id, entry] of this.supervisor.agents) {
      if (entry.running) {
        runningAgents.push({ id, name: entry.config.name || id });
      }
    }

    const managerCount = this.managerAgent.managers.size;
    const agentCount = this.supervisor.agents.size;
    
    let assignmentCount = 0;
    for (const [, entry] of this.managerAgent.managers) {
      assignmentCount += (entry.config.assignments || []).length;
    }

    // Recent activity counts from agent_runs
    let activityCounts = { success: 0, failed: 0, running: runningAgents.length };
    if (this.db) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const successCount = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_runs WHERE exit_code = 0 AND started_at >= ?`
        ).get(today)?.cnt || 0;
        const failedCount = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_runs WHERE exit_code != 0 AND started_at >= ?`
        ).get(today)?.cnt || 0;
        activityCounts.success = successCount;
        activityCounts.failed = failedCount;
      } catch {}
    }

    await replier(correlationId, {
      type: 'result',
      payload: {
        connected: true,
        managerCount,
        agentCount,
        assignmentCount,
        runningAgents,
        activityCounts,
        timestamp: new Date().toISOString()
      }
    });
    return true;
  }

  // --- Internal Helpers ---

  /**
   * Execute an agent and stream output chunks back to mobile
   */
  async _executeAgentWithStreaming(agentId, prompt, correlationId, replier) {
    const entry = this.supervisor.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);
    if (entry.running) throw new Error(`Agent ${agentId} is already running`);

    const originalPrompt = entry.config.prompt;
    entry.config.prompt = prompt;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        entry.config.prompt = originalPrompt;
        reject(new Error(`Agent ${agentId} timed out after 5 minutes`));
      }, 5 * 60 * 1000);

      let chunks = [];

      // Listen for streaming output if available
      const onOutput = (data) => {
        if (data.agentId !== agentId) return;
        const text = data.chunk || data.text || '';
        chunks.push(text);
        // Send streaming chunk to mobile with sequence number and content
        replier(correlationId, {
          type: 'streaming-chunk',
          payload: { text, idx: chunks.length, stream: data.stream || 'stdout', isFinal: false }
        }).catch(() => {});
      };

      const onCompleted = (data) => {
        if (data.agentId !== agentId) return;
        cleanup();
        entry.config.prompt = originalPrompt;
        const output = data.output || chunks.join('') || '(no output)';
        // Send final chunk marker so mobile knows streaming is done
        replier(correlationId, {
          type: 'streaming-chunk',
          payload: { text: '', idx: chunks.length + 1, isFinal: true }
        }).catch(() => {});
        resolve(output);
      };

      const onError = (data) => {
        if (data.agentId !== agentId) return;
        cleanup();
        entry.config.prompt = originalPrompt;
        reject(new Error(data.error || 'Agent execution failed'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.supervisor.removeListener('agent-output', onOutput);
        this.supervisor.removeListener('agent-completed', onCompleted);
        this.supervisor.removeListener('agent-error', onError);
      };

      this.supervisor.on('agent-output', onOutput);
      this.supervisor.on('agent-completed', onCompleted);
      this.supervisor.on('agent-error', onError);

      // Trigger execution
      this.supervisor._executeAgent(agentId);
    });
  }

  /**
   * Get last run info for a manager
   */
  _getLastManagerRun(managerId) {
    if (!this.db) return null;
    try {
      return this.db.prepare(`
        SELECT * FROM activity_log 
        WHERE agent_id LIKE ? OR trigger LIKE ?
        ORDER BY id DESC LIMIT 1
      `).get(`${managerId}%`, `%${managerId}%`);
    } catch { return null; }
  }

  /**
   * Get last run info for an assignment
   */
  _getLastAssignmentRun(managerId, assignmentId) {
    if (!this.db) return null;
    try {
      return this.db.prepare(`
        SELECT * FROM activity_log 
        WHERE agent_id = ? OR (trigger = 'assignment' AND agent_id LIKE ?)
        ORDER BY id DESC LIMIT 1
      `).get(`${managerId}/${assignmentId}`, `%${assignmentId}%`);
    } catch { return null; }
  }

  /**
   * Clean up idle chat sessions (older than 1 hour)
   */
  cleanupIdleSessions() {
    const cutoff = Date.now() - (60 * 60 * 1000);
    for (const [key, session] of this.chatSessions) {
      const lastMsg = session.messages[session.messages.length - 1];
      if (lastMsg && new Date(lastMsg.timestamp).getTime() < cutoff) {
        this.chatSessions.delete(key);
      }
    }
  }
}

module.exports = MobileHandler;
