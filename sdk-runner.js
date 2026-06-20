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
let agentPackage = null;
try {
  agentPackage = require('./agentPackage');
} catch (e) {
  // agentPackage missing - generated-package runtime path disabled (Marketplace).
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
    // Marketplace generated-package runtime path (off|canary|all). When enabled
    // for a project/azdo agent, the agent is wrapped into a generated plugin
    // package (agent + co-located .mcp.json + skills) and run via
    // pluginDirectories — the same uniform path plugin agents use — so project
    // agents get skills + MCP and the AzDO single-agent install bug is fixed at
    // the runtime layer. Default off = zero behaviour change.
    const pkgRaw = (process.env.MKT_PACKAGE_MODE || 'off').toLowerCase();
    this._pkgMode = VALID_MODES.includes(pkgRaw) ? pkgRaw : 'off';
    this._pkgAllowlist = new Set(
      (process.env.MKT_PACKAGE_AGENTS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
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
    // Cached model catalog from client.listModels().
    this._modelsCache = null;
    this._modelsCacheAt = 0;
    this._modelsTtlMs = parseInt(process.env.SDK_MODELS_TTL_MS || '', 10) || 300000; // 5 min
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

  /** True if a kept-alive chat session for this id is still connected in-memory. */
  hasLiveChat(sessionId) {
    return !!sessionId && this._liveSessions.has(sessionId);
  }

  /**
   * List available models with metadata (id, name, capabilities, billing
   * multiplier, supported reasoning efforts). Cached for a few minutes since the
   * catalog rarely changes within a process lifetime. Returns [] if the SDK is
   * unavailable or the call fails (callers degrade to the runtime default).
   */
  async listModels() {
    if (!this._available) return [];
    const now = Date.now();
    if (this._modelsCache && (now - this._modelsCacheAt) < this._modelsTtlMs) {
      return this._modelsCache;
    }
    const client = await this._getClient();
    if (!client || typeof client.listModels !== 'function') return this._modelsCache || [];
    try {
      const models = await client.listModels();
      this._modelsCache = Array.isArray(models) ? models : [];
      this._modelsCacheAt = now;
      return this._modelsCache;
    } catch (e) {
      console.error('[sdk-runner] listModels failed:', e.message);
      return this._modelsCache || [];
    }
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

  /** Should this project/azdo agent run via a generated runtime package? */
  _usePackage(config) {
    if (!agentPackage || !config) return false;
    if (config.pluginDir) return false; // plugin agents already get skills+mcp
    if (this._pkgMode === 'all') return true;
    if (this._pkgMode === 'canary') {
      return config.usePackage === true || config.runtime === 'package' || this._pkgAllowlist.has(config.id);
    }
    return false;
  }

  /**
   * Wrap a project/azdo agent into a generated plugin package and point opts at
   * it (pluginDirectories + namespaced agent id). Returns true on success; on
   * any failure returns false so the caller falls back to the customAgents path.
   */
  _applyPackage(opts, config) {
    try {
      const pkg = agentPackage.buildAgentPackage(config);
      if (!pkg) return false;
      opts.pluginDirectories = [pkg.pluginDir];
      opts.agent = pkg.agentId;
      return true;
    } catch (e) {
      console.error('[sdk-runner] generated package build failed:', e.message);
      return false;
    }
  }

  /**
   * Additively apply marketplace-attached capabilities from the per-agent
   * overlay dir to an already-wired opts. Used on the plugin-agent and
   * project-agent (customAgents) paths so an attach takes runtime effect even
   * for plugin agents (the Helix UX Standup MCP bug). NOT used on the generated
   * package path, where buildAgentPackage already merges the same overlay.
   *   - overlay .mcp.json  -> merged into opts.mcpServers (overlay wins)
   *   - overlay skills/    -> the overlay dir is exposed as an extra plugin
   *                           directory (a minimal plugin.json is written) so
   *                           its skills load like any plugin-bundled skill.
   */
  _applyOverlayCaps(opts, config) {
    if (!agentPackage || !config || !config.id) return;
    let dir;
    try {
      dir = agentPackage.overlayDir(config.id);
    } catch (_) {
      return;
    }
    try {
      const mcpPath = path.join(dir, '.mcp.json');
      if (fs.existsSync(mcpPath)) {
        const servers = (JSON.parse(fs.readFileSync(mcpPath, 'utf8')) || {}).mcpServers || {};
        if (Object.keys(servers).length) {
          opts.mcpServers = Object.assign({}, opts.mcpServers || {}, servers);
        }
      }
    } catch (e) {
      console.error('[sdk-runner] overlay mcp merge failed:', e.message);
    }
    try {
      const skillsDir = path.join(dir, 'skills');
      const hasSkills = fs.existsSync(skillsDir) &&
        fs.readdirSync(skillsDir, { withFileTypes: true })
          .some(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')));
      if (hasSkills) {
        const manifest = path.join(dir, 'plugin.json');
        if (!fs.existsSync(manifest)) {
          fs.writeFileSync(manifest, JSON.stringify({
            name: 'overlay-' + String(config.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
            description: 'Marketplace-attached skills overlay for agent ' + config.id,
            version: '1.0.0',
            skills: 'skills/'
          }, null, 2));
        }
        opts.pluginDirectories = (opts.pluginDirectories || []).concat([dir]);
      }
    } catch (e) {
      console.error('[sdk-runner] overlay skills merge failed:', e.message);
    }
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
   * Find the project-agent definition in <cwd>/.github/agents that belongs to
   * this config. Resolution order:
   *   1. config.source.path basename — authoritative. Sibling agents installed
   *      from the same repo share one checkout (e.g. autoscaler.md and
   *      autoscaler-standup.agent.md under dotnet-autoscaler), so each agent must
   *      bind to its OWN file. Without this, a name miss + the single-file
   *      fallback below would cross-resolve to the wrong sibling.
   *   2. frontmatter name / file slug matching config.agent.
   *   3. single-file fallback when the checkout holds exactly one agent file.
   * Considers both `*.md` and `*.agent.md` (the CLI auto-discovers either).
   * Returns CustomAgentConfig or null.
   */
  _resolveProjectAgent(config) {
    if (!config.cwd) return null;
    const agentsDir = path.join(config.cwd, '.github', 'agents');
    let files;
    try {
      files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    } catch (e) {
      return null;
    }
    if (!files.length) return null;
    const slugOf = f => f.replace(/\.agent\.md$/, '').replace(/\.md$/, '').toLowerCase();
    // 1. Authoritative: bind to the agent's own source file.
    const srcPath = config.source && config.source.path;
    if (srcPath) {
      const base = path.basename(String(srcPath)).toLowerCase();
      const own = files.find(f => f.toLowerCase() === base);
      if (own) return this._parseAgentMd(path.join(agentsDir, own));
    }
    // 2. Match by frontmatter name or file slug.
    const want = (config.agent || config.name || '').trim().toLowerCase();
    let fallback = null;
    for (const f of files) {
      const cfg = this._parseAgentMd(path.join(agentsDir, f));
      if (!cfg) continue;
      if ((cfg.name || '').toLowerCase() === want || slugOf(f) === want) return cfg;
      if (!fallback) fallback = cfg;
    }
    // 3. If exactly one agent file exists, use it even if the name didn't match.
    if (files.length === 1 && fallback) return fallback;
    return null;
  }

  /**
   * Resolve the agent identifier to request when loading a PLUGIN via
   * pluginDirectories.
   *
   * The SDK addresses a plugin's agents as "<plugin.json name>:<agent-file
   * slug>" (e.g. "helix-ux-standup:helix-ux-standup"). It does NOT match the
   * agent's frontmatter `name`, so a config.agent that holds a display name
   * (e.g. "Helix UX Standup") — or one drifted by the install-time "Supervised"
   * overlay — yields "Custom agent '<name>' not found". Map whatever config.agent
   * holds (namespaced id, file slug, or frontmatter display name, with the
   * " Supervised" suffix tolerated) to the canonical "<pluginName>:<slug>" id.
   * Falls back to config.agent when the plugin cannot be inspected.
   */
  _resolvePluginAgentName(config) {
    const want = (config.agent || config.name || '').trim();
    let pluginName = '';
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(config.pluginDir, 'plugin.json'), 'utf8'));
      pluginName = (pj && pj.name) || '';
    } catch (e) { /* ignore */ }
    let files;
    try {
      files = fs.readdirSync(path.join(config.pluginDir, 'agents')).filter(f => f.endsWith('.agent.md'));
    } catch (e) {
      // No agents/ directory: this plugin is a skills/MCP-only bundle and ships
      // no custom agent. Run under the default copilot agent (capabilities still
      // load via --plugin-dir). Returning `want` here would pass a non-existent
      // "<name>:<name>" ref to --agent and break chat/CLI.
      return '';
    }
    // Has an agents/ dir but no .agent.md files (or no plugin name to qualify a
    // ref): nothing to bind to -> default agent.
    if (!files.length) return '';
    if (!pluginName) return want;
    const entries = files.map(f => {
      const slug = f.replace(/\.agent\.md$/, '');
      const cfg = this._parseAgentMd(path.join(config.pluginDir, 'agents', f));
      return { slug, name: (cfg && cfg.name) || slug, id: `${pluginName}:${slug}` };
    });
    const wantLc = want.toLowerCase();
    const norm = s => s.toLowerCase().replace(/\s+supervised$/, '');
    let hit = entries.find(e => e.id.toLowerCase() === wantLc)
          || entries.find(e => e.slug.toLowerCase() === wantLc)
          || entries.find(e => e.name.toLowerCase() === wantLc)
          || entries.find(e => norm(e.name) === norm(want));
    if (!hit && entries.length === 1) hit = entries[0];
    return hit ? hit.id : want;
  }

  /**
   * Resolve the `copilot` CLI invocation for an agent so an interactive terminal
   * session boots with the SAME wiring (plugins / generated package / project
   * agent) that runAgent() uses. Returns { args, cwd, agent } where `args` are
   * copilot CLI flags (NOT including --session-id, which the caller pins).
   *
   *   - PLUGIN agent (config.pluginDir): --plugin-dir <dir> --agent <pluginName:slug>
   *   - PROJECT/AZDO agent via generated package: --plugin-dir <pkg> --agent <id>
   *   - PROJECT agent discovered from <cwd>/.github/agents: --agent <name>
   *     (the CLI auto-discovers .github/agents in the working directory)
   */
  resolveCliLaunch(config) {
    const cwd = (config && config.cwd) || process.cwd();
    const args = [];
    let agent = '';
    try {
      if (config && config.pluginDir && fs.existsSync(config.pluginDir)) {
        agent = this._resolvePluginAgentName(config);
        args.push('--plugin-dir', config.pluginDir);
        if (agent) args.push('--agent', agent);
        // Marketplace-attached overlay capabilities live in a per-agent overlay
        // dir; expose any skills overlay as an extra --plugin-dir so the CLI
        // session matches runAgent()'s applied caps.
        const overlay = config.overlayDir;
        if (overlay && fs.existsSync(path.join(overlay, 'plugin.json'))) {
          args.push('--plugin-dir', overlay);
        }
      } else if (this._usePackage(config)) {
        const pkg = agentPackage && agentPackage.buildAgentPackage(config);
        if (pkg) {
          agent = pkg.agentId;
          args.push('--plugin-dir', pkg.pluginDir, '--agent', pkg.agentId);
        }
      }
      if (!args.length) {
        const agentCfg = this._resolveProjectAgent(config);
        agent = (agentCfg && agentCfg.name) || (config && (config.agent || config.name)) || '';
        if (agent) args.push('--agent', agent);
      }
    } catch (e) {
      console.error('[sdk-runner] resolveCliLaunch failed:', e.message);
    }
    return { args, cwd, agent };
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
  async runAgent({ config, prompt, sessionId, onChunk, model }) {
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
    if (model) opts.model = model;

    if (config.pluginDir && fs.existsSync(config.pluginDir)) {
      opts.pluginDirectories = [config.pluginDir];
      opts.agent = this._resolvePluginAgentName(config);
      this._applyOverlayCaps(opts, config);
    } else if (this._usePackage(config) && this._applyPackage(opts, config)) {
      // Generated-package path: skills + MCP load from the wrapper plugin dir.
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
      this._applyOverlayCaps(opts, config);
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
  async runPrompt({ prompt, cwd, sessionId, onChunk, model }) {
    if (this.mode === 'off') {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner-off', sessionId };
    }
    const opts = {
      sessionId,
      workingDirectory: cwd || process.cwd(),
      streaming: true,
      onPermissionRequest: approveAll,
    };
    if (model) opts.model = model;
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
  async runChat({ config, prompt, sessionId, resume, cwd, onChunk, onStep, model }) {
    if (!this._available) {
      return { ok: false, fallback: true, code: -1, output: '', error: 'sdk-runner: SDK unavailable', sessionId };
    }
    const opts = {
      sessionId,
      workingDirectory: (config && config.cwd) || cwd || process.cwd(),
      streaming: true,
      onPermissionRequest: (config && config.allowAll === false) ? deny : approveAll,
    };
    if (model) opts.model = model;
    if (resume) {
      // Resuming a persisted session: the agent/tools are already wired in.
      opts.__resume = true;
      opts.__keepAlive = true;
      return this._execute(opts, prompt, sessionId, onChunk, onStep);
    }
    // New session: resolve the agent wiring (same rules as runAgent). If nothing
    // resolves, the chat still runs as the default copilot.
    if (config && config.pluginDir && fs.existsSync(config.pluginDir)) {
      opts.pluginDirectories = [config.pluginDir];
      opts.agent = this._resolvePluginAgentName(config);
      this._applyOverlayCaps(opts, config);
    } else if (config && this._usePackage(config) && this._applyPackage(opts, config)) {
      // Generated-package path: skills + MCP load from the wrapper plugin dir.
    } else if (config) {
      const agentCfg = this._resolveProjectAgent(config);
      if (agentCfg) {
        opts.customAgents = [agentCfg];
        opts.agent = agentCfg.name;
        const mcp = this._loadMcpServers(config);
        if (mcp) opts.mcpServers = mcp;
        this._applyOverlayCaps(opts, config);
      }
    }
    opts.__keepAlive = true;
    return this._execute(opts, prompt, sessionId, onChunk, onStep);
  }

  /**
   * Shared createSession/resumeSession -> sendAndWait -> getEvents core for
   * runAgent/runPrompt/runChat. Streams assistant deltas through onChunk(text)
   * and returns the standard result shape. A session start failure degrades to
   * { fallback:true }.
   */
  async _execute(opts, prompt, sessionId, onChunk, onStep) {
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
    let stepListeners = [];
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

      // Live step stream: tool calls, extended thinking, and sub-agent selection
      // are emitted as the run progresses (they are NOT in the delta stream). We
      // surface them through onStep so callers can render "Reasoning & steps"
      // live — without waiting for getEvents() at the end. Registered per-turn
      // and detached below, mirroring onDelta.
      if (typeof onStep === 'function') {
        const emit = (s) => { try { onStep(s); } catch (_) { /* ignore */ } };
        const add = (name, fn) => { session.on(name, fn); stepListeners.push([name, fn]); };
        add('tool.execution_start', (ev) => {
          const d = (ev && ev.data) || {};
          emit({ kind: 'tool_start', tool: d.toolName || 'tool', args: d.arguments, toolCallId: d.toolCallId });
        });
        add('tool.execution_complete', (ev) => {
          const d = (ev && ev.data) || {};
          emit({ kind: 'tool_complete', toolCallId: d.toolCallId, tool: d.toolName, success: d.success !== false && !d.error, result: String(d.result?.content || '').slice(0, 2000) });
        });
        add('assistant.reasoning', (ev) => {
          const d = (ev && ev.data) || {};
          if (d.content) emit({ kind: 'thinking', content: String(d.content).slice(0, 4000) });
        });
        add('subagent.selected', (ev) => {
          const d = (ev && ev.data) || {};
          emit({ kind: 'agent', name: d.agentDisplayName || d.agentName || 'subagent' });
        });
      }

      // assistant.usage events carry authoritative per-API-call billing metrics
      // (tokens, model multiplier as `cost`, duration). They are emitted live and
      // are NOT persisted in getEvents(), so we must accumulate them off the live
      // stream. Registered per-turn so reused chat sessions count only this turn.
      const usageAcc = { premiumRequests: 0, apiDurationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
      const onUsage = (ev) => {
        const d = ev && ev.data;
        if (!d) return;
        usageAcc.calls += 1;
        const mult = Number(d.cost);
        usageAcc.premiumRequests += Number.isFinite(mult) && mult > 0 ? mult : 1;
        usageAcc.apiDurationMs += Number(d.duration) || 0;
        usageAcc.inputTokens += Number(d.inputTokens) || 0;
        usageAcc.outputTokens += Number(d.outputTokens) || 0;
        usageAcc.cacheReadTokens += Number(d.cacheReadTokens) || 0;
        usageAcc.cacheWriteTokens += Number(d.cacheWriteTokens) || 0;
      };
      try { session.on('assistant.usage', onUsage); } catch (_) { /* ignore */ }

      let code = 0;
      let error = '';
      try {
        await session.sendAndWait({ prompt }, this._timeoutMs);
      } catch (e) {
        code = 1;
        error = e && e.message ? e.message : String(e);
      }

      // Detach the per-turn listeners before we may reuse this session again.
      if (onDelta) {
        try {
          const off = session.off || session.removeListener;
          if (off) off.call(session, 'assistant.message_delta', onDelta);
        } catch (_) { /* ignore */ }
        onDelta = null;
      }
      try {
        const off = session.off || session.removeListener;
        if (off) off.call(session, 'assistant.usage', onUsage);
      } catch (_) { /* ignore */ }
      if (stepListeners.length) {
        const off = session.off || session.removeListener;
        if (off) for (const [name, fn] of stepListeners) {
          try { off.call(session, name, fn); } catch (_) { /* ignore */ }
        }
        stepListeners.length = 0;
      }

      // Authoritative output: assistant.message contents joined like the scraper.
      let output = '';
      let eventCount = 0;
      let steps = [];
      let usedModel = '';
      let usage = null;
      try {
        const events = await session.getEvents();
        eventCount = events.length;
        const parts = [];
        let shutdownUsage = null;
        for (const ev of events) {
          if (ev.type === 'assistant.message' && ev.data && ev.data.content) {
            parts.push(ev.data.content);
          }
          // The runtime stamps each assistant.message (and some tool events) with
          // the model that actually served it — authoritative even when we let the
          // runtime default apply (opts.model was empty). Keep the last one seen.
          if (ev.data && typeof ev.data.model === 'string' && ev.data.model) {
            usedModel = ev.data.model;
          }
          // session.shutdown carries authoritative billing/usage totals for the
          // run. Rarely present before we read (it flushes on teardown), but prefer
          // it when available.
          if (ev.type === 'session.shutdown' && ev.data) {
            const td = ev.data.tokenDetails || {};
            shutdownUsage = {
              premiumRequests: Number(ev.data.totalPremiumRequests) || 0,
              apiDurationMs: Number(ev.data.totalApiDurationMs) || 0,
              inputTokens: Number(td.input?.tokenCount) || 0,
              outputTokens: Number(td.output?.tokenCount) || 0,
              cacheReadTokens: Number(td.cache_read?.tokenCount) || 0,
              cacheWriteTokens: Number(td.cache_write?.tokenCount) || 0,
            };
          }
        }
        // Prefer shutdown totals (if the session already tore down); otherwise use
        // the live assistant.usage accumulation for this turn.
        if (shutdownUsage && shutdownUsage.premiumRequests > 0) {
          usage = shutdownUsage;
        } else if (usageAcc.calls > 0) {
          usage = {
            premiumRequests: +usageAcc.premiumRequests.toFixed(4),
            apiDurationMs: usageAcc.apiDurationMs,
            inputTokens: usageAcc.inputTokens,
            outputTokens: usageAcc.outputTokens,
            cacheReadTokens: usageAcc.cacheReadTokens,
            cacheWriteTokens: usageAcc.cacheWriteTokens,
          };
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

      return { ok: code === 0, fallback: false, code, output, error, sessionId, eventCount, steps, model: usedModel || opts.model || '', usage };
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
      if (stepListeners.length && session) {
        const off = session.off || session.removeListener;
        if (off) for (const [name, fn] of stepListeners) {
          try { off.call(session, name, fn); } catch (_) { /* ignore */ }
        }
        stepListeners.length = 0;
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
