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
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mobile_chats (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_type TEXT NOT NULL DEFAULT 'agent',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS mobile_chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (chat_id) REFERENCES mobile_chats(id)
        );
      `);
      // Load existing chat sessions into memory
      this._loadChatsFromDb();
    } catch (err) {
      console.error('[mobile-handler] DB init error:', err.message);
    }
  }

  _loadChatsFromDb() {
    if (!this.db) return;
    try {
      const chats = this.db.prepare('SELECT * FROM mobile_chats ORDER BY updated_at DESC LIMIT 50').all();
      for (const chat of chats) {
        const messages = this.db.prepare(
          'SELECT role, content, timestamp FROM mobile_chat_messages WHERE chat_id = ? ORDER BY id'
        ).all(chat.id);
        this.chatSessions.set(chat.id, {
          target: chat.target_id,
          targetType: chat.target_type,
          messages,
          startedAt: chat.created_at
        });
      }
    } catch {}
  }

  _persistChatMessage(chatKey, sessionId, targetId, targetType, role, content) {
    if (!this.db) return;
    try {
      // Upsert chat session
      this.db.prepare(`
        INSERT OR IGNORE INTO mobile_chats (id, session_id, target_id, target_type)
        VALUES (?, ?, ?, ?)
      `).run(chatKey, sessionId, targetId, targetType);
      this.db.prepare(`UPDATE mobile_chats SET updated_at = datetime('now') WHERE id = ?`).run(chatKey);
      // Insert message
      this.db.prepare(`
        INSERT INTO mobile_chat_messages (chat_id, role, content, timestamp)
        VALUES (?, ?, ?, datetime('now'))
      `).run(chatKey, role, content);
    } catch {}
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
      case 'list-chats':
        return this._listChats(correlationId, sessionId, replier);
      case 'get-activity':
        return this._getActivity(correlationId, payload, replier);
      case 'get-run-history':
        return this._getRunHistory(correlationId, payload, replier);
      case 'get-status':
        return this._getStatus(correlationId, replier);
      default:
        await replier(correlationId, { type: 'error', error: `Unknown message type: ${type}` });
        return true;
    }
  }

  // --- List Handlers ---

  async _listManagers(correlationId, replier) {
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedManagerIds = new Set(connectedAssets.filter(a => a.type === 'manager').map(a => a.id));
    
    const managers = [];
    for (const [id, entry] of this.managerAgent.managers) {
      if (!connectedManagerIds.has(id)) continue;
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
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const agents = [];
    for (const [id, entry] of this.supervisor.agents) {
      if (!connectedAgentIds.has(id)) continue;
      const config = entry.config;
      agents.push({
        id,
        name: config.name || id,
        icon: config.icon || '🕵️',
        description: config.description || '',
        skills: Array.isArray(config.skills) ? config.skills : [],
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
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedManagerIds = new Set(connectedAssets.filter(a => a.type === 'manager').map(a => a.id));
    const connectedAssignmentIds = new Set(connectedAssets.filter(a => a.type === 'assignment').map(a => a.id));

    const assignments = [];
    for (const [managerId, entry] of this.managerAgent.managers) {
      const config = entry.config;
      const managerConnected = connectedManagerIds.has(managerId);
      for (const assignment of (config.assignments || [])) {
        const assignmentKey = `${managerId}/${assignment.id}`;
        // Include if the whole manager is connected, or this specific assignment is connected
        if (!managerConnected && !connectedAssignmentIds.has(assignmentKey)) continue;
        const lastRun = this._getLastAssignmentRun(managerId, assignment.id);
        assignments.push({
          id: assignmentKey,
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
    // Tasks are connected agents that can be run on-demand
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const tasks = [];
    const seenIds = new Set();
    
    // Currently running connected agents
    for (const [id, entry] of this.supervisor.agents) {
      if (!connectedAgentIds.has(id)) continue;
      if (entry.running) {
        seenIds.add(id);
        tasks.push({
          id,
          agentId: id,
          name: entry.config.name || id,
          status: 'running',
          startedAt: entry.startedAt || null,
          lastRun: this._getLastAgentRun(id),
        });
      }
    }

    // Connected agents that aren't currently running (available to execute)
    for (const [id, entry] of this.supervisor.agents) {
      if (seenIds.has(id)) continue;
      if (!connectedAgentIds.has(id)) continue;
      tasks.push({
        id,
        agentId: id,
        name: entry.config.name || id,
        status: 'idle',
        schedule: entry.config.schedule || null,
        lastRun: this._getLastAgentRun(id),
      });
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

    // Stream orchestration steps live as the manager works through them.
    // Concurrency is reject_if_running (one run per manager), so filtering by
    // managerId is sufficient to attribute steps to this run.
    const onStep = async ({ managerId: mId, step }) => {
      if (mId !== managerId || !step) return;
      try {
        if (step.action === 'thinking') {
          await replier(correlationId, { type: 'status-update', payload: { status: 'running', message: `Thinking (step ${step.iteration})…` } });
        } else if (step.action === 'run_agent') {
          await replier(correlationId, { type: 'status-update', payload: { status: 'running', message: `Running agent: ${step.agentId}` } });
          await replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n▶ Running **${step.agentId}**…\n`, idx: Date.now() } });
        } else if (step.action === 'agent_result') {
          await replier(correlationId, { type: 'streaming-chunk', payload: { text: `✓ ${step.agentId} finished (exit ${step.exitCode})\n`, idx: Date.now() } });
        } else if (step.action === 'org_rejected') {
          await replier(correlationId, { type: 'streaming-chunk', payload: { text: `⛔ ${step.agentId} is not in this manager's org — skipped\n`, idx: Date.now() } });
        } else if (step.action === 'request_agent') {
          await replier(correlationId, { type: 'streaming-chunk', payload: { text: `❓ Requested unavailable agent: ${step.agentId}\n`, idx: Date.now() } });
        } else if (step.action === 'complete') {
          await replier(correlationId, { type: 'status-update', payload: { status: 'running', message: 'Finalizing…' } });
        }
      } catch {}
    };
    this.managerAgent.on('manager-step', onStep);

    try {
      // sync:true → resolves when the orchestration actually finishes
      const result = await this.managerAgent.runAssignment(managerId, assignmentId, { sync: true });

      // _runOrchestration resolves (not rejects) on a caught error, surfacing { error }
      if (result && result.error) {
        await replier(correlationId, {
          type: 'error',
          payload: { status: 'failed', error: result.error }
        });
        return true;
      }

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: 'completed',
          output: result?.result || result?.output || '(no output)',
          outputFormat: 'markdown',
          runId: result?.runId || null,
          durationMs: result?.durationMs || null,
          agentsUsed: result?.agentsUsed || []
        }
      });
    } catch (err) {
      await replier(correlationId, {
        type: 'error',
        payload: { status: 'failed', error: err.message }
      });
    } finally {
      this.managerAgent.off('manager-step', onStep);
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
    this._persistChatMessage(chatKey, sessionId || 'default', targetId, targetType || 'agent', 'user', message);

    // Send typing indicator
    await replier(correlationId, {
      type: 'status-update',
      payload: { status: 'processing', message: 'Thinking...' }
    });

    try {
      let result;
      if (session.targetType === 'manager') {
        // Build prompt with conversation history so the manager has context
        let fullPrompt = message;
        if (session.messages.length > 1) {
          const history = session.messages.slice(-20, -1); // last 20 msgs excluding current
          const historyText = history.map(m => 
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
          ).join('\n\n');
          fullPrompt = `## Conversation History\n${historyText}\n\n## Current Message\nUser: ${message}\n\nRespond to the user's latest message. Use the conversation history for context. If the user references something from earlier in the conversation, use that context.`;
        }

        // Listen for orchestration steps to relay progress to mobile
        const stepHandler = (data) => {
          if (data.managerId !== targetId) return;
          const step = data.step;
          const stepMsg = step?.action === 'run_agent'
            ? `Running ${step.agentId || 'agent'}...`
            : step?.action === 'thinking'
            ? 'Thinking...'
            : step?.action === 'complete'
            ? 'Composing response...'
            : step?.action === 'agent_result'
            ? `Got results from ${step.agentId || 'agent'}`
            : `Working... (${step?.action || 'step'})`;
          replier(correlationId, {
            type: 'status-update',
            payload: { status: 'processing', message: stepMsg }
          }).catch(() => {});
        };
        this.managerAgent.on('manager-step', stepHandler);
        try {
          result = await this.managerAgent.executePrompt(targetId, fullPrompt, null, { sync: true });
          result = result?.result || result?.output || '(no output)';
        } finally {
          this.managerAgent.removeListener('manager-step', stepHandler);
        }
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
      this._persistChatMessage(chatKey, sessionId || 'default', targetId, targetType || 'agent', 'assistant', result);

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

  async _listChats(correlationId, sessionId, replier) {
    const chats = [];
    for (const [key, session] of this.chatSessions) {
      // Only return chats for this session or all if no session filter
      const lastMsg = session.messages[session.messages.length - 1];
      const entry = session.targetType === 'manager'
        ? this.managerAgent.managers.get(session.target)
        : this.supervisor.agents.get(session.target);
      const name = session.targetType === 'manager'
        ? (entry?.name || session.target)
        : (entry?.config?.name || session.target);

      chats.push({
        id: key,
        targetId: session.target,
        targetType: session.targetType,
        targetName: name,
        messageCount: session.messages.length,
        lastMessage: lastMsg ? lastMsg.content.substring(0, 100) : null,
        lastMessageAt: lastMsg?.timestamp || session.startedAt,
        startedAt: session.startedAt
      });
    }
    // Sort by most recent activity
    chats.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

    await replier(correlationId, { type: 'result', payload: { chats } });
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

  /**
   * Get recent runs for a single task (agent) or assignment (manager+assignment).
   * Payload: { kind: 'task'|'assignment', agentId?, managerId?, assignmentId?, limit? }
   * Returns normalized run rows matching the activity shape so the mobile
   * ActivityDetail screen can render each run's output directly.
   */
  async _getRunHistory(correlationId, payload, replier) {
    const { kind, agentId, managerId, assignmentId, limit = 20 } = payload || {};

    if (!this.db) {
      await replier(correlationId, { type: 'result', payload: { runs: [] } });
      return true;
    }

    const runs = [];
    try {
      if (kind === 'assignment') {
        if (!managerId) {
          await replier(correlationId, { type: 'error', error: 'managerId is required' });
          return true;
        }
        const entry = this.managerAgent?.managers?.get(managerId);
        const managerName = entry?.config?.name || managerId;
        let rows;
        if (assignmentId) {
          rows = this.db.prepare(
            'SELECT * FROM manager_runs WHERE manager_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT ?'
          ).all(managerId, assignmentId, limit);
        } else {
          rows = this.db.prepare(
            'SELECT * FROM manager_runs WHERE manager_id = ? ORDER BY id DESC LIMIT ?'
          ).all(managerId, limit);
        }
        let assignmentName = assignmentId;
        if (entry && assignmentId) {
          const a = (entry.config.assignments || []).find(x => x.id === assignmentId);
          assignmentName = a?.name || assignmentId;
        }
        for (const row of rows) {
          const status = row.status === 'completed' ? 'completed'
            : (row.status === 'error' || row.status === 'failed') ? 'failed'
            : (row.status || 'running');
          const durationMs = (row.started_at && row.finished_at)
            ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
            : null;
          runs.push({
            id: row.id,
            name: assignmentName || managerName,
            status,
            output: row.result || null,
            outputFormat: 'markdown',
            createdAt: row.started_at,
            durationMs,
            trigger: 'assignment'
          });
        }
      } else {
        // Default to task (agent) history
        const id = agentId;
        if (!id) {
          await replier(correlationId, { type: 'error', error: 'agentId is required' });
          return true;
        }
        const entry = this.supervisor?.agents?.get(id);
        const name = entry?.config?.name || id;
        const rows = this.db.prepare(
          'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
        ).all(id, limit);
        for (const row of rows) {
          const status = row.exit_code === 0 ? 'completed' : 'failed';
          const durationMs = (row.started_at && row.finished_at)
            ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
            : null;
          runs.push({
            id: row.id,
            agentId: row.agent_id,
            name,
            status,
            output: row.output || row.error || null,
            outputFormat: 'markdown',
            createdAt: row.started_at,
            durationMs,
            trigger: row.triggered_by || 'direct'
          });
        }
      }
    } catch (e) {
      await replier(correlationId, { type: 'error', error: `Failed to load run history: ${e.message}` });
      return true;
    }

    await replier(correlationId, { type: 'result', payload: { runs } });
    return true;
  }

  async _getStatus(correlationId, replier) {
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedManagerIds = new Set(connectedAssets.filter(a => a.type === 'manager').map(a => a.id));
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const runningAgents = [];
    for (const [id, entry] of this.supervisor.agents) {
      if (entry.running) {
        runningAgents.push({ id, name: entry.config.name || id });
      }
    }

    const managerCount = connectedManagerIds.size;
    const agentCount = connectedAgentIds.size;
    // Tasks are the runnable connected agents (see _listTasks), so the task
    // count tracks the number of connected agents.
    const taskCount = connectedAgentIds.size;
    
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
        taskCount,
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
   * Get last run info for an agent (task), normalized to { status, time, durationMs }.
   */
  _getLastAgentRun(agentId) {
    if (!this.db) return null;
    try {
      const row = this.db.prepare(
        'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
      ).get(agentId);
      if (!row) return null;
      const durationMs = (row.started_at && row.finished_at)
        ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
        : null;
      return {
        status: row.exit_code === 0 ? 'completed' : 'failed',
        time: row.started_at,
        durationMs,
      };
    } catch { return null; }
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
