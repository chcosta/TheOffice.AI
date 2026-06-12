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
  const pluginsDir = path.join(homeDir, '.copilot', 'installed-plugins', '_direct');
  const managerPluginDir = path.join(__dirname, 'plugins', 'manager');
  const targetDir = path.join(pluginsDir, 'manager');

  if (!fs.existsSync(managerPluginDir)) return;

  // Create junction if missing
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(pluginsDir, { recursive: true });
      require('child_process').execSync(`mklink /J "${targetDir}" "${managerPluginDir}"`, { shell: true });
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

// Forward supervisor events to SSE clients
supervisor.on('agent-running', (agentId) => {
  broadcastSSE('agent-status', { id: agentId, status: 'running' });
});
supervisor.on('agent-output', ({ agentId, stream, chunk }) => {
  broadcastSSE('agent-output', { id: agentId, stream, chunk });
});
supervisor.on('agent-completed', ({ agentId, code, output, error, sessionId }) => {
  broadcastSSE('agent-completed', { id: agentId, code, output: output?.slice(-10000), error: error?.slice(-2000), sessionId });
});
// Initialize manager agent system
const managerAgent = new ManagerAgent(db, supervisor);
const eventListener = new EventListener(supervisor, managerAgent, db);

// Mobile command handler — processes structured JSON messages from phone app
const mobileHandler = new MobileHandler(supervisor, managerAgent, db, eventListener);
eventListener.mobileHandler = mobileHandler;

// Activity log persistence — write supervisor events into activity_log table
supervisor.on('agent-running', (agentId) => {
  try {
    const entry = supervisor.agents.get(agentId);
    const name = entry?.config?.name || agentId;
    const trigger = entry?._triggeredBy || 'manual';
    db.prepare(
      `INSERT INTO activity_log (agent_id, status, trigger, created_at) VALUES (?, 'running', ?, datetime('now'))`
    ).run(agentId, trigger);
  } catch (err) {
    console.error('[activity-log] Error writing running event:', err.message);
  }
});

supervisor.on('agent-completed', ({ agentId, code, output, error, sessionId }) => {
  try {
    const status = code === 0 ? 'completed' : 'failed';
    const finalOutput = code === 0 ? (output || '').slice(-50000) : (error || output || '').slice(-50000);
    // Update the most recent 'running' row for this agent
    const row = db.prepare(
      `SELECT id, created_at FROM activity_log WHERE agent_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
    ).get(agentId);
    if (row) {
      const startTime = new Date(row.created_at + 'Z').getTime();
      const durationMs = Date.now() - startTime;
      db.prepare(
        `UPDATE activity_log SET status = ?, output = ?, duration_ms = ? WHERE id = ?`
      ).run(status, finalOutput, durationMs, row.id);
    } else {
      // No running row found — insert a completed row directly
      db.prepare(
        `INSERT INTO activity_log (agent_id, status, output, trigger, duration_ms, created_at) VALUES (?, ?, ?, 'unknown', 0, datetime('now'))`
      ).run(agentId, status, finalOutput);
    }
  } catch (err) {
    console.error('[activity-log] Error writing completed event:', err.message);
  }
});

// Session cleanup interval for idle event listener sessions
setInterval(() => eventListener.cleanupIdleSessions(), 60000);

// Load agent configs
function loadAgents() {
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  agents.forEach(agent => supervisor.register(agent));
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
  }
});
// Wire leader check into scheduler (schedules only fire if leader or sync disabled)
const leaderCheck = () => !configSync.enabled || configSync.isLeader;
supervisor.setLeaderCheck(leaderCheck);
managerAgent.setLeaderCheck(leaderCheck);
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
      const overlayDir = path.join(__dirname, 'plugins', pluginName);

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

// SPA — serve new unified app for all page routes
function serveSpa(req, res) {
  if (fs.existsSync(SPA_PATH)) {
    res.sendFile(SPA_PATH);
  } else {
    // Fallback to legacy pages if SPA not built yet
    res.send(getDashboardHtml());
  }
}
['/', '/agents', '/dashboard', '/managers', '/tasks', '/chat', '/activity'].forEach(route => {
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

// Chat with an agent — starts/resumes a copilot session and sends a prompt
app.post('/api/agents/:id/chat', (req, res) => {
  const { message, sessionId: existingSessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  
  const agentEntry = supervisor.agents.get(req.params.id);
  if (!agentEntry) return res.status(404).json({ error: 'Agent not found' });
  
  const copilotCmd = process.env.COPILOT_PATH || 'copilot';
  const agentConfig = agentEntry.config;
  const cwd = agentConfig.cwd || __dirname;
  const escapedMsg = message.replace(/"/g, '\\"');
  const { spawn } = require('child_process');
  
  let cmd;
  if (existingSessionId) {
    // Resume existing session
    cmd = `${copilotCmd} --resume=${existingSessionId} -p "${escapedMsg}" -s --yolo`;
  } else {
    // Start new session with the agent
    const agentFlag = agentConfig.agent ? `--agent "${agentConfig.agent}"` : '';
    cmd = `${copilotCmd} ${agentFlag} -p "${escapedMsg}" -s --yolo`;
  }
  
  const shellPath = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\system32\\cmd.exe' : '/bin/sh');
  const proc = spawn(cmd, [], { cwd, shell: shellPath, stdio: ['ignore', 'ignore', 'pipe'] });
  
  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d; });
  proc.on('error', e => {
    console.error(`[agent-chat] spawn error: ${e.message}`);
  });
  proc.on('close', code => {
    console.log(`[agent-chat] agent ${req.params.id} chat exited (${code})`);
    broadcastSSE('agent-chat-complete', { agentId: req.params.id, code });
  });
  proc.unref();
  
  // Try to find the session ID that was just created (will appear after a moment)
  // Return immediately — client will poll for the session
  res.json({ ok: true, started: true, existingSessionId: existingSessionId || null });
});

// Find the most recent session for an agent (by matching agent name in session start events)
app.get('/api/agents/:id/session', (req, res) => {
  const agentEntry = supervisor.agents.get(req.params.id);
  if (!agentEntry) return res.status(404).json({ error: 'Agent not found' });
  
  const SESSION_STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state');
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
  const { schedule } = req.body;
  if (!schedule) return res.status(400).json({ error: 'schedule required' });
  try {
    supervisor.updateSchedule(req.params.id, schedule);
    // Persist to agents.json
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const agent = agents.find(a => a.id === req.params.id);
    if (agent) {
      agent.schedule = schedule;
      // If setting a real schedule (not 'never'), clear triggers (mutual exclusion)
      if (schedule.toLowerCase() !== 'never' && agent.triggers) {
        delete agent.triggers;
        const entry = supervisor.agents.get(req.params.id);
        if (entry) delete entry.config.triggers;
      }
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  entry.config.prompt = prompt;
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === req.params.id);
  if (agent) {
    agent.prompt = prompt;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
  }
  res.json({ ok: true });
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

app.put('/api/agents/:id/triggers', (req, res) => {
  const { triggers } = req.body;
  try {
    // Update in-memory config
    const entry = supervisor.agents.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Agent not found' });
    entry.config.triggers = triggers || undefined;

    // Persist to agents.json
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
    const agent = agents.find(a => a.id === req.params.id);
    if (agent) {
      if (triggers && Object.keys(triggers).length > 0) {
        agent.triggers = triggers;
      } else {
        delete agent.triggers;
      }
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/agents', (req, res) => {
  const config = req.body;
  if (!config.id || !config.name || !config.cwd || !config.agent || !config.schedule || !config.prompt) {
    return res.status(400).json({ error: 'Missing required fields: id, name, cwd, agent, schedule, prompt' });
  }
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

app.delete('/api/agents/:id', (req, res) => {
  supervisor.stop(req.params.id);
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const filtered = agents.filter(a => a.id !== req.params.id);
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(filtered, null, 2));
  res.json({ ok: true });
});

// Reinstall an agent (re-read source definition and re-register)
app.post('/api/agents/:id/reinstall', (req, res) => {
  const agentId = req.params.id;
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
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
}

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
  broadcastSSE('task-updated', tasks[idx]);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const filtered = tasks.filter(t => t.id !== req.params.id);
  if (filtered.length === tasks.length) return res.status(404).json({ error: 'Task not found' });
  saveTasks(filtered);
  broadcastSSE('task-deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Run a task by ID (triggers the associated agent with the task's prompt)
app.post('/api/tasks/:id/run', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const entry = supervisor.agents.get(task.agentId);
  if (!entry) return res.status(404).json({ error: `Agent "${task.agentId}" not found` });
  // Override the prompt temporarily and run
  const originalPrompt = entry.config.prompt;
  entry.config.prompt = task.prompt;
  supervisor._executeAgent(task.agentId);
  entry.config.prompt = originalPrompt;
  broadcastSSE('task-running', { taskId: task.id, agentId: task.agentId });
  res.json({ ok: true, message: `Task "${task.name}" started on agent "${task.agentId}"` });
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
  if (!targetDir && config.pluginDir && config.pluginDir.includes(path.join(__dirname, 'plugins'))) {
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
app.get('/api/agents/:id/check-update', (req, res) => {
  const entry = supervisor.agents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Agent not found' });
  const config = entry.config;
  let sourceDir = config.sourceDir;
  const pluginDir = config.pluginDir;
  
  // If no explicit sourceDir, try to infer: if pluginDir is under our plugins/ folder,
  // check if there's a matching .github/plugin/<name> in the agent's cwd
  if (!sourceDir && pluginDir && pluginDir.includes(path.join(__dirname, 'plugins'))) {
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
    const localDir = path.join(__dirname, 'plugins', path.basename(pluginDir));
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
    `Subject: ${subject || 'Shared from Agent Supervisor'}`,
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
    summary: subject || 'Shared from Agent Supervisor',
    sections: [{
      activityTitle: subject || 'Shared from Agent Supervisor',
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

// Track chat errors per session for surfacing in poll
const chatErrors = new Map();

app.post('/api/sessions/:id/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const meta = readSessionMeta(sessionDir);
  const copilotCmd = process.env.COPILOT_PATH || 'copilot';
  const escapedMsg = message.replace(/"/g, '\\"');
  const { spawn } = require('child_process');
  const cmd = `${copilotCmd} --resume=${req.params.id} -p "${escapedMsg}" -s --yolo`;
  const shellPath = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\system32\\cmd.exe' : '/bin/sh');
  const proc = spawn(cmd, [], { cwd: meta.cwd || undefined, shell: shellPath, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d; console.error(`[chat] stderr: ${d}`); });
  proc.on('error', e => {
    console.error(`[chat] spawn error: ${e.message}`);
    chatErrors.set(req.params.id, { error: e.message, time: Date.now() });
  });
  proc.on('close', code => {
    console.log(`[chat] session ${req.params.id.substring(0,8)} exited (${code})`);
    if (code !== 0 && stderrBuf.trim()) {
      chatErrors.set(req.params.id, { error: stderrBuf.trim(), code, time: Date.now() });
    }
  });
  proc.unref();
  // Clear any previous error for this session
  chatErrors.delete(req.params.id);
  // Return immediately — client polls for live updates
  res.json({ ok: true, started: true });
});

// Poll a session for latest state (turn count + last assistant message)
app.get('/api/sessions/:id/poll', (req, res) => {
  const sessionDir = path.join(SESSION_STATE_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return res.json({ turnCount: 0, lastAssistant: '', isActive: false, turns: [] });
  
  const verbose = req.query.verbose === '1';
  const stat = fs.statSync(eventsPath);
  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
  let turnCount = 0;
  let lastAssistant = '';
  const allTurns = [];
  let currentUser = null;
  let currentSteps = [];
  let subTurnCount = 0; // track assistant sub-turns within a user turn
  let lastAssistantMsg = '';
  let currentModel = null; // track model per assistant message
  // Session-level metadata (verbose only)
  let sessionMeta = null;
  let tokenStats = null;
  let modelChanges = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
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
        // Update meta on resume if not set
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
        modelChanges.push(ev.data.newModel);
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
        // Flush previous turn
        if (currentUser !== null || lastAssistantMsg) {
          allTurns.push({ content: currentUser || '', assistant: lastAssistantMsg || null, model: verbose ? currentModel : undefined, steps: verbose ? [...currentSteps] : undefined });
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
  // Flush last turn
  if (currentUser !== null || lastAssistantMsg) {
    allTurns.push({ content: currentUser || '', assistant: lastAssistantMsg || null, model: verbose ? currentModel : undefined, steps: verbose ? [...currentSteps] : undefined });
  }
  // Remove duplicate: if last step is a comment matching the final assistant response, drop it
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
  const isActive = (Date.now() - stat.mtime.getTime()) < 30000;
  // Include any chat error for this session
  const chatErr = chatErrors.get(req.params.id);
  const response = { turnCount, lastAssistant, isActive, lastModified: stat.mtime.toISOString(), turns: allTurns };
  if (verbose) {
    if (sessionMeta) response.sessionMeta = sessionMeta;
    if (tokenStats) response.tokenStats = tokenStats;
  }
  if (chatErr) {
    response.chatError = chatErr.error;
    chatErrors.delete(req.params.id);
  }
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

  // plugins directory
  const pluginsDir = path.join(__dirname, 'plugins');
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

  // mcp-configs directory
  const mcpDir = path.join(__dirname, 'mcp-configs');
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

  // Export agent state (enabled/disabled, schedules, triggers) from DB
  const agentStates = [];
  const allStatus = supervisor.getAllStatus();
  for (const agent of allStatus) {
    agentStates.push({
      agent_id: agent.agent_id,
      enabled: agent.enabled,
      schedule: agent.schedule,
      triggers: agent.config?.triggers || {},
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
          const localPluginDir = path.join(__dirname, 'plugins', pluginName);
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
        const destPath = path.join(__dirname, filePath.replace(/\//g, path.sep));
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
      const pluginsDir = path.join(__dirname, 'plugins');
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
        const destPath = path.join(__dirname, filePath.replace(/\//g, path.sep));
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
app.get('/api/sync/status', async (req, res) => {
  try {
    const leaderInfo = configSync.enabled ? await configSync.getLeaderInfo() : null;
    res.json({
      enabled: configSync.enabled,
      isLeader: configSync.isLeader,
      epoch: configSync.epoch,
      machineId: configSync.machineId,
      leaderInfo,
      pathIssues: configSync.enabled ? configSync.scanUnresolvedPaths() : []
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

// Scan for path issues
app.get('/api/sync/path-issues', (req, res) => {
  res.json(configSync.scanUnresolvedPaths());
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

  const assignment = { id: assignmentId, name, prompt, schedule: schedule || 'never', enabled: enabled !== false };
  if (!entry.config.assignments) entry.config.assignments = [];
  const existing = entry.config.assignments.findIndex(a => a.id === assignmentId);
  if (existing >= 0) {
    entry.config.assignments[existing] = assignment;
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
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const result = managerAgent.executePrompt(req.params.id, prompt);
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
  const agentFile = path.join(__dirname, 'plugins', plugin, 'agents', `${agent}.agent.md`);
  if (!fs.existsSync(agentFile)) return res.status(404).json({ error: `Agent file not found: ${agentFile}` });
  const { spawn: sp } = require('child_process');
  sp('code-insiders', [agentFile], { shell: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true, file: agentFile });
});

// List available manager agent variants
app.get('/api/manager-agents', (req, res) => {
  const agentsDir = path.join(__dirname, 'plugins', 'manager', 'agents');
  if (!fs.existsSync(agentsDir)) return res.json([]);
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
  const variants = files.map(f => {
    const name = f.replace('.agent.md', '');
    const content = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
    const descMatch = content.match(/description:\s*(.+)/);
    return { id: `manager:${name}`, name, description: descMatch?.[1]?.trim() || '' };
  });
  res.json(variants);
});

// ============ End Manager API Routes ============

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

// Unified activity feed across all agents and managers
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activities = [];
  
  // Gather agent run history
  for (const [id, entry] of supervisor.agents) {
    const history = entry.history || [];
    for (const run of history.slice(-20)) {
      activities.push({
        type: 'agent',
        entityId: id,
        entityName: entry.config.name || id,
        action: 'run',
        status: run.status || (run.exitCode === 0 ? 'success' : 'failed'),
        timestamp: run.startedAt || run.timestamp,
        duration: run.duration,
        output: (run.output || '').slice(0, 500)
      });
    }
  }
  
  // Gather manager run history
  for (const [id, mgr] of managerAgent.managers) {
    const runs = mgr.runs || [];
    for (const run of runs.slice(-20)) {
      activities.push({
        type: 'manager',
        entityId: id,
        entityName: mgr.name || id,
        action: run.assignmentId ? `assignment:${run.assignmentId}` : 'prompt',
        status: run.status || 'completed',
        timestamp: run.startedAt,
        duration: run.duration,
        output: (run.summary || '').slice(0, 500)
      });
    }
  }
  
  // Sort by timestamp descending
  activities.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  res.json(activities.slice(0, limit));
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

app.put('/api/events/config', express.json(), (req, res) => {
  const update = req.body;
  // Don't overwrite connection string with masked value
  if (update.connectionString && update.connectionString.includes('•••••')) {
    update.connectionString = eventListener.config.connectionString;
  }
  Object.assign(eventListener.config, update);
  eventListener._saveConfig();
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

app.get('/api/events/log', (req, res) => {
  res.json(eventListener.eventLog);
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

// SPA catch-all: serve app.html for any non-API route (must be last)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  serveSpa(req, res);
});

// Start all enabled agents
supervisor.startAll();

const server = app.listen(PORT, () => {
  console.log(`[supervisor] Dashboard running at http://localhost:${PORT}`);
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

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot Agent Supervisor</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { color: #58a6ff; margin-bottom: 24px; font-size: 1.5rem; }
    .agents { display: grid; gap: 16px; }
    .agent-group { margin-bottom: 8px; }
    .group-header {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px;
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      cursor: pointer; user-select: none; transition: border-color 0.2s;
    }
    .group-header:hover { border-color: #58a6ff; }
    .group-toggle { color: #58a6ff; font-size: 0.9rem; width: 16px; }
    .group-name { font-size: 1rem; font-weight: 600; color: #f0f6fc; }
    .group-count { font-size: 0.8rem; color: #8b949e; }
    .group-status-dots { display: flex; gap: 4px; margin-left: auto; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot-idle { background: #58a6ff; }
    .dot-running { background: #f78835; }
    .dot-scheduled { background: #3fb950; }
    .dot-error { background: #f85149; }
    .dot-stopped { background: #8b949e; }
    .group-body { padding-left: 0; margin-top: 8px; display: grid; gap: 12px; }
    .group-body.collapsed { display: none; }
    .group-actions { display: flex; gap: 4px; margin-left: 8px; }
    .group-actions .btn { padding: 2px 8px; font-size: 0.7rem; }
    .group-select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; padding: 2px 6px; font-size: 0.75rem; cursor: pointer; }
    .group-select:focus { border-color: #58a6ff; outline: none; }
    .agent-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px;
      transition: border-color 0.2s, opacity 0.2s;
    }
    .agent-card:hover { border-color: #58a6ff; }
    .agent-card.agent-disabled { opacity: 0.55; border-style: dashed; }
    .toggle-switch { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; inset: 0; background: #484f58; border-radius: 20px; transition: 0.2s;
    }
    .toggle-slider::before {
      content: ''; position: absolute; width: 14px; height: 14px; left: 3px; bottom: 3px;
      background: #c9d1d9; border-radius: 50%; transition: 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider { background: #238636; }
    .toggle-switch input:checked + .toggle-slider::before { transform: translateX(16px); }
    .agent-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .agent-name { font-size: 1.1rem; font-weight: 600; color: #f0f6fc; cursor: pointer; }
    .agent-name:hover, .prompt-value:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
    .status-badge {
      padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
    }
    .status-idle { background: #1f6feb33; color: #58a6ff; }
    .status-running { background: #f7883533; color: #f78835; }
    .status-scheduled { background: #3fb95033; color: #3fb950; }
    .status-error { background: #f8514933; color: #f85149; }
    .status-stopped { background: #484f5833; color: #8b949e; }
    .agent-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .meta-item { font-size: 0.85rem; }
    .meta-label { color: #8b949e; }
    .meta-value { color: #c9d1d9; font-family: monospace; }
    .agent-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn {
      padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d; background: #21262d;
      color: #c9d1d9; cursor: pointer; font-size: 0.8rem; transition: all 0.15s;
    }
    .btn:hover { background: #30363d; border-color: #58a6ff; }
    .btn-primary { background: #238636; border-color: #238636; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; border-color: #da3633; color: #fff; }
    .btn-danger:hover { background: #f85149; }
    .output-section { margin-top: 12px; }
    .output-toggle { color: #58a6ff; cursor: pointer; font-size: 0.85rem; border: none; background: none; }
    .output-content {
      margin-top: 8px; padding: 12px; background: #0d1117; border: 1px solid #30363d;
      border-radius: 6px; font-size: 0.8rem; white-space: pre-wrap;
      max-height: 300px; overflow-y: auto; display: none;
    }
    .output-content.markdown-body { white-space: normal; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
    .output-content.visible { display: block; }
    .error-text { border-color: #f8514966; color: #f85149; }
    .triggers-section { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-left: 8px; padding: 6px 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; }
    .trigger-badge {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px;
      border-radius: 12px; font-size: 0.75rem; font-weight: 500;
    }
    .trigger-success { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95044; }
    .trigger-failure { background: #f8514922; color: #f85149; border: 1px solid #f8514944; }
    .trigger-complete { background: #58a6ff22; color: #58a6ff; border: 1px solid #58a6ff44; }
    .trigger-arrow { color: #8b949e; font-size: 0.7rem; }
    .trigger-label { color: #8b949e; font-size: 0.75rem; margin-right: 4px; }
    .trigger-editor {
      display: none; margin-top: 8px; padding: 12px; background: #0d1117;
      border: 1px solid #30363d; border-radius: 6px;
    }
    .trigger-editor.visible { display: block; }
    .trigger-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .trigger-input {
      background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
      padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; min-width: 200px;
    }
    .schedule-input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-family: monospace; width: 200px; }
    /* Schedule Editor */
    .sched-editor { display: none; position: absolute; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; z-index: 50; min-width: 340px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .sched-editor.visible { display: block; }
    .sched-editor label { color: #8b949e; font-size: 0.75rem; display: block; margin-bottom: 4px; }
    .sched-editor select, .sched-editor input[type="time"], .sched-editor input[type="number"] {
      background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;
    }
    .sched-editor .day-checkboxes { display: flex; gap: 4px; margin: 8px 0; }
    .sched-editor .day-checkboxes label { display: flex; align-items: center; gap: 2px; cursor: pointer; padding: 4px 6px; border-radius: 4px; border: 1px solid #30363d; color: #c9d1d9; font-size: 0.8rem; }
    .sched-editor .day-checkboxes label:has(input:checked) { background: #1f6feb33; border-color: #1f6feb; color: #58a6ff; }
    .sched-editor .day-checkboxes input { display: none; }
    .sched-editor .sched-preview { margin-top: 10px; padding: 8px; background: #0d1117; border-radius: 4px; color: #7ee787; font-size: 0.8rem; min-height: 20px; }
    .sched-editor .sched-actions { display: flex; gap: 8px; margin-top: 12px; }
    .sched-editor .sched-mode-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .sched-editor .sched-fields { margin-top: 8px; }
    /* Add Agent Panel */
    .panel-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; }
    .panel-overlay.visible { display: block; }
    .side-panel {
      position: fixed; top: 0; right: -520px; width: 500px; height: 100vh;
      background: #161b22; border-left: 1px solid #30363d; z-index: 101;
      transition: right 0.25s ease; overflow-y: auto; padding: 24px;
    }
    .side-panel.visible { right: 0; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .panel-header h2 { color: #f0f6fc; font-size: 1.2rem; }
    .panel-close { background: none; border: none; color: #8b949e; font-size: 1.5rem; cursor: pointer; }
    .panel-close:hover { color: #f0f6fc; }
    .panel-tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid #30363d; }
    .panel-tab {
      padding: 8px 16px; cursor: pointer; color: #8b949e; border-bottom: 2px solid transparent;
      font-size: 0.85rem; transition: all 0.15s; background: none; border-top: none; border-left: none; border-right: none;
    }
    .panel-tab:hover { color: #c9d1d9; }
    .panel-tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
    .panel-content { display: none; }
    .panel-content.active { display: block; }
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; }
    .form-input {
      width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 8px 10px; border-radius: 6px; font-size: 0.85rem; font-family: inherit;
    }
    .form-input:focus { border-color: #58a6ff; outline: none; }
    .form-input::placeholder { color: #484f58; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-checkbox { display: flex; align-items: center; gap: 8px; }
    .form-checkbox input { accent-color: #58a6ff; }
    .form-hint { font-size: 0.7rem; color: #484f58; margin-top: 2px; }
    /* Discover list */
    .discover-list { display: grid; gap: 10px; }
    .discover-item {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px;
      display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    }
    .discover-item.registered { opacity: 0.5; }
    .discover-info { flex: 1; min-width: 0; }
    .discover-name { font-weight: 600; color: #f0f6fc; font-size: 0.9rem; }
    .discover-meta { font-size: 0.75rem; color: #8b949e; margin-top: 2px; }
    .discover-desc { font-size: 0.78rem; color: #8b949e; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; }
    .source-badge {
      display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem;
      font-weight: 600; text-transform: uppercase;
    }
    .source-plugin { background: #8957e522; color: #d2a8ff; border: 1px solid #8957e544; }
    .source-marketplace { background: #f0883e22; color: #f0883e; border: 1px solid #f0883e44; }
    .source-repo-agent { background: #58a6ff22; color: #58a6ff; border: 1px solid #58a6ff44; }
    .source-local-plugin { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95044; }
    .discover-actions { flex-shrink: 0; }
    .discover-scan { display: flex; gap: 8px; margin-bottom: 12px; }
    .discover-scan input { flex: 1; }
    .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .auto-refresh { font-size: 0.8rem; color: #8b949e; }
    /* Sessions Panel */
    .sessions-panel {
      position: fixed; top: 0; right: -620px; width: 600px; height: 100vh;
      background: #161b22; border-left: 1px solid #30363d; z-index: 103;
      transition: right 0.25s ease; overflow-y: auto; padding: 24px;
    }
    .sessions-panel.visible { right: 0; }
    .sessions-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 102; }
    .sessions-overlay.visible { display: block; }
    .session-filters { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
    .session-filters select, .session-filters input {
      background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 6px 10px; border-radius: 6px; font-size: 0.8rem;
    }
    .session-card {
      background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
      padding: 14px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.2s;
    }
    .session-card:hover { border-color: #58a6ff; }
    .session-card.expanded { border-color: #58a6ff; }
    .session-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .session-name { font-weight: 600; color: #f0f6fc; font-size: 0.9rem; }
    .session-time { font-size: 0.75rem; color: #8b949e; white-space: nowrap; }
    .session-meta { font-size: 0.75rem; color: #8b949e; margin-top: 4px; }
    .session-meta span { margin-right: 12px; }
    .session-preview {
      font-size: 0.78rem; color: #8b949e; margin-top: 8px;
      max-height: 60px; overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }
    .session-detail { display: none; margin-top: 12px; }
    .session-card.expanded .session-detail { display: block; }
    .session-card.expanded .session-preview { display: none; }
    .session-conversation {
      max-height: 400px; overflow-y: auto; border: 1px solid #30363d;
      border-radius: 6px; padding: 12px; margin-bottom: 12px; background: #0d1117;
    }
    .conv-turn { margin-bottom: 12px; }
    .conv-turn:last-child { margin-bottom: 0; }
    .conv-role {
      font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
      margin-bottom: 4px; display: flex; align-items: center; gap: 6px;
    }
    .conv-role.user { color: #58a6ff; }
    .conv-role.assistant { color: #3fb950; }
    .conv-content {
      font-size: 0.8rem; color: #c9d1d9; white-space: pre-wrap; word-break: break-word;
      line-height: 1.5; padding-left: 8px; border-left: 2px solid #30363d;
    }
    .conv-content.assistant-content { border-left-color: #238636; }
    .session-chat {
      display: flex; gap: 8px; margin-top: 8px;
    }
    .session-chat input {
      flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 8px 10px; border-radius: 6px; font-size: 0.85rem;
    }
    .session-chat input:focus { border-color: #58a6ff; outline: none; }
    .session-chat button { white-space: nowrap; }
    .chat-sending {
      font-size: 0.8rem; color: #f78835; margin-top: 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .chat-sending .spinner {
      width: 14px; height: 14px; border: 2px solid #f7883544;
      border-top-color: #f78835; border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Tool steps */
    .tool-step {
      margin: 4px 0 4px 16px; padding: 6px 10px; background: #1c2128;
      border: 1px solid #30363d; border-radius: 6px; font-size: 0.75rem; color: #8b949e;
    }
    .tool-step-header { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .tool-step-icon { font-size: 0.7rem; }
    .tool-step-name { color: #d2a8ff; font-weight: 600; font-family: monospace; }
    .tool-step-desc { color: #8b949e; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 500px; }
    .tool-step-result { display: none; margin-top: 6px; padding: 6px 8px; background: #0d1117; border-radius: 4px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 0.7rem; color: #7ee787; }
    .tool-step-result.visible { display: block; }
    .tool-step.pending { border-left: 2px solid #f0883e; }
    .tool-step.success { border-left: 2px solid #3fb950; }
    .tool-step.failed { border-left: 2px solid #f85149; }
    /* Session metadata banner */
    .session-meta-banner {
      display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; margin-bottom: 10px;
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      font-size: 0.72rem; color: #8b949e;
    }
    .session-meta-banner .meta-item { display: flex; align-items: center; gap: 4px; }
    .session-meta-banner .meta-label { color: #6e7681; font-weight: 600; text-transform: uppercase; font-size: 0.65rem; }
    .session-meta-banner .meta-value { color: #c9d1d9; font-family: monospace; }
    /* Token stats footer */
    .session-token-stats {
      display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; margin-top: 10px;
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      font-size: 0.72rem; color: #8b949e;
    }
    .session-token-stats .stat-item { display: flex; align-items: center; gap: 4px; }
    .session-token-stats .stat-value { color: #d2a8ff; font-weight: 600; font-family: monospace; }
    .session-token-stats .stat-label { color: #6e7681; }
    /* Model badge */
    .model-badge {
      display: inline-block; font-size: 0.6rem; color: #8b949e; background: #21262d;
      border: 1px solid #30363d; border-radius: 4px; padding: 1px 6px; margin-left: 8px;
      font-family: monospace; vertical-align: middle;
    }
    /* Focus Modal */
    .focus-email-menu {
      display: none; position: absolute; top: 100%; right: 0; z-index: 300;
      background: #1c2128; border: 1px solid #30363d; border-radius: 6px;
      padding: 4px 0; min-width: 180px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .focus-email-menu.visible { display: block; }
    .focus-email-menu button {
      display: block; width: 100%; text-align: left; background: none; border: none;
      color: #c9d1d9; padding: 8px 14px; font-size: 0.82rem; cursor: pointer;
    }
    .focus-email-menu button:hover { background: #30363d; }
    .focus-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 200;
    }
    .focus-overlay.visible { display: flex; align-items: center; justify-content: center; }
    .focus-modal {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      width: 90vw; max-width: 900px; height: 85vh; display: flex; flex-direction: column;
      overflow: hidden;
    }
    .focus-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 20px; border-bottom: 1px solid #30363d; flex-shrink: 0;
    }
    .focus-header h2 { color: #f0f6fc; font-size: 1.1rem; margin: 0; }
    .focus-header-actions { display: flex; gap: 8px; align-items: center; }
    .focus-body {
      flex: 1; overflow-y: auto; padding: 20px;
    }
    .focus-chat {
      display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid #30363d; flex-shrink: 0;
    }
    .focus-chat input {
      flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 10px 12px; border-radius: 6px; font-size: 0.9rem;
    }
    .focus-chat input:focus { border-color: #58a6ff; outline: none; }
    /* Markdown styles in conversation */
    .conv-content.assistant-content table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    .conv-content.assistant-content th,
    .conv-content.assistant-content td { border: 1px solid #30363d; padding: 4px 8px; font-size: 0.78rem; }
    .conv-content.assistant-content th { background: #161b22; color: #f0f6fc; }
    .conv-content.assistant-content code { background: #0d1117; padding: 1px 4px; border-radius: 3px; font-size: 0.8rem; }
    .conv-content.assistant-content pre { background: #0d1117; padding: 8px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
    .conv-content.assistant-content pre code { background: none; padding: 0; }
    .conv-content.assistant-content h1, .conv-content.assistant-content h2,
    .conv-content.assistant-content h3 { color: #f0f6fc; margin: 8px 0 4px; }
    .conv-content.assistant-content h1 { font-size: 1rem; }
    .conv-content.assistant-content h2 { font-size: 0.95rem; }
    .conv-content.assistant-content h3 { font-size: 0.9rem; }
    .conv-content.assistant-content ul, .conv-content.assistant-content ol { padding-left: 20px; margin: 4px 0; }
    .conv-content.assistant-content strong { color: #f0f6fc; }
    .conv-content.assistant-content blockquote { border-left: 3px solid #30363d; padding-left: 10px; color: #8b949e; margin: 8px 0; }
  </style>
</head>
<body>
  <nav style="display:flex;gap:16px;align-items:center;margin-bottom:16px;border-bottom:1px solid #30363d;padding-bottom:12px;">
    <span style="font-size:1.3rem;font-weight:700;color:#f0f6fc;margin-right:auto;">Copilot Agent Supervisor</span>
    <a href="/" style="color:#8b949e;text-decoration:none;font-size:0.9rem;padding:6px 12px;border-radius:6px;">Managers</a>
    <a href="/agents" style="color:#58a6ff;text-decoration:none;font-size:0.9rem;padding:6px 12px;border-radius:6px;background:#1f6feb22;font-weight:600;">Agents</a>
  </nav>

  <div id="app" x-data="agentsApp()" x-init="init()">
    <div class="refresh-bar">
      <h1>&#x1F916; Copilot Agent Supervisor <span style="font-size:0.5em;color:#8b949e;font-weight:normal" title="${GIT_VERSION.message} | files:${GIT_VERSION.fileHash || '?'} | PID:${PROCESS_PID} | started:${PROCESS_START}">${GIT_VERSION.hash}${GIT_VERSION.dirty ? '<span style="color:#f85149">*</span>' : ''}</span></h1>
      <div>
        <button class="btn" @click="openSessionsPanel()" style="margin-right:4px">&#x1F4CB; Sessions</button>
        <button class="btn btn-primary" @click="openAddPanel()">+ Add Agent</button>
        <button class="btn" @click="openInCode()">&#x1F4DD; Edit in VS Code</button>
        <a href="/api/export" class="btn" style="text-decoration:none;display:inline-block" title="Export config as zip">&#x1F4E6; Export</a>
        <button class="btn" style="cursor:pointer;margin:0" title="Import config from zip" @click="$refs.importZipInput.click()">&#x1F4E5; Import</button>
        <input type="file" x-ref="importZipInput" accept=".zip" style="display:none" @change="handleImportFile($event)">
        <span class="auto-refresh">Auto-refreshes every 10s</span>
      </div>
    </div>

    <div class="filter-bar" style="display:flex;align-items:center;gap:12px;padding:8px 0;margin-bottom:8px;">
      <input type="text" x-model="filter" placeholder="Filter agents by name..." style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;width:220px;font-size:0.85rem;">
      <button class="btn" @click="expandAllGroups()" title="Expand all groups">▾ Expand All</button>
      <button class="btn" @click="collapseAllGroups()" title="Collapse all groups">▸ Collapse All</button>
    </div>

    <div class="agents" id="agents">
      <template x-for="group in groupedAgents()" :key="group.name">
        <div class="agent-group">
          <div class="group-header" @click="toggleGroup(group.name)">
            <span class="group-toggle" x-text="isGroupCollapsed(group.name) ? '▸' : '▾'"></span>
            <span class="group-name" x-text="group.name"></span>
            <span class="group-count" x-text="'(' + group.agents.length + ')'"></span>
            <div class="group-status-dots">
              <template x-for="agent in group.agents" :key="group.name + ':' + agent.agent_id">
                <span class="status-dot" :class="'dot-' + (agent.status || 'idle')" :title="agentDisplayName(agent) + ': ' + (agent.status || 'idle')"></span>
              </template>
            </div>
            <template x-if="group.name !== 'Ungrouped'">
              <div class="group-actions" @click.stop>
                <button class="btn" @click="renameGroup(group.name)" title="Rename group">✎</button>
                <button class="btn btn-danger" @click="deleteGroup(group.name)" title="Dissolve group">✗</button>
              </div>
            </template>
          </div>
          <div class="group-body" :class="{ collapsed: isGroupCollapsed(group.name) }">
            <template x-for="agent in group.agents" :key="agent.agent_id">
              <div class="agent-card" :class="{ 'agent-disabled': !isAgentEnabled(agent) }">
                <div class="agent-header">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <template x-if="editingNameId !== agent.agent_id">
                      <span class="agent-name" @dblclick="startEditName(agent)" title="Double-click to rename" x-text="agentDisplayName(agent)"></span>
                    </template>
                    <template x-if="editingNameId === agent.agent_id">
                      <input class="schedule-input" style="font-size:1.1rem;font-weight:bold;" x-model="pendingName" @keydown.enter.prevent="saveEditName(agent.agent_id)" @keydown.escape.prevent="cancelEditName()" @blur="saveEditName(agent.agent_id)" x-init="$nextTick(() => { $el.focus(); $el.select(); })">
                    </template>
                    <span style="font-size:0.65rem;padding:2px 6px;border-radius:3px;" :style="agent.config && agent.config.pluginDir ? 'background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55' : 'background:#2ea04322;color:#7ee787;border:1px solid #2ea04355'" x-text="agent.config && agent.config.pluginDir ? '🔌 plugin' : '🤖 agent'"></span>
                    <template x-if="agent.config && agent.config.agent && agent.config.agent !== agentDisplayName(agent)">
                      <span style="font-size:0.7rem;color:#8b949e;font-family:monospace" title="Agent identifier" x-text="agent.config.agent"></span>
                    </template>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="status-badge" :class="'status-' + (agent.status || 'idle')" x-text="agent.status || 'idle'"></span>
                    <label class="toggle-switch" :title="isAgentEnabled(agent) ? 'Enabled — click to disable' : 'Disabled — click to enable'">
                      <input type="checkbox" :checked="isAgentEnabled(agent)" @change="toggleEnabled(agent.agent_id, $event.target.checked)">
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                </div>

                <div class="agent-meta">
                  <div class="meta-item" style="grid-column: span 2">
                    <span class="meta-label">Prompt:</span>
                    <template x-if="editingPromptId !== agent.agent_id">
                      <span class="meta-value prompt-value" @dblclick="startEditPrompt(agent)" title="Double-click to edit" x-text="agentPrompt(agent)"></span>
                    </template>
                    <template x-if="editingPromptId === agent.agent_id">
                      <div style="width:100%;display:flex;flex-direction:column;gap:4px;">
                        <textarea class="schedule-input" style="width:100%;min-height:60px;resize:vertical;font-family:inherit;font-size:inherit;" x-model="pendingPrompt" @keydown.enter.exact.prevent="saveEditPrompt(agent.agent_id)" @keydown.shift.enter.stop @keydown.escape.prevent="cancelEditPrompt()" @blur="saveEditPrompt(agent.agent_id)" x-init="$nextTick(() => { $el.focus(); $el.select(); })"></textarea>
                        <div style="font-size:11px;color:#888;line-height:1.4;background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px 8px;">
                          <strong style="color:#aaa">Template variables</strong> (available when triggered by another agent):<br>
                          <code style="color:#7ec8e3">\{{ trigger.output }}</code> — output from triggering agent<br>
                          <code style="color:#7ec8e3">\{{ trigger.name }}</code> — name &nbsp;|&nbsp; <code style="color:#7ec8e3">\{{ trigger.exitCode }}</code> — exit code<br>
                          <code style="color:#7ec8e3">\{{ trigger.startedAt }}</code> / <code style="color:#7ec8e3">\{{ trigger.finishedAt }}</code> — timestamps<br>
                          <code style="color:#7ec8e3">\{{ chain[0].output }}</code> — output from earlier chain step (0-indexed)<br>
                          <span style="color:#666">Press Enter to save, Shift+Enter for newline, Esc to cancel.</span>
                        </div>
                      </div>
                    </template>
                  </div>
                  <div class="meta-item"><span class="meta-label">CWD:</span> <span class="meta-value" x-text="(agent.config && agent.config.cwd) || '-' "></span></div>
                  <div class="meta-item">
                    <span class="meta-label">Group:</span>
                    <select class="group-select" :value="(agent.config && agent.config.group) || ''" @change="moveToGroup(agent.agent_id, $event.target.value)">
                      <option value="">Ungrouped</option>
                      <template x-for="groupName in movableGroupNames()" :key="agent.agent_id + ':group:' + groupName">
                        <option :value="groupName" x-text="groupName"></option>
                      </template>
                      <option value="__new__">+ New group…</option>
                    </select>
                  </div>
                </div>

                <div class="agent-actions">
                  <button class="btn btn-primary" @click="startAgent(agent.agent_id)">▶ Start</button>
                  <button class="btn btn-danger" @click="stopAgent(agent.agent_id)">■ Stop</button>
                  <button class="btn" @click="runNow(agent.agent_id)">⚡ Run Now</button>
                  <span style="border-left:1px solid #30363d;height:20px;margin:0 4px"></span>
                  <button class="btn" @click="showAgentSessions(agentDisplayName(agent))" title="View sessions for this agent">📋 Sessions</button>
                  <button class="btn" @click="openLastTerminal(agent.agent_id, (agent.config && agent.config.cwd) || '')" title="Resume last session in Copilot CLI">💻 Copilot</button>
                  <button class="btn" @click="editAgentSource(agent.agent_id)" title="Open agent source in editor">✏️ Edit</button>
                  <button class="btn" @click="cloneAgent(agent.agent_id)" title="Clone this agent with a new name">📋 Clone</button>
                  <template x-if="agent.config && agent.config.pluginDir">
                    <button class="btn" @click="reinstallPlugin(agent.agent_id)" title="Reinstall plugin (uninstall + install)">🔄 Reinstall</button>
                  </template>
                  <button class="btn btn-danger" style="margin-left:auto" @click="deleteAgent(agent.agent_id)" title="Remove agent">🗑</button>

                  <template x-if="agent.isTriggerOnly">
                    <div style="position:relative;display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
                      <span style="color:#d2a8ff;font-weight:600;font-size:0.8rem">⚡ Trigger</span>
                      <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;">
                        <span style="color:#8b949e;" x-text="'Last: ' + timeAgo(agent.last_run) + ' · Exit: ' + ((agent.lastRun && agent.lastRun.exit_code != null) ? agent.lastRun.exit_code : '-')"></span>
                      </div>
                    </div>
                  </template>

                  <template x-if="!agent.isTriggerOnly">
                    <div style="position:relative;display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
                      <button class="btn" @click="openScheduleEditor(agent.agent_id, agent.schedule || '', $event)" title="Edit schedule">🕐 Schedule</button>
                      <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;">
                        <span style="color:#c9d1d9;" :title="agent.scheduleDescription || ''" x-text="(agent.schedule || 'none') + ' (' + (agent.scheduleDescription || '') + ')' "></span>
                        <span style="color:#8b949e;" x-text="'Next: ' + (isAgentEnabled(agent) ? timeUntil(agent.next_run) : '—') + ' · Last: ' + timeAgo(agent.last_run) + ' · Exit: ' + ((agent.lastRun && agent.lastRun.exit_code != null) ? agent.lastRun.exit_code : '-')"></span>
                        <span style="color:#8b949e;cursor:pointer;" @click="toggleAutoStart(agent.agent_id, isAutoStart(agent))" :title="'Click to toggle'" x-html="'Auto-start: ' + (isAutoStart(agent) ? '<span style=color:#7ee787>✓ on boot</span>' : '<span style=color:#f0883e>⏱ schedule only</span>')"></span>
                      </div>
                    </div>
                  </template>

                  <div style="display:inline-flex;flex-direction:column;position:relative;">
                    <div class="triggers-section">
                      <span class="trigger-label">Triggers:</span>
                      <template x-for="targetId in normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onSuccess)" :key="agent.agent_id + ':success:' + targetId">
                        <span class="trigger-badge trigger-success">✓ <span class="trigger-arrow">→</span> <span x-text="agentNameById(targetId)"></span></span>
                      </template>
                      <template x-for="targetId in normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onFailure)" :key="agent.agent_id + ':failure:' + targetId">
                        <span class="trigger-badge trigger-failure">✗ <span class="trigger-arrow">→</span> <span x-text="agentNameById(targetId)"></span></span>
                      </template>
                      <template x-for="targetId in normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onComplete)" :key="agent.agent_id + ':complete:' + targetId">
                        <span class="trigger-badge trigger-complete">● <span class="trigger-arrow">→</span> <span x-text="agentNameById(targetId)"></span></span>
                      </template>
                      <template x-if="!hasTriggers(agent)">
                        <span style="color:#8b949e;font-size:0.75rem">none</span>
                      </template>
                      <button class="btn" style="padding:2px 8px;font-size:0.7rem" @click="toggleTriggerEditor(agent)">✎ Edit</button>
                    </div>
                    <div class="trigger-editor" :class="{ visible: triggerEditor.agentId === agent.agent_id }" x-show="triggerEditor.agentId === agent.agent_id" style="position:absolute;top:100%;left:0;z-index:50;min-width:340px;">
                      <div class="trigger-row">
                        <span class="trigger-badge trigger-success" style="min-width:70px">✓ Success</span>
                        <select class="trigger-input" multiple x-model="triggerEditor.success">
                          <template x-for="target in triggerTargets(agent)" :key="agent.agent_id + ':trigger-success-opt:' + target.agent_id">
                            <option :value="target.agent_id" x-text="agentDisplayName(target)"></option>
                          </template>
                        </select>
                      </div>
                      <div class="trigger-row">
                        <span class="trigger-badge trigger-failure" style="min-width:70px">✗ Failure</span>
                        <select class="trigger-input" multiple x-model="triggerEditor.failure">
                          <template x-for="target in triggerTargets(agent)" :key="agent.agent_id + ':trigger-failure-opt:' + target.agent_id">
                            <option :value="target.agent_id" x-text="agentDisplayName(target)"></option>
                          </template>
                        </select>
                      </div>
                      <div class="trigger-row">
                        <span class="trigger-badge trigger-complete" style="min-width:70px">● Always</span>
                        <select class="trigger-input" multiple x-model="triggerEditor.complete">
                          <template x-for="target in triggerTargets(agent)" :key="agent.agent_id + ':trigger-complete-opt:' + target.agent_id">
                            <option :value="target.agent_id" x-text="agentDisplayName(target)"></option>
                          </template>
                        </select>
                      </div>
                      <button class="btn btn-primary" style="margin-top:6px" @click="saveTriggers()">Save</button>
                      <button class="btn btn-danger" style="margin-top:6px" @click="clearTriggers()">Clear All</button>
                    </div>
                  </div>
                </div>

                <template x-if="agent.lastRun && agent.lastRun.error">
                  <div class="output-section error-output">
                    <button class="output-toggle" @click="toggleOutput('err-' + agent.agent_id)" x-text="((agent.status === 'error' || isOutputExpanded('err-' + agent.agent_id)) ? '▾' : '▸') + ' Error'"></button>
                    <pre class="output-content error-text" :class="{ visible: agent.status === 'error' || isOutputExpanded('err-' + agent.agent_id) }" x-show="agent.status === 'error' || isOutputExpanded('err-' + agent.agent_id)" :id="'output-err-' + agent.agent_id" @scroll="rememberOutputScroll('output-err-' + agent.agent_id, $event.target.scrollTop)" x-text="agent.lastRun.error"></pre>
                  </div>
                </template>

                <template x-if="agent.status === 'running' || (agent.lastRun && agent.lastRun.output)">
                  <div class="output-section" :style="agent.status === 'running' ? 'border-left:3px solid #f0883e;' : ''">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <template x-if="agent.status === 'running'">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                          <span class="spinner" style="width:14px;height:14px;"></span>
                          <span style="color:#f0883e;font-weight:600;font-size:0.85rem;">Latest session</span>
                          <span style="color:#8b949e;font-size:0.75rem" :id="'live-status-' + agent.agent_id" x-text="liveStatusText(agent.agent_id)"></span>
                        </div>
                      </template>
                      <template x-if="agent.status !== 'running'">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                          <button class="output-toggle" @click="toggleOutput(agent.agent_id)" x-text="(isOutputExpanded(agent.agent_id) ? '▾' : '▸') + ' Latest session'"></button>
                          <span style="font-size:11px;color:#888;margin-left:4px" x-text="agent.lastRun && agent.lastRun.started_at ? formatRunTimestamp(agent.lastRun.started_at, agent.lastRun.finished_at) : ''"></span>
                        </div>
                      </template>
                      <button class="output-toggle" @click="openOutputModal(agentDisplayName(agent), agent.agent_id)" :style="agent.status === 'running' ? 'margin-left:8px;opacity:0.4;pointer-events:none' : 'margin-left:8px'" title="Open in full view">⛶ Focus</button>
                      <span :id="'live-chat-btn-' + agent.agent_id">
                        <template x-if="agent.status !== 'running'">
                          <button class="output-toggle" style="margin-left:0" title="Chat with this session" @click="openLastChat(agent.agent_id, agent.lastRun && agent.lastRun.session_id ? agent.lastRun.session_id : '')">💬 Chat</button>
                        </template>
                        <template x-if="agent.status === 'running' && liveSessionId(agent.agent_id)">
                          <button class="output-toggle" style="margin-left:0" title="Chat with this session" @click="openFocus(liveSessionId(agent.agent_id))">💬 Chat</button>
                        </template>
                        <template x-if="agent.status === 'running' && !liveSessionId(agent.agent_id)">
                          <button class="output-toggle" style="margin-left:0;opacity:0.4;pointer-events:none" title="Chat available after session completes">💬 Chat</button>
                        </template>
                      </span>
                      <button class="output-toggle" @click="emailOutput(agent.agent_id, agentDisplayName(agent))" :style="agent.status === 'running' ? 'margin-left:8px;opacity:0.4;pointer-events:none' : 'margin-left:8px'" title="Email last output">✉ Email</button>
                    </div>
                    <template x-if="agent.status === 'running'">
                      <div class="output-content markdown-body visible" :id="'live-' + agent.agent_id" style="margin-top:8px;max-height:400px;overflow-y:auto;opacity:0.9;display:block;" @scroll="rememberOutputScroll('live-' + agent.agent_id, $event.target.scrollTop)" x-html="liveOutputHtml(agent.agent_id)"></div>
                    </template>
                    <template x-if="agent.status !== 'running'">
                      <div class="output-content markdown-body" :class="{ visible: isOutputExpanded(agent.agent_id) }" x-show="isOutputExpanded(agent.agent_id)" :id="'output-' + agent.agent_id" @scroll="rememberOutputScroll('output-' + agent.agent_id, $event.target.scrollTop)" x-html="renderMd((agent.lastRun && agent.lastRun.output) || '')"></div>
                    </template>
                  </div>
                </template>

                <template x-for="triggerRun in (agent.triggerRuns || [])" :key="agent.agent_id + ':trigger:' + triggerRun.sourceId">
                  <div class="output-section" :style="triggerRun.lastRun && triggerRun.lastRun.exit_code !== 0 ? 'margin-top:4px;border-left:3px solid #f85149;' : 'margin-top:4px;'">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <button class="output-toggle" @click="toggleOutput('tr-' + agent.agent_id + '-' + triggerRun.sourceId)" x-text="(isOutputExpanded('tr-' + agent.agent_id + '-' + triggerRun.sourceId) ? '▾' : '▸') + ' From: ' + triggerRun.sourceName"></button>
                      <span style="font-size:11px;color:#888;" x-text="triggerRun.lastRun && triggerRun.lastRun.started_at ? formatRunTimestamp(triggerRun.lastRun.started_at, triggerRun.lastRun.finished_at) : 'never run'"></span>
                      <template x-if="triggerRun.lastRun && triggerRun.lastRun.exit_code != null">
                        <span style="font-size:11px;" :style="triggerRun.lastRun.exit_code === 0 ? 'color:#3fb950' : 'color:#f85149'" x-text="'Exit: ' + triggerRun.lastRun.exit_code"></span>
                      </template>
                      <template x-if="triggerRun.lastRun && triggerRun.lastRun.session_id">
                        <button class="output-toggle" style="margin-left:4px" @click="openFocus(triggerRun.lastRun.session_id)">⛶ Focus</button>
                      </template>
                    </div>
                    <template x-if="triggerRun.lastRun && triggerRun.lastRun.output">
                      <div class="output-content markdown-body" :class="{ visible: isOutputExpanded('tr-' + agent.agent_id + '-' + triggerRun.sourceId) }" x-show="isOutputExpanded('tr-' + agent.agent_id + '-' + triggerRun.sourceId)" :id="'output-tr-' + agent.agent_id + '-' + triggerRun.sourceId" @scroll="rememberOutputScroll('output-tr-' + agent.agent_id + '-' + triggerRun.sourceId, $event.target.scrollTop)" x-html="renderMd(triggerRun.lastRun.output || '')"></div>
                    </template>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>

    <div class="sched-editor" :class="{ visible: scheduleEditor.show }" x-show="scheduleEditor.show" :style="'position:fixed;top:' + scheduleEditor.top + 'px;left:' + scheduleEditor.left + 'px;'" @click.outside="closeScheduleEditor()">
      <label>Schedule type</label>
      <div class="sched-mode-row">
        <select x-model="scheduleEditor.mode" @change="onScheduleModeChanged()">
          <option value="interval">Interval (every N minutes/hours)</option>
          <option value="daily">Daily (at a specific time)</option>
          <option value="weekly">Weekly (pick days + time)</option>
          <option value="cron">Advanced (cron / free text)</option>
        </select>
      </div>
      <div class="sched-fields">
        <div x-show="scheduleEditor.mode === 'interval'" style="display:flex;gap:8px;align-items:center">
          <label style="margin:0">Every</label>
          <input type="number" min="1" max="720" style="width:60px" x-model="scheduleEditor.num" @input="previewSchedule()">
          <select x-model="scheduleEditor.unit" @change="previewSchedule()">
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </select>
        </div>
        <div x-show="scheduleEditor.mode === 'daily'" style="display:flex;gap:8px;align-items:center">
          <label style="margin:0">At</label>
          <input type="time" x-model="scheduleEditor.dailyTime" @change="previewSchedule()">
          <span style="color:#8b949e;font-size:0.8rem">every day</span>
        </div>
        <div x-show="scheduleEditor.mode === 'weekly'">
          <div class="day-checkboxes">
            <label><input type="checkbox" value="mon" x-model="scheduleEditor.days" @change="previewSchedule()"> Mon</label>
            <label><input type="checkbox" value="tue" x-model="scheduleEditor.days" @change="previewSchedule()"> Tue</label>
            <label><input type="checkbox" value="wed" x-model="scheduleEditor.days" @change="previewSchedule()"> Wed</label>
            <label><input type="checkbox" value="thu" x-model="scheduleEditor.days" @change="previewSchedule()"> Thu</label>
            <label><input type="checkbox" value="fri" x-model="scheduleEditor.days" @change="previewSchedule()"> Fri</label>
            <label><input type="checkbox" value="sat" x-model="scheduleEditor.days" @change="previewSchedule()"> Sat</label>
            <label><input type="checkbox" value="sun" x-model="scheduleEditor.days" @change="previewSchedule()"> Sun</label>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <label style="margin:0">At</label>
            <input type="time" x-model="scheduleEditor.weeklyTime" @change="previewSchedule()">
          </div>
        </div>
        <div x-show="scheduleEditor.mode === 'cron'" style="display:flex;flex-direction:column;gap:4px">
          <label style="margin:0">Cron expression or free text</label>
          <input type="text" class="schedule-input" style="width:100%" x-model="scheduleEditor.cron" @input="previewSchedule()" placeholder="e.g. 0 9 * * 1-5 or weekdays at 9am">
          <span style="color:#8b949e;font-size:0.7rem">Examples: 0 */2 * * * (every 2h) | weekdays at 9am | every 30 minutes</span>
        </div>
      </div>
      <div class="sched-preview" :style="'color:' + scheduleEditor.previewColor" x-text="scheduleEditor.previewText"></div>
      <div class="sched-actions">
        <button class="btn btn-primary" @click="saveScheduleEditor()">Save</button>
        <button class="btn" @click="closeScheduleEditor()">Cancel</button>
      </div>
    </div>

    <div class="sessions-overlay" :class="{ visible: sessionsPanel.show }" x-show="sessionsPanel.show" @click="closeSessionsPanel()"></div>
    <div class="sessions-panel" :class="{ visible: sessionsPanel.show }">
      <div class="panel-header">
        <h2>&#x1F4CB; Recent Sessions</h2>
        <button class="panel-close" @click="closeSessionsPanel()">&times;</button>
      </div>
      <div class="session-filters">
        <select x-model="sessionsPanel.hours" @change="loadSessions()">
          <option value="4">Last 4 hours</option>
          <option value="12">Last 12 hours</option>
          <option value="24">Last 24 hours</option>
          <option value="72">Last 3 days</option>
          <option value="168">Last 7 days</option>
        </select>
        <input type="text" x-model="sessionsPanel.filter" placeholder="Filter by name...">
        <button class="btn" @click="loadSessions()">&#x1F504; Refresh</button>
      </div>
      <template x-if="sessionsPanel.loading">
        <div style="color:#8b949e;text-align:center;padding:20px">Loading sessions...</div>
      </template>
      <template x-if="!sessionsPanel.loading && sessionGroups().length === 0">
        <div style="color:#8b949e;text-align:center;padding:20px">No sessions found</div>
      </template>
      <template x-for="group in sessionGroups()" :key="group.name">
        <div class="session-group" style="margin-bottom:12px">
          <div class="group-header" @click="toggleSessionGroup(group.name)" style="padding:8px 12px">
            <span class="group-toggle" x-text="isSessionGroupCollapsed(group.name) ? '▶' : '▼'"></span>
            <span class="group-name" style="font-size:0.9rem" x-text="group.name"></span>
            <span class="group-count" style="margin-left:8px" x-text="group.sessions.length + ' session' + (group.sessions.length !== 1 ? 's' : '')"></span>
            <span style="margin-left:auto;font-size:0.75rem;color:#8b949e" x-text="'📁 ' + group.repoShort + ' · ' + group.dateStr + ' ' + group.timeStr"></span>
          </div>
          <div class="group-body" :class="{ collapsed: isSessionGroupCollapsed(group.name) }" style="margin-top:6px;padding-left:0">
            <template x-for="session in group.sessions" :key="session.id">
              <div class="session-card" :class="{ expanded: !!sessionsPanel.expanded[session.id] }" :id="'session-' + session.id" @click="toggleSession(session.id)">
                <div class="session-header">
                  <div>
                    <span style="font-size:0.8rem;color:#c9d1d9" x-text="sessionDateLabel(session)"></span>
                    <span style="font-size:0.8rem;color:#8b949e;margin-left:8px" x-text="'— ' + (session.name || '(no prompt)')"></span>
                  </div>
                  <div style="font-size:0.75rem;color:#8b949e">
                    <span x-text="'💬 ' + session.turnCount + ' turn' + (session.turnCount !== 1 ? 's' : '')"></span>
                    <span style="margin-left:8px" x-text="'🔑 ' + session.id.substring(0,8)"></span>
                  </div>
                </div>
                <div class="session-preview" x-show="!sessionsPanel.expanded[session.id]" x-text="(session.lastResult || '').substring(0, 200)"></div>
                <div class="session-detail" @click.stop>
                  <template x-if="sessionsPanel.details[session.id] && sessionsPanel.details[session.id].loading">
                    <div style="color:#8b949e;font-size:0.8rem;padding:8px">Loading conversation...</div>
                  </template>
                  <template x-if="sessionsPanel.details[session.id] && !sessionsPanel.details[session.id].loading">
                    <div>
                      <div style="display:flex;gap:6px;margin-bottom:8px">
                        <button class="btn" @click="openFocus(session.id)" title="Expand to focus view">🔍 Focus</button>
                        <button class="btn" @click="openTerminal(session.id)" title="Open in terminal">💻 Terminal</button>
                      </div>
                      <div x-html="sessionsPanel.details[session.id].html"></div>
                      <div class="session-chat">
                        <input type="text" :value="sessionsPanel.chatInputs[session.id] || ''" @input="sessionsPanel.chatInputs[session.id] = $event.target.value" @keydown.enter.prevent="sendSessionChat(session.id)" placeholder="Ask a follow-up question...">
                        <button class="btn btn-primary" @click="sendSessionChat(session.id)">Send</button>
                      </div>
                      <div x-html="sessionsPanel.chatStatus[session.id] || ''"></div>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>

    <div class="focus-overlay" :class="{ visible: focus.show }" x-show="focus.show" @click.self="closeFocus()">
      <div class="focus-modal">
        <div class="focus-header">
          <h2 x-text="focus.title"></h2>
          <div class="focus-header-actions">
            <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;color:#8b949e;cursor:pointer;" title="Show tool calls and intermediate steps">
              <input type="checkbox" x-model="focus.verbose" @change="toggleFocusVerbose()">
              🔧 Steps
            </label>
            <div style="position:relative;display:inline-block;" @click.outside="focus.emailMenu = false">
              <button class="btn" @click="focus.emailMenu = !focus.emailMenu" title="Email session">✉ Email</button>
              <div class="focus-email-menu" :class="{ visible: focus.emailMenu }">
                <button @click="emailFocusSession('last')">Last response only</button>
                <button @click="emailFocusSession('full')">Full conversation</button>
              </div>
            </div>
            <button class="btn" @click="openTerminal(focus.sessionId)" title="Open in terminal">&#x1F4BB; Terminal</button>
            <button class="panel-close" @click="closeFocus()">&times;</button>
          </div>
        </div>
        <div class="focus-body" x-ref="focusBody" x-html="focus.html"></div>
        <div class="focus-chat">
          <input type="text" x-model="focus.chatInput" x-ref="focusChatInput" placeholder="Ask a follow-up question..." @keydown.enter.prevent="sendFocusChat()">
          <button class="btn btn-primary" @click="sendFocusChat()">Send</button>
        </div>
        <div style="padding:0 20px 8px" x-html="focus.chatStatus"></div>
      </div>
    </div>

    <div class="sessions-overlay" :class="{ visible: outputModal.show }" x-show="outputModal.show" @click="closeOutputModal()"></div>
    <div class="focus-modal" x-show="outputModal.show" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001">
      <div class="focus-header">
        <h2 x-text="outputModal.title"></h2>
        <button class="panel-close" @click="closeOutputModal()">&times;</button>
      </div>
      <div class="focus-body markdown-body" style="font-size:0.85rem" x-html="outputModal.content"></div>
    </div>

    <div class="panel-overlay" :class="{ visible: addPanel.show }" x-show="addPanel.show" @click="closeAddPanel()"></div>
    <div class="side-panel" :class="{ visible: addPanel.show }">
      <div class="panel-header">
        <h2>Add Agent</h2>
        <button class="panel-close" @click="closeAddPanel()">&times;</button>
      </div>
      <div class="panel-tabs">
        <button class="panel-tab" :class="{ active: addPanel.tab === 'discover' }" @click="switchAddTab('discover')">Discover</button>
        <button class="panel-tab" :class="{ active: addPanel.tab === 'manual' }" @click="switchAddTab('manual')">Manual</button>
      </div>

      <div class="panel-content" :class="{ active: addPanel.tab === 'discover' }" x-show="addPanel.tab === 'discover'">
        <div class="discover-scan">
          <input class="form-input" x-model="addPanel.scanDir" placeholder="Directory to scan (leave empty for all repos)">
          <button class="btn btn-primary" @click="runDiscover()">Scan</button>
          <button class="btn" @click="browseFolder()" title="Browse for folder">📁</button>
        </div>
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
          <template x-for="dir in addPanel.recentDirs" :key="dir">
            <button class="btn" style="font-size:0.7rem;padding:2px 8px" @click="addPanel.scanDir = dir" x-text="'📁 ' + basename(dir)"></button>
          </template>
        </div>
        <div class="discover-list">
          <template x-if="addPanel.discovering">
            <span style="color:#8b949e">Scanning…</span>
          </template>
          <template x-if="!addPanel.discovering && addPanel.discovered.length === 0 && !addPanel.discoverMessage">
            <span style="color:#8b949e;font-size:0.85rem">Click <strong>Scan</strong> to discover available agents from installed plugins and local repositories.</span>
          </template>
          <template x-if="!addPanel.discovering && addPanel.discoverMessage">
            <span :style="addPanel.discoverError ? 'color:#f85149' : 'color:#8b949e'" x-text="addPanel.discoverMessage"></span>
          </template>
          <template x-for="item in addPanel.discovered" :key="item.source + ':' + item.id + ':' + (item.pluginDir || item.cwd || '')">
            <div class="discover-item" :class="{ registered: item.registered }">
              <div class="discover-info">
                <div>
                  <span class="discover-name" x-text="item.displayName || item.name"></span>
                  <span class="source-badge" :class="discoverSourceClass(item)" x-text="discoverSourceLabel(item)"></span>
                  <template x-if="item.version"><span style="color:#8b949e;font-size:0.7rem" x-text="'v' + item.version"></span></template>
                  <template x-if="item.repoName"><span style="color:#8b949e;font-size:0.7rem" x-text="'in ' + item.repoName"></span></template>
                </div>
                <template x-if="item.description"><div class="discover-desc" x-text="item.description"></div></template>
                <template x-if="item.cwd"><div class="discover-meta" x-text="'📁 ' + item.cwd"></div></template>
                <template x-if="item.author"><div class="discover-meta" x-text="'👤 ' + item.author"></div></template>
              </div>
              <div class="discover-actions" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                <template x-if="item.registered">
                  <span style="color:#3fb950;font-size:0.8rem">✓ Added</span>
                </template>
                <template x-if="!item.registered">
                  <button class="btn btn-primary" @click="prefillFromDiscover(item)">+ Add</button>
                </template>
                <template x-if="item.installed === false && item.installCmd">
                  <button class="btn" :disabled="installState(installStateKey(item, 'cmd')).disabled" :title="installState(installStateKey(item, 'cmd')).title" @click="installPlugin(item.installCmd, null, null, installStateKey(item, 'cmd'))" x-text="installState(installStateKey(item, 'cmd')).text || '📦 Install'"></button>
                </template>
                <template x-if="item.pluginDir && !item.installed">
                  <button class="btn btn-primary" :disabled="installState(installStateKey(item, 'overlay')).disabled" :title="'Install as supervisor-managed overlay (recommended)'" @click="installPlugin(null, item.pluginDir, 'overlay', installStateKey(item, 'overlay'))" x-text="installState(installStateKey(item, 'overlay')).text || '🔧 Install Overlay'"></button>
                </template>
                <template x-if="item.pluginDir && !item.installed">
                  <button class="btn" style="background:#1f6feb22;border-color:#58a6ff44;color:#58a6ff" :disabled="installState(installStateKey(item, 'copilot-local')).disabled" :title="'Register in Copilot via junction + config.json'" @click="installPlugin(null, item.pluginDir, 'copilot-local', installStateKey(item, 'copilot-local'))" x-text="installState(installStateKey(item, 'copilot-local')).text || '📦 Copilot Registry'"></button>
                </template>
                <template x-if="item.pluginDir && !item.installed">
                  <button class="btn" style="background:#1f6feb22;border-color:#58a6ff44;color:#58a6ff" :disabled="installState(installStateKey(item, 'agency')).disabled" :title="'Install via Agency registry'" @click="installPlugin(null, item.pluginDir, 'agency', installStateKey(item, 'agency'))" x-text="installState(installStateKey(item, 'agency')).text || '⚡ Agency'"></button>
                </template>
                <template x-if="item.installed === false && !item.installCmd && !item.pluginDir">
                  <span style="color:#f0883e;font-size:0.7rem">not installed</span>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="panel-content" :class="{ active: addPanel.tab === 'manual' }" x-show="addPanel.tab === 'manual'">
        <div class="form-group">
          <label class="form-label">ID *</label>
          <input class="form-input" x-model="addPanel.form.id" placeholder="my-agent (unique identifier)">
          <div class="form-hint">Lowercase, hyphens. Used as internal key.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Display Name *</label>
          <input class="form-input" x-model="addPanel.form.name" placeholder="My Agent">
          <div class="form-hint">Human-readable name shown in the dashboard.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Agent Name *</label>
          <input class="form-input" x-model="addPanel.form.agent" placeholder="Agent display name for --agent flag">
          <div class="form-hint">The name passed to <code>copilot --agent</code>. Use exact display name.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Working Directory *</label>
          <input class="form-input" x-model="addPanel.form.cwd" placeholder="C:\repos\my-project">
          <div class="form-hint">Directory where the agent runs (where copilot-instructions.md lives).</div>
        </div>
        <div class="form-group">
          <label class="form-label">Prompt *</label>
          <input class="form-input" x-model="addPanel.form.prompt" placeholder="check status">
          <div class="form-hint">The prompt sent to the agent on each scheduled run.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Schedule *</label>
          <input class="form-input" x-model="addPanel.form.schedule" placeholder="1h, 30m, weekdays at 9am">
          <div class="form-hint">Interval (30m, 2h), cron expression, or human-readable schedule.</div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Group</label>
            <input class="form-input" x-model="addPanel.form.group" placeholder="Optional group name">
          </div>
          <div class="form-group">
            <label class="form-label">Copilot Path</label>
            <input class="form-input" x-model="addPanel.form.copilotPath" placeholder="Auto-detect">
            <div class="form-hint">Override path to copilot.cmd</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Plugin Directory</label>
          <input class="form-input" x-model="addPanel.form.pluginDir" placeholder="Optional — path to local plugin dir">
          <div class="form-hint">For plugins not globally installed. Uses <code>--plugin-dir</code> flag.</div>
        </div>
        <div class="form-group">
          <label class="form-label">MCP Config</label>
          <input class="form-input" x-model="addPanel.form.mcpConfig" placeholder="Optional — relative path to .mcp.json">
          <div class="form-hint">Relative to cwd. Uses <code>--additional-mcp-config</code> flag.</div>
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" x-model="addPanel.form.durable">
            <span>Durable</span>
            <span class="form-hint" style="margin:0">(auto-restart on supervisor start)</span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" x-model="addPanel.form.autoStart">
            <span>Auto-start</span>
            <span class="form-hint" style="margin:0">(run immediately when enabled; uncheck for schedule-only)</span>
          </label>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" @click="submitAddAgent()">Add Agent</button>
          <button class="btn" @click="closeAddPanel()">Cancel</button>
        </div>
        <div style="color:#f85149;font-size:0.8rem;margin-top:8px;display:none" x-show="!!addPanel.error" x-text="addPanel.error"></div>
      </div>
    </div>
  </div>

  <script>
    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function esc(str) {
      return escapeHtml(str || '');
    }

    function basename(p) {
      return (p || '').split(/[\\/]/).pop() || '';
    }

    function timeAgo(iso) {
      if (!iso) return 'never';
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return Math.round(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
      return Math.round(diff / 86400000) + 'd ago';
    }

    function timeUntil(iso) {
      if (!iso) return '-';
      const diff = new Date(iso).getTime() - Date.now();
      if (diff < 0) return 'now';
      if (diff < 60000) return Math.round(diff / 1000) + 's';
      if (diff < 3600000) return Math.round(diff / 60000) + 'm';
      return Math.floor(diff / 3600000) + 'h ' + Math.round((diff % 3600000) / 60000) + 'm';
    }

    function formatRunTimestamp(startedAt, finishedAt) {
      if (!startedAt) return '';
      const start = new Date(startedAt);
      const timeStr = start.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (!finishedAt) return '⏱ Started ' + timeStr + ' (running…)';
      const durationMs = new Date(finishedAt).getTime() - start.getTime();
      let durStr;
      if (durationMs < 60000) durStr = Math.round(durationMs / 1000) + 's';
      else if (durationMs < 3600000) durStr = Math.floor(durationMs / 60000) + 'm ' + Math.round((durationMs % 60000) / 1000) + 's';
      else durStr = Math.floor(durationMs / 3600000) + 'h ' + Math.round((durationMs % 3600000) / 60000) + 'm';
      return '🕐 ' + timeStr + ' · ran for ' + durStr;
    }

    function renderMd(s) {
      if (typeof marked !== 'undefined' && marked.parse) {
        try { return marked.parse(s || ''); } catch { }
      }
      return esc(s || '');
    }

    function renderSessionMetaBanner(meta) {
      if (!meta) return '';
      let items = '';
      if (meta.agent) items += '<span class="meta-item"><span class="meta-label">Agent</span><span class="meta-value">' + esc(meta.agent) + '</span></span>';
      if (meta.repo) items += '<span class="meta-item"><span class="meta-label">Repo</span><span class="meta-value">' + esc(meta.repo) + '</span></span>';
      if (meta.branch) items += '<span class="meta-item"><span class="meta-label">Branch</span><span class="meta-value">' + esc(meta.branch) + '</span></span>';
      if (meta.cwd) items += '<span class="meta-item"><span class="meta-label">CWD</span><span class="meta-value">' + esc(meta.cwd) + '</span></span>';
      if (meta.copilotVersion) items += '<span class="meta-item"><span class="meta-label">Version</span><span class="meta-value">' + esc(meta.copilotVersion) + '</span></span>';
      return items ? '<div class="session-meta-banner">' + items + '</div>' : '';
    }

    function renderTokenStats(stats) {
      if (!stats) return '';
      const totalTokens = (stats.input || 0) + (stats.output || 0) + (stats.cacheRead || 0) + (stats.cacheWrite || 0);
      let items = '';
      if (stats.premiumRequests != null) items += '<span class="stat-item"><span class="stat-value">' + stats.premiumRequests + '</span><span class="stat-label">requests</span></span>';
      if (totalTokens > 0) items += '<span class="stat-item"><span class="stat-value">' + totalTokens.toLocaleString() + '</span><span class="stat-label">tokens</span></span>';
      if (stats.input) items += '<span class="stat-item"><span class="stat-value">' + stats.input.toLocaleString() + '</span><span class="stat-label">in</span></span>';
      if (stats.output) items += '<span class="stat-item"><span class="stat-value">' + stats.output.toLocaleString() + '</span><span class="stat-label">out</span></span>';
      if (stats.cacheRead) items += '<span class="stat-item"><span class="stat-value">' + stats.cacheRead.toLocaleString() + '</span><span class="stat-label">cache read</span></span>';
      if (stats.apiDurationMs != null) items += '<span class="stat-item"><span class="stat-value">' + (stats.apiDurationMs / 1000).toFixed(1) + 's</span><span class="stat-label">API time</span></span>';
      if (stats.linesAdded != null || stats.linesRemoved != null) {
        const added = stats.linesAdded || 0;
        const removed = stats.linesRemoved || 0;
        if (added || removed) items += '<span class="stat-item"><span class="stat-value" style="color:#3fb950">+' + added + '</span><span class="stat-value" style="color:#f85149;margin-left:2px">-' + removed + '</span><span class="stat-label">lines</span></span>';
      }
      return items ? '<div class="session-token-stats">' + items + '</div>' : '';
    }

    function renderModelBadge(model) {
      if (!model) return '';
      return '<span class="model-badge">' + esc(model) + '</span>';
    }

    function renderStepsHtml(steps) {
      if (!steps || steps.length === 0) return '';
      let html = '';
      for (const step of steps) {
        if (step.type === 'comment') {
          html += '<div class="tool-step" style="border-left:2px solid #58a6ff;background:#161b22;">' +
            '<div style="font-size:0.7rem;color:#58a6ff;margin-bottom:2px;">💭 Agent</div>' +
            '<div class="conv-content assistant-content" style="font-size:0.75rem;padding-left:6px;border:none;">' + renderMd(step.content) + '</div>' +
            '</div>';
          continue;
        }
        const statusClass = step.type === 'tool_start' ? 'pending' : (step.success !== false ? 'success' : 'failed');
        const icon = step.type === 'tool_start' ? '⏳' : (step.success !== false ? '✓' : '✗');
        const desc = (step.args && (step.args.description || step.args.command || step.args.pattern || step.args.path || step.args.query)) || '';
        const stepId = 'step-' + Math.random().toString(36).slice(2, 8);
        html += '<div class="tool-step ' + statusClass + '">' +
          '<div class="tool-step-header" onclick="document.getElementById(\\'' + stepId + '\\').classList.toggle(\\'visible\\')">' +
          '<span class="tool-step-icon">' + icon + '</span>' +
          '<span class="tool-step-name">' + esc(step.tool || '') + '</span>' +
          (desc ? '<span class="tool-step-desc">' + esc(desc) + '</span>' : '') +
          '</div>';
        if (step.result) {
          html += '<div class="tool-step-result" id="' + stepId + '">' + esc(step.result) + '</div>';
        }
        html += '</div>';
      }
      return html;
    }

    function buildConvoHtml(turns, containerId, showSteps, sessionMeta, tokenStats, showPending) {
      if (!turns || turns.length === 0) {
        return '<div style="color:#8b949e;font-size:0.8rem;padding:8px">No conversation data</div>';
      }
      let html = '<div class="session-conversation" id="' + containerId + '">';
      if (showSteps && sessionMeta) html += renderSessionMetaBanner(sessionMeta);
      for (const turn of turns) {
        html += '<div class="conv-turn"><div class="conv-role user">👤 You</div><div class="conv-content">' + esc(turn.content) + '</div></div>';
        if (showSteps && turn.steps && turn.steps.length > 0) {
          html += renderStepsHtml(turn.steps);
        }
        if (turn.assistant) {
          html += '<div class="conv-turn"><div class="conv-role assistant">🤖 Agent' + (showSteps ? renderModelBadge(turn.model) : '') + '</div><div class="conv-content assistant-content">' + renderMd(turn.assistant) + '</div></div>';
        } else if (showPending) {
          html += '<div class="conv-turn"><div class="conv-role assistant">🤖 Agent</div><div class="conv-content assistant-content" style="color:#8b949e">Thinking...</div></div>';
        }
      }
      if (showSteps && tokenStats) html += renderTokenStats(tokenStats);
      html += '</div>';
      return html;
    }

    function agentsApp() {
      return {
        agents: [],
        filter: '',
        refreshTimer: null,
        refreshInFlight: false,
        collapsedGroups: JSON.parse(localStorage.getItem('collapsedAgentGroups') || '{}'),
        expandedOutputs: {},
        outputScrolls: {},
        liveOutputs: {},
        livePollers: {},
        editingNameId: '',
        pendingName: '',
        editingPromptId: '',
        pendingPrompt: '',
        triggerEditor: { agentId: '', success: [], failure: [], complete: [] },
        scheduleEditor: {
          show: false,
          agentId: '',
          top: 0,
          left: 0,
          current: '',
          mode: 'interval',
          num: 1,
          unit: 'h',
          dailyTime: '09:00',
          weeklyTime: '09:00',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          cron: '',
          previewText: '—',
          previewColor: '#8b949e'
        },
        sessionsPanel: {
          show: false,
          hours: '24',
          filter: '',
          sessions: [],
          loading: false,
          expanded: {},
          details: {},
          chatInputs: {},
          chatStatus: {},
          groupState: JSON.parse(localStorage.getItem('sessionGroupState') || '{}'),
          pollers: {}
        },
        focus: {
          show: false,
          sessionId: '',
          data: null,
          html: '',
          title: 'Session',
          verbose: localStorage.getItem('focusVerbose') === '1',
          poller: null,
          minTurns: 0,
          chatPending: false,
          chatInput: '',
          chatStatus: '',
          emailMenu: false
        },
        outputModal: { show: false, title: 'Output', content: '' },
        addPanel: {
          show: false,
          tab: 'discover',
          scanDir: '',
          recentDirs: [],
          discovering: false,
          discoverMessage: '',
          discoverError: false,
          discovered: [],
          installStates: {},
          error: '',
          form: {
            id: '',
            name: '',
            agent: '',
            cwd: '',
            prompt: '',
            schedule: '',
            group: '',
            copilotPath: '',
            pluginDir: '',
            mcpConfig: '',
            durable: true,
            autoStart: true
          }
        },

        async init() {
          await this.refresh();
          const self = this;
          this.refreshTimer = setInterval(function() {
            self.refresh();
          }, 10000);
          setTimeout(function() { self.ensureLivePollers(); }, 1000);
        },

        async requestJson(url, options) {
          const res = await fetch(url, options || {});
          const type = res.headers.get('content-type') || '';
          let data = null;
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

        rememberOutputScroll(id, value) {
          this.outputScrolls[id] = value;
        },

        captureOutputScrolls() {
          document.querySelectorAll('.output-content').forEach((el) => {
            if (el.id) this.outputScrolls[el.id] = el.scrollTop;
          });
        },

        restoreOutputScrolls() {
          this.$nextTick(() => {
            Object.keys(this.outputScrolls).forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.scrollTop = this.outputScrolls[id];
            });
          });
        },

        async refresh() {
          if (this.refreshInFlight) return;
          this.refreshInFlight = true;
          this.captureOutputScrolls();
          try {
            const agents = await this.requestJson('/api/agents');
            this.agents = Array.isArray(agents) ? agents : [];
            this.ensureLivePollers();
            this.restoreOutputScrolls();
          } catch (e) {
            console.error(e);
          } finally {
            this.refreshInFlight = false;
          }
        },

        renderMd(content) {
          return renderMd(content || '');
        },

        agentDisplayName(agent) {
          return (agent && agent.config && agent.config.name) || (agent && agent.agent_id) || '';
        },

        agentPrompt(agent) {
          return (agent && agent.config && agent.config.prompt) || '-';
        },

        isAgentEnabled(agent) {
          return agent && agent.enabled !== 0;
        },

        isAutoStart(agent) {
          return !agent || !agent.config || agent.config.autoStart !== false;
        },

        allGroupNames() {
          const names = [];
          const seen = {};
          this.agents.forEach((agent) => {
            const group = (agent.config && agent.config.group) || 'Ungrouped';
            if (!seen[group]) {
              seen[group] = true;
              names.push(group);
            }
          });
          return names;
        },

        movableGroupNames() {
          return this.allGroupNames().filter((name) => name !== 'Ungrouped');
        },

        groupedAgents() {
          const filterText = (this.filter || '').toLowerCase();
          const groups = {};
          this.agents.forEach((agent) => {
            const name = this.agentDisplayName(agent).toLowerCase();
            if (filterText && name.indexOf(filterText) === -1) return;
            const group = (agent.config && agent.config.group) || 'Ungrouped';
            if (!groups[group]) groups[group] = [];
            groups[group].push(agent);
          });
          return Object.keys(groups).map((name) => ({ name: name, agents: groups[name] }));
        },

        isGroupCollapsed(name) {
          return !!this.collapsedGroups[name];
        },

        saveCollapsedGroups() {
          localStorage.setItem('collapsedAgentGroups', JSON.stringify(this.collapsedGroups));
        },

        toggleGroup(name) {
          this.collapsedGroups[name] = !this.collapsedGroups[name];
          this.saveCollapsedGroups();
        },

        expandAllGroups() {
          this.collapsedGroups = {};
          this.saveCollapsedGroups();
        },

        collapseAllGroups() {
          const next = {};
          this.groupedAgents().forEach((group) => { next[group.name] = true; });
          this.collapsedGroups = next;
          this.saveCollapsedGroups();
        },

        isOutputExpanded(id) {
          return !!this.expandedOutputs[id];
        },

        toggleOutput(id) {
          this.expandedOutputs[id] = !this.expandedOutputs[id];
          this.restoreOutputScrolls();
        },

        liveOutputHtml(agentId) {
          const live = this.liveOutputs[agentId];
          if (live && live.html) return live.html;
          return '<span style="color:#8b949e">Waiting for agent output...</span>';
        },

        liveStatusText(agentId) {
          const live = this.liveOutputs[agentId];
          return (live && live.statusText) || 'watching...';
        },

        liveSessionId(agentId) {
          const live = this.liveOutputs[agentId];
          return (live && live.sessionId) || '';
        },

        startEditName(agent) {
          this.editingPromptId = '';
          this.editingNameId = agent.agent_id;
          this.pendingName = this.agentDisplayName(agent);
        },

        cancelEditName() {
          this.editingNameId = '';
          this.pendingName = '';
        },

        async saveEditName(agentId) {
          if (this.editingNameId !== agentId) return;
          const agent = this.agents.find((a) => a.agent_id === agentId);
          const current = this.agentDisplayName(agent);
          const newName = (this.pendingName || '').trim();
          this.cancelEditName();
          if (!newName || newName === current) return;
          try {
            await this.requestJson('/api/agents/' + agentId + '/name', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        startEditPrompt(agent) {
          this.editingNameId = '';
          this.editingPromptId = agent.agent_id;
          this.pendingPrompt = this.agentPrompt(agent) === '-' ? '' : this.agentPrompt(agent);
        },

        cancelEditPrompt() {
          this.editingPromptId = '';
          this.pendingPrompt = '';
        },

        async saveEditPrompt(agentId) {
          if (this.editingPromptId !== agentId) return;
          const agent = this.agents.find((a) => a.agent_id === agentId);
          const current = this.agentPrompt(agent);
          const newPrompt = (this.pendingPrompt || '').trim();
          this.cancelEditPrompt();
          if (!newPrompt || newPrompt === current) return;
          try {
            await this.requestJson('/api/agents/' + agentId + '/prompt', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: newPrompt })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async startAgent(id) {
          try { await this.requestJson('/api/agents/' + id + '/start', { method: 'POST' }); await this.refresh(); } catch (e) { alert(e.message); }
        },

        async stopAgent(id) {
          try { await this.requestJson('/api/agents/' + id + '/stop', { method: 'POST' }); await this.refresh(); } catch (e) { alert(e.message); }
        },

        async runNow(id) {
          try { await this.requestJson('/api/agents/' + id + '/run', { method: 'POST' }); await this.refresh(); } catch (e) { alert(e.message); }
        },

        async openInCode() {
          try { await this.requestJson('/api/open-editor', { method: 'POST' }); } catch (e) { alert(e.message); }
        },

        async handleImportFile(event) {
          const input = event.target;
          const file = input.files && input.files[0];
          if (!file) { alert('No file selected'); return; }
          const formData = new FormData();
          formData.append('file', file);
          try {
            const res = await fetch('/api/import', { method: 'POST', body: formData });
            if (!res.ok) {
              alert('Import request failed: HTTP ' + res.status);
              input.value = '';
              return;
            }
            const result = await res.json();
            let msg = '';
            if (result.imported && result.imported.length) msg += '✅ Imported:\\n' + result.imported.join('\\n') + '\\n\\n';
            if (result.warnings && result.warnings.length) msg += '⚠️ Warnings:\\n' + result.warnings.join('\\n') + '\\n\\n';
            if (result.errors && result.errors.length) msg += '❌ Errors:\\n' + result.errors.join('\\n');
            alert(msg || 'Import complete (no details returned)');
            await this.refresh();
          } catch (e) {
            alert('Import failed: ' + e.message);
          }
          input.value = '';
        },

        async toggleEnabled(id, enabled) {
          try {
            await this.requestJson('/api/agents/' + id + '/enabled', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: enabled })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async toggleAutoStart(id, current) {
          try {
            await this.requestJson('/api/agents/' + id + '/autostart', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ autoStart: !current })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        openScheduleEditor(agentId, currentSchedule, evt) {
          const rect = evt.currentTarget.getBoundingClientRect();
          let top = rect.top - 260 - 8;
          if (top < 10) top = rect.bottom + 8;
          let left = rect.left;
          if (left + 380 > window.innerWidth) left = window.innerWidth - 390;
          if (left < 10) left = 10;
          this.scheduleEditor.show = true;
          this.scheduleEditor.agentId = agentId;
          this.scheduleEditor.top = top;
          this.scheduleEditor.left = left;
          this.detectScheduleMode(currentSchedule || '');
        },

        closeScheduleEditor() {
          this.scheduleEditor.show = false;
        },

        detectScheduleMode(schedule) {
          const current = schedule || '';
          this.scheduleEditor.current = current;
          if (!current) {
            this.scheduleEditor.mode = 'interval';
          } else if (/^\d+[mh]$/i.test(current) || /^every\s+\d+\s*(min|hour|sec)/i.test(current)) {
            this.scheduleEditor.mode = 'interval';
          } else if (/weekday|M,T|mon|tue|wed|thu|fri|sat|sun/i.test(current)) {
            this.scheduleEditor.mode = 'weekly';
          } else if (/daily|^at\s+\d/i.test(current)) {
            this.scheduleEditor.mode = 'daily';
          } else {
            this.scheduleEditor.mode = 'cron';
          }
          let match = current.match(/(\d+)\s*([mh])/i);
          this.scheduleEditor.num = match ? parseInt(match[1], 10) : 1;
          this.scheduleEditor.unit = match ? match[2].toLowerCase() : 'h';
          let time = '09:00';
          match = current.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
          if (match) {
            let hours = parseInt(match[1], 10);
            const minutes = match[2] || '00';
            if (match[3] && match[3].toLowerCase() === 'pm' && hours < 12) hours += 12;
            if (match[3] && match[3].toLowerCase() === 'am' && hours === 12) hours = 0;
            time = String(hours).padStart(2, '0') + ':' + minutes;
          }
          this.scheduleEditor.dailyTime = time;
          this.scheduleEditor.weeklyTime = time;
          let checkedDays = [];
          if (/weekday/i.test(current)) {
            checkedDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
          } else {
            const dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
            checkedDays = dayKeys.filter((day) => new RegExp(day, 'i').test(current));
          }
          if (!checkedDays.length) checkedDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
          this.scheduleEditor.days = checkedDays;
          this.scheduleEditor.cron = current;
          this.previewSchedule();
        },

        onScheduleModeChanged() {
          if (this.scheduleEditor.mode === 'weekly' && !this.scheduleEditor.days.length) {
            this.scheduleEditor.days = ['mon', 'tue', 'wed', 'thu', 'fri'];
          }
          if (this.scheduleEditor.mode === 'cron' && !this.scheduleEditor.cron) {
            this.scheduleEditor.cron = this.scheduleEditor.current || '';
          }
          this.previewSchedule();
        },

        getScheduleValue() {
          if (this.scheduleEditor.mode === 'interval') {
            return String(this.scheduleEditor.num || '1').trim() + (this.scheduleEditor.unit || 'h');
          }
          if (this.scheduleEditor.mode === 'daily') {
            const time = this.scheduleEditor.dailyTime || '09:00';
            const parts = time.split(':').map(Number);
            const h = parts[0] || 0;
            const m = parts[1] || 0;
            const ampm = h >= 12 ? 'pm' : 'am';
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            return 'daily at ' + h12 + (m > 0 ? ':' + String(m).padStart(2, '0') : '') + ampm;
          }
          if (this.scheduleEditor.mode === 'weekly') {
            const checked = this.scheduleEditor.days.slice();
            if (!checked.length) return '';
            const time = this.scheduleEditor.weeklyTime || '09:00';
            const parts = time.split(':').map(Number);
            const h = parts[0] || 0;
            const m = parts[1] || 0;
            const ampm = h >= 12 ? 'pm' : 'am';
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            const timeStr = h12 + (m > 0 ? ':' + String(m).padStart(2, '0') : '') + ampm;
            if (checked.length === 5 && checked.indexOf('sat') === -1 && checked.indexOf('sun') === -1) {
              return 'weekdays at ' + timeStr;
            }
            const dayMap = { mon: 'M', tue: 'T', wed: 'W', thu: 'Th', fri: 'F', sat: 'Sa', sun: 'Su' };
            return checked.map((day) => dayMap[day]).join(',') + ' at ' + timeStr;
          }
          return (this.scheduleEditor.cron || '').trim();
        },

        async previewSchedule() {
          const value = this.getScheduleValue();
          if (!value) {
            this.scheduleEditor.previewText = '—';
            this.scheduleEditor.previewColor = '#8b949e';
            return;
          }
          try {
            const data = await this.requestJson('/api/schedule/describe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ schedule: value })
            });
            this.scheduleEditor.previewText = '✓ ' + (data.description || value);
            this.scheduleEditor.previewColor = '#7ee787';
          } catch (e) {
            this.scheduleEditor.previewText = '⚠ ' + e.message;
            this.scheduleEditor.previewColor = '#f85149';
          }
        },

        async saveScheduleEditor() {
          const value = this.getScheduleValue();
          if (!value) return;
          try {
            await this.requestJson('/api/agents/' + this.scheduleEditor.agentId + '/schedule', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ schedule: value })
            });
            this.closeScheduleEditor();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        normalizeTriggerList(value) {
          if (!value) return [];
          return Array.isArray(value) ? value : [value];
        },

        hasTriggers(agent) {
          return this.normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onSuccess).length > 0
            || this.normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onFailure).length > 0
            || this.normalizeTriggerList(agent.config && agent.config.triggers && agent.config.triggers.onComplete).length > 0;
        },

        agentNameById(id) {
          const agent = this.agents.find((a) => a.agent_id === id);
          return this.agentDisplayName(agent || { agent_id: id });
        },

        triggerTargets(agent) {
          return this.agents.filter((candidate) => candidate.agent_id !== agent.agent_id);
        },

        toggleTriggerEditor(agent) {
          if (this.triggerEditor.agentId === agent.agent_id) {
            this.triggerEditor = { agentId: '', success: [], failure: [], complete: [] };
            return;
          }
          const triggers = (agent.config && agent.config.triggers) || {};
          this.triggerEditor = {
            agentId: agent.agent_id,
            success: this.normalizeTriggerList(triggers.onSuccess),
            failure: this.normalizeTriggerList(triggers.onFailure),
            complete: this.normalizeTriggerList(triggers.onComplete)
          };
        },

        async saveTriggers() {
          const id = this.triggerEditor.agentId;
          if (!id) return;
          const triggers = {};
          if (this.triggerEditor.success.length) triggers.onSuccess = this.triggerEditor.success.slice();
          if (this.triggerEditor.failure.length) triggers.onFailure = this.triggerEditor.failure.slice();
          if (this.triggerEditor.complete.length) triggers.onComplete = this.triggerEditor.complete.slice();
          try {
            if (Object.keys(triggers).length > 0) {
              await this.requestJson('/api/agents/' + id + '/schedule', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schedule: 'never' })
              });
            }
            await this.requestJson('/api/agents/' + id + '/triggers', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ triggers: triggers })
            });
            this.triggerEditor = { agentId: '', success: [], failure: [], complete: [] };
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async clearTriggers() {
          const id = this.triggerEditor.agentId;
          if (!id) return;
          try {
            await this.requestJson('/api/agents/' + id + '/triggers', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ triggers: {} })
            });
            this.triggerEditor = { agentId: '', success: [], failure: [], complete: [] };
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async moveToGroup(agentId, group) {
          let nextGroup = group;
          if (nextGroup === '__new__') {
            const name = prompt('New group name:');
            if (!name) return;
            nextGroup = name.trim();
            if (!nextGroup) return;
          }
          try {
            await this.requestJson('/api/agents/' + agentId + '/group', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ group: nextGroup || null })
            });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async renameGroup(oldName) {
          const newName = prompt('Rename group "' + oldName + '" to:', oldName);
          if (!newName || newName === oldName) return;
          try {
            await this.requestJson('/api/groups/rename', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ oldName: oldName, newName: newName.trim() })
            });
            delete this.collapsedGroups[oldName];
            this.saveCollapsedGroups();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async deleteGroup(name) {
          if (!confirm('Dissolve group "' + name + '"? Agents will move to Ungrouped.')) return;
          try {
            await this.requestJson('/api/groups/' + encodeURIComponent(name), { method: 'DELETE' });
            delete this.collapsedGroups[name];
            this.saveCollapsedGroups();
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        async emailOutput(agentId) {
          try {
            await this.requestJson('/api/agents/' + agentId + '/email', { method: 'POST' });
          } catch (e) {
            alert(e.message);
          }
        },

        openOutputModal(name, agentId) {
          const agent = this.agents.find((a) => a.agent_id === agentId);
          const content = agent && agent.lastRun ? this.renderMd(agent.lastRun.output || '') : '';
          this.outputModal = { show: true, title: name + ' — Last Output', content: content };
        },

        closeOutputModal() {
          this.outputModal.show = false;
        },

        resetAddForm() {
          this.addPanel.form = {
            id: '',
            name: '',
            agent: '',
            cwd: '',
            prompt: '',
            schedule: '',
            group: '',
            copilotPath: '',
            pluginDir: '',
            mcpConfig: '',
            durable: true,
            autoStart: true
          };
        },

        async openAddPanel() {
          this.addPanel.show = true;
          this.addPanel.error = '';
          await this.loadRecentDirs();
        },

        cloneAgent(agentId) {
          const agent = this.agents.find((a) => a.agent_id === agentId);
          if (!agent || !agent.config) return;
          const c = agent.config;
          this.openAddPanel();
          this.switchAddTab('manual');
          this.addPanel.form.id = '';
          this.addPanel.form.name = (c.name || '') + ' (copy)';
          this.addPanel.form.agent = c.agent || '';
          this.addPanel.form.cwd = c.cwd || '';
          this.addPanel.form.prompt = c.prompt || '';
          this.addPanel.form.schedule = c.schedule || '1h';
          this.addPanel.form.group = c.group || '';
          this.addPanel.form.copilotPath = c.copilotPath || '';
          this.addPanel.form.pluginDir = c.pluginDir || '';
          this.addPanel.form.mcpConfig = c.mcpConfig || '';
          this.addPanel.form.durable = c.durable !== false;
          this.addPanel.form.autoStart = c.autoStart !== false;
          this.$nextTick(() => {
            const inputs = document.querySelectorAll('.side-panel .form-input');
            if (inputs && inputs.length > 1) {
              inputs[1].focus();
              inputs[1].select();
            }
          });
        },

        closeAddPanel() {
          this.addPanel.show = false;
        },

        switchAddTab(tab) {
          this.addPanel.tab = tab;
        },

        async browseFolder() {
          try {
            const data = await this.requestJson('/api/browse-folder', { method: 'POST' });
            if (data.folder) this.addPanel.scanDir = data.folder;
          } catch (e) {
            alert(e.message);
          }
        },

        async loadRecentDirs() {
          try {
            const dirs = await this.requestJson('/api/recent-dirs');
            this.addPanel.recentDirs = Array.isArray(dirs) ? dirs : [];
          } catch {}
        },

        async runDiscover() {
          this.addPanel.discovering = true;
          this.addPanel.discoverMessage = '';
          this.addPanel.discoverError = false;
          try {
            const params = this.addPanel.scanDir.trim() ? ('?dirs=' + encodeURIComponent(this.addPanel.scanDir.trim())) : '';
            const data = await this.requestJson('/api/discover' + params);
            this.addPanel.discovered = Array.isArray(data.discovered) ? data.discovered : [];
            if (this.addPanel.discovered.length === 0) {
              this.addPanel.discoverMessage = 'No agents discovered. Try specifying a directory with copilot agents/plugins.';
            }
          } catch (e) {
            this.addPanel.discoverMessage = 'Error: ' + e.message;
            this.addPanel.discoverError = true;
            this.addPanel.discovered = [];
          } finally {
            this.addPanel.discovering = false;
          }
        },

        discoverSourceLabel(item) {
          return ({ 'installed-plugin': 'installed', 'marketplace': 'marketplace', 'repo-agent': 'agent', 'repo-plugin': 'local plugin' }[item.source]) || item.source;
        },

        discoverSourceClass(item) {
          return ({ 'installed-plugin': 'source-plugin', 'marketplace': 'source-marketplace', 'repo-agent': 'source-repo-agent', 'repo-plugin': 'source-local-plugin' }[item.source]) || 'source-plugin';
        },

        installStateKey(item, mode) {
          return item.id + ':' + mode + ':' + (item.pluginDir || item.installCmd || '');
        },

        installState(key) {
          return this.addPanel.installStates[key] || { disabled: false, text: '', title: '' };
        },

        async installPlugin(installCmd, pluginDir, engine, key) {
          this.addPanel.installStates[key] = { disabled: true, text: '⏳ Installing…', title: '' };
          try {
            const body = {};
            if (installCmd) body.installCmd = installCmd;
            if (pluginDir) body.pluginDir = pluginDir;
            if (engine) body.engine = engine;
            await this.requestJson('/api/plugins/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            this.addPanel.installStates[key] = { disabled: true, text: '✓ Installed', title: '' };
            setTimeout(() => { this.runDiscover(); }, 1000);
          } catch (e) {
            this.addPanel.installStates[key] = { disabled: false, text: '✗ Failed', title: e.message };
            setTimeout(() => {
              this.addPanel.installStates[key] = { disabled: false, text: '', title: '' };
            }, 3000);
          }
        },

        prefillFromDiscover(item) {
          this.switchAddTab('manual');
          this.addPanel.form.id = item.id || '';
          this.addPanel.form.name = item.displayName || item.name || '';
          this.addPanel.form.agent = (item.source === 'repo-plugin' || item.source === 'installed-plugin') ? ((item.id || '') + ':' + (item.id || '')) : (item.displayName || item.name || '');
          this.addPanel.form.cwd = item.cwd || '';
          this.addPanel.form.prompt = '';
          this.addPanel.form.schedule = '1h';
          this.addPanel.form.group = '';
          this.addPanel.form.copilotPath = '';
          this.addPanel.form.pluginDir = item.pluginDir || '';
          this.addPanel.form.mcpConfig = item.mcpConfig || '';
          this.addPanel.form.durable = true;
          this.addPanel.form.autoStart = true;
          this.$nextTick(() => {
            const inputs = document.querySelectorAll('.side-panel .form-input');
            if (inputs && inputs.length > 4) inputs[4].focus();
          });
        },

        async submitAddAgent() {
          this.addPanel.error = '';
          const config = {
            id: (this.addPanel.form.id || '').trim(),
            name: (this.addPanel.form.name || '').trim(),
            agent: (this.addPanel.form.agent || '').trim(),
            cwd: (this.addPanel.form.cwd || '').trim(),
            prompt: (this.addPanel.form.prompt || '').trim(),
            schedule: (this.addPanel.form.schedule || '').trim(),
            durable: !!this.addPanel.form.durable
          };
          if (!this.addPanel.form.autoStart) config.autoStart = false;
          const group = (this.addPanel.form.group || '').trim();
          const copilotPath = (this.addPanel.form.copilotPath || '').trim();
          const pluginDir = (this.addPanel.form.pluginDir || '').trim();
          const mcpConfig = (this.addPanel.form.mcpConfig || '').trim();
          if (group) config.group = group;
          if (copilotPath) config.copilotPath = copilotPath;
          if (pluginDir) config.pluginDir = pluginDir;
          if (mcpConfig) config.mcpConfig = mcpConfig;
          if (!config.id || !config.name || !config.agent || !config.cwd || !config.prompt || !config.schedule) {
            this.addPanel.error = 'All required fields (*) must be filled.';
            return;
          }
          try {
            await this.requestJson('/api/agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config)
            });
            this.closeAddPanel();
            this.resetAddForm();
            await this.refresh();
          } catch (e) {
            this.addPanel.error = e.message;
          }
        },

        async deleteAgent(id) {
          if (!confirm('Delete agent "' + id + '"? This cannot be undone.')) return;
          try {
            await this.requestJson('/api/agents/' + id, { method: 'DELETE' });
            await this.refresh();
          } catch (e) {
            alert(e.message);
          }
        },

        openSessionsPanel() {
          this.sessionsPanel.show = true;
          this.loadSessions();
        },

        closeSessionsPanel() {
          this.sessionsPanel.show = false;
          Object.keys(this.sessionsPanel.pollers).forEach((id) => this.stopSessionPolling(id));
        },

        async loadSessions() {
          this.sessionsPanel.loading = true;
          try {
            const sessions = await this.requestJson('/api/sessions?hours=' + this.sessionsPanel.hours);
            this.sessionsPanel.sessions = Array.isArray(sessions) ? sessions : [];
          } catch {
            this.sessionsPanel.sessions = [];
          } finally {
            this.sessionsPanel.loading = false;
          }
        },

        sessionGroups() {
          const filterText = (this.sessionsPanel.filter || '').toLowerCase();
          const filtered = filterText
            ? this.sessionsPanel.sessions.filter((session) => {
                const haystack = ((session.agentName || session.name || '') + ' ' + (session.name || '') + ' ' + (session.repository || '') + ' ' + (session.cwd || '')).toLowerCase();
                return haystack.indexOf(filterText) !== -1;
              })
            : this.sessionsPanel.sessions;
          const groups = {};
          filtered.forEach((session) => {
            const key = session.agentName || basename(session.cwd) || '(unknown)';
            if (!groups[key]) groups[key] = [];
            groups[key].push(session);
          });
          return Object.keys(groups).map((name) => {
            const sessions = groups[name];
            const latestTime = new Date(sessions[0].lastModified);
            return {
              name: name,
              sessions: sessions,
              repoShort: sessions[0].repository ? sessions[0].repository.split('/').pop() : basename(sessions[0].cwd),
              timeStr: latestTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              dateStr: latestTime.toLocaleDateString([], { month: 'short', day: 'numeric' })
            };
          });
        },

        isSessionGroupCollapsed(name) {
          return this.sessionsPanel.groupState[name] !== false;
        },

        saveSessionGroupState() {
          localStorage.setItem('sessionGroupState', JSON.stringify(this.sessionsPanel.groupState));
        },

        toggleSessionGroup(name) {
          this.sessionsPanel.groupState[name] = !this.isSessionGroupCollapsed(name);
          this.saveSessionGroupState();
        },

        sessionDateLabel(session) {
          const time = new Date(session.lastModified);
          const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
          return dateStr + ' ' + timeStr;
        },

        async toggleSession(id) {
          Object.keys(this.sessionsPanel.pollers).forEach((pollerId) => this.stopSessionPolling(pollerId));
          if (this.sessionsPanel.expanded[id]) {
            this.sessionsPanel.expanded = {};
            return;
          }
          this.sessionsPanel.expanded = {};
          this.sessionsPanel.expanded[id] = true;
          this.sessionsPanel.details[id] = { loading: true, data: null, html: '', chatPending: false, minTurns: 0 };
          try {
            const data = await this.requestJson('/api/sessions/' + id);
            this.sessionsPanel.details[id] = { loading: false, data: data, html: buildConvoHtml(data.turns, 'convo-' + id, false, null, null, false), chatPending: false, minTurns: 0 };
            this.$nextTick(() => {
              const convo = document.getElementById('convo-' + id);
              if (convo) convo.scrollTop = convo.scrollHeight;
            });
          } catch {
            this.sessionsPanel.details[id] = { loading: false, data: null, html: '<div style="color:#f85149;padding:8px">Failed to load session</div>', chatPending: false, minTurns: 0 };
          }
        },

        rerenderSessionDetail(id) {
          const detail = this.sessionsPanel.details[id];
          if (!detail || !detail.data) return;
          detail.html = buildConvoHtml(detail.data.turns, 'convo-' + id, false, null, null, detail.chatPending);
          this.$nextTick(() => {
            const convo = document.getElementById('convo-' + id);
            if (convo) convo.scrollTop = convo.scrollHeight;
          });
        },

        startSessionPolling(id) {
          this.stopSessionPolling(id);
          const self = this;
          const poll = async function() {
            const detail = self.sessionsPanel.details[id];
            if (!detail) return;
            try {
              const data = await self.requestJson('/api/sessions/' + id + '/poll');
              if (!self.sessionsPanel.details[id]) return;
              if (data.turns && data.turns.length >= (detail.minTurns || 0)) {
                detail.chatPending = false;
                detail.data = Object.assign({}, detail.data || {}, data);
                self.rerenderSessionDetail(id);
              }
              const lastTurn = data.turns && data.turns.length ? data.turns[data.turns.length - 1] : null;
              const currentlyPending = lastTurn && !lastTurn.assistant;
              if (data.isActive || detail.chatPending || currentlyPending) {
                self.sessionsPanel.pollers[id] = setTimeout(poll, 2000);
              } else {
                delete self.sessionsPanel.pollers[id];
              }
            } catch {
              delete self.sessionsPanel.pollers[id];
            }
          };
          this.sessionsPanel.pollers[id] = setTimeout(poll, 2000);
        },

        stopSessionPolling(id) {
          if (this.sessionsPanel.pollers[id]) {
            clearTimeout(this.sessionsPanel.pollers[id]);
            delete this.sessionsPanel.pollers[id];
          }
        },

        async sendSessionChat(id) {
          const detail = this.sessionsPanel.details[id];
          const message = ((this.sessionsPanel.chatInputs[id] || '') + '').trim();
          if (!detail || !detail.data || !message) return;
          this.sessionsPanel.chatInputs[id] = '';
          this.sessionsPanel.chatStatus[id] = '<div class="chat-sending"><div class="spinner"></div>Sending to agent... this may take a minute</div>';
          detail.data.turns = (detail.data.turns || []).concat([{ content: message, assistant: null }]);
          detail.chatPending = true;
          detail.minTurns = (detail.data.turns || []).length;
          this.rerenderSessionDetail(id);
          try {
            await this.requestJson('/api/sessions/' + id + '/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: message })
            });
            this.sessionsPanel.chatStatus[id] = '';
            this.startSessionPolling(id);
          } catch {
            detail.chatPending = false;
            this.sessionsPanel.chatStatus[id] = '<div style="color:#f85149;font-size:0.8rem">Failed to send message</div>';
            this.rerenderSessionDetail(id);
          }
        },

        stopFocusPolling() {
          if (this.focus.poller) {
            clearTimeout(this.focus.poller);
            this.focus.poller = null;
          }
        },

        renderFocusHtml(data) {
          return buildConvoHtml(data.turns, 'focus-convo', this.focus.verbose, data.sessionMeta, data.tokenStats, true);
        },

        toggleFocusVerbose() {
          localStorage.setItem('focusVerbose', this.focus.verbose ? '1' : '0');
          if (this.focus.data && this.focus.data.turns) {
            this.focus.html = this.renderFocusHtml(this.focus.data);
            this.$nextTick(() => {
              const convo = document.getElementById('focus-convo');
              if (convo) convo.scrollTop = convo.scrollHeight;
            });
          }
        },

        async openFocus(id) {
          this.focus.show = true;
          this.focus.sessionId = id;
          this.focus.title = 'Session';
          this.focus.html = '<div style="color:#8b949e;padding:20px">Loading session...</div>';
          this.focus.chatInput = '';
          this.focus.chatStatus = '';
          this.focus.emailMenu = false;
          this.focus.minTurns = 0;
          this.focus.chatPending = false;
          this.stopFocusPolling();
          try {
            const data = await this.requestJson('/api/sessions/' + id);
            this.focus.data = data;
            const agentName = data.agentName || data.name || id.substring(0, 8);
            this.focus.title = agentName + ' — ' + (data.name || '');
            this.focus.html = this.renderFocusHtml(data);
            this.$nextTick(() => {
              const convo = document.getElementById('focus-convo');
              if (convo) convo.scrollTop = convo.scrollHeight;
              if (this.$refs.focusChatInput) this.$refs.focusChatInput.focus();
            });
            this.startFocusPolling(id);
          } catch {
            this.focus.html = '<div style="color:#f85149;padding:20px">Failed to load session</div>';
          }
        },

        startFocusPolling(sessionId) {
          this.stopFocusPolling();
          let lastTurnCount = -1;
          let lastStepCount = -1;
          let lastWasPending = false;
          let lastTokenStats = false;
          const self = this;
          const poll = async function() {
            if (self.focus.sessionId !== sessionId) return;
            try {
              const data = await self.requestJson('/api/sessions/' + sessionId + '/poll?verbose=' + (self.focus.verbose ? '1' : '0'));
              const turnCount = data.turns ? data.turns.length : 0;
              const totalSteps = (data.turns || []).reduce((sum, turn) => sum + ((turn.steps && turn.steps.length) || 0), 0);
              if (turnCount < self.focus.minTurns) {
                self.focus.poller = setTimeout(poll, 1000);
                return;
              }
              if (self.focus.chatPending && turnCount >= self.focus.minTurns) {
                self.focus.chatPending = false;
              }
              const lastTurn = data.turns && data.turns.length ? data.turns[data.turns.length - 1] : null;
              const currentlyPending = lastTurn && !lastTurn.assistant;
              const hasTokenStats = !!data.tokenStats;
              const changed = lastTurnCount < 0 || turnCount !== lastTurnCount || (self.focus.verbose && totalSteps !== lastStepCount) || (lastWasPending && !currentlyPending) || (self.focus.verbose && hasTokenStats !== lastTokenStats);
              if (changed) {
                const convo = document.getElementById('focus-convo');
                const wasAtBottom = convo ? (convo.scrollHeight - convo.scrollTop - convo.clientHeight) < 40 : true;
                self.focus.data = Object.assign({}, self.focus.data || {}, data);
                self.focus.html = self.renderFocusHtml(self.focus.data);
                self.$nextTick(() => {
                  const el = document.getElementById('focus-convo');
                  if (el && wasAtBottom) el.scrollTop = el.scrollHeight;
                });
              }
              if (data.chatError) {
                self.focus.chatStatus = '<div style="color:#f85149;font-size:0.8rem">' + esc(data.chatError) + '</div>';
                self.focus.poller = null;
                lastTurnCount = turnCount;
                lastStepCount = totalSteps;
                lastWasPending = currentlyPending;
                lastTokenStats = hasTokenStats;
                return;
              }
              if ((data.isActive || currentlyPending || self.focus.chatPending) && !self.focus.chatStatus.includes('focus-live-indicator')) {
                self.focus.chatStatus = '<span class="focus-live-indicator" style="color:#f0883e;font-size:0.8rem"><span class="spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px"></span>Session is active — updating live</span>';
              }
              if (!data.isActive && !currentlyPending && !self.focus.chatPending) {
                self.focus.chatStatus = '';
              }
              const needsMorePolls = (lastWasPending && !currentlyPending && self.focus.verbose && !hasTokenStats);
              if (data.isActive || currentlyPending || self.focus.chatPending || needsMorePolls) {
                self.focus.poller = setTimeout(poll, 2000);
              } else {
                self.focus.poller = null;
              }
              lastTurnCount = turnCount;
              lastStepCount = totalSteps;
              lastWasPending = currentlyPending;
              lastTokenStats = hasTokenStats;
            } catch {
              self.focus.poller = null;
            }
          };
          this.focus.poller = setTimeout(poll, 1500);
        },

        closeFocus() {
          this.stopFocusPolling();
          this.focus.show = false;
          this.focus.sessionId = '';
          this.focus.data = null;
          this.focus.html = '';
          this.focus.chatInput = '';
          this.focus.chatStatus = '';
          this.focus.minTurns = 0;
          this.focus.chatPending = false;
          this.focus.emailMenu = false;
        },

        async emailFocusSession(mode) {
          this.focus.emailMenu = false;
          if (!this.focus.sessionId) return;
          try {
            await this.requestJson('/api/sessions/' + this.focus.sessionId + '/email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: mode })
            });
          } catch (e) {
            alert('Failed to send email: ' + e.message);
          }
        },

        async sendFocusChat() {
          if (!this.focus.sessionId) return;
          const message = (this.focus.chatInput || '').trim();
          if (!message) return;
          this.focus.chatInput = '';
          this.focus.chatPending = true;
          const existingTurns = (this.focus.data && this.focus.data.turns) ? this.focus.data.turns.slice() : [];
          existingTurns.push({ content: message, assistant: null });
          this.focus.data = Object.assign({}, this.focus.data || {}, { turns: existingTurns });
          this.focus.html = this.renderFocusHtml(this.focus.data);
          this.focus.chatStatus = '<span class="focus-live-indicator" style="color:#f0883e;font-size:0.8rem"><span class="spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px"></span>Session is active — updating live</span>';
          this.focus.minTurns = existingTurns.length;
          this.$nextTick(() => {
            const convo = document.getElementById('focus-convo');
            if (convo) convo.scrollTop = convo.scrollHeight;
          });
          try {
            await this.requestJson('/api/sessions/' + this.focus.sessionId + '/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: message })
            });
            this.startFocusPolling(this.focus.sessionId);
          } catch {
            this.focus.chatPending = false;
            this.focus.chatStatus = '<div style="color:#f85149;font-size:0.8rem">Failed to send message</div>';
          }
          this.$nextTick(() => {
            if (this.$refs.focusChatInput) this.$refs.focusChatInput.focus();
          });
        },

        async openTerminal(id) {
          try {
            await this.requestJson('/api/sessions/' + id + '/terminal', { method: 'POST' });
          } catch (e) {
            alert(e.message);
          }
        },

        showAgentSessions(agentName) {
          const next = {};
          Object.keys(this.sessionsPanel.groupState).forEach((name) => { next[name] = true; });
          next[agentName] = false;
          this.sessionsPanel.groupState = next;
          this.saveSessionGroupState();
          this.openSessionsPanel();
        },

        async openLastTerminal(agentId, agentCwd) {
          try {
            const sessions = await this.requestJson('/api/sessions?hours=48');
            const match = (sessions || []).find((session) => ((session.agentName || '').toLowerCase().indexOf(agentId.toLowerCase()) !== -1) || ((session.name || '').toLowerCase().indexOf(agentId.toLowerCase()) !== -1));
            if (match) {
              await this.requestJson('/api/sessions/' + match.id + '/terminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: agentCwd })
              });
            } else if (agentCwd) {
              await this.requestJson('/api/terminal/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: agentCwd, agentId: agentId })
              });
            } else {
              alert('No recent session found for this agent');
            }
          } catch (e) {
            alert('Failed to find session: ' + e.message);
          }
        },

        async openLastChat(agentId, sessionId) {
          if (sessionId) {
            this.openFocus(sessionId);
            return;
          }
          try {
            const sessions = await this.requestJson('/api/sessions?hours=72');
            const match = (sessions || []).find((session) => ((session.agentName || '').toLowerCase().indexOf(agentId.toLowerCase()) !== -1) || ((session.name || '').toLowerCase().indexOf(agentId.toLowerCase()) !== -1));
            if (match) this.openFocus(match.id);
            else alert('No recent session found for this agent');
          } catch (e) {
            alert('Failed to find session: ' + e.message);
          }
        },

        async editAgentSource(agentId) {
          try { await this.requestJson('/api/agents/' + agentId + '/edit-source', { method: 'POST' }); } catch (e) { alert(e.message); }
        },

        async reinstallPlugin(agentId) {
          if (!confirm('Reinstall this plugin? This will uninstall and re-install it.')) return;
          try {
            await this.requestJson('/api/agents/' + agentId + '/reinstall', { method: 'POST' });
            alert('Plugin reinstalled successfully');
          } catch (e) {
            alert('Reinstall failed: ' + e.message);
          }
        },

        async pollLiveOutput(agentId) {
          if (this.livePollers[agentId]) return;
          const self = this;
          const poll = async function() {
            const el = document.getElementById('live-' + agentId);
            if (!el) {
              delete self.livePollers[agentId];
              return;
            }
            try {
              const data = await self.requestJson('/api/agents/' + agentId + '/live');
              if (!data.running) {
                if (self.livePollers[agentId]) clearTimeout(self.livePollers[agentId]);
                delete self.livePollers[agentId];
                delete self.liveOutputs[agentId];
                await self.refresh();
                return;
              }
              const wasAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
              const scrollTop = el.scrollTop;
              self.liveOutputs[agentId] = {
                html: data.output ? renderMd(data.output) : '<span style="color:#8b949e">Waiting for agent output...</span>',
                statusText: (data.messageCount || 0) + ' response' + ((data.messageCount || 0) !== 1 ? 's' : '') + (data.isActive ? ' · updating...' : ''),
                sessionId: data.sessionId || ''
              };
              self.$nextTick(() => {
                const liveEl = document.getElementById('live-' + agentId);
                if (liveEl) liveEl.scrollTop = wasAtBottom ? liveEl.scrollHeight : scrollTop;
              });
            } catch {}
            self.livePollers[agentId] = setTimeout(poll, 3000);
          };
          this.livePollers[agentId] = setTimeout(poll, 2000);
        },

        ensureLivePollers() {
          this.agents.forEach((agent) => {
            if (agent.status === 'running') this.pollLiveOutput(agent.agent_id);
          });
        }
      };
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
</body>
</html>`;
}

function getManagersPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Managers — Copilot Agent Supervisor</title>
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
    <span class="nav-title">Copilot Agent Supervisor</span>
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
          poller: null,
          loading: false
        },

        async init() {
          this.chat.verbose = localStorage.getItem('mgrVerbose') === 'true';
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
              body: JSON.stringify({ prompt: prompt })
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
          this.chat.poller = setInterval(function() { self.pollChatRun(); }, 2000);
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