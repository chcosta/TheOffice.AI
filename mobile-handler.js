'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdkRunner = require('./sdk-runner');
const settings = require('./settings');

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
 *   chat             → DISABLED (rejected): chat/get-chat-history/list-chat-
 *                       threads/new-chat-thread/list-chats are blocked on the
 *                       mobile channel for security. Chat lives on desktop only.
 *   get-activity     → get activity log (paginated)
 *   get-status       → get system status overview
 *   list-chains      → list all task chains with last-run status
 *   run-chain        → execute a chain (streams per-task output live)
 *   get-chain-runs   → recent run history for a chain
 *   get-chain-run    → full per-task output for one chain run
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
    this.configSync = null; // set by server after ConfigSync is constructed
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
        CREATE TABLE IF NOT EXISTS mobile_chat_threads (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL,
          target_type TEXT NOT NULL DEFAULT 'agent',
          title TEXT,
          last_preview TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS mobile_thread_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          speaker TEXT,
          agent_id TEXT,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Migration: per-message model so the mobile transcript can show which
      // model produced each assistant/agent turn.
      try { this.db.exec('ALTER TABLE mobile_thread_messages ADD COLUMN model TEXT'); } catch {}
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
      case 'list-organizations':
      case 'list-teams':
        return this._listOrganizations(correlationId, replier);
      case 'list-managers':
        return this._listManagers(correlationId, payload, replier);
      case 'list-agents':
        return this._listAgents(correlationId, payload, replier);
      case 'list-assignments':
        return this._listAssignments(correlationId, payload, replier);
      case 'list-tasks':
        return this._listTasks(correlationId, payload, replier);
      case 'run-assignment':
        return this._runAssignment(correlationId, sessionId, payload, replier);
      case 'run-agent':
        return this._runAgent(correlationId, sessionId, payload, replier);
      // Chat is intentionally disabled on the mobile channel. Ad-hoc
      // conversational access to agents/managers from a phone is a security
      // gap (arbitrary prompt execution against local employees), so these
      // message types are rejected regardless of client build. Mobile is
      // read/triage-first; authoring + chat stay on the desktop SPA.
      case 'chat':
      case 'get-chat-history':
      case 'list-chat-threads':
      case 'new-chat-thread':
      case 'list-chats':
        return replier(correlationId, {
          type: 'error',
          error: 'Chat is disabled on mobile for security. Use the desktop app to converse with agents and managers.',
        });
      case 'get-activity':
        return this._getActivity(correlationId, payload, replier);
      case 'get-run-history':
        return this._getRunHistory(correlationId, payload, replier);
      case 'get-status':
        return this._getStatus(correlationId, payload, replier);
      case 'list-machines':
        return this._listMachines(correlationId, replier);
      case 'install-from-machine':
        return this._installFromMachine(correlationId, payload, replier);
      case 'list-chains':
        return this._listChains(correlationId, payload, replier);
      case 'list-boards':
        return this._listBoards(correlationId, payload, replier);
      case 'get-board':
        return this._getBoard(correlationId, payload, replier);
      case 'list-insights':
        return this._listInsights(correlationId, payload, replier);
      case 'get-insight':
        return this._getInsight(correlationId, payload, replier);
      case 'generate-insight':
        return this._generateInsight(correlationId, payload, replier);
      case 'run-chain':
        return this._runChain(correlationId, sessionId, payload, replier);
      case 'get-chain-runs':
        return this._getChainRuns(correlationId, payload, replier);
      case 'get-chain-run':
        return this._getChainRun(correlationId, payload, replier);
      default:
        await replier(correlationId, { type: 'error', error: `Unknown message type: ${type}` });
        return true;
    }
  }

  // --- Team scoping ---
  // Mirrors the SPA's team model: employees (agents/managers) belong to a team via
  // teams.json memberIds; operations (assignments/flows) carry their own
  // teamId. A teamId of null/'all' (or absent) means office-wide — no filtering.

  _loadTeams() {
    try {
      const { dataPath } = require('./data-paths');
      let p = dataPath('teams.json');
      if (!fs.existsSync(p)) p = dataPath('organizations.json');
      if (!fs.existsSync(p)) return [];
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  // Accept both the new `teamId` and legacy `orgId` from mobile payloads.
  _payloadTeamId(payload) {
    if (!payload) return undefined;
    return payload.teamId !== undefined ? payload.teamId : payload.orgId;
  }

  // Returns a Set of employee ids in the team, or null for "all" (no filtering).
  // A real-but-unknown teamId yields an empty Set (hide all), matching the SPA,
  // where currentTeam() not found => idInCurrentTeam() false for everything.
  _orgMemberIds(teamId) {
    if (!teamId || teamId === 'all') return null;
    const team = this._loadTeams().find(o => o.id === teamId);
    return new Set((team && Array.isArray(team.memberIds)) ? team.memberIds : []);
  }

  // Team gate for an employee id (agent/manager). memberIds null => office-wide.
  _idInOrg(memberIds, id) {
    return !memberIds || memberIds.has(id);
  }

  // Team gate for an operation that carries its own teamId (assignment/flow).
  // Under "all" (memberIds null) everything shows; otherwise only ops stamped
  // with this team. Legacy ops without a teamId are hidden under a specific team.
  _opInOrg(memberIds, teamId, opTeamId) {
    if (!memberIds) return true;
    return !!opTeamId && opTeamId === teamId;
  }

  // Team gate for a flow/chain. Honors an explicit chain.teamId if present
  // (operation-level), otherwise falls back to referenced-agent membership
  // (mirrors SPA flowInCurrentTeam using step taskIds).
  _chainInOrg(memberIds, teamId, chain) {
    if (!memberIds) return true;
    const chainTeam = chain && (chain.teamId !== undefined ? chain.teamId : chain.orgId);
    if (chain && chainTeam) return chainTeam === teamId;
    const refs = (chain && Array.isArray(chain.steps) ? chain.steps : [])
      .map(s => s.taskId).filter(Boolean);
    if (!refs.length) return false;
    return refs.every(id => memberIds.has(id));
  }

  async _listOrganizations(correlationId, replier) {
    const teams = this._loadTeams().map(o => ({
      id: o.id,
      name: o.name || o.id,
      emoji: o.emoji || '🏢',
      color: o.color || null,
      theme: o.theme || 'default',
      description: o.description || '',
      memberCount: Array.isArray(o.memberIds) ? o.memberIds.length : 0,
    }));
    await replier(correlationId, { type: 'result', payload: { teams, organizations: teams } });
    return true;
  }

  // --- List Handlers ---

  async _listManagers(correlationId, payload, replier) {
    const memberIds = this._orgMemberIds(this._payloadTeamId(payload));
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedManagerIds = new Set(connectedAssets.filter(a => a.type === 'manager').map(a => a.id));
    
    const managers = [];
    for (const [id, entry] of this.managerAgent.managers) {
      if (!connectedManagerIds.has(id)) continue;
      if (!this._idInOrg(memberIds, id)) continue;
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

  async _listAgents(correlationId, payload, replier) {
    const memberIds = this._orgMemberIds(this._payloadTeamId(payload));
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const agents = [];
    for (const [id, entry] of this.supervisor.agents) {
      if (!connectedAgentIds.has(id)) continue;
      if (!this._idInOrg(memberIds, id)) continue;
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

  async _listAssignments(correlationId, payload, replier) {
    const orgId = this._payloadTeamId(payload);
    const memberIds = this._orgMemberIds(orgId);
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
        // Team scope: assignments carry their own teamId (operation-level scoping).
        if (!this._opInOrg(memberIds, orgId, (assignment.teamId !== undefined ? assignment.teamId : assignment.orgId))) continue;
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

  async _listTasks(correlationId, payload, replier) {
    // Tasks are connected agents that can be run on-demand
    const memberIds = this._orgMemberIds(this._payloadTeamId(payload));
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const tasks = [];
    const seenIds = new Set();
    
    // Currently running connected agents
    for (const [id, entry] of this.supervisor.agents) {
      if (!connectedAgentIds.has(id)) continue;
      if (!this._idInOrg(memberIds, id)) continue;
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
      if (!this._idInOrg(memberIds, id)) continue;
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
    const { targetId, targetType, message, threadId } = payload || {};
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
      let responseModel = '';
      if (session.targetType === 'manager') {
        const mgrEntry = this.managerAgent.managers.get(targetId);
        const managerName = mgrEntry?.config?.name || mgrEntry?.name || targetId;

        // Thread mode: persist the user turn and source history from the
        // thread transcript so the conversation survives navigation/restart.
        if (threadId) {
          this._upsertChatThread(threadId, targetId, 'manager', message);
          this._addThreadMessage(threadId, 'user', null, null, message);
        }

        // Build prompt with conversation history so the manager has context.
        let fullPrompt = message;
        const prior = threadId
          ? this._getThreadMessages(threadId).filter(m => m.role === 'user' || m.role === 'assistant')
          : session.messages;
        const history = prior.slice(0, -1).slice(-20); // last 20 turns excluding current
        if (history.length > 0) {
          const historyText = history.map(m =>
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
          ).join('\n\n');
          fullPrompt = `## Conversation History\n${historyText}\n\n## Current Message\nUser: ${message}\n\nRespond to the user's latest message. Use the conversation history for context. If the user references something from earlier in the conversation, use that context.`;
        }

        // Relay orchestration steps to mobile. Sub-agent runs are surfaced as
        // distinct, attributed messages ("agent-step") so the user can see
        // which sub-agent is contributing, and the manager's own progress is
        // surfaced as status updates.
        const stepHandler = (data) => {
          if (data.managerId !== targetId) return;
          const step = data.step;
          if (!step) return;
          if (step.action === 'run_agent') {
            const subName = this.supervisor.agents.get(step.agentId)?.config?.name || step.agentId || 'agent';
            replier(correlationId, {
              type: 'agent-step',
              payload: { phase: 'start', agentId: step.agentId, speaker: subName, manager: managerName }
            }).catch(() => {});
          } else if (step.action === 'agent_result') {
            const subName = this.supervisor.agents.get(step.agentId)?.config?.name || step.agentId || 'agent';
            const out = step.output || '';
            if (threadId) this._addThreadMessage(threadId, 'agent', subName, step.agentId, out, step.model);
            replier(correlationId, {
              type: 'agent-step',
              payload: { phase: 'result', agentId: step.agentId, speaker: subName, manager: managerName, text: out, exitCode: step.exitCode, model: step.model }
            }).catch(() => {});
          } else {
            const stepMsg = step.action === 'thinking'
              ? `${managerName} is thinking…`
              : step.action === 'complete'
              ? `${managerName} is composing a response…`
              : step.action === 'request_agent'
              ? `${managerName} wants to add ${step.agentId || 'an agent'}…`
              : `Working… (${step.action})`;
            replier(correlationId, {
              type: 'status-update',
              payload: { status: 'processing', message: stepMsg }
            }).catch(() => {});
          }
        };
        this.managerAgent.on('manager-step', stepHandler);
        // Heartbeat keeps the mobile client's inactivity timer alive during
        // long, quiet orchestration stretches (e.g. a multi-minute agent run).
        const heartbeat = setInterval(() => {
          replier(correlationId, {
            type: 'status-update',
            payload: { status: 'processing', message: `${managerName} is still working…` }
          }).catch(() => {});
        }, 20000);
        try {
          result = await this.managerAgent.executePrompt(targetId, fullPrompt, null, { sync: true });
          responseModel = result?.model || '';
          result = result?.result || result?.output || '(no output)';
        } finally {
          clearInterval(heartbeat);
          this.managerAgent.removeListener('manager-step', stepHandler);
        }
        if (threadId) {
          this._addThreadMessage(threadId, 'assistant', managerName, null, result, responseModel);
          // Tell the client who authored the final answer for attribution.
          await replier(correlationId, {
            type: 'agent-step',
            payload: { phase: 'manager-final', speaker: managerName }
          });
        }
      } else {
        // Agent chat: the thread id IS the SDK session id. We run interactive
        // turns through the SAME resume-aware SDK chat path the SPA uses
        // (sdkRunner.runChat with keepAlive), so the agent session stays open
        // between turns instead of re-spinning ("starting agent") each message.
        // We also persist an attributed transcript to the DB — identical to
        // managers — so history survives navigation/restart and never depends on
        // the SDK's deferred events.jsonl flush timing.
        if (threadId) {
          const agentName = this.supervisor.agents.get(targetId)?.config?.name || targetId;
          this._upsertChatThread(threadId, targetId, 'agent', message);
          this._addThreadMessage(threadId, 'user', null, null, message);
          const turn = await this._executeAgentChatTurn(targetId, threadId, message, correlationId, replier);
          result = turn.output;
          responseModel = turn.model || '';
          this._addThreadMessage(threadId, 'assistant', agentName, targetId, result, responseModel);
        } else {
          // Fallback (no thread): build prompt with conversation history.
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
      }

      if (threadId) this._touchChatThread(threadId, result);

      session.messages.push({ role: 'assistant', content: result, timestamp: new Date().toISOString() });
      this._persistChatMessage(chatKey, sessionId || 'default', targetId, targetType || 'agent', 'assistant', result);

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: 'completed',
          output: result,
          outputFormat: 'markdown',
          model: responseModel || undefined,
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
    const { targetId, threadId } = payload || {};
    if (!targetId && !threadId) {
      await replier(correlationId, { type: 'error', error: 'targetId or threadId is required' });
      return true;
    }

    // Thread mode. Both managers and agents keep an attributed transcript
    // (speaker + content) in the DB, so history survives navigation/restart and
    // never depends on the SDK's deferred events.jsonl flush. For older agent
    // threads with no DB transcript, fall back to scraping the copilot session.
    if (threadId) {
      const ttype = this._threadTargetType(threadId) || (payload.targetType || 'agent');
      if (ttype === 'manager') {
        const messages = this._getThreadMessages(threadId);
        await replier(correlationId, {
          type: 'result',
          payload: { messages, targetId, targetType: 'manager', threadId }
        });
        return true;
      }
      let messages = this._getThreadMessages(threadId);
      if (!messages || messages.length === 0) {
        // Back-compat: agent threads created before the DB-transcript change.
        messages = this._readSessionMessages(threadId);
      }
      await replier(correlationId, {
        type: 'result',
        payload: { messages, targetId, targetType: 'agent', threadId }
      });
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

  // --- Chat Threads (copilot-session-backed) ---

  _sessionStateDir() {
    return path.join(require('os').homedir(), '.copilot', 'session-state');
  }

  /**
   * Read a thread's conversation from its copilot session events.jsonl.
   * Returns [{ role, content, timestamp }] in order.
   */
  _readSessionMessages(threadId) {
    try {
      const file = path.join(this._sessionStateDir(), threadId, 'events.jsonl');
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const messages = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const ts = ev.timestamp || ev.data?.timestamp || null;
        if (ev.type === 'user.message' && ev.data?.content) {
          messages.push({ role: 'user', content: ev.data.content, timestamp: ts });
        } else if (ev.type === 'assistant.message' && ev.data?.content) {
          messages.push({ role: 'assistant', content: ev.data.content, timestamp: ts });
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  _upsertChatThread(threadId, targetId, targetType, firstMessage) {
    if (!this.db) return;
    try {
      const existing = this.db.prepare('SELECT id, title FROM mobile_chat_threads WHERE id = ?').get(threadId);
      const derivedTitle = (firstMessage || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!existing) {
        const title = derivedTitle || 'New conversation';
        this.db.prepare(
          'INSERT INTO mobile_chat_threads (id, target_id, target_type, title, last_preview) VALUES (?, ?, ?, ?, ?)'
        ).run(threadId, targetId, targetType || 'agent', title, (firstMessage || '').slice(0, 120));
      } else if (derivedTitle && (!existing.title || existing.title === 'New conversation')) {
        // Thread was minted empty (e.g. via new-chat-thread); backfill a real
        // title from the first actual message so history is meaningful.
        this.db.prepare('UPDATE mobile_chat_threads SET title = ? WHERE id = ?').run(derivedTitle, threadId);
      }
    } catch (e) { /* non-fatal */ }
  }

  _touchChatThread(threadId, lastReply) {
    if (!this.db) return;
    try {
      this.db.prepare(
        "UPDATE mobile_chat_threads SET updated_at = datetime('now'), last_preview = ? WHERE id = ?"
      ).run((lastReply || '').replace(/\s+/g, ' ').trim().slice(0, 120), threadId);
    } catch (e) { /* non-fatal */ }
  }

  _threadTargetType(threadId) {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT target_type FROM mobile_chat_threads WHERE id = ?').get(threadId);
      return row ? row.target_type : null;
    } catch { return null; }
  }

  /**
   * Persist a transcript message for a (manager) thread. Used to record the
   * back-and-forth plus each sub-agent's contribution with attribution, so the
   * conversation — and who said what — survives navigation and restarts.
   */
  _addThreadMessage(threadId, role, speaker, agentId, content, model = null) {
    if (!this.db || !threadId) return;
    try {
      this.db.prepare(
        'INSERT INTO mobile_thread_messages (thread_id, role, speaker, agent_id, content, timestamp, model) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(threadId, role, speaker || null, agentId || null, content == null ? '' : String(content), new Date().toISOString(), model || null);
    } catch (e) { /* non-fatal */ }
  }

  _getThreadMessages(threadId) {
    if (!this.db) return [];
    try {
      return this.db.prepare(
        'SELECT role, speaker, agent_id, content, timestamp, model FROM mobile_thread_messages WHERE thread_id = ? ORDER BY id ASC'
      ).all(threadId).map(r => ({
        role: r.role,
        speaker: r.speaker || undefined,
        agentId: r.agent_id || undefined,
        content: r.content,
        timestamp: r.timestamp,
        model: r.model || undefined,
      }));
    } catch { return []; }
  }

  async _listChatThreads(correlationId, payload, replier) {
    const { targetId } = payload || {};
    if (!targetId) {
      await replier(correlationId, { type: 'error', error: 'targetId is required' });
      return true;
    }
    let threads = [];
    if (this.db) {
      try {
        threads = this.db.prepare(
          'SELECT id, target_id, target_type, title, last_preview, created_at, updated_at FROM mobile_chat_threads WHERE target_id = ? ORDER BY updated_at DESC'
        ).all(targetId).map(r => ({
          threadId: r.id,
          targetId: r.target_id,
          targetType: r.target_type,
          title: r.title,
          lastPreview: r.last_preview,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }));
      } catch (e) { threads = []; }
    }
    await replier(correlationId, { type: 'result', payload: { threads } });
    return true;
  }

  async _newChatThread(correlationId, payload, replier) {
    const { targetId, targetType } = payload || {};
    if (!targetId) {
      await replier(correlationId, { type: 'error', error: 'targetId is required' });
      return true;
    }
    const threadId = crypto.randomUUID();
    this._upsertChatThread(threadId, targetId, targetType || 'agent', '');
    await replier(correlationId, { type: 'result', payload: { threadId, targetId, targetType: targetType || 'agent' } });
    return true;
  }

  async _listChats(correlationId, sessionId, payload, replier) {
    const memberIds = this._orgMemberIds(this._payloadTeamId(payload));
    const chats = [];
    for (const [key, session] of this.chatSessions) {
      // Team scope: chats are gated by whether their target employee is in the team.
      if (!this._idInOrg(memberIds, session.target)) continue;
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
    const orgId = this._payloadTeamId(payload);
    
    if (!this.db) {
      await replier(correlationId, { type: 'result', payload: { activity: [], total: 0 } });
      return true;
    }

    // Org scope: activity rows are agent runs, gated by whether the running
    // agent belongs to the selected org (mirrors SPA activityInCurrentOrg).
    const memberIds = this._orgMemberIds(orgId);
    if (memberIds && memberIds.size === 0) {
      // A specific org with no members — nothing to show.
      await replier(correlationId, { type: 'result', payload: { activity: [], total: 0, limit, offset } });
      return true;
    }

    const whereParts = [];
    const whereParams = [];
    if (filterStatus) {
      whereParts.push(`exit_code ${filterStatus === 'completed' ? '= 0' : '!= 0'}`);
    }
    if (memberIds) {
      const ids = [...memberIds];
      whereParts.push(`agent_id IN (${ids.map(() => '?').join(',')})`);
      whereParams.push(...ids);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const query = `SELECT * FROM agent_runs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) as total FROM agent_runs ${whereSql}`;

    const total = this.db.prepare(countQuery).get(...whereParams)?.total || 0;
    const rows = this.db.prepare(query).all(...whereParams, limit, offset);

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

  async _getStatus(correlationId, payload, replier) {
    const orgId = this._payloadTeamId(payload);
    const memberIds = this._orgMemberIds(orgId);
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedManagerIds = new Set(connectedAssets.filter(a => a.type === 'manager').map(a => a.id));
    const connectedAgentIds = new Set(connectedAssets.filter(a => a.type === 'agent').map(a => a.id));
    
    const runningAgents = [];
    for (const [id, entry] of this.supervisor.agents) {
      if (entry.running && this._idInOrg(memberIds, id)) {
        runningAgents.push({ id, name: entry.config.name || id });
      }
    }

    const managerCount = [...connectedManagerIds].filter(id => this._idInOrg(memberIds, id)).length;
    const agentCount = [...connectedAgentIds].filter(id => this._idInOrg(memberIds, id)).length;
    // Tasks are the runnable connected agents (see _listTasks), so the task
    // count tracks the number of connected agents.
    const taskCount = agentCount;
    
    let assignmentCount = 0;
    for (const [, entry] of this.managerAgent.managers) {
      for (const a of (entry.config.assignments || [])) {
        if (this._opInOrg(memberIds, orgId, (a.teamId !== undefined ? a.teamId : a.orgId))) assignmentCount++;
      }
    }

    let chainCount = 0;
    if (this.chainEngine) {
      try {
        const connectedChainIds = new Set(connectedAssets.filter(a => a.type === 'chain').map(a => a.id));
        chainCount = (this.chainEngine.list() || [])
          .filter(c => connectedChainIds.has(c.id) && this._chainInOrg(memberIds, orgId, c)).length;
      } catch {}
    }

    // Recent activity counts from agent_runs
    let activityCounts = { success: 0, failed: 0, running: runningAgents.length };
    if (this.db) {
      try {
        const today = new Date().toISOString().split('T')[0];
        let memberClause = '';
        const memberParams = [];
        if (memberIds) {
          const ids = [...memberIds];
          if (ids.length === 0) {
            // Specific org with no members — zero activity.
            activityCounts.success = 0;
            activityCounts.failed = 0;
            throw new Error('skip');
          }
          memberClause = ` AND agent_id IN (${ids.map(() => '?').join(',')})`;
          memberParams.push(...ids);
        }
        const successCount = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_runs WHERE exit_code = 0 AND started_at >= ?${memberClause}`
        ).get(today, ...memberParams)?.cnt || 0;
        const failedCount = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_runs WHERE exit_code != 0 AND started_at >= ?${memberClause}`
        ).get(today, ...memberParams)?.cnt || 0;
        activityCounts.success = successCount;
        activityCounts.failed = failedCount;
      } catch {}
    }

    let leader = null;
    if (this.configSync) {
      try { leader = await this.configSync.getLeaderStatus(); } catch {}
    }

    await replier(correlationId, {
      type: 'result',
      payload: {
        connected: true,
        managerCount,
        agentCount,
        taskCount,
        assignmentCount,
        chainCount,
        runningAgents,
        activityCounts,
        leader,
        timestamp: new Date().toISOString()
      }
    });
    return true;
  }

  // --- Chains (DAG of conditionally-triggered tasks) ---

  async _listChains(correlationId, payload, replier) {
    const orgId = this._payloadTeamId(payload);
    const memberIds = this._orgMemberIds(orgId);
    const connectedAssets = this.eventListener?.config?.connectedAssets || [];
    const connectedChainIds = new Set(connectedAssets.filter(a => a.type === 'chain').map(a => a.id));
    const out = [];
    if (this.chainEngine) {
      try {
        for (const chain of this.chainEngine.list()) {
          if (!connectedChainIds.has(chain.id)) continue;
          if (!this._chainInOrg(memberIds, orgId, chain)) continue;
          let lastRun = null;
          try {
            const recent = this.chainEngine.recentRuns(chain.id, 1);
            if (recent && recent[0]) {
              lastRun = {
                id: recent[0].id,
                status: recent[0].status,
                time: recent[0].started_at || recent[0].startedAt || null
              };
            }
          } catch {}
          out.push({
            id: chain.id,
            name: chain.name || chain.id,
            description: chain.description || '',
            enabled: chain.enabled !== false,
            schedule: chain.schedule || null,
            taskCount: (chain.steps || []).length,
            lastRun
          });
        }
      } catch (e) {
        await replier(correlationId, { type: 'error', error: `Failed to list chains: ${e.message}` });
        return true;
      }
    }
    await replier(correlationId, { type: 'result', payload: { chains: out } });
    return true;
  }

  // Build a readable markdown summary of all task outputs in a finished run.
  _aggregateChainOutput(chain, run) {
    const order = (chain?.steps || []).map(s => s.id);
    const ids = order.length ? order : Object.keys(run.nodes || {});
    const icon = { succeeded: '✅', failed: '❌', skipped: '⏭️', running: '⏳', pending: '○' };
    const parts = [];
    for (const sid of ids) {
      const node = (run.nodes || {})[sid];
      if (!node) continue;
      const name = node.taskName || sid;
      const mark = icon[node.status] || '•';
      let head = `## ${mark} ${name}`;
      if (node.code !== undefined && node.code !== null) head += ` (exit ${node.code})`;
      parts.push(head);
      if (node.reason) parts.push(`_${node.reason}_`);
      parts.push(node.output ? String(node.output).trim() : '_(no output)_');
      parts.push('');
    }
    return parts.join('\n').trim() || '_(no output)_';
  }

  async _runChain(correlationId, sessionId, payload, replier) {
    const { chainId } = payload || {};
    if (!this.chainEngine) {
      await replier(correlationId, { type: 'error', error: 'Chains are not available on this server' });
      return true;
    }
    if (!chainId) {
      await replier(correlationId, { type: 'error', error: 'chainId is required' });
      return true;
    }
    const chain = this.chainEngine.get(chainId);
    if (!chain) {
      await replier(correlationId, { type: 'error', error: `Chain "${chainId}" not found` });
      return true;
    }

    await replier(correlationId, {
      type: 'status-update',
      payload: { status: 'running', message: `Starting chain: ${chain.name || chainId}…` }
    });

    let runId = null;
    const sentLen = {}; // stepId -> chars already streamed

    const onStep = (d) => {
      if (!runId || d.runId !== runId) return;
      const node = (this.chainEngine.runs.get(runId)?.nodes || {})[d.stepId] || {};
      const name = node.taskName || d.stepId;
      if (d.status === 'running') {
        replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n▶ **${name}**…\n`, idx: Date.now() } }).catch(() => {});
        replier(correlationId, { type: 'status-update', payload: { status: 'running', message: `Running ${name}…` } }).catch(() => {});
      } else if (d.status === 'succeeded') {
        replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n✅ ${name} succeeded\n`, idx: Date.now() } }).catch(() => {});
      } else if (d.status === 'failed') {
        replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n❌ ${name} failed\n`, idx: Date.now() } }).catch(() => {});
      } else if (d.status === 'skipped') {
        replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n⏭️ ${name} skipped\n`, idx: Date.now() } }).catch(() => {});
      }
    };
    const onOutput = (d) => {
      if (!runId || d.runId !== runId) return;
      const full = d.output || '';
      const prev = sentLen[d.stepId] || 0;
      if (full.length > prev) {
        const delta = full.slice(prev);
        sentLen[d.stepId] = full.length;
        replier(correlationId, { type: 'streaming-chunk', payload: { text: delta, idx: Date.now() } }).catch(() => {});
      }
    };
    const onEdge = (d) => {
      if (!runId || d.runId !== runId) return;
      if (d.pass === false && d.reason) {
        replier(correlationId, { type: 'streaming-chunk', payload: { text: `\n⤳ condition not met: ${d.reason}\n`, idx: Date.now() } }).catch(() => {});
      }
    };

    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    const onFinished = (run) => {
      if (!runId || run.id !== runId) return;
      resolveFinished(run);
    };

    this.chainEngine.on('chain-run-step', onStep);
    this.chainEngine.on('chain-run-output', onOutput);
    this.chainEngine.on('chain-run-edge', onEdge);
    this.chainEngine.on('chain-run-finished', onFinished);

    const cleanup = () => {
      this.chainEngine.off('chain-run-step', onStep);
      this.chainEngine.off('chain-run-output', onOutput);
      this.chainEngine.off('chain-run-edge', onEdge);
      this.chainEngine.off('chain-run-finished', onFinished);
    };

    try {
      runId = this.chainEngine.runChain(chainId, { manual: true });
      if (!runId) {
        cleanup();
        await replier(correlationId, { type: 'error', error: 'Chain is disabled or has no tasks' });
        return true;
      }

      // Safety timeout so the mobile request always resolves.
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 15 * 60 * 1000));
      const run = await Promise.race([finished, timeout]);

      if (!run) {
        const live = this.chainEngine.getRun(runId);
        await replier(correlationId, {
          type: 'result',
          payload: {
            status: 'running',
            output: live ? this._aggregateChainOutput(chain, live) : 'Chain is still running…',
            outputFormat: 'markdown',
            runId,
            complete: false
          }
        });
        return true;
      }

      await replier(correlationId, {
        type: 'result',
        payload: {
          status: run.status === 'completed' ? 'completed' : 'failed',
          output: this._aggregateChainOutput(chain, run),
          outputFormat: 'markdown',
          runId,
          complete: true
        }
      });
    } catch (err) {
      await replier(correlationId, { type: 'error', payload: { status: 'failed', error: err.message } });
    } finally {
      cleanup();
    }
    return true;
  }

  async _getChainRuns(correlationId, payload, replier) {
    const { chainId, limit = 20 } = payload || {};
    if (!this.chainEngine) {
      await replier(correlationId, { type: 'result', payload: { runs: [] } });
      return true;
    }
    if (!chainId) {
      await replier(correlationId, { type: 'error', error: 'chainId is required' });
      return true;
    }
    let runs = [];
    try {
      const rows = this.chainEngine.recentRuns(chainId, limit) || [];
      runs = rows.map(r => {
        const started = r.started_at || r.startedAt || null;
        const finished = r.finished_at || r.finishedAt || null;
        const status = r.status === 'completed' ? 'completed'
          : (r.status === 'error' || r.status === 'failed') ? 'failed'
          : (r.status || 'running');
        const durationMs = (started && finished)
          ? new Date(finished).getTime() - new Date(started).getTime()
          : null;
        return {
          id: r.id,
          name: r.name || chainId,
          status,
          createdAt: started,
          durationMs,
          trigger: r.trigger || 'chain'
        };
      });
    } catch (e) {
      await replier(correlationId, { type: 'error', error: `Failed to load chain runs: ${e.message}` });
      return true;
    }
    await replier(correlationId, { type: 'result', payload: { runs } });
    return true;
  }

  async _getChainRun(correlationId, payload, replier) {
    const { runId } = payload || {};
    if (!this.chainEngine) {
      await replier(correlationId, { type: 'error', error: 'Chains are not available on this server' });
      return true;
    }
    if (!runId) {
      await replier(correlationId, { type: 'error', error: 'runId is required' });
      return true;
    }
    const run = this.chainEngine.getRun(runId);
    if (!run) {
      await replier(correlationId, { type: 'error', error: `Run "${runId}" not found` });
      return true;
    }
    const chain = this.chainEngine.get(run.chainId);
    const order = (chain?.steps || []).map(s => s.id);
    const ids = order.length ? order : Object.keys(run.nodes || {});
    const tasks = ids.map(sid => {
      const node = (run.nodes || {})[sid] || {};
      return {
        id: sid,
        name: node.taskName || sid,
        status: node.status || 'pending',
        code: (node.code !== undefined ? node.code : null),
        reason: node.reason || null,
        output: node.output || null,
        outputFormat: 'markdown'
      };
    });
    await replier(correlationId, {
      type: 'result',
      payload: {
        id: run.id,
        chainId: run.chainId,
        name: run.name,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        trigger: run.trigger || null,
        tasks,
        output: this._aggregateChainOutput(chain, run),
        outputFormat: 'markdown'
      }
    });
    return true;
  }

  // --- Boards & Insights ---
  // Boards and insights live in server.js with substantial resolution logic
  // (pin → live status, "where was I" briefings, cross-board insight generation).
  // Rather than duplicate any of that here, the handler calls the server's own
  // HTTP API over loopback (same process) so there is a single source of truth.

  _localBase() {
    return this.localBaseUrl || `http://127.0.0.1:${process.env.PORT || 3847}`;
  }

  async _localGet(pathname) {
    const resp = await fetch(this._localBase() + pathname, { headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error(`GET ${pathname} → ${resp.status}`);
    return resp.json();
  }

  async _localPost(pathname, body) {
    const resp = await fetch(this._localBase() + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!resp.ok) throw new Error(`POST ${pathname} → ${resp.status}`);
    return resp.json();
  }

  _teamNameFor(teamId) {
    if (!teamId) return null;
    const t = this._loadTeams().find(o => o.id === teamId);
    return t ? (t.name || teamId) : teamId;
  }

  // A light board card for the list: cached "where was I" snippet + badge counts.
  // No LLM call here — we read the last persisted summary so the list stays fast.
  _boardCard(b) {
    const summary = b.summary || null;
    const items = (summary && Array.isArray(summary.items)) ? summary.items : [];
    const lower = (s) => String(s || '').toLowerCase();
    const attention = items.filter(i => ['error', 'failed'].includes(lower(i.status))).length;
    const running = items.filter(i => lower(i.status) === 'running').length;
    const openChecklist = (Array.isArray(b.checklists) ? b.checklists : [])
      .reduce((n, cl) => n + (Array.isArray(cl.items) ? cl.items.filter(i => !i.done).length : 0), 0);
    const whereWasI = (summary && summary.text)
      ? String(summary.text).replace(/\s+/g, ' ').trim().slice(0, 180)
      : '';
    return {
      id: b.id,
      name: b.name,
      emoji: b.emoji || '📌',
      teamId: b.teamId || null,
      teamName: b.teamId ? this._teamNameFor(b.teamId) : null,
      enabled: b.enabled !== false,
      pinCount: Array.isArray(b.items) ? b.items.length : 0,
      noteCount: Array.isArray(b.notes) ? b.notes.length : 0,
      openChecklist,
      attention,
      running,
      whereWasI,
      summaryAt: (summary && summary.generatedAt) || null,
      updatedAt: b.updatedAt || b.createdAt || '',
    };
  }

  // Boards are team-scoped operations (each carries its own teamId). Under "all"
  // (memberIds null) show every non-archived board; under a team show only that
  // team's boards — mirrors the SPA's boardInCurrentTeam().
  async _listBoards(correlationId, payload, replier) {
    try {
      const teamId = this._payloadTeamId(payload);
      const memberIds = this._orgMemberIds(teamId);
      const boards = await this._localGet('/api/boards');
      const cards = (Array.isArray(boards) ? boards : [])
        .filter(b => !b.archived)
        .filter(b => this._opInOrg(memberIds, teamId, (b.teamId !== undefined ? b.teamId : b.orgId)))
        .map(b => this._boardCard(b))
        .sort((a, c) => String(c.updatedAt).localeCompare(String(a.updatedAt)));
      await replier(correlationId, { type: 'result', payload: { boards: cards } });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  async _getBoard(correlationId, payload, replier) {
    try {
      const { boardId, refresh } = payload || {};
      if (!boardId) { await replier(correlationId, { type: 'error', error: 'boardId is required' }); return true; }
      const board = await this._localGet('/api/boards/' + encodeURIComponent(boardId));
      if (!board || !board.id) { await replier(correlationId, { type: 'error', error: 'Board not found' }); return true; }

      // "Where was I" resolves every pinned item to its live status + a briefing.
      let briefing = null;
      try {
        briefing = await this._localPost('/api/boards/' + encodeURIComponent(boardId) + '/where-was-i', { force: !!refresh });
      } catch {}
      // Compliance: is the board blocked because pinned items aren't in its team?
      let compliance = null;
      try {
        compliance = await this._localGet('/api/boards/' + encodeURIComponent(boardId) + '/compliance');
      } catch {}

      const items = (briefing && Array.isArray(briefing.items))
        ? briefing.items
        : ((board.summary && Array.isArray(board.summary.items)) ? board.summary.items : []);

      await replier(correlationId, {
        type: 'result',
        payload: {
          id: board.id,
          name: board.name,
          emoji: board.emoji || '📌',
          teamId: board.teamId || null,
          teamName: board.teamId ? this._teamNameFor(board.teamId) : null,
          enabled: board.enabled !== false,
          blocked: !!(compliance && compliance.blocked),
          complianceIssues: (compliance && Array.isArray(compliance.issues))
            ? compliance.issues.map(i => ({
                itemId: i.itemId, kind: i.kind, label: i.label,
                problems: (Array.isArray(i.problems) ? i.problems : []).map(p => ({
                  kind: p.kind, role: p.role, opKind: p.opKind,
                  currentTeamName: p.currentTeamName || null,
                  employeeName: p.employeeName || null,
                })),
              }))
            : [],
          whereWasI: (briefing && briefing.summary) || (board.summary && board.summary.text) || '',
          whereWasIAt: (briefing && briefing.generatedAt) || (board.summary && board.summary.generatedAt) || null,
          items: items.map(it => ({
            id: it.id, kind: it.kind, refId: it.refId,
            label: it.label || it.refId, sublabel: it.sublabel || '',
            status: it.status || '', detail: it.detail || '', when: it.when || null,
          })),
          deltas: (briefing && Array.isArray(briefing.deltas)) ? briefing.deltas : [],
          notes: (Array.isArray(board.notes) ? board.notes : []).map(n => ({ id: n.id, text: n.text })),
          checklists: (Array.isArray(board.checklists) ? board.checklists : []).map(cl => ({
            id: cl.id, title: cl.title,
            items: (Array.isArray(cl.items) ? cl.items : []).map(i => ({ id: i.id, text: i.text, done: !!i.done })),
          })),
        },
      });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  _insightCard(v) {
    const content = v.content || null;
    const narrative = content && content.narrative
      ? String(content.narrative).replace(/\s+/g, ' ').trim().slice(0, 220)
      : '';
    return {
      id: v.id,
      name: v.name,
      emoji: v.emoji || '🔭',
      builtin: !!v.builtin,
      mode: v.mode,
      boardCount: content && Array.isArray(content.boards) ? content.boards.length : (Array.isArray(v.boardIds) ? v.boardIds.length : 0),
      checklistCount: content && Array.isArray(content.checklist) ? content.checklist.length : 0,
      calloutCount: content && Array.isArray(content.callouts) ? content.callouts.length : 0,
      narrative,
      generatedAt: (content && content.generatedAt) || null,
      generating: !!v.generating,
      error: v.error || null,
    };
  }

  _insightDetail(v) {
    const content = v.content || null;
    return {
      id: v.id,
      name: v.name,
      emoji: v.emoji || '🔭',
      builtin: !!v.builtin,
      mode: v.mode,
      generating: !!v.generating,
      error: v.error || null,
      generatedAt: (content && content.generatedAt) || null,
      narrative: (content && content.narrative) || '',
      checklist: content && Array.isArray(content.checklist)
        ? content.checklist.map(c => ({ title: c.title, why: c.why, boardId: c.boardId, priority: c.priority }))
        : [],
      callouts: content && Array.isArray(content.callouts)
        ? content.callouts.map(c => ({ type: c.type, text: c.text, boardId: c.boardId }))
        : [],
      boards: content && Array.isArray(content.boards)
        ? content.boards.map(b => ({ boardId: b.boardId, name: b.name, emoji: b.emoji, teamName: b.teamName, whereWasI: b.whereWasI }))
        : [],
    };
  }

  // Insights are GLOBAL cross-board "views" — not team-scoped (the built-in
  // Overview deliberately spans every team), so no team filtering here.
  async _listInsights(correlationId, payload, replier) {
    try {
      const insights = await this._localGet('/api/insights');
      const cards = (Array.isArray(insights) ? insights : []).map(v => this._insightCard(v));
      await replier(correlationId, { type: 'result', payload: { insights: cards } });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  async _getInsight(correlationId, payload, replier) {
    try {
      const { insightId } = payload || {};
      if (!insightId) { await replier(correlationId, { type: 'error', error: 'insightId is required' }); return true; }
      const v = await this._localGet('/api/insights/' + encodeURIComponent(insightId));
      if (!v || !v.id) { await replier(correlationId, { type: 'error', error: 'Insight not found' }); return true; }
      await replier(correlationId, { type: 'result', payload: this._insightDetail(v) });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  async _generateInsight(correlationId, payload, replier) {
    try {
      const { insightId } = payload || {};
      if (!insightId) { await replier(correlationId, { type: 'error', error: 'insightId is required' }); return true; }
      await replier(correlationId, { type: 'status-update', payload: { status: 'running', message: 'Generating insight…' } });
      await this._localPost('/api/insights/' + encodeURIComponent(insightId) + '/generate', {});
      // Re-read so the reply carries the full, freshly-persisted insight record.
      const v = await this._localGet('/api/insights/' + encodeURIComponent(insightId));
      await replier(correlationId, { type: 'result', payload: this._insightDetail(v) });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  async _listMachines(correlationId, replier) {
    if (!this.configSync || !this.configSync.enabled) {
      await replier(correlationId, { type: 'result', payload: { machines: [], selfId: null } });
      return true;
    }
    try {
      const machines = await this.configSync.listMachines();
      await replier(correlationId, { type: 'result', payload: { machines, selfId: this.configSync.machineId } });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  async _installFromMachine(correlationId, payload, replier) {
    if (typeof this.installFromMachine !== 'function') {
      await replier(correlationId, { type: 'error', error: 'Install is not available on this server' });
      return true;
    }
    const machineId = payload && payload.machineId;
    let items = payload && Array.isArray(payload.items) ? payload.items : null;
    if (!items && payload && payload.type && payload.id) items = [{ type: payload.type, id: payload.id }];
    try {
      const results = await this.installFromMachine(machineId, items);
      await replier(correlationId, { type: 'result', payload: { ok: true, ...results } });
    } catch (err) {
      await replier(correlationId, { type: 'error', error: err.message });
    }
    return true;
  }

  // --- Internal Helpers ---

  /**
   * Run one interactive agent chat turn through the resume-aware SDK chat path
   * (the same `sdkRunner.runChat` the SPA uses). The thread id is the SDK
   * session id; the session is kept alive between turns so the agent isn't
   * re-spun on every message. Streams assistant deltas to mobile as
   * streaming-chunk updates and resolves with the full assistant text.
   *
   * resume is true when we already have a session for this thread — either a
   * still-connected live session (same server process) or a persisted session
   * on disk (after a restart). The first turn of a brand-new thread is a fresh
   * session.
   */
  async _executeAgentChatTurn(agentId, threadId, message, correlationId, replier) {
    const entry = this.supervisor.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);
    const config = entry.config;

    const sessionExistsOnDisk = () => {
      try {
        return fs.existsSync(path.join(this._sessionStateDir(), threadId, 'events.jsonl'));
      } catch { return false; }
    };
    const resume = sdkRunner.hasLiveChat(threadId) || sessionExistsOnDisk();
    const chatModel = settings.resolveModel('chat', config);

    let chunkIdx = 0;
    const onChunk = (text) => {
      if (!text) return;
      chunkIdx++;
      replier(correlationId, {
        type: 'streaming-chunk',
        payload: { text, idx: chunkIdx, stream: 'stdout', isFinal: false }
      }).catch(() => {});
    };

    // Heartbeat keeps the mobile client's inactivity timer alive during long,
    // silent stretches where the agent emits no deltas for a while.
    const heartbeat = setInterval(() => {
      replier(correlationId, {
        type: 'status-update',
        payload: { status: 'processing', message: 'Still working…' }
      }).catch(() => {});
    }, 20000);

    let res;
    try {
      res = await sdkRunner.runChat({
        config,
        prompt: message,
        sessionId: threadId,
        resume,
        cwd: config && config.cwd,
        onChunk,
        model: chatModel,
      });
    } finally {
      clearInterval(heartbeat);
    }

    // Final chunk marker so the client knows streaming is done.
    replier(correlationId, {
      type: 'streaming-chunk',
      payload: { text: '', idx: chunkIdx + 1, isFinal: true }
    }).catch(() => {});

    if (!res || res.fallback || res.ok === false) {
      const errMsg = (res && res.error) || 'agent chat failed';
      // A stale/invalid resume target can fail; retry once as a fresh session
      // so the user still gets a reply instead of a dead conversation.
      if (resume) {
        const retry = await sdkRunner.runChat({
          config, prompt: message, sessionId: threadId, resume: false,
          cwd: config && config.cwd, onChunk, model: chatModel,
        }).catch(() => null);
        if (retry && !retry.fallback && retry.ok !== false) {
          this._recordChatUsage(targetId, config, retry);
          return { output: retry.output || '(no output)', model: retry.model || chatModel || '', usage: retry.usage || null };
        }
      }
      throw new Error(errMsg);
    }
    this._recordChatUsage(agentId, config, res);
    return { output: res.output || '(no output)', model: res.model || chatModel || '', usage: res.usage || null };
  }

  // Append a mobile agent chat turn to the canonical usage ledger.
  _recordChatUsage(agentId, config, res) {
    try {
      if (this.supervisor && typeof this.supervisor.recordUsage === 'function') {
        this.supervisor.recordUsage({
          ts: new Date().toISOString(),
          source: 'chat',
          refId: agentId || 'chat',
          label: (config && config.name) || agentId || 'Mobile Chat',
          model: res.model || '',
          status: res.ok === false ? 'error' : 'success',
          usage: res.usage || null,
        });
      }
    } catch (e) { /* non-fatal */ }
  }

  /**
   * Execute an agent and stream output chunks back to mobile
   */
  async _executeAgentWithStreaming(agentId, prompt, correlationId, replier, threadId) {
    const entry = this.supervisor.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);
    if (entry.running) throw new Error(`Agent ${agentId} is already running`);

    const originalPrompt = entry.config.prompt;
    entry.config.prompt = prompt;
    // Pin the copilot session so the conversation resumes/persists natively.
    if (threadId) entry._chatSessionId = threadId;

    const restore = () => {
      entry.config.prompt = originalPrompt;
      delete entry._chatSessionId;
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        restore();
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
        restore();
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
        restore();
        reject(new Error(data.error || 'Agent execution failed'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        this.supervisor.removeListener('agent-output', onOutput);
        this.supervisor.removeListener('agent-completed', onCompleted);
        this.supervisor.removeListener('agent-error', onError);
      };

      // Heartbeat keeps the mobile client's inactivity timer alive during long,
      // silent agent runs that emit no streaming output for a while.
      const heartbeat = setInterval(() => {
        replier(correlationId, {
          type: 'status-update',
          payload: { status: 'processing', message: 'Still working…' }
        }).catch(() => {});
      }, 20000);

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
