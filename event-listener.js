'use strict';

const { ServiceBusClient } = require('@azure/service-bus');
const { DefaultAzureCredential } = require('@azure/identity');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const CONFIG_FILE = path.join(__dirname, 'events-config.json');

/**
 * Event Listener — Service Bus consumer that routes external messages
 * to agents, managers, tasks, and assignments.
 * 
 * Message contract:
 *   { senderId, correlationId, content, replyTo? }
 * 
 * Routing:
 *   @name  → agent/manager session (conversational)
 *   /run name → task/assignment (fire-and-forget)
 *   /help  → list connected assets
 *   /close → close current session
 */
class EventListener extends EventEmitter {
  constructor(supervisor, managerAgent, db) {
    super();
    this.supervisor = supervisor;
    this.managerAgent = managerAgent;
    this.db = db;
    this.client = null;
    this.receiver = null;
    this.sender = null; // For reply queue
    this.connected = false;
    this.sessions = new Map(); // senderId → { target, targetType, startedAt, messages[] }
    this.eventLog = []; // Recent events for live log (also persisted)
    this.maxLogSize = 500;
    this.config = this._loadConfig();
    this._initDb();
  }

  _initDb() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        source TEXT,
        content TEXT,
        status TEXT,
        sender_id TEXT,
        correlation_id TEXT,
        target TEXT,
        target_type TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        target TEXT NOT NULL,
        target_type TEXT,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_dlq (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        correlation_id TEXT,
        content TEXT NOT NULL,
        error TEXT,
        attempts INTEGER DEFAULT 1,
        max_attempts INTEGER DEFAULT 3,
        status TEXT DEFAULT 'failed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at TEXT
      )
    `);
  }

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      return {
        connected: false,
        connectionString: '',
        namespace: '',
        queueName: 'inbound-commands',
        replyQueue: 'outbound-replies',
        maxSessions: 10,
        rateLimitPerUser: 20,
        rateLimitTotal: 100,
        sessionTimeout: 30,
        connectedAssets: [],
        users: [],
        autoReconnect: true,
        maxReconnectAttempts: 10
      };
    }
  }

  _saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Connection state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
   */
  get connectionState() {
    return this._connectionState || 'disconnected';
  }

  _setConnectionState(state) {
    const prev = this._connectionState;
    this._connectionState = state;
    if (prev !== state) {
      this.emit('connection-state', { state, previous: prev });
      this._logEvent('system', 'connection', `State: ${state}`, state);
    }
  }

  /**
   * Connect to Service Bus and start receiving messages
   */
  async connect() {
    if (this.connected) return;
    if ((!this.config.connectionString && !this.config.namespace) || !this.config.queueName) {
      throw new Error('Connection string (or namespace) and queue name are required');
    }

    this._reconnectAttempts = 0;
    this._intentionalDisconnect = false;
    await this._connect();
  }

  async _connect() {
    this._setConnectionState(this._reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      if (this.config.namespace) {
        // Azure AD auth via DefaultAzureCredential
        const fullyQualifiedNamespace = this.config.namespace.includes('.')
          ? this.config.namespace
          : `${this.config.namespace}.servicebus.windows.net`;
        this.client = new ServiceBusClient(fullyQualifiedNamespace, new DefaultAzureCredential());
      } else {
        this.client = new ServiceBusClient(this.config.connectionString);
      }
      this.receiver = this.client.createReceiver(this.config.queueName);
      
      // Set up reply sender if reply queue configured
      if (this.config.replyQueue) {
        this.sender = this.client.createSender(this.config.replyQueue);
      }

      // Start receiving
      this.receiver.subscribe({
        processMessage: async (message) => {
          await this._handleMessage(message);
        },
        processError: async (args) => {
          console.error('[event-listener] Service Bus error:', args.error.message);
          this._logEvent('error', 'system', `Service Bus error: ${args.error.message}`, 'error');
          
          // Check if this is a fatal disconnect
          if (this._isDisconnectError(args.error)) {
            this._handleDisconnect(args.error);
          }
        }
      });

      this.connected = true;
      this._reconnectAttempts = 0;
      this._setConnectionState('connected');
      this.config.connected = true;
      this._saveConfig();
      this._logEvent('system', 'listener', 'Connected to Service Bus', '');
      this.emit('connected');
    } catch (err) {
      this.connected = false;
      console.error('[event-listener] Connection failed:', err.message);
      
      if (this.config.autoReconnect !== false && !this._intentionalDisconnect) {
        this._scheduleReconnect(err);
      } else {
        this._setConnectionState('failed');
        throw err;
      }
    }
  }

  /**
   * Check if an error indicates a lost connection
   */
  _isDisconnectError(error) {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('disconnect') || msg.includes('connection lost') ||
           msg.includes('socket') || msg.includes('econnrefused') ||
           msg.includes('econnreset') || msg.includes('timeout') ||
           error.code === 'ServiceUnavailable' || error.code === 'MessagingEntityNotFound';
  }

  /**
   * Handle unexpected disconnect — attempt reconnect
   */
  _handleDisconnect(error) {
    if (this._intentionalDisconnect || this._connectionState === 'reconnecting') return;
    
    this.connected = false;
    this._logEvent('error', 'connection', `Disconnected: ${error.message}`, 'error');
    
    if (this.config.autoReconnect !== false) {
      this._scheduleReconnect(error);
    } else {
      this._setConnectionState('failed');
    }
  }

  /**
   * Schedule a reconnect with exponential backoff
   */
  _scheduleReconnect(error) {
    const maxAttempts = this.config.maxReconnectAttempts || 10;
    this._reconnectAttempts++;

    if (this._reconnectAttempts > maxAttempts) {
      this._setConnectionState('failed');
      this._logEvent('error', 'connection', `Reconnect failed after ${maxAttempts} attempts. Manual reconnect required.`, 'error');
      this.emit('reconnect-failed', { attempts: this._reconnectAttempts, lastError: error });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000);
    this._setConnectionState('reconnecting');
    this._logEvent('system', 'connection', `Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${maxAttempts})...`, '');

    // Clean up old resources before reconnecting
    this._cleanup();

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this._connect();
      } catch (err) {
        // _connect will schedule next attempt internally
      }
    }, delay);
  }

  /**
   * Clean up Service Bus resources without state changes
   */
  _cleanup() {
    try { if (this.receiver) this.receiver.close().catch(() => {}); } catch {}
    try { if (this.sender) this.sender.close().catch(() => {}); } catch {}
    try { if (this.client) this.client.close().catch(() => {}); } catch {}
    this.receiver = null;
    this.sender = null;
    this.client = null;
  }

  /**
   * Disconnect from Service Bus (intentional)
   */
  async disconnect() {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    await this._cleanup();
    this.connected = false;
    this.config.connected = false;
    this._saveConfig();
    this._setConnectionState('disconnected');
    this._logEvent('system', 'listener', 'Disconnected from Service Bus', '');
    this.emit('disconnected');
  }

  /**
   * Handle an inbound message from Service Bus
   */
  async _handleMessage(message) {
    const body = message.body;
    const correlationId = body?.correlationId || message.correlationId || Date.now().toString();

    // Mobile protocol: structured JSON with a 'type' field
    if (this.mobileHandler && this.mobileHandler.isMobileMessage(body)) {
      const senderId = body.senderId || message.applicationProperties?.senderId || 'mobile';
      this._logEvent('inbound', senderId, `[mobile] ${body.type}`, 'received');

      // Validate sender (skip for get-status which is lightweight)
      if (body.type !== 'get-status' && !this._validateSender(senderId)) {
        this._logEvent('error', senderId, 'REJECTED: unknown sender', 'denied');
        await this._reply(correlationId, senderId, { type: 'error', error: 'Unauthorized.' });
        return;
      }

      // Rate limit
      if (!this._checkRateLimit(senderId)) {
        await this._reply(correlationId, senderId, { type: 'error', error: 'Rate limit exceeded.' });
        return;
      }

      // Create a replier function that uses our reply queue
      const replier = async (corrId, payload) => {
        await this._reply(corrId, senderId, payload);
      };

      try {
        await this.mobileHandler.handle(body, replier);
      } catch (err) {
        this._logEvent('error', 'mobile-handler', `Error: ${err.message}`, 'error');
        await this._reply(correlationId, senderId, { type: 'error', error: err.message });
      }
      return;
    }

    // Legacy text-based protocol
    const content = (typeof body === 'string' ? body : body?.content || '').trim();

    if (!content) return;

    // Identity: if token validation is enabled, extract senderId from verified token
    let senderId;
    if (this.config.requireTokenAuth) {
      const token = message.applicationProperties?.authToken || body?.authToken;
      if (!token) {
        this._logEvent('error', 'unknown', 'REJECTED: no auth token provided', 'denied');
        await this._reply(correlationId, 'unknown', { status: 'error', error: 'Authentication required. Include authToken in message.' });
        return;
      }
      const identity = await this._verifyToken(token);
      if (!identity) {
        this._logEvent('error', 'unknown', 'REJECTED: invalid or expired token', 'denied');
        await this._reply(correlationId, 'unknown', { status: 'error', error: 'Invalid or expired token.' });
        return;
      }
      senderId = identity;
    } else {
      // Trust senderId from message (legacy mode)
      senderId = body?.senderId || message.applicationProperties?.senderId || 'unknown';
    }

    this._logEvent('inbound', senderId, content, 'received');

    // Validate sender against RBAC
    if (!this._validateSender(senderId)) {
      this._logEvent('error', senderId, `REJECTED: unknown sender, no RBAC entry`, 'denied');
      await this._reply(correlationId, senderId, { status: 'error', error: 'Unauthorized. Use /help for available commands.' });
      return;
    }

    // Rate limiting
    if (!this._checkRateLimit(senderId)) {
      this._logEvent('error', senderId, 'Rate limit exceeded', 'denied');
      await this._reply(correlationId, senderId, { status: 'error', error: 'Rate limit exceeded. Please wait.' });
      return;
    }

    // Route the message
    try {
      await this._route(senderId, correlationId, content);
    } catch (err) {
      this._logEvent('error', 'router', `Routing error: ${err.message}`, 'error');
      await this._reply(correlationId, senderId, { status: 'error', error: err.message });
      this._deadLetter(senderId, correlationId, content, err.message);
    }
  }

  /**
   * Dead-letter a failed message for later review/retry
   */
  _deadLetter(senderId, correlationId, content, error) {
    if (!this.db) return;
    try {
      this.db.prepare(
        'INSERT INTO event_dlq (sender_id, correlation_id, content, error, last_attempt_at) VALUES (?, ?, ?, ?, ?)'
      ).run(senderId, correlationId, content, error, new Date().toISOString());
    } catch (err) {
      console.error('[event-listener] DLQ write failed:', err.message);
    }
  }

  /**
   * Get dead-lettered messages for UI review
   */
  getDLQ(options = {}) {
    if (!this.db) return [];
    const { limit = 50, status = 'failed' } = options;
    return this.db.prepare(
      'SELECT * FROM event_dlq WHERE status = ? ORDER BY id DESC LIMIT ?'
    ).all(status, limit);
  }

  /**
   * Retry a dead-lettered message
   */
  async retryDLQ(dlqId) {
    if (!this.db) throw new Error('No database');
    const entry = this.db.prepare('SELECT * FROM event_dlq WHERE id = ?').get(dlqId);
    if (!entry) throw new Error('DLQ entry not found');
    if (entry.attempts >= entry.max_attempts) {
      this.db.prepare('UPDATE event_dlq SET status = ? WHERE id = ?').run('exhausted', dlqId);
      throw new Error(`Max retry attempts (${entry.max_attempts}) exceeded`);
    }

    this.db.prepare('UPDATE event_dlq SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?')
      .run(new Date().toISOString(), dlqId);

    try {
      await this._route(entry.sender_id, entry.correlation_id, entry.content);
      this.db.prepare('UPDATE event_dlq SET status = ? WHERE id = ?').run('resolved', dlqId);
      return { ok: true };
    } catch (err) {
      this.db.prepare('UPDATE event_dlq SET error = ? WHERE id = ?').run(err.message, dlqId);
      if (entry.attempts + 1 >= entry.max_attempts) {
        this.db.prepare('UPDATE event_dlq SET status = ? WHERE id = ?').run('exhausted', dlqId);
      }
      throw err;
    }
  }

  /**
   * Dismiss a DLQ entry (mark as acknowledged)
   */
  dismissDLQ(dlqId) {
    if (!this.db) return;
    this.db.prepare('UPDATE event_dlq SET status = ? WHERE id = ?').run('dismissed', dlqId);
  }

  /**
   * Route a message based on its content pattern
   */
  async _route(senderId, correlationId, content) {
    // /help — list connected assets
    if (content.toLowerCase() === '/help') {
      const help = this._buildHelpResponse();
      await this._reply(correlationId, senderId, { status: 'complete', content: help });
      this._logEvent('outbound', 'system', help.substring(0, 100), 'sent');
      return;
    }

    // /close — close active session
    if (content.toLowerCase() === '/close') {
      const session = this.sessions.get(senderId);
      if (session) {
        this.sessions.delete(senderId);
        this._logEvent('system', 'router', `Session closed: ${senderId} → ${session.target}`, '');
        await this._reply(correlationId, senderId, { status: 'complete', content: 'Session closed.' });
      } else {
        await this._reply(correlationId, senderId, { status: 'complete', content: 'No active session.' });
      }
      return;
    }

    // /run <name> — fire-and-forget task/assignment execution
    const runMatch = content.match(/^\/run\s+(.+)$/i);
    if (runMatch) {
      const taskName = runMatch[1].trim();
      await this._runTask(senderId, correlationId, taskName);
      return;
    }

    // @name <message> — route to agent/manager session
    const mentionMatch = content.match(/^@(\S+)\s*(.*)?$/s);
    if (mentionMatch) {
      const targetName = mentionMatch[1].toLowerCase();
      const message = (mentionMatch[2] || '').trim();
      await this._routeToSession(senderId, correlationId, targetName, message);
      return;
    }

    // No prefix — route to active session if one exists
    const existingSession = this.sessions.get(senderId);
    if (existingSession) {
      await this._sendToSession(senderId, correlationId, existingSession, content);
      return;
    }

    // Unknown command
    await this._reply(correlationId, senderId, {
      status: 'error',
      error: 'Unknown command. Use @name to address an agent/manager, /run to execute a task, or /help for available commands.'
    });
  }

  /**
   * Run a task or assignment by name
   */
  async _runTask(senderId, correlationId, taskName) {
    const asset = this.config.connectedAssets.find(a =>
      (a.type === 'task' || a.type === 'assignment') &&
      (a.name.toLowerCase() === taskName.toLowerCase() || a.id.toLowerCase() === taskName.toLowerCase())
    );

    if (!asset) {
      await this._reply(correlationId, senderId, { status: 'error', error: `Task "${taskName}" not found or not connected.` });
      return;
    }

    this._logEvent('system', 'router', `Task dispatched: ${asset.name} (fire-and-forget)`, '');

    // Execute via supervisor
    try {
      const result = await this._executeTask(asset);
      await this._reply(correlationId, senderId, { status: 'complete', content: result });
      this._logEvent('outbound', asset.name, (result || '').substring(0, 80), 'sent');
    } catch (err) {
      await this._reply(correlationId, senderId, { status: 'error', error: `Task failed: ${err.message}` });
    }
  }

  /**
   * Route to an agent/manager session
   */
  async _routeToSession(senderId, correlationId, targetName, message) {
    const asset = this.config.connectedAssets.find(a =>
      (a.type === 'agent' || a.type === 'manager') &&
      (a.name.toLowerCase() === targetName || a.id.toLowerCase() === targetName)
    );

    if (!asset) {
      await this._reply(correlationId, senderId, { status: 'error', error: `"${targetName}" not found or not connected. Use /help to see available assets.` });
      return;
    }

    // Check if different from current session → close old one
    const existing = this.sessions.get(senderId);
    if (existing && existing.target !== asset.id) {
      this._logEvent('system', 'router', `Session switch: ${senderId} closed ${existing.target}, opening ${asset.id}`, '');
      this._persistSessionClose(senderId, existing);
      this.sessions.delete(senderId);
    }

    // Create or reuse session
    if (!this.sessions.has(senderId) || this.sessions.get(senderId).target !== asset.id) {
      const session = {
        target: asset.id,
        targetName: asset.name,
        targetType: asset.type,
        startedAt: new Date().toISOString(),
        messages: [],
        lastActivity: Date.now()
      };
      this.sessions.set(senderId, session);
      this._persistSessionOpen(senderId, session);
      this._logEvent('system', 'router', `Session created: ${senderId} → ${asset.name}`, '');
    }

    const session = this.sessions.get(senderId);
    if (message) {
      await this._sendToSession(senderId, correlationId, session, message);
    } else {
      await this._reply(correlationId, senderId, { status: 'complete', content: `Connected to ${asset.name}. Send your message.` });
    }
  }

  /**
   * Send a message to an active session's target
   */
  async _sendToSession(senderId, correlationId, session, content) {
    session.messages.push({ role: 'user', content, timestamp: new Date().toISOString() });
    session.lastActivity = Date.now();

    try {
      let result;
      if (session.targetType === 'manager') {
        result = await this._executeManagerPrompt(session.target, content);
      } else {
        result = await this._executeAgentPrompt(session.target, content);
      }

      session.messages.push({ role: 'assistant', content: result, timestamp: new Date().toISOString() });
      await this._reply(correlationId, senderId, { status: 'complete', content: result });
      this._logEvent('outbound', session.targetName, (result || '').substring(0, 80), 'sent');
    } catch (err) {
      await this._reply(correlationId, senderId, { status: 'error', error: `Execution failed: ${err.message}` });
      this._logEvent('error', session.targetName, err.message, 'error');
    }
  }

  /**
   * Execute an agent prompt via the supervisor.
   * Spawns the agent with a custom prompt and collects output via events.
   */
  async _executeAgentPrompt(agentId, prompt) {
    const entry = this.supervisor.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);
    if (entry.running) throw new Error(`Agent ${agentId} is already running`);

    // Temporarily override the agent prompt, execute, then restore
    const originalPrompt = entry.config.prompt;
    entry.config.prompt = prompt;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Agent ${agentId} timed out after 5 minutes`));
      }, 5 * 60 * 1000);

      const onCompleted = (data) => {
        if (data.agentId !== agentId) return;
        cleanup();
        entry.config.prompt = originalPrompt;
        resolve(data.output || '(no output)');
      };

      const onError = (data) => {
        if (data.agentId !== agentId) return;
        cleanup();
        entry.config.prompt = originalPrompt;
        reject(data.error || new Error('Agent execution failed'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.supervisor.removeListener('agent-completed', onCompleted);
        this.supervisor.removeListener('agent-error', onError);
      };

      this.supervisor.on('agent-completed', onCompleted);
      this.supervisor.on('agent-error', onError);

      // Trigger execution
      this.supervisor._executeAgent(agentId);
    });
  }

  /**
   * Execute a manager prompt synchronously (waits for orchestration to complete)
   */
  async _executeManagerPrompt(managerId, prompt) {
    const result = await this.managerAgent.executePrompt(managerId, prompt, null, { sync: true });
    return result?.result || result?.output || '(no output)';
  }

  /**
   * Execute a task/assignment by asset reference
   */
  async _executeTask(asset) {
    if (asset.type === 'assignment') {
      // Assignment IDs are stored as "managerId/assignmentId"
      const separatorIdx = asset.id.indexOf('/');
      if (separatorIdx === -1) throw new Error(`Invalid assignment ID format: ${asset.id}`);
      const managerId = asset.id.substring(0, separatorIdx);
      const assignmentId = asset.id.substring(separatorIdx + 1);
      
      // runAssignment looks up the assignment's prompt and runs orchestration
      const result = await this.managerAgent.runAssignment(managerId, assignmentId);
      return result?.result || result?.output || '(completed)';
    } else {
      // Task = agent execution with its configured prompt
      return this._executeAgentPrompt(asset.id, this._getAgentPrompt(asset.id));
    }
  }

  _getAgentPrompt(agentId) {
    const entry = this.supervisor.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);
    return entry.config.prompt;
  }

  /**
   * Send a reply to the sender via the reply queue
   */
  async _reply(correlationId, senderId, payload) {
    if (!this.sender) return; // No reply queue configured
    
    try {
      await this.sender.sendMessages({
        body: { ...payload, senderId, correlationId, timestamp: new Date().toISOString() },
        correlationId,
        applicationProperties: { senderId }
      });
    } catch (err) {
      console.error('[event-listener] Reply send failed:', err.message);
    }
  }

  /**
   * Check whether a userId/name corresponds to an approved RBAC user.
   * This is the single source of truth for "is this identity allowed".
   */
  isApprovedUser(userId) {
    if (!userId) return false;
    if (!Array.isArray(this.config.users) || this.config.users.length === 0) return false;
    return this.config.users.some(u => u.id === userId || u.name === userId);
  }

  /**
   * Validate sender has RBAC access
   */
  _validateSender(senderId) {
    if (!Array.isArray(this.config.users) || this.config.users.length === 0) return false; // No users = reject all
    return this.isApprovedUser(senderId);
  }

  /**
   * Verify an Azure AD JWT token. Returns the sender identity (oid or upn) or null.
   */
  async _verifyToken(token) {
    const tenantId = this.config.tenantId;
    if (!tenantId) {
      console.error('[event-listener] Token auth enabled but no tenantId configured');
      return null;
    }

    // Lazily create JWKS client for this tenant
    if (!this._jwksClient || this._jwksTenant !== tenantId) {
      this._jwksClient = jwksClient({
        jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
        cache: true,
        cacheMaxAge: 600000, // 10 min
        rateLimit: true
      });
      this._jwksTenant = tenantId;
    }

    try {
      // Decode header to get kid
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header?.kid) return null;

      // Get signing key
      const key = await this._jwksClient.getSigningKey(decoded.header.kid);
      const signingKey = key.getPublicKey();

      // Verify token
      const payload = jwt.verify(token, signingKey, {
        issuer: [
          `https://login.microsoftonline.com/${tenantId}/v2.0`,
          `https://sts.windows.net/${tenantId}/`
        ],
        audience: this.config.tokenAudience || undefined,
        algorithms: ['RS256']
      });

      // Return identity: prefer upn (user@domain), fall back to oid (GUID)
      return payload.upn || payload.preferred_username || payload.oid || null;
    } catch (err) {
      console.error('[event-listener] Token verification failed:', err.message);
      return null;
    }
  }

  /**
   * Check rate limiting for sender
   */
  _checkRateLimit(senderId) {
    // Simple in-memory rate limiter
    if (!this._rateLimits) this._rateLimits = new Map();
    
    const now = Date.now();
    const window = 60000; // 1 minute
    const userConfig = this.config.users.find(u => u.id === senderId || u.name === senderId);
    const limit = userConfig?.rateLimit || this.config.rateLimitPerUser || 20;
    
    if (limit === 0) return true; // Unlimited

    let bucket = this._rateLimits.get(senderId);
    if (!bucket) {
      bucket = { count: 0, windowStart: now };
      this._rateLimits.set(senderId, bucket);
    }

    if (now - bucket.windowStart > window) {
      bucket.count = 0;
      bucket.windowStart = now;
    }

    bucket.count++;
    return bucket.count <= limit;
  }

  /**
   * Build /help response listing connected assets
   */
  _buildHelpResponse() {
    const lines = ['## Available Commands\n'];
    
    const agents = this.config.connectedAssets.filter(a => a.type === 'agent');
    const managers = this.config.connectedAssets.filter(a => a.type === 'manager');
    const tasks = this.config.connectedAssets.filter(a => a.type === 'task' || a.type === 'assignment');

    if (managers.length) {
      lines.push('**Managers** (use `@name <message>`):');
      managers.forEach(m => lines.push(`  • @${m.name.toLowerCase().replace(/\s+/g, '-')}`));
      lines.push('');
    }
    if (agents.length) {
      lines.push('**Agents** (use `@name <message>`):');
      agents.forEach(a => lines.push(`  • @${a.name.toLowerCase().replace(/\s+/g, '-')}`));
      lines.push('');
    }
    if (tasks.length) {
      lines.push('**Tasks** (use `/run name`):');
      tasks.forEach(t => lines.push(`  • /run ${t.name.toLowerCase().replace(/\s+/g, '-')}`));
      lines.push('');
    }

    lines.push('**Other commands:**');
    lines.push('  • `/help` — Show this help');
    lines.push('  • `/close` — Close current session');

    return lines.join('\n');
  }

  /**
   * Log an event to the in-memory event log
   */
  _logEvent(type, sender, content, status, extra = {}) {
    const event = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      sender,
      content,
      status,
      timestamp: new Date().toISOString().split('T')[1].split('.')[0] + '.' + Date.now().toString().slice(-3)
    };
    this.eventLog.unshift(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.length = this.maxLogSize;
    }
    this.emit('event', event);

    // Persist to SQLite
    if (this.db) {
      try {
        this.db.prepare(
          'INSERT INTO event_history (type, source, content, status, sender_id, correlation_id, target, target_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(type, sender, (content || '').substring(0, 2000), status || '', extra.senderId || sender, extra.correlationId || '', extra.target || '', extra.targetType || '', new Date().toISOString());
      } catch (err) {
        console.error('[event-listener] Failed to persist event:', err.message);
      }
    }

    return event;
  }

  /**
   * Get active sessions info for the UI
   */
  getSessionsInfo() {
    const sessions = [];
    for (const [senderId, session] of this.sessions) {
      const duration = Date.now() - new Date(session.startedAt).getTime();
      sessions.push({
        id: `${senderId}-${session.target}`,
        user: senderId,
        target: `${session.targetType === 'manager' ? '👔' : '🤖'} ${session.targetName}`,
        lastMessage: session.messages.length ? session.messages[session.messages.length - 1].content.substring(0, 60) : '',
        messageCount: session.messages.length,
        duration: this._formatDuration(duration),
        status: 'active',
        startedAt: session.startedAt
      });
    }
    return sessions;
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  }

  /**
   * Clean up idle sessions
   */
  cleanupIdleSessions() {
    const timeout = (this.config.sessionTimeout || 30) * 60 * 1000;
    const now = Date.now();
    for (const [senderId, session] of this.sessions) {
      if (now - session.lastActivity > timeout) {
        this._persistSessionClose(senderId, session);
        this.sessions.delete(senderId);
        this._logEvent('system', 'cleanup', `Session expired: ${senderId} → ${session.targetName}`, '');
      }
    }
  }

  /**
   * Persist session open to SQLite
   */
  _persistSessionOpen(senderId, session) {
    if (!this.db) return;
    try {
      this.db.prepare(
        'INSERT INTO event_sessions (sender_id, target, target_type, started_at, status) VALUES (?, ?, ?, ?, ?)'
      ).run(senderId, session.target, session.targetType, session.startedAt, 'active');
    } catch (err) {
      console.error('[event-listener] Failed to persist session open:', err.message);
    }
  }

  /**
   * Persist session close to SQLite
   */
  _persistSessionClose(senderId, session) {
    if (!this.db) return;
    try {
      this.db.prepare(
        'UPDATE event_sessions SET closed_at = ?, message_count = ?, status = ? WHERE sender_id = ? AND target = ? AND status = ?'
      ).run(new Date().toISOString(), session.messages.length, 'closed', senderId, session.target, 'active');
    } catch (err) {
      console.error('[event-listener] Failed to persist session close:', err.message);
    }
  }

  /**
   * Get persisted event history from SQLite (for History tab)
   */
  getHistory(options = {}) {
    if (!this.db) return { events: [], stats: {} };
    const { limit = 200, offset = 0, type, since } = options;

    let query = 'SELECT * FROM event_history';
    const conditions = [];
    const params = [];

    if (type) { conditions.push('type = ?'); params.push(type); }
    if (since) { conditions.push('created_at >= ?'); params.push(since); }

    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const events = this.db.prepare(query).all(...params);

    // Stats
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN type = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN type = 'outbound' THEN 1 ELSE 0 END) as outbound,
        SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END) as errors
      FROM event_history
    `).get();

    return { events, stats };
  }

  /**
   * Get persisted session history from SQLite
   */
  getSessionHistory(options = {}) {
    if (!this.db) return [];
    const { limit = 50, status } = options;
    let query = 'SELECT * FROM event_sessions';
    const params = [];
    if (status) { query += ' WHERE status = ?'; params.push(status); }
    query += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(query).all(...params);
  }
}

module.exports = EventListener;
