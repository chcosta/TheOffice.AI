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

// Ensure tasks.json exists
if (!fs.existsSync(TASKS_PATH)) {
  fs.writeFileSync(TASKS_PATH, '[]');
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
      agent: `${item.id}:${item.id}`,
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
    res.json(marketplace.getCatalog({
      type: req.query.type || null,
      q: req.query.q || null,
      sourceId: req.query.sourceId || null,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      agent: `${baseId}:${baseId}`,
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
// and cascade-clean afterwards. Managers keep the agent id in their `org`
// array; tasks reference it via `agentId`; flows reference it indirectly via a
// step's task, or directly via an AI edge condition's `agentId`.
function computeAgentDependents(agentId) {
  const managers = [];
  try {
    if (fs.existsSync(MANAGERS_PATH)) {
      for (const m of JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'))) {
        if (Array.isArray(m.org) && m.org.includes(agentId)) managers.push({ id: m.id, name: m.name || m.id });
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

  // Cascade 1: strip the agent from every manager's org (runtime + managers.json)
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
        managers[mi].org = runtime ? runtime.config.org : (managers[mi].org || []).filter(x => x !== agentId);
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
      // Re-read agent.md if present
      const agentsDir = path.join(agent.pluginDir, 'agents');
      if (fs.existsSync(agentsDir)) {
        const mdFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
        if (mdFiles.length > 0) {
          const content = fs.readFileSync(path.join(agentsDir, mdFiles[0]), 'utf-8');
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
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    let changed = 0;
    agents.forEach(a => {
      if (a.group === oldName) { a.group = newName; changed++; }
    });
    if (changed === 0) return res.status(404).json({ error: 'No agents in that group' });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    // Update in-memory configs
    for (const [, entry] of supervisor.agents) {
      if (entry.config.group === oldName) entry.config.group = newName;
    }
    res.json({ ok: true, changed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a group (move agents to Ungrouped)
app.delete('/api/groups/:name', (req, res) => {
  const groupName = decodeURIComponent(req.params.name);
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    let changed = 0;
    agents.forEach(a => {
      if (a.group === groupName) { delete a.group; changed++; }
    });
    if (changed === 0) return res.status(404).json({ error: 'No agents in that group' });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    for (const [, entry] of supervisor.agents) {
      if (entry.config.group === groupName) delete entry.config.group;
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
  const { id, name, agentId, prompt, schedule, enabled } = req.body;
  if (!name || !agentId) return res.status(400).json({ error: 'name and agentId are required' });
  const tasks = loadTasks();
  const taskId = id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // Check for name collision
  const existing = tasks.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'duplicate_name', existingId: existing.id, message: `A task named "${name}" already exists.` });
  }
  const task = { id: taskId, name, agentId, prompt: prompt || '', schedule: schedule || 'never', enabled: enabled !== false, createdAt: new Date().toISOString() };
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
  const { name, prompt, schedule, enabled } = req.body;
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
app.get('/api/agents/:id/check-update', async (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
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
      return res.json({
        upToDate: !current || !s.objectId || current === s.objectId,
        reason: 'azdo',
        source: s,
        currentObjectId: current
      });
    } catch (e) {
      return res.json({ upToDate: true, reason: 'azdo-error', error: e.message });
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
  if (!sourceDir || !pluginDir) return res.json({ upToDate: true, reason: 'no-overlay' });
  // If sourceDir === pluginDir, no comparison needed
  if (path.resolve(sourceDir) === path.resolve(pluginDir)) return res.json({ upToDate: true, reason: 'same-dir' });
  // Both must exist
  if (!fs.existsSync(sourceDir)) return res.json({ upToDate: true, reason: 'source-missing' });
  if (!fs.existsSync(pluginDir)) return res.json({ upToDate: false, reason: 'installed-missing' });

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
  
  res.json({
    upToDate: diffs.length === 0,
    diffs: diffs.slice(0, 10),
    sourceDir,
    pluginDir
  });
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
  // Write a temp batch file with error diagnostics
  const batContent = [
    '@echo off',
    `if not exist "${cwd}" (`,
    `  echo ERROR: Working directory not found: ${cwd}`,
    '  pause',
    '  exit /b 1',
    ')',
    `cd /d "${cwd}"`,
    `where "${copilotCmd}" >nul 2>&1 || (`,
    `  echo ERROR: copilot not found in PATH`,
    '  echo PATH=%PATH%',
    '  pause',
    '  exit /b 1',
    ')',
    `"${copilotCmd}" --resume=${req.params.id} --yolo`,
    'pause'
  ].join('\n');
  const batPath = path.join(__dirname, 'temp-terminal.bat');
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
  const batContent = [
    '@echo off',
    `if not exist "${cwd}" (`,
    `  echo ERROR: Working directory not found: ${cwd}`,
    '  pause',
    '  exit /b 1',
    ')',
    `cd /d "${cwd}"`,
    `where "${copilotCmd}" >nul 2>&1 || (`,
    `  echo ERROR: copilot not found in PATH`,
    '  echo PATH=%PATH%',
    '  pause',
    '  exit /b 1',
    ')',
    `"${copilotCmd}" --yolo`,
    'pause'
  ].join('\n');
  const batPath = path.join(__dirname, 'temp-terminal.bat');
  fs.writeFileSync(batPath, batContent);
  exec(`start "Copilot Session" "${batPath}"`);
  res.json({ ok: true });
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
        // Pull in the manager's org agents too.
        for (const orgId of (Array.isArray(manager.org) ? manager.org : [])) installAgentById(orgId);
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
  if (!config.org) config.org = [];
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

// Start a manager's schedules
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
  const { id: assignmentId, name, prompt, schedule, enabled } = req.body;
  if (!assignmentId || !name || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: id, name, prompt' });
  }

  const entry = managerAgent.managers.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Manager not found' });

  if (!entry.config.assignments) entry.config.assignments = [];
  const existingIdx = entry.config.assignments.findIndex(a => a.id === assignmentId);
  const assignment = { id: assignmentId, name, prompt, schedule: schedule || 'never', enabled: enabled !== false };
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

// Manage org: add agent
app.post('/api/managers/:id/org', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  try {
    managerAgent.addToOrg(req.params.id, agentId);
    // Persist
    let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === req.params.id);
    if (mi >= 0) { managers[mi].org = managerAgent.managers.get(req.params.id).config.org; }
    fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manage org: remove agent
app.delete('/api/managers/:id/org/:agentId', (req, res) => {
  try {
    managerAgent.removeFromOrg(req.params.id, req.params.agentId);
    // Persist
    let managers = JSON.parse(fs.readFileSync(MANAGERS_PATH, 'utf-8'));
    const mi = managers.findIndex(m => m.id === req.params.id);
    if (mi >= 0) { managers[mi].org = managerAgent.managers.get(req.params.id).config.org; }
    fs.writeFileSync(MANAGERS_PATH, JSON.stringify(managers, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get available agents not in manager's org
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
// Ephemeral try-run buffers, keyed by runId.
const suggestionRuns = new Map();

function suggestionAgentCatalog() {
  return supervisor.getAllStatus().map(a => ({
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
  const agents = suggestionAgentCatalog();
  if (!agents.length) return res.status(400).json({ error: 'No agents available to design with.' });
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
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/execution-suggestions', (req, res) => {
  res.json({ pinned: loadPinnedSuggestions() });
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
  if (!sug || !sug.kind) return res.status(400).json({ error: 'suggestion required' });
  try {
    if (sug.kind === 'task') {
      if (!sug.agentId || !sug.prompt) return res.status(400).json({ error: 'task suggestion missing agent or prompt' });
      const tasks = loadTasks();
      const id = 'task-ai-' + require('crypto').randomBytes(4).toString('hex');
      const task = { id, name: sug.title || 'AI Task', agentId: sug.agentId, prompt: sug.prompt, schedule: 'never', enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
      tasks.push({ id: tid, name: (st.title || (sug.title + ' step ' + (i + 1))), agentId: st.agentId, prompt: st.prompt, schedule: 'never', enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
    const chain = chainEngine.create({ name: sug.title || 'AI Flow', description: sug.description || '', schedule: 'never', enabled: true, steps: chainSteps, edges });
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
      return { id: data.id, title: data.title, target: data.target, targetType: data.targetType, updatedAt: data.updatedAt, messageCount: (data.messages || []).length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(chats);
});

app.get('/api/chats/:id', (req, res) => {
  const chatFile = path.join(CHATS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(chatFile)) return res.status(404).json({ error: 'Chat not found' });
  res.json(JSON.parse(fs.readFileSync(chatFile, 'utf-8')));
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
        output: (run.result || '').slice(0, 500)
      });
    }
  } catch {}
  
  // Sort by timestamp descending
  activities.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  res.json(activities.slice(0, limit));
});

// Single run detail
app.get('/api/activity/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const entry = supervisor.agents.get(row.agent_id);
  res.json({
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
    sessionId: row.session_id
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

// Start all enabled agents
supervisor.startAll();

const server = app.listen(PORT, () => {
  console.log(`[supervisor] Dashboard running at http://localhost:${PORT}`);
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
            <div class="org-label">Organization (Agents)</div>
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
        <h3>Add Agent to Organization</h3>
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
            config.org = (existing.config && existing.config.org) || [];
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
            await this.request('/api/managers/' + this.orgForm.managerId + '/org', {
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
            await this.request('/api/managers/' + managerId + '/org/' + agentId, { method: 'DELETE' });
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