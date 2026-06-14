// sdk-runner.js
// Phase 2 of the @github/copilot-sdk migration.
//
// The official SDK's createSession()/resumeSession()/sendAndWait()/getEvents()
// API is now the SOLE runtime for agent runs, chains, the manager, and
// interactive chat. The legacy `copilot` CLI child_process.spawn was removed in
// Phase 5 — there is no longer a CLI fallback.
//
// SDK_RUN_MODE is retained only as vestigial gating for run-routing helpers
// (shouldUse / mode), used by chains and the manager. In production it is 'all'.
//   off            - shouldUse() returns false (legacy gate; runs still SDK-only)
//   canary         - opt-in via config.runtime === 'sdk' or SDK_RUN_AGENTS
//   all            - every agent routes through the SDK runner
// Note: interactive chat (runChat) ignores this gate and runs whenever the SDK
// package is available.
//
// Agent resolution (proven by experiments/sdk-spike/phase2-spike2.mjs):
//   - PLUGIN agents (config.pluginDir set): loaded via pluginDirectories; the
//     SDK reads plugin.json + agents/ + .mcp.json + skills/ with no manual
//     parsing. agent name is the full "plugin:agent" string.
//   - PROJECT agents: parse <cwd>/.github/agents/<slug>.agent.md (YAML
//     frontmatter name/description/tools + markdown body = prompt) into a
//     CustomAgentConfig and pass via customAgents + agent.
//
// The module degrades gracefully: resolution/start failures return
// { ok:false, fallback:true } so the caller can record a terminal failure
// (the CLI spawn fallback was removed in Phase 5). It never throws.

const fs = require('fs');
const path = require('path');

let SDK = null;
let approveAll = null;
let yaml = null;
try {
  const mod = require('@github/copilot-sdk');
  SDK = mod.CopilotClient;
  approveAll = mod.approveAll;
} catch (e) {
  // SDK not installed - runner stays disabled.
}
try {
  yaml = require('js-yaml');
} catch (e) {
  // js-yaml missing - project-agent parsing disabled (plugin agents still work).
}

const SEP = '\n\n---\n\n';
const VALID_MODES = ['off', 'canary', 'all'];
const deny = () => ({ kind: 'deny', message: 'sdk-runner: permission denied (allowAll disabled)' });

class SdkRunner {
  constructor() {
    const raw = (process.env.SDK_RUN_MODE || 'off').toLowerCase();
    this._mode = VALID_MODES.includes(raw) ? raw : 'off';
    this._allowlist = new Set(
      (process.env.SDK_RUN_AGENTS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
    this._timeoutMs = parseInt(process.env.SDK_RUN_TIMEOUT_MS || '', 10) || 1800000; // 30 min
    this._client = null;
    this._starting = null;
    this._failures = 0;
    this._available = !!SDK;
    // Live interactive-chat sessions kept connected between turns so each new
    // message reuses the same agent process instead of re-spinning it ("starting
    // agent" on every turn). Keyed by sessionId -> { session, lastUsed, timer }.
    // Evicted (disconnected) after SDK_CHAT_IDLE_MS of inactivity.
    this._liveSessions = new Map();
    this._liveTtlMs = parseInt(process.env.SDK_CHAT_IDLE_MS || '', 10) || 600000; // 10 min
  }

  /** (Re)arm the idle eviction timer for a kept-alive chat session. */
  _scheduleEvict(sessionId, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      this._liveSessions.delete(sessionId);
      try { await entry.session.disconnect(); } catch (_) { /* ignore */ }
    }, this._liveTtlMs);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
  }

  /** Explicitly close a kept-alive chat session (e.g. when a chat is closed). */
  async closeChatSession(sessionId) {
    const entry = this._liveSessions.get(sessionId);
    if (!entry) return false;
    this._liveSessions.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    try { await entry.session.disconnect(); } catch (_) { /* ignore */ }
    return true;
  }

  get mode() {
    return this._available && this._mode !== 'off' ? this._mode : 'off';
  }

  /** Should this agent run via the SDK runner instead of the CLI spawn? */
  shouldUse(config) {
    if (this.mode === 'off' || !config) return false;
    if (this.mode === 'all') return true;
    // canary: opt-in only
    return config.runtime === 'sdk' || this._allowlist.has(config.id);
  }

  async _getClient() {
    // Client availability is decoupled from SDK_RUN_MODE: interactive chat
    // (runChat) needs a client even when the run-routing gate is 'off'.
    if (!this._available) return null;
    if (this._client) return this._client;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      try {
        const c = new SDK({ useLoggedInUser: true, logLevel: 'error' });
        await c.start();
        this._client = c;
        this._failures = 0;
        return c;
      } catch (e) {
        this._failures++;
        if (this._failures >= 3) {
          this._available = false;
          console.error('[sdk-runner] disabled after repeated start failures:', e.message);
        } else {
          console.error('[sdk-runner] client start failed (will retry):', e.message);
        }
        return null;
      } finally {
        this._starting = null;
      }
    })();
    return this._starting;
  }

  /**
   * Parse a <cwd>/.github/agents/*.agent.md file into a CustomAgentConfig.
   * Returns null on read/parse failure.
   */
  _parseAgentMd(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (!m) {
        return { name: path.basename(file).replace(/\.agent\.md$/, ''), prompt: raw.trim() || '(no body)', tools: null };
      }
      const fm = (yaml && yaml.load(m[1])) || {};
      return {
        name: fm.name || path.basename(file).replace(/\.agent\.md$/, ''),
        displayName: fm.name,
        description: fm.description,
        tools: Array.isArray(fm.tools) ? fm.tools : null,
        prompt: (m[2] || '').trim() || '(no body)',
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Find the project-agent .agent.md in <cwd>/.github/agents whose frontmatter
   * name (or file slug) matches config.agent. Returns CustomAgentConfig or null.
   */
  _resolveProjectAgent(config) {
    if (!config.cwd) return null;
    const agentsDir = path.join(config.cwd, '.github', 'agents');
    let files;
    try {
      files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
    } catch (e) {
      return null;
    }
    const want = (config.agent || config.name || '').trim().toLowerCase();
    let fallback = null;
    for (const f of files) {
      const cfg = this._parseAgentMd(path.join(agentsDir, f));
      if (!cfg) continue;
      const slug = f.replace(/\.agent\.md$/, '').toLowerCase();
      if ((cfg.name || '').toLowerCase() === want || slug === want) return cfg;
      if (!fallback) fallback = cfg;
    }
    // If exactly one agent file exists, use it even if the name didn't match.
    if (files.length === 1 && fallback) return fallback;
    return null;
  }

  /** Compact a tool's arguments object into a short one-line summary. */
  _summarizeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    try {
      const s = JSON.stringify(args);
      return s.length > 300 ? s.slice(0, 300) + '…' : s;
    } catch (_) {
      return '';
    }
  }

  /**
   * Build an ordered, display-ready step list (sub-agent selection, extended
   * thinking, and tool calls with outcomes) from a session's getEvents() output.
   * Shape matches the frontend msg-activity renderer: { type, label, text }.
   */
  _buildSteps(events) {
    const steps = [];
    const toolStarts = Object.create(null);
    for (const ev of events || []) {
      const t = ev && ev.type;
      const d = (ev && ev.data) || {};
      if (t === 'subagent.selected') {
        steps.push({ type: 'run_agent', label: '🤖 Agent: ' + (d.agentDisplayName || d.agentName || 'subagent'), text: '' });
      } else if (t === 'assistant.reasoning' && d.content) {
        steps.push({ type: 'thinking', label: '💭 Thinking', text: String(d.content).slice(0, 4000) });
      } else if (t === 'tool.execution_start') {
        if (d.toolCallId) toolStarts[d.toolCallId] = { name: d.toolName, args: d.arguments };
      } else if (t === 'tool.execution_complete') {
        const s = (d.toolCallId && toolStarts[d.toolCallId]) || {};
        const name = s.name || d.toolName || 'tool';
        const ok = d.success !== false && !d.error;
        const errMsg = d.error && (d.error.message || d.error.name);
        const argStr = this._summarizeArgs(s.args);
        steps.push({
          type: ok ? 'tool' : 'error',
          label: '🔧 ' + name + (ok ? ' ✓' : ' ✗'),
          text: ok ? argStr : (String(errMsg || 'failed').slice(0, 1000)),
        });
      }
    }
    return steps;
  }

  /** Load mcpServers from config.mcpConfig (an .mcp.json path), if present. */
  _loadMcpServers(config) {
    if (!config.mcpConfig) return null;
    try {
      const p = path.isAbsolute(config.mcpConfig)
        ? config.mcpConfig
        : path.resolve(config.cwd || '.', config.mcpConfig);
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      return json.mcpServers || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Run an agent via the SDK. Streams assistant deltas through onChunk(text).
   * @returns {Promise<{ok:boolean, fallback?:boolean, code:number, output:string,
   *   error:string, sessionId:string|null, eventCount?:number}>}
   * On a resolution failure the result has fallback:true so the caller can
   * record a terminal failure (no CLI fallback remains).
   */
  async runAgent({ config, prompt, sessionId, onChunk }) {
    if (this.mode === 'off') {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner-off', sessionId };
    }

    // Resolve agent wiring up front so we can fall back before touching the SDK.
    const opts = {
      sessionId,
      workingDirectory: config.cwd,
      streaming: true,
      onPermissionRequest: config.allowAll !== false ? approveAll : deny,
    };

    if (config.pluginDir && fs.existsSync(config.pluginDir)) {
      opts.pluginDirectories = [config.pluginDir];
      opts.agent = config.agent;
    } else {
      const agentCfg = this._resolveProjectAgent(config);
      if (!agentCfg) {
        return {
          ok: false,
          fallback: true,
          code: -1,
          output: '',
          error: `sdk-runner: could not resolve agent "${config.agent}" (no pluginDir, no matching .github/agents/*.agent.md under ${config.cwd})`,
          sessionId,
        };
      }
      opts.customAgents = [agentCfg];
      opts.agent = agentCfg.name;
      const mcp = this._loadMcpServers(config);
      if (mcp) opts.mcpServers = mcp;
    }

    return this._execute(opts, prompt, sessionId, onChunk);
  }

  /**
   * Run a one-off prompt with NO custom agent (the default copilot), e.g. the
   * chain AI judge / condition evaluator. Same result/fallback contract as
   * runAgent. Only enabled when mode !== 'off'.
   * @returns {Promise<{ok:boolean, fallback?:boolean, code:number, output:string,
   *   error:string, sessionId:string|null, eventCount?:number, steps?:Array}>}
   */
  async runPrompt({ prompt, cwd, sessionId, onChunk }) {
    if (this.mode === 'off') {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner-off', sessionId };
    }
    const opts = {
      sessionId,
      workingDirectory: cwd || process.cwd(),
      streaming: true,
      onPermissionRequest: approveAll,
    };
    return this._execute(opts, prompt, sessionId, onChunk);
  }

  /**
   * Interactive chat turn via the SDK. For a NEW session pass resume:false and a
   * config (agent wiring is resolved exactly like runAgent); for a follow-up turn
   * pass resume:true and the existing sessionId (the agent is already baked into
   * the persisted session, so no wiring is needed). Streams assistant deltas
   * through onChunk(deltaText). Same result/fallback contract as runAgent.
   * Unlike runAgent/runPrompt, chat is NOT gated by SDK_RUN_MODE — it runs
   * whenever the SDK package is available.
   * @returns {Promise<{ok:boolean, fallback?:boolean, code:number, output:string,
   *   error:string, sessionId:string|null, eventCount?:number, steps?:Array}>}
   */
  async runChat({ config, prompt, sessionId, resume, cwd, onChunk }) {
    if (!this._available) {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner: SDK unavailable', sessionId };
    }
    const opts = {
      sessionId,
      workingDirectory: (config && config.cwd) || cwd || process.cwd(),
      streaming: true,
      onPermissionRequest: (config && config.allowAll === false) ? deny : approveAll,
    };
    if (resume) {
      // Resuming a persisted session: the agent/tools are already wired in.
      opts.__resume = true;
      opts.__keepAlive = true;
      return this._execute(opts, prompt, sessionId, onChunk);
    }
    // New session: resolve the agent wiring (same rules as runAgent). If nothing
    // resolves, the chat still runs as the default copilot.
    if (config && config.pluginDir && fs.existsSync(config.pluginDir)) {
      opts.pluginDirectories = [config.pluginDir];
      opts.agent = config.agent;
    } else if (config) {
      const agentCfg = this._resolveProjectAgent(config);
      if (agentCfg) {
        opts.customAgents = [agentCfg];
        opts.agent = agentCfg.name;
        const mcp = this._loadMcpServers(config);
        if (mcp) opts.mcpServers = mcp;
      }
    }
    opts.__keepAlive = true;
    return this._execute(opts, prompt, sessionId, onChunk);
  }

  /**
   * Shared createSession/resumeSession -> sendAndWait -> getEvents core for
   * runAgent/runPrompt/runChat. Streams assistant deltas through onChunk(text)
   * and returns the standard result shape. A session start failure degrades to
   * { fallback:true }.
   */
  async _execute(opts, prompt, sessionId, onChunk) {
    const client = await this._getClient();
    if (!client) {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner: no client', sessionId };
    }

    const resume = !!opts.__resume;
    const keepAlive = !!opts.__keepAlive;
    const sessionOpts = { ...opts };
    delete sessionOpts.__resume;
    delete sessionOpts.__keepAlive;

    let session = null;
    let entry = null;
    let onDelta = null;
    try {
      // Reuse a still-connected chat session if we have one — this is what keeps
      // the agent "open" between turns instead of re-resuming each message.
      if (keepAlive && this._liveSessions.has(sessionId)) {
        entry = this._liveSessions.get(sessionId);
        if (entry.timer) clearTimeout(entry.timer);
        session = entry.session;
      } else {
        session = resume
          ? await client.resumeSession(sessionId, sessionOpts)
          : await client.createSession(sessionOpts);
      }

      if (typeof onChunk === 'function') {
        // Register per-turn so reused sessions don't accumulate listeners
        // (which would fire onChunk multiple times per delta).
        onDelta = (ev) => {
          const txt = ev?.data?.deltaContent ?? ev?.data?.content ?? ev?.data?.delta ?? '';
          if (txt) {
            try { onChunk(String(txt)); } catch (_) { /* ignore */ }
          }
        };
        session.on('assistant.message_delta', onDelta);
      }

      let code = 0;
      let error = '';
      try {
        await session.sendAndWait({ prompt }, this._timeoutMs);
      } catch (e) {
        code = 1;
        error = e && e.message ? e.message : String(e);
      }

      // Detach the per-turn listener before we may reuse this session again.
      if (onDelta) {
        try {
          const off = session.off || session.removeListener;
          if (off) off.call(session, 'assistant.message_delta', onDelta);
        } catch (_) { /* ignore */ }
        onDelta = null;
      }

      // Authoritative output: assistant.message contents joined like the scraper.
      let output = '';
      let eventCount = 0;
      let steps = [];
      try {
        const events = await session.getEvents();
        eventCount = events.length;
        const parts = [];
        for (const ev of events) {
          if (ev.type === 'assistant.message' && ev.data && ev.data.content) {
            parts.push(ev.data.content);
          }
        }
        output = parts.join(SEP);
        steps = this._buildSteps(events);
        // Surface a session-level error if sendAndWait succeeded but the run failed.
        if (code === 0) {
          const errEv = events.find(e => e.type === 'error' || e.type === 'session.error');
          if (errEv) {
            code = 1;
            error = (errEv.data && (errEv.data.message || errEv.data.content)) || 'session error';
          }
        }
      } catch (e) {
        if (code === 0) { code = 1; error = `getEvents failed: ${e.message}`; }
      }

      // Keep the session connected and (re)arm its idle timer so the next turn
      // reuses it. One-shot runs (runAgent/runPrompt) disconnect in finally.
      if (keepAlive) {
        if (!entry) entry = {};
        entry.session = session;
        entry.lastUsed = Date.now();
        this._liveSessions.set(sessionId, entry);
        this._scheduleEvict(sessionId, entry);
      }

      return { ok: code === 0, fallback: false, code, output, error, sessionId, eventCount, steps };
    } catch (e) {
      // createSession/resumeSession failed - return fallback so the caller can
      // record a terminal failure (no CLI fallback remains).
      if (keepAlive) this._liveSessions.delete(sessionId);
      return {
        ok: false,
        fallback: true,
        code: -1,
        output: '',
        error: `sdk-runner: session start failed: ${e && e.message ? e.message : String(e)}`,
        sessionId,
      };
    } finally {
      if (onDelta && session) {
        try {
          const off = session.off || session.removeListener;
          if (off) off.call(session, 'assistant.message_delta', onDelta);
        } catch (_) { /* ignore */ }
      }
      // Only one-shot runs disconnect here; kept-alive chat sessions stay open
      // and are closed by the idle timer or closeChatSession().
      if (session && !keepAlive) {
        try { await session.disconnect(); } catch (_) { /* preserves disk */ }
      }
    }
  }

  async stop() {
    if (this._client) {
      try { await this._client.stop(); } catch (_) { /* ignore */ }
      this._client = null;
    }
  }
}

module.exports = new SdkRunner();
