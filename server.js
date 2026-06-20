const express = require('express');
const path = require('path');
const fs = require('fs');
const yazl = require('yazl');
const yauzl = require('yauzl');
const multer = require('multer');
const { openDatabase } = require('./db');
const Supervisor = require('./supervisor');
const ManagerAgent = require('./manager');
const EventListener = require('./event-listener');
const MobileHandler = require('./mobile-handler');
const ConfigSync = require('./config-sync');
const azdo = require('./azdo');
const capabilities = require('./capabilities');
const mcpTest = require('./mcpTest');
const agentPackage = require('./agentPackage');
const agentExport = require('./agentExport');
const marketplace = require('./marketplace');
const marketplaceDesign = require('./marketplace-design');

// Runtime data dirs (plugins, mcp-configs) live under the user profile, not the
// repo. The repo only ships built-in plugin seeds in builtin-plugins/.
const SUPERVISOR_DATA_DIR = ConfigSync.SUPERVISOR_DATA_DIR;
const PLUGINS_DIR = ConfigSync.PLUGINS_DIR;
const MCP_CONFIGS_DIR = ConfigSync.MCP_CONFIGS_DIR;
const BUILTIN_PLUGINS_DIR = path.join(__dirname, 'builtin-plugins');

// One-time migration: move any legacy in-repo runtime dirs into the profile store.
(function migrateRuntimeDirs() {
  for (const dirName of ['plugins', 'mcp-configs']) {
    const legacyDir = path.join(__dirname, dirName);
    const targetDir = path.join(SUPERVISOR_DATA_DIR, dirName);
    if (!fs.existsSync(legacyDir)) continue;
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
        // The built-in manager plugin is re-seeded separately; skip it.
        if (dirName === 'plugins' && entry.name === 'manager') continue;
        const dest = path.join(targetDir, entry.name);
        if (fs.existsSync(dest)) continue; // don't clobber existing runtime data
        fs.cpSync(path.join(legacyDir, entry.name), dest, { recursive: true });
      }
      console.log(`[supervisor] Migrated legacy ${dirName}/ into runtime store`);
    } catch (e) {
      console.warn(`[supervisor] Could not migrate ${dirName}/:`, e.message);
    }
  }
})();

const upload = multer({ dest: path.join(require('os').tmpdir(), 'agent-supervisor-uploads') });

const PORT = process.env.PORT || 3847;
const DB_PATH = path.join(__dirname, 'supervisor.db');
const AGENTS_PATH = path.join(__dirname, 'agents.json');
const MANAGERS_PATH = path.join(__dirname, 'managers.json');
const TASKS_PATH = path.join(__dirname, 'tasks.json');
const TEAMS_PATH = path.join(__dirname, 'teams.json');
const LEGACY_ORGANIZATIONS_PATH = path.join(__dirname, 'organizations.json');
const BOARDS_PATH = path.join(__dirname, 'boards.json');
const INSIGHTS_PATH = path.join(__dirname, 'insights.json');

// Ensure tasks.json exists
if (!fs.existsSync(TASKS_PATH)) {
  fs.writeFileSync(TASKS_PATH, '[]');
}

// One-time migration: "Organizations" were renamed to "Teams". Rename the data
// file and normalize the per-operation scope key orgId -> teamId (and the manager
// roster field org -> team) across all persisted runtime files. Reads remain
// backward-compatible (teamId ?? orgId) so any unswept/cloud-synced file still works.
(function migrateOrgsToTeams() {
  try {
    if (!fs.existsSync(TEAMS_PATH)) {
      if (fs.existsSync(LEGACY_ORGANIZATIONS_PATH)) {
        fs.copyFileSync(LEGACY_ORGANIZATIONS_PATH, TEAMS_PATH);
        console.log('[migrate] organizations.json -> teams.json');
      } else {
        fs.writeFileSync(TEAMS_PATH, '[]');
      }
    }
    const sweepKey = (file, fn) => {
      try {
        const p = path.join(__dirname, file);
        if (!fs.existsSync(p)) return;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(data)) return;
        let changed = false;
        for (const row of data) if (fn(row)) changed = true;
        if (changed) fs.writeFileSync(p, JSON.stringify(data, null, 2));
      } catch (e) { console.warn(`[migrate] ${file} skipped:`, e.message); }
    };
    const moveOrgId = (o) => {
      if (o && typeof o === 'object' && o.orgId !== undefined && o.teamId === undefined) {
        o.teamId = o.orgId; delete o.orgId; return true;
      }
      return false;
    };
    sweepKey('tasks.json', moveOrgId);
    sweepKey('chains.json', moveOrgId);
    sweepKey('boards.json', moveOrgId);
    sweepKey('managers.json', (m) => {
      let changed = false;
      if (m && m.org !== undefined && m.team === undefined) { m.team = m.org; delete m.org; changed = true; }
      if (m && Array.isArray(m.assignments)) for (const a of m.assignments) if (moveOrgId(a)) changed = true;
      return changed;
    });
  } catch (e) { console.warn('[migrate] orgs->teams failed:', e.message); }
})();

function loadTeams() {
  try {
    if (!fs.existsSync(TEAMS_PATH)) return [];
    const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
    return Array.isArray(teams) ? teams : [];
  } catch { return []; }
}

function saveTeams(teams) {
  fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams || [], null, 2));
}

function loadBoards() {
  try {
    if (!fs.existsSync(BOARDS_PATH)) return [];
    const boards = JSON.parse(fs.readFileSync(BOARDS_PATH, 'utf-8'));
    return Array.isArray(boards) ? boards : [];
  } catch { return []; }
}

function saveBoards(boards) {
  fs.writeFileSync(BOARDS_PATH, JSON.stringify(boards || [], null, 2));
}

function loadInsights() {
  try {
    if (!fs.existsSync(INSIGHTS_PATH)) return [];
    const v = JSON.parse(fs.readFileSync(INSIGHTS_PATH, 'utf-8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function saveInsights(insights) {
  fs.writeFileSync(INSIGHTS_PATH, JSON.stringify(insights || [], null, 2));
}

// Resolve copilot CLI path for environments where it's not in PATH (e.g., scheduled tasks)
if (!process.env.COPILOT_PATH) {
  const copilotCmd = 'C:\\Users\\chcosta\\AppData\\Roaming\\npm\\copilot.cmd';
  if (fs.existsSync(copilotCmd)) {
    process.env.COPILOT_PATH = copilotCmd;
    console.log(`[supervisor] Resolved copilot CLI: ${copilotCmd}`);
  } else {
    console.warn('[supervisor] WARNING: copilot.cmd not found at expected path');
  }
}

// Ensure manager plugin is registered in copilot config
(function ensureManagerPlugin() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const configPath = path.join(homeDir, '.copilot', 'config.json');
  const installedDir = path.join(homeDir, '.copilot', 'installed-plugins', '_direct');
  const builtinManager = path.join(BUILTIN_PLUGINS_DIR, 'manager');
  const runtimeManager = path.join(PLUGINS_DIR, 'manager');
  const targetDir = path.join(installedDir, 'manager');

  // Seed the built-in manager plugin from the repo into the runtime store.
  try {
    if (fs.existsSync(builtinManager) && !fs.existsSync(runtimeManager)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      fs.cpSync(builtinManager, runtimeManager, { recursive: true });
      console.log('[supervisor] Seeded manager plugin into runtime store');
    }
  } catch (e) { console.warn('[supervisor] Could not seed manager plugin:', e.message); }

  if (!fs.existsSync(runtimeManager)) return;

  // Create junction if missing
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(installedDir, { recursive: true });
      require('child_process').execSync(`mklink /J "${targetDir}" "${runtimeManager}"`, { shell: true });
      console.log('[supervisor] Created manager plugin junction');
    } catch (e) { console.warn('[supervisor] Could not create manager plugin junction:', e.message); }
  }

  // Register in config.json if missing
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
      const config = JSON.parse(raw);
      if (!config.installedPlugins) config.installedPlugins = [];
      const hasManager = config.installedPlugins.some(p => p.name === 'manager');
      if (!hasManager) {
        config.installedPlugins.push({
          name: 'manager', marketplace: '', version: '1.0.0',
          installed_at: new Date().toISOString(), enabled: true,
          cache_path: targetDir,
          source: { source: 'local', path: managerPluginDir }
        });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('[supervisor] Registered manager plugin in copilot config');
      }
    } catch (e) { console.warn('[supervisor] Could not register manager plugin:', e.message); }
  }
})();

// Get git version info and process identity at startup
const PROCESS_START = new Date().toISOString();
const PROCESS_PID = process.pid;
let GIT_VERSION = { hash: 'unknown', message: '', dirty: false };
try {
  const { execSync } = require('child_process');
  const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8' }).trim();
  const message = execSync('git log -1 --format=%s', { cwd: __dirname, encoding: 'utf-8' }).trim();
  const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf-8' }).trim();
  const dirty = status.length > 0;
  // Compute file hash of running source for integrity verification
  const crypto = require('crypto');
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'));
  const supervisorSrc = fs.readFileSync(path.join(__dirname, 'supervisor.js'));
  const fileHash = crypto.createHash('sha256').update(serverSrc).update(supervisorSrc).digest('hex').substring(0, 8);
  GIT_VERSION = { hash, message, dirty, fileHash };
} catch {}

async function main() {

// Initialize database
const db = await openDatabase(DB_PATH);

// Initialize supervisor
const supervisor = new Supervisor(db);

// --- Interactive chat: SDK runtime (Phase 6) ---------------------------------
const sdkRunner = require('./sdk-runner');
const settings = require('./settings');
const STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
// In-memory live chat state, keyed by sessionId. The SDK flushes events.jsonl to
// disk only on session disconnect, so disk reads lag the live stream — live
// (in-progress) turns are served from here, completed turns from the flushed
// file by id. { running, userPrompt, acc, startedAt, lastUpdate, finishedAt,
//   error, priorTurns }
const liveChatBuffers = new Map();
// Most-recent chat session id per agent — replaces the brittle session-dir
// name/recency correlation that /api/agents/:id/session used to do.
const agentChatSessions = new Map();
// Track chat errors per session for surfacing in poll.
const chatErrors = new Map();

// Parse a session's events.jsonl lines into the /poll turn structure. Operates
// on the same {type,data} event shape the SDK getEvents() returns, so the SDK's
// on-disk log and live stream share one parser.
function buildPollTurns(lines, verbose) {
  let turnCount = 0;
  let lastAssistant = '';
  const allTurns = [];
  let currentUser = null;
  let currentSteps = [];
  let subTurnCount = 0;
  let lastAssistantMsg = '';
  let currentModel = null;
  let sessionMeta = null;
  let tokenStats = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // Capture the serving model on every turn, regardless of verbose — model
      // indication must always be available to the UI.
      if (ev.type === 'assistant.message' && ev.data?.model) currentModel = ev.data.model;
      if (ev.type === 'session.model_change' && ev.data?.newModel) currentModel = ev.data.newModel;
      if (verbose && ev.type === 'session.start' && ev.data) {
        sessionMeta = {
          cwd: ev.data.context?.cwd,
          branch: ev.data.context?.branch,
          repo: ev.data.context?.repository,
          agent: ev.data.context?.agentName,
          copilotVersion: ev.data.copilotVersion
        };
      }
      if (verbose && ev.type === 'session.resume' && ev.data) {
        if (!sessionMeta) sessionMeta = {};
        sessionMeta.cwd = sessionMeta.cwd || ev.data.context?.cwd;
        sessionMeta.branch = sessionMeta.branch || ev.data.context?.branch;
        sessionMeta.repo = sessionMeta.repo || ev.data.context?.repository;
      }
      if (verbose && ev.type === 'subagent.selected' && ev.data) {
        if (!sessionMeta) sessionMeta = {};
        sessionMeta.agent = ev.data.agentDisplayName || ev.data.agentName;
      }
      if (verbose && ev.type === 'session.model_change' && ev.data) {
        currentModel = ev.data.newModel;
      }
      if (verbose && ev.type === 'session.shutdown' && ev.data) {
        tokenStats = {
          premiumRequests: ev.data.totalPremiumRequests,
          apiDurationMs: ev.data.totalApiDurationMs,
          input: ev.data.tokenDetails?.input?.tokenCount || 0,
          cacheRead: ev.data.tokenDetails?.cache_read?.tokenCount || 0,
          cacheWrite: ev.data.tokenDetails?.cache_write?.tokenCount || 0,
          output: ev.data.tokenDetails?.output?.tokenCount || 0,
          linesAdded: ev.data.codeChanges?.linesAdded,
          linesRemoved: ev.data.codeChanges?.linesRemoved
        };
      }
      if (ev.type === 'user.message') {
        if (currentUser !== null || lastAssistantMsg) {
          allTurns.push({ content: currentUser || '', assistant: lastAssistantMsg || null, model: currentModel || undefined, steps: verbose ? [...currentSteps] : undefined });
        }
        turnCount++;
        currentUser = ev.data?.content || '';
        currentSteps = [];
        subTurnCount = 0;
        lastAssistantMsg = '';
      }
      if (ev.type === 'assistant.turn_start') {
        subTurnCount++;
      }
      if (verbose && ev.type === 'assistant.message') {
        if (ev.data?.model) currentModel = ev.data.model;
        if (ev.data?.content) {
          if (subTurnCount > 1 || currentSteps.length > 0) {
            currentSteps.push({ type: 'comment', content: ev.data.content });
          }
          lastAssistantMsg = ev.data.content;
          lastAssistant = ev.data.content;
        }
      }
      if (!verbose && ev.type === 'assistant.message' && ev.data?.content) {
        lastAssistantMsg = ev.data.content;
        lastAssistant = ev.data.content;
      }
      if (verbose && ev.type === 'tool.execution_start' && ev.data) {
        currentSteps.push({ type: 'tool_start', tool: ev.data.toolName, args: ev.data.arguments, toolCallId: ev.data.toolCallId });
      }
      if (verbose && ev.type === 'tool.execution_complete' && ev.data) {
        const step = currentSteps.find(s => s.toolCallId === ev.data.toolCallId);
        if (step) {
          step.type = 'tool';
          step.success = ev.data.success;
          step.result = (ev.data.result?.content || '').substring(0, 2000);
          if (ev.data.result?.detailedContent) step.detail = ev.data.result.detailedContent.substring(0, 500);
        } else {
          currentSteps.push({ type: 'tool', tool: ev.data.toolName || '?', success: ev.data.success, result: (ev.data.result?.content || '').substring(0, 2000) });
        }
      }
    } catch { }
  }
  if (currentUser !== null || lastAssistantMsg) {
    allTurns.push({ content: currentUser || '', assistant: lastAssistantMsg || null, model: currentModel || undefined, steps: verbose ? [...currentSteps] : undefined });
  }
  if (verbose) {
    for (const turn of allTurns) {
      if (turn.steps && turn.steps.length > 0 && turn.assistant) {
        const lastStep = turn.steps[turn.steps.length - 1];
        if (lastStep.type === 'comment' && lastStep.content === turn.assistant) {
          turn.steps.pop();
        }
      }
    }
  }
  return { turnCount, lastAssistant, turns: allTurns, sessionMeta, tokenStats };
}

// Snapshot the committed (flushed-to-disk) turns for a session id — used to seed
// the live-chat view so prior turns stay visible while a new turn streams.
function snapshotPriorTurns(sessionId, verbose) {
  try {
    const ep = path.join(STATE_DIR, sessionId, 'events.jsonl');
    if (!fs.existsSync(ep)) return [];
    const lines = fs.readFileSync(ep, 'utf-8').split('\n').filter(Boolean);
    return buildPollTurns(lines, verbose).turns;
  } catch { return []; }
}

// Run one interactive chat turn through the SDK runner, maintaining the live
// in-memory buffer that /poll overlays. `agentId` is set for agent chats so the
// pinned session id is tracked for /api/agents/:id/session.
function runChatTurn({ sessionId, message, config, resume, agentId }) {
  const buf = {
    running: true,
    userPrompt: message,
    acc: '',
    steps: [],
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    priorTurns: resume ? snapshotPriorTurns(sessionId, true) : [],
    error: null,
    requestedModel: settings.resolveModel('chat', config) || '',
  };
  liveChatBuffers.set(sessionId, buf);
  chatErrors.delete(sessionId);
  if (agentId) agentChatSessions.set(agentId, sessionId);

  const onChunk = (chunk) => {
    buf.acc += chunk;
    buf.lastUpdate = Date.now();
  };

  // Live "Reasoning & steps": the SDK emits tool/thinking/sub-agent events as the
  // run progresses. Mirror them into buf.steps using the SAME shape buildPollTurns
  // produces from the flushed events.jsonl, so the in-progress view and the
  // committed view render identically (tool_start -> tool, thinking, run_agent).
  const onStep = (s) => {
    if (!s) return;
    if (s.kind === 'tool_start') {
      buf.steps.push({ type: 'tool_start', tool: s.tool, args: s.args, toolCallId: s.toolCallId });
    } else if (s.kind === 'tool_complete') {
      const st = s.toolCallId && buf.steps.find(x => x.toolCallId === s.toolCallId);
      if (st) { st.type = 'tool'; st.success = s.success; st.result = s.result; }
      else buf.steps.push({ type: 'tool', tool: s.tool || '?', success: s.success, result: s.result });
    } else if (s.kind === 'thinking') {
      buf.steps.push({ type: 'thinking', content: s.content });
    } else if (s.kind === 'agent') {
      buf.steps.push({ type: 'run_agent', tool: s.name });
    }
    buf.lastUpdate = Date.now();
  };

  sdkRunner.runChat({ config, prompt: message, sessionId, resume, cwd: config && config.cwd, onChunk, onStep, model: settings.resolveModel('chat', config) })
    .then((res) => {
      buf.running = false;
      buf.finishedAt = Date.now();
      buf.usedModel = res.model || buf.requestedModel || '';
      if (!res.ok) {
        buf.error = res.error || 'chat failed';
        chatErrors.set(sessionId, { error: buf.error, code: res.code, time: Date.now() });
      }
      // Canonical usage ledger: one row per chat turn (agent/ad-hoc chats; manager
      // chats are recorded via the manager run path, so no double counting).
      supervisor.recordUsage({
        ts: new Date().toISOString(),
        source: 'chat',
        refId: agentId || 'chat',
        label: (config && config.name) || agentId || 'Chat',
        model: res.model || buf.requestedModel || '',
        status: res.ok ? 'success' : 'error',
        usage: res.usage || null,
      });
      if (agentId) broadcastSSE('agent-chat-complete', { agentId, code: res.code });
    })
    .catch((err) => {
      buf.running = false;
      buf.finishedAt = Date.now();
      buf.error = err.message;
      chatErrors.set(sessionId, { error: err.message, time: Date.now() });
      if (agentId) broadcastSSE('agent-chat-complete', { agentId, code: 1 });
    });
}

// Forward supervisor events to SSE clients
supervisor.on('agent-running', (agentId) => {
  broadcastSSE('agent-status', { id: agentId, status: 'running' });
});
supervisor.on('agent-output', ({ agentId, stream, chunk }) => {
  broadcastSSE('agent-output', { id: agentId, stream, chunk });
});
supervisor.on('agent-completed', ({ agentId, code, output, error, sessionId, steps, model }) => {
  broadcastSSE('agent-completed', { id: agentId, code, output: output?.slice(-10000), error: error?.slice(-2000), sessionId, steps: Array.isArray(steps) ? steps : [], model: model || '' });
});
// Initialize manager agent system
const managerAgent = new ManagerAgent(db, supervisor);
const eventListener = new EventListener(supervisor, managerAgent, db);

// Mobile command handler — processes structured JSON messages from phone app
const mobileHandler = new MobileHandler(supervisor, managerAgent, db, eventListener);
eventListener.mobileHandler = mobileHandler;
// Let the handler reach the server's own HTTP endpoints (boards/insights live
// here with all their resolution logic) without duplicating that logic.
mobileHandler.localBaseUrl = `http://127.0.0.1:${PORT}`;

// Session cleanup interval for idle event listener sessions
setInterval(() => eventListener.cleanupIdleSessions(), 60000);

// Load agent configs
function loadAgents() {
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  // Normalize any pluginDir still pointing at the legacy in-repo plugins/ folder
  // to the relocated runtime store. Persist once so the scan/paths stay clean.
  const legacyPluginsDir = path.join(__dirname, 'plugins');
  let normalized = false;
  for (const agent of agents) {
    if (agent.pluginDir && agent.pluginDir.startsWith(legacyPluginsDir)) {
      agent.pluginDir = path.join(PLUGINS_DIR, path.basename(agent.pluginDir));
      normalized = true;
    }
  }
  if (normalized) {
    try { fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2)); } catch {}
  }
  agents.forEach(agent => supervisor.register(agent));
  supervisor.pruneOrphans(agents.map(a => a.id));
  return agents;
}

// Load manager configs
function loadManagers() {
  if (!fs.existsSync(MANAGERS_PATH)) return [];
  const managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  managers.forEach(m => managerAgent.register(m));
  return managers;
}

loadAgents();
loadManagers();

// Config sync (cloud-based, leader election)
const configSync = new ConfigSync({
  onLeaderChange: (isLeader, epoch) => {
    console.log(`[config-sync] Leadership changed: ${isLeader ? 'LEADER' : 'STANDBY'} (epoch ${epoch})`);
  },
  onConfigPulled: (version) => {
    console.log(`[config-sync] Config pulled (v${version}), reloading...`);
    loadAgents();
    loadManagers();
    // Chain definitions are read fresh from chains.json on each access, but cron
    // schedules for pulled chains must be (re)registered.
    try { if (typeof chainEngine !== 'undefined' && chainEngine) chainEngine.rescheduleAll(); } catch (e) { console.warn('[config-sync] chain reschedule failed:', e.message); }
  }
});
// Each machine owns its own agents/managers/tasks and always runs its OWN scheduled
// work locally. Leadership only gates shared event-bus / relay handling (below), not a
// machine's own scheduled agents — so we never suppress local schedules.
const leaderCheck = () => true;
supervisor.setLeaderCheck(leaderCheck);
managerAgent.setLeaderCheck(leaderCheck);
// Give the mobile handler access to leader/liveness status for get-status
mobileHandler.configSync = configSync;
// Let the mobile handler install agents/managers from other machines (browse + install).
mobileHandler.installFromMachine = installFromMachine;
// Start async (non-blocking)
configSync.start().catch(err => console.log('[config-sync] Disabled:', err.message));

// Auto-start managers that have scheduled assignments
(() => {
  const managers = managerAgent.managers;
  for (const [id, entry] of managers) {
    const hasScheduled = (entry.config.assignments || []).some(
      a => a.enabled !== false && a.schedule && a.schedule.toLowerCase() !== 'never'
    );
    if (hasScheduled) {
      try {
        managerAgent.startSchedules(id);
        console.log(`[manager] Auto-started schedules for "${entry.config.name || id}"`);
      } catch (e) {
        console.error(`[manager] Failed to auto-start "${id}":`, e.message);
      }
    }
  }
})();

// Watch agents.json for external edits and reload
let _reloadTimer = null;
fs.watch(AGENTS_PATH, () => {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    try {
      console.log('[supervisor] agents.json changed, reloading...');
      loadAgents();
      // Each machine pushes its OWN config changes to its own cloud namespace.
      if (configSync.enabled) {
        configSync.pushConfig().catch(e => console.warn('[sync] auto-push (agents) failed:', e.message));
      }
    } catch (e) {
      console.error('[supervisor] Failed to reload agents.json:', e.message);
    }
  }, 500);
});

// Watch managers.json for external edits and reload
let _reloadManagerTimer = null;
if (fs.existsSync(MANAGERS_PATH)) {
  fs.watch(MANAGERS_PATH, () => {
    if (_reloadManagerTimer) clearTimeout(_reloadManagerTimer);
    _reloadManagerTimer = setTimeout(() => {
      try {
        console.log('[supervisor] managers.json changed, reloading...');
        loadManagers();
        if (configSync.enabled) {
          configSync.pushConfig().catch(e => console.warn('[sync] auto-push (managers) failed:', e.message));
        }
      } catch (e) {
        console.error('[supervisor] Failed to reload managers.json:', e.message);
      }
    }, 500);
  });
}

// Express app
const app = express();
app.use(express.json());

// Serve static SPA files
app.use('/public', express.static(path.join(__dirname, 'public')));
const SPA_PATH = path.join(__dirname, 'public', 'app.html');

// SSE (Server-Sent Events) for real-time updates
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch(e) { sseClients.delete(client); }
  }
}

// Discover available agents from plugins, repos, and marketplaces
app.get('/api/discover', async (req, res) => {
  const { execSync } = require('child_process');
  const discovered = [];
  const registeredIds = new Set(Array.from(supervisor.agents.keys()));
  const copilotPath = process.env.COPILOT_PATH || 'copilot';
  const installedPluginsDir = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'installed-plugins', '_direct');

  // Helper: read plugin.json description
  function readPluginJson(dir) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));
      return { name: pj.name, description: pj.description, version: pj.version, author: pj.author?.name };
    } catch { return null; }
  }

  // Helper: read agent .md frontmatter
  function readAgentMd(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fm) return null;
      const nameMatch = fm[1].match(/name:\s*['"]?([^'"\n]+)/);
      const descMatch = fm[1].match(/description:\s*['"]?([^'"\n]+)/);
      return { name: nameMatch?.[1]?.trim(), description: descMatch?.[1]?.trim() };
    } catch { return null; }
  }

  // 1. Installed Copilot CLI plugins (with descriptions from plugin.json)
  const installedNames = new Set();
  try {
    if (fs.existsSync(installedPluginsDir)) {
      const dirs = fs.readdirSync(installedPluginsDir, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const d of dirs) {
        const pj = readPluginJson(path.join(installedPluginsDir, d.name));
        const id = pj?.name || d.name;
        installedNames.add(id);
        discovered.push({
          source: 'installed-plugin',
          id,
          name: pj?.name || d.name,
          displayName: (pj?.name || d.name).split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          description: pj?.description || '',
          version: pj?.version || '',
          author: pj?.author || '',
          installed: true,
          registered: registeredIds.has(id)
        });
      }
    }
  } catch (e) {
    console.warn('[discover] Failed to read installed plugins:', e.message);
  }

  // 2. Marketplace plugins (not installed)
  try {
    const output = execSync(`"${copilotPath}" plugin marketplace browse copilot-plugins`, { encoding: 'utf-8', timeout: 15000, shell: true });
    const lines = output.split('\n');
    for (const line of lines) {
      const m = line.match(/•\s+(\S+)\s*-\s*(.*)/);
      if (m) {
        const id = m[1].trim();
        if (!installedNames.has(id)) {
          discovered.push({
            source: 'marketplace',
            id,
            name: id,
            displayName: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
            description: m[2].trim(),
            marketplace: 'copilot-plugins',
            installCmd: `${id}@copilot-plugins`,
            installed: false,
            registered: false
          });
        }
      }
    }
  } catch (e) {
    console.warn('[discover] Failed to browse marketplace:', e.message);
  }

  // 3. Scan directories for repo agents and local plugins
  const scanDirs = (req.query.dirs || '').split(',').filter(Boolean);
  if (scanDirs.length === 0) {
    const parentDir = path.dirname(__dirname);
    try {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      entries.forEach(e => {
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.worktrees') && e.name !== 'sessions') {
          scanDirs.push(path.join(parentDir, e.name));
        }
      });
    } catch { /* ignore */ }
  }

  for (const dir of scanDirs) {
    try {
      // 3a. .github/agents/*.md (agent definitions with YAML frontmatter)
      const agentsDir = path.join(dir, '.github', 'agents');
      if (fs.existsSync(agentsDir)) {
        const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const info = readAgentMd(path.join(agentsDir, file));
          if (info?.name) {
            const id = info.name;
            discovered.push({
              source: 'repo-agent',
              id,
              name: id,
              displayName: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
              description: info.description || '',
              cwd: dir,
              repoName: path.basename(dir),
              registered: registeredIds.has(id)
            });
          }
        }
      }

      // 3b. .github/plugin/*/plugin.json (local/uninstalled plugins in repos)
      const pluginDir = path.join(dir, '.github', 'plugin');
      if (fs.existsSync(pluginDir)) {
        // Try to get GitHub owner/repo from git remote
        let ghOwnerRepo = null;
        try {
          const { execSync: es } = require('child_process');
          const remote = es('git remote get-url origin', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim();
          const ghMatch = remote.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
          if (ghMatch) ghOwnerRepo = ghMatch[1];
        } catch { /* not a git repo or no remote */ }

        const dirs2 = fs.readdirSync(pluginDir, { withFileTypes: true }).filter(e => e.isDirectory());
        for (const pd of dirs2) {
          const pj = readPluginJson(path.join(pluginDir, pd.name));
          const id = pj?.name || pd.name;
          // Skip if already discovered as installed
          if (!discovered.some(d => d.id === id && d.source === 'installed-plugin')) {
            const pluginSubPath = `.github/plugin/${pd.name}`;
            const installCmd = ghOwnerRepo ? `${ghOwnerRepo}:${pluginSubPath}` : null;
            const pluginDirPath = path.join(pluginDir, pd.name);
            const mcpJsonPath = path.join(pluginDirPath, '.mcp.json');
            const hasMcpConfig = fs.existsSync(mcpJsonPath);
            discovered.push({
              source: 'repo-plugin',
              id,
              name: id,
              displayName: (pj?.name || pd.name).split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
              description: pj?.description || '',
              version: pj?.version || '',
              cwd: dir,
              repoName: path.basename(dir),
              pluginDir: pluginDirPath,
              mcpConfig: hasMcpConfig ? `.github\\plugin\\${pd.name}\\.mcp.json` : null,
              installCmd,
              installed: installedNames.has(id),
              registered: registeredIds.has(id)
            });
          }
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  // 4. Include already-registered agents for completeness
  const registered = [];
  for (const [id, entry] of supervisor.agents) {
    registered.push({ id, name: entry.config.name, group: entry.config.group });
  }

  res.json({ discovered, registered });
});

// Install a plugin
// Register a materialized local plugin directory into Copilot's config.json via
// a directory junction. Shared by /api/plugins/install (copilot-local) and the
// Azure DevOps install/reinstall paths.
function registerLocalPluginInCopilot(pluginDir) {
  const { execSync } = require('child_process');
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const configPath = path.join(homeDir, '.copilot', 'config.json');
  const pluginsDir = path.join(homeDir, '.copilot', 'installed-plugins', '_direct');
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) throw new Error('No plugin.json found in ' + pluginDir);
  const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  const pluginName = pluginMeta.name;
  const targetDir = path.join(pluginsDir, pluginName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    execSync(`mklink /J "${targetDir}" "${pluginDir}"`, { shell: true });
  }
  const configRaw = fs.readFileSync(configPath, 'utf-8');
  const configClean = configRaw.replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(configClean);
  if (!config.installedPlugins) config.installedPlugins = [];
  const existing = config.installedPlugins.findIndex(p => p.name === pluginName);
  const entry = {
    name: pluginName,
    marketplace: '',
    version: pluginMeta.version || '1.0.0',
    installed_at: new Date().toISOString(),
    enabled: true,
    cache_path: targetDir,
    source: { source: 'local', path: pluginDir }
  };
  if (existing >= 0) config.installedPlugins[existing] = entry;
  else config.installedPlugins.push(entry);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { pluginName, targetDir };
}

app.post('/api/plugins/install', (req, res) => {
  const { execSync } = require('child_process');
  const { installCmd, pluginDir, engine } = req.body;
  const copilotPath = process.env.COPILOT_PATH || 'copilot';

  if (engine === 'overlay' && pluginDir) {
    // Install as supervisor-managed overlay: copy plugin, patch agent for tool access
    try {
      const pluginJsonPath = path.join(pluginDir, 'plugin.json');
      if (!fs.existsSync(pluginJsonPath)) {
        return res.status(400).json({ error: 'No plugin.json found in ' + pluginDir });
      }
      const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      const pluginName = pluginMeta.name;
      const overlayDir = path.join(PLUGINS_DIR, pluginName);

      // Copy plugin to overlay directory
      if (fs.existsSync(overlayDir)) {
        fs.rmSync(overlayDir, { recursive: true });
      }
      fs.cpSync(pluginDir, overlayDir, { recursive: true });

      // Patch agent files: remove tools: restriction so MCP tools are accessible
      const agentsDir = path.join(overlayDir, 'agents');
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
          const agentFile = path.join(agentsDir, f);
          let content = fs.readFileSync(agentFile, 'utf-8').replace(/\r\n/g, '\n');
          // Remove tools: block from YAML frontmatter
          content = content.replace(/^(---\n[\s\S]*?)(tools:\n(?:\s+-[^\n]*\n)*)([\s\S]*?---)/m, '$1$3');
          fs.writeFileSync(agentFile, content);
        }
      }

      // Patch .mcp.json: replace thrive-dataservice with uvx microsoft-fabric-rti-mcp
      const mcpJsonPath = path.join(overlayDir, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        let mcpContent = fs.readFileSync(mcpJsonPath, 'utf-8');
        try {
          const mcpConfig = JSON.parse(mcpContent);
          let patched = false;
          for (const [name, server] of Object.entries(mcpConfig.mcpServers || {})) {
            if (server.command === 'thrive-dataservice') {
              const cluster = (server.env && server.env.THRIVE_KUSTO_CLUSTER_NAME) || '';
              const db = (server.env && server.env.THRIVE_DATABASE_NAME) || 'engineeringdata';
              mcpConfig.mcpServers[name] = {
                command: 'uvx',
                args: ['microsoft-fabric-rti-mcp@latest', '--service-uri', cluster, '--database', db],
                env: {}
              };
              patched = true;
            }
          }
          if (patched) {
            fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
          }
        } catch { /* leave as-is if parse fails */ }
      }

      return res.json({
        ok: true,
        output: `Installed "${pluginName}" as supervisor overlay in plugins/${pluginName}`,
        overlayDir,
        pluginName,
        sourceDir: pluginDir
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (engine === 'agency' && pluginDir) {
    // Install via Agency (supports local paths and ADO repos)
    try {
      const output = execSync(`agency plugin install "local:${pluginDir}" --engine copilot`, { encoding: 'utf-8', timeout: 60000, shell: true });
      return res.json({ ok: true, output });
    } catch (e) {
      return res.status(500).json({ error: e.stderr || e.message });
    }
  }

  if (engine === 'copilot-local' && pluginDir) {
    // Register a local plugin directly in Copilot's config.json
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME;
      const configPath = path.join(homeDir, '.copilot', 'config.json');
      const pluginsDir = path.join(homeDir, '.copilot', 'installed-plugins', '_direct');

      // Read plugin.json for metadata
      const pluginJsonPath = path.join(pluginDir, 'plugin.json');
      if (!fs.existsSync(pluginJsonPath)) {
        return res.status(400).json({ error: 'No plugin.json found in ' + pluginDir });
      }
      const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      const pluginName = pluginMeta.name;

      // Create junction/symlink in Copilot's plugin directory
      const targetDir = path.join(pluginsDir, pluginName);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(pluginsDir, { recursive: true });
        execSync(`mklink /J "${targetDir}" "${pluginDir}"`, { shell: true });
      }

      // Add to installedPlugins in config.json
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      // Strip // comments (config.json has them)
      const configClean = configRaw.replace(/^\s*\/\/.*$/gm, '');
      const config = JSON.parse(configClean);
      if (!config.installedPlugins) config.installedPlugins = [];

      const existing = config.installedPlugins.findIndex(p => p.name === pluginName);
      const entry = {
        name: pluginName,
        marketplace: '',
        version: pluginMeta.version || '1.0.0',
        installed_at: new Date().toISOString(),
        enabled: true,
        cache_path: targetDir,
        source: { source: 'local', path: pluginDir }
      };
      if (existing >= 0) {
        config.installedPlugins[existing] = entry;
      } else {
        config.installedPlugins.push(entry);
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return res.json({ ok: true, output: `Registered "${pluginName}" in Copilot (junction → ${pluginDir})` });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (installCmd) {
    // Standard install via copilot marketplace/GitHub
    try {
      const output = execSync(`"${copilotPath}" plugin install ${installCmd}`, { encoding: 'utf-8', timeout: 60000, shell: true });
      return res.json({ ok: true, output });
    } catch (e) {
      return res.status(500).json({ error: e.stderr || e.message });
    }
  }

  if (pluginDir) {
    return res.status(400).json({
      error: 'Use "Install for Copilot" or "Install via Agency" to install local plugins.'
    });
  }

  res.status(400).json({ error: 'installCmd or pluginDir required' });
});

// ---- Azure DevOps git: discover + install agents/plugins from a repo --------
// Auth is secretless via the locally signed-in Azure CLI (see azdo.js).

app.get('/api/azdo/repos', async (req, res) => {
  const { org, project } = req.query;
  if (!org || !project) return res.status(400).json({ error: 'org and project are required' });
  try {
    res.json({ repos: await azdo.listRepos(org, project) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/azdo/branches', async (req, res) => {
  const { org, project, repo } = req.query;
  if (!org || !project || !repo) return res.status(400).json({ error: 'org, project and repo are required' });
  try {
    res.json({ branches: await azdo.listBranches(org, project, repo) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/azdo/discover', async (req, res) => {
  const { org, project, repo, branch } = req.query;
  if (!org || !project || !repo || !branch) return res.status(400).json({ error: 'org, project, repo and branch are required' });
  try {
    let registered = [];
    try { registered = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8')); } catch {}
    const isRegistered = (d) => registered.some(a => {
      const s = a.source;
      // Source-aware match: an item from THIS azdo source is registered even if
      // its id was suffixed to coexist with a same-id install from elsewhere.
      if (s && s.type === 'azdo') {
        return s.org === org && s.project === project && s.repo === repo && s.path === d.path;
      }
      return a.id === d.id;
    });
    const discovered = (await azdo.discover(org, project, repo, branch))
      .map(d => ({ ...d, registered: isRegistered(d) }));
    res.json({ discovered });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Materialize + register an AzDO agent/plugin. Shared by /api/azdo/install and
// the marketplace install endpoint. Returns the persisted agent config.
// Two installs of the same logical item from the SAME source update in place
// (same id). Installs of the same base id from a DIFFERENT source coexist by
// suffixing the id with the source kind (e.g. "helix-ux-standup-azdo").
function sameInstallSource(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'azdo') return a.org === b.org && a.project === b.project && a.repo === b.repo && a.path === b.path;
  if (a.type === 'local') return String(a.path || '') === String(b.path || '');
  return false;
}
function sourceSuffix(source) {
  if (!source) return 'src';
  if (source.type === 'azdo') return 'azdo';
  if (source.type === 'local') return 'local';
  return String(source.type || 'src');
}
// Resolve the id to persist for a new install, honoring same-source overwrite
// and different-source coexistence. Returns { id, suffixed }.
function resolveInstallId(baseId, newSource, agents) {
  const existing = agents.find(a => a.id === baseId);
  // Free, or it's the same logical source (an update/reinstall) -> reuse base id.
  if (!existing) return { id: baseId, suffixed: false };
  if (sameInstallSource(existing.source, newSource)) return { id: baseId, suffixed: false };
  // Collision with a different (or source-less) entry -> suffix by source kind.
  const suffix = sourceSuffix(newSource);
  let candidate = `${baseId}-${suffix}`;
  let n = 1;
  while (true) {
    const c = agents.find(a => a.id === candidate);
    if (!c) return { id: candidate, suffixed: true };
    if (sameInstallSource(c.source, newSource)) return { id: candidate, suffixed: true };
    n++;
    candidate = `${baseId}-${suffix}-${n}`;
  }
}

async function installAzdoItem({ org, project, repo, branch, item, group }) {
  const source = {
    type: 'azdo', kind: item.kind, org, project, repo, branch,
    path: item.path, objectId: item.objectId || null,
    installedAt: new Date().toISOString()
  };
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const { id: finalId, suffixed } = resolveInstallId(item.id, source, agents);
  const baseName = item.displayName || item.name || item.id;
  const name = suffixed ? `${baseName} (Azure DevOps)` : baseName;
  let config;
  if (item.kind === 'plugin') {
    const { pluginDir, mcpConfig } = await azdo.materializePlugin(org, project, repo, branch, item);
    registerLocalPluginInCopilot(pluginDir);
    config = {
      id: finalId,
      name,
      cwd: azdo.repoRoot(org, project, repo, branch),
      pluginDir,
      sourceDir: pluginDir,
      agent: ensurePluginAgent(pluginDir),
      schedule: 'never',
      durable: true,
      group: group || 'Azure DevOps',
      description: item.description || '',
      source
    };
    if (mcpConfig) config.mcpConfig = mcpConfig;
  } else {
    const { cwd, mcpConfig, skillCount } = await azdo.materializeAgent(org, project, repo, branch, item.path);
    config = {
      id: finalId,
      name,
      cwd,
      agent: item.agentRef || item.name || item.id,
      schedule: 'never',
      durable: true,
      group: group || 'Azure DevOps',
      description: item.description || '',
      source
    };
    if (mcpConfig) config.mcpConfig = mcpConfig;
    // Co-located MCP/skills were materialized: run this agent through the
    // generated runtime package so they're actually wired at run time.
    if (mcpConfig || skillCount) config.usePackage = true;
  }
  const existing = agents.findIndex(a => a.id === config.id);
  if (existing >= 0) agents[existing] = config; else agents.push(config);
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  supervisor.register(config);
  broadcastSSE('agent-update', { agentId: config.id });
  return config;
}

app.post('/api/azdo/install', async (req, res) => {
  const { org, project, repo, branch, item, group } = req.body || {};
  if (!org || !project || !repo || !branch || !item || !item.kind || !item.id) {
    return res.status(400).json({ error: 'org, project, repo, branch and item{kind,id,path} are required' });
  }
  try {
    const config = await installAzdoItem({ org, project, repo, branch, item, group });
    res.json({ ok: true, agent: config });
  } catch (e) {
    res.status(500).json({ error: `Azure DevOps install failed: ${e.message}` });
  }
});

// ============ Marketplace API Routes ============
// Sources (local folders / AzDO repos) are scanned greedily for agents,
// plugins, skills and MCP servers; the catalog merges scanned entries with an
// implicit "installed" view. Capabilities can be added to any agent (reusing
// the Phase 2 overlay attach), and agents/plugins installed via the existing
// AzDO / local register paths.

app.get('/api/marketplace/sources', (req, res) => {
  try { res.json({ sources: marketplace.listSources() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/sources', (req, res) => {
  try { res.json({ ok: true, source: marketplace.addSource(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Suggest marketplace sources derived from the source locations of installed
// agents/plugins (azdo repos + local folders). Preview only — nothing is added.
app.get('/api/marketplace/sources/suggested', (req, res) => {
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    res.json({ suggested: marketplace.suggestSources(agents) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add (and optionally scan) the suggested sources that aren't already present.
app.post('/api/marketplace/sources/autopopulate', async (req, res) => {
  const scan = (req.body && req.body.scan) !== false; // default true
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const suggestions = marketplace.suggestSources(agents).filter(s => !s.exists);
    const added = [];
    const errors = [];
    for (const s of suggestions) {
      const { id, exists, from, ...input } = s;
      let source;
      try { source = marketplace.addSource(input); }
      catch (e) { errors.push({ id, label: s.label, error: e.message }); continue; }
      added.push(source);
      if (scan) {
        try { await marketplace.scanSource(source.id); }
        catch (e) { errors.push({ id: source.id, label: source.label, error: `scan: ${e.message}` }); }
      }
    }
    res.json({ ok: true, added, errors, sources: marketplace.listSources() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/sources/:id', (req, res) => {
  try {
    const ok = marketplace.removeSource(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/sources/:id/scan', async (req, res) => {
  try { res.json({ ok: true, ...(await marketplace.scanSource(req.params.id)) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/marketplace/catalog', (req, res) => {
  try {
    const result = marketplace.getCatalog({
      type: req.query.type || null,
      q: req.query.q || null,
      sourceId: req.query.sourceId || null,
    });
    decorateCatalogInstallState(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark catalog entries with whether they're already part of our system:
//  - agent|plugin  -> installed: true if a registered agent matches it
//  - skill|mcp     -> inUse: true if the capability catalog already has it
// Matching is done on normalized identity tokens (name/ref/plugin folder).
function decorateCatalogInstallState(result) {
  if (!result || !Array.isArray(result.entries)) return result;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const baseName = (p) => norm(String(p || '').split(/[\\/]/).filter(Boolean).pop());

  // Installed agents/plugins -> identity tokens.
  const installedTokens = new Set();
  let agents = [];
  try { agents = supervisor.getAllStatus() || []; } catch (_) {}
  for (const a of agents) {
    const cfg = a.config || {};
    const ref = cfg.agent || a.agent || '';
    [a.agent_id, cfg.name, cfg.displayName, ref].forEach(v => { if (v) installedTokens.add(norm(v)); });
    if (ref && ref.includes(':')) {
      installedTokens.add(norm(ref.split(':')[0]));
      installedTokens.add(norm(ref.split(':').pop()));
    }
    const pdir = cfg.pluginDir || a.pluginDir;
    if (pdir) installedTokens.add(baseName(pdir));
  }

  // Skills/MCP already present in our capability catalog.
  const skillNames = new Set();
  const mcpNames = new Set();
  try {
    const cat = capabilities.buildCatalog();
    for (const s of cat.skills || []) skillNames.add(norm(s.name));
    for (const m of cat.mcp || []) mcpNames.add(norm(m.name));
  } catch (_) {}

  for (const e of result.entries) {
    if (e.type === 'agent' || e.type === 'plugin') {
      const tokens = [e.name, e.displayName];
      if (e.plugin && e.plugin.dir) tokens.push(baseName(e.plugin.dir));
      if (e.agent && e.agent.ref) { tokens.push(e.agent.ref); tokens.push(String(e.agent.ref).split(':')[0]); }
      e.installed = tokens.some(t => t && installedTokens.has(norm(t)));
    } else if (e.type === 'skill') {
      e.inUse = skillNames.has(norm(e.name));
    } else if (e.type === 'mcp') {
      const server = (e.mcp && e.mcp.server) || e.name;
      e.inUse = mcpNames.has(norm(server));
    }
  }
  return result;
}

// Install / add a catalog entry.
//  - agent|plugin from an azdo source -> materialize + register (reuse azdo install)
//  - agent|plugin from a local source -> register an agents.json entry
//  - skill|mcp + agentId -> attach to that agent's overlay (Phase 2)
app.post('/api/marketplace/install', async (req, res) => {
  const { entryId, agentId, group } = req.body || {};
  if (!entryId) return res.status(400).json({ error: 'entryId is required' });
  const entry = marketplace.findEntry(entryId);
  if (!entry) return res.status(404).json({ error: 'Catalog entry not found' });
  try {
    if (entry.type === 'skill' || entry.type === 'mcp') {
      if (!agentId) return res.status(400).json({ error: 'agentId is required to add a capability to an agent' });
      const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
      const target = agents.find(a => a.id === agentId);
      if (!target) return res.status(404).json({ error: 'Target agent not found' });
      const mat = await marketplace.materializeForAttach(entry);
      let result;
      if (mat.kind === 'mcp') {
        const cfg = capabilities.resolveCatalogMcp(mat.sourcePath, mat.name);
        if (!cfg) return res.status(400).json({ error: 'Could not resolve MCP server config' });
        result = capabilities.attachMcp(agentId, mat.name, cfg);
      } else {
        const dir = capabilities.resolveCatalogSkill(mat.sourceDir);
        if (!dir) return res.status(400).json({ error: 'Could not resolve skill source' });
        result = capabilities.attachSkill(agentId, { name: mat.name, sourceDir: dir });
      }
      broadcastSSE('agent-update', { agentId });
      return res.json({ ok: true, attached: { type: entry.type, name: mat.name, agentId }, result });
    }

    // agent | plugin install
    if (entry.sourceKind === 'azdo' && entry.install && entry.azdo) {
      const { org, project, repo, branch } = entry.azdo;
      const config = await installAzdoItem({ org, project, repo, branch, item: entry.install.item, group });
      return res.json({ ok: true, agent: config });
    }
    if (entry.sourceKind === 'local') {
      const config = installLocalCatalogEntry(entry, group);
      return res.json({ ok: true, agent: config });
    }
    return res.status(400).json({ error: 'This entry cannot be installed directly' });
  } catch (e) {
    res.status(500).json({ error: `Install failed: ${e.message}` });
  }
});

// Marker embedded in agents we synthesize for skills/MCP-only plugins, so the
// update path can tell our stand-in apart from an agent the publisher ships.
const GENERATED_AGENT_MARKER = 'Auto-generated by TheOffice.AI';

function isGeneratedAgentFile(text) {
  return typeof text === 'string' && text.includes(GENERATED_AGENT_MARKER);
}

// Determine the "<pluginName>:<agentSlug>" custom-agent reference a plugin
// exposes by reading its plugin.json + agents/ folder. Returns '' when the
// plugin ships no custom agent (a skills/MCP-only bundle) — those run under the
// default copilot agent with capabilities loaded via --plugin-dir. Fabricating
// a "<name>:<name>" ref for such plugins breaks chat ("Custom agent not found").
function resolvePluginAgentRef(pluginDir) {
  let pluginName = '';
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8'));
    pluginName = (pj && pj.name) || '';
  } catch (_) { /* ignore */ }
  let files = [];
  try {
    files = fs.readdirSync(path.join(pluginDir, 'agents')).filter(f => /\.agent\.md$/i.test(f));
  } catch (_) { return ''; }
  if (!files.length || !pluginName) return '';
  const slugs = files.map(f => f.replace(/\.agent\.md$/i, ''));
  const chosen = slugs.find(s => s.toLowerCase() === pluginName.toLowerCase()) || slugs[0];
  return `${pluginName}:${chosen}`;
}

// Read the bundled skills of a plugin as { name, description } (from each
// skills/*/SKILL.md frontmatter). Best-effort; returns [] on any problem.
function readPluginSkills(pluginDir) {
  const out = [];
  const tryDir = (skillsRoot) => {
    let dirs = [];
    try { dirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) { return; }
    for (const d of dirs) {
      const md = path.join(skillsRoot, d.name, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      let name = d.name, description = '';
      try {
        const raw = fs.readFileSync(md, 'utf-8');
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
          const nm = fm[1].match(/^name:\s*(.+)$/im); if (nm) name = nm[1].replace(/^["']|["']$/g, '').trim();
          const dm = fm[1].match(/^description:\s*(.+)$/im); if (dm) description = dm[1].replace(/^["']|["']$/g, '').trim();
        }
      } catch (_) {}
      out.push({ name, description });
    }
  };
  tryDir(path.join(pluginDir, 'skills'));
  return out;
}

// MCP server names declared by a plugin's .mcp.json (best-effort).
function readPluginMcpServers(pluginDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf-8'));
    return Object.keys((cfg && cfg.mcpServers) || {});
  } catch (_) { return []; }
}

// Pull the "What it does" / overview bullets from a plugin README (best-effort).
function readPluginReadmeBullets(pluginDir) {
  let raw = '';
  for (const f of ['README.md', 'readme.md', 'Readme.md']) {
    try { raw = fs.readFileSync(path.join(pluginDir, f), 'utf-8'); break; } catch (_) {}
  }
  if (!raw) return [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const bullets = [];
  let capture = false;
  for (const ln of lines) {
    if (/^#{1,6}\s/.test(ln)) {
      // Start capturing after a "What it does"/"Overview"/"Features" heading.
      capture = /what it does|overview|features|capabilit/i.test(ln);
      if (!capture && bullets.length) break; // next heading ends the section
      continue;
    }
    if (capture) {
      const m = ln.match(/^\s*[-*]\s+(.+)$/);
      if (m) bullets.push(m[1].trim());
      else if (bullets.length && ln.trim() === '') break;
    }
  }
  return bullets.slice(0, 12);
}

// Intelligently synthesize an .agent.md for a plugin that ships skills/MCP but
// no agent of its own. Reads the plugin's real context (plugin.json, README,
// skills, MCP) and writes agents/<slug>.agent.md INSIDE the plugin so Copilot
// discovers it natively as "<pluginName>:<slug>". Idempotent: if an agent
// already exists it is reused. Returns the agent ref, or '' on failure.
function ensurePluginAgent(pluginDir) {
  const existing = resolvePluginAgentRef(pluginDir);
  if (existing) return existing;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8')) || {}; } catch (_) {}
  const pluginName = meta.name;
  if (!pluginName) return '';
  const slug = String(pluginName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  const description = (meta.description || `Assistant powered by the ${pluginName} plugin.`).replace(/\s+/g, ' ').trim();
  const skills = readPluginSkills(pluginDir);
  const servers = readPluginMcpServers(pluginDir);
  const bullets = readPluginReadmeBullets(pluginDir);
  const pretty = String(meta.displayName || pluginName)
    .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // YAML single-quoted scalar (double any embedded single quotes).
  const yq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = [];
  lines.push('---');
  lines.push(`name: ${slug}`);
  lines.push(`description: ${yq(description)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${pretty} Agent`);
  lines.push('');
  lines.push(`<!-- ${GENERATED_AGENT_MARKER}: this plugin shipped skills/MCP but no agent of its own. Edit freely; delete to regenerate on reinstall. -->`);
  lines.push('');
  lines.push(`You are **${pretty}**, an assistant powered by the \`${pluginName}\` Copilot plugin. ${description}`);
  lines.push('');
  if (bullets.length) {
    lines.push('## What you can do');
    lines.push('');
    for (const b of bullets) lines.push(`- ${b}`);
    lines.push('');
  }
  if (skills.length) {
    lines.push('## Skills');
    lines.push('');
    lines.push('Use these bundled skills — they encode the correct steps, queries, and data sources. Prefer them over improvising:');
    lines.push('');
    for (const s of skills) lines.push(`- **${s.name}**${s.description ? ' — ' + s.description : ''}`);
    lines.push('');
  }
  if (servers.length) {
    lines.push('## Tools');
    lines.push('');
    lines.push('You have access to these MCP servers bundled with the plugin:');
    lines.push('');
    for (const sv of servers) lines.push(`- \`${sv}\``);
    lines.push('');
  }
  lines.push('## How to work');
  lines.push('');
  lines.push("- Clarify the user's goal, then carry it out using the skills and tools above.");
  if (skills.length) lines.push('- For domain tasks, drive the work through the bundled skills rather than guessing.');
  if (servers.length) lines.push('- Query live data through the MCP servers above when the user needs current information.');
  lines.push('- Be concise, show your findings clearly, and cite the data sources you used.');
  lines.push('');

  const agentsDir = path.join(pluginDir, 'agents');
  try {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, `${slug}.agent.md`), lines.join('\n'));
  } catch (e) {
    console.warn('[install] could not generate plugin agent for', pluginName, '-', e.message);
    return '';
  }
  console.log(`[install] generated agent "${pluginName}:${slug}" for skills/MCP-only plugin`);
  return `${pluginName}:${slug}`;
}

// Reconcile a plugin's agent on (re)install/update. Handles the two cases the
// auto-generate feature must survive across updates:
//   1. The new plugin version now ships a real agent of its own -> delete any
//      stand-in we generated previously (so there are no duplicates) and bind to
//      the publisher's agent.
//   2. The plugin is still agent-less -> regenerate our stand-in from the new
//      version's context (description/skills/MCP may have changed) so it stays
//      current, then bind to it.
// Returns the agent ref to persist ('' only if generation fails).
function reconcilePluginAgent(pluginDir) {
  const agentsDir = path.join(pluginDir, 'agents');
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter(f => /\.agent\.md$/i.test(f)); } catch (_) { files = []; }
  const generated = [];
  let hasReal = false;
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(agentsDir, f), 'utf-8'); } catch (_) {}
    if (isGeneratedAgentFile(txt)) generated.push(f); else hasReal = true;
  }
  if (hasReal) {
    // Publisher now ships a real agent — remove our generated stand-ins.
    for (const g of generated) {
      try { fs.unlinkSync(path.join(agentsDir, g)); console.log(`[update] removed generated stand-in agent ${g} (plugin now ships its own)`); } catch (_) {}
    }
    return resolvePluginAgentRef(pluginDir);
  }
  // No real agent: drop stale generated files so ensurePluginAgent regenerates
  // from the current plugin context.
  for (const g of generated) { try { fs.unlinkSync(path.join(agentsDir, g)); } catch (_) {} }
  return ensurePluginAgent(pluginDir);
}

// Register a local agent/plugin catalog entry as an agent.
function installLocalCatalogEntry(entry, group) {
  const baseId = slugifyId(entry.displayName || entry.name || entry.id);
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  let config;
  if (entry.type === 'plugin' && entry.plugin && entry.plugin.dir) {
    const source = { type: 'local', kind: 'plugin', path: entry.plugin.dir, installedAt: new Date().toISOString() };
    const { id: finalId, suffixed } = resolveInstallId(baseId, source, agents);
    const baseName = entry.displayName || entry.name || baseId;
    registerLocalPluginInCopilot(entry.plugin.dir);
    config = {
      id: finalId,
      name: suffixed ? `${baseName} (Local)` : baseName,
      cwd: path.dirname(entry.plugin.dir),
      pluginDir: entry.plugin.dir,
      sourceDir: entry.plugin.dir,
      agent: ensurePluginAgent(entry.plugin.dir),
      schedule: 'never',
      durable: true,
      group: group || 'Marketplace',
      description: entry.description || '',
      source,
    };
  } else if (entry.type === 'agent' && entry.agent) {
    const source = { type: 'local', kind: 'agent', path: entry.path, installedAt: new Date().toISOString() };
    const { id: finalId, suffixed } = resolveInstallId(baseId, source, agents);
    const baseName = entry.displayName || entry.name || baseId;
    config = {
      id: finalId,
      name: suffixed ? `${baseName} (Local)` : baseName,
      cwd: entry.agent.cwd || path.dirname(entry.path || '.'),
      agent: entry.agent.ref || entry.name || baseId,
      schedule: 'never',
      durable: true,
      group: group || 'Marketplace',
      description: entry.description || '',
      source,
    };
  } else {
    throw new Error('Unsupported local entry');
  }
  const existing = agents.findIndex(a => a.id === config.id);
  if (existing >= 0) agents[existing] = config; else agents.push(config);
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  supervisor.register(config);
  broadcastSSE('agent-update', { agentId: config.id });
  return config;
}

function slugifyId(v) {
  return String(v || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

// ---- Marketplace: Design with AI ----
// Propose creative capability attachments for an existing agent (enhance) or a
// brand-new agent composed from the catalog (create). Mirrors the execution
// "Design with AI" mechanism: one-shot runChat -> fenced JSON -> normalize.
app.post('/api/marketplace/design/generate', async (req, res) => {
  const mode = (req.body && req.body.mode) === 'create' ? 'create' : 'enhance';
  const hint = String((req.body && req.body.hint) || '').trim();
  try {
    const catalog = marketplaceDesign.compactCatalog();
    if (!catalog.skills.length && !catalog.mcp.length) {
      return res.status(400).json({ error: 'No marketplace capabilities to design with. Add and scan a source first.' });
    }

    let prompt, agentId = null;
    if (mode === 'enhance') {
      agentId = String((req.body && req.body.agentId) || '').trim();
      if (!agentId) return res.status(400).json({ error: 'agentId is required for enhance mode' });
      const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
      const target = agents.find(a => a.id === agentId);
      if (!target) return res.status(404).json({ error: 'Target agent not found' });
      let caps = { mcp: [], skills: [] };
      try { caps = capabilities.getEffectiveCapabilities(target); } catch (_) {}
      prompt = marketplaceDesign.enhancePrompt(
        { name: target.name || target.id, description: target.description || '' }, caps, catalog, hint);
    } else {
      let inspiration = [];
      try {
        inspiration = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'))
          .slice(0, 20).map(a => ({ name: a.name || a.id, description: String(a.description || '').slice(0, 120) }));
      } catch (_) {}
      prompt = marketplaceDesign.createPrompt(catalog, inspiration, hint);
    }

    let acc = '';
    const result = await sdkRunner.runChat({
      config: null, prompt, sessionId: require('crypto').randomUUID(), resume: false, cwd: __dirname,
      onChunk: (c) => { acc += c; }
    });
    const text = acc.trim() ? acc : (result.output || '');
    const arr = marketplaceDesign.parseProposals(text);
    if (!arr) return res.status(502).json({ error: 'Could not parse AI proposals. Try again.', raw: text.slice(0, 500) });
    const proposals = arr
      .map(p => mode === 'enhance' ? marketplaceDesign.normalizeEnhance(p, agentId) : marketplaceDesign.normalizeCreate(p))
      .filter(Boolean);
    if (!proposals.length) return res.status(502).json({ error: 'AI returned no usable proposals. Try again.' });
    res.json({ mode, proposals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Design proposal helpers (shared by apply + test) ----

// Allocate an agent id that doesn't collide with an existing one.
function uniqueAgentId(agents, base) {
  const slug = marketplaceDesign.slugify(base || 'agent');
  if (!agents.some(a => a.id === slug)) return slug;
  let i = 2;
  while (agents.some(a => a.id === `${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// Copy a source agent's marketplace overlay (attached caps) onto a new id so a
// cloned/test agent inherits everything the original already had.
function copyOverlay(srcId, dstId) {
  const src = agentPackage.overlayDir(srcId);
  const dst = agentPackage.overlayDir(dstId);
  if (src === dst) return;
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
}

// Attach a proposal's capabilities (re-resolved by type:name against the live
// catalog) onto an agent's overlay. Returns { attached, failed }.
async function attachCapsToAgent(agentId, attachArr) {
  const attached = [];
  const failed = [];
  for (const a of Array.isArray(attachArr) ? attachArr : []) {
    try {
      const entry = marketplace.resolveByTypeName(a.type, a.name);
      if (!entry) { failed.push({ ...a, error: 'not found in catalog' }); continue; }
      const mat = await marketplace.materializeForAttach(entry);
      if (mat.kind === 'mcp') {
        const cfg = capabilities.resolveCatalogMcp(mat.sourcePath, mat.name);
        if (!cfg) { failed.push({ ...a, error: 'could not resolve MCP config' }); continue; }
        capabilities.attachMcp(agentId, mat.name, cfg);
      } else {
        const dir = capabilities.resolveCatalogSkill(mat.sourceDir);
        if (!dir) { failed.push({ ...a, error: 'could not resolve skill source' }); continue; }
        capabilities.attachSkill(agentId, { name: mat.name, sourceDir: dir });
      }
      attached.push({ type: a.type, name: mat.name });
    } catch (e) {
      failed.push({ ...a, error: e.message });
    }
  }
  return { attached, failed };
}

// Build the runnable config a proposal describes WITHOUT persisting it to
// agents.json. Used by the "test" flow so a suggestion can be exercised live
// before the user commits to creating the agent. Returns { config, id }.
const DESIGN_TEST_PREFIX = 'dtest-';
async function buildProposalConfig(proposal, { persist } = {}) {
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  let id, config;

  if (proposal.kind === 'create') {
    const spec = proposal.agent || {};
    if (!spec.name || !spec.body) throw new Error('proposal.agent missing name/body');
    if (proposal.newName) spec.name = String(proposal.newName).trim();
    // Fold the user's (possibly edited) test prompt into the agent's core
    // instructions so the created agent embodies the behavior they validated.
    const testPrompt = String(proposal.testPrompt || '').trim();
    if (testPrompt) {
      const objective = ['## Primary Objective', '', testPrompt, ''].join('\n');
      if (!String(spec.body).includes(testPrompt)) {
        spec.body = String(spec.body).trimEnd() + '\n\n' + objective;
      }
    }
    const w = marketplaceDesign.writeGeneratedAgent(spec);
    id = persist ? uniqueAgentId(agents, w.slug) : DESIGN_TEST_PREFIX + require('crypto').randomBytes(4).toString('hex');
    config = {
      id, name: spec.name, cwd: w.dir, agent: w.slug,
      schedule: 'never', durable: true, group: 'Marketplace',
      description: spec.description || '',
      source: { type: 'design', kind: 'agent', path: w.agentMdPath, createdAt: new Date().toISOString() },
    };
  } else if (proposal.kind === 'enhance') {
    const targetId = String(proposal.agentId || '').trim();
    const target = agents.find(a => a.id === targetId);
    if (!target) throw new Error('Target agent not found');
    const newName = (proposal.newName || `${target.name} (enhanced)`).trim();
    id = persist ? uniqueAgentId(agents, marketplaceDesign.slugify(newName))
                 : DESIGN_TEST_PREFIX + require('crypto').randomBytes(4).toString('hex');
    config = {
      ...target,
      id,
      name: newName,
      autoStart: false,
      schedule: 'never',
      durable: true,
      group: target.group || 'Marketplace',
      source: { type: 'design', kind: 'enhanced-clone', from: targetId, createdAt: new Date().toISOString() },
    };
    // Inherit the target's already-attached capabilities, then layer the new ones.
    copyOverlay(targetId, id);
  } else {
    throw new Error('Unknown proposal kind');
  }
  return { config, id };
}

// Apply a design proposal. Both kinds now CREATE a new agent:
//   create  -> write + register a brand-new generated agent
//   enhance -> clone the target into a new agent (original is left untouched)
// then attach the proposed capabilities. The new agent can be exported to AzDO.
app.post('/api/marketplace/design/apply', async (req, res) => {
  const proposal = req.body && req.body.proposal;
  if (!proposal || !proposal.kind) return res.status(400).json({ error: 'proposal is required' });
  if (req.body.name) proposal.newName = String(req.body.name).trim();
  if (req.body.testPrompt != null) proposal.testPrompt = String(req.body.testPrompt);
  try {
    const { config, id: agentId } = await buildProposalConfig(proposal, { persist: true });
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    agents.push(config);
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    supervisor.register(config);

    const { attached, failed } = await attachCapsToAgent(agentId, proposal.attach);
    broadcastSSE('agent-update', { agentId });
    res.json({ ok: true, kind: proposal.kind, agentId, created: config, attached, failed });
  } catch (e) {
    const msg = e.message || 'Apply failed';
    const code = /not found/i.test(msg) ? 404 : (/missing|required/i.test(msg) ? 400 : 500);
    res.status(code).json({ error: `Apply failed: ${msg}` });
  }
});

// Test a design proposal LIVE before committing. Stages the would-be agent to a
// throwaway id, attaches the proposed caps, and runs a single chat turn the
// client streams via GET /api/sessions/:sessionId/poll?verbose=1. Nothing is
// written to agents.json; throwaway overlays/packages are reaped here.
app.post('/api/marketplace/design/test', async (req, res) => {
  const proposal = req.body && req.body.proposal;
  if (!proposal || !proposal.kind) return res.status(400).json({ error: 'proposal is required' });
  const prompt = String((req.body && req.body.prompt) || '').trim()
    || 'Briefly: what tools and skills do you currently have access to? List them by name, then confirm you can use them.';
  try {
    // Reap prior throwaway test artifacts (best-effort).
    reapDesignTestArtifacts();

    const { config, id: testId } = await buildProposalConfig(proposal, { persist: false });
    const { attached, failed } = await attachCapsToAgent(testId, proposal.attach);
    config.name = `${config.name} (test)`;

    const sessionId = require('crypto').randomUUID();
    designTestSessions.set(sessionId, testId);
    runChatTurn({ sessionId, message: prompt, config, resume: false, agentId: testId });
    res.json({ ok: true, sessionId, testId, prompt, attached, failed });
  } catch (e) {
    const msg = e.message || 'Test failed';
    const code = /not found/i.test(msg) ? 404 : (/missing|required/i.test(msg) ? 400 : 500);
    res.status(code).json({ error: `Test failed: ${msg}` });
  }
});

const designTestSessions = new Map(); // sessionId -> testId
function reapDesignTestArtifacts() {
  for (const root of [agentPackage.OVERLAYS_ROOT, agentPackage.PACKAGES_ROOT]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (n.startsWith(DESIGN_TEST_PREFIX) || n.startsWith('gen-' + DESIGN_TEST_PREFIX)) {
        try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch (_) {}
      }
    }
  }
}
// ============ End Marketplace API Routes ============

// SPA — serve new unified app for all page routes
function serveSpa(req, res) {
  if (fs.existsSync(SPA_PATH)) {
    res.sendFile(SPA_PATH);
  } else {
    // SPA asset missing (degraded state). The legacy embedded dashboard has been removed.
    res.status(503).send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>TheOffice.AI</title></head><body style="font-family:system-ui;padding:40px"><h1>TheOffice.AI</h1><p>The SPA bundle (<code>public/app.html</code>) was not found. Please restore it and reload.</p></body></html>');
  }
}
['/', '/agents', '/dashboard', '/managers', '/tasks', '/chat', '/activity', '/marketplace'].forEach(route => {
  app.get(route, serveSpa);
});

// Version/health endpoint for verifying deployed version
app.get('/api/version', (req, res) => {
  res.json({
    gitHash: GIT_VERSION.hash,
    gitMessage: GIT_VERSION.message,
    dirty: GIT_VERSION.dirty,
    fileHash: GIT_VERSION.fileHash || 'unknown',
    pid: PROCESS_PID,
    startedAt: PROCESS_START,
    uptime: Math.round(process.uptime()) + 's'
  });
});

// API Routes
app.get('/api/agents', (req, res) => {
  res.json(supervisor.getAllStatus());
});

app.get('/api/agents/:id', (req, res) => {
  const status = supervisor.getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Agent not found' });
  res.json(status);
});

app.get('/api/agents/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(supervisor.getRunHistory(req.params.id, limit));
});

// Agent statistics
app.get('/api/agents/:id/stats', (req, res) => {
  const agentId = req.params.id;
  const rows = db.prepare(`SELECT exit_code, started_at, finished_at FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC`).all(agentId);
  const total = rows.length;
  const success = rows.filter(r => r.exit_code === 0).length;
  const fail = total - success;
  let avgDuration = 0;
  const durations = rows.filter(r => r.started_at && r.finished_at).map(r => new Date(r.finished_at) - new Date(r.started_at));
  if (durations.length > 0) avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const lastRun = rows.length > 0 ? rows[0].started_at : null;
  res.json({ total, success, fail, avgDuration, lastRun });
});

// Live output for a running agent
app.get('/api/agents/:id/live', (req, res) => {
  const live = supervisor.getLiveOutput(req.params.id);
  if (!live) return res.json({ running: false });
  res.json({ running: true, ...live });
});

app.post('/api/agents/:id/start', (req, res) => {
  try {
    supervisor.start(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/agents/:id/stop', (req, res) => {
  supervisor.stop(req.params.id);
  broadcastSSE('agent-status', { id: req.params.id, status: 'stopped' });
  res.json({ ok: true });
});

app.post('/api/agents/:id/run', (req, res) => {
  try {
    supervisor._executeAgent(req.params.id);
    broadcastSSE('run-started', { id: req.params.id, type: 'agent', timestamp: new Date().toISOString() });
    res.json({ ok: true, message: 'Execution triggered' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Chat with an agent — starts/resumes an SDK session and sends a prompt.
app.post('/api/agents/:id/chat', (req, res) => {
  const { message, sessionId: existingSessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const agentEntry = supervisor.agents.get(req.params.id);
  if (!agentEntry) return res.status(404).json({ error: 'Agent not found' });

  const config = agentEntry.config;
  const resume = !!existingSessionId;
  const sessionId = existingSessionId || crypto.randomUUID();

  runChatTurn({ sessionId, message, config, resume, agentId: req.params.id });

  // Return the pinned session id immediately so the client can poll it directly
  // (no session-dir correlation needed). The turn streams in the background.
  res.json({ ok: true, started: true, sessionId, existingSessionId: existingSessionId || null });
});

// Open a real, interactive `copilot` CLI terminal for an agent and bind it to a
// chat in our system. We pin a fresh session UUID via --session-id so the CLI
// writes events to ~/.copilot/session-state/<uuid>/events.jsonl, which we mirror
// back into a source:'cli' chat (read-only). The agent's plugin/package/project
// wiring is resolved by sdk-runner so the terminal boots with the same org.
function launchAgentCliSession(agentEntry) {
  const sessionId = crypto.randomUUID();
  const { args, cwd, agent } = sdkRunner.resolveCliLaunch(agentEntry.config);
  const copilotPath = process.env.COPILOT_PATH || 'copilot';
  const launchArgs = ['--session-id', sessionId, '--banner', ...args];
  const os = require('os');
  // Batch-file quoting: wrap any token with whitespace/quotes.
  const q = (a) => (/[\s"]/.test(String(a)) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a));
  // copilot is a .cmd shim; invoke via `call` so the launcher window survives it.
  const cmdLine = 'call ' + q(copilotPath) + ' ' + launchArgs.map(q).join(' ');
  const title = ('Copilot CLI - ' + (agent || agentEntry.config.name || 'agent')).replace(/[\r\n]/g, ' ');
  const launcher = path.join(os.tmpdir(), `cli-session-${sessionId}.cmd`);
  const body = [
    '@echo off',
    'title ' + title,
    'cd /d ' + q(cwd),
    'echo Copilot CLI session ' + sessionId,
    'echo Agent: ' + (agent || '(default)'),
    'echo.',
    cmdLine,
    'echo.',
    'echo [session ended - press any key to close]',
    'pause >nul'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(launcher, body);
  const { spawn } = require('child_process');
  spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', launcher], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { sessionId, args: launchArgs, cwd, agent, launcher };
}

app.post('/api/agents/:id/cli-session', (req, res) => {
  const agentEntry = supervisor.agents.get(req.params.id);
  if (!agentEntry) return res.status(404).json({ error: 'Agent not found' });
  let launch;
  try {
    launch = launchAgentCliSession(agentEntry);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to launch CLI session: ' + e.message });
  }
  const name = agentEntry.config.name || agentEntry.config.agent || req.params.id;
  const chatId = `agent-${String(req.params.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-cli-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const chat = {
    id: chatId,
    title: `${name} · CLI session`,
    target: req.params.id,
    targetType: 'agent',
    source: 'cli',
    cliSessionId: launch.sessionId,
    cwd: launch.cwd,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  try {
    fs.writeFileSync(path.join(CHATS_DIR, `${chatId}.json`), JSON.stringify(chat, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'CLI launched but failed to save chat: ' + e.message });
  }
  broadcastSSE('chat-created', { chatId, target: req.params.id, targetType: 'agent' });
  res.json({ ok: true, chatId, sessionId: launch.sessionId, agent: launch.agent, cwd: launch.cwd });
});

// Find the chat session for an agent. Prefers the pinned id tracked when chat
// started; falls back to a legacy session-dir scan for sessions created before
// this server started (e.g. external/older sessions).
app.get('/api/agents/:id/session', (req, res) => {
  const agentEntry = supervisor.agents.get(req.params.id);
  if (!agentEntry) return res.status(404).json({ error: 'Agent not found' });

  // Authoritative: the id we pinned when this agent's chat last ran.
  const tracked = agentChatSessions.get(req.params.id);
  if (tracked) {
    const buf = liveChatBuffers.get(tracked);
    let isActive = !!(buf && buf.running);
    let lastModified = new Date((buf && buf.lastUpdate) || Date.now()).toISOString();
    if (!isActive) {
      try {
        const ep = path.join(STATE_DIR, tracked, 'events.jsonl');
        if (fs.existsSync(ep)) {
          const stat = fs.statSync(ep);
          isActive = (Date.now() - stat.mtime.getTime()) < 30000;
          lastModified = stat.mtime.toISOString();
        }
      } catch {}
    }
    return res.json({ sessionId: tracked, isActive, lastModified });
  }

  const SESSION_STATE_DIR = STATE_DIR;
  if (!fs.existsSync(SESSION_STATE_DIR)) return res.json({ sessionId: null });
  
  const agentName = agentEntry.config.agent || agentEntry.config.name || req.params.id;
  const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, mtime: fs.statSync(path.join(SESSION_STATE_DIR, d.name)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  
  for (const dir of dirs.slice(0, 50)) {
    const eventsPath = path.join(SESSION_STATE_DIR, dir.name, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) continue;
    const content = fs.readFileSync(eventsPath, 'utf-8');
    
    // Only match sessions that were STARTED with this agent — check session.start or subagent.selected events
    // Avoid matching sessions that merely mention the agent name in conversation
    let isAgentSession = false;
    const lines = content.split('\n').filter(Boolean).slice(0, 20); // Only check first 20 events for performance
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'subagent.selected' && ev.data) {
          const selectedName = (ev.data.agentDisplayName || ev.data.agentName || '').toLowerCase();
          if (selectedName === agentName.toLowerCase() || selectedName.includes(req.params.id.toLowerCase())) {
            isAgentSession = true;
            break;
          }
        }
        if (ev.type === 'session.start' && ev.data?.context?.agentName) {
          const startAgent = ev.data.context.agentName.toLowerCase();
          if (startAgent === agentName.toLowerCase() || startAgent.includes(req.params.id.toLowerCase())) {
            isAgentSession = true;
            break;
          }
        }
      } catch {}
    }
    
    if (isAgentSession) {
      const stat = fs.statSync(eventsPath);
      const isActive = (Date.now() - stat.mtime.getTime()) < 30000;
      return res.json({ sessionId: dir.name, isActive, lastModified: stat.mtime.toISOString() });
    }
  }
  res.json({ sessionId: null });
});

app.put('/api/agents/:id/schedule', (req, res) => {
  // Policy: only tasks, assignments, and flows carry saved schedules. Agents run
  // via tasks (scheduled prompts), triggers, or manual execution — never on their
  // own saved schedule. This endpoint is intentionally disabled.
  res.status(410).json({ error: 'Agents cannot be scheduled. Create a scheduled Task for this agent instead.' });
});

// Update agent group
app.put('/api/agents/:id/group', (req, res) => {
  const { group } = req.body;
  if (group === undefined) return res.status(400).json({ error: 'group required' });
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  agent.group = group || undefined;
  if (!group) delete agent.group;
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  // Update in-memory
  const entry = supervisor.agents.get(req.params.id);
  if (entry) entry.config.group = group || undefined;
  broadcastSSE('agent-update', { agentId: req.params.id });
  res.json({ ok: true });
});

// Update agent prompt
app.put('/api/agents/:id/prompt', (req, res) => {
  // Deprecated: agents no longer carry a definition prompt. Prompts come from
  // tasks, assignments, and chains/flows. Kept as a 410 so old clients fail loud.
  res.status(410).json({ error: 'Agents no longer have a definition prompt. Create a Task, assignment, or flow instead.' });
});

// Update agent description and/or skills (used by managers to route requests)
app.put('/api/agents/:id/details', (req, res) => {
  const { description, skills } = req.body || {};
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });

  // Normalize skills into a clean string array
  let normalizedSkills;
  if (skills !== undefined) {
    if (Array.isArray(skills)) {
      normalizedSkills = skills.map(s => String(s).trim()).filter(Boolean);
    } else if (typeof skills === 'string') {
      normalizedSkills = skills.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      return res.status(400).json({ error: 'skills must be an array or comma-separated string' });
    }
  }

  if (description !== undefined) entry.config.description = String(description);
  if (normalizedSkills !== undefined) entry.config.skills = normalizedSkills;

  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === req.params.id);
  if (agent) {
    if (description !== undefined) agent.description = String(description);
    if (normalizedSkills !== undefined) agent.skills = normalizedSkills;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  }
  res.json({ ok: true, description: entry.config.description || '', skills: entry.config.skills || [] });
});

// ---- Marketplace: agent capabilities (MCP servers + skills) ----------------
// Attached capabilities live in a per-agent overlay dir on disk and are merged
// into the agent's runtime by sdk-runner._applyOverlayCaps at run time, so an
// attach takes effect on the NEXT run/chat with no re-register needed.

// Effective (attached) capabilities + the full installable catalog.
app.get('/api/agents/:id/capabilities', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json({
      effective: capabilities.getEffectiveCapabilities(entry.config),
      catalog: capabilities.buildCatalog(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Attach an MCP server. Body: { name, config } for an explicit server, or
// { name, sourcePath } / { catalogName } to pull a server out of the catalog.
app.post('/api/agents/:id/capabilities/mcp', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  let { name, config, sourcePath, catalogName } = req.body || {};
  try {
    if (!config) {
      // Pull the real (non-redacted) server config from the catalog source file.
      if (sourcePath && (name || catalogName)) {
        config = capabilities.resolveCatalogMcp(sourcePath, name || catalogName);
        name = name || catalogName;
      }
      if (!config) {
        const cat = capabilities.buildCatalog();
        const match = cat.mcp.find(m =>
          (sourcePath && m.sourcePath === sourcePath && (!name || m.name === name)) ||
          (catalogName && m.name === catalogName) ||
          (name && m.name === name));
        if (!match) return res.status(400).json({ error: 'MCP server not found in catalog; provide an explicit config' });
        name = name || match.name;
        config = capabilities.resolveCatalogMcp(match.sourcePath, match.name)
          || { command: match.command, args: match.args || [], env: {} };
      }
    }
    if (!name) return res.status(400).json({ error: 'name required' });
    capabilities.attachMcp(req.params.id, name, config);
    broadcastSSE('agent-update', { agentId: req.params.id, capability: 'mcp', action: 'attach', name });
    res.json({ ok: true, effective: capabilities.getEffectiveCapabilities(entry.config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Validate that an MCP server is usable on this machine by actually starting it
// (the way the agent runtime would) and attempting an MCP `initialize`
// handshake. Body: { name, sourcePath } / { catalogName } / { config }.
app.post('/api/mcp/test', async (req, res) => {
  let { name, config, sourcePath, catalogName } = req.body || {};
  try {
    if (!config) {
      if (sourcePath && (name || catalogName)) {
        config = capabilities.resolveCatalogMcp(sourcePath, name || catalogName);
        name = name || catalogName;
      }
      if (!config) {
        const cat = capabilities.buildCatalog();
        const match = cat.mcp.find(m =>
          (sourcePath && m.sourcePath === sourcePath && (!name || m.name === name)) ||
          (catalogName && m.name === catalogName) ||
          (name && m.name === name));
        if (match) {
          name = name || match.name;
          config = capabilities.resolveCatalogMcp(match.sourcePath, match.name)
            || { command: match.command, args: match.args || [], env: {} };
        }
      }
    }
    if (!config) return res.status(400).json({ error: 'MCP server config not found; provide sourcePath+name or an explicit config' });
    const result = await mcpTest.testServer(config);
    res.json(Object.assign({ name: name || null }, result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Probe a named MCP server attached to a specific agent (base/plugin or overlay).
// Resolves the RAW config (real env) server-side and runs the same start/handshake
// probe used by the marketplace Test, so failures (missing runtime, crash on
// launch, exit code + stderr) are surfaced for the exact server the agent uses.
app.post('/api/agents/:id/capabilities/mcp/:name/test', async (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  try {
    const config = capabilities.resolveAgentMcp(entry.config, req.params.name);
    if (!config) return res.status(404).json({ error: 'MCP server "' + req.params.name + '" not found for this agent' });
    const result = await mcpTest.testServer(config);
    res.json(Object.assign({ name: req.params.name }, result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detach an MCP server.
app.delete('/api/agents/:id/capabilities/mcp/:name', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  try {
    capabilities.detachMcp(req.params.id, req.params.name);
    broadcastSSE('agent-update', { agentId: req.params.id, capability: 'mcp', action: 'detach', name: req.params.name });
    res.json({ ok: true, effective: capabilities.getEffectiveCapabilities(entry.config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Attach a skill. Body: { name, description, body } to author inline, or
// { name, sourceDir } / { catalogName } to copy one out of the catalog.
app.post('/api/agents/:id/capabilities/skill', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  let { name, description, body, sourceDir, catalogName } = req.body || {};
  try {
    if (!body && (sourceDir || catalogName)) {
      const cat = capabilities.buildCatalog();
      const match = cat.skills.find(s =>
        (sourceDir && s.sourceDir === sourceDir && (!name || s.name === name)) ||
        (catalogName && s.name === catalogName) ||
        (name && s.name === name));
      if (!match) return res.status(400).json({ error: 'Skill not found in catalog' });
      name = name || match.name;
      capabilities.attachSkill(req.params.id, { name, sourceDir: match.sourceDir });
    } else {
      if (!name) return res.status(400).json({ error: 'name required' });
      capabilities.attachSkill(req.params.id, { name, description, body });
    }
    broadcastSSE('agent-update', { agentId: req.params.id, capability: 'skill', action: 'attach', name });
    res.json({ ok: true, effective: capabilities.getEffectiveCapabilities(entry.config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detach a skill.
app.delete('/api/agents/:id/capabilities/skill/:name', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  try {
    capabilities.detachSkill(req.params.id, req.params.name);
    broadcastSSE('agent-update', { agentId: req.params.id, capability: 'skill', action: 'detach', name: req.params.name });
    res.json({ ok: true, effective: capabilities.getEffectiveCapabilities(entry.config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Structural dry-run: build the generated package for this agent and report the
// MCP servers + skills that actually resolve into it. Lets the UI confirm an
// attach "took" before the user relies on it. Best-effort, never mutates state.
app.post('/api/agents/:id/capabilities/validate', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  const cfg = entry.config;
  try {
    // Plugin agents resolve overlay caps directly (no generated package); report
    // the effective overlay merged onto the plugin's own wiring.
    const eff = capabilities.getEffectiveCapabilities(cfg);
    let pkg = null, pkgErr = null;
    if (!cfg.pluginDir) {
      try {
        const built = agentPackage.buildAgentPackage(cfg);
        if (built) {
          const mcpPath = path.join(built.pluginDir, '.mcp.json');
          let servers = [];
          if (fs.existsSync(mcpPath)) {
            servers = Object.keys((JSON.parse(fs.readFileSync(mcpPath, 'utf8')) || {}).mcpServers || {});
          }
          const skillsRoot = path.join(built.pluginDir, 'skills');
          let skills = [];
          try {
            skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
              .filter(e => e.isDirectory()).map(e => e.name);
          } catch (_) {}
          pkg = { agentId: built.agentId, mcpServers: servers, skills, mcpCount: built.mcpCount, skillCount: built.skillCount };
        } else {
          pkgErr = 'could not resolve an agent file to package';
        }
      } catch (e) {
        pkgErr = e.message;
      }
    }
    res.json({
      ok: !pkgErr,
      kind: cfg.pluginDir ? 'plugin' : 'project',
      effective: eff,
      package: pkg,
      error: pkgErr,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export an agent (+ its capability overlay) to an Azure DevOps repo.
// Body: { org, project, repo, baseBranch?, newBranch?, layout?, basePath?,
//         pluginName?, createPr?, prTitle?, prDescription?, dryRun? }
// dryRun (default true) returns the file plan + redactions + secret findings
// without touching the repo. A non-dry run blocks if the secret scan trips.
app.post('/api/agents/:id/export-azdo', async (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  const b = req.body || {};
  const dryRun = b.dryRun !== false;
  try {
    const plan = agentExport.buildExport(entry.config, {
      layout: b.layout, basePath: b.basePath, pluginName: b.pluginName
    });
    if (!plan) return res.status(400).json({ error: 'This agent could not be serialized (no agent definition found).' });

    const fileSummary = plan.files.map(f => ({ path: f.path, bytes: f.content.length }));
    const preview = {
      slug: plan.slug, pluginName: plan.pluginName, kind: plan.kind, layout: plan.layout,
      branchSuggestion: plan.branchSuggestion, files: fileSummary,
      redactions: plan.redactions, secrets: plan.secrets, warnings: plan.warnings
    };

    if (dryRun) return res.json({ ok: true, dryRun: true, preview });

    if (!b.org || !b.project || !b.repo) {
      return res.status(400).json({ error: 'org, project and repo are required to push.' });
    }
    if (plan.secrets.length) {
      return res.status(400).json({ error: 'Secret-like content found; push blocked.', preview });
    }

    // Preflight: resolve repo + base branch.
    const repoInfo = await azdo.getRepo(b.org, b.project, b.repo);
    const baseBranch = (b.baseBranch || repoInfo.defaultBranch || 'main').replace(/^refs\/heads\//, '');
    const baseSha = await azdo.getRefObjectId(b.org, b.project, b.repo, baseBranch);
    if (!baseSha) return res.status(400).json({ error: `Base branch "${baseBranch}" not found in ${b.repo}.` });

    const newBranch = (b.newBranch || plan.branchSuggestion).replace(/^refs\/heads\//, '');
    if (await azdo.getRefObjectId(b.org, b.project, b.repo, newBranch)) {
      return res.status(409).json({ error: `Branch "${newBranch}" already exists. Choose a different name.` });
    }

    // Decide add vs edit per file against the base branch.
    const changes = [];
    for (const f of plan.files) {
      const exists = await azdo.getObjectId(b.org, b.project, b.repo, baseBranch, f.path);
      changes.push({ path: f.path, content: f.content, changeType: exists ? 'edit' : 'add' });
    }

    const commitMessage = b.commitMessage || `Export agent: ${entry.config.name || plan.slug}`;
    await azdo.pushFiles(b.org, b.project, b.repo, { baseBranch, newBranch, changes, commitMessage });

    let pr = null;
    if (b.createPr) {
      pr = await azdo.createPullRequest(b.org, b.project, b.repo, {
        sourceBranch: newBranch, targetBranch: baseBranch,
        title: b.prTitle || `Add ${entry.config.name || plan.slug}`,
        description: b.prDescription || `Exported from TheOffice.AI (${plan.layout} layout).`
      });
    }

    const branchUrl = `https://dev.azure.com/${encodeURIComponent(b.org)}/${encodeURIComponent(b.project)}/_git/${encodeURIComponent(b.repo)}?version=GB${encodeURIComponent(newBranch)}`;
    res.json({ ok: true, dryRun: false, branch: newBranch, baseBranch, branchUrl, pr, filesPushed: changes.length, preview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update agent display name
app.put('/api/agents/:id/name', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  entry.config.name = name;
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === req.params.id);
  if (agent) {
    agent.name = name;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  }
  res.json({ ok: true });
});

// Enable or disable an agent (persists to DB)
app.put('/api/agents/:id/enabled', (req, res) => {
  const { enabled } = req.body;
  const id = req.params.id;
  try {
    if (enabled) {
      supervisor.start(id, { runImmediately: false });
    } else {
      supervisor.stop(id, { persist: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Toggle autoStart (persists to agents.json)
app.put('/api/agents/:id/autostart', (req, res) => {
  const { autoStart } = req.body;
  const id = req.params.id;
  try {
    const entry = supervisor.agents.get(id);
    if (!entry) return res.status(404).json({ error: 'Agent not found' });
    entry.config.autoStart = autoStart;

    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const agent = agents.find(a => a.id === id);
    if (agent) {
      if (autoStart === false) { agent.autoStart = false; } else { delete agent.autoStart; }
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/agents', (req, res) => {
  const config = req.body;
  if (!config.id || !config.name || !config.cwd || !config.agent || !config.schedule) {
    return res.status(400).json({ error: 'Missing required fields: id, name, cwd, agent, schedule' });
  }
  // Agents no longer carry a definition prompt — prompts come from tasks,
  // assignments, and chains/flows. Strip any legacy prompt before persisting.
  delete config.prompt;
  // Save to agents.json
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const existing = agents.findIndex(a => a.id === config.id);
  if (existing >= 0) {
    agents[existing] = config;
  } else {
    agents.push(config);
  }
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  supervisor.register(config);
  res.json({ ok: true });
});

// Compute everything that references an agent so we can warn before deletion
// and cascade-clean afterwards. Managers keep the agent id in their `team`
// array; tasks reference it via `agentId`; flows reference it indirectly via a
// step's task, or directly via an AI edge condition's `agentId`.
function computeAgentDependents(agentId) {
  const managers = [];
  try {
    if (fs.existsSync(MANAGERS_PATH)) {
      for (const m of JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'))) {
        const roster = Array.isArray(m.team) ? m.team : (Array.isArray(m.org) ? m.org : []);
        if (roster.includes(agentId)) managers.push({ id: m.id, name: m.name || m.id });
      }
    }
  } catch {}
  const allTasks = loadTasks();
  const tasks = allTasks.filter(t => t.agentId === agentId).map(t => ({ id: t.id, name: t.name || t.id }));
  const taskIds = new Set(tasks.map(t => t.id));
  const flows = [];
  try {
    for (const c of chainEngine.list()) {
      const viaStep = (c.steps || []).some(s => taskIds.has(s.taskId));
      const viaCond = (c.edges || []).some(e => e.condition && e.condition.type === 'ai' && e.condition.agentId === agentId);
      if (viaStep || viaCond) flows.push({ id: c.id, name: c.name || c.id });
    }
  } catch {}
  return { managers, tasks, flows };
}

// What references this agent? Powers the pre-delete confirmation in the SPA.
app.get('/api/agents/:id/dependents', (req, res) => {
  res.json(computeAgentDependents(req.params.id));
});

app.delete('/api/agents/:id', (req, res) => {
  const agentId = req.params.id;
  const deps = computeAgentDependents(agentId);

  // Cascade 1: strip the agent from every manager's team (runtime + managers.json)
  // so managers stop advertising a tool they can no longer invoke.
  const managersUpdated = [];
  if (deps.managers.length) {
    let managers = [];
    try { managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8')); } catch {}
    for (const m of deps.managers) {
      try { managerAgent.removeFromOrg(m.id, agentId); } catch {}
      const mi = managers.findIndex(x => x.id === m.id);
      if (mi >= 0) {
        const runtime = managerAgent.managers.get(m.id);
        managers[mi].team = runtime ? (runtime.config.team || []) : ((managers[mi].team || managers[mi].org || []).filter(x => x !== agentId));
        delete managers[mi].org;
      }
      managersUpdated.push(m);
    }
    try { fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2)); } catch {}
  }

  // Cascade 2: disable tasks that target the agent (they would silently no-op
  // on every fire) and stop their schedules.
  const tasksDisabled = [];
  if (deps.tasks.length) {
    const tasks = loadTasks();
    for (const dt of deps.tasks) {
      const t = tasks.find(x => x.id === dt.id);
      if (t) { t.enabled = false; t.updatedAt = new Date().toISOString(); }
      try { unscheduleTask(dt.id); } catch {}
      tasksDisabled.push(dt);
    }
    saveTasks(tasks);
    for (const dt of tasksDisabled) {
      const t = tasks.find(x => x.id === dt.id);
      if (t) broadcastSSE('task-updated', t);
    }
  }

  // Cascade 3: disable flows that depend on the agent (a step or AI condition
  // would error every run). chainEngine.update re-normalizes and reschedules.
  const flowsDisabled = [];
  for (const f of deps.flows) {
    try { chainEngine.update(f.id, { enabled: false }); flowsDisabled.push(f); } catch {}
  }

  // Finally remove the agent itself.
  supervisor.unregister(agentId);
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const filtered = agents.filter(a => a.id !== agentId);
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(filtered, null, 2));
  res.json({ ok: true, cascade: { managersUpdated, tasksDisabled, flowsDisabled } });
});

// Reinstall an agent (re-read source definition and re-register)
app.post('/api/agents/:id/reinstall', async (req, res) => {
  const agentId = req.params.id;
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    // Azure DevOps source: re-fetch the latest files from the same org/project/repo/branch.
    if (agent.source && agent.source.type === 'azdo') {
      const s = agent.source;
      if (s.kind === 'plugin') {
        let fresh = null;
        try {
          const items = await azdo.discover(s.org, s.project, s.repo, s.branch);
          fresh = items.find(it => it.kind === 'plugin' && it.path === s.path);
        } catch { /* fall back to stored file list below */ }
        const target = fresh || { kind: 'plugin', id: agentId, path: s.path, files: null };
        const { pluginDir, mcpConfig } = await azdo.materializePlugin(s.org, s.project, s.repo, s.branch, target);
        registerLocalPluginInCopilot(pluginDir);
        agent.pluginDir = pluginDir;
        agent.sourceDir = pluginDir;
        if (mcpConfig) agent.mcpConfig = mcpConfig;
        // Keep the agent ref correct across versions: bind to a newly-published
        // real agent, or (re)generate our stand-in if still agent-less.
        agent.agent = reconcilePluginAgent(pluginDir);
        agent.source = { ...s, objectId: (fresh && fresh.objectId) || s.objectId, installedAt: new Date().toISOString() };
      } else {
        const { cwd } = await azdo.materializeAgent(s.org, s.project, s.repo, s.branch, s.path);
        agent.cwd = cwd;
        const newOid = await azdo.getObjectId(s.org, s.project, s.repo, s.branch, s.path);
        agent.source = { ...s, objectId: newOid || s.objectId, installedAt: new Date().toISOString() };
      }
      const azIdx = agents.findIndex(a => a.id === agentId);
      agents[azIdx] = agent;
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
      supervisor.register(agent);
      broadcastSSE('agent-update', { agentId });
      return res.json({ ok: true, agent });
    }

    // For plugins with a pluginDir, re-read the plugin.json and agent.md
    if (agent.pluginDir && fs.existsSync(agent.pluginDir)) {
      const pluginJsonPath = path.join(agent.pluginDir, 'plugin.json');
      if (fs.existsSync(pluginJsonPath)) {
        const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
        if (pj.name) agent.name = pj.name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      }
      // Reconcile the agent ref: adopt a newly-published real agent (removing any
      // stand-in we generated) or regenerate the stand-in if still agent-less.
      agent.agent = reconcilePluginAgent(agent.pluginDir);
      // Re-read agent.md name (skip our generated stand-in so the display name
      // reflects a real agent when one is present).
      const agentsDir = path.join(agent.pluginDir, 'agents');
      if (fs.existsSync(agentsDir)) {
        const mdFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
        const realMd = mdFiles.find(f => {
          try { return !isGeneratedAgentFile(fs.readFileSync(path.join(agentsDir, f), 'utf-8')); } catch { return false; }
        });
        if (realMd) {
          const content = fs.readFileSync(path.join(agentsDir, realMd), 'utf-8');
          const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fm) {
            const nameMatch = fm[1].match(/name:\s*['"]?([^'"\n]+)/);
            if (nameMatch) agent.name = nameMatch[1].trim();
          }
        }
      }
    }
    // For agents with a cwd, re-read the .github/agents/<id>.agent.md
    else if (agent.cwd && fs.existsSync(agent.cwd)) {
      const agentMdPath = path.join(agent.cwd, '.github', 'agents', `${agentId}.agent.md`);
      if (fs.existsSync(agentMdPath)) {
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fm) {
          const nameMatch = fm[1].match(/name:\s*['"]?([^'"\n]+)/);
          if (nameMatch) { agent.agent = nameMatch[1].trim(); agent.name = nameMatch[1].trim(); }
        }
      }
    }

    // Save updated config
    const idx = agents.findIndex(a => a.id === agentId);
    agents[idx] = agent;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));

    // Re-register in supervisor
    supervisor.register(agent);
    broadcastSSE('agent-update', { agentId });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(500).json({ error: `Reinstall failed: ${e.message}` });
  }
});

// List the files bundled in a plugin agent's source, for the identity card.
// Walks the plugin/source dir (skipping VCS + dependency noise), flags the
// agent stand-in we auto-generated, and caps the result so huge repos stay fast.
app.get('/api/agents/:id/files', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  const c = entry.config || {};
  const root = c.pluginDir || c.sourceDir || '';
  if (!root) return res.json({ root: null, files: [], reason: 'no-plugin-dir' });
  if (!fs.existsSync(root)) return res.json({ root, files: [], missing: true });
  const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.parcel-cache', '.copilot']);
  const MAX = 1000;
  const files = [];
  let truncated = false;
  (function walk(dir, prefix) {
    if (files.length >= MAX) { truncated = true; return; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (files.length >= MAX) { truncated = true; break; }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), rel);
      } else {
        let size = 0;
        try { size = fs.statSync(path.join(dir, e.name)).size; } catch (_) {}
        let generated = false;
        if (/\.agent\.md$/i.test(e.name)) {
          try { generated = isGeneratedAgentFile(fs.readFileSync(path.join(dir, e.name), 'utf-8')); } catch (_) {}
        }
        files.push({ path: rel, size, generated });
      }
    }
  })(root, '');
  res.json({ root, files, truncated, count: files.length });
});

// Update agent group
app.put('/api/agents/:id/group', (req, res) => {
  const { group } = req.body;
  try {
    const entry = supervisor.agents.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Agent not found' });
    entry.config.group = group || undefined;

    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const agent = agents.find(a => a.id === req.params.id);
    if (agent) {
      if (group) { agent.group = group; } else { delete agent.group; }
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rename a group
app.put('/api/groups/rename', (req, res) => {
  const { oldName, newName, agentIds } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  // Optional org-scoping: when agentIds is provided, only rename the group for
  // those agents so a group shared across organizations isn't renamed globally.
  const scope = Array.isArray(agentIds) ? new Set(agentIds) : null;
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    let changed = 0;
    agents.forEach(a => {
      if (a.group === oldName && (!scope || scope.has(a.id))) { a.group = newName; changed++; }
    });
    if (changed === 0) return res.status(404).json({ error: 'No agents in that group' });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    // Update in-memory configs
    for (const [id, entry] of supervisor.agents) {
      if (entry.config.group === oldName && (!scope || scope.has(id))) entry.config.group = newName;
    }
    res.json({ ok: true, changed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a group (move agents to Ungrouped)
app.delete('/api/groups/:name', (req, res) => {
  const groupName = decodeURIComponent(req.params.name);
  // Optional org-scoping via ?agentIds=a,b,c — only ungroup those agents so a
  // group shared across organizations isn't deleted everywhere.
  const scope = (typeof req.query.agentIds === 'string' && req.query.agentIds.length)
    ? new Set(req.query.agentIds.split(',').filter(Boolean))
    : null;
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    let changed = 0;
    agents.forEach(a => {
      if (a.group === groupName && (!scope || scope.has(a.id))) { delete a.group; changed++; }
    });
    if (changed === 0) return res.status(404).json({ error: 'No agents in that group' });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    for (const [id, entry] of supervisor.agents) {
      if (entry.config.group === groupName && (!scope || scope.has(id))) delete entry.config.group;
    }
    res.json({ ok: true, changed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reload agents.json
app.post('/api/reload', (req, res) => {
  loadAgents();
  res.json({ ok: true });
});

// ============ Tasks API ============
// Tasks are separate from agents — an agent can have multiple tasks
function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8')); }
  catch { return []; }
}
function saveTasks(tasks) {
  fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
  // tasks.json is part of this machine's synced namespace — mirror to cloud.
  if (configSync.enabled) configSync.pushConfig().catch(e => console.warn('[sync] auto-push (tasks) failed:', e.message));
}

// ---- Task scheduler ----
// Tasks are the unit of scheduled work for an agent (agents themselves are chatted
// with, not self-scheduled). A scheduled task fires its agent with the task's prompt,
// mirroring how the supervisor schedules agents and the manager schedules assignments.
// Manual runs still work via POST /api/tasks/:id/run.
const { Cron: TaskCron } = require('croner');
const { parseSchedule: parseTaskSchedule } = require('./scheduler');
const taskJobs = new Map(); // taskId -> { stop() }

// Central task runner. Runs a task's agent standalone. Conditional follow-on
// work is now expressed via Task Chains (see chains.js), not inline triggers.
// `triggerContext` carries upstream output for {{ task.* }} interpolation;
// `promptOverride` lets a caller supply its own prompt instead of the default.
function executeTask(task, triggerContext = null, { scheduled = false, promptOverride = null } = {}) {
  const entry = supervisor.agents.get(task.agentId);
  if (!entry) {
    console.warn(`[task-scheduler] Agent "${task.agentId}" not found for task "${task.name}"`);
    return false;
  }
  if (entry.running) {
    console.warn(`[task-scheduler] Agent "${task.agentId}" is already running; skipping task "${task.name}"`);
    return false;
  }
  const originalPrompt = entry.config.prompt;
  entry.config.prompt = promptOverride || task.prompt;
  entry._taskId = task.id;
  entry._trigger = { kind: 'task', label: task.name, route: '#/tasks' };
  try { supervisor._executeAgent(task.agentId, triggerContext); }
  finally { entry.config.prompt = originalPrompt; }
  broadcastSSE('task-running', { taskId: task.id, agentId: task.agentId, scheduled });
  return true;
}

function runScheduledTask(task) {
  if (!leaderCheck()) return;
  if (executeTask(task, null, { scheduled: true })) {
    console.log(`[task-scheduler] Ran scheduled task "${task.name}" → ${task.agentId}`);
  }
}

function unscheduleTask(taskId) {
  const job = taskJobs.get(taskId);
  if (job) { try { job.stop(); } catch {} taskJobs.delete(taskId); }
}

function scheduleTask(task) {
  unscheduleTask(task.id);
  if (!task || task.enabled === false) return;
  if (!task.schedule || String(task.schedule).toLowerCase() === 'never') return;
  let parsed;
  try { parsed = parseTaskSchedule(task.schedule); }
  catch (e) { console.warn(`[task-scheduler] Bad schedule for "${task.name}": ${e.message}`); return; }
  if (parsed.type === 'cron') {
    taskJobs.set(task.id, new TaskCron(parsed.cron, () => runScheduledTask(task)));
  } else if (parsed.type === 'interval') {
    const timer = setInterval(() => runScheduledTask(task), parsed.ms);
    taskJobs.set(task.id, { stop: () => clearInterval(timer) });
  } else {
    return;
  }
  console.log(`[task-scheduler] Scheduled task "${task.name}": ${parsed.description}`);
}

function rescheduleAllTasks() {
  for (const id of [...taskJobs.keys()]) unscheduleTask(id);
  for (const task of loadTasks()) scheduleTask(task);
}
// Activate schedules for any already-saved tasks at startup.
rescheduleAllTasks();

// Backfill task attribution on historical agent runs. The task_id column was
// added later, so runs that predate it have task_id = NULL. When an agent is
// driven by exactly one task and has no schedule of its own, every run of that
// agent is unambiguously that task's run, so we can safely attribute them.
// Idempotent: only touches rows where task_id IS NULL.
function backfillTaskRunAttribution() {
  try {
    const tasksByAgent = new Map();
    for (const t of loadTasks()) {
      if (!t.agentId) continue;
      if (!tasksByAgent.has(t.agentId)) tasksByAgent.set(t.agentId, []);
      tasksByAgent.get(t.agentId).push(t);
    }
    for (const [agentId, list] of tasksByAgent) {
      if (list.length !== 1) continue; // multiple tasks → ambiguous
      const entry = supervisor.agents.get(agentId);
      const agentSchedule = entry && entry.config && entry.config.schedule;
      if (agentSchedule && String(agentSchedule).toLowerCase() !== 'never') continue; // self-scheduling → ambiguous
      const result = db.prepare('UPDATE agent_runs SET task_id = ? WHERE agent_id = ? AND task_id IS NULL').run(list[0].id, agentId);
      if (result.changes) console.log(`[backfill] Attributed ${result.changes} historical run(s) of "${agentId}" to task "${list[0].id}"`);
    }
  } catch (e) {
    console.warn('[backfill] Task run attribution failed:', e.message);
  }
}
backfillTaskRunAttribution();

// ---- Task Chains ----
// A chain is a first-class, schedulable DAG of tasks connected by conditional
// edges (status / expression / AI). It replaces the old inline per-task triggers.
const { ChainEngine } = require('./chains');
const chainEngine = new ChainEngine({
  db,
  supervisor,
  loadTasks,
  broadcast: broadcastSSE,
  onPersist: () => { if (configSync.enabled) configSync.pushConfig().catch(e => console.warn('[sync] auto-push (chains) failed:', e.message)); }
});

mobileHandler.chainEngine = chainEngine;

app.get('/api/chains', (req, res) => res.json(chainEngine.list()));

app.get('/api/chains/:id', (req, res) => {
  const chain = chainEngine.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  res.json(chain);
});

app.post('/api/chains', (req, res) => {
  try { res.status(201).json(chainEngine.create(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/chains/:id', (req, res) => {
  try { res.json(chainEngine.update(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/chains/:id', (req, res) => {
  if (!chainEngine.remove(req.params.id)) return res.status(404).json({ error: 'Chain not found' });
  res.json({ ok: true });
});

// Manually start a chain run
app.post('/api/chains/:id/run', (req, res) => {
  try {
    const runId = chainEngine.runChain(req.params.id, { manual: true });
    res.json({ ok: true, runId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Live + historical run state for visualization
app.get('/api/chains/:id/runs', (req, res) => {
  res.json(chainEngine.recentRuns(req.params.id, Number(req.query.limit) || 10));
});
app.get('/api/chain-runs/:runId', (req, res) => {
  const run = chainEngine.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});


app.get('/api/tasks', (req, res) => {
  res.json(loadTasks());
});

app.get('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const { id, name, agentId, prompt, schedule, enabled, teamId, orgId } = req.body;
  if (!name || !agentId) return res.status(400).json({ error: 'name and agentId are required' });
  const tasks = loadTasks();
  const taskId = id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // Check for name collision
  const existing = tasks.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'duplicate_name', existingId: existing.id, message: `A task named "${name}" already exists.` });
  }
  const team = teamId !== undefined ? teamId : orgId;
  const task = { id: taskId, name, agentId, prompt: prompt || '', schedule: schedule || 'never', enabled: enabled !== false, teamId: team || null, createdAt: new Date().toISOString() };
  tasks.push(task);
  saveTasks(tasks);
  scheduleTask(task);
  broadcastSSE('task-created', task);
  res.status(201).json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  const { name, prompt, schedule, enabled, teamId, orgId } = req.body;
  const team = teamId !== undefined ? teamId : orgId;
  // Check for name collision (excluding self)
  if (name) {
    const dup = tasks.find(t => t.id !== req.params.id && t.name.toLowerCase() === name.toLowerCase());
    if (dup) {
      return res.status(409).json({ error: 'duplicate_name', existingId: dup.id, message: `A task named "${name}" already exists.` });
    }
    tasks[idx].name = name;
  }
  if (prompt !== undefined) tasks[idx].prompt = prompt;
  if (schedule !== undefined) tasks[idx].schedule = schedule;
  if (enabled !== undefined) tasks[idx].enabled = enabled;
  if (team !== undefined) tasks[idx].teamId = team || null;
  tasks[idx].updatedAt = new Date().toISOString();
  saveTasks(tasks);
  scheduleTask(tasks[idx]);
  broadcastSSE('task-updated', tasks[idx]);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const filtered = tasks.filter(t => t.id !== req.params.id);
  if (filtered.length === tasks.length) return res.status(404).json({ error: 'Task not found' });
  saveTasks(filtered);
  unscheduleTask(req.params.id);
  broadcastSSE('task-deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Run a task by ID (triggers the associated agent with the task's prompt)
app.post('/api/tasks/:id/run', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!supervisor.agents.get(task.agentId)) return res.status(404).json({ error: `Agent "${task.agentId}" not found` });
  const started = executeTask(task, null);
  if (!started) return res.status(409).json({ error: `Agent "${task.agentId}" is busy or unavailable` });
  res.json({ ok: true, message: `Task "${task.name}" started on agent "${task.agentId}"` });
});

// Run history for a single task (task-triggered agent runs, tracked via task_id)
app.get('/api/tasks/:id/runs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const rows = db.prepare(
      'SELECT id, agent_id, started_at, finished_at, exit_code, session_id FROM agent_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?'
    ).all(req.params.id, limit);
    res.json(rows.map(r => ({
      id: r.id, agentId: r.agent_id, startedAt: r.started_at, finishedAt: r.finished_at,
      exitCode: r.exit_code, sessionId: r.session_id,
      status: r.finished_at == null && r.exit_code == null ? 'running' : (r.exit_code === 0 ? 'success' : 'failed')
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Describe a schedule string
app.post('/api/schedule/describe', (req, res) => {
  const { parseSchedule } = require('./scheduler');
  try {
    const result = parseSchedule(req.body.schedule || '');
    res.json({ ok: true, description: result.description, type: result.type });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Open project in VS Code Insiders
app.post('/api/open-editor', (req, res) => {
  const { spawn } = require('child_process');
  spawn('code-insiders', [__dirname], { shell: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});

// Open agent source in VS Code
app.post('/api/agents/:id/edit-source', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  const { spawnSync, spawn } = require('child_process');
  const config = entry.config;
  // Prefer sourceDir (original source), then infer from cwd, then pluginDir, then cwd
  let targetDir = config.sourceDir;
  if (!targetDir && config.pluginDir && config.pluginDir.includes(PLUGINS_DIR)) {
    const pluginName = path.basename(config.pluginDir);
    const candidate = path.join(config.cwd || '', '.github', 'plugin', pluginName);
    if (fs.existsSync(candidate)) targetDir = candidate;
  }
  if (!targetDir) targetDir = config.pluginDir || config.cwd;
  // Try VS Code Insiders first, fall back to VS Code
  const insiders = spawnSync('where', ['code-insiders'], { shell: true, encoding: 'utf-8' });
  const editor = insiders.status === 0 ? 'code-insiders' : 'code';
  spawn(editor, [targetDir], { shell: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true, editor, path: targetDir });
});

// Check if agent's installed plugin is out of date compared to source
// Compute update status for a single agent/plugin entry. Returns { upToDate, ... }.
// Shared by the per-item check-update route and the aggregate available-count route.
async function computeUpdateStatus(entry) {
  const config = entry.config;

  // Azure DevOps source: compare the stored objectId against the current one on the branch.
  if (config.source && config.source.type === 'azdo') {
    const s = config.source;
    try {
      let current = null;
      if (s.kind === 'plugin') {
        try {
          const items = await azdo.discover(s.org, s.project, s.repo, s.branch);
          const fresh = items.find(it => it.kind === 'plugin' && it.path === s.path);
          current = (fresh && fresh.objectId) || null;
        } catch {}
        if (!current) current = await azdo.getObjectId(s.org, s.project, s.repo, s.branch, s.path + '/plugin.json');
      } else {
        current = await azdo.getObjectId(s.org, s.project, s.repo, s.branch, s.path);
      }
      return {
        upToDate: !current || !s.objectId || current === s.objectId,
        reason: 'azdo',
        source: s,
        currentObjectId: current
      };
    } catch (e) {
      return { upToDate: true, reason: 'azdo-error', error: e.message };
    }
  }

  let sourceDir = config.sourceDir;
  const pluginDir = config.pluginDir;

  // If no explicit sourceDir, try to infer: if pluginDir is under our plugins/ folder,
  // check if there's a matching .github/plugin/<name> in the agent's cwd
  if (!sourceDir && pluginDir && pluginDir.includes(PLUGINS_DIR)) {
    const pluginName = path.basename(pluginDir);
    const candidate = path.join(config.cwd || '', '.github', 'plugin', pluginName);
    if (fs.existsSync(candidate)) sourceDir = candidate;
  }

  // No sourceDir means either the pluginDir IS the source or there's no plugin
  if (!sourceDir || !pluginDir) return { upToDate: true, reason: 'no-overlay' };
  // If sourceDir === pluginDir, no comparison needed
  if (path.resolve(sourceDir) === path.resolve(pluginDir)) return { upToDate: true, reason: 'same-dir' };
  // Both must exist
  if (!fs.existsSync(sourceDir)) return { upToDate: true, reason: 'source-missing' };
  if (!fs.existsSync(pluginDir)) return { upToDate: false, reason: 'installed-missing' };

  // Compare key files recursively (shallow: plugin.json mtime, agents/*.md sizes)
  function getFingerprint(dir) {
    const files = {};
    function walk(d, prefix) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(d, entry.name), rel);
          } else {
            const stat = fs.statSync(path.join(d, entry.name));
            files[rel] = { size: stat.size, mtime: stat.mtimeMs };
          }
        }
      } catch {}
    }
    walk(dir, '');
    return files;
  }

  const srcFiles = getFingerprint(sourceDir);
  const instFiles = getFingerprint(pluginDir);
  const diffs = [];
  for (const [file, info] of Object.entries(srcFiles)) {
    if (!instFiles[file]) {
      diffs.push({ file, reason: 'new-in-source' });
    } else if (instFiles[file].size !== info.size) {
      diffs.push({ file, reason: 'size-changed' });
    } else if (info.mtime > instFiles[file].mtime) {
      diffs.push({ file, reason: 'source-newer' });
    }
  }

  return { upToDate: diffs.length === 0, diffs: diffs.slice(0, 10), sourceDir, pluginDir };
}

app.get('/api/agents/:id/check-update', async (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json(await computeUpdateStatus(entry));
  } catch (e) {
    res.json({ upToDate: true, reason: 'error', error: e.message });
  }
});
app.post('/api/agents/:id/reinstall', async (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  if (!entry.config.pluginDir) return res.status(400).json({ error: 'Not a plugin agent' });
  
  const { execSync } = require('child_process');
  const copilotCmd = process.env.COPILOT_PATH || 'copilot';
  let pluginDir = entry.config.pluginDir;
  
  // If configured pluginDir doesn't exist, try resolving relative to server's plugins/ directory
  if (!fs.existsSync(pluginDir)) {
    const localDir = path.join(PLUGINS_DIR, path.basename(pluginDir));
    if (fs.existsSync(localDir)) {
      pluginDir = localDir;
    }
  }
  
  try {
    // Get plugin name from plugin.json
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    const pluginName = pluginJson.name || path.basename(pluginDir);
    
    // Uninstall existing
    try {
      execSync(`"${copilotCmd}" plugin uninstall "${pluginName}"`, { encoding: 'utf-8', shell: true, timeout: 30000 });
    } catch (e) {
      // Uninstall may fail if not installed — that's ok
    }
    
    // Install directly from source (no --plugin-dir needed at runtime, so no patching required)
    const output = execSync(`"${copilotCmd}" plugin install "${pluginDir}"`, { encoding: 'utf-8', shell: true, timeout: 30000 });

    res.json({ ok: true, output: output.trim() });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// Browse for folder using Windows folder picker
app.post('/api/browse-folder', (req, res) => {
  const { exec } = require('child_process');
  const tmpFile = path.join(__dirname, '.browse-result.txt');
  try { fs.unlinkSync(tmpFile); } catch {}
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Select agent directory'
$f.RootFolder = 'MyComputer'
$f.SelectedPath = 'C:\\repos'
$topForm = New-Object System.Windows.Forms.Form
$topForm.TopMost = $true
$result = $f.ShowDialog($topForm)
$topForm.Dispose()
if ($result -eq 'OK') { Set-Content -Path '${tmpFile.replace(/\\/g, '\\\\')}' -Value $f.SelectedPath }
`;
  const psFile = path.join(__dirname, '.browse-folder.ps1');
  fs.writeFileSync(psFile, psScript);
  // Use 'start /wait' to run powershell in a visible (but minimized) process
  exec(`start /wait powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { cwd: __dirname }, () => {
    let folder = null;
    try { folder = fs.readFileSync(tmpFile, 'utf-8').trim(); fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(psFile); } catch {}
    res.json({ folder: folder || null });
  });
});

// Get recent directories from existing agents
app.get('/api/recent-dirs', (req, res) => {
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const seen = new Set();
  const dirs = agents.map(a => a.cwd).filter(Boolean).filter(d => {
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json(dirs);
});

// Email agent output via default mail client
app.post('/api/agents/:id/email', (req, res) => {
  const status = supervisor.getStatus(req.params.id);
  if (!status || !status.lastRun?.output) return res.status(404).json({ error: 'No output to email' });
  const agentName = status.config?.name || req.params.id;
  const subject = `Agent Report: ${agentName} — ${new Date(status.lastRun.started_at).toLocaleDateString()}`;
  const markdown = status.lastRun.output;
  
  // Convert markdown to HTML and create a .eml file for rich formatting
  const { marked } = require('marked');
  const htmlBody = marked.parse(markdown);
  const htmlEmail = `<html><head><style>
body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #222; padding: 16px; }
h1, h2, h3 { color: #333; }
a { color: #0078d4; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
ul, ol { padding-left: 24px; }
li { margin-bottom: 4px; }
code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
</style></head><body>${htmlBody}</body></html>`;

  // Build .eml (RFC 2822) with HTML content
  const boundary = `----=_Part_${Date.now()}`;
  const eml = [
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Unsent: 1`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    markdown,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    htmlEmail,
    ``,
    `--${boundary}--`
  ].join('\r\n');

  const os = require('os');
  const emlPath = path.join(os.tmpdir(), `agent-email-${req.params.id}-${Date.now()}.eml`);
  fs.writeFileSync(emlPath, eml, 'utf8');
  const { exec } = require('child_process');
  exec(`start "" "${emlPath}"`);
  res.json({ ok: true });
});

// Email a session's content (full conversation or last response only)
app.post('/api/sessions/:id/email', (req, res) => {
  const { mode } = req.body; // 'full' or 'last'
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const conversation = readSessionConversation(sessionDir);
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  let agentName = 'Agent';
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'subagent.selected' && ev.data?.agentDisplayName) { agentName = ev.data.agentDisplayName; break; }
      } catch {}
    }
  }

  let markdown = '';
  const subject = `Session: ${agentName} — ${new Date().toLocaleDateString()}`;
  if (mode === 'last') {
    // Last agent response only
    const lastTurn = [...conversation.turns].reverse().find(t => t.assistant);
    markdown = lastTurn?.assistant || 'No agent response found.';
  } else {
    // Full conversation
    for (const turn of conversation.turns) {
      markdown += `**You:** ${turn.content}\n\n`;
      if (turn.assistant) markdown += `**Agent:** ${turn.assistant}\n\n---\n\n`;
    }
  }

  const { marked } = require('marked');
  const htmlBody = marked.parse(markdown);
  const htmlEmail = `<html><head><style>
body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #222; padding: 16px; }
h1, h2, h3 { color: #333; }
a { color: #0078d4; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
ul, ol { padding-left: 24px; }
li { margin-bottom: 4px; }
code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
</style></head><body>${htmlBody}</body></html>`;

  const boundary = `----=_Part_${Date.now()}`;
  const eml = [
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Unsent: 1`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    markdown,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    htmlEmail,
    ``,
    `--${boundary}--`
  ].join('\r\n');

  const os = require('os');
  const emlPath = path.join(os.tmpdir(), `session-email-${req.params.id.substring(0,8)}-${Date.now()}.eml`);
  fs.writeFileSync(emlPath, eml, 'utf8');
  const { exec } = require('child_process');
  exec(`start "" "${emlPath}"`);
  res.json({ ok: true });
});

// Share content via email (.eml file)
app.post('/api/share/email', (req, res) => {
  const { content, subject } = req.body;
  if (!content) return res.status(400).json({ error: 'No content to share' });

  const { marked } = require('marked');
  const htmlBody = marked.parse(content);
  const htmlEmail = `<html><head><style>
body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #222; padding: 16px; }
h1, h2, h3 { color: #333; }
a { color: #0078d4; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ddd; padding: 6px 10px; }
</style></head><body>${htmlBody}</body></html>`;

  const boundary = `----=_Part_${Date.now()}`;
  const eml = [
    `Subject: ${subject || 'Shared from TheOffice.AI'}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Unsent: 1`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    content,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    htmlEmail,
    ``,
    `--${boundary}--`
  ].join('\r\n');

  const draftDir = path.join(__dirname, '.share-drafts');
  fs.mkdirSync(draftDir, { recursive: true });
  const emlPath = path.join(draftDir, `share-${Date.now()}.eml`);
  fs.writeFileSync(emlPath, eml, 'utf8');
  const { exec } = require('child_process');
  exec(`start "" "${emlPath}"`);
  res.json({ ok: true });
});

// Share content to Teams channel
app.post('/api/share/teams', (req, res) => {
  const { content, subject } = req.body;
  if (!content) return res.status(400).json({ error: 'No content to share' });

  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({ error: 'Teams webhook not configured. Set TEAMS_WEBHOOK_URL environment variable.' });
  }

  const card = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: 'b11f4b',
    summary: subject || 'Shared from TheOffice.AI',
    sections: [{
      activityTitle: subject || 'Shared from TheOffice.AI',
      activitySubtitle: new Date().toLocaleString(),
      text: content.length > 5000 ? `${content.substring(0, 5000)}\n\n...(truncated)` : content,
      markdown: true
    }]
  };

  const https = require('https');
  const url = new URL(webhookUrl);
  const postData = JSON.stringify(card);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        res.json({ ok: true });
      } else {
        res.status(502).json({ error: `Teams returned ${response.statusCode}: ${data}` });
      }
    });
  });
  request.on('error', (e) => res.status(502).json({ error: e.message }));
  request.write(postData);
  request.end();
});

// ---- Session History & Chat ----
const SESSION_STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');

function parseYamlSimple(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
    if (m) obj[m[1]] = m[2].trim();
  }
  return obj;
}

function readSessionMeta(sessionDir) {
  const wsPath = path.join(sessionDir, 'workspace.yaml');
  if (!fs.existsSync(wsPath)) return null;
  const yaml = parseYamlSimple(fs.readFileSync(wsPath, 'utf-8'));
  return {
    id: yaml.id || path.basename(sessionDir),
    name: yaml.name || '(unnamed)',
    cwd: yaml.cwd || '',
    repository: yaml.repository || '',
    branch: yaml.branch || '',
    client: yaml.client_name || '',
    createdAt: yaml.created_at || '',
    updatedAt: yaml.updated_at || ''
  };
}

function readSessionConversation(sessionDir, opts = {}) {
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return { turns: [], summary: '' };
  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
  const turns = [];
  let currentAssistant = '';
  let currentSteps = [];
  let subTurnCount = 0;
  let currentModel = null;
  let sessionMeta = null;
  let tokenStats = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'session.start' && ev.data) {
        sessionMeta = {
          cwd: ev.data.context?.cwd,
          branch: ev.data.context?.branch,
          repo: ev.data.context?.repository,
          agent: ev.data.context?.agentName,
          copilotVersion: ev.data.copilotVersion
        };
      }
      if (ev.type === 'session.resume' && ev.data) {
        if (!sessionMeta) sessionMeta = {};
        sessionMeta.cwd = sessionMeta.cwd || ev.data.context?.cwd;
        sessionMeta.branch = sessionMeta.branch || ev.data.context?.branch;
        sessionMeta.repo = sessionMeta.repo || ev.data.context?.repository;
      }
      if (ev.type === 'subagent.selected' && ev.data) {
        if (!sessionMeta) sessionMeta = {};
        sessionMeta.agent = ev.data.agentDisplayName || ev.data.agentName;
      }
      if (ev.type === 'session.model_change' && ev.data) {
        currentModel = ev.data.newModel;
      }
      if (ev.type === 'session.shutdown' && ev.data) {
        tokenStats = {
          premiumRequests: ev.data.totalPremiumRequests,
          apiDurationMs: ev.data.totalApiDurationMs,
          input: ev.data.tokenDetails?.input?.tokenCount || 0,
          cacheRead: ev.data.tokenDetails?.cache_read?.tokenCount || 0,
          cacheWrite: ev.data.tokenDetails?.cache_write?.tokenCount || 0,
          output: ev.data.tokenDetails?.output?.tokenCount || 0,
          linesAdded: ev.data.codeChanges?.linesAdded,
          linesRemoved: ev.data.codeChanges?.linesRemoved
        };
      }
      if (ev.type === 'user.message' && ev.data?.content) {
        if (currentAssistant) {
          if (turns.length > 0) {
            turns[turns.length - 1].assistant = currentAssistant;
            turns[turns.length - 1].model = currentModel;
            turns[turns.length - 1].steps = [...currentSteps];
          }
          currentAssistant = '';
          currentSteps = [];
        }
        subTurnCount = 0;
        turns.push({ role: 'user', content: ev.data.content, timestamp: ev.timestamp, assistant: '', model: null, steps: [] });
      } else if (ev.type === 'assistant.turn_start') {
        subTurnCount++;
      } else if (ev.type === 'assistant.message' && ev.data?.content) {
        if (ev.data.model) currentModel = ev.data.model;
        if (subTurnCount > 1 || currentSteps.length > 0) {
          currentSteps.push({ type: 'comment', content: ev.data.content });
        }
        currentAssistant = ev.data.content;
      } else if (ev.type === 'tool.execution_start' && ev.data) {
        currentSteps.push({ type: 'tool_start', tool: ev.data.toolName, args: ev.data.arguments, toolCallId: ev.data.toolCallId });
      } else if (ev.type === 'tool.execution_complete' && ev.data) {
        const step = currentSteps.find(s => s.toolCallId === ev.data.toolCallId);
        if (step) {
          step.type = 'tool';
          step.success = ev.data.success;
          step.result = (ev.data.result?.content || '').substring(0, 2000);
          if (ev.data.result?.detailedContent) step.detail = ev.data.result.detailedContent.substring(0, 500);
        } else {
          currentSteps.push({ type: 'tool', tool: ev.data.toolName || '?', success: ev.data.success, result: (ev.data.result?.content || '').substring(0, 2000) });
        }
      }
    } catch { /* skip malformed lines */ }
  }
  // Assign last assistant response
  if (currentAssistant && turns.length > 0) {
    turns[turns.length - 1].assistant = currentAssistant;
    turns[turns.length - 1].model = currentModel;
    turns[turns.length - 1].steps = [...currentSteps];
  }
  // Remove duplicate: if last step is a comment matching the final assistant response
  for (const turn of turns) {
    if (turn.steps && turn.steps.length > 0 && turn.assistant) {
      const lastStep = turn.steps[turn.steps.length - 1];
      if (lastStep.type === 'comment' && lastStep.content === turn.assistant) {
        turn.steps.pop();
      }
    }
  }
  const lastAssistant = currentAssistant || (turns.length > 0 ? turns[turns.length - 1].assistant : '');
  const summary = lastAssistant.substring(0, 500);
  return { turns, summary, sessionMeta, tokenStats };
}

// Convert readSessionConversation() step objects (tool/tool_start/comment) into
// the {type,label,text} activity shape the chat message renderer expects.
function cliStepsToActivity(steps) {
  const out = [];
  for (const s of steps || []) {
    if (s.type === 'comment') {
      out.push({ type: 'thinking', label: '💬 Note', text: String(s.content || '').slice(0, 4000) });
    } else {
      const ok = s.success !== false;
      const name = s.tool || 'tool';
      let text = '';
      if (s.args) {
        try { text = typeof s.args === 'string' ? s.args : JSON.stringify(s.args); } catch { text = ''; }
      }
      if (!text && s.result) text = String(s.result).slice(0, 1500);
      out.push({ type: ok ? 'tool' : 'error', label: '🔧 ' + name + (ok ? ' ✓' : ' ✗'), text: String(text).slice(0, 2000) });
    }
  }
  return out;
}

// Flatten parsed session turns into chat messages (user + assistant pairs).
function cliTurnsToMessages(turns) {
  const msgs = [];
  for (const t of turns || []) {
    if (t.content) msgs.push({ role: 'user', content: t.content, timestamp: t.timestamp });
    if (t.assistant || (t.steps && t.steps.length)) {
      const m = { role: 'assistant', content: t.assistant || '', timestamp: t.timestamp, model: t.model || '' };
      const act = cliStepsToActivity(t.steps);
      if (act.length) m.activity = act;
      msgs.push(m);
    }
  }
  return msgs;
}

// Mirror a CLI-backed chat's bound copilot session (events.jsonl) into the
// chat's messages[] so the read-only SPA view reflects the live terminal.
// Returns the (possibly updated) chat object.
function syncCliChat(chat) {
  if (!chat || chat.source !== 'cli' || !chat.cliSessionId) return chat;
  const dir = path.join(STATE_DIR, chat.cliSessionId);
  if (!fs.existsSync(dir)) return chat;
  let conv;
  try { conv = readSessionConversation(dir); } catch { return chat; }
  const msgs = cliTurnsToMessages(conv.turns || []);
  const prevLen = (chat.messages || []).length;
  const prevLast = JSON.stringify((chat.messages || [])[prevLen - 1] || null);
  const newLast = JSON.stringify(msgs[msgs.length - 1] || null);
  const changed = msgs.length !== prevLen || newLast !== prevLast;
  if (!changed) return chat;
  chat.messages = msgs;
  chat.updatedAt = new Date().toISOString();
  if (conv.sessionMeta && conv.sessionMeta.agent && !chat.agentName) chat.agentName = conv.sessionMeta.agent;
  try { fs.writeFileSync(path.join(CHATS_DIR, `${chat.id}.json`), JSON.stringify(chat, null, 2)); } catch { /* ignore */ }
  broadcastSSE('chat-message', { chatId: chat.id, message: msgs[msgs.length - 1] || null });
  return chat;
}

app.get('/api/sessions', (req, res) => {
  const hoursBack = parseInt(req.query.hours) || 24;
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  try {
    if (!fs.existsSync(SESSION_STATE_DIR)) return res.json([]);
    const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    const sessions = [];
    for (const d of dirs) {
      const fullPath = path.join(SESSION_STATE_DIR, d.name);
      const stat = fs.statSync(fullPath);
      if (stat.mtime < cutoff) continue;
      const meta = readSessionMeta(fullPath);
      if (!meta) continue;
      // Get a quick summary without full conversation
      const eventsPath = path.join(fullPath, 'events.jsonl');
      let lastResult = '';
      let turnCount = 0;
      let agentName = '';
      if (fs.existsSync(eventsPath)) {
        const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'user.message') turnCount++;
            if (ev.type === 'assistant.message' && ev.data?.content) lastResult = ev.data.content;
            if (ev.type === 'subagent.selected' && ev.data?.agentDisplayName) agentName = ev.data.agentDisplayName;
          } catch { }
        }
      }
      sessions.push({
        ...meta,
        agentName: agentName || '',
        lastResult: lastResult.substring(0, 800),
        turnCount,
        lastModified: stat.mtime.toISOString()
      });
    }
    sessions.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });
  const meta = readSessionMeta(sessionDir);
  const conversation = readSessionConversation(sessionDir);
  // Extract agent name from events
  let agentName = '';
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'subagent.selected' && ev.data?.agentDisplayName) {
          agentName = ev.data.agentDisplayName;
          break;
        }
      } catch { }
    }
  }
  res.json({ ...meta, agentName, ...conversation });
});

app.post('/api/sessions/:id/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const meta = readSessionMeta(sessionDir);
  // Resume the existing SDK session by id. The agent/tools are already baked
  // into the persisted session, so only the working directory is supplied.
  runChatTurn({
    sessionId: req.params.id,
    message,
    config: { cwd: meta.cwd || undefined },
    resume: true,
  });
  // Return immediately — client polls /poll for live updates.
  res.json({ ok: true, started: true });
});

// Poll a session for latest state (turn count + last assistant message)
app.get('/api/sessions/:id/poll', (req, res) => {
  const sessionId = req.params.id;
  const verbose = req.query.verbose === '1';
  const buf = liveChatBuffers.get(sessionId);

  // While a chat turn is streaming the SDK has not flushed events.jsonl to disk,
  // so serve the in-progress turn from the live in-memory buffer (prior turns
  // were snapshotted from the flushed file when the turn started).
  if (buf && buf.running) {
    const turns = [...(buf.priorTurns || [])];
    turns.push({
      content: buf.userPrompt || '',
      assistant: buf.acc || null,
      model: buf.requestedModel || undefined,
      steps: verbose ? (buf.steps || []) : undefined,
    });
    return res.json({
      turnCount: turns.length,
      lastAssistant: buf.acc || '',
      isActive: true,
      lastModified: new Date(buf.lastUpdate || buf.startedAt).toISOString(),
      turns,
    });
  }

  const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    // A brand-new session whose turn failed before any disk flush.
    if (buf) {
      const turns = [...(buf.priorTurns || []), { content: buf.userPrompt || '', assistant: null, steps: verbose ? [] : undefined }];
      const response = { turnCount: turns.length, lastAssistant: '', isActive: false, lastModified: new Date(buf.finishedAt || Date.now()).toISOString(), turns };
      if (buf.error) response.chatError = buf.error;
      liveChatBuffers.delete(sessionId);
      return res.json(response);
    }
    return res.status(404).json({ error: 'Session not found' });
  }
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return res.json({ turnCount: 0, lastAssistant: '', isActive: false, turns: [] });

  const stat = fs.statSync(eventsPath);
  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
  const parsed = buildPollTurns(lines, verbose);

  // A just-finished chat turn: the file is now flushed and complete, so report
  // completion deterministically (don't wait out the mtime window) and clear
  // the one-shot live buffer.
  let isActive = (Date.now() - stat.mtime.getTime()) < 30000;
  if (buf && !buf.running) isActive = false;

  const response = {
    turnCount: parsed.turnCount,
    lastAssistant: parsed.lastAssistant,
    isActive,
    lastModified: stat.mtime.toISOString(),
    turns: parsed.turns,
  };
  if (verbose) {
    if (parsed.sessionMeta) response.sessionMeta = parsed.sessionMeta;
    if (parsed.tokenStats) response.tokenStats = parsed.tokenStats;
  }
  const chatErr = chatErrors.get(sessionId);
  if (chatErr) {
    response.chatError = chatErr.error;
    chatErrors.delete(sessionId);
  }
  if (buf && !buf.running) liveChatBuffers.delete(sessionId);
  res.json(response);
});

app.post('/api/sessions/:id/terminal', (req, res) => {
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });
  const meta = readSessionMeta(sessionDir);
  const cwd = req.body?.cwd || meta.cwd || __dirname;

  const copilotCmd = process.env.COPILOT_PATH || 'copilot';
  const { exec } = require('child_process');
  // NOTE: avoid parenthesized cmd blocks like `if exist "x" ( ... )` / `|| ( ... )`.
  // cmd expands %PATH% while parsing the whole block, and PATH entries that
  // contain ")" (e.g. "C:\Program Files (x86)\...") prematurely close the block,
  // producing errors such as "\Microsoft was unexpected at this time." Use goto
  // labels instead so each statement is parsed independently.
  //
  // Guard: `where <pattern>` only works for a bare command name; when COPILOT_PATH
  // is an absolute path (e.g. ...\copilot.cmd) `where` returns errorlevel 2 even
  // though the file exists. Use `if not exist` for path-qualified launchers.
  const copilotIsPath = /[\\/:]/.test(copilotCmd);
  const guardLines = copilotIsPath
    ? [`if not exist "${copilotCmd}" goto nocopilot`]
    : [`where "${copilotCmd}" >nul 2>&1`, 'if errorlevel 1 goto nocopilot'];
  const batContent = [
    '@echo off',
    `if not exist "${cwd}" goto nodir`,
    `cd /d "${cwd}"`,
    ...guardLines,
    `"${copilotCmd}" --resume=${req.params.id} --yolo`,
    'pause',
    'exit /b 0',
    ':nodir',
    `echo ERROR: Working directory not found: ${cwd}`,
    'pause',
    'exit /b 1',
    ':nocopilot',
    'echo ERROR: copilot not found in PATH',
    'echo PATH=%PATH%',
    'pause',
    'exit /b 1',
  ].join('\r\n');
  const batPath = path.join(__dirname, `temp-terminal-${req.params.id}.bat`);
  fs.writeFileSync(batPath, batContent);
  exec(`start "Copilot Session" "${batPath}"`);
  res.json({ ok: true });
});

// Open copilot in a directory without resuming a session
app.post('/api/terminal/open', (req, res) => {
  const { cwd } = req.body || {};
  if (!cwd) return res.status(400).json({ error: 'cwd required' });

  const copilotCmd = process.env.COPILOT_PATH || 'copilot';
  const { exec } = require('child_process');
  // See note above: no parenthesized cmd blocks (PATH may contain ")" ), and use
  // `if not exist` rather than `where` when COPILOT_PATH is a path-qualified launcher.
  const copilotIsPath = /[\\/:]/.test(copilotCmd);
  const guardLines = copilotIsPath
    ? [`if not exist "${copilotCmd}" goto nocopilot`]
    : [`where "${copilotCmd}" >nul 2>&1`, 'if errorlevel 1 goto nocopilot'];
  const batContent = [
    '@echo off',
    `if not exist "${cwd}" goto nodir`,
    `cd /d "${cwd}"`,
    ...guardLines,
    `"${copilotCmd}" --yolo`,
    'pause',
    'exit /b 0',
    ':nodir',
    `echo ERROR: Working directory not found: ${cwd}`,
    'pause',
    'exit /b 1',
    ':nocopilot',
    'echo ERROR: copilot not found in PATH',
    'echo PATH=%PATH%',
    'pause',
    'exit /b 1',
  ].join('\r\n');
  const batPath = path.join(__dirname, `temp-terminal-${Date.now().toString(36)}.bat`);
  fs.writeFileSync(batPath, batContent);
  exec(`start "Copilot Session" "${batPath}"`);
  res.json({ ok: true });
});

// ============ CLI Sessions page ============
// Lists every known Copilot CLI/SDK session (workspace.yaml present), with a
// derived title and any cached AI summary. "Resume" reuses the existing
// POST /api/sessions/:id/terminal endpoint above.
const SPA_SUMMARY_FILE = '.spa-summary.json';
// Incremental in-memory cache for the CLI sessions list. Keyed by session dir name;
// each value is { sig, entry } where sig is a composite of file mtimes. Repeat loads
// reuse entries whose underlying files are unchanged, so the page loads instantly.
const _cliSessCache = new Map();

function deriveSessionTitle(meta, agentName, lastUser) {
  if (meta && meta.name && meta.name !== '(unnamed)' && String(meta.name).trim()) return String(meta.name).trim();
  const t = String(lastUser || '').replace(/\s+/g, ' ').trim();
  if (t) return t.length > 70 ? t.slice(0, 70) + '…' : t;
  if (agentName) return agentName + ' run';
  return '(untitled session)';
}

app.get('/api/cli/sessions', (req, res) => {
  try {
    if (!fs.existsSync(SESSION_STATE_DIR)) return res.json([]);
    const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    const out = [];
    const seen = new Set();
    for (const d of dirs) {
      const full = path.join(SESSION_STATE_DIR, d.name);
      let stat; try { stat = fs.statSync(full); } catch { continue; }
      seen.add(d.name);
      // Cheap signature from file mtimes; skip the expensive parse if unchanged.
      const ep = path.join(full, 'events.jsonl');
      const sp = path.join(full, SPA_SUMMARY_FILE);
      let epm = 0, spm = 0;
      try { epm = fs.statSync(ep).mtimeMs; } catch {}
      try { spm = fs.statSync(sp).mtimeMs; } catch {}
      const sig = `${stat.mtimeMs}:${epm}:${spm}`;
      const cached = _cliSessCache.get(d.name);
      if (cached && cached.sig === sig) { out.push(cached.entry); continue; }
      const meta = readSessionMeta(full);
      if (!meta) continue; // require workspace.yaml
      let turnCount = 0, agentName = '', lastUser = '';
      if (epm) {
        try {
          for (const line of fs.readFileSync(ep, 'utf-8').split('\n')) {
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'user.message') { turnCount++; if (ev.data && ev.data.content) lastUser = String(ev.data.content); }
            else if (ev.type === 'subagent.selected' && ev.data && ev.data.agentDisplayName) agentName = ev.data.agentDisplayName;
            else if (ev.type === 'session.start' && ev.data && ev.data.context && ev.data.context.agentName && !agentName) agentName = ev.data.context.agentName;
          }
        } catch {}
      }
      let summary = null, summaryAt = null;
      if (spm) { try { const s = JSON.parse(fs.readFileSync(sp, 'utf-8')); summary = s.summary; summaryAt = s.generatedAt; } catch {} }
      const entry = {
        id: meta.id,
        title: deriveSessionTitle(meta, agentName, lastUser),
        agentName,
        cwd: meta.cwd,
        repository: meta.repository,
        branch: meta.branch,
        client: meta.client,
        turnCount,
        lastUserPreview: lastUser.replace(/\s+/g, ' ').trim().slice(0, 160),
        createdAt: meta.createdAt,
        lastModified: stat.mtime.toISOString(),
        summary,
        summaryAt
      };
      _cliSessCache.set(d.name, { sig, entry });
      out.push(entry);
    }
    // Drop cache entries for sessions that no longer exist.
    if (_cliSessCache.size > seen.size) {
      for (const k of _cliSessCache.keys()) if (!seen.has(k)) _cliSessCache.delete(k);
    }
    out.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate (or return cached) a brief AI summary of a session. Cached on disk so
// it persists and is cheap to re-fetch. Pass {force:true} to regenerate.
app.post('/api/cli/sessions/:id/summarize', async (req, res) => {
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });
  const force = !!(req.body && req.body.force);
  const sp = path.join(sessionDir, SPA_SUMMARY_FILE);
  if (!force && fs.existsSync(sp)) {
    try { const s = JSON.parse(fs.readFileSync(sp, 'utf-8')); return res.json({ summary: s.summary, generatedAt: s.generatedAt, cached: true }); } catch {}
  }
  let conv;
  try { conv = readSessionConversation(sessionDir); } catch (e) { return res.status(500).json({ error: 'read failed: ' + e.message }); }
  const turns = (conv && conv.turns) || [];
  const lines = [];
  for (const t of turns.slice(-30)) {
    if (t.content) lines.push('USER: ' + String(t.content).replace(/\s+/g, ' ').trim().slice(0, 600));
    if (t.assistant) lines.push('ASSISTANT: ' + String(t.assistant).replace(/\s+/g, ' ').trim().slice(0, 600));
  }
  // Fallback for agent-run sessions: user.message has no inline content (prompt is
  // delivered via file), so readSessionConversation() yields no turns. Pull the raw
  // assistant messages, the kickoff prompt, and tool activity straight from the log.
  if (!lines.length) {
    try {
      const ep = path.join(sessionDir, 'events.jsonl');
      if (fs.existsSync(ep)) {
        const tools = [];
        for (const ln of fs.readFileSync(ep, 'utf-8').split('\n')) {
          if (!ln) continue;
          let ev; try { ev = JSON.parse(ln); } catch { continue; }
          const d = ev.data || {};
          if (ev.type === 'session.start' && d.context && d.context.agentName) lines.push('AGENT: ' + d.context.agentName);
          else if (ev.type === 'subagent.selected' && (d.agentDisplayName || d.agentName)) lines.push('AGENT: ' + (d.agentDisplayName || d.agentName));
          else if (ev.type === 'user.message' && d.content) lines.push('PROMPT: ' + String(d.content).replace(/\s+/g, ' ').trim().slice(0, 800));
          else if (ev.type === 'assistant.message' && d.content) lines.push('ASSISTANT: ' + String(d.content).replace(/\s+/g, ' ').trim().slice(0, 800));
          else if (ev.type === 'tool.execution_start' && d.toolName) tools.push(d.toolName);
        }
        if (tools.length) {
          const counts = {};
          for (const t of tools) counts[t] = (counts[t] || 0) + 1;
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => v > 1 ? `${k}×${v}` : k);
          lines.push('TOOLS USED: ' + top.join(', '));
        }
      }
    } catch {}
  }
  if (!lines.length) return res.status(400).json({ error: 'No conversation content to summarize' });
  const transcript = lines.join('\n').slice(0, 9000);
  const prompt = [
    'Summarize the following Copilot CLI session in 2-4 sentences.',
    'Focus on: what the user was trying to do, what was accomplished, and the current state or any next steps.',
    'Be concrete and specific. Plain prose, no preamble, no bullet list, no surrounding quotes.',
    '',
    'Transcript:',
    transcript,
    '',
    'Summary:'
  ].join('\n');
  try {
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
    let summary = (acc.trim() || (result && result.output) || '').trim();
    if (!summary) return res.status(500).json({ error: 'Empty summary returned' });
    const payload = { summary, generatedAt: new Date().toISOString(), turnCount: turns.length };
    try { fs.writeFileSync(sp, JSON.stringify(payload, null, 2)); } catch {}
    res.json({ summary, generatedAt: payload.generatedAt, cached: false });
  } catch (e) { res.status(500).json({ error: (e && e.message) || 'summarize failed' }); }
});

// ============ Agent / Plugin Updates page ============
// A single normalized inventory of every installed agent/plugin with its origin,
// type, last-updated time, and commit id. Update-availability is checked per-row
// by the existing GET /api/agents/:id/check-update; reinstall via POST .../reinstall.
app.get('/api/updates/inventory', (req, res) => {
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const out = agents.map(a => {
      const s = a.source || null;
      const kind = (s && s.kind) || (a.pluginDir ? 'plugin' : 'agent');
      const originType = (s && s.type) || (a.pluginDir ? 'local' : 'builtin');
      let originLabel = 'Local project';
      let sourceDetail = '';
      if (s && s.type === 'azdo') {
        originLabel = `${s.org}/${s.project}/${s.repo}`;
        sourceDetail = `${s.repo}@${s.branch} · ${s.path}`;
      } else if (s && s.type === 'local') {
        originLabel = 'Local folder';
        sourceDetail = s.path || a.pluginDir || a.cwd || '';
      } else if (a.pluginDir) {
        originLabel = 'Local plugin';
        sourceDetail = a.pluginDir;
      } else if (a.cwd) {
        originLabel = 'Local project';
        sourceDetail = a.cwd;
      }
      let lastUpdated = (s && s.installedAt) || null;
      if (!lastUpdated) {
        const probe = a.pluginDir || a.cwd;
        if (probe) { try { if (fs.existsSync(probe)) lastUpdated = fs.statSync(probe).mtime.toISOString(); } catch {} }
      }
      return {
        id: a.id,
        name: a.name || a.id,
        kind,
        originType,
        originLabel,
        sourceDetail,
        lastUpdated,
        commitId: (s && s.objectId) || null,
        reinstallable: !!(s || a.pluginDir),
        checkable: !!((s && s.type === 'azdo') || a.pluginDir || a.sourceDir)
      };
    });
    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aggregate count of agents/plugins with an update available. Server-cached for
// 5 minutes since azdo checks are network-bound; pass ?force=1 to bypass.
let _updAvailCache = null; // { at, data }
app.get('/api/updates/available-count', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && _updAvailCache && (Date.now() - _updAvailCache.at) < 5 * 60 * 1000) {
    return res.json({ ..._updAvailCache.data, cached: true });
  }
  try {
    const entries = [...supervisor.agents.entries()]; // [id, { config, ... }]
    const total = entries.length;
    const checkables = entries.filter(([, e]) => {
      const c = (e && e.config) || {};
      return !!((c.source && c.source.type === 'azdo') || c.pluginDir || c.sourceDir);
    });
    const results = await Promise.all(checkables.map(async ([id, e]) => {
      try { const st = await computeUpdateStatus(e); return { id, up: st.upToDate }; }
      catch { return { id, up: null }; }
    }));
    const checked = results.filter(r => r.up !== null).length;
    const availItems = results.filter(r => r.up === false).map(r => r.id);
    const data = { available: availItems.length, items: availItems, checked, total, checkedAt: new Date().toISOString() };
    _updAvailCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summarize what an available update would change for an agent/plugin. Gathers a
// textual diff of the installed files vs. the newest source (azdo repo or local
// source folder), then asks the LLM for a 1-3 sentence description of the changes.
const TEXT_EXTS = new Set(['.md', '.markdown', '.json', '.yml', '.yaml', '.txt', '.js', '.ts', '.py', '.ps1', '.sh']);
function isTextFile(p) { return TEXT_EXTS.has(path.extname(p).toLowerCase()); }
function readTextSafe(p) { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } }
function lineDiff(oldText, newText) {
  const oldLines = String(oldText || '').split('\n');
  const newLines = String(newText || '').split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter(l => l.trim() && !oldSet.has(l));
  const removed = oldLines.filter(l => l.trim() && !newSet.has(l));
  return { added, removed };
}

app.post('/api/updates/:id/summarize-changes', async (req, res) => {
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const agent = agents.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const s = agent.source || null;
    const files = []; // { path, added:[], removed:[] }

    if (s && s.type === 'azdo') {
      // Collect repo blob paths under the source path, fetch new content, diff vs installed.
      let blobs = [];
      try {
        const tree = await azdo.getTree(s.org, s.project, s.repo, s.branch);
        const base = '/' + String(s.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
        blobs = tree.filter(it => {
          const p = it.path || '';
          return isTextFile(p) && (p === base || p.startsWith(base + '/') || p.startsWith(base));
        });
      } catch (e) { return res.status(502).json({ error: 'Could not read source repo: ' + e.message }); }
      if (!blobs.length) {
        // Agent definitions are often a single file at s.path.
        if (isTextFile(s.path || '')) blobs = [{ path: '/' + String(s.path).replace(/^\/+/, '') }];
      }
      const installRoot = s.kind === 'plugin' ? (agent.pluginDir || agent.sourceDir) : agent.cwd;
      for (const b of blobs.slice(0, 8)) {
        const repoPath = b.path;
        let newText = '';
        try { newText = await azdo.getFileText(s.org, s.project, s.repo, s.branch, repoPath); } catch {}
        // Map repo path to the installed file on disk.
        let oldText = '';
        if (installRoot) {
          const baseClean = String(s.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
          const rp = repoPath.replace(/^\/+/, '');
          let rel = rp.startsWith(baseClean) ? rp.slice(baseClean.length).replace(/^\/+/, '') : path.basename(rp);
          let candidate = path.join(installRoot, rel || path.basename(rp));
          if (!fs.existsSync(candidate)) {
            // Agents materialize under .github/agents/<file>.
            const alt = path.join(installRoot, '.github', 'agents', path.basename(rp));
            if (fs.existsSync(alt)) candidate = alt;
          }
          oldText = readTextSafe(candidate);
        }
        const d = lineDiff(oldText, newText);
        if (d.added.length || d.removed.length) files.push({ path: repoPath, added: d.added, removed: d.removed });
      }
    } else {
      // Local plugin/agent: compare source folder vs installed folder. Resolve the
      // source the SAME way GET /api/agents/:id/check-update does, so an item that
      // shows "update available" always has a source to diff against.
      let sourceDir = agent.sourceDir || (s && s.path) || null;
      const installDir = agent.pluginDir || agent.cwd || null;
      if (!sourceDir && agent.pluginDir && String(agent.pluginDir).includes(PLUGINS_DIR)) {
        const cand = path.join(agent.cwd || '', '.github', 'plugin', path.basename(agent.pluginDir));
        if (fs.existsSync(cand)) sourceDir = cand;
      }
      if (!sourceDir || !installDir || path.resolve(sourceDir) === path.resolve(installDir)) {
        return res.json({ summary: 'This item is installed directly from its source folder, so there are no pending changes to describe.', changedFiles: [], upToDate: true });
      }
      if (!fs.existsSync(sourceDir)) return res.json({ summary: 'The update source folder is no longer available.', changedFiles: [], upToDate: true });
      const collect = (dir, prefix, acc) => {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) collect(path.join(dir, e.name), rel, acc);
            else if (isTextFile(e.name)) acc.push(rel);
          }
        } catch {}
        return acc;
      };
      const relFiles = collect(sourceDir, '', []);
      for (const rel of relFiles.slice(0, 12)) {
        const newText = readTextSafe(path.join(sourceDir, rel));
        const oldText = readTextSafe(path.join(installDir, rel));
        if (newText === oldText) continue;
        const d = lineDiff(oldText, newText);
        if (d.added.length || d.removed.length) files.push({ path: rel, added: d.added, removed: d.removed });
        if (files.length >= 8) break;
      }
    }

    if (!files.length) {
      return res.json({ summary: 'No content changes detected — this item appears up to date.', changedFiles: [], upToDate: true });
    }

    // Build a compact diff text for the LLM (cap size).
    const parts = [];
    for (const f of files) {
      parts.push('FILE: ' + f.path);
      for (const l of f.removed.slice(0, 25)) parts.push('- ' + l.trim().slice(0, 200));
      for (const l of f.added.slice(0, 25)) parts.push('+ ' + l.trim().slice(0, 200));
      parts.push('');
    }
    const diffText = parts.join('\n').slice(0, 9000);
    const prompt = [
      'Briefly describe what changed in this update to an AI agent/plugin, in 1-3 plain-prose sentences.',
      'Focus on the substance of the changes (new capabilities, instruction tweaks, config or tool changes), not file mechanics.',
      'No preamble, no bullet list, no surrounding quotes.',
      '',
      'Changed lines (- removed, + added):',
      diffText,
      '',
      'Summary of changes:'
    ].join('\n');
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
    const summary = (acc.trim() || (result && result.output) || '').trim();
    if (!summary) return res.status(500).json({ error: 'Empty summary returned' });
    res.json({ summary, changedFiles: files.map(f => f.path), upToDate: false });
  } catch (e) { res.status(500).json({ error: (e && e.message) || 'summarize-changes failed' }); }
});

// Export configuration as zip
app.get('/api/export', (req, res) => {
  const zip = new yazl.ZipFile();

  // agents.json
  zip.addFile(AGENTS_PATH, 'agents.json');

  // managers.json
  if (fs.existsSync(MANAGERS_PATH)) {
    zip.addFile(MANAGERS_PATH, 'managers.json');
  }

  // events-config.json
  const eventsConfigPath = path.join(__dirname, 'events-config.json');
  if (fs.existsSync(eventsConfigPath)) {
    zip.addFile(eventsConfigPath, 'events-config.json');
  }

  // plugins directory (runtime store in user profile)
  const pluginsDir = PLUGINS_DIR;
  if (fs.existsSync(pluginsDir)) {
    const addDir = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const zipPath = prefix + '/' + entry.name;
        if (entry.isDirectory()) addDir(fullPath, zipPath);
        else zip.addFile(fullPath, zipPath);
      }
    };
    addDir(pluginsDir, 'plugins');
  }

  // mcp-configs directory (runtime store in user profile)
  const mcpDir = MCP_CONFIGS_DIR;
  if (fs.existsSync(mcpDir)) {
    const addDir = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const zipPath = prefix + '/' + entry.name;
        if (entry.isDirectory()) addDir(fullPath, zipPath);
        else zip.addFile(fullPath, zipPath);
      }
    };
    addDir(mcpDir, 'mcp-configs');
  }

  // Export agent state (enabled/disabled, schedules) from DB
  const agentStates = [];
  const allStatus = supervisor.getAllStatus();
  for (const agent of allStatus) {
    agentStates.push({
      agent_id: agent.agent_id,
      enabled: agent.enabled,
      schedule: agent.schedule,
      group: agent.config?.group || null,
      autoStart: agent.autoStart
    });
  }
  zip.addBuffer(Buffer.from(JSON.stringify(agentStates, null, 2)), 'agent-state.json');

  // package.json for dependency reference
  const pkgPath = path.join(__dirname, 'package.json');
  if (fs.existsSync(pkgPath)) {
    zip.addFile(pkgPath, 'package.json');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="agent-supervisor-config-${new Date().toISOString().slice(0,10)}.zip"`);
  zip.outputStream.pipe(res);
  zip.end();
});

// Import configuration from zip
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const results = { imported: [], warnings: [], errors: [] };

  try {
    const entries = await new Promise((resolve, reject) => {
      const files = {};
      yauzl.open(req.file.path, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.readEntry();
        zipfile.on('entry', entry => {
          if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
          zipfile.openReadStream(entry, (err, stream) => {
            if (err) return reject(err);
            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => { files[entry.fileName] = Buffer.concat(chunks); zipfile.readEntry(); });
          });
        });
        zipfile.on('end', () => resolve(files));
      });
    });

    // Discover copilot on this machine
    const { execSync } = require('child_process');
    let copilotPath = null;
    try {
      copilotPath = execSync('where copilot', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
      results.imported.push(`Copilot found: ${copilotPath}`);
    } catch {
      results.warnings.push('copilot not found in PATH. Install GitHub Copilot CLI or set COPILOT_PATH env var.');
    }

    // Import agents.json
    if (entries['agents.json']) {
      const agents = JSON.parse(entries['agents.json'].toString());
      for (const agent of agents) {
        // Remove hardcoded copilotPath — rely on PATH resolution
        delete agent.copilotPath;
        // Rewrite pluginDir to local plugins/ directory if it's an absolute path from another machine
        if (agent.pluginDir) {
          const pluginName = path.basename(agent.pluginDir);
          const localPluginDir = path.join(PLUGINS_DIR, pluginName);
          if (agent.pluginDir !== localPluginDir) {
            agent.pluginDir = localPluginDir;
          }
        }
      }
      // Validate CWDs
      for (const agent of agents) {
        if (agent.cwd && !fs.existsSync(agent.cwd)) {
          results.warnings.push(`Agent "${agent.name || agent.id}": CWD does not exist: ${agent.cwd}`);
        }
      }
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
      results.imported.push(`agents.json: ${agents.length} agents`);
    }

    // Import managers.json
    if (entries['managers.json']) {
      const managers = JSON.parse(entries['managers.json'].toString());
      fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
      results.imported.push(`managers.json: ${managers.length} managers`);
    }

    // Import events-config.json
    if (entries['events-config.json']) {
      const eventsPath = path.join(__dirname, 'events-config.json');
      fs.writeFileSync(eventsPath, entries['events-config.json'].toString());
      results.imported.push('events-config.json imported');
    }

    // Import plugins
    let pluginCount = 0;
    for (const [filePath, content] of Object.entries(entries)) {
      if (filePath.startsWith('plugins/')) {
        const destPath = path.join(SUPERVISOR_DATA_DIR, filePath.replace(/\//g, path.sep));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
        pluginCount++;
      }
    }
    if (pluginCount > 0) results.imported.push(`plugins: ${pluginCount} files`);

    // Install extracted plugins into copilot (with tools restriction patching)
    if (pluginCount > 0 && copilotPath) {
      const { execSync } = require('child_process');
      const os = require('os');
      const pluginsDir = PLUGINS_DIR;
      const pluginDirs = fs.readdirSync(pluginsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(pluginsDir, d.name));
      for (const pDir of pluginDirs) {
        if (!fs.existsSync(path.join(pDir, 'plugin.json'))) continue;
        const pluginName = path.basename(pDir);
        try {
          // Create patched copy (remove tools restrictions)
          const patchedDir = path.join(os.tmpdir(), `plugin-import-${pluginName}-${Date.now()}`);
          fs.cpSync(pDir, patchedDir, { recursive: true });
          const agentsDir = path.join(patchedDir, 'agents');
          if (fs.existsSync(agentsDir)) {
            for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
              const agentFile = path.join(agentsDir, f);
              let content = fs.readFileSync(agentFile, 'utf-8').replace(/\r\n/g, '\n');
              content = content.replace(/^(---\n[\s\S]*?)(tools:\n(?:\s+-[^\n]*\n)*)([\s\S]*?---)/m, '$1$3');
              fs.writeFileSync(agentFile, content);
            }
          }
          // Uninstall first (ignore errors if not installed)
          try { execSync(`"${copilotPath}" plugin uninstall "${pluginName}"`, { encoding: 'utf-8', shell: true, timeout: 30000 }); } catch {}
          execSync(`"${copilotPath}" plugin install "${patchedDir}"`, { encoding: 'utf-8', shell: true, timeout: 30000 });
          try { fs.rmSync(patchedDir, { recursive: true }); } catch {}
          results.imported.push(`plugin installed: ${pluginName}`);
        } catch (e) {
          results.warnings.push(`plugin install failed for ${pluginName}: ${(e.stderr || e.message).trim().split('\n')[0]}`);
        }
      }
    }

    // Import mcp-configs
    let mcpCount = 0;
    for (const [filePath, content] of Object.entries(entries)) {
      if (filePath.startsWith('mcp-configs/')) {
        const destPath = path.join(SUPERVISOR_DATA_DIR, filePath.replace(/\//g, path.sep));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
        mcpCount++;
      }
    }
    if (mcpCount > 0) results.imported.push(`mcp-configs: ${mcpCount} files`);

    // Apply agent state (enabled/disabled flags)
    if (entries['agent-state.json']) {
      const states = JSON.parse(entries['agent-state.json'].toString());
      for (const state of states) {
        if (state.enabled === 0 || state.enabled === false) {
          db.prepare('UPDATE agent_state SET enabled = 0 WHERE agent_id = ?').run(state.agent_id);
        }
      }
      results.imported.push(`agent-state.json: ${states.length} states applied`);
    }

    // Reload supervisor with new config
    loadAgents();
    results.imported.push('Supervisor reloaded');

  } catch (e) {
    results.errors.push(`Import failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }

  res.json(results);
});

// ============ Config Sync API Routes ============

// Get sync status
// --- Global settings: model selection (chat / executions / system AI) --------
// Persisted server-side (settings.json) so schedules, triggers, chat and the
// manager brain all honor the chosen models — not just the browser.

// List available models from the SDK (id, name, cost multiplier, reasoning).
app.get('/api/models', async (req, res) => {
  try {
    const models = await sdkRunner.listModels();
    res.json({
      models: (models || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        multiplier: (m.billing && typeof m.billing.multiplier === 'number') ? m.billing.multiplier : null,
        reasoningEfforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [],
        defaultReasoningEffort: m.defaultReasoningEffort || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ models: [], error: err.message });
  }
});

// Read the global settings (model selections).
app.get('/api/settings', (req, res) => {
  res.json(settings.getSettings());
});

// Update the global settings. Body may include chatModel/executionModel/systemModel.
app.put('/api/settings', (req, res) => {
  try {
    const next = settings.updateSettings(req.body || {});
    // Persist into this machine's cloud config too, if sync is on and we lead.
    try { if (configSync && configSync.enabled && configSync.isLeader && configSync.pushConfig) configSync.pushConfig(); } catch {}
    res.json(next);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reports / Usage analytics ----------------------------------------------
// Exhaustive usage + cost reporting backed by the canonical usage_events ledger.
// Returns aggregate totals plus per-day, per-model and per-source breakdowns for
// a time window (default: last 30 days). Every billable run path (agent, task,
// manager, chat) writes exactly one ledger row, so nothing is double-counted.
app.get('/api/reports', (req, res) => {
  try {
    const reqDays = parseInt(req.query.days, 10);
    const days = Math.min(Math.max(Number.isFinite(reqDays) ? reqDays : 30, 1), 365);
    const now = new Date();
    let to = req.query.to ? String(req.query.to) : now.toISOString();
    let from = req.query.from ? String(req.query.from) : new Date(now.getTime() - days * 86400000).toISOString();
    const rate = settings.getCostPerPremiumRequest();
    const decorate = (rows) => rows.map(r => ({ ...r, cost: +(((r.premiumRequests || 0) * rate).toFixed(4)) }));

    const SUMS = `
        COUNT(*) AS runs,
        COALESCE(SUM(premium_requests),0) AS premiumRequests,
        COALESCE(SUM(api_duration_ms),0) AS apiDurationMs,
        COALESCE(SUM(input_tokens),0) AS inputTokens,
        COALESCE(SUM(output_tokens),0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens`;

    const agg = db.prepare(`SELECT ${SUMS},
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error
      FROM usage_events WHERE ts >= ? AND ts <= ?`).get(from, to) || {};

    const bySource = db.prepare(`SELECT source, ${SUMS}
      FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY source ORDER BY premiumRequests DESC`).all(from, to);

    const byModel = db.prepare(`SELECT COALESCE(NULLIF(model,''),'(runtime default)') AS model, ${SUMS}
      FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY model ORDER BY premiumRequests DESC, runs DESC`).all(from, to);

    const daily = db.prepare(`SELECT substr(ts,1,10) AS day, ${SUMS}
      FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY day ORDER BY day ASC`).all(from, to);

    // Zero-fill every day in the window so the chart renders a continuous
    // time axis instead of collapsing to a single bar when activity is sparse.
    const emptyDay = (day) => ({ day, runs: 0, premiumRequests: 0, apiDurationMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const dailyMap = new Map(daily.map(r => [r.day, r]));
    const filledDaily = [];
    const fillCursor = new Date(from.slice(0, 10) + 'T00:00:00Z');
    const fillEnd = new Date(to.slice(0, 10) + 'T00:00:00Z');
    for (let d = fillCursor; d <= fillEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      filledDaily.push(dailyMap.get(key) || emptyDay(key));
    }

    const dailyBySource = db.prepare(`SELECT substr(ts,1,10) AS day, source, COUNT(*) AS runs,
        COALESCE(SUM(premium_requests),0) AS premiumRequests
      FROM usage_events WHERE ts >= ? AND ts <= ? GROUP BY day, source ORDER BY day ASC`).all(from, to);

    // Per-source counts for the headline cards.
    const srcCount = {};
    for (const r of bySource) srcCount[r.source] = r.runs;

    // Flows: chain_runs is a separate table (not in the ledger).
    let flowsRun = 0;
    try { flowsRun = db.prepare(`SELECT COUNT(*) AS c FROM chain_runs WHERE started_at >= ? AND started_at <= ?`).get(from, to)?.c || 0; } catch {}

    // Total conversations (all-time): SPA chat files + mobile threads.
    let spaChats = 0;
    try { spaChats = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json')).length; } catch {}
    let mobileThreads = 0;
    try { mobileThreads = db.prepare(`SELECT COUNT(*) AS c FROM mobile_chat_threads`).get()?.c || 0; } catch {}

    const totals = {
      runs: agg.runs || 0,
      success: agg.success || 0,
      error: agg.error || 0,
      premiumRequests: +(agg.premiumRequests || 0).toFixed(4),
      apiDurationMs: agg.apiDurationMs || 0,
      inputTokens: agg.inputTokens || 0,
      outputTokens: agg.outputTokens || 0,
      cacheReadTokens: agg.cacheReadTokens || 0,
      cacheWriteTokens: agg.cacheWriteTokens || 0,
      totalTokens: (agg.inputTokens || 0) + (agg.outputTokens || 0),
      cost: +(((agg.premiumRequests || 0) * rate).toFixed(2)),
    };

    res.json({
      window: { from, to, days },
      rate,
      totals,
      counts: {
        agentRuns: srcCount.agent || 0,
        taskRuns: srcCount.task || 0,
        managerRuns: srcCount.manager || 0,
        chatTurns: srcCount.chat || 0,
        flowsRun,
        totalConversations: spaChats + mobileThreads,
        spaChats,
        mobileThreads,
      },
      bySource: decorate(bySource),
      byModel: decorate(byModel),
      daily: decorate(filledDaily),
      dailyBySource,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sync/status', async (req, res) => {
  try {
    const leaderInfo = configSync.enabled ? await configSync.getLeaderInfo() : null;
    res.json({
      enabled: configSync.enabled,
      isLeader: configSync.isLeader,
      epoch: configSync.epoch,
      machineId: configSync.machineId,
      hostname: require('os').hostname(),
      leaderInfo
    });
  } catch (err) {
    res.json({ enabled: configSync.enabled, isLeader: configSync.isLeader, epoch: configSync.epoch, machineId: configSync.machineId, error: err.message });
  }
});

// Get sync config
app.get('/api/sync/config', (req, res) => {
  res.json(configSync.getSyncConfig());
});

// Update sync config
app.put('/api/sync/config', express.json(), async (req, res) => {
  try {
    const updated = configSync.saveSyncConfig(req.body);
    // Restart sync if storage account changed
    if (req.body.storageAccount) {
      configSync.stop();
      await configSync.start();
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force this machine to become leader
app.post('/api/sync/force-leader', async (req, res) => {
  try {
    const result = await configSync.forceLeader();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all known SPA instances (presence registry) with liveness + leader flag.
app.get('/api/sync/instances', async (req, res) => {
  try {
    res.json(await configSync.listInstances());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request that a specific machine become the leader (remote handoff).
app.post('/api/sync/request-leader', express.json(), async (req, res) => {
  try {
    const { machineId } = req.body || {};
    if (!machineId) return res.status(400).json({ error: 'machineId is required' });
    res.json(await configSync.requestLeader(machineId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push local config to cloud
app.post('/api/sync/push', async (req, res) => {
  try {
    await configSync.pushConfig();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pull config from cloud
app.post('/api/sync/pull', async (req, res) => {
  try {
    await configSync.pullConfig();
    loadAgents();
    loadManagers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Machines (per-machine cloud namespaces) ============

// List all machines that have published a config namespace to the cloud.
app.get('/api/machines', async (req, res) => {
  try {
    if (!configSync.enabled) return res.json({ machines: [], selfId: null });
    const machines = await configSync.listMachines();
    res.json({ machines, selfId: configSync.machineId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detail for a single machine: its published agents/managers catalog.
app.get('/api/machines/:id', async (req, res) => {
  try {
    if (!configSync.enabled) return res.status(400).json({ error: 'Cloud sync is not enabled' });
    const machines = await configSync.listMachines();
    const machine = machines.find(m => m.machineId === req.params.id);
    if (!machine) return res.status(404).json({ error: `Machine ${req.params.id} not found` });
    res.json(machine);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Install one or more agents/managers from another machine into this machine's
// own namespace. items: [{ type: 'agent'|'manager', id }]. Copies any referenced
// plugin directory locally, rewrites pluginDir, dedupes by id, reloads, and pushes
// the updated local namespace to the cloud. Shared by the REST endpoint and the
// mobile protocol handler. Throws Error (with optional .status) on failure.
async function installFromMachine(machineId, items) {
  if (!configSync.enabled) { const e = new Error('Cloud sync is not enabled'); e.status = 400; throw e; }
  if (machineId === configSync.machineId) { const e = new Error('Cannot install from this machine into itself'); e.status = 400; throw e; }
  if (!Array.isArray(items) || !items.length) { const e = new Error('No items specified (expected [{ type, id }])'); e.status = 400; throw e; }

  {
    const snap = await configSync.getMachineSnapshotFiles(machineId).catch(err => {
      if (/No cloud config found/i.test(err.message)) { const e = new Error(err.message); e.status = 404; throw e; }
      throw err;
    });
    const parse = (name) => { try { return JSON.parse(snap.files[name] || 'null'); } catch { return null; } };
    const srcAgents = Array.isArray(parse('agents.json')) ? parse('agents.json') : [];
    const srcManagers = Array.isArray(parse('managers.json')) ? parse('managers.json') : [];
    const pluginFiles = parse('plugins.tar.json') || {};
    const mcpFiles = parse('mcp-configs.tar.json') || {};

    const localAgents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const localManagers = fs.existsSync(MANAGERS_PATH) ? JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8')) : [];
    const localAgentIds = new Set(localAgents.map(a => a.id));
    const localManagerIds = new Set(localManagers.map(m => m.id));
    const results = { installed: [], skipped: [], warnings: [] };

    // Write a plugin directory (by basename) out of the source plugins.tar.json map.
    const installPluginDir = (pluginBase) => {
      if (!pluginBase) return false;
      let count = 0;
      for (const [relPath, content] of Object.entries(pluginFiles)) {
        const top = relPath.split('/')[0];
        if (top !== pluginBase) continue;
        const destPath = path.join(PLUGINS_DIR, relPath.replace(/\//g, path.sep));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
        count++;
      }
      return count > 0;
    };

    const installAgentById = (agentId) => {
      if (localAgentIds.has(agentId)) { results.skipped.push(`agent ${agentId} (already installed)`); return; }
      const src = srcAgents.find(a => a.id === agentId);
      if (!src) { results.warnings.push(`agent ${agentId} not found on source machine`); return; }
      const agent = JSON.parse(JSON.stringify(src));
      delete agent.copilotPath;
      if (agent.pluginDir) {
        const base = path.basename(agent.pluginDir);
        if (installPluginDir(base)) {
          agent.pluginDir = path.join(PLUGINS_DIR, base);
        } else {
          results.warnings.push(`agent ${agentId}: plugin "${base}" not found in source snapshot`);
          agent.pluginDir = path.join(PLUGINS_DIR, base);
        }
      }
      if (agent.cwd && !fs.existsSync(agent.cwd)) {
        results.warnings.push(`agent ${agentId}: cwd does not exist locally (${agent.cwd}) — edit after install`);
      }
      localAgents.push(agent);
      localAgentIds.add(agentId);
      results.installed.push(`agent ${agent.name || agentId}`);
    };

    for (const item of items) {
      if (item.type === 'agent') {
        installAgentById(item.id);
      } else if (item.type === 'manager') {
        if (localManagerIds.has(item.id)) { results.skipped.push(`manager ${item.id} (already installed)`); continue; }
        const src = srcManagers.find(m => m.id === item.id);
        if (!src) { results.warnings.push(`manager ${item.id} not found on source machine`); continue; }
        const manager = JSON.parse(JSON.stringify(src));
        // Pull in the manager's team agents too.
        for (const agentId of (Array.isArray(manager.team) ? manager.team : (Array.isArray(manager.org) ? manager.org : []))) installAgentById(agentId);
        localManagers.push(manager);
        localManagerIds.add(item.id);
        results.installed.push(`manager ${manager.name || item.id}`);
      } else {
        results.warnings.push(`unknown item type: ${item.type}`);
      }
    }

    // Copy any referenced MCP configs (best-effort: install all referenced by installed agents).
    for (const [relPath, content] of Object.entries(mcpFiles)) {
      const destPath = path.join(MCP_CONFIGS_DIR, relPath.replace(/\//g, path.sep));
      try {
        if (fs.existsSync(destPath)) continue;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
      } catch { /* ignore */ }
    }

    if (results.installed.length) {
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(localAgents, null, 2));
      fs.writeFileSync(MANAGERS_PATH, JSON.stringify(localManagers, null, 2));
      loadAgents();
      loadManagers();
      configSync.pushConfig().catch(e => results.warnings.push(`cloud push failed: ${e.message}`));
    }

    return results;
  }
}

app.post('/api/machines/:id/install', express.json(), async (req, res) => {
  try {
    let items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
    if (!items && req.body && req.body.type && req.body.id) items = [{ type: req.body.type, id: req.body.id }];
    const results = await installFromMachine(req.params.id, items);
    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============ Manager API Routes ============

// List all managers
app.get('/api/managers', (req, res) => {
  res.json(managerAgent.getAllStatus());
});

// Get a single manager
app.get('/api/managers/:id', (req, res) => {
  const status = managerAgent.getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Manager not found' });
  res.json(status);
});

// Create or update a manager
app.post('/api/managers', (req, res) => {
  const config = req.body;
  if (!config.id || !config.name) {
    return res.status(400).json({ error: 'Missing required fields: id, name' });
  }
  if (config.team === undefined && Array.isArray(config.org)) config.team = config.org;
  if (!config.team) config.team = [];
  delete config.org;
  if (!config.assignments) config.assignments = [];

  // Save to managers.json
  let managers = [];
  if (fs.existsSync(MANAGERS_PATH)) {
    managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  }
  const existing = managers.findIndex(m => m.id === config.id);
  if (existing >= 0) {
    managers[existing] = config;
  } else {
    managers.push(config);
  }
  fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
  managerAgent.register(config);
  res.json({ ok: true });
});

// Delete a manager
app.delete('/api/managers/:id', (req, res) => {
  managerAgent.stopSchedules(req.params.id);
  let managers = [];
  if (fs.existsSync(MANAGERS_PATH)) {
    managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  }
  managers = managers.filter(m => m.id !== req.params.id);
  fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
  managerAgent.managers.delete(req.params.id);
  res.json({ ok: true });
});

// ===== Teams API =====
// A team groups "employees" (agent ids + manager ids) via memberIds.
// Operations carry a teamId; cross-team operations are not permitted.
// Legacy note: teams were formerly called "organizations" — the /api/organizations
// paths are kept as backward-compatible aliases.

function _employeeExists(id) {
  if (supervisor.agents.has(id)) return true;
  if (managerAgent.managers && managerAgent.managers.has(id)) return true;
  // managers.json fallback (in case runtime map is stale)
  try {
    if (fs.existsSync(MANAGERS_PATH)) {
      const ms = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
      if (ms.some(m => m.id === id)) return true;
    }
  } catch {}
  return false;
}

// List teams
app.get(['/api/teams', '/api/organizations'], (req, res) => {
  res.json(loadTeams());
});

// Get a single team
app.get(['/api/teams/:id', '/api/organizations/:id'], (req, res) => {
  const team = loadTeams().find(o => o.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
});

// Create or update a team
app.post(['/api/teams', '/api/organizations'], (req, res) => {
  const { id, name, emoji, color, description, memberIds, theme } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Missing required field: name' });
  }
  const teams = loadTeams();
  const teamId = id || ('team-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36).slice(-4));
  const existingIdx = teams.findIndex(o => o.id === teamId);
  const base = existingIdx >= 0 ? teams[existingIdx] : { createdAt: new Date().toISOString(), memberIds: [] };
  const team = {
    ...base,
    id: teamId,
    name: String(name).trim(),
    emoji: emoji || base.emoji || '🏢',
    color: color || base.color || '#b11f4b',
    description: description != null ? description : (base.description || ''),
    theme: theme || base.theme || 'default',
    memberIds: Array.isArray(memberIds) ? [...new Set(memberIds.filter(_employeeExists))] : (base.memberIds || []),
    updatedAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) teams[existingIdx] = team; else teams.push(team);
  saveTeams(teams);
  broadcastSSE('teams-changed', { id: teamId });
  res.json({ ok: true, team });
});

// Update a team (partial)
app.put(['/api/teams/:id', '/api/organizations/:id'], (req, res) => {
  const teams = loadTeams();
  const idx = teams.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Team not found' });
  const { name, emoji, color, description, memberIds, theme } = req.body || {};
  const team = teams[idx];
  if (name != null) team.name = String(name).trim();
  if (emoji != null) team.emoji = emoji;
  if (color != null) team.color = color;
  if (description != null) team.description = description;
  if (theme != null) team.theme = theme;
  if (Array.isArray(memberIds)) team.memberIds = [...new Set(memberIds.filter(_employeeExists))];
  team.updatedAt = new Date().toISOString();
  teams[idx] = team;
  saveTeams(teams);
  broadcastSSE('teams-changed', { id: team.id });
  res.json({ ok: true, team });
});

// Delete a team
app.delete(['/api/teams/:id', '/api/organizations/:id'], (req, res) => {
  let teams = loadTeams();
  if (!teams.some(o => o.id === req.params.id)) return res.status(404).json({ error: 'Team not found' });
  teams = teams.filter(o => o.id !== req.params.id);
  saveTeams(teams);
  broadcastSSE('teams-changed', { id: req.params.id, deleted: true });
  res.json({ ok: true });
});

// Add a member (employee) to a team
app.post(['/api/teams/:id/members', '/api/organizations/:id/members'], (req, res) => {
  const { employeeId } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'Missing required field: employeeId' });
  if (!_employeeExists(employeeId)) return res.status(404).json({ error: 'Employee not found' });
  const teams = loadTeams();
  const idx = teams.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Team not found' });
  if (!Array.isArray(teams[idx].memberIds)) teams[idx].memberIds = [];
  if (!teams[idx].memberIds.includes(employeeId)) teams[idx].memberIds.push(employeeId);
  teams[idx].updatedAt = new Date().toISOString();
  saveTeams(teams);
  broadcastSSE('teams-changed', { id: req.params.id });
  res.json({ ok: true, team: teams[idx] });
});

// Remove a member (employee) from a team. The employee's operations
// within this team are disabled (not deleted) by the cascade below.
app.delete(['/api/teams/:id/members/:employeeId', '/api/organizations/:id/members/:employeeId'], (req, res) => {
  const teams = loadTeams();
  const idx = teams.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Team not found' });
  teams[idx].memberIds = (teams[idx].memberIds || []).filter(m => m !== req.params.employeeId);
  teams[idx].updatedAt = new Date().toISOString();
  saveTeams(teams);
  // Cascade: disable (don't delete) this employee's operations in this team so they
  // stay on record but go inert without a valid team context.
  const disabled = disableOperationsForEmployeeInTeam(req.params.employeeId, req.params.id);
  broadcastSSE('teams-changed', { id: req.params.id });
  res.json({ ok: true, team: teams[idx], disabled });
});

// Disable (not delete) every operation tied to this employee within this team.
// Invoked when an employee is removed from a team: tasks the agent owns,
// assignments the manager owns, and flows that reference the agent — all stamped
// with this team — are flipped to enabled:false and unscheduled, preserving the
// record while stopping them from firing without a valid team context.
function disableOperationsForEmployeeInTeam(employeeId, teamId) {
  const result = { tasks: [], assignments: [], flows: [] };
  if (!teamId) return result;
  const opTeam = (x) => (x && (x.teamId !== undefined ? x.teamId : x.orgId)) || null;

  // Tasks: agent-owned and stamped with this team.
  const tasks = loadTasks();
  let tasksChanged = false;
  for (const t of tasks) {
    if (t.agentId === employeeId && opTeam(t) === teamId && t.enabled !== false) {
      t.enabled = false; t.updatedAt = new Date().toISOString();
      try { unscheduleTask(t.id); } catch {}
      tasksChanged = true;
      result.tasks.push({ id: t.id, name: t.name || t.id });
    }
  }
  if (tasksChanged) {
    saveTasks(tasks);
    for (const dt of result.tasks) { const t = tasks.find(x => x.id === dt.id); if (t) broadcastSSE('task-updated', t); }
  }

  // Assignments: an assignment's "employee" is its owning manager.
  const entry = managerAgent.managers.get(employeeId);
  if (entry && Array.isArray(entry.config.assignments)) {
    let assignmentsChanged = false;
    for (const a of entry.config.assignments) {
      if (opTeam(a) === teamId && a.enabled !== false) {
        a.enabled = false; assignmentsChanged = true;
        result.assignments.push({ id: a.id, name: a.name || a.id });
      }
    }
    if (assignmentsChanged) {
      try {
        const managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
        const mi = managers.findIndex(m => m.id === employeeId);
        if (mi >= 0) { managers[mi] = entry.config; fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2)); }
      } catch {}
      try { _restartManagerSchedules(employeeId); } catch {}
    }
  }

  // Flows: stamped with this team and referencing this agent (via a step's task or an AI edge).
  try {
    const allTasks = loadTasks();
    for (const c of chainEngine.list()) {
      if (opTeam(c) !== teamId || c.enabled === false) continue;
      const viaStep = (c.steps || []).some(s => allTasks.some(t => t.agentId === employeeId && (t.id === s.taskId || ('task-' + t.id) === s.taskId)));
      const viaCond = (c.edges || []).some(e => e.condition && e.condition.type === 'ai' && e.condition.agentId === employeeId);
      if (viaStep || viaCond) {
        try { chainEngine.update(c.id, { enabled: false }); result.flows.push({ id: c.id, name: c.name || c.id }); } catch {}
      }
    }
  } catch {}

  return result;
}

// ===================== BOARDS =====================
// A board is a personal pinboard for actively-tracked work. It groups pinned
// references to CLI sessions, chats, tasks, flows, assignments, and agents, plus
// freeform notes and checklists. Boards are team-scoped (teamId) or global (teamId
// null). Stored wholesale in boards.json.
const BOARD_KINDS = ['session', 'chat', 'comment', 'task', 'flow', 'assignment', 'agent', 'manager', 'location'];

function _boardId(name) {
  return 'board-' + String(name || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) + '-' + Date.now().toString(36).slice(-4);
}
function _genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function _normalizeBoard(b) {
  return {
    id: b.id,
    name: b.name,
    emoji: b.emoji || '📌',
    teamId: (b.teamId !== undefined ? b.teamId : b.orgId) || null,
    items: Array.isArray(b.items) ? b.items : [],
    notes: Array.isArray(b.notes) ? b.notes : [],
    checklists: Array.isArray(b.checklists) ? b.checklists : [],
    layout: (b.layout && typeof b.layout === 'object' && !Array.isArray(b.layout)) ? b.layout : {},
    // Stashed items: { '<panelBaseId>': true }. Stashed pins/notes/checklists are hidden
    // from the board grid but still feed the AI context (where-was-i, assistant). Display-only.
    hidden: (b.hidden && typeof b.hidden === 'object' && !Array.isArray(b.hidden)) ? b.hidden : {},
    summary: (b.summary && typeof b.summary === 'object' && !Array.isArray(b.summary)) ? b.summary : null,
    archived: !!b.archived,
    enabled: b.enabled !== false,
    starred: !!b.starred,
    autoWidth: b.autoWidth !== false,
    pinView: !!b.pinView,
    autoArrange: !!b.autoArrange,
    lastViewedAt: b.lastViewedAt || null,
    createdAt: b.createdAt || new Date().toISOString(),
    updatedAt: b.updatedAt || new Date().toISOString(),
  };
}

app.get('/api/boards', (req, res) => {
  res.json(loadBoards().map(_normalizeBoard));
});

app.get('/api/boards/:id', (req, res) => {
  const board = loadBoards().find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(_normalizeBoard(board));
});

// Create a board
app.post('/api/boards', (req, res) => {
  const { name, emoji, teamId, orgId } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Missing required field: name' });
  const boards = loadBoards();
  const board = _normalizeBoard({
    id: _boardId(name),
    name: String(name).trim(),
    emoji: emoji || '📌',
    teamId: (teamId !== undefined ? teamId : orgId) || null,
    items: [], notes: [], checklists: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  boards.push(board);
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: board.id });
  res.json({ ok: true, board });
});

// Update a board (partial: name/emoji/teamId and/or wholesale items/notes/checklists)
app.put('/api/boards/:id', (req, res) => {
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(boards[idx]);
  const { name, emoji, teamId, orgId, items, notes, checklists, layout, archived, enabled, autoWidth, pinView, autoArrange, starred, hidden } = req.body || {};
  if (name != null) b.name = String(name).trim();
  if (emoji != null) b.emoji = emoji;
  const teamScope = teamId !== undefined ? teamId : orgId;
  if (teamScope !== undefined) b.teamId = teamScope || null;
  if (Array.isArray(items)) b.items = items;
  if (Array.isArray(notes)) b.notes = notes;
  if (Array.isArray(checklists)) b.checklists = checklists;
  if (layout && typeof layout === 'object' && !Array.isArray(layout)) b.layout = layout;
  if (hidden && typeof hidden === 'object' && !Array.isArray(hidden)) b.hidden = hidden;
  if (archived !== undefined) b.archived = !!archived;
  if (enabled !== undefined) b.enabled = !!enabled;
  if (starred !== undefined) b.starred = !!starred;
  if (autoWidth !== undefined) b.autoWidth = !!autoWidth;
  if (pinView !== undefined) b.pinView = !!pinView;
  if (autoArrange !== undefined) b.autoArrange = !!autoArrange;
  b.updatedAt = new Date().toISOString();
  boards[idx] = b;
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: b.id });
  res.json({ ok: true, board: b });
});

// Delete a board
app.delete('/api/boards/:id', (req, res) => {
  let boards = loadBoards();
  if (!boards.some(b => b.id === req.params.id)) return res.status(404).json({ error: 'Board not found' });
  boards = boards.filter(b => b.id !== req.params.id);
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: req.params.id, deleted: true });
  res.json({ ok: true });
});

// Pin an item to a board
app.post('/api/boards/:id/items', (req, res) => {
  const { kind, refId, label, sublabel } = req.body || {};
  if (!kind || !BOARD_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  if (!refId) return res.status(400).json({ error: 'Missing refId' });
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(boards[idx]);
  if (b.items.some(it => it.kind === kind && it.refId === refId)) {
    return res.json({ ok: true, board: b, alreadyPinned: true });
  }
  b.items.unshift({ id: _genId('pin'), kind, refId, label: label || refId, sublabel: sublabel || '', addedAt: new Date().toISOString() });
  b.updatedAt = new Date().toISOString();
  boards[idx] = b;
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: b.id });
  res.json({ ok: true, board: b });
});

// Unpin an item from a board
app.delete('/api/boards/:id/items/:itemId', (req, res) => {
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(boards[idx]);
  b.items = b.items.filter(it => it.id !== req.params.itemId);
  b.updatedAt = new Date().toISOString();
  boards[idx] = b;
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: b.id });
  res.json({ ok: true, board: b });
});

// Update a pinned item's metadata (currently: excludeFromSummary toggle). The item
// stays on the board either way; excludeFromSummary only controls whether it feeds
// the "Where was I?" briefing and the insights derived from it.
app.patch('/api/boards/:id/items/:itemId', (req, res) => {
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(boards[idx]);
  const it = b.items.find(x => x.id === req.params.itemId);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  if (req.body && 'excludeFromSummary' in req.body) {
    if (req.body.excludeFromSummary) it.excludeFromSummary = true;
    else delete it.excludeFromSummary;
  }
  b.updatedAt = new Date().toISOString();
  boards[idx] = b;
  saveBoards(boards);
  broadcastSSE('boards-changed', { id: b.id });
  res.json({ ok: true, board: b });
});

// ===================== SOURCE LOCATIONS (folder pins) =====================
// Helpers + endpoints backing the "pin a source location" board feature: derive a
// README summary, open the folder in an editor / CLI / file explorer, and search it.
function _validDir(p) {
  try { const s = fs.statSync(p); return s.isDirectory(); } catch { return false; }
}
// True when the folder is (or sits inside) a git repo. A worktree/submodule uses a
// .git file rather than a directory, so accept either; walk up to catch subfolders.
function _isGitRepo(p) {
  try {
    let dir = path.resolve(p);
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return false;
}
// Current git branch for a folder (or the repo it sits in), or '' if not a repo /
// indeterminable. Reads .git/HEAD directly (no shelling out): a normal repo has a
// .git directory; a worktree/submodule has a .git FILE containing "gitdir: <path>".
// HEAD is either "ref: refs/heads/<branch>" or a raw SHA when detached.
function _gitBranch(p) {
  try {
    let dir = path.resolve(p), gitPath = null;
    for (let i = 0; i < 40; i++) {
      const cand = path.join(dir, '.git');
      if (fs.existsSync(cand)) { gitPath = cand; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitPath) return '';
    let gitDir = gitPath;
    const st = fs.statSync(gitPath);
    if (st.isFile()) {
      const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)\s*/);
      if (!m) return '';
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1].trim();
    return head.length >= 7 ? `(detached @ ${head.slice(0, 8)})` : '';
  } catch { return ''; }
}
// Directories we never descend into when summarizing / searching a source folder.
const FS_SKIP_DIRS = new Set(['.git', 'node_modules', '.vs', '.vscode', 'bin', 'obj', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'packages']);

// Brief summary of a folder, sourced from its README when present.
app.post('/api/fs/folder-summary', (req, res) => {
  const dir = String((req.body && req.body.path) || '').trim();
  if (!dir) return res.status(400).json({ error: 'path required' });
  if (!_validDir(dir)) return res.status(404).json({ error: 'Folder not found', path: dir });
  const rs = _readmeSummary(dir, 320);
  res.json({ ok: true, path: dir, name: path.basename(dir.replace(/[\\/]+$/, '')) || dir, summary: rs.summary, hasReadme: rs.hasReadme, readmePath: rs.readmePath, isGit: _isGitRepo(dir) });
});

// List immediate child directories of a path, for the source-location folder
// browser. With no path (or path === ''), returns the available roots — drive
// letters on Windows plus a few convenient starting points (home, repos). Files
// are omitted; we only browse folders since a pinned location is always a folder.
app.post('/api/fs/list', (req, res) => {
  const raw = String((req.body && req.body.path) || '').trim();
  try {
    // Root view: drives + handy shortcuts.
    if (!raw) {
      const roots = [];
      const seen = new Set();
      const add = (p, label) => {
        if (!p || seen.has(p) || !_validDir(p)) return;
        seen.add(p);
        roots.push({ name: label || p, path: p, isGit: false });
      };
      if (process.platform === 'win32') {
        for (let c = 67 /* C */; c <= 90 /* Z */; c++) {
          const drive = String.fromCharCode(c) + ':\\';
          if (_validDir(drive)) roots.push({ name: drive, path: drive, isGit: false, drive: true });
        }
        add(process.env.USERPROFILE, '🏠 ' + (process.env.USERNAME || 'Home'));
        add(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'repos') : '', '📦 repos');
        add('C:\\repos', '📦 C:\\repos');
      } else {
        add(process.env.HOME, '🏠 Home');
        add('/', '/');
      }
      return res.json({ ok: true, path: '', parent: null, dirs: roots });
    }
    if (!_validDir(raw)) return res.status(404).json({ error: 'Folder not found', path: raw });
    const dir = path.resolve(raw);
    const parentDir = path.dirname(dir);
    const parent = parentDir && parentDir !== dir ? parentDir : '';
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      return res.status(403).json({ error: 'Cannot read folder', path: dir });
    }
    const dirs = entries
      .filter(e => { try { return e.isDirectory(); } catch { return false; } })
      .map(e => e.name)
      .filter(name => !name.startsWith('$') && name !== 'node_modules')
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 500)
      .map(name => {
        const full = path.join(dir, name);
        return { name, path: full, hidden: name.startsWith('.'), isGit: fs.existsSync(path.join(full, '.git')) };
      });
    res.json({ ok: true, path: dir, parent, isGit: _isGitRepo(dir), dirs });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'list failed' });
  }
});

// Open a folder in an editor (VS Code Insiders → VS Code), a Copilot CLI session, or
// the OS file explorer.
app.post('/api/fs/open', (req, res) => {
  const dir = String((req.body && req.body.path) || '').trim();
  const target = String((req.body && req.body.target) || 'editor').trim();
  if (!dir) return res.status(400).json({ error: 'path required' });
  if (!_validDir(dir)) return res.status(404).json({ error: 'Folder not found', path: dir });
  const { spawn, spawnSync, exec } = require('child_process');
  try {
    if (target === 'explorer') {
      // explorer returns exit code 1 even on success; ignore it.
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return res.json({ ok: true, target });
    }
    if (target === 'cli') {
      const copilotCmd = process.env.COPILOT_PATH || 'copilot';
      const copilotIsPath = /[\\/:]/.test(copilotCmd);
      const guardLines = copilotIsPath
        ? [`if not exist "${copilotCmd}" goto nocopilot`]
        : [`where "${copilotCmd}" >nul 2>&1`, 'if errorlevel 1 goto nocopilot'];
      const batContent = [
        '@echo off',
        `if not exist "${dir}" goto nodir`,
        `cd /d "${dir}"`,
        ...guardLines,
        `"${copilotCmd}" --yolo`,
        'pause', 'exit /b 0',
        ':nodir', `echo ERROR: Working directory not found: ${dir}`, 'pause', 'exit /b 1',
        ':nocopilot', 'echo ERROR: copilot not found in PATH', 'echo PATH=%PATH%', 'pause', 'exit /b 1',
      ].join('\r\n');
      const batPath = path.join(__dirname, `temp-loc-cli-${Date.now().toString(36)}.bat`);
      fs.writeFileSync(batPath, batContent);
      exec(`start "Copilot Session" "${batPath}"`);
      return res.json({ ok: true, target });
    }
    // default: editor
    const insiders = spawnSync('where', ['code-insiders'], { shell: true, encoding: 'utf-8' });
    const editor = insiders.status === 0 ? 'code-insiders' : 'code';
    spawn(editor, [dir], { shell: true, detached: true, stdio: 'ignore' }).unref();
    return res.json({ ok: true, target, editor });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'open failed' });
  }
});

// Search a pinned source folder for a text query. Prefers ripgrep; falls back to a
// bounded Node recursive scan. Returns file/line/snippet matches.
function _fsSearchNode(root, query, maxMatches) {
  const ql = query.toLowerCase();
  const matches = [];
  let scanned = 0;
  const walk = (dir, depth) => {
    if (matches.length >= maxMatches || depth > 12 || scanned > 20000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (matches.length >= maxMatches) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (FS_SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        scanned++;
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (st.size > 1_500_000) continue; // skip large/binary
        let txt; try { txt = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (txt.indexOf('\u0000') !== -1) continue; // binary
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(ql)) {
            matches.push({ file: path.relative(root, full), line: i + 1, text: lines[i].trim().slice(0, 240) });
            if (matches.length >= maxMatches) return;
          }
        }
      }
    }
  };
  walk(root, 0);
  return matches;
}
// Synchronous "search a folder" used by both the manual /api/fs/search endpoint,
// the confirm-gated /assistant/search, and the board assistant's automatic search.
// Prefers ripgrep, falls back to a bounded Node scan. Returns file/line/snippet rows.
function _locationSearch(dir, query, maxMatches = 80) {
  const { spawnSync } = require('child_process');
  try {
    const rg = spawnSync('rg', ['--no-heading', '--line-number', '--color', 'never', '-i', '--max-count', '3', '-m', String(maxMatches), '--', query, dir], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    if (rg.status === 0 || rg.status === 1) {
      const matches = [];
      for (const ln of String(rg.stdout || '').split(/\r?\n/)) {
        if (!ln || matches.length >= maxMatches) break;
        const m = ln.match(/^(.*?):(\d+):(.*)$/);
        if (m) matches.push({ file: path.relative(dir, m[1]), line: parseInt(m[2], 10), text: m[3].trim().slice(0, 240) });
      }
      return matches;
    }
  } catch {}
  return _fsSearchNode(dir, query, maxMatches);
}
app.post('/api/fs/search', (req, res) => {
  const dir = String((req.body && req.body.path) || '').trim();
  const query = String((req.body && req.body.query) || '').trim();
  const maxMatches = Math.min(Math.max(parseInt((req.body && req.body.max), 10) || 60, 1), 200);
  if (!dir || !query) return res.status(400).json({ error: 'path and query required' });
  if (!_validDir(dir)) return res.status(404).json({ error: 'Folder not found', path: dir });
  const { spawnSync } = require('child_process');
  // Try ripgrep first (fast, respects .gitignore, skips binary).
  try {
    const args = ['--no-heading', '--line-number', '--color', 'never', '-i', '--max-count', '3', '-m', String(maxMatches), '--', query, dir];
    const rg = spawnSync('rg', args, { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    if (rg.status === 0 || rg.status === 1) {
      const matches = [];
      for (const ln of String(rg.stdout || '').split(/\r?\n/)) {
        if (!ln || matches.length >= maxMatches) break;
        // <file>:<line>:<text>
        const m = ln.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        matches.push({ file: path.relative(dir, m[1]), line: parseInt(m[2], 10), text: m[3].trim().slice(0, 240) });
      }
      return res.json({ ok: true, engine: 'rg', query, count: matches.length, truncated: matches.length >= maxMatches, matches });
    }
  } catch {}
  // Fallback: Node scan.
  try {
    const matches = _fsSearchNode(dir, query, maxMatches);
    return res.json({ ok: true, engine: 'node', query, count: matches.length, truncated: matches.length >= maxMatches, matches });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'search failed' });
  }
});


// team for the board to be usable. An item belongs when:
//   - operation (task/flow/assignment): its own teamId === board.teamId AND each
//     of its component employees (the agent a task runs, the manager owning an
//     assignment, every agent a flow references) is a member of the team.
//   - employee pin (agent/manager): the employee is a member of the team.
//   - chat/comment: the chat's target employee is a member of the team.
//   - session/note/checklist: always compliant.
// Boards with no team, or whose team was deleted, are never blocked. Pins whose
// underlying item no longer exists are skipped (not a team problem). When any
// item is non-compliant the board is "blocked" in the UI until resolved.

function _teamById(id) { return loadTeams().find(t => t.id === id) || null; }
function _teamName(id) { const t = _teamById(id); return t ? (t.name || id) : (id || null); }
function _employeeNameOf(id) {
  const a = supervisor.agents.get(id); if (a) return a.config.name || a.config.agent || id;
  const m = managerAgent.managers.get(id); if (m) return (m.config && m.config.name) || id;
  try { if (fs.existsSync(MANAGERS_PATH)) { const ms = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8')); const mm = ms.find(x => x.id === id); if (mm) return mm.name || id; } } catch {}
  return id;
}
function _opTeamOf(x) { return (x && (x.teamId !== undefined ? x.teamId : x.orgId)) || null; }
function _findTaskByRef(refId) {
  const tasks = loadTasks();
  const rawId = String(refId).replace(/^task-/, '');
  return tasks.find(x => x.id === rawId || ('task-' + x.id) === refId || x.id === refId) || null;
}
function _findAssignmentByRef(refId) {
  const m = String(refId).match(/^assignment-(.+)-([^-]+)$/);
  if (!m) return null;
  const managerId = m[1], assignmentId = m[2];
  const entry = managerAgent.managers.get(managerId);
  if (!entry) return null;
  const assignment = (entry.config.assignments || []).find(a => a.id === assignmentId);
  if (!assignment) return null;
  return { managerId, assignmentId, assignment, entry };
}
function _chatTargetEmployeeOf(refId, kind) {
  let chatId = String(refId);
  if (kind === 'comment') { const i = chatId.indexOf('~'); if (i >= 0) chatId = chatId.slice(0, i); }
  try { const cf = path.join(CHATS_DIR, `${chatId}.json`); if (fs.existsSync(cf)) { const c = JSON.parse(fs.readFileSync(cf, 'utf-8')); return c.target || null; } } catch {}
  return null;
}
// The "component employees" an operation depends on (must be team members too).
function _opComponentEmployees(item) {
  const out = [];
  if (item.kind === 'task') {
    const t = _findTaskByRef(item.refId);
    if (t && t.agentId) out.push({ employeeId: t.agentId, role: 'agent' });
  } else if (item.kind === 'assignment') {
    const a = _findAssignmentByRef(item.refId);
    if (a) out.push({ employeeId: a.managerId, role: 'manager' });
  } else if (item.kind === 'flow') {
    let c = null; try { c = chainEngine.get(item.refId); } catch {}
    if (c) {
      const tasks = loadTasks();
      const set = new Set();
      for (const s of (c.steps || [])) { const t = tasks.find(t => t.id === s.taskId || ('task-' + t.id) === s.taskId); if (t && t.agentId) set.add(t.agentId); }
      for (const e of (c.edges || [])) { if (e.condition && e.condition.type === 'ai' && e.condition.agentId) set.add(e.condition.agentId); }
      for (const id of set) out.push({ employeeId: id, role: 'agent' });
    }
  }
  return out;
}

function computeBoardCompliance(boardRaw) {
  const b = _normalizeBoard(boardRaw);
  const teamId = b.teamId;
  if (!teamId) return { boardId: b.id, teamId: null, teamName: null, ok: true, blocked: false, issues: [] };
  const team = _teamById(teamId);
  if (!team) return { boardId: b.id, teamId, teamName: null, ok: true, blocked: false, issues: [] };
  const teamName = team.name || teamId;
  const members = new Set(team.memberIds || []);
  const inTeam = (id) => members.has(id);
  const OP_KINDS = new Set(['task', 'assignment', 'flow']);
  const EMP_KINDS = new Set(['agent', 'manager']);
  const EMP_ACTIONS = ['add_member', 'move_member'];
  const issues = [];

  for (const it of b.items) {
    const problems = [];
    if (OP_KINDS.has(it.kind)) {
      let opTeam = null, found = false;
      if (it.kind === 'task') { const t = _findTaskByRef(it.refId); if (t) { found = true; opTeam = _opTeamOf(t); } }
      else if (it.kind === 'assignment') { const a = _findAssignmentByRef(it.refId); if (a) { found = true; opTeam = _opTeamOf(a.assignment); } }
      else if (it.kind === 'flow') { let c = null; try { c = chainEngine.get(it.refId); } catch {} if (c) { found = true; opTeam = _opTeamOf(c); } }
      if (!found) continue; // unresolved pin — not a team problem
      if (opTeam !== teamId) {
        problems.push({ kind: 'op_team', opKind: it.kind, currentTeamId: opTeam, currentTeamName: opTeam ? _teamName(opTeam) : null, actions: ['clone_op', 'move_op'] });
      }
      for (const ce of _opComponentEmployees(it)) {
        if (!inTeam(ce.employeeId)) problems.push({ kind: 'employee', role: ce.role, employeeId: ce.employeeId, employeeName: _employeeNameOf(ce.employeeId), component: true, actions: EMP_ACTIONS });
      }
    } else if (EMP_KINDS.has(it.kind)) {
      if (!_employeeExists(it.refId)) continue;
      if (!inTeam(it.refId)) problems.push({ kind: 'employee', role: it.kind === 'manager' ? 'manager' : 'agent', employeeId: it.refId, employeeName: _employeeNameOf(it.refId), actions: EMP_ACTIONS });
    } else if (it.kind === 'chat' || it.kind === 'comment') {
      const target = _chatTargetEmployeeOf(it.refId, it.kind);
      if (!target) continue;
      if (!inTeam(target)) problems.push({ kind: 'employee', role: 'agent', employeeId: target, employeeName: _employeeNameOf(target), viaChat: true, actions: EMP_ACTIONS });
    }
    if (problems.length) issues.push({ itemId: it.id, kind: it.kind, refId: it.refId, label: it.label || it.refId, sublabel: it.sublabel || '', problems, canRemove: true });
  }
  const blocked = issues.length > 0;
  return { boardId: b.id, teamId, teamName, ok: !blocked, blocked, issues };
}

// ---- compliance mutation helpers ----
function _persistManagerConfig(managerId, config) {
  try {
    const managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === managerId);
    if (mi >= 0) { managers[mi] = config; fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2)); }
  } catch {}
}
function _addEmployeeToTeam(teamId, employeeId) {
  const teams = loadTeams();
  const idx = teams.findIndex(t => t.id === teamId);
  if (idx < 0) return false;
  if (!Array.isArray(teams[idx].memberIds)) teams[idx].memberIds = [];
  if (!teams[idx].memberIds.includes(employeeId)) teams[idx].memberIds.push(employeeId);
  teams[idx].updatedAt = new Date().toISOString();
  saveTeams(teams);
  broadcastSSE('teams-changed', { id: teamId });
  return true;
}
// Move = remove the employee from every OTHER team (with the same disable cascade
// used by the members DELETE route), then add to the target team.
function _moveEmployeeToTeam(teamId, employeeId) {
  const teams = loadTeams();
  const removedFrom = [];
  for (const t of teams) {
    if (t.id !== teamId && (t.memberIds || []).includes(employeeId)) {
      t.memberIds = t.memberIds.filter(m => m !== employeeId);
      t.updatedAt = new Date().toISOString();
      removedFrom.push(t.id);
    }
  }
  const tgt = teams.find(t => t.id === teamId);
  if (tgt) { if (!Array.isArray(tgt.memberIds)) tgt.memberIds = []; if (!tgt.memberIds.includes(employeeId)) tgt.memberIds.push(employeeId); tgt.updatedAt = new Date().toISOString(); }
  saveTeams(teams);
  for (const tid of removedFrom) { try { disableOperationsForEmployeeInTeam(employeeId, tid); } catch {} broadcastSSE('teams-changed', { id: tid }); }
  broadcastSSE('teams-changed', { id: teamId });
  return true;
}
// Re-stamp an operation's team globally (changes the op everywhere it appears).
function _moveOpToTeam(item, teamId) {
  if (item.kind === 'task') {
    const t = _findTaskByRef(item.refId); if (!t) return { ok: false, error: 'Task not found' };
    const tasks = loadTasks(); const idx = tasks.findIndex(x => x.id === t.id);
    tasks[idx].teamId = teamId || null; tasks[idx].updatedAt = new Date().toISOString();
    saveTasks(tasks); try { scheduleTask(tasks[idx]); } catch {}
    broadcastSSE('task-updated', tasks[idx]);
    return { ok: true };
  }
  if (item.kind === 'flow') {
    try { chainEngine.update(item.refId, { teamId: teamId || null }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }
  if (item.kind === 'assignment') {
    const a = _findAssignmentByRef(item.refId); if (!a) return { ok: false, error: 'Assignment not found' };
    a.assignment.teamId = teamId || null;
    _persistManagerConfig(a.managerId, a.entry.config);
    try { _restartManagerSchedules(a.managerId); } catch {}
    return { ok: true };
  }
  return { ok: false, error: 'Not an operation' };
}
// Create a team-scoped duplicate of an operation; returns the new pin refId so the
// caller can re-point the pin (the original op is left untouched).
function _cloneOpToTeam(item, teamId) {
  const suffix = _teamName(teamId) || 'team';
  if (item.kind === 'task') {
    const t = _findTaskByRef(item.refId); if (!t) return { ok: false, error: 'Task not found' };
    const tasks = loadTasks();
    const base = t.name || 'task';
    let name = `${base} (${suffix})`, n = 2;
    while (tasks.some(x => String(x.name).toLowerCase() === name.toLowerCase())) name = `${base} (${suffix} ${n++})`;
    const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const clone = { id: newId, name, agentId: t.agentId, prompt: t.prompt || '', schedule: t.schedule || 'never', enabled: t.enabled !== false, teamId: teamId || null, createdAt: new Date().toISOString() };
    tasks.push(clone); saveTasks(tasks); try { scheduleTask(clone); } catch {}
    broadcastSSE('task-created', clone);
    return { ok: true, newRefId: `task-${newId}` };
  }
  if (item.kind === 'flow') {
    let c = null; try { c = chainEngine.get(item.refId); } catch {}
    if (!c) return { ok: false, error: 'Flow not found' };
    const newId = 'chain-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const clone = { id: newId, name: `${c.name} (${suffix})`, description: c.description || '', teamId: teamId || null, schedule: c.schedule || 'never', enabled: c.enabled !== false, steps: (c.steps || []).map(s => ({ ...s })), edges: (c.edges || []).map(e => ({ ...e })) };
    try { chainEngine.create(clone); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, newRefId: newId };
  }
  if (item.kind === 'assignment') {
    const a = _findAssignmentByRef(item.refId); if (!a) return { ok: false, error: 'Assignment not found' };
    const src = a.assignment;
    const newAid = 'assign-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const clone = { id: newAid, name: `${src.name} (${suffix})`, prompt: src.prompt, schedule: src.schedule || 'never', enabled: src.enabled !== false, teamId: teamId || null };
    if (!a.entry.config.assignments) a.entry.config.assignments = [];
    a.entry.config.assignments.push(clone);
    _persistManagerConfig(a.managerId, a.entry.config);
    try { _restartManagerSchedules(a.managerId); } catch {}
    return { ok: true, newRefId: `assignment-${a.managerId}-${newAid}` };
  }
  return { ok: false, error: 'Not an operation' };
}

// Compliance for a single board.
app.get('/api/boards/:id/compliance', (req, res) => {
  const board = loadBoards().find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(computeBoardCompliance(board));
});

// Resolve a single migration action, then return refreshed compliance.
app.post('/api/boards/:id/migrate', (req, res) => {
  const { itemId, action, employeeId } = req.body || {};
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(boards[idx]);
  if (!b.teamId) return res.status(400).json({ error: 'Board has no team' });
  const item = b.items.find(it => it.id === itemId);
  if (!item) return res.status(404).json({ error: 'Pinned item not found' });
  let changedBoard = false;
  try {
    if (action === 'remove_pin') {
      b.items = b.items.filter(it => it.id !== itemId); changedBoard = true;
    } else if (action === 'add_member') {
      if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
      _addEmployeeToTeam(b.teamId, employeeId);
    } else if (action === 'move_member') {
      if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
      _moveEmployeeToTeam(b.teamId, employeeId);
    } else if (action === 'move_op') {
      const r = _moveOpToTeam(item, b.teamId); if (!r.ok) return res.status(400).json({ error: r.error || 'move failed' });
    } else if (action === 'clone_op') {
      const r = _cloneOpToTeam(item, b.teamId); if (!r.ok) return res.status(400).json({ error: r.error || 'clone failed' });
      item.refId = r.newRefId; changedBoard = true;
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (changedBoard) {
    b.updatedAt = new Date().toISOString();
    boards[idx] = b; saveBoards(boards); broadcastSSE('boards-changed', { id: b.id });
  }
  const compliance = computeBoardCompliance(b);
  res.json({ ok: true, board: b, compliance });
});

// "Where was I" — summarize the most recent state across a board's pinned items.
// Best-effort, deterministic (no LLM): resolves each pinned reference to its
// latest activity and returns items sorted by recency plus a text digest.
// Resolve a board's pinned items into (a) per-item digests `out` for the UI list
// and (b) richer per-item `contextBlocks` (transcripts / run output / messages)
// fed to the LLM for the "Where was I?" briefing.
// ---- Pinned source-location (folder) helpers ----
// A location pin's refId is an absolute folder path. We surface a brief summary
// derived from a README in that folder (if present) and let the board/assistant
// open, search, and reason about the folder's contents.
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];
function _findReadme(dir) {
  try {
    for (const n of README_NAMES) { const p = path.join(dir, n); if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
    // Case-insensitive fallback for odd casings.
    const entries = fs.readdirSync(dir);
    const hit = entries.find(e => /^readme(\.(md|markdown|rst|txt))?$/i.test(e));
    if (hit) { const p = path.join(dir, hit); if (fs.statSync(p).isFile()) return p; }
  } catch {}
  return null;
}
// Strip markdown/badge noise and pull the first meaningful prose paragraph.
function _readmeSummary(dir, maxLen = 280) {
  const rp = _findReadme(dir);
  if (!rp) return { summary: '', readmePath: null, hasReadme: false };
  let raw = '';
  try { raw = fs.readFileSync(rp, 'utf-8'); } catch { return { summary: '', readmePath: rp, hasReadme: true }; }
  const lines = raw.split(/\r?\n/);
  const para = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { if (para.length) break; else continue; }
    if (/^#{1,6}\s/.test(t)) { if (para.length) break; else continue; } // heading
    if (/^!\[/.test(t) || /^\[!\[/.test(t)) continue;                    // badge/image line
    if (/^[-=*_]{3,}$/.test(t)) continue;                                // hr
    if (/^<.*>$/.test(t)) continue;                                      // bare html
    para.push(t);
    if (para.join(' ').length > maxLen * 1.5) break;
  }
  let summary = para.join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links → text
    .replace(/[`*_>#]+/g, '')                       // md punctuation
    .replace(/\s+/g, ' ').trim();
  if (summary.length > maxLen) summary = summary.slice(0, maxLen - 1).trimEnd() + '…';
  return { summary, readmePath: rp, hasReadme: true };
}

function _resolveBoardItems(b, opts = {}) {
  // When forSummary is set, items the user flagged with excludeFromSummary are
  // skipped entirely — they stay pinned on the board but contribute nothing to the
  // "Where was I?" briefing or the cross-board insights derived from it.
  const forSummary = !!opts.forSummary;
  const out = [];
  const contextBlocks = [];
  const tasks = loadTasks();
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  for (const it of b.items) {
    if (forSummary && it.excludeFromSummary) continue;
    let when = it.addedAt || null, status = '', detail = '', route = '', context = '';
    try {
      if (it.kind === 'agent') {
        route = '#/agents/' + encodeURIComponent(it.refId);
        const runs = supervisor.getRunHistory(it.refId, 1) || [];
        if (runs[0]) { when = runs[0].finished_at || runs[0].started_at || when; status = runs[0].exit_code === 0 ? 'success' : (runs[0].status || 'error'); detail = clip(runs[0].output || runs[0].error || '', 240); context = clip(runs[0].output || runs[0].error || '', 1200); }
      } else if (it.kind === 'task') {
        route = '#/tasks/' + encodeURIComponent(it.refId);
        const rawId = String(it.refId).replace(/^task-/, '');
        const t = tasks.find(x => x.id === rawId || ('task-' + x.id) === it.refId);
        if (t) {
          const runs = (supervisor.getRunHistory(t.agentId, 10) || []).filter(r => !r.task_id || r.task_id === t.id);
          const r0 = runs[0];
          if (r0) { when = r0.finished_at || r0.started_at || when; status = r0.exit_code === 0 ? 'success' : (r0.status || 'error'); detail = clip(r0.output || r0.error || '', 240); context = clip(r0.output || r0.error || '', 1200); }
          else { status = t.enabled === false ? 'disabled' : 'idle'; }
        }
      } else if (it.kind === 'assignment') {
        route = '#/assignments/' + encodeURIComponent(it.refId);
        const m = String(it.refId).match(/^assignment-(.+)-([^-]+)$/);
        if (m) {
          const managerId = m[1], assignmentId = m[2];
          const runs = (managerAgent.getRunHistory(managerId, 20) || []).filter(r => !r.assignment_id || r.assignment_id === assignmentId);
          const r0 = runs[0];
          if (r0) { when = r0.finished_at || r0.started_at || when; status = r0.status || (r0.error ? 'error' : 'success'); detail = clip(r0.result || r0.error || '', 240); context = clip(r0.result || r0.error || '', 1200); }
        }
      } else if (it.kind === 'flow') {
        route = '#/chains/' + encodeURIComponent(it.refId);
        try { const c = chainEngine.get(it.refId); if (c) { status = c.enabled === false ? 'disabled' : 'idle'; if (c.lastRunAt) when = c.lastRunAt; detail = c.description || ''; context = clip(c.description || '', 600); } } catch {}
      } else if (it.kind === 'manager') {
        route = '#/managers/' + encodeURIComponent(it.refId);
        const runs = managerAgent.getRunHistory(it.refId, 1) || [];
        if (runs[0]) { when = runs[0].finished_at || runs[0].started_at || when; status = runs[0].status || 'idle'; detail = clip(runs[0].result || runs[0].error || '', 240); context = clip(runs[0].result || runs[0].error || '', 1200); }
      } else if (it.kind === 'chat') {
        route = '#/chat/' + encodeURIComponent(it.refId);
        const cf = path.join(CHATS_DIR, `${it.refId}.json`);
        if (fs.existsSync(cf)) {
          try {
            const c = JSON.parse(fs.readFileSync(cf, 'utf-8'));
            when = c.updatedAt || when;
            const msgs = c.messages || [];
            const last = msgs[msgs.length - 1];
            if (last) { status = last.role; detail = clip(last.content || '', 240); }
            context = msgs.slice(-6).map(mm => (mm.role === 'assistant' ? 'ASSISTANT: ' : 'USER: ') + clip(mm.content || '', 500)).join('\n').slice(0, 2000);
          } catch {}
        }
      } else if (it.kind === 'comment') {
        // A pinned comment: refId is "<chatId>~<messageTimestamp>". Locate the exact
        // message and surround it with a few neighbouring turns so the summary/assistant
        // has the conversational context around the pinned remark.
        const sep = String(it.refId).indexOf('~');
        const chatId = sep < 0 ? String(it.refId) : String(it.refId).slice(0, sep);
        const stamp = sep < 0 ? '' : String(it.refId).slice(sep + 1);
        route = '#/chat/' + encodeURIComponent(chatId);
        const cf = path.join(CHATS_DIR, `${chatId}.json`);
        if (fs.existsSync(cf)) {
          try {
            const c = JSON.parse(fs.readFileSync(cf, 'utf-8'));
            const msgs = Array.isArray(c.messages) ? c.messages : [];
            let idx = stamp ? msgs.findIndex(m => m.timestamp === stamp) : -1;
            if (idx < 0 && msgs.length) idx = msgs.length - 1; // fall back to the latest
            if (idx >= 0) {
              const pinned = msgs[idx];
              when = pinned.timestamp || c.updatedAt || when;
              status = pinned.role || 'comment';
              detail = clip(pinned.content || '', 240);
              const start = Math.max(0, idx - 3), end = Math.min(msgs.length, idx + 3);
              const lines = [];
              for (let i = start; i < end; i++) {
                const mm = msgs[i];
                const who = mm.role === 'assistant' ? 'ASSISTANT' : 'USER';
                const mark = i === idx ? ' «PINNED»' : '';
                // The pinned message is the point of interest — include it in full so the
                // board assistant sees the same complete comment the board now displays;
                // neighbouring turns stay clipped for context only.
                const body = i === idx ? clip(mm.content || '', 6000) : clip(mm.content || '', 500);
                lines.push(`${who}${mark}: ${body}`);
              }
              context = lines.join('\n').slice(0, 6000);
            }
          } catch {}
        }
      } else if (it.kind === 'location') {
        // A pinned source folder. Status reflects whether the path still exists;
        // the README summary feeds both the card and the AI context so the board
        // assistant knows what lives there (and can be asked to search it).
        const dir = String(it.refId);
        try {
          if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            status = 'location';
            try { when = new Date(fs.statSync(dir).mtimeMs).toISOString(); } catch {}
            const rs = _readmeSummary(dir, 600);
            detail = rs.summary ? clip(rs.summary, 240) : clip(it.sublabel || '', 240);
            context = (rs.summary ? rs.summary : 'A pinned source folder (no README found).')
              + `\n(path: ${dir}${rs.hasReadme ? '' : ' — no README'})`;
          } else {
            status = 'missing';
            detail = 'Folder not found';
            context = `Pinned folder no longer exists: ${dir}`;
          }
        } catch {}
      } else if (it.kind === 'session') {
        route = '#/sessions';
        try {
          const dir = path.join(SESSION_STATE_DIR, it.refId);
          if (fs.existsSync(dir)) {
            const ep = path.join(dir, 'events.jsonl');
            try { when = new Date(fs.statSync(ep).mtimeMs).toISOString(); } catch { try { when = new Date(fs.statSync(dir).mtimeMs).toISOString(); } catch {} }
            status = 'session';
            const sp = path.join(dir, SPA_SUMMARY_FILE);
            try { if (fs.existsSync(sp)) detail = clip(JSON.parse(fs.readFileSync(sp, 'utf-8')).summary || '', 240); } catch {}
            // Build a multi-turn transcript for the LLM (last 8 turns), falling back
            // to a raw events.jsonl scan for agent-run sessions whose prompts arrive
            // via file (so readSessionConversation yields no turns).
            const tl = [];
            try {
              const conv = readSessionConversation(dir);
              for (const t of (conv.turns || []).slice(-8)) {
                if (t.content) tl.push('USER: ' + clip(t.content, 500));
                if (t.assistant) tl.push('ASSISTANT: ' + clip(t.assistant, 500));
              }
            } catch {}
            if (!tl.length && fs.existsSync(ep)) {
              try {
                let agentName = '';
                const tools = [];
                for (const ln of fs.readFileSync(ep, 'utf-8').split('\n')) {
                  if (!ln) continue;
                  let ev; try { ev = JSON.parse(ln); } catch { continue; }
                  const d = ev.data || {};
                  if (ev.type === 'user.message' && d.content) tl.push('USER: ' + clip(d.content, 500));
                  else if (ev.type === 'assistant.message' && d.content) tl.push('ASSISTANT: ' + clip(d.content, 500));
                  else if (ev.type === 'subagent.selected' && (d.agentDisplayName || d.agentName)) agentName = d.agentDisplayName || d.agentName;
                  else if (ev.type === 'session.start' && d.context && d.context.agentName && !agentName) agentName = d.context.agentName;
                  else if (ev.type === 'tool.execution_start' && d.toolName) tools.push(d.toolName);
                }
                if (!tl.length && agentName) {
                  const counts = {};
                  for (const t of tools) counts[t] = (counts[t] || 0) + 1;
                  const topt = Object.entries(counts).sort((a, c) => c[1] - a[1]).slice(0, 8).map(([k, v]) => v > 1 ? `${k}×${v}` : k);
                  tl.push('AGENT: ' + agentName + (topt.length ? ' — used ' + topt.join(', ') : ''));
                }
                while (tl.length > 16) tl.shift();
              } catch {}
            }
            if (!detail && tl.length) {
              for (let i = tl.length - 1; i >= 0; i--) { if (tl[i].startsWith('ASSISTANT: ')) { detail = clip(tl[i].slice(11), 240); break; } }
              if (!detail) detail = clip(tl[tl.length - 1], 240);
            }
            context = tl.join('\n').slice(0, 2400);
          }
        } catch {}
      }
    } catch {}
    out.push({ id: it.id, kind: it.kind, refId: it.refId, label: it.label, sublabel: it.sublabel, route, when, status, detail });
    if (context) contextBlocks.push(`### ${String(it.kind).toUpperCase()}: ${it.label || it.refId}${route ? ` [source link: ${route}]` : ''}\n${context}`);
  }
  out.sort((a, c) => new Date(c.when || 0) - new Date(a.when || 0));
  return { out, contextBlocks };
}

// AI-powered "Where was I?" briefing. Reviews the recent conversation/run context
// of every pinned item and produces a short prose summary + optional next steps.
// The result is cached on board.summary; a <30s cache is served unless {force:true}.
app.post('/api/boards/:id/where-was-i', async (req, res) => {
  const raw = loadBoards().find(b => b.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(raw);
  const force = !!(req.body && req.body.force);

  if (!force && b.summary && b.summary.generatedAt) {
    const age = Date.now() - new Date(b.summary.generatedAt).getTime();
    if (age >= 0 && age < 30000) {
      return res.json({ ok: true, generatedAt: b.summary.generatedAt, summary: b.summary.text, items: b.summary.items || [], deltas: b.summary.deltas || [], cached: true });
    }
  }

  const { out, contextBlocks } = _resolveBoardItems(b, { forSummary: true });
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // Deltas: what changed since the user last viewed (generated a briefing for) this
  // board. Pinned items whose latest activity timestamp is newer than lastViewedAt,
  // flagged for attention when the latest run errored/failed.
  const prevViewed = b.lastViewedAt ? new Date(b.lastViewedAt).getTime() : 0;
  const deltas = prevViewed
    ? out.filter(o => o.when && new Date(o.when).getTime() > prevViewed).map(o => ({
        label: o.label || o.refId, kind: o.kind, status: o.status || '', when: o.when, route: o.route,
        attention: ['error', 'failed'].includes(String(o.status).toLowerCase())
      }))
    : [];
  if (deltas.length) {
    const dl = deltas.map(d => `- ${d.attention ? '⚠ ' : ''}${d.label}${d.status ? ' [' + d.status + ']' : ''}`).join('\n');
    contextBlocks.unshift('### SINCE LAST VIEWED\n' + dl);
  }

  // Fold the board's own notes and checklists (with item status) into the context
  // so the briefing reflects what the user jotted down and what's still unchecked.
  const notes = (Array.isArray(b.notes) ? b.notes : []).map(n => clip(n.text, 300)).filter(Boolean);
  const checklists = (Array.isArray(b.checklists) ? b.checklists : []).map(cl => {
    const items = Array.isArray(cl.items) ? cl.items : [];
    const done = items.filter(i => i.done).length;
    return { title: clip(cl.title, 120), done, total: items.length, items };
  });
  if (notes.length) {
    contextBlocks.push('### NOTES\n' + notes.map(t => '- ' + t).join('\n'));
  }
  for (const cl of checklists) {
    const lines = cl.items.map(i => `- [${i.done ? 'x' : ' '}] ${clip(i.text, 200)}`);
    contextBlocks.push(`### CHECKLIST: ${cl.title || 'Untitled'} (${cl.done}/${cl.total} done)${lines.length ? '\n' + lines.join('\n') : ''}`);
  }
  const openChecklistItems = checklists.reduce((n, cl) => n + cl.items.filter(i => !i.done).length, 0);

  // Deterministic fallback used when the board is empty, has no usable context, or
  // the LLM call fails.
  const top = out.slice(0, 6).map(o => {
    const rel = o.when ? new Date(o.when).toLocaleString() : 'no recent activity';
    const st = o.status ? ` [${o.status}]` : '';
    return `• ${o.label}${st} — ${rel}${o.detail ? `\n    ${clip(o.detail, 160)}` : ''}`;
  }).join('\n');
  const manualLine = [
    notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : '',
    checklists.length ? `${openChecklistItems} open checklist item${openChecklistItems === 1 ? '' : 's'}` : ''
  ].filter(Boolean).join(', ');
  let digest;
  if (out.length) {
    digest = `Here's where you left off across ${out.length} pinned item${out.length === 1 ? '' : 's'} on "${b.name}", most recent first:\n\n${top}`;
    if (manualLine) digest += `\n\nAlso on this board: ${manualLine}.`;
  } else if (notes.length || checklists.length) {
    digest = `Board "${b.name}" has no pinned operations yet, but you have ${manualLine} here.`;
  } else {
    digest = `Board "${b.name}" has no pinned items yet. Pin a CLI session, chat, task, flow, assignment, or agent to track it here.`;
  }
  if (deltas.length) {
    const dl = deltas.map(d => `${d.attention ? '⚠ ' : ''}${d.label}${d.status ? ' [' + d.status + ']' : ''}`).join(', ');
    digest = `Since you last looked: ${dl}.\n\n` + digest;
  }

  // Persist the briefing onto the board record and notify SPA clients. Also advances
  // lastViewedAt so the next briefing's deltas are measured from this point.
  const persist = (text) => {
    const generatedAt = new Date().toISOString();
    const summary = { text, generatedAt, items: out, deltas };
    try {
      const all = loadBoards();
      const idx = all.findIndex(x => x.id === b.id);
      if (idx >= 0) { all[idx].summary = summary; all[idx].lastViewedAt = generatedAt; saveBoards(all); broadcastSSE('boards-changed', { id: b.id }); }
    } catch {}
    return summary;
  };

  if (!contextBlocks.length) {
    const saved = persist(digest);
    return res.json({ ok: true, generatedAt: saved.generatedAt, summary: saved.text, items: out, deltas, cached: false });
  }

  const prompt = [
    `You are reviewing a work board named "${b.name}". Below is recent context: items the user pinned (conversation transcripts, run output, or messages), plus the user's own NOTES and CHECKLIST sections. Checklist lines marked "[x]" are done and "[ ]" are still open.`,
    'Each pinned-item section is headed "### KIND: Name [source link: <route>]". The route after "source link:" is the primary source for everything in that section.',
    'Write a "Where was I?" briefing that reorients the user:',
    '- If a "SINCE LAST VIEWED" section is present, begin with one sentence highlighting what changed since the user last looked (call out any items marked ⚠ as needing attention).',
    '- 3 to 6 sentences of plain prose summarizing what is going on across these items, the current state, and what the notes/checklists indicate.',
    '- CITE YOUR PRIMARY SOURCES: when a statement draws on a specific pinned item, attribute it inline as a markdown link using that item\'s Name and its source link, e.g. "the latest run failed ([Autoscaler agent](#/agents/autoscaler))". Only cite items that actually have a source link in their heading; never invent a route. Notes/checklists are the user\'s own input and do not need a citation.',
    '- Then, only if there are concrete pending actions, add a line "Next steps:" followed by a short bullet list (each line starting with "- "). Treat unchecked checklist items as pending actions.',
    '- Finally, add a line "Sources:" followed by a short bullet list of the primary pinned items you actually drew from, each as a markdown link "[Name](route)" using its source link. Omit this line only if no pinned item had a source link.',
    'Be specific and concrete. No preamble, no headings other than "Next steps:" and "Sources:", no surrounding quotes.',
    '',
    contextBlocks.join('\n\n').slice(0, 9000),
    '',
    'Briefing:'
  ].join('\n');

  try {
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
    const text = (acc.trim() || (result && result.output) || '').trim() || digest;
    const saved = persist(text);
    res.json({ ok: true, generatedAt: saved.generatedAt, summary: saved.text, items: out, deltas, cached: false });
  } catch (e) {
    const saved = persist(digest);
    res.json({ ok: true, generatedAt: saved.generatedAt, summary: saved.text, items: out, deltas, cached: false, error: (e && e.message) || 'llm failed' });
  }
});

// ============================================================================
// INSIGHTS — read-only, AI-generated cross-board "Views". An insight gathers the
// "Where was I?" state of one or more ENABLED boards and produces a prioritized
// narrative + checklist + callouts. The built-in "Overview" spans every enabled
// board across all teams; custom insights pick an explicit set of enabled boards.
// Insights are NOT user-editable content — the user only configures membership
// and prompt; the body is regenerated by the LLM.
// ============================================================================
const INSIGHT_OVERVIEW_ID = 'insight-overview';

function _normalizeInsight(v) {
  v = v || {};
  return {
    id: v.id || ('insight-' + Math.random().toString(36).slice(2, 9)),
    name: (v.name && String(v.name).trim()) || 'Untitled insight',
    emoji: v.emoji || '🔭',
    ai: true,
    builtin: !!v.builtin,
    mode: v.mode === 'custom' ? 'custom' : 'all_enabled',
    boardIds: Array.isArray(v.boardIds) ? v.boardIds.filter(x => typeof x === 'string') : [],
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    schedule: v.schedule || 'never',
    content: (v.content && typeof v.content === 'object' && !Array.isArray(v.content)) ? v.content : null,
    generating: !!v.generating,
    error: v.error || null,
    createdAt: v.createdAt || new Date().toISOString(),
    updatedAt: v.updatedAt || new Date().toISOString()
  };
}

// Seed (and return) the built-in Overview insight. It is global, spans all enabled
// boards, and cannot be deleted or have its mode/membership changed.
function ensureOverviewInsight() {
  const all = loadInsights();
  let ov = all.find(v => v.id === INSIGHT_OVERVIEW_ID);
  if (!ov) {
    ov = _normalizeInsight({
      id: INSIGHT_OVERVIEW_ID, name: 'Overview', emoji: '🛰️', builtin: true,
      mode: 'all_enabled', prompt: '', schedule: 'never'
    });
    all.unshift(ov);
    saveInsights(all);
  }
  return ov;
}

// Resolve the set of boards an insight covers: enabled, non-archived boards only.
// all_enabled → every such board across ALL teams; custom → the explicit boardIds
// intersected with the enabled set.
function _insightMemberBoards(view) {
  const enabled = loadBoards().map(_normalizeBoard).filter(b => b.enabled !== false && !b.archived);
  if (view.mode === 'custom') {
    const want = new Set(view.boardIds || []);
    return enabled.filter(b => want.has(b.id));
  }
  return enabled;
}

// The "where was I" text for a board: prefer a recent cached summary, else build a
// deterministic digest from resolved pins/notes/checklists (no LLM call here).
function _boardWhereWasI(b) {
  if (b.summary && b.summary.text && b.summary.generatedAt) {
    const age = Date.now() - new Date(b.summary.generatedAt).getTime();
    if (age >= 0 && age < 6 * 60 * 60 * 1000) return b.summary.text;
  }
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const { out } = _resolveBoardItems(b, { forSummary: true });
  const notes = (Array.isArray(b.notes) ? b.notes : []).length;
  const open = (Array.isArray(b.checklists) ? b.checklists : []).reduce((n, cl) => n + (Array.isArray(cl.items) ? cl.items.filter(i => !i.done).length : 0), 0);
  if (!out.length && !notes && !open) return `No pinned items yet on "${b.name}".`;
  const top = out.slice(0, 5).map(o => {
    const st = o.status ? ` [${o.status}]` : '';
    const rel = o.when ? new Date(o.when).toLocaleString() : '';
    return `• ${o.label}${st}${rel ? ' — ' + rel : ''}${o.detail ? `: ${clip(o.detail, 140)}` : ''}`;
  }).join('\n');
  let d = out.length ? `${out.length} pinned item${out.length === 1 ? '' : 's'}:\n${top}` : `"${b.name}"`;
  const extra = [notes ? `${notes} note${notes === 1 ? '' : 's'}` : '', open ? `${open} open checklist item${open === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  if (extra) d += `\nAlso: ${extra}.`;
  return d;
}

function _parseInsightJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a >= 0 && z > a) s = s.slice(a, z + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// Build the per-board context, prompt the LLM for a strict-JSON insight body, parse
// robustly, attach each board's where-was-i, and persist onto the insight record.
async function generateInsight(viewId) {
  let all = loadInsights();
  let idx = all.findIndex(v => v.id === viewId);
  if (idx < 0) throw new Error('Insight not found');
  const view = _normalizeInsight(all[idx]);
  const boards = _insightMemberBoards(view);

  // mark generating
  all[idx] = { ...all[idx], generating: true, error: null, updatedAt: new Date().toISOString() };
  saveInsights(all); broadcastSSE('insights-changed', { id: viewId });

  const perBoard = boards.map(b => ({
    boardId: b.id, name: b.name, emoji: b.emoji || '📌',
    teamId: b.teamId || null, teamName: b.teamId ? _teamName(b.teamId) : null,
    whereWasI: _boardWhereWasI(b)
  }));

  const finish = (content, error) => {
    const cur = loadInsights();
    const i2 = cur.findIndex(v => v.id === viewId);
    if (i2 >= 0) {
      cur[i2] = { ...cur[i2], content, generating: false, error: error || null, updatedAt: new Date().toISOString() };
      saveInsights(cur); broadcastSSE('insights-changed', { id: viewId });
    }
    return content;
  };

  const generatedAt = new Date().toISOString();
  const baseContent = {
    narrative: '', checklist: [], callouts: [],
    boards: perBoard.map(p => ({ boardId: p.boardId, name: p.name, emoji: p.emoji, teamName: p.teamName, whereWasI: p.whereWasI })),
    generatedAt
  };

  if (!perBoard.length) {
    return finish({ ...baseContent, narrative: view.mode === 'custom' ? 'No enabled boards are part of this insight yet. Add enabled boards in the editor.' : 'No enabled boards yet. Enable a board to see it summarized here.' });
  }

  const ctx = perBoard.map(p => `### BOARD: ${p.name}${p.teamName ? ` (Team: ${p.teamName})` : ' (All teams)'} [id:${p.boardId}]\n${p.whereWasI}`).join('\n\n').slice(0, 11000);
  const prompt = [
    `You are an executive assistant producing a cross-board "${view.name}" insight over ${perBoard.length} work board${perBoard.length === 1 ? '' : 's'}. Each board's current state ("where was I") is given below, tagged with its id.`,
    view.prompt ? `User focus for this insight: ${view.prompt}` : '',
    'Respond with STRICT JSON only (no prose, no code fences) in exactly this shape:',
    '{',
    '  "narrative": "2-4 sentence prose overview of what is happening across all boards right now",',
    '  "checklist": [ { "title": "a concrete thing to work on", "why": "one short sentence on why it matters / urgency", "boardId": "<the board id this relates to>", "priority": 1 } ],',
    '  "callouts": [ { "type": "due|outage|failure|activity|note", "text": "short notable highlight", "boardId": "<board id or omit>" } ]',
    '}',
    'Rules: order the checklist by importance (priority 1 = most important, ascending). Use ONLY board ids that appear below. Keep titles short and actionable. Include 3-8 checklist items if there is enough signal, fewer if not. Callouts are optional — only include genuinely notable items (failures, due dates, outages, interesting activity).',
    '',
    ctx,
    '',
    'JSON:'
  ].filter(Boolean).join('\n');

  try {
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
    const raw = (acc.trim() || (result && result.output) || '').trim();
    const parsed = _parseInsightJson(raw);
    if (!parsed) throw new Error('could not parse insight JSON');
    const validBoardIds = new Set(perBoard.map(p => p.boardId));
    const checklist = (Array.isArray(parsed.checklist) ? parsed.checklist : [])
      .map((c, i) => ({
        title: String(c.title || '').trim(),
        why: String(c.why || '').trim(),
        boardId: validBoardIds.has(c.boardId) ? c.boardId : (perBoard[0] && perBoard[0].boardId) || null,
        priority: Number.isFinite(c.priority) ? c.priority : (i + 1)
      }))
      .filter(c => c.title)
      .sort((a, b) => a.priority - b.priority);
    const callouts = (Array.isArray(parsed.callouts) ? parsed.callouts : [])
      .map(c => ({ type: String(c.type || 'note').trim().toLowerCase(), text: String(c.text || '').trim(), boardId: validBoardIds.has(c.boardId) ? c.boardId : null }))
      .filter(c => c.text);
    return finish({ ...baseContent, narrative: String(parsed.narrative || '').trim() || baseContent.narrative, checklist, callouts });
  } catch (e) {
    // Deterministic fallback: list boards as a basic checklist.
    const checklist = perBoard.map((p, i) => ({ title: `Review ${p.name}`, why: 'Catch up on this board', boardId: p.boardId, priority: i + 1 }));
    return finish({ ...baseContent, narrative: `Tracking ${perBoard.length} enabled board${perBoard.length === 1 ? '' : 's'}.`, checklist }, (e && e.message) || 'llm failed');
  }
}

// GET /api/insights — list all insights (seeds the Overview on first call).
app.get('/api/insights', (req, res) => {
  ensureOverviewInsight();
  res.json(loadInsights().map(_normalizeInsight));
});

// GET /api/insights/:id — single insight.
app.get('/api/insights/:id', (req, res) => {
  ensureOverviewInsight();
  const v = loadInsights().find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Insight not found' });
  res.json(_normalizeInsight(v));
});

// POST /api/insights — create a custom insight.
app.post('/api/insights', (req, res) => {
  const { name, emoji, mode, boardIds, prompt, schedule } = req.body || {};
  const v = _normalizeInsight({ name, emoji, mode, boardIds, prompt, schedule, builtin: false });
  const all = loadInsights();
  all.push(v);
  saveInsights(all);
  broadcastSSE('insights-changed', { id: v.id });
  res.json(v);
});

// PUT /api/insights/:id — update config. Built-in Overview: only name/emoji/prompt/
// schedule may change (mode + membership are locked to "all enabled").
app.put('/api/insights/:id', (req, res) => {
  const all = loadInsights();
  const idx = all.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Insight not found' });
  const cur = _normalizeInsight(all[idx]);
  const { name, emoji, mode, boardIds, prompt, schedule } = req.body || {};
  if (name != null) cur.name = String(name).trim() || cur.name;
  if (emoji != null) cur.emoji = emoji;
  if (prompt != null) cur.prompt = String(prompt);
  if (schedule != null) cur.schedule = schedule;
  if (!cur.builtin) {
    if (mode != null) cur.mode = mode === 'custom' ? 'custom' : 'all_enabled';
    if (Array.isArray(boardIds)) cur.boardIds = boardIds.filter(x => typeof x === 'string');
  }
  cur.updatedAt = new Date().toISOString();
  all[idx] = cur;
  saveInsights(all);
  broadcastSSE('insights-changed', { id: cur.id });
  res.json(cur);
});

// DELETE /api/insights/:id — remove a custom insight (the built-in cannot be deleted).
app.delete('/api/insights/:id', (req, res) => {
  const all = loadInsights();
  const v = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Insight not found' });
  if (v.builtin || v.id === INSIGHT_OVERVIEW_ID) return res.status(400).json({ error: 'The built-in Overview insight cannot be deleted.' });
  saveInsights(all.filter(x => x.id !== req.params.id));
  broadcastSSE('insights-changed', { id: req.params.id, deleted: true });
  res.json({ ok: true });
});

// POST /api/insights/:id/generate — (re)generate the insight body now.
app.post('/api/insights/:id/generate', async (req, res) => {
  ensureOverviewInsight();
  if (!loadInsights().find(x => x.id === req.params.id)) return res.status(404).json({ error: 'Insight not found' });
  try {
    const content = await generateInsight(req.params.id);
    res.json({ ok: true, content });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'generation failed' });
  }
});

// POST /api/insights/suggest — "Design with AI": propose NEW insight definitions
// (with reasoning) based on the available enabled boards. Returns proposals only;
// nothing is persisted until the user creates one.
app.post('/api/insights/suggest', async (req, res) => {
  const enabled = loadBoards().map(_normalizeBoard).filter(b => b.enabled !== false && !b.archived);
  if (!enabled.length) return res.status(400).json({ error: 'No enabled boards to design insights from. Enable a board first.' });

  const hint = String((req.body && req.body.hint) || '').trim();
  const existing = loadInsights().map(_normalizeInsight).map(v => ({ name: v.name, mode: v.mode, boardIds: v.boardIds }));
  const boards = enabled.map(b => ({
    id: b.id, name: b.name,
    team: b.teamId ? _teamName(b.teamId) : null,
    state: String(_boardWhereWasI(b) || '').replace(/\s+/g, ' ').slice(0, 600)
  }));

  const prompt = [
    'You design "Insights" for a work-board platform. An insight is a read-only AI view that summarizes and prioritizes work across a chosen set of boards. Propose CREATIVE, GENUINELY USEFUL new insights by grouping the available boards in ways the user may not have considered (by team, by theme, by urgency, by cross-cutting concern like "anything on fire", "due this week", "stalled work").',
    '',
    'AVAILABLE ENABLED BOARDS (only ever reference these exact ids):',
    JSON.stringify(boards, null, 2),
    '',
    'EXISTING INSIGHTS (do not just repeat these):',
    JSON.stringify(existing, null, 2),
    '',
    hint ? ('USER FOCUS: ' + hint) : 'No specific focus — surprise the user with useful groupings.',
    '',
    'Propose 4 insights. Each has:',
    '- "mode": "all_enabled" (covers every enabled board) or "custom" (a chosen subset).',
    '- For "custom", "boardIds" MUST be a non-empty subset of the available board ids above.',
    '- A short "prompt": the focus instruction the insight\'s generator should emphasize (e.g. "highlight outages and anything due this week").',
    '- A "reasoning": 1-2 sentences explaining WHY this grouping is useful and what the user would get from it. Be specific to the actual boards/state above.',
    'Prefer "custom" groupings unless an all-boards view is genuinely the most useful. Vary the angle across the 4 suggestions.',
    '',
    'Respond with ONLY a JSON array (no prose) in this exact shape:',
    '```json',
    '[',
    '  { "name": "...", "emoji": "🔭", "mode": "custom", "boardIds": ["<board id>", "..."], "prompt": "...", "reasoning": "..." }',
    ']',
    '```'
  ].join('\n');

  try {
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), resume: false, cwd: __dirname, onChunk: (c) => { acc += c; } });
    const text = acc.trim() ? acc : (result && result.output) || '';
    const arr = parseSuggestionJson(text);
    if (!arr) return res.status(502).json({ error: 'Could not parse AI suggestions. Try refreshing.', raw: String(text).slice(0, 500) });
    const validIds = new Set(boards.map(b => b.id));
    const byId = Object.fromEntries(boards.map(b => [b.id, b.name]));
    const suggestions = arr.map(s => {
      const mode = s && s.mode === 'custom' ? 'custom' : 'all_enabled';
      let boardIds = Array.isArray(s && s.boardIds) ? s.boardIds.filter(x => validIds.has(x)) : [];
      if (mode === 'custom' && !boardIds.length) return null; // custom needs real boards
      const name = String((s && s.name) || '').trim();
      if (!name) return null;
      return {
        id: 'isug-' + require('crypto').randomBytes(4).toString('hex'),
        name, emoji: (s && s.emoji) || '🔭', mode,
        boardIds: mode === 'custom' ? boardIds : [],
        boardNames: (mode === 'custom' ? boardIds : boards.map(b => b.id)).map(id => byId[id]).filter(Boolean),
        prompt: String((s && s.prompt) || '').trim(),
        reasoning: String((s && s.reasoning) || '').trim()
      };
    }).filter(Boolean);
    if (!suggestions.length) return res.status(502).json({ error: 'AI returned no valid suggestions. Try refreshing.' });
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'suggestion failed' });
  }
});

// Board assistant — a board transformer + light orchestrator. It reads the board's
// pinned context, the user's notes/checklists, and the installed-agent catalog, and
// PROPOSES actions: note/checklist edits, running a PINNED agent to gather fresh info
// (query_agent), or pinning an installed agent to the board (pin_agent). Everything
// is propose → confirm — the client applies/queues confirmed actions. The only thing
// executed directly is a pinned agent the user has explicitly chosen to run.
async function runBoardAssistant(b, { message, history = [], extraContext = '', allowQuery = true, depth = 0 } = {}) {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // Bounded agent orchestration: the assistant may chain agent runs across confirmable
  // steps, but only up to MAX_QUERY_DEPTH hops so a request can't spiral into unbounded
  // runs. agentJustRan = this turn already has a fresh agent result folded into context.
  const MAX_QUERY_DEPTH = 3;
  const canQuery = allowQuery && depth < MAX_QUERY_DEPTH;
  const agentJustRan = /## AGENT RESULT|## SEARCH RESULT/.test(extraContext || '');

  // ---- Board context (pins + notes + checklists, with stable ids the model can
  // reference back in its proposed actions). Reuses the same resolver as the
  // "Where was I?" briefing so the assistant sees real run output / transcripts.
  const { contextBlocks } = _resolveBoardItems(b);
  const notes = (Array.isArray(b.notes) ? b.notes : []);
  const checklists = (Array.isArray(b.checklists) ? b.checklists : []);
  const pins = (Array.isArray(b.items) ? b.items : []);
  // Index of pins on this board so the model can only link checklist items to
  // things that are actually pinned here (kind:refId is the stable handle).
  const pinByKey = new Map(pins.map(p => [p.kind + ':' + p.refId, p]));
  const RUNNABLE = new Set(['agent', 'task', 'assignment', 'flow']);
  // Installed-agent catalog (for query_agent labels + pin_agent candidates). Agents
  // already pinned to this board are excluded from the "available to pin" list.
  let installed = [];
  try { installed = (supervisor.getAllStatus && supervisor.getAllStatus()) || []; } catch { installed = []; }
  const agentId = (s) => s.agent_id || (s.config && s.config.id) || '';
  const installedById = new Map(installed.map(s => [agentId(s), s]));
  const pinnedAgentIds = new Set(pins.filter(p => p.kind === 'agent').map(p => p.refId));
  const available = installed.filter(s => { const id = agentId(s); return id && !pinnedAgentIds.has(id); });
  const ctx = [];
  // Catalog blocks (available agents/operations/employees) go in their OWN list so
  // they keep a reserved budget — on a busy board the pinned transcripts + briefing
  // would otherwise eat the whole context window and the assistant would never see
  // what it can pin.
  const catalogCtx = [];
  if (contextBlocks.length) ctx.push('## PINNED ITEMS\n' + contextBlocks.join('\n\n').slice(0, 9000));
  if (pins.length) {
    ctx.push('## BOARD PINS (link checklist items to these by kind:refId)\n' + pins.map(p => {
      const key = p.kind + ':' + p.refId;
      const run = RUNNABLE.has(p.kind) ? 'runnable' : 'open-only';
      return `- (${key}) ${p.kind} "${clip(p.label || p.refId, 120)}" [${run}]`;
    }).join('\n'));
  }
  // Pinned source locations (folders) are searchable context. List each with its
  // path + README summary so the assistant knows what lives there and can propose
  // search_location to look inside when it needs to find something. Built into its
  // OWN string with a reserved budget (like the catalog) so a busy board's pinned
  // transcripts can't slice the locations — and their git branch — out of context.
  const locationPins = pins.filter(p => p.kind === 'location');
  let locationStr = '';
  if (locationPins.length) {
    locationStr = '## PINNED SOURCE LOCATIONS (folders you can search via search_location, refId = the path)\n' + locationPins.map(p => {
      let sum = '';
      try { sum = _readmeSummary(String(p.refId), 400).summary; } catch {}
      let git = '';
      try { const br = _gitBranch(String(p.refId)); if (br) git = ` [git branch: ${br}]`; else if (_isGitRepo(String(p.refId))) git = ' [git repo]'; else git = ' [not a git repo]'; } catch {}
      return `- (location:${p.refId})${git} "${clip(p.label || p.refId, 80)}"${sum ? ' — ' + clip(sum, 360) : ' — (no README)'}`;
    }).join('\n');
  }
  if (notes.length) {
    ctx.push('## NOTES\n' + notes.map(n => `- (${n.id}) ${clip(n.text, 300)}`).join('\n'));
  }
  if (checklists.length) {
    ctx.push('## CHECKLISTS\n' + checklists.map(cl => {
      const items = Array.isArray(cl.items) ? cl.items : [];
      const lines = items.map(i => `    - [${i.done ? 'x' : ' '}] (${i.id}) ${clip(i.text, 200)}`);
      return `- (${cl.id}) "${clip(cl.title, 120)}"${lines.length ? '\n' + lines.join('\n') : ''}`;
    }).join('\n'));
  }
  if (available.length) {
    catalogCtx.push('## AVAILABLE AGENTS (installed, NOT pinned — propose pin_item to add one)\n' + available.slice(0, 25).map(s => {
      const id = agentId(s); const c = s.config || {};
      const desc = clip(c.description || (Array.isArray(c.skills) ? c.skills.join(', ') : '') || '', 160);
      return `- (agent:${id}) "${clip(c.name || id, 80)}"${desc ? ' — ' + desc : ''}`;
    }).join('\n'));
  }
  // ---- Available OPERATIONS & EMPLOYEES catalog (beyond agents): lets the assistant
  // examine the whole system and propose pinning the right managers, tasks, flows, and
  // assignments to build out the board for a stated goal. Respects the board's team
  // scope — only items that belong to the team are offered, so a proposed pin never
  // makes the board non-compliant. catalogByKey is also the resolver for pin_item.
  const pinnedKeys = new Set(pins.map(p => p.kind + ':' + p.refId));
  const boardTeamId = b.teamId || null;
  const teamMembers = boardTeamId ? new Set((_teamById(boardTeamId) || {}).memberIds || []) : null;
  const inTeam = (id) => !teamMembers || teamMembers.has(id);
  const opOk = (opTeam, componentIds) => !boardTeamId || (opTeam === boardTeamId && (componentIds || []).every(inTeam));
  const catalogByKey = new Map(); // kind:refId -> { kind, refId, label, sublabel }
  const offer = (kind, refId, label, sublabel) => {
    const key = kind + ':' + refId;
    if (!refId || pinnedKeys.has(key) || catalogByKey.has(key)) return;
    catalogByKey.set(key, { kind, refId, label: clip(label || refId, 120), sublabel: clip(sublabel || '', 80) });
  };
  const mgrName = (m) => (m && (m.name || (m.config && m.config.name))) || (m && m.id) || '';
  const mgrAssignments = (m) => (m && (m.assignments || (m.config && m.config.assignments))) || [];
  try { for (const m of loadManagers()) { if (inTeam(m.id)) offer('manager', m.id, mgrName(m), 'Manager'); } } catch {}
  try {
    for (const t of loadTasks()) {
      if (!opOk(_opTeamOf(t), t.agentId ? [t.agentId] : [])) continue;
      const agentNm = t.agentId && installedById.get(t.agentId) ? clip((installedById.get(t.agentId).config || {}).name || t.agentId, 40) : '';
      offer('task', 'task-' + t.id, t.name || t.id, 'Task' + (agentNm ? ' · runs ' + agentNm : ''));
    }
  } catch {}
  try {
    for (const c of (chainEngine.list() || [])) {
      const cids = _opComponentEmployees({ kind: 'flow', refId: c.id }).map(e => e.employeeId);
      if (!opOk(_opTeamOf(c), cids)) continue;
      offer('flow', c.id, c.name || c.id, 'Flow' + ((c.steps || []).length ? ' · ' + c.steps.length + ' steps' : ''));
    }
  } catch {}
  try {
    for (const m of loadManagers()) {
      for (const a of mgrAssignments(m)) {
        if (!opOk(_opTeamOf(a), [m.id])) continue;
        offer('assignment', 'assignment-' + m.id + '-' + a.id, a.name || a.id, 'Assignment · ' + clip(mgrName(m), 40));
      }
    }
  } catch {}
  if (catalogByKey.size) {
    const byKind = {};
    for (const v of catalogByKey.values()) (byKind[v.kind] = byKind[v.kind] || []).push(v);
    const order = ['manager', 'task', 'flow', 'assignment'];
    const labelFor = { manager: 'managers (employees)', task: 'tasks (operations)', flow: 'flows (operations)', assignment: 'assignments (operations)' };
    const lines = [];
    for (const k of order) {
      const arr = (byKind[k] || []).slice(0, 20);
      if (!arr.length) continue;
      lines.push('### ' + labelFor[k]);
      for (const v of arr) lines.push(`- (${v.kind}:${v.refId}) "${v.label}"${v.sublabel ? ' — ' + v.sublabel : ''}`);
    }
    if (lines.length) catalogCtx.push('## AVAILABLE OPERATIONS & EMPLOYEES (' + (boardTeamId ? 'in this team, ' : '') + 'NOT pinned — propose pin_item to add)\n' + lines.join('\n'));
  }
  // Fold in the board's own "Where was I?" briefing so the assistant can answer
  // questions about it and build on it (it's the user's latest synthesized view of
  // the board). Placed first so it frames the rest of the context.
  if (b.summary && b.summary.text) {
    ctx.unshift('## WHERE WAS I? (latest AI briefing for this board)\n' + clip(b.summary.text, 2000));
  }
  const baseCtx = ctx.join('\n\n');
  // Reserved budgets per section so a busy board's pinned transcripts can't crowd out
  // the catalog or source locations. Modern models have large context windows, so we
  // keep the main content budget generous.
  const CTX_CONTENT_MAX = 32000, CTX_LOCATION_MAX = 1600, CTX_CATALOG_MAX = 4000;
  const contentStr = [extraContext, baseCtx].filter(Boolean).join('\n\n').slice(0, CTX_CONTENT_MAX);
  const catalogStr = catalogCtx.join('\n\n').slice(0, CTX_CATALOG_MAX);
  const locStr = locationStr.slice(0, CTX_LOCATION_MAX);
  const contextStr = [contentStr, locStr, catalogStr].filter(Boolean).join('\n\n') || '(this board is empty — no pins, notes, or checklists yet)';

  // ---- Prompt: force a single JSON object {reply, actions[]}. Actions are
  // constrained to notes/checklists only.
  const sys = [
    `You are the board assistant for a work board named "${b.name}". You help keep the board clean and actionable, and you can orchestrate the board's own pinned agents. You work by PROPOSING actions that the user confirms — you never apply changes or run anything yourself except a pinned agent the user explicitly confirms.`,
    '',
    'You can propose these action types (and ONLY these):',
    '- {"type":"add_note","text":"<markdown note>"}',
    '- {"type":"edit_note","noteId":"<existing note id>","text":"<new full text>"}',
    '- {"type":"add_checklist","title":"<title>","items":[<item>, ...]}',
    '- {"type":"add_checklist_items","checklistId":"<existing checklist id>","items":[<item>, ...]}',
    '- {"type":"check_item","checklistId":"<existing checklist id>","itemId":"<existing item id>"}  (marks the item done)',
    '- {"type":"uncheck_item","checklistId":"<existing checklist id>","itemId":"<existing item id>"}  (marks the item NOT done)',
    '- {"type":"delete_note","noteId":"<existing note id>"}  (removes the note)',
    '- {"type":"edit_checklist","checklistId":"<existing checklist id>","title":"<new title>"}  (renames the checklist)',
    '- {"type":"delete_checklist","checklistId":"<existing checklist id>"}  (removes the whole checklist and its items)',
    '- {"type":"edit_checklist_item","checklistId":"<existing checklist id>","itemId":"<existing item id>","text":"<new item text>"}  (rewrites one item)',
    '- {"type":"delete_checklist_item","checklistId":"<existing checklist id>","itemId":"<existing item id>"}  (removes one item)',
    (canQuery ? '- {"type":"query_agent","agentRefId":"<refId of a PINNED agent>","prompt":"<what to ask it>","purpose":"<why>"}  (runs that pinned agent so you can use its fresh output — propose this when you need live data only a pinned agent can produce, e.g. "make a checklist from my Autoscaler epic")' : ''),
    '- {"type":"pin_item","kind":"<agent|manager|task|flow|assignment>","refId":"<kind:refId from AVAILABLE AGENTS or AVAILABLE OPERATIONS & EMPLOYEES>"}  (adds an existing employee or operation to this board — propose when the goal needs a capability/op that is not yet pinned, e.g. an agent for email access, a task/flow/assignment that already does the work, or a manager that owns the org). Employees: agent, manager. Operations: task, flow, assignment.',
    (canQuery && locationPins.length ? '- {"type":"search_location","refId":"<path of a PINNED source location>","query":"<text to grep for>","purpose":"<why>"}  (searches inside a pinned source folder. This runs AUTOMATICALLY and instantly — there is NO confirm step and no cost — and the matching file contents are folded straight back so you can answer from real code/docs. Propose this FREELY and immediately whenever the user asks about, or you need to find anything inside, a pinned source location. You may propose several in one turn; you will be re-invoked with the results to give the final answer.)' : ''),
    '- {"type":"set_layout", ...}  (change how the board is PRESENTED — VISUAL ONLY, never touches content. Use for requests like "focus on the release checklist", "collapse everything", "expand the autoscaler agent", "hide the boring panels", "zoom out a bit", "bigger font", "tidy this up", or "design a good layout". Include ONLY the optional fields the request needs: "summary":"<short human label of the change>", "focus":{"kind":"<note|checklist|agent|manager|task|flow|assignment|chat|session>","refId":"<id>"} (spotlight ONE item — collapses all others and expands + widens it), "collapse":"all"|"none"|[{"kind":"...","refId":"..."}, ...] ("all" collapses every panel, "none" expands every panel, or a list of specific panels to collapse), "expand":[{"kind":"...","refId":"..."}, ...], "zoom":<0.5-1.2>, "fontScale":<0.8-1.3>, "organize":true (de-overlap/tidy), "compact":true (shrink widths + pack tightly), "aiDesign":true (hand the WHOLE view to the layout AI — use this for vague asks like "make it look good" or "collapse whatever is not interesting", and do NOT combine aiDesign with other fields). Reference targets by the SAME ids in BOARD CONTEXT: a NOTE by its note id with kind "note", a CHECKLIST by its cl id with kind "checklist", a PIN by its kind:refId. Propose at most ONE set_layout per turn.)',
    '',
    'Each checklist <item> is EITHER a plain string "<short imperative step>" OR an object that links the step to a pinned item so the user can run/open it directly from the checklist:',
    '  {"text":"<short step>","ref":{"kind":"<pin kind>","refId":"<pin refId>"}}',
    'Only use ref kind:refId pairs that appear under BOARD PINS below. Linking a runnable pin (agent/task/assignment/flow) makes the checklist item one-click runnable; linking an open-only pin (manager/chat/session) makes it one-click openable. Prefer a ref when the step is literally "run/check/open <a pinned thing>".',
    'Item "text" (and note text) renders inline MARKDOWN, so it supports clickable hyperlinks. When a step refers to something that has a real URL (a work item, PR, doc, dashboard, build, etc.) and that URL is present in the BOARD CONTEXT, embed it as a markdown link, e.g. "[#10842 — Queue wait-time](https://dev.azure.com/.../workitems/edit/10842)". When the user explicitly asks for hyperlinks/links, EVERY relevant item MUST contain a real markdown link — never give back plain text. Never invent or guess a URL: if you do not have the real URL, gather it first (run the relevant pinned agent via query_agent) rather than producing a linkless or fabricated list.',
    '',
    'Rules:',
    '- Only reference ids (note ids like note-..., checklist ids like cl-..., item ids like ci-...), pin handles (kind:refId), and agent ids that appear in the BOARD CONTEXT below. Never invent ids.',
    // Anti-hallucination for plain factual questions.
    '- STAY GROUNDED ON FACTS: when the user asks a factual question (about a source location, its git branch/repo/remote, a file, a status, a URL, a number, who owns something, etc.), answer ONLY from what is actually in the BOARD CONTEXT below. Do NOT guess plausible-sounding defaults. In particular, if the user asks about a source location or its branch and there is NO "PINNED SOURCE LOCATIONS" section (or that specific folder is not listed), say that no source location is pinned to this board rather than naming a branch like "main". If a location IS pinned but its branch is not shown in context, say you can search the folder but do not have its branch — never invent one. When the needed fact is genuinely absent, say so plainly (and, if a pinned agent or a search_location could fetch it, offer that) instead of fabricating an answer.',
    // Proactive gathering — don't fabricate; run/pin the right agent when context is thin.
    (canQuery
      ? '- GATHER BEFORE YOU GUESS: if fulfilling the request needs facts that are NOT already in the BOARD CONTEXT (live status, URLs, a list from an epic/agent, etc.), do not fabricate, hand-wave, or emit placeholder items. If a PINNED agent can produce those facts, propose query_agent. If no pinned agent fits but one under AVAILABLE AGENTS clearly does, propose pin_item (the user pins it, then asks you to run it). Only answer/build directly when the needed facts are already present in context.'
      : '- You may still propose query_agent for a genuinely DIFFERENT agent or purpose if the request needs more data you do not yet have, but NEVER re-run the same agent for the same purpose.'),
    (agentJustRan ? '- You just received a fresh AGENT RESULT or SEARCH RESULT in the context below. Use it now to answer the user and build the concrete notes/checklists they asked for; do not ask the user to run the same agent or search again.' : ''),
    // Honor explicit agent requests.
    (canQuery ? '- HONOR explicit agent requests: if the user tells you to "use an agent" / "run an agent" / "have an agent find/fetch ..." to obtain information, you MUST propose query_agent for the best-matching pinned agent instead of shortcutting with whatever is already in the context — unless the BOARD CONTEXT already contains the EXACT, complete data needed (e.g. the real URLs themselves).' : ''),
    // Smart agent selection + auto-pin.
    '- SMART AGENT CHOICE: when you need an agent, read the agent NAMES and DESCRIPTIONS in BOARD PINS / AVAILABLE AGENTS and pick the SINGLE best match for the capability required (e.g. an Azure/work-item agent for work-item URLs, an email agent for sending mail). Prefer an already-pinned agent; only propose pin_item when no pinned agent covers the need.',
    // Proactively help build/modify the board from a direction.
    '- BUILD/MODIFY THE BOARD: treat AVAILABLE OPERATIONS & EMPLOYEES (and AVAILABLE AGENTS) as the catalog you can draw from. When the user gives a DIRECTION for the board (e.g. "set this board up to monitor Azure and email me when something breaks", "make this a release-readiness board"), examine that catalog, pick the items whose NAMES and DESCRIPTIONS best match the goal, and propose pin_item for each relevant employee/operation — then add a short note and/or checklist that wires them into a concrete plan (link checklist items to the things you just proposed to pin by their kind:refId). Prefer existing operations (task/flow/assignment) over re-deriving the work by hand. Only pin what is clearly relevant to the stated goal; do not pin the entire catalog.',
    '- LAYOUT / PRESENTATION REQUESTS: when the user asks to change how the board LOOKS or is arranged — focus on / spotlight / collapse / hide / expand / show an item, zoom in or out, larger or smaller font, tidy / organize / compact, or "design a good layout" — propose exactly ONE set_layout action and NOTHING else. NEVER edit, rename, or delete board content to satisfy a presentation request (collapsing is visual, not deletion). For a precise ask ("focus on the release checklist", "collapse the notes") fill the matching set_layout fields; for a vague ask ("make this look good", "collapse what is not interesting", "clean this up") use aiDesign:true alone.',
    '- Use pin_item ONLY for kind:refId pairs that literally appear under AVAILABLE AGENTS or AVAILABLE OPERATIONS & EMPLOYEES. Never invent one. Pick the best matches for the stated goal/capability.',
    // Dedup / merge awareness.
    '- AVOID DUPLICATES: before add_checklist, scan the CHECKLISTS already in the context — if one already covers this topic, use add_checklist_items against its real id instead of creating a near-duplicate. Likewise prefer edit_note to update an existing relevant note rather than adding a second one. Do not propose items that already exist on the board.',
    // Multi-step confirmable plans.
    '- MULTI-STEP PLANS: when a request needs several steps (e.g. gather data → build a checklist → add a note), briefly state the ordered plan in "reply", then propose ONLY the first actionable step now — usually a single query_agent. After each step runs/applies you will be called again to propose the next step. NEVER propose a query_agent together with the checklist/note that depends on its output in the same response.',
    '- Use pin_item ONLY for kind:refId pairs under AVAILABLE AGENTS / AVAILABLE OPERATIONS & EMPLOYEES. Pick the single best match for the stated capability.',
    '- To start a brand-new checklist use add_checklist; to extend an existing one use add_checklist_items with its real id.',
    '- DESTRUCTIVE ACTIONS (delete_note, delete_checklist, delete_checklist_item) and edits (edit_note, edit_checklist, edit_checklist_item, uncheck_item) require explicit user intent: only propose them when the user clearly asks to remove, clear, delete, rename, rewrite, fix, or uncheck specific existing board content. NEVER delete or rewrite content proactively, and never delete more than the user asked for. Each one targets a single real id from the BOARD CONTEXT.',
    '- Propose actions ONLY when the user is clearly asking to add/change board content or orchestrate work. For pure questions, return an empty actions array and just answer in "reply".',
    '- Keep checklist items short and imperative; embed real hyperlinks as described above. Keep notes concise.',
    '- Base proposals on the actual board context (pinned run output, agent results, notes, existing checklists) when relevant.',
    '',
    'Respond with a SINGLE JSON object and nothing else: {"reply":"<short conversational reply describing what you propose, or your answer>","actions":[ ... ]}. No code fences, no prose outside the JSON.',
    '',
    '# BOARD CONTEXT',
    contextStr,
  ].filter(l => l !== '').join('\n');

  const convo = history.slice(-8).map(h => `${h.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${clip(h.content, 800)}`).join('\n');
  const prompt = [sys, '', '# CONVERSATION', convo, `USER: ${clip(message, 2000)}`, '', 'JSON:'].join('\n');

  // Robust JSON extraction: strip code fences, take the outermost {...}.
  const parseModel = (text) => {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  };

  // Resolve a model-proposed action against the live board into a concrete,
  // applies-cleanly action with a human label. Drops anything unresolvable.
  const findChecklist = (a) => {
    if (a.checklistId) { const c = checklists.find(c => c.id === a.checklistId); if (c) return c; }
    if (a.checklistTitle || a.title) {
      const want = String(a.checklistTitle || a.title).toLowerCase().trim();
      return checklists.find(c => String(c.title || '').toLowerCase().trim() === want) || null;
    }
    return null;
  };
  const resolveAction = (a) => {
    if (!a || typeof a !== 'object') return null;
    const type = String(a.type || '');
    // Normalize a proposed checklist entry into { text, ref? }. Accepts a plain
    // string or an object with an optional ref; a ref is only kept if it matches
    // a real pin on this board (otherwise the step survives as plain text).
    const normItem = (x) => {
      if (typeof x === 'string') { const text = clip(x, 500); return text ? { text } : null; }
      if (x && typeof x === 'object') {
        const text = clip(x.text, 500); if (!text) return null;
        const r = x.ref && typeof x.ref === 'object' ? x.ref
          : (x.kind && x.refId ? { kind: x.kind, refId: x.refId } : null);
        if (r && r.kind && r.refId) {
          const p = pinByKey.get(r.kind + ':' + r.refId);
          if (p) return { text, ref: { kind: p.kind, refId: p.refId, label: p.label || p.refId } };
        }
        return { text };
      }
      return null;
    };
    const normItems = (arr) => (Array.isArray(arr) ? arr : []).map(normItem).filter(Boolean).slice(0, 30);
    const linkSuffix = (items) => { const n = items.filter(i => i.ref).length; return n ? ` · ${n} linked` : ''; };
    // Newline-preserving normalizer for note bodies and full previews — unlike clip(),
    // it keeps line breaks (only trims trailing spaces / collapses 3+ blank lines) so the
    // proposal card shows the note exactly as it will be saved, never truncated mid-sentence.
    const multiline = (s, n = 4000) => String(s == null ? '' : s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
    if (type === 'add_note') {
      const text = multiline(a.text, 4000); if (!text) return null;
      return { type, text, label: 'Add note', preview: text };
    }
    if (type === 'edit_note') {
      const n = notes.find(n => n.id === a.noteId); const text = multiline(a.text, 4000);
      if (!n || !text) return null;
      return { type, noteId: n.id, text, label: 'Update note', preview: text, before: clip(n.text, 100) };
    }
    if (type === 'add_checklist') {
      const title = clip(a.title, 120); if (!title) return null;
      const items = normItems(a.items);
      return { type, title, items, label: 'New checklist', preview: title + (items.length ? ` (${items.length} item${items.length === 1 ? '' : 's'}${linkSuffix(items)})` : '') };
    }
    if (type === 'add_checklist_items') {
      const cl = findChecklist(a);
      const items = normItems(a.items);
      if (!items.length) return null;
      if (!cl) { // unknown target → fall back to a fresh checklist so the proposal isn't lost
        const title = clip(a.checklistTitle || a.title || 'Checklist', 120);
        return { type: 'add_checklist', title, items, label: 'New checklist', preview: title + ` (${items.length} item${items.length === 1 ? '' : 's'}${linkSuffix(items)})` };
      }
      return { type, checklistId: cl.id, checklistTitle: cl.title, items, label: 'Add to checklist', preview: `${cl.title}: +${items.length} item${items.length === 1 ? '' : 's'}${linkSuffix(items)}` };
    }
    // Item-targeting ops (check/uncheck/edit/delete a single item). Resolve the
    // checklist (by id or title) then the item id within it.
    const findItem = (cl, a) => {
      const items = Array.isArray(cl && cl.items) ? cl.items : [];
      if (a.itemId) { const it = items.find(i => i.id === a.itemId); if (it) return it; }
      if (a.itemText || a.text) {
        const want = String(a.itemText || a.text).toLowerCase().trim();
        return items.find(i => String(i.text || '').toLowerCase().trim() === want) || null;
      }
      return null;
    };
    if (type === 'check_item' || type === 'uncheck_item') {
      const cl = findChecklist(a); if (!cl) return null;
      const it = findItem(cl, a); if (!it) return null;
      const done = type === 'check_item';
      return { type, checklistId: cl.id, itemId: it.id, label: done ? 'Check off item' : 'Uncheck item', preview: `${clip(cl.title, 120)}: ${done ? '☑' : '☐'} ${clip(it.text, 1000)}` };
    }
    if (type === 'delete_note') {
      const n = notes.find(n => n.id === a.noteId); if (!n) return null;
      return { type, noteId: n.id, label: 'Delete note', preview: multiline(n.text, 4000), destructive: true };
    }
    if (type === 'edit_checklist') {
      const cl = findChecklist(a); const title = clip(a.title, 120);
      if (!cl || !title) return null;
      return { type, checklistId: cl.id, title, label: 'Rename checklist', preview: `"${clip(cl.title, 200)}" → "${title}"` };
    }
    if (type === 'delete_checklist') {
      const cl = findChecklist(a); if (!cl) return null;
      const n = Array.isArray(cl.items) ? cl.items.length : 0;
      return { type, checklistId: cl.id, label: 'Delete checklist', preview: `"${clip(cl.title, 200)}"` + (n ? ` (${n} item${n === 1 ? '' : 's'})` : ''), destructive: true };
    }
    if (type === 'edit_checklist_item') {
      const cl = findChecklist(a); if (!cl) return null;
      const it = findItem(cl, a); const text = clip(a.text || a.newText, 1000);
      if (!it || !text) return null;
      return { type, checklistId: cl.id, itemId: it.id, text, label: 'Edit item', preview: `${clip(cl.title, 120)}: "${clip(it.text, 1000)}" → "${text}"` };
    }
    if (type === 'delete_checklist_item') {
      const cl = findChecklist(a); if (!cl) return null;
      const it = findItem(cl, a); if (!it) return null;
      return { type, checklistId: cl.id, itemId: it.id, label: 'Delete item', preview: `${clip(cl.title, 120)}: ${clip(it.text, 1000)}`, destructive: true };
    }
    if (type === 'query_agent') {
      if (!canQuery) return null;
      let refId = a.agentRefId || a.refId || a.agentId || '';
      if (typeof refId === 'string' && refId.indexOf('agent:') === 0) refId = refId.slice(6);
      const pin = pins.find(p => p.kind === 'agent' && p.refId === refId);
      if (!pin) return null; // only agents pinned to THIS board may be queried
      const q = clip(a.prompt || a.instruction || message, 1500);
      const name = pin.label || refId;
      // Carry the current chain depth so the client can echo it back when it runs the
      // agent, letting the follow-up continue the chain (bounded by MAX_QUERY_DEPTH).
      return { type, agentId: refId, agentLabel: name, prompt: q, purpose: clip(a.purpose, 200), depth, label: 'Run agent', preview: `Run ${name}` + (q ? `: ${q}` : '') };
    }
    if (type === 'search_location') {
      if (!canQuery) return null;
      let refId = a.refId || a.path || a.locationRefId || '';
      if (typeof refId === 'string' && refId.indexOf('location:') === 0) refId = refId.slice(9);
      const pin = pins.find(p => p.kind === 'location' && p.refId === refId);
      if (!pin) return null; // only locations pinned to THIS board may be searched
      const q = clip(a.query || a.prompt || message, 200);
      if (!q) return null;
      const name = pin.label || refId;
      return { type, refId, locationLabel: name, query: q, purpose: clip(a.purpose, 200), depth, label: 'Search location', preview: `Search ${name} for "${q}"` };
    }
    if (type === 'pin_item' || type === 'pin_agent') {
      // pin_agent is kept as a backward-compat alias: it's just pin_item kind:agent.
      // refId may arrive as a bare id or as a "kind:refId" handle (strip the kind).
      let kind = type === 'pin_agent' ? 'agent' : String(a.kind || '').trim();
      let refId = a.refId || a.agentId || a.id || '';
      if (typeof refId === 'string' && refId.includes(':')) {
        const i = refId.indexOf(':');
        const pre = refId.slice(0, i);
        if (BOARD_KINDS.includes(pre)) { if (!kind) kind = pre; refId = refId.slice(i + 1); }
      }
      if (!kind || !refId) return null;
      if (pins.some(p => p.kind === kind && p.refId === refId)) return null; // already pinned
      // Agents come from the installed catalog; everything else from catalogByKey.
      if (kind === 'agent') {
        const s = installedById.get(refId); if (!s) return null;
        const c = s.config || {};
        const name = clip(c.name || refId, 120);
        const sub = clip(c.group || (Array.isArray(c.skills) ? c.skills.slice(0, 3).join(', ') : '') || 'Agent', 80);
        return { type: 'pin_item', kind, refId, pinLabel: name, pinSublabel: sub, label: 'Pin employee', preview: `Pin ${name} (agent) to this board` };
      }
      const hit = catalogByKey.get(kind + ':' + refId);
      if (!hit) return null;
      const isEmp = kind === 'manager';
      return { type: 'pin_item', kind, refId, pinLabel: hit.label, pinSublabel: hit.sublabel, label: isEmp ? 'Pin employee' : 'Pin operation', preview: `Pin ${hit.label} (${kind}) to this board` };
    }
    if (type === 'set_layout') {
      // Presentation-only action: validate/normalize a layout directive. The client
      // resolves the {kind,refId} targets against the live panels and applies it —
      // we just sanitize the fields here. Targets reuse the board's own id space:
      // notes by note id (kind "note"), checklists by cl id (kind "checklist"),
      // pins by their real kind:refId.
      const normTarget = (t) => {
        if (!t || typeof t !== 'object') return null;
        const k = clip(t.kind, 40).toLowerCase(); const r = clip(t.refId, 200);
        if (!k || !r) return null; return { kind: k, refId: r };
      };
      const out = { type, label: 'Adjust layout' };
      let has = false;
      if (a.aiDesign === true) { out.aiDesign = true; has = true; }
      if (a.collapse === 'all' || a.collapse === 'none') { out.collapse = a.collapse; has = true; }
      else if (Array.isArray(a.collapse)) { const arr = a.collapse.map(normTarget).filter(Boolean).slice(0, 60); if (arr.length) { out.collapse = arr; has = true; } }
      if (Array.isArray(a.expand)) { const arr = a.expand.map(normTarget).filter(Boolean).slice(0, 60); if (arr.length) { out.expand = arr; has = true; } }
      const f = normTarget(a.focus); if (f) { out.focus = f; has = true; }
      if (typeof a.zoom === 'number' && isFinite(a.zoom)) { out.zoom = Math.max(0.5, Math.min(1.2, a.zoom)); has = true; }
      if (typeof a.fontScale === 'number' && isFinite(a.fontScale)) { out.fontScale = Math.max(0.8, Math.min(1.3, a.fontScale)); has = true; }
      if (a.organize === true) { out.organize = true; has = true; }
      if (a.compact === true) { out.compact = true; has = true; }
      if (!has) return null;
      // Human-readable preview describing the change.
      const bits = [];
      if (out.aiDesign) bits.push('AI-design the view');
      if (out.focus) bits.push('focus the ' + out.focus.kind);
      if (out.collapse === 'all') bits.push('collapse all panels');
      else if (out.collapse === 'none') bits.push('expand all panels');
      else if (Array.isArray(out.collapse)) bits.push('collapse ' + out.collapse.length + ' panel' + (out.collapse.length === 1 ? '' : 's'));
      if (Array.isArray(out.expand)) bits.push('expand ' + out.expand.length + ' panel' + (out.expand.length === 1 ? '' : 's'));
      if (typeof out.zoom === 'number') bits.push('zoom ' + Math.round(out.zoom * 100) + '%');
      if (typeof out.fontScale === 'number') bits.push('font ' + Math.round(out.fontScale * 100) + '%');
      if (out.compact) bits.push('compact');
      else if (out.organize) bits.push('organize');
      out.preview = clip(a.summary, 140) || bits.join(' · ') || 'Adjust the board layout';
      return out;
    }
    return null;
  };

  let acc = '';
  const result = await sdkRunner.runChat({ config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
  const rawText = (acc.trim() || (result && result.output) || '').trim();
  const parsed = parseModel(rawText);
  // Newline-preserving normalizer for the chat reply so block markdown (headings,
  // tables, lists, code fences) survives to the client renderer. clip() would
  // collapse every newline into a space, flattening the whole reply into one
  // paragraph — only inline markdown (bold/code) would then render.
  const replyText = (s, n = 6000) => String(s == null ? '' : s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
  let reply, actions = [];
  if (parsed && typeof parsed === 'object') {
    reply = replyText(parsed.reply) || 'Here is what I suggest.';
    const proposed = Array.isArray(parsed.actions) ? parsed.actions : [];
    actions = proposed.map(resolveAction).filter(Boolean).slice(0, 8).map((a, i) => ({ id: 'act-' + Date.now().toString(36) + '-' + i, ...a }));
  } else {
    // Model didn't return JSON — treat the whole thing as a plain reply.
    reply = replyText(rawText) || "I couldn't generate a response. Try rephrasing.";
  }

  // AUTO-SEARCH pinned source locations. Searching a folder is read-only and safe,
  // so we never make the user click a confirm button for it: when the model proposes
  // search_location action(s) and we still have query budget, run them server-side,
  // fold the matches back in as context, and recurse once to produce the real answer
  // in a single round trip. (query_agent stays confirm-gated — it has side effects.)
  if (canQuery) {
    const searches = actions.filter(a => a.type === 'search_location').slice(0, 3);
    if (searches.length) {
      const blocks = [];
      for (const s of searches) {
        let matches = [];
        try { matches = _locationSearch(s.refId, s.query, 60); } catch {}
        const lines = matches.slice(0, 40).map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
        blocks.push(`### Search of "${s.locationLabel}" for "${s.query}"\n` + (lines ? lines : '(no matches found)'));
      }
      const searchCtx = (extraContext ? extraContext + '\n\n' : '') + '## SEARCH RESULT\n' + blocks.join('\n\n');
      return await runBoardAssistant(b, { message, history, extraContext: searchCtx, allowQuery, depth: depth + 1 });
    }
  }

  return { reply, actions };
}

// Board assistant chat — proposes (never applies) board edits + orchestration.
app.post('/api/boards/:id/assistant', async (req, res) => {
  const raw = loadBoards().find(b => b.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(raw);
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
  try {
    const out = await runBoardAssistant(b, { message, history });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || 'assistant failed' });
  }
});

// AI Layout — the model reviews a digest of the board's panels (supplied by the
// client, which knows the live rendered content) and returns a PRESENTATION plan:
// which panels are interesting (keep expanded / make prominent) vs. low-signal
// (collapse), plus a good canvas zoom and content font size. It proposes presentation
// only — it never edits board content. The client applies the plan and re-organizes.
app.post('/api/boards/:id/ai-layout', async (req, res) => {
  const raw = loadBoards().find(b => b.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(raw);
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const inPanels = Array.isArray(req.body && req.body.panels) ? req.body.panels : [];
  if (!inPanels.length) return res.status(400).json({ error: 'No panels' });
  // Keep only well-formed entries; cap count + per-field size we feed the model.
  const panels = inPanels.filter(p => p && p.id).slice(0, 60).map(p => ({
    id: String(p.id),
    type: clip(p.type, 24),
    title: clip(p.title, 120),
    text: clip(p.text, 600),
    collapsed: !!p.collapsed,
  }));
  if (!panels.length) return res.status(400).json({ error: 'No valid panels' });
  const digest = panels.map((p, i) =>
    `${i + 1}. id=${JSON.stringify(p.id)} type=${p.type || 'item'} title="${p.title}"` +
    `\n   content: ${p.text || '(empty)'}`
  ).join('\n');

  const sys = [
    `You are a layout designer for a work board named "${b.name}". You are given every panel currently on the board with its type, title, and a snippet of its live content. Decide how to PRESENT the board so the most useful, active, or attention-worthy panels are immediately visible and low-signal ones get out of the way. You change presentation only — you never edit, add, or delete board content.`,
    '',
    'For EACH panel decide:',
    '- importance: "high" (key / attention-worthy — keep expanded and prominent), "normal" (relevant — keep expanded), or "low" (stale, empty, finished, or background — collapse it).',
    '- collapsed: true to collapse the panel to a small header chip, false to keep it open. Collapse low-importance and empty/finished panels; keep high and normal panels open.',
    '- width: optional "full" (span the whole board width — use ONLY for the single most important / widest-content panel, e.g. a substantive briefing or a long note) or "half" (the default column width). Use "full" sparingly (at most one or two panels).',
    '',
    'Also choose, for the WHOLE board:',
    '- zoom: a number from 0.6 to 1.0 — how far to zoom the canvas so the expanded panels fit comfortably without wasted space. Many open/important panels → zoom out a little (toward 0.7); only a few → 1.0.',
    '- fontScale: a number from 0.85 to 1.2 — content text size. Use ~1.0 normally; nudge up when there is little content, down when the board is dense.',
    '',
    'Heuristics for what is interesting: panels with fresh status, errors/failures, action items, unchecked work, recent agent output, or a substantive briefing are HIGH. Empty notes, fully-completed checklists, idle/placeholder pins, and duplicates are LOW. A briefing-style panel ("Where was I?") that has real content is usually HIGH and a good "full"-width candidate.',
    '',
    'Respond with a SINGLE JSON object and nothing else — no code fences, no prose outside the JSON:',
    '{"zoom":<num>,"fontScale":<num>,"reasoning":"<one short sentence on the focus you chose>","panels":[{"id":"<exact id>","importance":"high|normal|low","collapsed":<bool>,"width":"full|half"}]}',
    'Include EVERY panel id exactly as given below. Never invent ids.',
    '',
    '# BOARD PANELS',
    digest,
    '',
    'JSON:',
  ].join('\n');

  try {
    let acc = '';
    const result = await sdkRunner.runChat({ config: null, prompt: sys, sessionId: require('crypto').randomUUID(), cwd: __dirname, onChunk: (c) => { acc += c; } });
    const rawText = (acc.trim() || (result && result.output) || '').trim();
    let parsed = null;
    try {
      let t = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      if (s >= 0 && e > s) parsed = JSON.parse(t.slice(s, e + 1));
    } catch {}
    if (!parsed || typeof parsed !== 'object') return res.status(502).json({ ok: false, error: 'Could not parse a layout plan' });
    const known = new Set(panels.map(p => p.id));
    const clampNum = (v, lo, hi, dflt) => { let n = parseFloat(v); if (!isFinite(n)) n = dflt; return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)); };
    const outPanels = (Array.isArray(parsed.panels) ? parsed.panels : [])
      .filter(p => p && known.has(String(p.id)))
      .map(p => {
        const importance = ['high', 'normal', 'low'].includes(p.importance) ? p.importance : 'normal';
        const collapsed = typeof p.collapsed === 'boolean' ? p.collapsed : (importance === 'low');
        const width = (p.width === 'full' || p.width === 'half') ? p.width : null;
        return { id: String(p.id), importance, collapsed, width };
      });
    res.json({
      ok: true,
      zoom: clampNum(parsed.zoom, 0.5, 1.2, 0.9),
      fontScale: clampNum(parsed.fontScale, 0.8, 1.3, 1.0),
      reasoning: clip(parsed.reasoning, 240),
      panels: outPanels,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || 'ai-layout failed' });
  }
});

// Run a PINNED agent on the board, then fold its output back into the assistant so
// it can propose concrete notes/checklists from the fresh result. This is the one
// place the assistant executes anything — and only because the user confirmed it.
app.post('/api/boards/:id/assistant/query', async (req, res) => {
  const raw = loadBoards().find(b => b.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(raw);
  const agentId = String((req.body && req.body.agentId) || '').trim();
  const subPrompt = String((req.body && req.body.prompt) || '').trim();
  const message = String((req.body && req.body.message) || '').trim();
  if (!agentId || !subPrompt) return res.status(400).json({ error: 'Missing agentId or prompt' });
  // The agent MUST be pinned to this board — no querying arbitrary installed agents.
  const pins = Array.isArray(b.items) ? b.items : [];
  const pin = pins.find(p => p.kind === 'agent' && p.refId === agentId);
  if (!pin) return res.status(403).json({ error: 'Agent is not pinned to this board' });
  const entry = supervisor.agents.get(agentId);
  if (!entry || !entry.config) return res.status(404).json({ error: 'Agent not found' });
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
  const name = pin.label || (entry.config.name) || agentId;
  try {
    let acc = '';
    const run = await sdkRunner.runAgent({
      config: entry.config,
      prompt: subPrompt,
      sessionId: require('crypto').randomUUID(),
      model: settings.resolveModel('execution', entry.config),
      onChunk: (c) => { acc += c; },
    });
    const output = ((acc.trim() || (run && run.output) || '').trim()).slice(0, 8000);
    if (run && run.fallback) return res.status(502).json({ ok: false, error: `Could not run ${name}.` });
    const extraContext = `## AGENT RESULT (the user just ran the pinned agent "${name}" to help with their request — use this output now)\n${output || '(the agent produced no output)'}`;
    const followUp = message || `Use the result of "${name}" to fulfil my request.`;
    const depth = Number(req.body && req.body.depth) || 0;
    const out = await runBoardAssistant(b, { message: followUp, history, extraContext, allowQuery: true, depth: depth + 1 });
    res.json({ ok: true, reply: out.reply, actions: out.actions, agentOutput: output, agentLabel: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || 'agent query failed' });
  }
});

// Search a pinned source location, then fold the matches back into the assistant so
// it can answer / build from the real file contents. Mirrors /assistant/query: the
// search runs only because the user confirmed it, and only against a pinned folder.
app.post('/api/boards/:id/assistant/search', async (req, res) => {
  const raw = loadBoards().find(b => b.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Board not found' });
  const b = _normalizeBoard(raw);
  const refId = String((req.body && req.body.refId) || '').trim();
  const query = String((req.body && req.body.query) || '').trim();
  const message = String((req.body && req.body.message) || '').trim();
  if (!refId || !query) return res.status(400).json({ error: 'Missing refId or query' });
  const pins = Array.isArray(b.items) ? b.items : [];
  const pin = pins.find(p => p.kind === 'location' && p.refId === refId);
  if (!pin) return res.status(403).json({ error: 'Location is not pinned to this board' });
  if (!_validDir(refId)) return res.status(404).json({ error: 'Folder not found' });
  const name = pin.label || refId;
  try {
    const matches = _locationSearch(refId, query, 80);
    const lines = matches.slice(0, 60).map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
    const extraContext = `## SEARCH RESULT (the user searched the pinned location "${name}" for "${query}" — use these matches now)\n` + (lines || '(no matches found)');
    const followUp = message || `Use the search results from "${name}" to answer my request.`;
    const depth = Number(req.body && req.body.depth) || 0;
    const out = await runBoardAssistant(b, { message: followUp, history: Array.isArray(req.body && req.body.history) ? req.body.history : [], extraContext, allowQuery: true, depth: depth + 1 });
    res.json({ ok: true, reply: out.reply, actions: out.actions, matches, query, locationLabel: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || 'location search failed' });
  }
});

app.post('/api/managers/:id/start', (req, res) => {
  try {
    managerAgent.startSchedules(req.params.id);
    broadcastSSE('manager-status', { id: req.params.id, status: 'running' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stop a manager's schedules
app.post('/api/managers/:id/stop', (req, res) => {
  managerAgent.stopSchedules(req.params.id);
  broadcastSSE('manager-status', { id: req.params.id, status: 'stopped' });
  res.json({ ok: true });
});

// Run an assignment (async — returns immediately with runId)
app.post('/api/managers/:id/assignments/:assignmentId/run', (req, res) => {
  try {
    const result = managerAgent.runAssignment(req.params.id, req.params.assignmentId);
    broadcastSSE('run-started', { id: req.params.id, assignmentId: req.params.assignmentId, type: 'assignment', timestamp: new Date().toISOString() });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Add an assignment
app.post('/api/managers/:id/assignments', (req, res) => {
  const { id: assignmentId, name, prompt, schedule, enabled, teamId, orgId } = req.body;
  if (!assignmentId || !name || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: id, name, prompt' });
  }

  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });

  if (!entry.config.assignments) entry.config.assignments = [];
  const existingIdx = entry.config.assignments.findIndex(a => a.id === assignmentId);
  const prev = existingIdx >= 0 ? entry.config.assignments[existingIdx] : null;
  const incomingTeam = teamId !== undefined ? teamId : orgId;
  const resolvedTeamId = incomingTeam !== undefined ? (incomingTeam || null) : (prev ? ((prev.teamId !== undefined ? prev.teamId : prev.orgId) || null) : null);
  const assignment = { id: assignmentId, name, prompt, schedule: schedule || 'never', enabled: enabled !== false, teamId: resolvedTeamId };
  if (existingIdx >= 0) {
    entry.config.assignments[existingIdx] = assignment;
  } else {
    entry.config.assignments.push(assignment);
  }

  // Persist
  let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  const mi = managers.findIndex(m => m.id === req.params.id);
  if (mi >= 0) { managers[mi] = entry.config; }
  fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));

  // Restart schedules if this manager has active scheduled assignments
  _restartManagerSchedules(req.params.id);

  res.json({ ok: true });
});

// Delete an assignment
app.delete('/api/managers/:id/assignments/:assignmentId', (req, res) => {
  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });

  entry.config.assignments = (entry.config.assignments || []).filter(a => a.id !== req.params.assignmentId);

  let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  const mi = managers.findIndex(m => m.id === req.params.id);
  if (mi >= 0) { managers[mi] = entry.config; }
  fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));

  // Restart schedules to remove the deleted assignment's timer
  _restartManagerSchedules(req.params.id);

  res.json({ ok: true });
});

// Update a single assignment's schedule
app.put('/api/managers/:id/assignments/:assignmentId/schedule', (req, res) => {
  const { schedule } = req.body;
  if (!schedule) return res.status(400).json({ error: 'schedule required' });

  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });

  const assignment = (entry.config.assignments || []).find(a => a.id === req.params.assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Validate schedule string
  try {
    const { parseSchedule } = require('./scheduler');
    const parsed = parseSchedule(schedule);
    assignment.schedule = schedule;

    // Persist
    let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === req.params.id);
    if (mi >= 0) { managers[mi] = entry.config; }
    fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));

    // Restart schedules
    _restartManagerSchedules(req.params.id);

    res.json({ ok: true, description: parsed.description });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update a single assignment's triggers (downstream assignment chaining)
app.put('/api/managers/:id/assignments/:assignmentId/triggers', (req, res) => {
  // Inline assignment triggers were replaced by Task Chains. Kept as a no-op
  // for backward compatibility with any cached clients.
  res.json({ ok: true, triggers: {} });
});

// Toggle assignment enabled/disabled
app.put('/api/managers/:id/assignments/:assignmentId/toggle', (req, res) => {
  const { enabled } = req.body;
  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });

  const assignment = (entry.config.assignments || []).find(a => a.id === req.params.assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  assignment.enabled = enabled !== false;

  let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  const mi = managers.findIndex(m => m.id === req.params.id);
  if (mi >= 0) { managers[mi] = entry.config; }
  fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));

  _restartManagerSchedules(req.params.id);

  res.json({ ok: true, enabled: assignment.enabled });
});

// Helper: restart schedules for a manager if it has any scheduled assignments
function _restartManagerSchedules(managerId) {
  const entry = managerAgent.managers.get(managerId);
  if (!entry) return;
  const hasScheduled = (entry.config.assignments || []).some(
    a => a.enabled !== false && a.schedule && a.schedule.toLowerCase() !== 'never'
  );
  if (hasScheduled) {
    managerAgent.startSchedules(managerId);
  } else {
    managerAgent.stopSchedules(managerId);
  }
}

// Ad-hoc prompt to a manager (async — returns immediately with runId)
app.post('/api/managers/:id/prompt', (req, res) => {
  const { prompt, liveStream } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const result = managerAgent.executePrompt(req.params.id, prompt, null, { liveStream: !!liveStream });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Poll a manager run for live status
app.get('/api/managers/:id/runs/:runId', (req, res) => {
  const run = managerAgent.getRun(parseInt(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const messages = managerAgent.getRunMessages(req.params.id, parseInt(req.params.runId));
  res.json({ ...run, messages, steps: JSON.parse(run.steps || '[]') });
});

// Get manager run history
app.get('/api/managers/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(managerAgent.getRunHistory(req.params.id, limit));
});

// Manager statistics
app.get('/api/managers/:id/stats', (req, res) => {
  const managerId = req.params.id;
  const rows = db.prepare(`SELECT status, started_at, finished_at FROM manager_runs WHERE manager_id = ? ORDER BY started_at DESC`).all(managerId);
  const total = rows.length;
  const success = rows.filter(r => r.status === 'completed').length;
  const fail = rows.filter(r => r.status === 'error').length;
  const durations = rows.filter(r => r.started_at && r.finished_at).map(r => new Date(r.finished_at) - new Date(r.started_at));
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const lastRun = rows.length > 0 ? rows[0].started_at : null;
  res.json({ total, success, fail, avgDuration, lastRun });
});

// Get manager messages (chat history)
app.get('/api/managers/:id/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(managerAgent.getMessages(req.params.id, limit));
});

// Manage team: add agent
app.post(['/api/managers/:id/team', '/api/managers/:id/org'], (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  try {
    managerAgent.addToOrg(req.params.id, agentId);
    // Persist
    let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === req.params.id);
    if (mi >= 0) { managers[mi].team = managerAgent.managers.get(req.params.id).config.team; delete managers[mi].org; }
    fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manage team: remove agent
app.delete(['/api/managers/:id/team/:agentId', '/api/managers/:id/org/:agentId'], (req, res) => {
  try {
    managerAgent.removeFromOrg(req.params.id, req.params.agentId);
    // Persist
    let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === req.params.id);
    if (mi >= 0) { managers[mi].team = managerAgent.managers.get(req.params.id).config.team; delete managers[mi].org; }
    fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get available agents not in manager's team
app.get('/api/managers/:id/available-agents', (req, res) => {
  res.json(managerAgent.getAvailableAgents(req.params.id));
});

// Open manager agent file in VS Code
app.post('/api/managers/:id/edit-agent', (req, res) => {
  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });
  const agentRef = entry.config.agent || 'manager:manager';
  const [plugin, agent] = agentRef.split(':');
  const agentFile = path.join(PLUGINS_DIR, plugin, 'agents', `${agent}.agent.md`);
  if (!fs.existsSync(agentFile)) return res.status(404).json({ error: `Agent file not found: ${agentFile}` });
  const { spawn: sp } = require('child_process');
  sp('code-insiders', [agentFile], { shell: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true, file: agentFile });
});

// ----- Manager Templates (the built-in "backing agents" managers derive from) -----
// A template is a <name>.agent.md file under builtin-plugins/manager/agents/.
// Managers reference one via config.agent === `manager:<name>`.
const MANAGER_AGENTS_DIR = path.join(PLUGINS_DIR, 'manager', 'agents');
const PROTECTED_MANAGER_TEMPLATES = new Set(['manager']);

function ensureManagerAgentsDir() {
  if (!fs.existsSync(MANAGER_AGENTS_DIR)) fs.mkdirSync(MANAGER_AGENTS_DIR, { recursive: true });
}

// Split a .agent.md into { frontmatter (raw), body, fields }
function parseManagerAgentFile(content) {
  content = String(content).replace(/\r\n?/g, '\n');
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fields: {}, tools: [], body: content.trim() };
  const fm = m[1];
  const body = (m[2] || '').replace(/^\n+/, '');
  const fields = {};
  const tools = [];
  let inTools = false;
  for (const line of fm.split('\n')) {
    const toolItem = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (inTools && toolItem) { tools.push(toolItem[1].trim()); continue; }
    inTools = false;
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (key === 'tools' && val === '') { inTools = true; continue; }
    fields[key] = val.replace(/^['"]|['"]$/g, '');
  }
  return { fields, tools, body };
}

function buildManagerAgentFile({ name, description, tools, body }) {
  const toolList = (Array.isArray(tools) ? tools : [])
    .map(t => String(t).trim()).filter(Boolean);
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (toolList.length) {
    lines.push('tools:');
    for (const t of toolList) lines.push(`  - '${t}'`);
  }
  lines.push('---', '', (body || '').trim(), '');
  return lines.join('\n');
}

// Remove any "## Response Format" section from a template body. The action-block
// contract is shared across all managers and injected at runtime, so it must
// never live in (or be editable from) an individual template — that would let a
// template drift and break orchestration. Strips the heading through the next
// heading of any level (or end of body).
function stripResponseFormatSection(body) {
  if (!body) return body;
  const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const title = h[2].trim().toLowerCase();
      if (title === 'response format') { skipping = true; continue; }
      if (skipping) skipping = false; // next heading ends the skipped section
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function managerTemplateUsage(name) {
  let managers = [];
  try {
    if (fs.existsSync(MANAGERS_PATH)) managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
  } catch { managers = []; }
  const ref = `manager:${name}`;
  const usedBy = managers.filter(m => (m.agent || 'manager:manager') === ref).map(m => ({ id: m.id, name: m.name }));
  return usedBy;
}

function readManagerTemplate(name) {
  const file = path.join(MANAGER_AGENTS_DIR, `${name}.agent.md`);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf-8');
  const parsed = parseManagerAgentFile(content);
  const usedBy = managerTemplateUsage(name);
  return {
    id: `manager:${name}`,
    name,
    description: parsed.fields.description || '',
    tools: parsed.tools,
    body: parsed.body,
    raw: content,
    builtin: PROTECTED_MANAGER_TEMPLATES.has(name),
    inUse: usedBy.length,
    usedBy
  };
}

// List available manager templates (a.k.a. backing agent variants)
app.get('/api/manager-agents', (req, res) => {
  ensureManagerAgentsDir();
  if (!fs.existsSync(MANAGER_AGENTS_DIR)) return res.json([]);
  const files = fs.readdirSync(MANAGER_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
  const variants = files.map(f => {
    const name = f.replace('.agent.md', '');
    const t = readManagerTemplate(name);
    return {
      id: `manager:${name}`,
      name,
      description: t?.description || '',
      builtin: t?.builtin || false,
      inUse: t?.inUse || 0,
      usedBy: t?.usedBy || []
    };
  });
  res.json(variants);
});

// Get a single manager template (full content)
app.get('/api/manager-agents/:name', (req, res) => {
  const t = readManagerTemplate(req.params.name);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

// Create a new manager template
app.post('/api/manager-agents', (req, res) => {
  ensureManagerAgentsDir();
  const { name, description, tools, body } = req.body || {};
  const clean = String(name || '').trim().toLowerCase();
  if (!clean || !/^[a-z0-9][a-z0-9-]*$/.test(clean)) {
    return res.status(400).json({ error: 'Template name must be lowercase letters, numbers, and dashes (e.g. "incident-manager").' });
  }
  const file = path.join(MANAGER_AGENTS_DIR, `${clean}.agent.md`);
  if (fs.existsSync(file)) return res.status(409).json({ error: `A template named "${clean}" already exists.` });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Template body (the orchestration instructions) is required.' });
  const content = buildManagerAgentFile({
    name: clean,
    description: String(description || '').trim(),
    tools: tools && tools.length ? tools : ['powershell'],
    body: stripResponseFormatSection(body)
  });
  fs.writeFileSync(file, content);
  res.json(readManagerTemplate(clean));
});

// Update an existing manager template (name is immutable to preserve references)
app.put('/api/manager-agents/:name', (req, res) => {
  const name = req.params.name;
  const file = path.join(MANAGER_AGENTS_DIR, `${name}.agent.md`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Template not found' });
  const { description, tools, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Template body is required.' });
  const content = buildManagerAgentFile({
    name,
    description: String(description || '').trim(),
    tools: tools && tools.length ? tools : ['powershell'],
    body: stripResponseFormatSection(body)
  });
  fs.writeFileSync(file, content);
  res.json(readManagerTemplate(name));
});

// Delete a manager template (blocked if built-in or actively used by a manager)
app.delete('/api/manager-agents/:name', (req, res) => {
  const name = req.params.name;
  const file = path.join(MANAGER_AGENTS_DIR, `${name}.agent.md`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Template not found' });
  if (PROTECTED_MANAGER_TEMPLATES.has(name)) {
    return res.status(409).json({ error: 'The default Manager Template cannot be removed.' });
  }
  const usedBy = managerTemplateUsage(name);
  if (usedBy.length) {
    return res.status(409).json({ error: `Template is in use by ${usedBy.length} manager(s): ${usedBy.map(m => m.name).join(', ')}. Reassign them first.` });
  }
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ===== Shared manager Response Format (the action-block contract) =====
// One definition, used by every manager via manager.js _buildManagerSystemPrompt,
// so editing it can't break orchestration for one template while leaving others.
app.get('/api/manager-response-format', (req, res) => {
  const format = ManagerAgent.loadResponseFormat();
  const isDefault = format.trim() === String(ManagerAgent.DEFAULT_RESPONSE_FORMAT).trim();
  res.json({ format, isDefault, default: ManagerAgent.DEFAULT_RESPONSE_FORMAT });
});

app.put('/api/manager-response-format', (req, res) => {
  const { format } = req.body || {};
  const txt = String(format == null ? '' : format).replace(/\r\n?/g, '\n').trim();
  if (!txt) return res.status(400).json({ error: 'Response format cannot be empty.' });
  // Guard: the manager decision parser keys off these verbs — refuse a format
  // that drops any of them so a manager can never be left unable to act.
  for (const verb of ['RUN_AGENT', 'COMPLETE', 'REQUEST_AGENT']) {
    if (!txt.includes(verb)) {
      return res.status(400).json({ error: `Response format must still define ${verb} — the manager parser depends on it.` });
    }
  }
  try {
    fs.mkdirSync(path.dirname(ManagerAgent.RESPONSE_FORMAT_PATH), { recursive: true });
    fs.writeFileSync(ManagerAgent.RESPONSE_FORMAT_PATH, txt + '\n');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save response format: ' + e.message });
  }
  res.json({ ok: true, format: txt, isDefault: txt === String(ManagerAgent.DEFAULT_RESPONSE_FORMAT).trim() });
});

// Reset the shared response format to the built-in default.
app.delete('/api/manager-response-format', (req, res) => {
  try { if (fs.existsSync(ManagerAgent.RESPONSE_FORMAT_PATH)) fs.unlinkSync(ManagerAgent.RESPONSE_FORMAT_PATH); } catch (_) {}
  res.json({ ok: true, format: ManagerAgent.DEFAULT_RESPONSE_FORMAT, isDefault: true });
});

// ===== Manager Template dev assistant =====
// A copilot-backed chat that helps the user design a manager template persona and,
// once aligned, emits a ```template JSON block the UI can apply. The shared action
// contract is injected globally, so the assistant is told NOT to include it.
const MANAGER_TEMPLATE_ASSISTANT_PERSONA = [
  'You are the Manager Template Dev Assistant for an agent-orchestration platform.',
  'Your job is to help the user design a "manager template" — the persona/brain for a Manager that ORCHESTRATES other agents (it never does work itself; it decides which sub-agent to run and in what order).',
  '',
  'Key facts about how managers work here:',
  '- A manager runs ONE sub-agent per turn, reviews the output, then decides the next action.',
  '- The machine-readable action-block response format (RUN_AGENT / COMPLETE / REQUEST_AGENT) is injected automatically at runtime and is shared across ALL managers. NEVER include it, restate it, or describe its syntax in the template body — that would duplicate and risk breaking it.',
  '- The template body should focus on: persona/identity, what this manager is responsible for, decision guidelines (when to run which kind of agent, how to sequence them, how to pass context forward), tone, and how to summarize results for the user.',
  '',
  'How to collaborate:',
  '- Ask brief clarifying questions about the manager\'s purpose, the kinds of agents it will coordinate, and any decision rules.',
  '- Keep replies concise and conversational.',
  '- When (and only when) you and the user are aligned on the design, output the proposal as a single fenced code block tagged `template` containing JSON with keys: name (kebab-case slug), description (one line), tools (array, default ["powershell"]), body (the markdown persona, WITHOUT any response-format/action-block section). Example:',
  '```template',
  '{',
  '  "name": "incident-manager",',
  '  "description": "Coordinates monitoring and notification agents during incidents",',
  '  "tools": ["powershell"],',
  '  "body": "# Incident Manager\\n\\nYou coordinate ..."',
  '}',
  '```',
  '- Before emitting the block, briefly confirm with the user. After emitting it, tell them they can review and click Apply to create/update the template.',
].join('\n');

app.post('/api/manager-template-assistant/chat', async (req, res) => {
  const { message, sessionId: incomingId, resume } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });
  const sessionId = incomingId || require('crypto').randomUUID();
  const isResume = !!resume && !!incomingId;
  const prompt = isResume
    ? String(message)
    : MANAGER_TEMPLATE_ASSISTANT_PERSONA + '\n\n## User\n' + String(message);
  try {
    let acc = '';
    const result = await sdkRunner.runChat({
      config: null, prompt, sessionId, resume: isResume, cwd: __dirname,
      onChunk: (c) => { acc += c; }
    });
    // Deltas fire only for the current turn, so `acc` is just this reply. The
    // result.output joins ALL assistant messages in the session (every prior
    // turn too) — only fall back to it when no deltas streamed.
    const output = acc.trim() ? acc : (result.output || '');
    if (!result.ok && !output) {
      return res.status(500).json({ error: result.error || 'assistant failed', sessionId });
    }
    res.json({ sessionId, output, steps: Array.isArray(result.steps) ? result.steps : [] });
  } catch (e) {
    res.status(500).json({ error: e.message, sessionId });
  }
});

// ============ End Manager API Routes ============

// ============ Execution "Design with AI" suggestions ============
// AI looks at the available agents/tasks/flows and proposes creative NEW manual
// tasks and flows. Suggestions are ephemeral (generated on demand) unless the
// user pins them; pinned ones persist in suggestions.json. Users can try-run a
// suggestion (ephemeral, nothing saved) or "save" it into the real Tasks/Flows.
const SUGGESTIONS_PATH = path.join(__dirname, 'suggestions.json');
function loadPinnedSuggestions() {
  try { return JSON.parse(fs.readFileSync(SUGGESTIONS_PATH, 'utf-8')); }
  catch { return []; }
}
function savePinnedSuggestions(list) {
  fs.writeFileSync(SUGGESTIONS_PATH, JSON.stringify(list, null, 2));
  if (configSync.enabled) configSync.pushConfig().catch(e => console.warn('[sync] auto-push (suggestions) failed:', e.message));
}
// Last-generated (unpinned) suggestion set, so the Design-with-AI page can show
// the most recent ideas on revisit/reload instead of regenerating every time.
const LATEST_SUGGESTIONS_PATH = path.join(__dirname, 'suggestions-latest.json');
function loadLatestSuggestions() {
  try { return JSON.parse(fs.readFileSync(LATEST_SUGGESTIONS_PATH, 'utf-8')); }
  catch { return null; }
}
function saveLatestSuggestions(obj) {
  try { fs.writeFileSync(LATEST_SUGGESTIONS_PATH, JSON.stringify(obj, null, 2)); }
  catch (e) { console.warn('[suggestions] could not persist latest:', e.message); }
}
// Ephemeral try-run buffers, keyed by runId.
const suggestionRuns = new Map();

function suggestionAgentCatalog(teamId) {
  let list = supervisor.getAllStatus();
  // When designing inside a specific team, only offer that team's
  // member agents so generated tasks/flows never depend on outside agents.
  if (teamId && teamId !== 'all') {
    const team = (loadTeams() || []).find(o => o.id === teamId);
    const members = new Set((team && team.memberIds) || []);
    list = list.filter(a => members.has(a.agent_id));
  }
  return list.map(a => ({
    id: a.agent_id,
    name: (a.config && a.config.name) || a.agent_id,
    description: (a.config && a.config.description) || '',
    skills: (a.config && a.config.skills) || []
  }));
}

// Pull a JSON array out of an AI reply (fenced ```json block, or first [...]).
function parseSuggestionJson(text) {
  if (!text) return null;
  let body = null;
  const fence = String(text).match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) body = fence[1];
  if (!body) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) body = text.slice(start, end + 1);
  }
  if (!body) return null;
  try { const parsed = JSON.parse(body.trim()); return Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

// Normalize a flow-step gate condition into one of the three chain-edge types.
function normalizeSuggestionCondition(raw) {
  if (!raw || typeof raw !== 'object') return { type: 'status', status: 'onSuccess' };
  if (raw.type === 'expression') {
    const ops = ['contains', 'notContains', 'regex', 'equals', 'gt', 'lt'];
    return { type: 'expression', op: ops.includes(raw.op) ? raw.op : 'contains', value: String(raw.value || ''), source: 'output' };
  }
  if (raw.type === 'ai') {
    return { type: 'ai', predicate: String(raw.predicate || '').trim(), agentId: null };
  }
  const statuses = ['onSuccess', 'onFailure', 'onComplete'];
  return { type: 'status', status: statuses.includes(raw.status) ? raw.status : 'onSuccess' };
}

// Human-readable one-liner for a gate condition (used in Try-run output).
function describeSuggestionCondition(c) {
  if (!c) return 'always';
  if (c.type === 'ai') return 'AI decision: ' + (c.predicate || '(no predicate)');
  if (c.type === 'expression') return `if output ${c.op} "${c.value}"`;
  if (c.type === 'status') return 'if previous ' + (c.status === 'onSuccess' ? 'succeeds' : c.status === 'onFailure' ? 'fails' : 'completes');
  return 'condition';
}

function normalizeSuggestion(raw, validAgentIds) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'flow' ? 'flow' : 'task';
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const base = {
    id: 'sug-' + require('crypto').randomBytes(5).toString('hex'),
    kind, title,
    description: String(raw.description || '').trim()
  };
  if (kind === 'task') {
    const agentId = String(raw.agentId || '').trim();
    if (!validAgentIds.has(agentId)) return null;
    base.agentId = agentId;
    base.prompt = String(raw.prompt || '').trim();
    if (!base.prompt) return null;
  } else {
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .map(s => ({
        agentId: String(s.agentId || '').trim(),
        title: String(s.title || '').trim(),
        prompt: String(s.prompt || '').trim(),
        // Gate controlling whether this step runs, based on the previous step's output.
        condition: normalizeSuggestionCondition(s.condition)
      }))
      .filter(s => validAgentIds.has(s.agentId) && s.prompt);
    if (steps.length < 2) return null; // a flow needs at least two steps
    delete steps[0].condition; // the first step has no incoming gate
    base.steps = steps;
  }
  return base;
}

app.post('/api/execution-suggestions/generate', async (req, res) => {
  const teamId = String((req.body && (req.body.teamId !== undefined ? req.body.teamId : req.body.orgId)) || '').trim();
  const agents = suggestionAgentCatalog(teamId);
  if (!agents.length) {
    const scoped = teamId && teamId !== 'all';
    const team = scoped ? (loadTeams() || []).find(o => o.id === teamId) : null;
    return res.status(400).json({ error: scoped
      ? `${(team && team.name) || 'This team'} has no agents to design with. Add agents to this team first.`
      : 'No agents available to design with.' });
  }
  const validIds = new Set(agents.map(a => a.id));
  const tasks = loadTasks().map(t => ({ name: t.name, agentId: t.agentId, prompt: String(t.prompt || '').slice(0, 200) }));
  let chains = [];
  try { chains = chainEngine.list().map(c => ({ name: c.name, description: c.description, steps: (c.steps || []).map(s => s.taskId) })); } catch (_) {}
  const hint = String((req.body && req.body.hint) || '').trim();
  const focusAgentId = String((req.body && req.body.focusAgentId) || '').trim();
  const focusAgent = focusAgentId && validIds.has(focusAgentId)
    ? agents.find(a => a.id === focusAgentId)
    : null;

  const prompt = [
    'You are an automation strategist for an agent-orchestration platform. Propose CREATIVE, GENUINELY USEFUL new things the user could run, by combining their existing agents in ways they may not have considered.',
    '',
    'AVAILABLE AGENTS (only ever reference these exact ids):',
    JSON.stringify(agents, null, 2),
    '',
    'EXISTING TASKS (for context — do not just repeat these):',
    JSON.stringify(tasks, null, 2),
    '',
    'EXISTING FLOWS (for context):',
    JSON.stringify(chains, null, 2),
    '',
    hint ? ('USER FOCUS: ' + hint) : 'No specific focus — surprise the user with a useful mix.',
    '',
    focusAgent
      ? ('FOCUS AGENT (HARD REQUIREMENT): Every single suggestion MUST involve the agent id "' + focusAgent.id + '"' + (focusAgent.name ? ' (' + focusAgent.name + ')' : '') + '. '
         + 'For "task" suggestions, that agent MUST be the agentId. For "flow" suggestions, that agent MUST appear as one of the steps (it can be the first step that produces data, or a later step that acts on prior output — whichever is most natural). '
         + 'Do NOT propose any suggestion that omits this agent. Design the other steps/agents around it.')
      : 'No focus agent — feel free to use any mix of the available agents.',
    '',
    'Propose 5 suggestions. Each is either:',
    '- a "task": a single agent run with a specific, ready-to-run prompt, OR',
    '- a "flow": 2-4 agents chained in sequence, where each step\'s output feeds the next. In a flow step prompt, use {{previous}} to reference the prior step\'s output.',
    'All suggestions are MANUAL (run on demand, no schedules). Favor flows that turn raw monitoring/data agents into actionable outcomes (notify, summarize, file, decide).',
    '',
    'FLOW CONDITIONALS — every flow step AFTER THE FIRST carries a "condition" that decides whether it runs, evaluated against the PREVIOUS step\'s output. Pick the most appropriate type:',
    '  - { "type": "status", "status": "onSuccess" | "onFailure" | "onComplete" } — gate purely on whether the previous step succeeded, failed, or just finished.',
    '  - { "type": "expression", "op": "contains" | "notContains" | "regex" | "equals" | "gt" | "lt", "value": "..." } — a deterministic text/number check on the previous output.',
    '  - { "type": "ai", "predicate": "<a crisp true/false statement about the previous output>" } — an AI DECISION. Use this whenever the branch depends on judgement/interpretation, e.g. "Azure has an outage or degraded service", "the report contains an error worth alerting on".',
    'IMPORTANT: When the flow is "do X, and only if the result indicates a problem do Y" (alerting/escalation patterns), the gate into Y MUST be an "ai" decision with a precise predicate — do not just use onSuccess. The first step never has a condition.',
    '',
    'Respond with ONLY a JSON array (no prose) in this exact shape:',
    '```json',
    '[',
    '  { "kind": "task", "title": "...", "description": "one line", "agentId": "<agent id>", "prompt": "..." },',
    '  { "kind": "flow", "title": "...", "description": "one line", "steps": [',
    '      { "agentId": "<id>", "title": "step name", "prompt": "..." },',
    '      { "agentId": "<id>", "title": "step name", "prompt": "... {{previous}} ...", "condition": { "type": "ai", "predicate": "the previous output indicates a problem worth acting on" } }',
    '  ] }',
    ']',
    '```'
  ].join('\n');

  try {
    let acc = '';
    const result = await sdkRunner.runChat({
      config: null, prompt, sessionId: require('crypto').randomUUID(), resume: false, cwd: __dirname,
      onChunk: (c) => { acc += c; }
    });
    const text = acc.trim() ? acc : (result.output || '');
    const arr = parseSuggestionJson(text);
    if (!arr) return res.status(502).json({ error: 'Could not parse AI suggestions. Try refreshing.', raw: text.slice(0, 500) });
    let suggestions = arr.map(s => normalizeSuggestion(s, validIds)).filter(Boolean);
    if (focusAgent) {
      const involvesFocus = (s) => s.kind === 'task'
        ? s.agentId === focusAgent.id
        : Array.isArray(s.steps) && s.steps.some(st => st.agentId === focusAgent.id);
      suggestions = suggestions.filter(involvesFocus);
    }
    if (!suggestions.length) return res.status(502).json({ error: 'AI returned no valid suggestions. Try refreshing.' });
    saveLatestSuggestions({ suggestions, hint, focusAgentId: focusAgent ? focusAgent.id : '', generatedAt: new Date().toISOString() });
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/execution-suggestions', (req, res) => {
  res.json({ pinned: loadPinnedSuggestions(), latest: loadLatestSuggestions() });
});

app.post('/api/execution-suggestions/pin', (req, res) => {
  const sug = req.body && req.body.suggestion;
  if (!sug || !sug.id || !sug.title) return res.status(400).json({ error: 'suggestion required' });
  const list = loadPinnedSuggestions();
  if (!list.some(s => s.id === sug.id)) { list.push({ ...sug, pinnedAt: new Date().toISOString() }); savePinnedSuggestions(list); }
  res.json({ ok: true, pinned: list });
});

app.delete('/api/execution-suggestions/:id', (req, res) => {
  const list = loadPinnedSuggestions();
  const next = list.filter(s => s.id !== req.params.id);
  savePinnedSuggestions(next);
  res.json({ ok: true, pinned: next });
});

// Migrate a suggestion into the real Tasks/Flows sections (manual, no schedule).
app.post('/api/execution-suggestions/save', (req, res) => {
  const sug = req.body && req.body.suggestion;
  const teamId = (req.body && (req.body.teamId !== undefined ? req.body.teamId : req.body.orgId)) || null;
  if (!sug || !sug.kind) return res.status(400).json({ error: 'suggestion required' });
  try {
    if (sug.kind === 'task') {
      if (!sug.agentId || !sug.prompt) return res.status(400).json({ error: 'task suggestion missing agent or prompt' });
      const tasks = loadTasks();
      const id = 'task-ai-' + require('crypto').randomBytes(4).toString('hex');
      const task = { id, name: sug.title || 'AI Task', agentId: sug.agentId, prompt: sug.prompt, schedule: 'never', enabled: true, teamId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      tasks.push(task); saveTasks(tasks);
      return res.json({ ok: true, type: 'task', id, name: task.name });
    }
    // flow: create a backing task per step, then a sequential onSuccess chain.
    const steps = Array.isArray(sug.steps) ? sug.steps : [];
    if (steps.length < 2) return res.status(400).json({ error: 'flow suggestion needs at least two steps' });
    const tasks = loadTasks();
    const chainSteps = [];
    steps.forEach((st, i) => {
      const tid = 'task-ai-' + require('crypto').randomBytes(4).toString('hex');
      tasks.push({ id: tid, name: (st.title || (sug.title + ' step ' + (i + 1))), agentId: st.agentId, prompt: st.prompt, schedule: 'never', enabled: true, teamId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      chainSteps.push({ id: 's' + (i + 1), taskId: tid, prompt: st.prompt });
    });
    saveTasks(tasks);
    const edges = [];
    for (let i = 0; i < chainSteps.length - 1; i++) {
      // The gate lives on the step being entered (the next step).
      const next = steps[i + 1];
      const condition = (next && next.condition) ? next.condition : { type: 'status', status: 'onSuccess' };
      edges.push({ from: chainSteps[i].id, to: chainSteps[i + 1].id, condition });
    }
    const chain = chainEngine.create({ name: sug.title || 'AI Flow', description: sug.description || '', schedule: 'never', enabled: true, teamId, steps: chainSteps, edges });
    res.json({ ok: true, type: 'flow', id: chain.id, name: chain.name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Ephemeral try-run: execute the suggestion now without persisting anything.
function startSuggestionRun(suggestion) {
  const runId = require('crypto').randomUUID();
  const buf = { running: true, kind: suggestion.kind, title: suggestion.title, steps: [], startedAt: Date.now(), error: null };
  suggestionRuns.set(runId, buf);
  (async () => {
    try {
      const list = suggestion.kind === 'flow'
        ? suggestion.steps
        : [{ agentId: suggestion.agentId, title: suggestion.title, prompt: suggestion.prompt }];
      let prev = '';
      let prevOk = true;
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        const stepRec = {
          agentId: st.agentId, title: st.title || st.agentId,
          running: true, output: '', ok: false, skipped: false,
          condition: st.condition || null, conditionReason: null
        };
        buf.steps.push(stepRec);
        // Evaluate the gate (against the previous step's result) before running this step.
        if (i > 0 && st.condition) {
          let verdict;
          try {
            verdict = await chainEngine._evaluate(st.condition, { code: prevOk ? 0 : 1, output: prev }, null);
          } catch (e) { verdict = { pass: false, reason: 'evaluation error: ' + e.message }; }
          stepRec.conditionReason = verdict.reason || '';
          if (!verdict.pass) {
            stepRec.running = false;
            stepRec.skipped = true;
            stepRec.output = `Skipped — ${describeSuggestionCondition(st.condition)} → ${verdict.reason || 'condition not met'}`;
            break; // linear flow: a failed gate stops the chain
          }
        }
        const entry = supervisor.agents.get(st.agentId);
        if (!entry) { stepRec.running = false; stepRec.output = `Agent "${st.agentId}" is not installed.`; break; }
        const p = String(st.prompt || '').replace(/\{\{\s*(?:previous|output|trigger\.output)\s*\}\}/gi, prev);
        const r = await sdkRunner.runAgent({ config: entry.config, prompt: p, sessionId: require('crypto').randomUUID() });
        stepRec.running = false;
        stepRec.ok = !!r.ok;
        stepRec.output = r.output || r.error || '(no output)';
        prev = stepRec.output;
        prevOk = stepRec.ok;
        // Do not break on failure: the next step's gate (e.g. onFailure / AI decision) decides.
      }
    } catch (e) {
      buf.error = e.message;
    } finally {
      buf.running = false;
      buf.finishedAt = Date.now();
    }
  })();
  return runId;
}

app.post('/api/execution-suggestions/run', (req, res) => {
  const sug = req.body && req.body.suggestion;
  if (!sug || !sug.kind) return res.status(400).json({ error: 'suggestion required' });
  if (sug.kind === 'task' && (!sug.agentId || !sug.prompt)) return res.status(400).json({ error: 'task suggestion missing agent or prompt' });
  if (sug.kind === 'flow' && !(Array.isArray(sug.steps) && sug.steps.length)) return res.status(400).json({ error: 'flow suggestion has no steps' });
  const runId = startSuggestionRun(sug);
  res.json({ ok: true, runId });
});

app.get('/api/execution-suggestions/run/:runId', (req, res) => {
  const buf = suggestionRuns.get(req.params.runId);
  if (!buf) return res.status(404).json({ error: 'run not found' });
  res.json({
    running: buf.running, error: buf.error,
    startedAt: buf.startedAt, finishedAt: buf.finishedAt || null,
    steps: buf.steps.map(s => ({ agentId: s.agentId, title: s.title, running: s.running, ok: s.ok, skipped: !!s.skipped, condition: s.condition || null, conditionReason: s.conditionReason || null, output: String(s.output || '').slice(0, 8000) }))
  });
});


// ============ Chat Persistence API ============
const CHATS_DIR = path.join(__dirname, 'chats');
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

app.get('/api/chats', (req, res) => {
  if (!fs.existsSync(CHATS_DIR)) return res.json([]);
  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
  const chats = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf-8'));
      return { id: data.id, title: data.title, target: data.target, targetType: data.targetType, source: data.source || null, cliSessionId: data.cliSessionId || null, updatedAt: data.updatedAt, messageCount: (data.messages || []).length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(chats);
});

app.get('/api/chats/:id', (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(chatFile)) return res.status(404).json({ error: 'Chat not found' });
  let chat = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
  // CLI-backed chats mirror an interactive copilot session — refresh on read.
  if (chat.source === 'cli') chat = syncCliChat(chat);
  res.json(chat);
});

app.post('/api/chats', (req, res) => {
  const { id, title, target, targetType } = req.body;
  if (!id || !target) return res.status(400).json({ error: 'id and target required' });
  const chat = { id, title: title || `Chat with ${target}`, target, targetType: targetType || 'agent', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(CHATS_DIR, `${id}.json`), JSON.stringify(chat, null, 2));
  res.json(chat);
});

app.post('/api/chats/:id/messages', (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(chatFile)) return res.status(404).json({ error: 'Chat not found' });
  const chat = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
  const msg = { role: req.body.role || 'user', content: req.body.content, timestamp: new Date().toISOString() };
  // Persist optional captured reasoning/step activity so the verbose/live trace
  // survives reloads and can be reviewed (collapsed) under the response.
  if (req.body.activity && Array.isArray(req.body.activity) && req.body.activity.length) msg.activity = req.body.activity;
  if (req.body.runId) msg.runId = req.body.runId;
  if (req.body.model) msg.model = req.body.model;
  chat.messages.push(msg);
  chat.updatedAt = msg.timestamp;
  fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2));
  broadcastSSE('chat-message', { chatId: req.params.id, message: msg });
  res.json(msg);
});

// Rename a conversation (manual title edit from the UI).
app.patch('/api/chats/:id', (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(chatFile)) return res.status(404).json({ error: 'Chat not found' });
  const chat = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
  if (typeof req.body.title === 'string') {
    const t = req.body.title.trim();
    if (t) chat.title = t.slice(0, 120);
  }
  fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2));
  broadcastSSE('chat-updated', { chatId: chat.id, title: chat.title });
  res.json({ id: chat.id, title: chat.title });
});

// Ask the model for a short, topic-specific title once a conversation has a
// real exchange. Default ("Chat with X") titles are auto-upgraded; an explicit
// {force:true} regenerates regardless. Cheap one-shot — runs once per thread.
app.post('/api/chats/:id/autotitle', async (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(chatFile)) return res.status(404).json({ error: 'Chat not found' });
  const chat = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
  const force = !!(req.body && req.body.force);
  if (!force && chat.title && !/^Chat with /i.test(chat.title)) {
    return res.json({ title: chat.title, unchanged: true });
  }
  const firstUser = (chat.messages || []).find(m => m.role === 'user');
  const firstAsst = (chat.messages || []).find(m => m.role && m.role !== 'user');
  if (!firstUser) return res.status(400).json({ error: 'no user message yet' });
  const userText = String(firstUser.content || '').slice(0, 1500);
  const asstText = String((firstAsst && firstAsst.content) || '').slice(0, 800);
  const prompt = [
    'Generate a short, specific title summarizing the topic of this conversation.',
    'Rules: 3 to 6 words, Title Case, no surrounding quotes, no trailing punctuation, no emojis.',
    'Respond with ONLY the title text on a single line — nothing else.',
    '',
    'User message:',
    userText,
    asstText ? ('\nAssistant reply (context only):\n' + asstText) : '',
    '',
    'Title:'
  ].join('\n');
  try {
    let acc = '';
    const result = await sdkRunner.runChat({
      config: null, prompt, sessionId: require('crypto').randomUUID(), cwd: __dirname,
      onChunk: (c) => { acc += c; }
    });
    let title = (acc.trim() || result.output || '').trim();
    title = (title.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
    title = title.replace(/^["'`*#>\s]+/, '').replace(/["'`*\s]+$/, '').replace(/[.;:,]+$/, '').trim();
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 10) title = words.slice(0, 10).join(' ');
    if (title.length > 80) title = title.slice(0, 80).trim();
    if (!title) return res.json({ title: chat.title, unchanged: true });
    chat.title = title;
    fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2));
    broadcastSSE('chat-updated', { chatId: chat.id, title });
    res.json({ title });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'autotitle failed' });
  }
});

app.delete('/api/chats/:id', (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (fs.existsSync(chatFile)) fs.unlinkSync(chatFile);
  res.json({ ok: true });
});

// ============ End Chat API ============

// Unified view of every scheduled item (agents, tasks, manager assignments, flows).
// Only manual / "never" items are excluded — disabled-but-scheduled items are
// included (flagged enabled:false) so they can be re-enabled from the dashboard.
// Returns last run + computed next run, sorted soonest-first.
app.get('/api/schedules', (req, res) => {
  const { getNextRun, parseSchedule } = require('./scheduler');
  const isScheduled = (s) => s && String(s).trim().toLowerCase() !== 'never';
  const describe = (s) => { try { return parseSchedule(s).description; } catch { return String(s); } };
  const nextRunIso = (s) => { try { const n = getNextRun(s); return n ? n.toISOString() : null; } catch { return null; } };
  const agentStatus = (row) => {
    if (!row) return null;
    if (row.finished_at == null && row.exit_code == null) return 'running';
    return row.exit_code === 0 ? 'success' : 'failed';
  };
  const out = [];

  try {
    // Policy: only tasks, assignments, and flows have saved schedules. Agents are
    // intentionally NOT enumerated here — an agent runs via its scheduled Tasks,
    // triggers, or manual execution, never on its own saved schedule.

    // Scheduled tasks (fire an agent with the task prompt). Tasks are tracked
    // separately from the underlying agent via the task_id column on agent_runs.
    for (const task of loadTasks()) {
      if (!isScheduled(task.schedule)) continue;
      const agentEntry = supervisor.agents.get(task.agentId);
      const last = db.prepare('SELECT started_at, finished_at, exit_code FROM agent_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(task.id);
      out.push({
        type: 'task', id: task.id, name: task.name,
        parentName: agentEntry ? (agentEntry.config.name || task.agentId) : task.agentId,
        schedule: task.schedule, scheduleDescription: describe(task.schedule), enabled: task.enabled !== false,
        nextRun: nextRunIso(task.schedule), lastRun: last ? last.started_at : null, lastStatus: agentStatus(last),
        href: '#/tasks'
      });
    }

    // Manager assignments (a manager is "scheduled" when it has scheduled assignments)
    for (const [mid, entry] of managerAgent.managers) {
      const mgrName = (entry.config && entry.config.name) || mid;
      for (const a of (entry.config.assignments || [])) {
        if (!isScheduled(a.schedule)) continue;
        const last = db.prepare('SELECT started_at, finished_at, status FROM manager_runs WHERE manager_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT 1').get(mid, a.id);
        out.push({
          type: 'assignment', id: mid + '/' + a.id, managerId: mid, assignmentId: a.id, name: a.name, parentName: mgrName,
          schedule: a.schedule, scheduleDescription: describe(a.schedule), enabled: a.enabled !== false,
          nextRun: nextRunIso(a.schedule), lastRun: last ? last.started_at : null,
          lastStatus: last ? last.status : null, href: '#/managers/' + mid
        });
      }
    }

    // Flows (chains)
    try {
      for (const chain of chainEngine.load()) {
        if (!isScheduled(chain.schedule)) continue;
        const last = db.prepare('SELECT started_at, finished_at, status FROM chain_runs WHERE chain_id = ? ORDER BY started_at DESC LIMIT 1').get(chain.id);
        out.push({
          type: 'flow', id: chain.id, name: chain.name, parentName: null,
          schedule: chain.schedule, scheduleDescription: describe(chain.schedule), enabled: chain.enabled !== false,
          nextRun: nextRunIso(chain.schedule), lastRun: last ? last.started_at : null,
          lastStatus: last ? last.status : null, href: '#/chains'
        });
      }
    } catch (e) { console.warn('[schedules] chain enumeration failed:', e.message); }

    out.sort((a, b) => {
      if (!a.nextRun && !b.nextRun) return 0;
      if (!a.nextRun) return 1;
      if (!b.nextRun) return -1;
      return new Date(a.nextRun) - new Date(b.nextRun);
    });

    res.json(out);
  } catch (e) {
    console.error('[schedules] failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Unified activity feed across all agents and managers
app.get('/api/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const activities = [];
  
  // Gather agent run history from SQLite (persisted across restarts)
  const agentRuns = db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  for (const run of agentRuns) {
    const entry = supervisor.agents.get(run.agent_id);
    activities.push({
      type: 'agent',
      entityId: run.agent_id,
      entityName: entry?.config?.name || run.agent_id,
      action: 'run',
      status: run.exit_code === 0 ? 'success' : (run.exit_code === null ? 'running' : 'failed'),
      timestamp: run.started_at,
      finishedAt: run.finished_at,
      duration: (run.started_at && run.finished_at)
        ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
        : null,
      output: (run.output || '').slice(0, 500),
      runId: run.id,
      taskId: run.task_id || null,
      triggeredBy: run.triggered_by || 'manual'
    });
  }
  
  // Gather manager run history from SQLite
  try {
    const mgrRuns = db.prepare('SELECT * FROM manager_runs ORDER BY id DESC LIMIT ?').all(limit);
    for (const run of mgrRuns) {
      const mgr = managerAgent.managers.get(run.manager_id);
      activities.push({
        type: 'manager',
        entityId: run.manager_id,
        entityName: mgr?.name || run.manager_id,
        action: run.assignment_id ? `assignment:${run.assignment_id}` : 'prompt',
        status: run.status || 'completed',
        timestamp: run.started_at,
        finishedAt: run.finished_at,
        duration: (run.started_at && run.finished_at)
          ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
          : null,
        output: (run.result || '').slice(0, 500),
        runId: run.id,
        assignmentId: run.assignment_id || null
      });
    }
  } catch {}
  
  // Sort by timestamp descending
  activities.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  res.json(activities.slice(0, limit));
});

// Explain WHY a given agent run fired, from its stored attribution.
// agent_runs only stamps triggered_by (event-trigger id) and task_id; an agent's
// own schedule and the Run button / chat path leave both NULL. We translate that
// into a human reason so the UI can answer "why did this run even though it isn't
// scheduled?".
function describeRunTrigger(row) {
  // 1) Fired by a Task (scheduled or run on-demand from the Tasks page / a flow).
  if (row.task_id) {
    let task = null;
    try { task = loadTasks().find(t => t.id === row.task_id) || null; } catch {}
    const sched = task && task.schedule && task.schedule !== 'never' ? task.schedule : null;
    return {
      reason: 'task',
      label: task ? `Task: ${task.name || task.id}` : `Task: ${row.task_id}`,
      detail: sched
        ? `Ran from the scheduled task "${task.name || row.task_id}" (${sched}).`
        : `Ran from the task "${task ? (task.name || row.task_id) : row.task_id}", which has no schedule — so it was started on demand (Tasks page, a flow step, or an API call).`,
      taskId: row.task_id,
      route: '#/tasks'
    };
  }
  // 2) Fired by an Event Listener trigger.
  if (row.triggered_by) {
    return {
      reason: 'trigger',
      label: `Event trigger: ${row.triggered_by}`,
      detail: `Started by the event trigger "${row.triggered_by}" (Event Listeners), not by a schedule.`,
      route: '#/events'
    };
  }
  // 3) Nothing recorded → a manual / ad-hoc run.
  return {
    reason: 'manual',
    label: 'Manual / ad-hoc run',
    detail: 'No task or trigger is attached to this run — it was started manually (the Run button) or from a chat session, not by a schedule.',
    route: null
  };
}

// Single run detail. Tries agent_runs first, then manager_runs so manager
// assignment/ad-hoc runs are drill-downable too.
app.get('/api/activity/:id', (req, res) => {
  const wantManager = req.query.type === 'manager';
  const row = wantManager ? null : db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.id);
  if (row) {
    const entry = supervisor.agents.get(row.agent_id);
    return res.json({
      type: 'agent',
      id: row.id,
      agentId: row.agent_id,
      agentName: entry?.config?.name || row.agent_id,
      status: row.exit_code === 0 ? 'success' : (row.exit_code === null ? 'running' : 'failed'),
      exitCode: row.exit_code,
      output: row.output || '',
      error: row.error || '',
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: (row.started_at && row.finished_at)
        ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
        : null,
      triggeredBy: row.triggered_by || 'manual',
      taskId: row.task_id || null,
      trigger: describeRunTrigger(row),
      entityRoute: `#/agents/${row.agent_id}`,
      sessionId: row.session_id
    });
  }
  // Manager run fallback.
  let mrow = null;
  try { mrow = db.prepare('SELECT * FROM manager_runs WHERE id = ?').get(req.params.id); } catch {}
  if (!mrow) return res.status(404).json({ error: 'Run not found' });
  const mgr = managerAgent.managers.get(mrow.manager_id);
  let assignmentName = null;
  if (mrow.assignment_id && mgr && Array.isArray(mgr.assignments)) {
    const a = mgr.assignments.find(x => x.id === mrow.assignment_id);
    assignmentName = a ? (a.name || a.id) : mrow.assignment_id;
  }
  const ok = mrow.status === 'completed' || mrow.status === 'success';
  const trigger = mrow.assignment_id
    ? { reason: 'assignment', label: `Assignment: ${assignmentName}`, detail: `Ran from the manager assignment "${assignmentName}".`, route: '#/managers' }
    : { reason: 'manual', label: 'Ad-hoc prompt', detail: 'Started from an ad-hoc prompt in the manager chat, not a schedule.', route: null };
  res.json({
    type: 'manager',
    id: mrow.id,
    managerId: mrow.manager_id,
    agentName: mgr?.name || mrow.manager_id,
    status: ok ? 'success' : (mrow.status === 'running' ? 'running' : 'failed'),
    output: mrow.result || '',
    error: '',
    prompt: mrow.prompt || '',
    assignmentId: mrow.assignment_id || null,
    startedAt: mrow.started_at,
    finishedAt: mrow.finished_at,
    durationMs: (mrow.started_at && mrow.finished_at)
      ? new Date(mrow.finished_at).getTime() - new Date(mrow.started_at).getTime()
      : null,
    trigger,
    entityRoute: `#/managers/${mrow.manager_id}`
  });
});

// ─── Event Listeners API ───────────────────────────────────────────────────────

app.get('/api/events/config', (req, res) => {
  const config = { ...eventListener.config };
  // Mask connection string for security
  if (config.connectionString) {
    config.connectionString = config.connectionString.replace(/SharedAccessKey=[^;]+/, 'SharedAccessKey=•••••');
  }
  config.connected = eventListener.connected;
  config.connectionState = eventListener.connectionState;
  config.activeSessions = eventListener.sessions.size;
  res.json(config);
});

app.get('/api/events/health', (req, res) => {
  res.json({
    connectionState: eventListener.connectionState,
    connected: eventListener.connected,
    activeSessions: eventListener.sessions.size,
    reconnectAttempts: eventListener._reconnectAttempts || 0,
    uptime: eventListener.connected ? Date.now() - (eventListener._connectedAt || Date.now()) : 0
  });
});

app.put('/api/events/config', express.json(), async (req, res) => {
  const update = req.body;
  // Don't overwrite connection string with masked value
  if (update.connectionString && update.connectionString.includes('•••••')) {
    update.connectionString = eventListener.config.connectionString;
  }
  Object.assign(eventListener.config, update);
  eventListener._saveConfig();
  // Persist RBAC users / connected assets to this machine's own cloud namespace so
  // they survive restarts. Every machine owns its namespace, so any machine pushes.
  if (configSync.enabled) {
    try {
      await configSync.pushConfig();
    } catch (err) {
      console.warn('[events] config saved locally but cloud push failed:', err.message);
    }
  }
  res.json({ ok: true });
});

app.post('/api/events/connect', async (req, res) => {
  try {
    await eventListener.connect();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/events/disconnect', async (req, res) => {
  try {
    await eventListener.disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/events/test-connection', express.json(), async (req, res) => {
  const { connectionString, namespace, queueName } = req.body;
  if ((!connectionString && !namespace) || !queueName) {
    return res.json({ ok: false, error: 'Connection string (or namespace) and queue name are required' });
  }
  if (connectionString && !connectionString.includes('Endpoint=sb://')) {
    return res.json({ ok: false, error: 'Invalid connection string format. Must start with Endpoint=sb://' });
  }
  // Attempt a real connection test
  try {
    const { ServiceBusClient } = require('@azure/service-bus');
    let testClient;
    if (namespace) {
      const { DefaultAzureCredential } = require('@azure/identity');
      const fqns = namespace.includes('.') ? namespace : `${namespace}.servicebus.windows.net`;
      testClient = new ServiceBusClient(fqns, new DefaultAzureCredential());
    } else {
      testClient = new ServiceBusClient(connectionString);
    }
    const testReceiver = testClient.createReceiver(queueName, { receiveMode: 'peekLock' });
    // Peek one message to verify queue access (non-destructive)
    await testReceiver.peekMessages(1);
    await testReceiver.close();
    await testClient.close();
    res.json({ ok: true, message: 'Successfully connected and verified queue access.' });
  } catch (err) {
    res.json({ ok: false, error: `Connection failed: ${err.message}` });
  }
});

// Generate a mobile device pairing payload for a user
app.post('/api/events/pair-device', express.json(), async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.json({ ok: false, error: 'userId is required' });
  
  const user = eventListener.config.users.find(u => u.id === userId);
  if (!user) return res.json({ ok: false, error: `User '${userId}' not found` });
  
  // Call relay to generate a pairing token
  const RELAY_URL = process.env.RELAY_URL || 'https://relay-agentsessions.lemondune-11ff5970.westus2.azurecontainerapps.io';
  const RELAY_ADMIN_KEY = process.env.RELAY_ADMIN_KEY || 'gZ9oaNEMAJsLs6AIJ0H5WolbUTuJMzmNAefj6JeKIK0=';

  try {
    const pairResp = await fetch(`${RELAY_URL}/api/pair`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RELAY_ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: user.id, deviceName: `${user.name} Mobile` }),
    });

    if (!pairResp.ok) {
      const err = await pairResp.text();
      return res.json({ ok: false, error: `Relay pairing failed: ${err}` });
    }

    const pairData = await pairResp.json();

    const payload = {
      v: 2,
      relay: RELAY_URL,
      token: pairData.deviceToken,
      userId: user.id,
      userName: user.name,
      role: user.role,
      exp: Date.now() + 10 * 60 * 1000,
    };

    // Generate QR code as data URL
    const QRCode = require('qrcode');
    const payloadStr = JSON.stringify(payload);
    const qrDataUrl = await QRCode.toDataURL(payloadStr, { width: 280, margin: 1 });
    res.json({ ok: true, payload: payloadStr, qrDataUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/events/log', (req, res) => {
  res.json(eventListener.eventLog);
});

// Live mobile-relay channel status for the Event Listeners UI.
app.get('/api/relay/status', (req, res) => {
  // Every machine runs its own scheduled events locally now, so the relay
  // channel is always "active" wherever the server is up.
  const devices = Array.from(relayDevices.values())
    .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  res.json({ ...relayStatus, eventsActive: true, devices });
});

app.get('/api/events/sessions', (req, res) => {
  res.json(eventListener.getSessionsInfo());
});

app.post('/api/events/sessions/:sessionId/close', (req, res) => {
  // Find and close session by compound ID (user-target)
  const parts = req.params.sessionId.split('-');
  const senderId = parts[0]; // Simplified — real impl would use full ID
  if (eventListener.sessions.has(senderId)) {
    eventListener.sessions.delete(senderId);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: 'Session not found' });
  }
});

app.get('/api/events/history', (req, res) => {
  const { limit, offset, type, since } = req.query;
  const history = eventListener.getHistory({
    limit: limit ? parseInt(limit) : 200,
    offset: offset ? parseInt(offset) : 0,
    type: type || undefined,
    since: since || undefined
  });
  res.json(history);
});

app.get('/api/events/session-history', (req, res) => {
  const { limit, status } = req.query;
  const sessions = eventListener.getSessionHistory({
    limit: limit ? parseInt(limit) : 50,
    status: status || undefined
  });
  res.json(sessions);
});

// Recent external connections (mobile-relay devices + inbound event traffic),
// aggregated per caller for the Settings → External → Connections tab.
app.get('/api/events/connections', (req, res) => {
  const byId = new Map();
  const upsert = (c) => {
    const prev = byId.get(c.id);
    if (!prev) { byId.set(c.id, c); return; }
    prev.messageCount += c.messageCount || 0;
    if (!prev.firstSeen || (c.firstSeen && c.firstSeen < prev.firstSeen)) prev.firstSeen = c.firstSeen;
    if (!prev.lastSeen || (c.lastSeen && c.lastSeen > prev.lastSeen)) prev.lastSeen = c.lastSeen;
    prev.online = prev.online || c.online;
  };

  // Mobile-relay devices (live, with lastSeen)
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const d of relayDevices.values()) {
    const last = Date.parse(d.lastSeen);
    upsert({
      id: d.deviceId,
      name: d.user || d.deviceId,
      channel: 'mobile',
      messageCount: d.messageCount || 0,
      firstSeen: d.lastSeen,
      lastSeen: d.lastSeen,
      online: !!last && last >= cutoff
    });
  }

  // Inbound event traffic grouped by sender
  try {
    for (const c of (eventListener.getConnections() || [])) upsert(c);
  } catch (e) { /* table may be empty */ }

  const connections = Array.from(byId.values())
    .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  res.json(connections);
});

app.get('/api/events/dlq', (req, res) => {
  const { limit, status } = req.query;
  res.json(eventListener.getDLQ({ limit: limit ? parseInt(limit) : 50, status: status || 'failed' }));
});

app.post('/api/events/dlq/:id/retry', async (req, res) => {
  try {
    await eventListener.retryDLQ(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/events/dlq/:id/dismiss', (req, res) => {
  eventListener.dismissDLQ(parseInt(req.params.id));
  res.json({ ok: true });
});

// SSE stream for live event log
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');

  const onEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  eventListener.on('event', onEvent);

  req.on('close', () => {
    eventListener.removeListener('event', onEvent);
  });
});

// Local simulation endpoint — SSE streaming version for step-by-step progress
app.post('/api/events/simulate/stream', express.json(), async (req, res) => {
  const { senderId, content, correlationId } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const simCorrelationId = correlationId || `sim-${Date.now()}`;
  const simSenderId = senderId || 'local-user';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Listen for manager step events
  const stepHandler = (data) => {
    sendEvent('step', data);
  };
  managerAgent.on('manager-step', stepHandler);

  // Capture reply
  let capturedReply = null;
  const originalReply = eventListener._reply.bind(eventListener);
  eventListener._reply = async (corrId, sender, payload) => {
    if (corrId === simCorrelationId) {
      capturedReply = payload;
    }
  };

  try {
    const fakeMessage = {
      body: { senderId: simSenderId, correlationId: simCorrelationId, content },
      correlationId: simCorrelationId,
      applicationProperties: { senderId: simSenderId }
    };

    sendEvent('status', { message: 'Processing...' });
    await eventListener._handleMessage(fakeMessage);

    if (!capturedReply) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    sendEvent('reply', capturedReply || { status: 'pending', content: 'Execution started (async)' });
  } catch (err) {
    sendEvent('reply', { status: 'error', error: err.message });
  } finally {
    managerAgent.removeListener('manager-step', stepHandler);
    eventListener._reply = originalReply;
    res.end();
  }
});

// Local simulation endpoint — bypasses Service Bus, exercises full routing pipeline
app.post('/api/events/simulate', express.json(), async (req, res) => {
  const { senderId, content, correlationId } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const simCorrelationId = correlationId || `sim-${Date.now()}`;
  const simSenderId = senderId || 'local-user';

  // Capture reply by temporarily intercepting _reply
  let capturedReply = null;
  const originalReply = eventListener._reply.bind(eventListener);
  eventListener._reply = async (corrId, sender, payload) => {
    if (corrId === simCorrelationId) {
      capturedReply = payload;
    }
    // Still call original in case sender is set up (no-op without Service Bus)
    // But don't fail if no sender configured
  };

  try {
    // Build a fake Service Bus message object
    const fakeMessage = {
      body: { senderId: simSenderId, correlationId: simCorrelationId, content },
      correlationId: simCorrelationId,
      applicationProperties: { senderId: simSenderId }
    };

    await eventListener._handleMessage(fakeMessage);

    // Wait briefly for async execution if no reply yet
    if (!capturedReply) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    res.json({
      correlationId: simCorrelationId,
      senderId: simSenderId,
      reply: capturedReply || { status: 'pending', content: 'Execution started (async — check live log for results)' }
    });
  } catch (err) {
    res.json({
      correlationId: simCorrelationId,
      senderId: simSenderId,
      reply: { status: 'error', error: err.message }
    });
  } finally {
    eventListener._reply = originalReply;
  }
});

// ============================================================
// Mobile REST API — same handlers as Service Bus, but over HTTP
// (for local network access or development/testing)
// ============================================================

app.post('/api/mobile/:action', async (req, res) => {
  const { action } = req.params;
  const correlationId = req.body.correlationId || Date.now().toString();
  const sessionId = req.body.sessionId || 'rest-session';
  // Nest body contents under payload (excluding protocol fields)
  const { correlationId: _c, sessionId: _s, payload: explicitPayload, ...rest } = req.body;
  const body = { type: action, correlationId, sessionId, payload: explicitPayload || rest };

  if (!mobileHandler.isMobileMessage(body)) {
    return res.status(400).json({ error: 'Invalid mobile message format' });
  }

  const replies = [];
  const replier = async (corrId, payload) => {
    replies.push({ correlationId: corrId, ...payload });
  };

  try {
    await mobileHandler.handle(body, replier);
    // Return last reply (the 'result' or 'error'), include streaming chunks
    const finalReply = replies[replies.length - 1];
    if (replies.length > 1) {
      finalReply._streamingChunks = replies.slice(0, -1).filter(r => r.type === 'streaming-chunk');
    }
    res.json(finalReply);
  } catch (err) {
    res.status(500).json({ type: 'error', error: err.message });
  }
});

// ============================================================
// Relay Poller — polls the cloud relay for inbound mobile messages
// ============================================================

const RELAY_URL = process.env.RELAY_URL || 'https://relay-agentsessions.lemondune-11ff5970.westus2.azurecontainerapps.io';
const RELAY_ADMIN_KEY = process.env.RELAY_ADMIN_KEY || 'gZ9oaNEMAJsLs6AIJ0H5WolbUTuJMzmNAefj6JeKIK0=';
let relayPollerInterval = null;

// Live relay/mobile-channel status, surfaced in the Event Listeners UI so the
// mobile experience is a first-class channel alongside Service Bus.
const relayStatus = {
  reachable: false,
  lastPollAt: null,
  lastOkAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastMessageAt: null,
  totalMessages: 0,
};
const relayDevices = new Map(); // deviceId → { deviceId, user, lastSeen, messageCount, lastType }

function _recordRelayDevice(deviceId, type) {
  const now = new Date().toISOString();
  const prev = relayDevices.get(deviceId) || { deviceId, messageCount: 0 };
  relayDevices.set(deviceId, {
    deviceId,
    lastSeen: now,
    messageCount: (prev.messageCount || 0) + 1,
    lastType: type,
  });
}

async function pollRelay() {
  relayStatus.lastPollAt = new Date().toISOString();
  try {
    // Identify ourselves so the relay hands us messages addressed to this
    // machine (the device's chosen "listener"). Every poller also drains the
    // shared default queue for devices that haven't picked a listener yet.
    const machineId = configSync.enabled ? configSync.machineId : null;
    const qs = new URLSearchParams();
    if (machineId) qs.set('machineId', machineId);
    const resp = await fetch(`${RELAY_URL}/api/messages/receive?${qs.toString()}`, {
      headers: { 'Authorization': `Bearer ${RELAY_ADMIN_KEY}` },
    });
    if (!resp.ok) {
      relayStatus.reachable = false;
      relayStatus.consecutiveFailures++;
      relayStatus.lastError = `HTTP ${resp.status}`;
      return;
    }

    relayStatus.reachable = true;
    relayStatus.lastOkAt = relayStatus.lastPollAt;
    relayStatus.consecutiveFailures = 0;
    relayStatus.lastError = null;

    const data = await resp.json();
    if (!data.messages || data.messages.length === 0) return;

    console.log(`[relay-poller] Received ${data.messages.length} message(s)`);
    for (const msg of data.messages) {
      const body = msg.body;
      if (!body || !body.type) { console.log('[relay-poller] Skip msg without type:', JSON.stringify(msg).slice(0, 100)); continue; }

      const correlationId = body.correlationId || msg.id;
      const sessionId = body.sessionId || `relay-${msg.from}`;
      const mobileMsg = { type: body.type, correlationId, sessionId, payload: body.payload || body };

      console.log(`[relay-poller] Processing: type=${body.type}, from=${msg.from}, corrId=${correlationId}`);

      if (!mobileHandler.isMobileMessage(mobileMsg)) { console.log('[relay-poller] Not a mobile message, skipping'); continue; }

      relayStatus.lastMessageAt = new Date().toISOString();
      relayStatus.totalMessages++;
      _recordRelayDevice(msg.from, body.type);
      // Surface inbound mobile traffic in the Event Listeners Live Log + History.
      try {
        eventListener._logEvent('inbound', msg.from, `[mobile] ${body.type}`, 'received', {
          channel: 'mobile', senderId: msg.from, correlationId,
        });
      } catch {}

      const replier = async (corrId, payload) => {
        // Send reply back via relay
        try {
          const replyResp = await fetch(`${RELAY_URL}/api/messages/reply`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RELAY_ADMIN_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              targetDeviceId: msg.from,
              correlationId: corrId,
              body: { correlationId: corrId, ...payload },
            }),
          });
          console.log(`[relay-poller] Reply sent for ${corrId} → ${msg.from} (status: ${replyResp.status})`);
          try {
            eventListener._logEvent('outbound', msg.from, `[mobile] ${payload && payload.type ? payload.type : 'reply'}`, 'sent', {
              channel: 'mobile', senderId: msg.from, correlationId: corrId,
            });
          } catch {}
        } catch (e) {
          console.error('[relay-poller] Failed to send reply:', e.message);
        }
      };

      try {
        // RBAC enforcement: the relay sets msg.from to the paired device's userId.
        // Only identities that map to an approved RBAC user may use the mobile
        // channel. Deny EVERYTHING (including get-status) for unapproved users so
        // an external session leaks no data and is fully refused.
        const fromUser = msg.from;
        if (!eventListener.isApprovedUser(fromUser)) {
          console.warn(`[relay-poller] REJECTED unauthorized device user='${fromUser}' type=${body.type}`);
          try {
            eventListener._logEvent('error', msg.from, '[mobile] REJECTED: unauthorized device', 'denied', {
              channel: 'mobile', senderId: msg.from, correlationId,
            });
          } catch {}
          await replier(correlationId, {
            type: 'error',
            error: 'Unauthorized: this device is not linked to an approved user. Ask an admin to add you under RBAC in the web dashboard.',
          });
          continue;
        }
        await mobileHandler.handle(mobileMsg, replier);
      } catch (err) {
        console.error('[relay-poller] Handler error:', err.message);
      }
    }
  } catch (err) {
    // Network error — relay may be scaling up. Track it for the UI status badge.
    relayStatus.reachable = false;
    relayStatus.consecutiveFailures++;
    relayStatus.lastError = err.message;
  }
}

function startRelayPoller() {
  if (relayPollerInterval) return;
  console.log(`[relay-poller] Polling relay at ${RELAY_URL} every 3s`);
  relayPollerInterval = setInterval(pollRelay, 3000);
  pollRelay(); // immediate first poll
}

// Start the relay poller
startRelayPoller();

// SPA catch-all: serve app.html for any non-API route (must be last)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  serveSpa(req, res);
});

// Bind the port FIRST. Only the instance that successfully owns the port should
// initialize agents — a redundant instance (e.g. spawned by an external
// scheduler while one is already running) must not touch agent/DB state before
// it discovers the conflict and exits via the EADDRINUSE handler below.
const server = app.listen(PORT, () => {
  console.log(`[supervisor] Dashboard running at http://localhost:${PORT}`);
  // Register enabled agents as scheduled. startAll() never runs any agent on
  // boot — execution comes only from user/orchestrated/scheduled triggers.
  supervisor.startAll();
  try {
    const _rdr = require('./sdk-reader');
    const _rnr = require('./sdk-runner');
    const envRead = process.env.SDK_READ_MODE || 'shadow';
    const envRun = process.env.SDK_RUN_MODE || 'off';
    const runAgents = process.env.SDK_RUN_AGENTS || '';
    console.log(`[supervisor] SDK modes — read: env=${envRead} effective=${_rdr.mode} | run: env=${envRun} effective=${_rnr.mode}${runAgents ? ' agents=[' + runAgents + ']' : ''} | node=${process.version} COPILOT_HOME=${process.env.COPILOT_HOME || '(default)'}`);
  } catch (e) { console.warn('[supervisor] could not log SDK modes:', e.message); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[supervisor] Port ${PORT} already in use — another instance is running. Exiting.`);
    process.exit(0);
  }
  throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[supervisor] Shutting down...');
  configSync.stop();
  supervisor.stopAll();
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  configSync.stop();
  supervisor.stopAll();
  db.close();
  process.exit(0);
});

} // end main

main().catch(err => {
  console.error('Failed to start supervisor:', err);
  process.exit(1);
});

function getManagersPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Managers — TheOffice.AI</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    
    .top-nav {
      display: flex; gap: 16px; align-items: center; margin-bottom: 24px;
      border-bottom: 1px solid #30363d; padding-bottom: 16px;
    }
    .nav-link {
      color: #8b949e; text-decoration: none; font-size: 0.9rem; padding: 6px 12px;
      border-radius: 6px; transition: all 0.15s;
    }
    .nav-link:hover { color: #c9d1d9; background: #21262d; }
    .nav-link.active { color: #58a6ff; background: #1f6feb22; font-weight: 600; }
    .nav-title { font-size: 1.3rem; font-weight: 700; color: #f0f6fc; margin-right: auto; }

    h2 { color: #58a6ff; margin-bottom: 16px; font-size: 1.2rem; }
    
    .managers-grid { display: grid; gap: 20px; margin-bottom: 32px; }
    
    .manager-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px;
      transition: border-color 0.2s;
    }
    .manager-card:hover { border-color: #58a6ff; }
    .manager-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .manager-name { font-size: 1.2rem; font-weight: 700; color: #f0f6fc; }
    .manager-desc { color: #8b949e; font-size: 0.9rem; margin-bottom: 16px; }
    
    .status-badge {
      padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
    }
    .status-idle { background: #1f6feb33; color: #58a6ff; }
    .status-running { background: #f7883533; color: #f78835; }
    .status-scheduled { background: #3fb95033; color: #3fb950; }
    .status-error { background: #f8514933; color: #f85149; }

    .org-section { margin-bottom: 16px; }
    .org-label { font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .org-agents { display: flex; gap: 6px; flex-wrap: wrap; }
    .org-chip {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
      background: #21262d; border: 1px solid #30363d; border-radius: 16px;
      font-size: 0.8rem; color: #c9d1d9;
    }
    .org-chip .remove-btn {
      cursor: pointer; color: #f85149; font-size: 0.7rem; margin-left: 4px;
      opacity: 0.6; transition: opacity 0.15s;
    }
    .org-chip .remove-btn:hover { opacity: 1; }
    .org-add-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
      background: none; border: 1px dashed #30363d; border-radius: 16px;
      font-size: 0.8rem; color: #58a6ff; cursor: pointer; transition: all 0.15s;
    }
    .org-add-btn:hover { border-color: #58a6ff; background: #1f6feb11; }

    .assignments-section { margin-bottom: 16px; }
    .assignment-list { display: grid; gap: 8px; }
    .assignment-item {
      display: flex; align-items: center; gap: 12px; padding: 10px 14px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
      position: relative;
    }
    .assignment-name { font-weight: 600; font-size: 0.9rem; color: #f0f6fc; }
    .assignment-schedule { font-size: 0.75rem; color: #8b949e; font-family: monospace; }
    .assignment-prompt { font-size: 0.8rem; color: #8b949e; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .assignment-actions { display: flex; gap: 6px; }

    .btn {
      padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d; background: #21262d;
      color: #c9d1d9; cursor: pointer; font-size: 0.8rem; transition: all 0.15s;
    }
    .btn:hover { background: #30363d; border-color: #58a6ff; }
    .btn-primary { background: #238636; border-color: #238636; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; border-color: #da3633; color: #fff; }
    .btn-danger:hover { background: #f85149; }
    .btn-sm { padding: 4px 10px; font-size: 0.75rem; }

    .chat-section {
      margin-top: 16px; border-top: 1px solid #30363d; padding-top: 16px;
    }
    .chat-messages {
      max-height: 300px; overflow-y: auto; margin-bottom: 12px;
      padding: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
      display: none;
    }
    .chat-messages.visible { display: block; }
    .chat-msg { margin-bottom: 8px; font-size: 0.85rem; }
    .chat-msg.user { color: #58a6ff; }
    .chat-msg.assistant { color: #c9d1d9; }
    .chat-msg .role { font-weight: 600; margin-right: 6px; }
    .chat-input-row { display: flex; gap: 8px; }
    .chat-input {
      flex: 1; padding: 10px 14px; background: #0d1117; border: 1px solid #30363d;
      border-radius: 8px; color: #c9d1d9; font-size: 0.9rem; resize: none;
    }
    .chat-input:focus { border-color: #58a6ff; outline: none; }

    .history-section { margin-top: 16px; }
    .history-toggle { color: #58a6ff; cursor: pointer; font-size: 0.85rem; border: none; background: none; }
    .history-list { display: none; margin-top: 8px; }
    .history-list.visible { display: block; }
    .history-item {
      padding: 8px 12px; background: #0d1117; border: 1px solid #30363d;
      border-radius: 6px; margin-bottom: 6px; font-size: 0.8rem;
    }
    .history-item .time { color: #8b949e; }
    .history-item .status-ok { color: #3fb950; }
    .history-item .status-err { color: #f85149; }

    .empty-state {
      text-align: center; padding: 60px 24px; color: #8b949e;
    }
    .empty-state h3 { color: #f0f6fc; margin-bottom: 8px; }

    .asgn-sched-editor { display: none; position: fixed; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; z-index: 1000; min-width: 340px; max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .asgn-sched-editor.visible { display: block; }
    .asgn-sched-editor label { color: #8b949e; font-size: 0.75rem; display: block; margin-bottom: 4px; }
    .asgn-sched-editor select, .asgn-sched-editor input[type="time"], .asgn-sched-editor input[type="number"] {
      background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 4px; font-size: 0.85rem; margin-bottom: 8px;
    }
    .asgn-sched-editor .day-checkboxes { display: flex; gap: 4px; margin: 8px 0; }
    .asgn-sched-editor .day-checkboxes label { display: flex; align-items: center; gap: 2px; cursor: pointer; padding: 4px 6px; border-radius: 4px; border: 1px solid #30363d; color: #c9d1d9; font-size: 0.8rem; }
    .asgn-sched-editor .day-checkboxes label:has(input:checked) { background: #1f6feb33; border-color: #1f6feb; color: #58a6ff; }
    .asgn-sched-editor .day-checkboxes input { display: none; }
    .asgn-sched-editor .sched-preview { margin-top: 10px; padding: 8px; background: #0d1117; border-radius: 4px; color: #7ee787; font-size: 0.8rem; min-height: 20px; }
    .asgn-sched-editor .sched-actions { display: flex; gap: 8px; margin-top: 12px; }

    .modal-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      z-index: 1000; align-items: center; justify-content: center;
    }
    .modal-overlay.visible { display: flex; }
    .modal {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      padding: 24px; width: 500px; max-width: 90vw; max-height: 80vh; overflow-y: auto;
    }
    .modal h3 { color: #f0f6fc; margin-bottom: 16px; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 4px; }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d;
      border-radius: 6px; color: #c9d1d9; font-size: 0.9rem;
    }
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
      border-color: #58a6ff; outline: none;
    }
    .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

    .steps-list { margin-top: 8px; }
    .step-item { padding: 6px 10px; font-size: 0.8rem; border-left: 2px solid #30363d; margin-bottom: 4px; padding-left: 12px; }
    .step-item.run_agent { border-color: #58a6ff; }
    .step-item.complete { border-color: #3fb950; }
    .step-item.error { border-color: #f85149; }

    /* Manager Chat Modal Styles */
    .mgr-chat-msg { margin-bottom: 16px; }
    .mgr-chat-msg.user { }
    .mgr-chat-msg.assistant { }
    .mgr-chat-role { font-size: 0.8rem; font-weight: 600; margin-bottom: 4px; }
    .mgr-chat-msg.user .mgr-chat-role { color: #58a6ff; }
    .mgr-chat-msg.assistant .mgr-chat-role { color: #8b949e; }
    .mgr-chat-content { font-size: 0.9rem; line-height: 1.5; padding: 8px 12px; border-radius: 8px; }
    .mgr-chat-msg.user .mgr-chat-content { background: #1f6feb22; border: 1px solid #1f6feb44; }
    .mgr-chat-msg.assistant .mgr-chat-content { background: #0d1117; border: 1px solid #30363d; }
    .mgr-chat-content.assistant-md table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    .mgr-chat-content.assistant-md th, .mgr-chat-content.assistant-md td { border: 1px solid #30363d; padding: 4px 8px; font-size: 0.8rem; }
    .mgr-chat-content.assistant-md th { background: #161b22; color: #f0f6fc; }
    .mgr-chat-content.assistant-md code { background: #21262d; padding: 1px 4px; border-radius: 3px; font-size: 0.8rem; }
    .mgr-chat-content.assistant-md pre { background: #21262d; padding: 8px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
    .mgr-chat-content.assistant-md pre code { background: none; padding: 0; }
    .mgr-chat-content.assistant-md h1, .mgr-chat-content.assistant-md h2, .mgr-chat-content.assistant-md h3 { color: #f0f6fc; margin: 8px 0 4px; }
    .mgr-chat-content.assistant-md ul, .mgr-chat-content.assistant-md ol { padding-left: 20px; margin: 4px 0; }
    .mgr-chat-content.assistant-md strong { color: #f0f6fc; }
    .mgr-steps { margin: 8px 0; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; }
    .mgr-step { font-size: 0.8rem; padding: 4px 0; color: #8b949e; display: flex; align-items: center; gap: 6px; }
    .mgr-step.run_agent { color: #58a6ff; }
    .mgr-step.agent_result { color: #3fb950; }
    .mgr-step.complete { color: #3fb950; }
    .mgr-step.error { color: #f85149; }
    .mgr-step.thinking { color: #f78835; }
  </style>
</head>
<body>
  <nav class="top-nav">
    <span class="nav-title">TheOffice.AI</span>
    <a href="/" class="nav-link active">Managers</a>
    <a href="/agents" class="nav-link">Agents</a>
  </nav>

  <div id="app" x-data="managersApp()" x-init="init()">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2>Managers</h2>
      <button class="btn btn-primary" @click="showCreateManager()">+ New Manager</button>
    </div>

    <template x-if="managers.length === 0">
      <div class="empty-state">
        <h3>No Managers Yet</h3>
        <p>Create a manager to orchestrate your agents intelligently.</p>
      </div>
    </template>

    <div id="managers-list" class="managers-grid" x-show="managers.length > 0">
      <template x-for="m in managers" :key="m.manager_id">
        <div class="manager-card" :id="'mgr-' + m.manager_id">
          <div class="manager-header">
            <span class="manager-name" x-text="(m.config && m.config.name) || m.manager_id"></span>
            <div style="display:flex;gap:8px;align-items:center;">
              <span class="status-badge" :class="'status-' + (m.status || 'idle')" x-text="m.status || 'idle'"></span>
              <button class="btn btn-sm" title="Edit manager" @click="showEditManager(m)">✎</button>
              <button class="btn btn-sm btn-danger" title="Delete manager" @click="deleteManager(m.manager_id)">✕</button>
            </div>
          </div>
          <div class="manager-desc" x-text="(m.config && m.config.description) || ''"></div>

          <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
            <span style="font-size:0.8rem;color:#8b949e;">Agent:</span>
            <code style="font-size:0.8rem;color:#58a6ff;background:#1f6feb22;padding:2px 8px;border-radius:4px;" x-text="managerAgentLabel(m)"></code>
            <button class="btn btn-sm" @click="editManagerAgent(m.manager_id, managerAgentLabel(m))">🔄 Change</button>
            <button class="btn btn-sm" @click="openManagerAgentInEditor(m.manager_id)">📝 Edit Prompt</button>
          </div>

          <div class="org-section">
            <div class="org-label">Team (Agents)</div>
            <div class="org-agents">
              <template x-for="a in (m.orgDetails || [])" :key="a.id">
                <span class="org-chip">
                  <span x-text="a.name"></span>
                  <span class="remove-btn" title="Remove" @click="removeFromOrg(m.manager_id, a.id)">✕</span>
                </span>
              </template>
              <button class="org-add-btn" @click="showAddAgent(m.manager_id)">+ Add</button>
            </div>
          </div>

          <div class="assignments-section">
            <div class="org-label">
              <span>Assignments</span>
              <span x-show="(m.activeSchedules || 0) > 0" style="color:#3fb950;font-size:11px;" x-text="'(' + (m.activeSchedules || 0) + ' scheduled)'"></span>
            </div>
            <div class="assignment-list">
              <template x-for="a in ((m.config && m.config.assignments) || [])" :key="a.id">
                <div class="assignment-item">
                  <span class="assignment-name" x-text="a.name"></span>
                  <span class="assignment-schedule" :title="a.scheduleDescription || ''" x-text="assignmentScheduleLabel(a)"></span>
                  <span x-show="a.nextRun" style="font-size:10px;color:#8b949e;" x-text="'next: ' + formatTime(a.nextRun)"></span>
                  <span class="assignment-prompt" :title="a.prompt || ''" x-text="a.prompt || ''"></span>
                  <div class="assignment-actions">
                    <button class="btn btn-sm" title="Edit assignment" @click="showEditAssignment(m.manager_id, a)">✎</button>
                    <button class="btn btn-sm" :title="a.enabled !== false ? 'Disable' : 'Enable'" @click="toggleAssignment(m.manager_id, a.id, a.enabled === false)" x-text="a.enabled !== false ? '⏸' : '▶️'"></button>
                    <button class="btn btn-sm" title="Edit schedule" @click="openScheduleEditor(m.manager_id, a, $event)">🕐</button>
                    <button class="btn btn-sm btn-primary" @click="runAssignment(m.manager_id, a.id)">▶ Run</button>
                    <button class="btn btn-sm btn-danger" @click="deleteAssignment(m.manager_id, a.id)">✕</button>
                  </div>
                </div>
              </template>
              <button class="btn btn-sm" style="margin-top:6px;" @click="showAddAssignment(m.manager_id)">+ Add Assignment</button>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-primary" @click="openManagerChat(m.manager_id, (m.config && m.config.name) || m.manager_id)">💬 Chat with Manager</button>
            <button class="btn" @click="toggleHistory(m.manager_id)">📋 Run History</button>
          </div>

          <div class="history-section">
            <div class="history-list" :class="{ visible: historyOpen[m.manager_id] }" x-show="historyOpen[m.manager_id]">
              <template x-if="(histories[m.manager_id] || []).length === 0">
                <div style="color:#8b949e;font-size:0.85rem;">No runs yet.</div>
              </template>
              <template x-for="run in (histories[m.manager_id] || [])" :key="run.id">
                <div class="history-item" style="cursor:pointer;" @click="viewRun(m.manager_id, run.id)">
                  <div>
                    <span :class="run.status === 'completed' ? 'status-ok' : 'status-err'" x-text="run.status"></span>
                    <span class="time" x-text="formatDateTime(run.started_at)"></span>
                    <span x-text="run.assignment_id ? ' — ' + run.assignment_id : ' — ad-hoc'"></span>
                  </div>
                  <div style="margin-top:4px;color:#8b949e;font-size:0.75rem;" x-text="truncate(run.prompt || '', 100)"></div>
                  <div class="steps-list" x-show="filteredHistorySteps(run).length > 0">
                    <template x-for="step in filteredHistorySteps(run)" :key="historyStepKey(run, step)">
                      <div class="step-item" :class="step.action" x-text="historyStepSummary(step)"></div>
                    </template>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div id="managerModal" class="modal-overlay" x-show="showManagerModal" :class="{ visible: showManagerModal }" @click.self="closeManagerModal()">
      <div class="modal">
        <h3 x-text="mgrForm.editing ? 'Edit Manager' : 'Create Manager'"></h3>
        <div class="form-group">
          <label>ID (unique slug)</label>
          <input type="text" x-model="mgrForm.id" :disabled="mgrForm.editing" placeholder="e.g. helix-ops-manager">
        </div>
        <div class="form-group">
          <label>Name</label>
          <input type="text" x-model="mgrForm.name" placeholder="e.g. Helix Ops Manager">
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea rows="2" x-model="mgrForm.desc" placeholder="What this manager does..."></textarea>
        </div>
        <div class="form-group">
          <label>Agent Plugin</label>
          <select x-model="mgrForm.agent">
            <template x-for="variant in managerAgents" :key="variant.id">
              <option :value="variant.id" x-text="variant.id + ' — ' + variant.description"></option>
            </template>
          </select>
        </div>
        <div class="form-actions">
          <button class="btn" @click="closeManagerModal()">Cancel</button>
          <button class="btn btn-primary" @click="saveManager()">Save</button>
        </div>
      </div>
    </div>

    <div id="assignmentModal" class="modal-overlay" x-show="showAssignmentModal" :class="{ visible: showAssignmentModal }" @click.self="closeAssignmentModal()">
      <div class="modal">
        <h3 x-text="asgnForm.editing ? 'Edit Assignment' : 'New Assignment'"></h3>
        <div class="form-group">
          <label>ID (unique slug)</label>
          <input type="text" x-model="asgnForm.id" :disabled="asgnForm.editing" placeholder="e.g. monitor-azure">
        </div>
        <div class="form-group">
          <label>Name</label>
          <input type="text" x-model="asgnForm.name" placeholder="e.g. Monitor Azure">
        </div>
        <div class="form-group">
          <label>Prompt</label>
          <textarea rows="4" x-model="asgnForm.prompt" placeholder="What should the manager do?"></textarea>
        </div>
        <div class="form-group">
          <label>Schedule</label>
          <input type="text" x-model="asgnForm.schedule" placeholder="e.g. 1h, daily at 9am, never">
        </div>
        <div class="form-actions">
          <button class="btn" @click="closeAssignmentModal()">Cancel</button>
          <button class="btn btn-primary" @click="saveAssignment()">Save</button>
        </div>
      </div>
    </div>

    <div id="orgModal" class="modal-overlay" x-show="showOrgModal" :class="{ visible: showOrgModal }" @click.self="closeOrgModal()">
      <div class="modal">
        <h3>Add Agent to Team</h3>
        <div class="form-group">
          <label>Available Agents</label>
          <select size="8" style="height:auto;" x-model="orgForm.agentId">
            <template x-for="agent in availableOrgAgents" :key="agent.id">
              <option :value="agent.id" x-text="agent.name + ' (' + agent.id + ')'"></option>
            </template>
          </select>
        </div>
        <div class="form-actions">
          <button class="btn" @click="closeOrgModal()">Cancel</button>
          <button class="btn btn-primary" @click="addAgentToOrg()">Add</button>
        </div>
      </div>
    </div>

    <div id="agentSelectModal" class="modal-overlay" x-show="showAgentSelectModal" :class="{ visible: showAgentSelectModal }" @click.self="closeAgentSelectModal()">
      <div class="modal">
        <h3>Select Agent Plugin</h3>
        <div class="form-group">
          <label>Agent Variant</label>
          <select size="1" style="width:100%;" x-model="agentSelect.agent">
            <template x-for="variant in managerAgents" :key="variant.id">
              <option :value="variant.id" x-text="variant.id + ' — ' + variant.description"></option>
            </template>
          </select>
        </div>
        <div class="form-actions">
          <button class="btn" @click="closeAgentSelectModal()">Cancel</button>
          <button class="btn btn-primary" @click="saveAgentSelect()">Save</button>
        </div>
      </div>
    </div>

    <div class="asgn-sched-editor" x-show="schedEditor.show" :class="{ visible: schedEditor.show }" :style="'top:' + schedEditor.top + 'px; left:' + schedEditor.left + 'px;'" @click.outside="closeScheduleEditor()" x-transition.opacity>
      <label>Schedule type</label>
      <div style="margin-bottom:8px;">
        <select x-model="schedEditor.mode" @change="onScheduleModeChanged()">
          <option value="never">Never (manual only)</option>
          <option value="interval">Interval (every N minutes/hours)</option>
          <option value="daily">Daily (at a specific time)</option>
          <option value="weekly">Weekly (pick days + time)</option>
          <option value="cron">Advanced (cron / free text)</option>
        </select>
      </div>
      <div>
        <div x-show="schedEditor.mode === 'never'">
          <span style="color:#8b949e;font-size:0.8rem;">Assignment will only run manually.</span>
        </div>
        <div x-show="schedEditor.mode === 'interval'" style="display:flex;gap:8px;align-items:center;">
          <label style="margin:0">Every</label>
          <input type="number" min="1" max="720" style="width:60px" x-model="schedEditor.num" @input="updateSchedulePreview()">
          <select x-model="schedEditor.unit" @change="updateSchedulePreview()">
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </select>
        </div>
        <div x-show="schedEditor.mode === 'daily'" style="display:flex;gap:8px;align-items:center;">
          <label style="margin:0">At</label>
          <input type="time" x-model="schedEditor.dailyTime" @change="updateSchedulePreview()">
          <span style="color:#8b949e;font-size:0.8rem">every day</span>
        </div>
        <div x-show="schedEditor.mode === 'weekly'">
          <div class="day-checkboxes">
            <label><input type="checkbox" value="mon" x-model="schedEditor.days" @change="updateSchedulePreview()"> Mon</label>
            <label><input type="checkbox" value="tue" x-model="schedEditor.days" @change="updateSchedulePreview()"> Tue</label>
            <label><input type="checkbox" value="wed" x-model="schedEditor.days" @change="updateSchedulePreview()"> Wed</label>
            <label><input type="checkbox" value="thu" x-model="schedEditor.days" @change="updateSchedulePreview()"> Thu</label>
            <label><input type="checkbox" value="fri" x-model="schedEditor.days" @change="updateSchedulePreview()"> Fri</label>
            <label><input type="checkbox" value="sat" x-model="schedEditor.days" @change="updateSchedulePreview()"> Sat</label>
            <label><input type="checkbox" value="sun" x-model="schedEditor.days" @change="updateSchedulePreview()"> Sun</label>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="margin:0">At</label>
            <input type="time" x-model="schedEditor.weeklyTime" @change="updateSchedulePreview()">
          </div>
        </div>
        <div x-show="schedEditor.mode === 'cron'" style="display:flex;flex-direction:column;gap:4px;">
          <label style="margin:0">Cron expression or free text</label>
          <input type="text" style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;width:100%;" x-model="schedEditor.cron" @input="updateSchedulePreview()" placeholder="e.g. 0 9 * * 1-5 or weekdays at 9am">
          <span style="color:#8b949e;font-size:0.7rem">Examples: 0 */2 * * * (every 2h) | weekdays at 9am | every 30 minutes</span>
        </div>
      </div>
      <div class="sched-preview" :style="'color:' + schedEditor.previewColor" x-text="schedEditor.previewText"></div>
      <div class="sched-actions">
        <button class="btn btn-primary" @click="saveScheduleEditor()">Save</button>
        <button class="btn" @click="closeScheduleEditor()">Cancel</button>
      </div>
    </div>

    <div id="mgrChatOverlay" class="modal-overlay" x-show="chat.show" :class="{ visible: chat.show }" @click.self="closeManagerChat()">
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;width:90vw;max-width:900px;height:85vh;display:flex;flex-direction:column;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #30363d;flex-shrink:0;">
          <h2 style="color:#f0f6fc;font-size:1.1rem;margin:0;" x-text="chat.title || 'Chat'"></h2>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;color:#8b949e;cursor:pointer;" title="Show orchestration steps">
              <input type="checkbox" x-model="chat.verbose" @change="toggleChatVerbose()">
              🔧 Verbose
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;color:#8b949e;cursor:pointer;" title="Stream sub-agent output live as it runs (experimental)">
              <input type="checkbox" x-model="chat.live" @change="toggleChatLive()">
              📡 Live
            </label>
            <button class="btn" style="padding:4px 10px;font-size:1rem;line-height:1;" @click="closeManagerChat()">&times;</button>
          </div>
        </div>
        <div x-ref="chatBody" style="flex:1;overflow-y:auto;padding:20px;">
          <template x-if="chat.loading">
            <div style="color:#8b949e;padding:20px;text-align:center;">Loading...</div>
          </template>
          <template x-if="!chat.loading && chat.messages.length === 0 && !chat.pending">
            <div style="color:#8b949e;padding:20px;text-align:center;">Send a message to start chatting with the manager.</div>
          </template>
          <template x-for="(msg, index) in chat.messages" :key="chatMessageKey(msg, index)">
            <div class="mgr-chat-msg" :class="msg.role">
              <div class="mgr-chat-role">
                <span x-text="msg.role === 'user' ? '👤 You' : '🤖 Manager'"></span>
                <span style="color:#484f58;font-size:0.7rem;margin-left:8px;" x-show="msg.timestamp" x-text="formatTime(msg.timestamp)"></span>
              </div>
              <template x-if="shouldShowMessageSteps(msg)">
                <div class="mgr-steps" x-html="renderSteps(msg.steps)"></div>
              </template>
              <div class="mgr-chat-content" :class="{ 'assistant-md': msg.role === 'assistant' }" x-html="renderChatContent(msg)"></div>
            </div>
          </template>
          <template x-if="chat.pending">
            <div class="mgr-chat-msg assistant">
              <div class="mgr-chat-role">🤖 Manager</div>
              <template x-if="chat.verbose && chat.pending.steps && chat.pending.steps.length">
                <div class="mgr-steps" x-html="renderSteps(chat.pending.steps)"></div>
              </template>
              <template x-if="!chat.verbose && chat.live && chat.pending.steps && chat.pending.steps.length">
                <div class="mgr-steps" x-html="renderSteps(chat.pending.steps.filter(s => s.streaming))"></div>
              </template>
              <div class="mgr-chat-content assistant-md" :style="'color:' + chat.pending.color" x-text="chat.pending.text"></div>
            </div>
          </template>
        </div>
        <div style="display:flex;gap:8px;padding:12px 20px;border-top:1px solid #30363d;flex-shrink:0;">
          <input type="text" x-ref="chatInput" x-model="chat.input" @keydown.enter.exact.prevent="sendManagerChat()" placeholder="Ask the manager to do something..." style="flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:10px 12px;border-radius:6px;font-size:0.9rem;">
          <button class="btn btn-primary" @click="sendManagerChat()">Send</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function managersApp() {
      return {
        managers: [],
        refreshTimer: null,
        refreshInFlight: false,
        showManagerModal: false,
        showAssignmentModal: false,
        showOrgModal: false,
        showAgentSelectModal: false,
        managerAgents: [],
        availableOrgAgents: [],
        mgrForm: { originalId: '', id: '', name: '', desc: '', agent: 'manager:manager', editing: false },
        asgnForm: { managerId: '', originalId: '', id: '', name: '', prompt: '', schedule: 'never', editing: false },
        orgForm: { managerId: '', agentId: '' },
        agentSelect: { managerId: '', agent: 'manager:manager' },
        historyOpen: {},
        histories: {},
        schedEditor: {
          show: false,
          top: 0,
          left: 0,
          managerId: '',
          assignmentId: '',
          rawSchedule: 'never',
          mode: 'never',
          num: 1,
          unit: 'h',
          dailyTime: '09:00',
          weeklyTime: '09:00',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          cron: '',
          previewText: '—',
          previewColor: '#8b949e'
        },
        chat: {
          show: false,
          managerId: '',
          title: 'Chat',
          input: '',
          messages: [],
          pending: null,
          runId: null,
          verbose: false,
          live: false,
          poller: null,
          loading: false
        },

        async init() {
          this.chat.verbose = localStorage.getItem('mgrVerbose') === 'true';
          this.chat.live = localStorage.getItem('mgrLive') === 'true';
          document.addEventListener('keydown', this.handleGlobalKeydown.bind(this));
          await this.refresh();
          const self = this;
          this.refreshTimer = setInterval(function() { self.refresh(); }, 10000);
        },

        handleGlobalKeydown(e) {
          if (e.key !== 'Escape') return;
          if (this.chat.show) {
            this.closeManagerChat();
          } else if (this.schedEditor.show) {
            this.closeScheduleEditor();
          } else if (this.showAgentSelectModal) {
            this.closeAgentSelectModal();
          } else if (this.showOrgModal) {
            this.closeOrgModal();
          } else if (this.showAssignmentModal) {
            this.closeAssignmentModal();
          } else if (this.showManagerModal) {
            this.closeManagerModal();
          }
        },

        async request(url, options) {
          const res = await fetch(url, options || {});
          let data = null;
          const type = res.headers.get('content-type') || '';
          if (type.includes('application/json')) {
            data = await res.json();
          } else {
            const text = await res.text();
            try { data = JSON.parse(text); } catch { data = text; }
          }
          if (!res.ok) {
            throw new Error(data && data.error ? data.error : 'Request failed');
          }
          return data;
        },

        async refresh() {
          if (this.refreshInFlight) return;
          this.refreshInFlight = true;
          try {
            const data = await this.request('/api/managers');
            this.managers = Array.isArray(data) ? data : [];
            const openIds = Object.keys(this.historyOpen).filter((id) => this.historyOpen[id]);
            await Promise.all(openIds.map((id) => this.refreshHistory(id, true)));
          } catch (e) {
            console.error(e);
          } finally {
            this.refreshInFlight = false;
          }
        },

        findManager(managerId) {
          return this.managers.find((m) => m.manager_id === managerId) || null;
        },

        managerAgentLabel(manager) {
          return (manager && manager.config && manager.config.agent) || 'manager:manager';
        },

        assignmentScheduleLabel(assignment) {
          const schedule = assignment && assignment.schedule ? assignment.schedule : 'never';
          return assignment && assignment.scheduleDescription ? schedule + ' (' + assignment.scheduleDescription + ')' : schedule;
        },

        formatTime(value) {
          if (!value) return '';
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return '';
          return d.toLocaleTimeString();
        },

        formatDateTime(value) {
          if (!value) return '';
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return '';
          return d.toLocaleString();
        },

        truncate(value, maxLen) {
          const text = value || '';
          return text.length > maxLen ? text.substring(0, maxLen) : text;
        },

        async loadManagerAgents() {
          try {
            const variants = await this.request('/api/manager-agents');
            this.managerAgents = Array.isArray(variants) && variants.length ? variants : [{ id: 'manager:manager', description: 'Default manager agent' }];
          } catch {
            this.managerAgents = [{ id: 'manager:manager', description: 'Default manager agent' }];
          }
        },

        async showCreateManager() {
          await this.loadManagerAgents();
          this.mgrForm = { originalId: '', id: '', name: '', desc: '', agent: 'manager:manager', editing: false };
          if (this.managerAgents.length && !this.managerAgents.some((v) => v.id === this.mgrForm.agent)) {
            this.mgrForm.agent = this.managerAgents[0].id;
          }
          this.showManagerModal = true;
          this.$nextTick(() => {
            const input = document.querySelector('#managerModal input');
            if (input) input.focus();
          });
        },

        async showEditManager(manager) {
          await this.loadManagerAgents();
          this.mgrForm = {
            originalId: manager.manager_id,
            id: manager.manager_id,
            name: (manager.config && manager.config.name) || '',
            desc: (manager.config && manager.config.description) || '',
            agent: this.managerAgentLabel(manager),
            editing: true
          };
          this.showManagerModal = true;
        },

        closeManagerModal() {
          this.showManagerModal = false;
        },

        async saveManager() {
          const config = {
            id: (this.mgrForm.id || '').trim(),
            name: (this.mgrForm.name || '').trim(),
            description: (this.mgrForm.desc || '').trim(),
            agent: (this.mgrForm.agent || '').trim() || 'manager:manager',
            org: [],
            assignments: []
          };
          if (!config.id || !config.name) {
            alert('ID and Name are required');
            return;
          }
          const existing = this.findManager(this.mgrForm.originalId || config.id);
          if (existing) {
            config.team = (existing.config && (existing.config.team || existing.config.org)) || [];
            config.assignments = (existing.config && existing.config.assignments) || [];
          }
          try {
            await this.request('/api/managers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config)
            });
            this.closeManagerModal();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async deleteManager(managerId) {
          if (!confirm('Delete this manager?')) return;
          try {
            await this.request('/api/managers/' + managerId, { method: 'DELETE' });
            if (this.chat.managerId === managerId) this.closeManagerChat();
            delete this.historyOpen[managerId];
            delete this.histories[managerId];
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async editManagerAgent(managerId, currentAgent) {
          await this.loadManagerAgents();
          this.agentSelect = { managerId: managerId, agent: currentAgent || 'manager:manager' };
          this.showAgentSelectModal = true;
        },

        closeAgentSelectModal() {
          this.showAgentSelectModal = false;
        },

        async saveAgentSelect() {
          const manager = this.findManager(this.agentSelect.managerId);
          if (!manager) return;
          const config = Object.assign({}, manager.config || {}, { agent: (this.agentSelect.agent || '').trim() || 'manager:manager' });
          try {
            await this.request('/api/managers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config)
            });
            this.closeAgentSelectModal();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async openManagerAgentInEditor(managerId) {
          try {
            await this.request('/api/managers/' + managerId + '/edit-agent', { method: 'POST' });
          } catch (e) {
            alert(e.message);
          }
        },

        async showAddAgent(managerId) {
          try {
            const agents = await this.request('/api/managers/' + managerId + '/available-agents');
            this.availableOrgAgents = Array.isArray(agents) ? agents : [];
            this.orgForm = { managerId: managerId, agentId: this.availableOrgAgents.length ? this.availableOrgAgents[0].id : '' };
            this.showOrgModal = true;
          } catch (e) {
            alert(e.message);
          }
        },

        closeOrgModal() {
          this.showOrgModal = false;
        },

        async addAgentToOrg() {
          if (!this.orgForm.agentId) return;
          try {
            await this.request('/api/managers/' + this.orgForm.managerId + '/team', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: this.orgForm.agentId })
            });
            this.closeOrgModal();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async removeFromOrg(managerId, agentId) {
          try {
            await this.request('/api/managers/' + managerId + '/team/' + agentId, { method: 'DELETE' });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        showAddAssignment(managerId) {
          this.asgnForm = { managerId: managerId, originalId: '', id: '', name: '', prompt: '', schedule: 'never', editing: false };
          this.showAssignmentModal = true;
        },

        showEditAssignment(managerId, assignment) {
          this.asgnForm = {
            managerId: managerId,
            originalId: assignment.id,
            id: assignment.id,
            name: assignment.name || '',
            prompt: assignment.prompt || '',
            schedule: assignment.schedule || 'never',
            editing: true
          };
          this.showAssignmentModal = true;
        },

        closeAssignmentModal() {
          this.showAssignmentModal = false;
        },

        async saveAssignment() {
          const payload = {
            id: (this.asgnForm.id || '').trim(),
            name: (this.asgnForm.name || '').trim(),
            prompt: (this.asgnForm.prompt || '').trim(),
            schedule: (this.asgnForm.schedule || '').trim() || 'never'
          };
          if (!payload.id || !payload.name || !payload.prompt) {
            alert('ID, Name, and Prompt are required');
            return;
          }
          const manager = this.findManager(this.asgnForm.managerId);
          const existing = manager && manager.config && manager.config.assignments
            ? manager.config.assignments.find((assignment) => assignment.id === (this.asgnForm.originalId || payload.id))
            : null;
          if (existing && existing.enabled === false) {
            payload.enabled = false;
          }
          try {
            await this.request('/api/managers/' + this.asgnForm.managerId + '/assignments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            this.closeAssignmentModal();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async deleteAssignment(managerId, assignmentId) {
          if (!confirm('Delete this assignment?')) return;
          try {
            await this.request('/api/managers/' + managerId + '/assignments/' + assignmentId, { method: 'DELETE' });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async toggleAssignment(managerId, assignmentId, enabled) {
          try {
            await this.request('/api/managers/' + managerId + '/assignments/' + assignmentId + '/toggle', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: enabled })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        openScheduleEditor(managerId, assignment, evt) {
          const rect = evt.currentTarget.getBoundingClientRect();
          let top = rect.top - 280 - 8;
          if (top < 10) top = rect.bottom + 8;
          let left = rect.left - 160;
          if (left < 10) left = 10;
          if (left + 380 > window.innerWidth) left = window.innerWidth - 390;
          this.schedEditor.show = true;
          this.schedEditor.top = top;
          this.schedEditor.left = left;
          this.schedEditor.managerId = managerId;
          this.schedEditor.assignmentId = assignment.id;
          this.detectScheduleMode(assignment.schedule || 'never');
        },

        closeScheduleEditor() {
          this.schedEditor.show = false;
        },

        detectScheduleMode(schedule) {
          const current = schedule || 'never';
          this.schedEditor.rawSchedule = current;
          if (!current || current === 'never') {
            this.schedEditor.mode = 'never';
          } else if (/^\d+[mh]$/i.test(current) || /^every\s+\d+\s*(min|hour|sec)/i.test(current)) {
            this.schedEditor.mode = 'interval';
          } else if (/weekday|M,T|mon|tue|wed|thu|fri|sat|sun/i.test(current)) {
            this.schedEditor.mode = 'weekly';
          } else if (/daily|^at\s+\d/i.test(current)) {
            this.schedEditor.mode = 'daily';
          } else {
            this.schedEditor.mode = 'cron';
          }

          let match;
          match = current.match(/(\d+)\s*([mh])/i);
          this.schedEditor.num = match ? parseInt(match[1], 10) : 1;
          this.schedEditor.unit = match ? match[2].toLowerCase() : 'h';

          let time = '09:00';
          match = current.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
          if (match) {
            let hours = parseInt(match[1], 10);
            const minutes = match[2] || '00';
            if (match[3] && match[3].toLowerCase() === 'pm' && hours < 12) hours += 12;
            if (match[3] && match[3].toLowerCase() === 'am' && hours === 12) hours = 0;
            time = String(hours).padStart(2, '0') + ':' + minutes;
          }
          this.schedEditor.dailyTime = time;
          this.schedEditor.weeklyTime = time;

          let checkedDays = [];
          if (/weekday/i.test(current)) {
            checkedDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
          } else {
            const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
            checkedDays = keys.filter((day) => new RegExp(day, 'i').test(current));
          }
          if (!checkedDays.length) checkedDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
          this.schedEditor.days = checkedDays;
          this.schedEditor.cron = current === 'never' ? '' : current;
          this.updateSchedulePreview();
        },

        onScheduleModeChanged() {
          if (this.schedEditor.mode === 'weekly' && !this.schedEditor.days.length) {
            this.schedEditor.days = ['mon', 'tue', 'wed', 'thu', 'fri'];
          }
          if (this.schedEditor.mode === 'cron' && !this.schedEditor.cron && this.schedEditor.rawSchedule !== 'never') {
            this.schedEditor.cron = this.schedEditor.rawSchedule || '';
          }
          this.updateSchedulePreview();
        },

        getScheduleValue() {
          if (this.schedEditor.mode === 'never') return 'never';
          if (this.schedEditor.mode === 'interval') {
            const num = String(this.schedEditor.num || '1').trim() || '1';
            return num + (this.schedEditor.unit || 'h');
          }
          if (this.schedEditor.mode === 'daily') {
            const time = this.schedEditor.dailyTime || '09:00';
            const pieces = time.split(':').map(Number);
            const hours = pieces[0] || 0;
            const minutes = pieces[1] || 0;
            const ampm = hours >= 12 ? 'pm' : 'am';
            const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
            return 'daily at ' + h12 + (minutes > 0 ? ':' + String(minutes).padStart(2, '0') : '') + ampm;
          }
          if (this.schedEditor.mode === 'weekly') {
            const checked = this.schedEditor.days.slice();
            if (!checked.length) return '';
            const time = this.schedEditor.weeklyTime || '09:00';
            const pieces = time.split(':').map(Number);
            const hours = pieces[0] || 0;
            const minutes = pieces[1] || 0;
            const ampm = hours >= 12 ? 'pm' : 'am';
            const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
            const timeStr = h12 + (minutes > 0 ? ':' + String(minutes).padStart(2, '0') : '') + ampm;
            if (checked.length === 5 && !checked.includes('sat') && !checked.includes('sun')) {
              return 'weekdays at ' + timeStr;
            }
            const dayMap = { mon: 'M', tue: 'T', wed: 'W', thu: 'Th', fri: 'F', sat: 'Sa', sun: 'Su' };
            return checked.map((day) => dayMap[day]).join(',') + ' at ' + timeStr;
          }
          return (this.schedEditor.cron || '').trim();
        },

        async updateSchedulePreview() {
          const value = this.getScheduleValue();
          if (!value || value === 'never') {
            this.schedEditor.previewText = value === 'never' ? 'Manual only' : '—';
            this.schedEditor.previewColor = '#8b949e';
            return;
          }
          try {
            const data = await this.request('/api/schedule/describe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ schedule: value })
            });
            this.schedEditor.previewText = '✓ ' + (data.description || value);
            this.schedEditor.previewColor = '#7ee787';
          } catch (e) {
            this.schedEditor.previewText = '⚠ ' + e.message;
            this.schedEditor.previewColor = '#f85149';
          }
        },

        async saveScheduleEditor() {
          const value = this.getScheduleValue();
          if (!value) return;
          try {
            await this.request('/api/managers/' + this.schedEditor.managerId + '/assignments/' + this.schedEditor.assignmentId + '/schedule', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ schedule: value })
            });
            this.closeScheduleEditor();
            await this.refresh();
          } catch (e) {
            alert('Invalid schedule: ' + e.message);
          }
        },

        filteredHistorySteps(run) {
          return ((run && run._steps) || []).filter((step) => step.action !== 'thinking');
        },

        historyStepKey(run, step) {
          return String(run.id) + ':' + (step.timestamp || '') + ':' + (step.action || '') + ':' + (step.agentId || '');
        },

        historyStepSummary(step) {
          const detail = step.agentId || this.truncate(step.result || '', 80) || step.message || '';
          return step.action + ': ' + detail;
        },

        async toggleHistory(managerId) {
          this.historyOpen[managerId] = !this.historyOpen[managerId];
          if (this.historyOpen[managerId]) {
            await this.refreshHistory(managerId);
          }
        },

        async refreshHistory(managerId, silent) {
          try {
            const runs = await this.request('/api/managers/' + managerId + '/history');
            this.histories[managerId] = (Array.isArray(runs) ? runs : []).map((run) => {
              let steps = [];
              try {
                steps = Array.isArray(run.steps) ? run.steps : JSON.parse(run.steps || '[]');
              } catch {
                steps = [];
              }
              return Object.assign({}, run, { _steps: steps });
            });
          } catch (e) {
            if (!silent) alert(e.message);
          }
        },

        async openManagerChat(managerId, managerName) {
          this.stopChatPolling();
          this.chat.show = true;
          this.chat.managerId = managerId;
          this.chat.title = '💬 ' + (managerName || managerId);
          this.chat.input = '';
          this.chat.messages = [];
          this.chat.pending = null;
          this.chat.runId = null;
          this.chat.loading = true;
          try {
            await this.loadChatHistory(managerId);
          } catch (e) {
            this.chat.messages = [{ role: 'assistant', content: 'Error: ' + e.message, timestamp: new Date().toISOString(), steps: [], alwaysShowSteps: false }];
          } finally {
            this.chat.loading = false;
            this.scrollChatToBottom();
            this.focusChatInput();
          }
        },

        closeManagerChat() {
          this.chat.show = false;
          this.chat.managerId = '';
          this.chat.title = 'Chat';
          this.chat.input = '';
          this.chat.messages = [];
          this.chat.pending = null;
          this.chat.runId = null;
          this.chat.loading = false;
          this.stopChatPolling();
        },

        toggleChatVerbose() {
          localStorage.setItem('mgrVerbose', this.chat.verbose ? 'true' : 'false');
          if (this.chat.runId) {
            this.pollChatRun();
          }
        },

        toggleChatLive() {
          localStorage.setItem('mgrLive', this.chat.live ? 'true' : 'false');
          if (this.chat.runId) {
            this.startChatPolling();
          }
        },

        async loadChatHistory(managerId) {
          const messages = await this.request('/api/managers/' + managerId + '/messages?limit=30');
          this.chat.messages = (Array.isArray(messages) ? messages : []).map((msg) => ({
            role: msg.role,
            content: msg.content,
            timestamp: msg.created_at,
            steps: [],
            alwaysShowSteps: false
          }));
          this.chat.pending = null;
          try {
            const runs = await this.request('/api/managers/' + managerId + '/history?limit=1');
            if (Array.isArray(runs) && runs.length > 0 && runs[0].status === 'running') {
              this.chat.runId = runs[0].id;
              this.chat.pending = { text: '🧠 Thinking...', steps: [], color: '#8b949e' };
              this.startChatPolling();
            }
          } catch {}
          this.scrollChatToBottom();
        },

        renderChatContent(msg) {
          if (msg.role === 'user') return escapeHtml(msg.content || '');
          return typeof marked !== 'undefined' ? marked.parse(msg.content || '') : escapeHtml(msg.content || '');
        },

        shouldShowMessageSteps(msg) {
          return !!(msg && msg.steps && msg.steps.length && (this.chat.verbose || msg.alwaysShowSteps));
        },

        renderSteps(steps) {
          const icons = { thinking: '🧠', run_agent: '▶️', agent_result: '✅', complete: '🏁', error: '❌', request_agent: '🔍' };
          return (steps || []).map((step) => {
            const icon = icons[step.action] || '•';
            let detail = '';
            if (step.action === 'thinking') {
              detail = 'Analyzing...';
            } else if (step.action === 'run_agent') {
              detail = 'Running <strong>' + escapeHtml(step.agentId || '') + '</strong>: ' + escapeHtml((step.prompt || '').substring(0, 100));
              if (step.streaming && step.partial) {
                detail += '<pre style="margin:6px 0 0;padding:8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;max-height:240px;overflow:auto;white-space:pre-wrap;color:#8b949e;font-size:0.75rem;">' + escapeHtml(step.partial) + '<span style="color:#3fb950;">▋</span></pre>';
              }
            } else if (step.action === 'agent_result') {
              detail = '<strong>' + escapeHtml(step.agentId || '') + '</strong> returned (exit ' + escapeHtml(String(step.exitCode ?? '')) + ', ' + escapeHtml(String(step.outputLength ?? '0')) + ' chars)';
            } else if (step.action === 'complete') {
              detail = 'Completed';
            } else if (step.action === 'error') {
              detail = escapeHtml(step.message || 'Error');
            } else if (step.action === 'request_agent') {
              detail = 'Requesting <strong>' + escapeHtml(step.agentId || '') + '</strong>: ' + escapeHtml(step.reason || '');
            } else {
              detail = escapeHtml(step.message || '');
            }
            const time = step.timestamp ? '<span style="color:#484f58;margin-left:8px;">' + this.formatTime(step.timestamp) + '</span>' : '';
            return '<div class="mgr-step ' + escapeHtml(step.action || '') + '">' + icon + ' ' + detail + time + '</div>';
          }).join('');
        },

        chatMessageKey(msg, index) {
          return (msg.role || 'msg') + ':' + (msg.timestamp || '') + ':' + index;
        },

        scrollChatToBottom() {
          this.$nextTick(() => {
            if (this.$refs.chatBody) {
              this.$refs.chatBody.scrollTop = this.$refs.chatBody.scrollHeight;
            }
          });
        },

        focusChatInput() {
          this.$nextTick(() => {
            if (this.$refs.chatInput) this.$refs.chatInput.focus();
          });
        },

        getRunStatusText(run) {
          const steps = run && run.steps ? run.steps : [];
          const lastStep = steps.length ? steps[steps.length - 1] : null;
          if (!lastStep) return 'Thinking...';
          if (lastStep.action === 'run_agent') return 'Running ' + (lastStep.agentId || 'agent') + '...';
          if (lastStep.action === 'agent_result') return 'Analyzing results...';
          if (lastStep.action === 'error') return lastStep.message || 'Error';
          return 'Thinking...';
        },

        async sendManagerChat() {
          if (!this.chat.managerId) return;
          const prompt = (this.chat.input || '').trim();
          if (!prompt) return;
          this.chat.input = '';
          this.chat.messages.push({ role: 'user', content: prompt, timestamp: new Date().toISOString(), steps: [], alwaysShowSteps: false });
          this.chat.pending = { text: 'Thinking...', steps: [], color: '#8b949e' };
          this.scrollChatToBottom();
          try {
            const data = await this.request('/api/managers/' + this.chat.managerId + '/prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: prompt, liveStream: !!this.chat.live })
            });
            if (data && data.runId) {
              this.chat.runId = data.runId;
              this.startChatPolling();
            }
          } catch (e) {
            this.chat.pending = { text: 'Error: ' + e.message, steps: [], color: '#f85149' };
            this.chat.runId = null;
          }
          this.focusChatInput();
        },

        async runAssignment(managerId, assignmentId) {
          const manager = this.findManager(managerId);
          await this.openManagerChat(managerId, (manager && manager.config && manager.config.name) || managerId);
          try {
            const data = await this.request('/api/managers/' + managerId + '/assignments/' + assignmentId + '/run', { method: 'POST' });
            if (data && data.runId) {
              this.chat.runId = data.runId;
              this.chat.pending = { text: 'Thinking...', steps: [], color: '#8b949e' };
              this.startChatPolling();
            }
          } catch (e) {
            this.chat.pending = { text: 'Error: ' + e.message, steps: [], color: '#f85149' };
          }
        },

        startChatPolling() {
          this.stopChatPolling();
          const self = this;
          const interval = this.chat.live ? 1000 : 2000;
          this.chat.poller = setInterval(function() { self.pollChatRun(); }, interval);
          this.pollChatRun();
        },

        stopChatPolling() {
          if (this.chat.poller) {
            clearInterval(this.chat.poller);
            this.chat.poller = null;
          }
        },

        async pollChatRun() {
          const managerId = this.chat.managerId;
          const runId = this.chat.runId;
          if (!managerId || !runId) return;
          try {
            const run = await this.request('/api/managers/' + managerId + '/runs/' + runId);
            if (this.chat.managerId !== managerId || this.chat.runId !== runId) return;
            const steps = Array.isArray(run.steps) ? run.steps : [];
            if (run.status === 'running') {
              this.chat.pending = { text: this.getRunStatusText(run), steps: steps, color: '#8b949e' };
            } else {
              this.stopChatPolling();
              this.chat.pending = null;
              this.chat.messages.push({
                role: 'assistant',
                content: run.result || run.error || 'No response',
                timestamp: run.completed_at || run.started_at || new Date().toISOString(),
                steps: steps,
                alwaysShowSteps: false
              });
              this.chat.runId = null;
              await this.refresh();
              if (this.historyOpen[managerId]) {
                await this.refreshHistory(managerId, true);
              }
            }
            this.scrollChatToBottom();
          } catch {}
        },

        async viewRun(managerId, runId) {
          const manager = this.findManager(managerId);
          this.stopChatPolling();
          this.chat.show = true;
          this.chat.managerId = managerId;
          this.chat.title = '💬 ' + ((manager && manager.config && manager.config.name) || managerId);
          this.chat.input = '';
          this.chat.messages = [];
          this.chat.pending = null;
          this.chat.runId = null;
          this.chat.loading = true;
          try {
            const run = await this.request('/api/managers/' + managerId + '/runs/' + runId);
            const steps = Array.isArray(run.steps) ? run.steps : [];
            if (run.prompt) {
              this.chat.messages.push({ role: 'user', content: run.prompt, timestamp: run.started_at, steps: [], alwaysShowSteps: false });
            }
            if (run.status === 'running') {
              this.chat.runId = run.id;
              this.chat.pending = { text: this.getRunStatusText(run), steps: steps, color: '#8b949e' };
              this.startChatPolling();
            } else {
              this.chat.messages.push({
                role: 'assistant',
                content: run.result || run.error || 'No response',
                timestamp: run.completed_at || run.started_at,
                steps: steps,
                alwaysShowSteps: true
              });
            }
          } catch (e) {
            this.chat.messages = [{ role: 'assistant', content: 'Error: ' + e.message, timestamp: new Date().toISOString(), steps: [], alwaysShowSteps: false }];
          } finally {
            this.chat.loading = false;
            this.scrollChatToBottom();
            this.focusChatInput();
          }
        }
      };
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
</body>
</html>`;
}