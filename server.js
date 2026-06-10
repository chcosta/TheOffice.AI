const express = require('express');
const path = require('path');
const fs = require('fs');
const yazl = require('yazl');
const yauzl = require('yauzl');
const multer = require('multer');
const { openDatabase } = require('./db');
const Supervisor = require('./supervisor');
const ManagerAgent = require('./manager');

const upload = multer({ dest: path.join(require('os').tmpdir(), 'agent-supervisor-uploads') });

const PORT = process.env.PORT || 3847;
const DB_PATH = path.join(__dirname, 'supervisor.db');
const AGENTS_PATH = path.join(__dirname, 'agents.json');
const MANAGERS_PATH = path.join(__dirname, 'managers.json');

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

// Initialize manager agent system
const managerAgent = new ManagerAgent(db, supervisor);

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
        pluginName
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

// Dashboard HTML — Agents page
app.get('/agents', (req, res) => {
  res.send(getDashboardHtml());
});

// Managers page (default)
app.get('/', (req, res) => {
  res.send(getManagersPageHtml());
});

// Legacy dashboard route
app.get('/dashboard', (req, res) => {
  res.send(getDashboardHtml());
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
  res.json({ ok: true });
});

app.post('/api/agents/:id/run', (req, res) => {
  try {
    supervisor._executeAgent(req.params.id);
    res.json({ ok: true, message: 'Execution triggered' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
  const { spawn } = require('child_process');
  // Open pluginDir if it's a plugin agent, otherwise open cwd
  const targetDir = entry.config.pluginDir || entry.config.cwd;
  spawn('code-insiders', [targetDir], { shell: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});

// Reinstall plugin (uninstall + install)
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
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stop a manager's schedules
app.post('/api/managers/:id/stop', (req, res) => {
  managerAgent.stopSchedules(req.params.id);
  res.json({ ok: true });
});

// Run an assignment (async — returns immediately with runId)
app.post('/api/managers/:id/assignments/:assignmentId/run', (req, res) => {
  try {
    const result = managerAgent.runAssignment(req.params.id, req.params.assignmentId);
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
  supervisor.stopAll();
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
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
  <div class="refresh-bar">
    <h1>&#x1F916; Copilot Agent Supervisor <span style="font-size:0.5em;color:#8b949e;font-weight:normal" title="${GIT_VERSION.message} | files:${GIT_VERSION.fileHash || '?'} | PID:${PROCESS_PID} | started:${PROCESS_START}">${GIT_VERSION.hash}${GIT_VERSION.dirty ? '<span style="color:#f85149">*</span>' : ''}</span></h1>
    <div>
      <button class="btn" onclick="openSessionsPanel()" style="margin-right:4px">&#x1F4CB; Sessions</button>
      <button class="btn btn-primary" onclick="openAddPanel()">+ Add Agent</button>
      <button class="btn" onclick="openInCode()">&#x1F4DD; Edit in VS Code</button>
      <button class="btn" onclick="window.location='/api/export'" title="Export config as zip">&#x1F4E6; Export</button>
      <label class="btn" style="cursor:pointer;margin:0" title="Import config from zip">&#x1F4E5; Import<input type="file" id="importZipInput" accept=".zip" style="display:none"></label>
      <span class="auto-refresh">Auto-refreshes every 10s</span>
    </div>
  </div>
  <div class="filter-bar" style="display:flex;align-items:center;gap:12px;padding:8px 0;margin-bottom:8px;">
    <input type="text" id="agent-filter" placeholder="Filter agents by name..." oninput="refresh()" style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;width:220px;font-size:0.85rem;">
    <button class="btn" onclick="expandAllGroups()" title="Expand all groups">▾ Expand All</button>
    <button class="btn" onclick="collapseAllGroups()" title="Collapse all groups">▸ Collapse All</button>
  </div>
  <div class="agents" id="agents"></div>

  <!-- Sessions Panel -->
  <div class="sessions-overlay" id="sessionsOverlay" onclick="closeSessionsPanel()"></div>
  <div class="sessions-panel" id="sessionsPanel">
    <div class="panel-header">
      <h2>&#x1F4CB; Recent Sessions</h2>
      <button class="panel-close" onclick="closeSessionsPanel()">&times;</button>
    </div>
    <div class="session-filters">
      <select id="sessionHours" onchange="loadSessions()">
        <option value="4">Last 4 hours</option>
        <option value="12">Last 12 hours</option>
        <option value="24" selected>Last 24 hours</option>
        <option value="72">Last 3 days</option>
        <option value="168">Last 7 days</option>
      </select>
      <input type="text" id="sessionFilter" placeholder="Filter by name..." oninput="filterSessions()" />
      <button class="btn" onclick="loadSessions()">&#x1F504; Refresh</button>
    </div>
    <div id="sessionsList"></div>
  </div>

  <!-- Focus Modal -->
  <div class="focus-overlay" id="focusOverlay" onclick="if(event.target===this)closeFocus()">
    <div class="focus-modal">
      <div class="focus-header">
        <h2 id="focusTitle">Session</h2>
        <div class="focus-header-actions">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;color:#8b949e;cursor:pointer;" title="Show tool calls and intermediate steps">
            <input type="checkbox" id="focusVerbose" onchange="toggleFocusVerbose()" />
            🔧 Steps
          </label>
          <div style="position:relative;display:inline-block;" id="focusEmailWrap">
            <button class="btn" onclick="document.getElementById('focusEmailMenu').classList.toggle('visible')" title="Email session">✉ Email</button>
            <div id="focusEmailMenu" class="focus-email-menu">
              <button onclick="emailFocusSession('last')">Last response only</button>
              <button onclick="emailFocusSession('full')">Full conversation</button>
            </div>
          </div>
          <button class="btn" onclick="openTerminal(focusSessionId)" title="Open in terminal">&#x1F4BB; Terminal</button>
          <button class="panel-close" onclick="closeFocus()">&times;</button>
        </div>
      </div>
      <div class="focus-body" id="focusBody"></div>
      <div class="focus-chat">
        <input type="text" id="focusChatInput" placeholder="Ask a follow-up question..."
               onkeydown="if(event.key==='Enter')sendFocusChat()" />
        <button class="btn btn-primary" onclick="sendFocusChat()">Send</button>
      </div>
      <div id="focusChatStatus" style="padding:0 20px 8px"></div>
    </div>
  </div>

  <!-- Output Focus Modal -->
  <div class="sessions-overlay" id="outputModalOverlay" onclick="closeOutputModal()"></div>
  <div class="focus-modal" id="outputModal" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001">
    <div class="focus-header">
      <h2 id="outputModalTitle">Output</h2>
      <button class="panel-close" onclick="closeOutputModal()">&times;</button>
    </div>
    <div class="focus-body markdown-body" id="outputModalBody" style="font-size:0.85rem"></div>
  </div>

  <div class="panel-overlay" id="panelOverlay" onclick="closeAddPanel()"></div>
  <div class="side-panel" id="addPanel">
    <div class="panel-header">
      <h2>Add Agent</h2>
      <button class="panel-close" onclick="closeAddPanel()">&times;</button>
    </div>
    <div class="panel-tabs">
      <button class="panel-tab active" onclick="switchTab('discover', this)">Discover</button>
      <button class="panel-tab" onclick="switchTab('manual', this)">Manual</button>
    </div>

    <div class="panel-content active" id="tab-discover">
      <div class="discover-scan">
        <input class="form-input" id="scanDir" placeholder="Directory to scan (leave empty for all repos)" />
        <button class="btn btn-primary" onclick="runDiscover()">Scan</button>
        <button class="btn" onclick="browseFolder()" title="Browse for folder">📁</button>
      </div>
      <div id="recentDirs" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px"></div>
      <div class="discover-list" id="discoverList">
        <span style="color:#8b949e;font-size:0.85rem">Click <strong>Scan</strong> to discover available agents from installed plugins and local repositories.</span>
      </div>
    </div>

    <div class="panel-content" id="tab-manual">
      <div class="form-group">
        <label class="form-label">ID *</label>
        <input class="form-input" id="add-id" placeholder="my-agent (unique identifier)" />
        <div class="form-hint">Lowercase, hyphens. Used as internal key.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Display Name *</label>
        <input class="form-input" id="add-name" placeholder="My Agent" />
        <div class="form-hint">Human-readable name shown in the dashboard.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Agent Name *</label>
        <input class="form-input" id="add-agent" placeholder="Agent display name for --agent flag" />
        <div class="form-hint">The name passed to <code>copilot --agent</code>. Use exact display name.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Working Directory *</label>
        <input class="form-input" id="add-cwd" placeholder="C:\\repos\\my-project" />
        <div class="form-hint">Directory where the agent runs (where copilot-instructions.md lives).</div>
      </div>
      <div class="form-group">
        <label class="form-label">Prompt *</label>
        <input class="form-input" id="add-prompt" placeholder="check status" />
        <div class="form-hint">The prompt sent to the agent on each scheduled run.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Schedule *</label>
        <input class="form-input" id="add-schedule" placeholder="1h, 30m, weekdays at 9am" />
        <div class="form-hint">Interval (30m, 2h), cron expression, or human-readable schedule.</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Group</label>
          <input class="form-input" id="add-group" placeholder="Optional group name" />
        </div>
        <div class="form-group">
          <label class="form-label">Copilot Path</label>
          <input class="form-input" id="add-copilotPath" placeholder="Auto-detect" />
          <div class="form-hint">Override path to copilot.cmd</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Plugin Directory</label>
        <input class="form-input" id="add-pluginDir" placeholder="Optional — path to local plugin dir" />
        <div class="form-hint">For plugins not globally installed. Uses <code>--plugin-dir</code> flag.</div>
      </div>
      <div class="form-group">
        <label class="form-label">MCP Config</label>
        <input class="form-input" id="add-mcpConfig" placeholder="Optional — relative path to .mcp.json" />
        <div class="form-hint">Relative to cwd. Uses <code>--additional-mcp-config</code> flag.</div>
      </div>
      <div class="form-group">
        <label class="form-checkbox">
          <input type="checkbox" id="add-durable" checked />
          <span>Durable</span>
          <span class="form-hint" style="margin:0">(auto-restart on supervisor start)</span>
        </label>
      </div>
      <div class="form-group">
        <label class="form-checkbox">
          <input type="checkbox" id="add-autoStart" checked />
          <span>Auto-start</span>
          <span class="form-hint" style="margin:0">(run immediately when enabled; uncheck for schedule-only)</span>
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-primary" onclick="submitAddAgent()">Add Agent</button>
        <button class="btn" onclick="closeAddPanel()">Cancel</button>
      </div>
      <div id="add-error" style="color:#f85149;font-size:0.8rem;margin-top:8px;display:none"></div>
    </div>
  </div>

  <script>
    async function fetchAgents() {
      const res = await fetch('/api/agents');
      return res.json();
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
      if (!finishedAt) return \`⏱ Started \${timeStr} (running…)\`;
      const durationMs = new Date(finishedAt).getTime() - start.getTime();
      let durStr;
      if (durationMs < 60000) durStr = Math.round(durationMs / 1000) + 's';
      else if (durationMs < 3600000) durStr = Math.floor(durationMs / 60000) + 'm ' + Math.round((durationMs % 60000) / 1000) + 's';
      else durStr = Math.floor(durationMs / 3600000) + 'h ' + Math.round((durationMs % 3600000) / 60000) + 'm';
      return \`🕐 \${timeStr} · ran for \${durStr}\`;
    }

    // Track which output panels are expanded
    const expandedOutputs = new Set();

    // Track collapsed groups
    const collapsedGroups = new Set();

    function renderAgents(agents) {
      // Skip re-render if user is focused on an input or schedule editor is open
      const focused = document.activeElement;
      if (focused && (focused.classList.contains('schedule-input') || focused.classList.contains('trigger-input') || focused.classList.contains('group-select'))) return;
      if (document.querySelector('.sched-editor')) return;
      // Skip if any modal/overlay is visible
      if (document.querySelector('.modal-overlay.visible, .panel-overlay.visible')) return;

      // Filter agents by name
      const filterText = (document.getElementById('agent-filter')?.value || '').toLowerCase();
      if (filterText) {
        agents = agents.filter(a => (a.config?.name || a.agent_id).toLowerCase().includes(filterText));
      }

      // Save scroll positions of expanded output divs
      const scrollPositions = new Map();
      document.querySelectorAll('.output-content.visible').forEach(el => {
        if (el.id && el.scrollTop > 0) scrollPositions.set(el.id, el.scrollTop);
      });

      // Save live output content so it's not reset by re-render
      const liveOutputCache = new Map();
      document.querySelectorAll('[id^="live-"]').forEach(el => {
        if (el.id.startsWith('live-chat-btn-')) {
          if (el.innerHTML) liveOutputCache.set(el.id, el.innerHTML);
        } else if (el.innerHTML && !el.innerHTML.includes('Waiting for agent')) {
          liveOutputCache.set(el.id, el.innerHTML);
        }
      });
      document.querySelectorAll('[id^="live-status-"]').forEach(el => {
        if (el.textContent !== 'watching...') liveOutputCache.set(el.id, el.textContent);
      });

      // Group agents
      const groups = new Map();
      agents.forEach(agent => {
        const group = agent.config?.group || 'Ungrouped';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(agent);
      });

      // Collect all known group names for the group selector
      const allGroupNames = Array.from(groups.keys());
      window._lastGroupNames = allGroupNames;

      const container = document.getElementById('agents');
      container.innerHTML = Array.from(groups.entries()).map(([groupName, groupAgents]) => {
        const isCollapsed = collapsedGroups.has(groupName);
        const statusDots = groupAgents.map(a =>
          \`<span class="status-dot dot-\${a.status || 'idle'}" title="\${a.config?.name || a.agent_id}: \${a.status || 'idle'}"></span>\`
        ).join('');
        const isUngrouped = groupName === 'Ungrouped';
        return \`
          <div class="agent-group">
            <div class="group-header" onclick="toggleGroup('\${escapeHtml(groupName)}')">
              <span class="group-toggle">\${isCollapsed ? '▸' : '▾'}</span>
              <span class="group-name">\${escapeHtml(groupName)}</span>
              <span class="group-count">(\${groupAgents.length})</span>
              <div class="group-status-dots">\${statusDots}</div>
              \${!isUngrouped ? \`
                <div class="group-actions" onclick="event.stopPropagation()">
                  <button class="btn" onclick="renameGroup('\${escapeHtml(groupName)}')" title="Rename group">✎</button>
                  <button class="btn btn-danger" onclick="deleteGroup('\${escapeHtml(groupName)}')" title="Dissolve group">✗</button>
                </div>\` : ''}
            </div>
            <div class="group-body\${isCollapsed ? ' collapsed' : ''}">
              \${groupAgents.map(agent => renderAgentCard(agent, agents, allGroupNames)).join('')}
            </div>
          </div>\`;
      }).join('');

      // Restore live output content first (before scroll restore)
      liveOutputCache.forEach((content, id) => {
        const el = document.getElementById(id);
        if (el) {
          if (id.startsWith('live-status-')) el.textContent = content;
          else el.innerHTML = content;
        }
      });

      // Restore scroll positions of output divs (including live output)
      scrollPositions.forEach((scrollTop, id) => {
        const el = document.getElementById(id);
        if (el) el.scrollTop = scrollTop;
      });
    }

    function renderAgentCard(agent, agents, allGroupNames) {
      const currentGroup = agent.config?.group || '';
      const isEnabled = agent.enabled !== 0;
      const autoStart = agent.config?.autoStart !== false;
      const groupOpts = allGroupNames.filter(g => g !== 'Ungrouped')
        .map(g => \`<option value="\${escapeHtml(g)}" \${g === currentGroup ? 'selected' : ''}>\${escapeHtml(g)}</option>\`).join('');
      return \`
        <div class="agent-card\${!isEnabled ? ' agent-disabled' : ''}">
          <div class="agent-header">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="agent-name" ondblclick="editAgentName('\${agent.agent_id}', this)" title="Double-click to rename">\${agent.config?.name || agent.agent_id}</span>
              <span style="font-size:0.65rem;padding:2px 6px;border-radius:3px;background:\${agent.config?.pluginDir ? '#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55' : '#2ea04322;color:#7ee787;border:1px solid #2ea04355'}">\${agent.config?.pluginDir ? '🔌 plugin' : '🤖 agent'}</span>
             \${agent.config?.agent && agent.config.agent !== agent.config?.name ? \`<span style="font-size:0.7rem;color:#8b949e;font-family:monospace" title="Agent identifier">\${escapeHtml(agent.config.agent)}</span>\` : ''}
           </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="status-badge status-\${agent.status || 'idle'}">\${agent.status || 'idle'}</span>
              <label class="toggle-switch" title="\${isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
                <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleEnabled('\${agent.agent_id}', this.checked)" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="agent-meta">
            <div class="meta-item" style="grid-column: span 2"><span class="meta-label">Prompt:</span> <span class="meta-value prompt-value" ondblclick="editAgentPrompt('\${agent.agent_id}', this)" title="Double-click to edit">\${escapeHtml(agent.config?.prompt || '-')}</span></div>
            <div class="meta-item"><span class="meta-label">CWD:</span> <span class="meta-value">\${agent.config?.cwd || '-'}</span></div>
            <div class="meta-item">
              <span class="meta-label">Group:</span>
              <select class="group-select" onchange="moveToGroup('\${agent.agent_id}', this.value)">
                <option value="" \${!currentGroup ? 'selected' : ''}>Ungrouped</option>
                \${groupOpts}
                <option value="__new__">+ New group…</option>
              </select>
            </div>
          </div>
          <div class="agent-actions">
            <button class="btn btn-primary" onclick="startAgent('\${agent.agent_id}')">▶ Start</button>
            <button class="btn btn-danger" onclick="stopAgent('\${agent.agent_id}')">■ Stop</button>
            <button class="btn" onclick="runNow('\${agent.agent_id}')">⚡ Run Now</button>
            <span style="border-left:1px solid #30363d;height:20px;margin:0 4px"></span>
            <button class="btn" onclick="showAgentSessions('\${escapeHtml(agent.config?.name || agent.agent_id)}')" title="View sessions for this agent">📋 Sessions</button>
            <button class="btn" onclick="openLastTerminal('\${agent.agent_id}', '\${escapeJs(agent.config?.cwd || '')}')" title="Resume last session in Copilot CLI">💻 Copilot</button>
            <button class="btn" onclick="editAgentSource('\${agent.agent_id}')" title="Open agent source in editor">✏️ Edit</button>
            <button class="btn" onclick="cloneAgent('\${agent.agent_id}')" title="Clone this agent with a new name">📋 Clone</button>
            \${agent.config?.pluginDir ? \`<button class="btn" onclick="reinstallPlugin('\${agent.agent_id}')" title="Reinstall plugin (uninstall + install)">🔄 Reinstall</button>\` : ''}
            <button class="btn btn-danger" style="margin-left:auto" onclick="deleteAgent('\${agent.agent_id}')" title="Remove agent">🗑</button>
            \${agent.isTriggerOnly ? \`
              <div style="position:relative;display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
                <span style="color:#d2a8ff;font-weight:600;font-size:0.8rem">⚡ Trigger</span>
                <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;">
                  <span style="color:#8b949e;">Last: \${timeAgo(agent.last_run)} · Exit: \${agent.lastRun?.exit_code ?? '-'}</span>
                </div>
              </div>
            \` : \`
              <div style="position:relative;display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
                <button class="btn" onclick="openScheduleEditor('\${agent.agent_id}', '\${escapeHtml(agent.schedule || '')}', this)" title="Edit schedule">🕐 Schedule</button>
                <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;">
                  <span style="color:#c9d1d9;" title="\${agent.scheduleDescription || ''}">\${agent.schedule || 'none'} <span style="color:#8b949e">(\${agent.scheduleDescription || ''})</span></span>
                  <span style="color:#8b949e;">Next: <span style="color:#58a6ff">\${isEnabled ? timeUntil(agent.next_run) : '—'}</span> · Last: \${timeAgo(agent.last_run)} · Exit: \${agent.lastRun?.exit_code ?? '-'}</span>
                  <span style="color:#8b949e;cursor:pointer;" onclick="toggleAutoStart('\${agent.agent_id}', \${autoStart})" title="Click to toggle">Auto-start: \${autoStart ? '<span style=color:#7ee787>✓ on boot</span>' : '<span style=color:#f0883e>⏱ schedule only</span>'}</span>
                </div>
              </div>
            \`}
            \${renderTriggers(agent, agents)}
          </div>
          \${agent.lastRun?.error ? \`
            <div class="output-section error-output">
              <button class="output-toggle" onclick="toggleOutput('err-\${agent.agent_id}')">\${(agent.status === 'error' || expandedOutputs.has('err-' + agent.agent_id)) ? '▾' : '▸'} Error</button>
              <pre class="output-content error-text\${(agent.status === 'error' || expandedOutputs.has('err-' + agent.agent_id)) ? ' visible' : ''}" id="output-err-\${agent.agent_id}">\${escapeHtml(agent.lastRun.error)}</pre>
            </div>
          \` : ''}
          \${(agent.status === 'running' || agent.lastRun?.output) ? \`
            <div class="output-section"\${agent.status === 'running' ? ' style="border-left:3px solid #f0883e;"' : ''}>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                \${agent.status === 'running' ? \`
                  <span class="spinner" style="width:14px;height:14px;"></span>
                  <span style="color:#f0883e;font-weight:600;font-size:0.85rem;">Latest session</span>
                  <span style="color:#8b949e;font-size:0.75rem" id="live-status-\${agent.agent_id}">watching...</span>
                \` : \`
                  <button class="output-toggle" onclick="toggleOutput('\${agent.agent_id}')">\${expandedOutputs.has(agent.agent_id) ? '▾' : '▸'} Latest session</button>
                  <span style="font-size:11px;color:#888;margin-left:4px">\${agent.lastRun?.started_at ? formatRunTimestamp(agent.lastRun.started_at, agent.lastRun.finished_at) : ''}</span>
                \`}
                <button class="output-toggle" onclick="openOutputModal('\${escapeHtml(agent.config?.name || agent.agent_id)}', '\${agent.agent_id}')" style="margin-left:8px\${agent.status === 'running' ? ';opacity:0.4;pointer-events:none' : ''}" title="Open in full view">⛶ Focus</button>
                <span id="live-chat-btn-\${agent.agent_id}">\${agent.status !== 'running' ? \`<button class="output-toggle" onclick="openLastChat('\${agent.agent_id}', '\${agent.lastRun?.session_id || ''}')" style="margin-left:0" title="Chat with this session">💬 Chat</button>\` : \`<button class="output-toggle" style="margin-left:0;opacity:0.4;pointer-events:none" title="Chat available after session completes">💬 Chat</button>\`}</span>
                <button class="output-toggle" onclick="emailOutput('\${agent.agent_id}', '\${escapeHtml(agent.config?.name || agent.agent_id)}')" style="margin-left:8px\${agent.status === 'running' ? ';opacity:0.4;pointer-events:none' : ''}" title="Email last output">✉ Email</button>
              </div>
              \${agent.status === 'running' ? \`
                <div class="output-content markdown-body visible" id="live-\${agent.agent_id}" style="margin-top:8px;max-height:400px;overflow-y:auto;opacity:0.9;">
                  <span style="color:#8b949e">Waiting for agent output...</span>
                </div>
              \` : \`
                <div class="output-content markdown-body\${expandedOutputs.has(agent.agent_id) ? ' visible' : ''}" id="output-\${agent.agent_id}">\${typeof marked !== 'undefined' ? marked.parse(agent.lastRun.output || '') : escapeHtml(agent.lastRun.output)}</div>
              \`}
            </div>
          \` : ''}
          \${agent.isTriggerOnly && agent.triggerRuns && agent.triggerRuns.length > 0 ? agent.triggerRuns.map(tr => \`
            <div class="output-section" style="margin-top:4px;\${tr.lastRun?.exit_code !== 0 && tr.lastRun ? 'border-left:3px solid #f85149;' : ''}">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <button class="output-toggle" onclick="toggleOutput('tr-\${agent.agent_id}-\${tr.sourceId}')">\${expandedOutputs.has('tr-'+agent.agent_id+'-'+tr.sourceId) ? '▾' : '▸'} From: \${escapeHtml(tr.sourceName)}</button>
                <span style="font-size:11px;color:#888;">\${tr.lastRun?.started_at ? formatRunTimestamp(tr.lastRun.started_at, tr.lastRun.finished_at) : 'never run'}</span>
                \${tr.lastRun?.exit_code != null ? \`<span style="font-size:11px;color:\${tr.lastRun.exit_code === 0 ? '#3fb950' : '#f85149'}">Exit: \${tr.lastRun.exit_code}</span>\` : ''}
                \${tr.lastRun?.session_id ? \`<button class="output-toggle" onclick="openFocus('\${tr.lastRun.session_id}')" style="margin-left:4px">⛶ Focus</button>\` : ''}
              </div>
              \${tr.lastRun?.output ? \`
                <div class="output-content markdown-body\${expandedOutputs.has('tr-'+agent.agent_id+'-'+tr.sourceId) ? ' visible' : ''}" id="output-tr-\${agent.agent_id}-\${tr.sourceId}">\${typeof marked !== 'undefined' ? marked.parse(tr.lastRun.output || '') : escapeHtml(tr.lastRun.output)}</div>
              \` : ''}
            </div>
          \`).join('') : ''}
        </div>\`;
    }

    function renderTriggers(agent, allAgents) {
      const triggers = agent.config?.triggers || {};
      const agentName = (id) => {
        const a = allAgents.find(a => a.agent_id === id);
        return a?.config?.name || id;
      };
      const badges = [];
      const renderList = (ids, cls, icon) => {
        const list = Array.isArray(ids) ? ids : [ids];
        list.forEach(id => badges.push(\`<span class="trigger-badge \${cls}">\${icon} <span class="trigger-arrow">→</span> \${agentName(id)}</span>\`));
      };
      if (triggers.onSuccess) renderList(triggers.onSuccess, 'trigger-success', '✓');
      if (triggers.onFailure) renderList(triggers.onFailure, 'trigger-failure', '✗');
      if (triggers.onComplete) renderList(triggers.onComplete, 'trigger-complete', '●');

      const agentOpts = allAgents.filter(a => a.agent_id !== agent.agent_id)
        .map(a => \`<option value="\${a.agent_id}">\${a.config?.name || a.agent_id}</option>\`).join('');

      const editId = 'triggers-edit-' + agent.agent_id;
      const isEditing = expandedOutputs.has(editId);

      const currentSuccess = (Array.isArray(triggers.onSuccess) ? triggers.onSuccess : triggers.onSuccess ? [triggers.onSuccess] : []).join(', ');
      const currentFailure = (Array.isArray(triggers.onFailure) ? triggers.onFailure : triggers.onFailure ? [triggers.onFailure] : []).join(', ');
      const currentComplete = (Array.isArray(triggers.onComplete) ? triggers.onComplete : triggers.onComplete ? [triggers.onComplete] : []).join(', ');

      return \`
        <div style="display:inline-flex;flex-direction:column;position:relative;">
        <div class="triggers-section">
          <span class="trigger-label">Triggers:</span>
          \${badges.length > 0 ? badges.join('') : '<span style="color:#8b949e;font-size:0.75rem">none</span>'}
          <button class="btn" style="padding:2px 8px;font-size:0.7rem" onclick="toggleOutput('\${editId}')">✎ Edit</button>
        </div>
        <div class="trigger-editor\${isEditing ? ' visible' : ''}" id="output-\${editId}" style="position:absolute;top:100%;left:0;z-index:50;min-width:340px;">
          <div class="trigger-row">
            <span class="trigger-badge trigger-success" style="min-width:70px">✓ Success</span>
            <select class="trigger-input" id="trig-success-\${agent.agent_id}" multiple>
              \${allAgents.filter(a => a.agent_id !== agent.agent_id).map(a =>
                \`<option value="\${a.agent_id}" \${currentSuccess.includes(a.agent_id) ? 'selected' : ''}>\${a.config?.name || a.agent_id}</option>\`
              ).join('')}
            </select>
          </div>
          <div class="trigger-row">
            <span class="trigger-badge trigger-failure" style="min-width:70px">✗ Failure</span>
            <select class="trigger-input" id="trig-failure-\${agent.agent_id}" multiple>
              \${allAgents.filter(a => a.agent_id !== agent.agent_id).map(a =>
                \`<option value="\${a.agent_id}" \${currentFailure.includes(a.agent_id) ? 'selected' : ''}>\${a.config?.name || a.agent_id}</option>\`
              ).join('')}
            </select>
          </div>
          <div class="trigger-row">
            <span class="trigger-badge trigger-complete" style="min-width:70px">● Always</span>
            <select class="trigger-input" id="trig-complete-\${agent.agent_id}" multiple>
              \${allAgents.filter(a => a.agent_id !== agent.agent_id).map(a =>
                \`<option value="\${a.agent_id}" \${currentComplete.includes(a.agent_id) ? 'selected' : ''}>\${a.config?.name || a.agent_id}</option>\`
              ).join('')}
            </select>
          </div>
          <button class="btn btn-primary" style="margin-top:6px" onclick="saveTriggers('\${agent.agent_id}')">Save</button>
          <button class="btn btn-danger" style="margin-top:6px" onclick="clearTriggers('\${agent.agent_id}')">Clear All</button>
        </div>
        </div>\`;
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escapeJs(str) {
      return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }

    function editAgentName(id, el) {
      const current = el.textContent;
      const input = document.createElement('input');
      input.className = 'schedule-input';
      input.style.fontSize = '1.1rem';
      input.style.fontWeight = 'bold';
      input.value = current;
      el.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        const newName = input.value.trim();
        if (newName && newName !== current) {
          await fetch(\`/api/agents/\${id}/name\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: newName }) });
        }
        refresh();
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
    }

    function editAgentPrompt(id, el) {
      const current = el.textContent;
      const container = document.createElement('div');
      container.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;';
      const textarea = document.createElement('textarea');
      textarea.className = 'schedule-input';
      textarea.style.cssText = 'width:100%;min-height:60px;resize:vertical;font-family:inherit;font-size:inherit;';
      textarea.value = current === '-' ? '' : current;
      
      // Help hint for template variables
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#888;line-height:1.4;background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px 8px;';
      hint.innerHTML = \`<strong style="color:#aaa">Template variables</strong> (available when triggered by another agent):<br>
<code style="color:#7ec8e3">\{{ trigger.output }}</code> — output from triggering agent<br>
<code style="color:#7ec8e3">\{{ trigger.name }}</code> — name &nbsp;|&nbsp; <code style="color:#7ec8e3">\{{ trigger.exitCode }}</code> — exit code<br>
<code style="color:#7ec8e3">\{{ trigger.startedAt }}</code> / <code style="color:#7ec8e3">\{{ trigger.finishedAt }}</code> — timestamps<br>
<code style="color:#7ec8e3">\{{ chain[0].output }}</code> — output from earlier chain step (0-indexed)<br>
<span style="color:#666">Unresolved variables are left as-is. Press Enter to save, Esc to cancel.</span>\`;
      
      container.appendChild(textarea);
      container.appendChild(hint);
      el.replaceWith(container);
      textarea.focus();
      textarea.select();
      const save = async () => {
        const newPrompt = textarea.value.trim();
        if (newPrompt && newPrompt !== current) {
          await fetch(\`/api/agents/\${id}/prompt\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt: newPrompt }) });
        }
        refresh();
      };
      textarea.addEventListener('blur', save);
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
        if (e.key === 'Escape') { textarea.value = current; textarea.blur(); }
      });
    }

    async function startAgent(id) { await fetch(\`/api/agents/\${id}/start\`, { method: 'POST' }); refresh(); }
    async function stopAgent(id) { await fetch(\`/api/agents/\${id}/stop\`, { method: 'POST' }); refresh(); }
    async function runNow(id) { await fetch(\`/api/agents/\${id}/run\`, { method: 'POST' }); refresh(); }
    async function openInCode() { await fetch('/api/open-editor', { method: 'POST' }); }
    function importConfig() { document.getElementById('importFileInput').click(); }
    async function handleImportFile(input) {
      const file = input.files[0];
      if (!file) { alert('No file selected'); return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/import', { method: 'POST', body: formData });
        if (!res.ok) { alert('Import request failed: HTTP ' + res.status); return; }
        const result = await res.json();
        let msg = '';
        if (result.imported?.length) msg += '✅ Imported:\\n' + result.imported.join('\\n') + '\\n\\n';
        if (result.warnings?.length) msg += '⚠️ Warnings:\\n' + result.warnings.join('\\n') + '\\n\\n';
        if (result.errors?.length) msg += '❌ Errors:\\n' + result.errors.join('\\n');
        alert(msg || 'Import complete (no details returned)');
        refresh();
      } catch (e) {
        alert('Import failed: ' + e.message);
      }
      input.value = '';
    }
    async function toggleEnabled(id, enabled) {
      await fetch(\`/api/agents/\${id}/enabled\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) });
      refresh();
    }
    async function toggleAutoStart(id, current) {
      const newVal = !current;
      await fetch(\`/api/agents/\${id}/autostart\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ autoStart: newVal }) });
      refresh();
    }
    async function updateSchedule(id) {
      const val = document.getElementById('sched-' + id)?.value;
      if (val) {
        await fetch(\`/api/agents/\${id}/schedule\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schedule: val}) });
        refresh();
      }
    }

    function openScheduleEditor(agentId, currentSchedule, btnEl) {
      document.querySelectorAll('.sched-editor').forEach(e => e.remove());
      const editor = document.createElement('div');
      editor.className = 'sched-editor visible';
      editor.innerHTML = \`
        <label>Schedule type</label>
        <div class="sched-mode-row">
          <select id="sched-mode" onchange="schedModeChanged()">
            <option value="interval">Interval (every N minutes/hours)</option>
            <option value="daily">Daily (at a specific time)</option>
            <option value="weekly">Weekly (pick days + time)</option>
            <option value="cron">Advanced (cron / free text)</option>
          </select>
        </div>
        <div class="sched-fields" id="sched-fields"></div>
        <div class="sched-preview" id="sched-preview">—</div>
        <div class="sched-actions">
          <button class="btn btn-primary" onclick="saveScheduleEditor('\${agentId}')">Save</button>
          <button class="btn" onclick="closeScheduleEditor()">Cancel</button>
        </div>
      \`;
      btnEl.parentElement.appendChild(editor);
      editor.dataset.agentId = agentId;
      editor.dataset.current = currentSchedule;
      detectScheduleMode(currentSchedule);
      setTimeout(() => document.addEventListener('click', schedEditorOutsideClick), 10);
    }

    function schedEditorOutsideClick(e) {
      const editor = document.querySelector('.sched-editor');
      if (!editor) return;
      // Don't close if click is inside editor or on editor-related elements
      if (editor.contains(e.target)) return;
      if (e.target.closest('[onclick*="openScheduleEditor"]')) return;
      if (e.target.closest('.sched-editor')) return;
      // Don't close if a select dropdown is active (native dropdowns fire clicks on document)
      if (e.target.tagName === 'OPTION' || e.target.tagName === 'SELECT') return;
      // Small delay to avoid race with native dropdown close events
      setTimeout(() => {
        if (document.querySelector('.sched-editor')) closeScheduleEditor();
      }, 50);
    }

    function closeScheduleEditor() {
      document.querySelectorAll('.sched-editor').forEach(e => e.remove());
      document.removeEventListener('click', schedEditorOutsideClick);
    }

    function detectScheduleMode(schedule) {
      const mode = document.getElementById('sched-mode');
      if (!schedule) { mode.value = 'interval'; schedModeChanged(); return; }
      if (/^\\d+[mh]$/.test(schedule) || /^every\\s+\\d+\\s*(min|hour|sec)/i.test(schedule)) mode.value = 'interval';
      else if (/weekday|M,T|mon|tue|wed|thu|fri|sat|sun/i.test(schedule)) mode.value = 'weekly';
      else if (/daily|^at\\s+\\d/i.test(schedule)) mode.value = 'daily';
      else mode.value = 'cron';
      schedModeChanged(schedule);
    }

    function schedModeChanged(prefill) {
      const mode = document.getElementById('sched-mode').value;
      const fields = document.getElementById('sched-fields');
      const editor = document.querySelector('.sched-editor');
      const current = prefill || editor?.dataset.current || '';

      if (mode === 'interval') {
        let num = 1, unit = 'h';
        const m = current.match(/(\\d+)\\s*([mh])/);
        if (m) { num = parseInt(m[1]); unit = m[2]; }
        else { const m2 = current.match(/every\\s+(\\d+)\\s*(min|hour)/i); if (m2) { num = parseInt(m2[1]); unit = m2[2].startsWith('h') ? 'h' : 'm'; } }
        fields.innerHTML = \`<div style="display:flex;gap:8px;align-items:center">
          <label style="margin:0">Every</label>
          <input type="number" id="sched-interval-num" value="\${num}" min="1" max="720" style="width:60px" oninput="previewSchedule()">
          <select id="sched-interval-unit" onchange="previewSchedule()">
            <option value="m" \${unit==='m'?'selected':''}>minutes</option>
            <option value="h" \${unit==='h'?'selected':''}>hours</option>
          </select>
        </div>\`;
      } else if (mode === 'daily') {
        let time = '09:00';
        const m = current.match(/(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?/i);
        if (m) { let h = parseInt(m[1]); const min = m[2]||'00'; if(m[3]?.toLowerCase()==='pm'&&h<12)h+=12; if(m[3]?.toLowerCase()==='am'&&h===12)h=0; time = String(h).padStart(2,'0')+':'+min; }
        fields.innerHTML = \`<div style="display:flex;gap:8px;align-items:center">
          <label style="margin:0">At</label>
          <input type="time" id="sched-daily-time" value="\${time}" onchange="previewSchedule()">
          <span style="color:#8b949e;font-size:0.8rem">every day</span>
        </div>\`;
      } else if (mode === 'weekly') {
        const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
        const dayKeys = ['mon','tue','wed','thu','fri','sat','sun'];
        let checkedDays = new Set();
        if (/weekday/i.test(current)) checkedDays = new Set(['mon','tue','wed','thu','fri']);
        else { for (let i=0;i<dayKeys.length;i++) { if(new RegExp(dayKeys[i],'i').test(current)) checkedDays.add(dayKeys[i]); } }
        if (checkedDays.size===0) checkedDays = new Set(['mon','tue','wed','thu','fri']);
        let time = '09:00';
        const m = current.match(/(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?/i);
        if (m) { let h=parseInt(m[1]); const min=m[2]||'00'; if(m[3]?.toLowerCase()==='pm'&&h<12)h+=12; if(m[3]?.toLowerCase()==='am'&&h===12)h=0; time=String(h).padStart(2,'0')+':'+min; }
        fields.innerHTML = \`<div class="day-checkboxes">
          \${days.map((d,i) => \`<label><input type="checkbox" value="\${dayKeys[i]}" \${checkedDays.has(dayKeys[i])?'checked':''} onchange="previewSchedule()"> \${d}</label>\`).join('')}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="margin:0">At</label>
          <input type="time" id="sched-weekly-time" value="\${time}" onchange="previewSchedule()">
        </div>\`;
      } else {
        fields.innerHTML = \`<div style="display:flex;flex-direction:column;gap:4px">
          <label style="margin:0">Cron expression or free text</label>
          <input type="text" class="schedule-input" style="width:100%" id="sched-cron-input" value="\${current.replace(/"/g,'&quot;')}" oninput="previewSchedule()" placeholder="e.g. 0 9 * * 1-5 or weekdays at 9am">
          <span style="color:#8b949e;font-size:0.7rem">Examples: 0 */2 * * * (every 2h) | weekdays at 9am | every 30 minutes</span>
        </div>\`;
      }
      previewSchedule();
    }

    function getScheduleValue() {
      const mode = document.getElementById('sched-mode').value;
      if (mode === 'interval') {
        const num = document.getElementById('sched-interval-num')?.value || '1';
        const unit = document.getElementById('sched-interval-unit')?.value || 'h';
        return num + unit;
      } else if (mode === 'daily') {
        const time = document.getElementById('sched-daily-time')?.value || '09:00';
        const [h, m] = time.split(':').map(Number);
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return \`daily at \${h12}\${m > 0 ? ':' + String(m).padStart(2,'0') : ''}\${ampm}\`;
      } else if (mode === 'weekly') {
        const checked = Array.from(document.querySelectorAll('.day-checkboxes input:checked')).map(c => c.value);
        if (checked.length === 0) return '';
        const time = document.getElementById('sched-weekly-time')?.value || '09:00';
        const [h, min] = time.split(':').map(Number);
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        const timeStr = \`\${h12}\${min > 0 ? ':' + String(min).padStart(2,'0') : ''}\${ampm}\`;
        if (checked.length === 5 && !checked.includes('sat') && !checked.includes('sun')) return \`weekdays at \${timeStr}\`;
        const dayMap = {mon:'M',tue:'T',wed:'W',thu:'Th',fri:'F',sat:'Sa',sun:'Su'};
        return checked.map(d => dayMap[d]).join(',') + ' at ' + timeStr;
      } else {
        return document.getElementById('sched-cron-input')?.value || '';
      }
    }

    async function previewSchedule() {
      const val = getScheduleValue();
      const preview = document.getElementById('sched-preview');
      if (!val) { preview.textContent = '—'; preview.style.color = '#8b949e'; return; }
      try {
        const res = await fetch('/api/schedule/describe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schedule: val}) });
        const data = await res.json();
        if (data.error) { preview.textContent = '⚠ ' + data.error; preview.style.color = '#f85149'; }
        else { preview.textContent = '✓ ' + (data.description || val); preview.style.color = '#7ee787'; }
      } catch { preview.textContent = val; preview.style.color = '#c9d1d9'; }
    }

    async function saveScheduleEditor(agentId) {
      const val = getScheduleValue();
      if (!val) return;
      await fetch(\`/api/agents/\${agentId}/schedule\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schedule: val}) });
      closeScheduleEditor();
      refresh();
    }

    async function saveTriggers(id) {
      const getSelected = (elId) => Array.from(document.getElementById(elId).selectedOptions).map(o => o.value);
      const onSuccess = getSelected('trig-success-' + id);
      const onFailure = getSelected('trig-failure-' + id);
      const onComplete = getSelected('trig-complete-' + id);
      const triggers = {};
      if (onSuccess.length) triggers.onSuccess = onSuccess;
      if (onFailure.length) triggers.onFailure = onFailure;
      if (onComplete.length) triggers.onComplete = onComplete;
      // If triggers are being set, switch to trigger mode (schedule=never)
      if (Object.keys(triggers).length > 0) {
        await fetch(\`/api/agents/\${id}/schedule\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schedule: 'never'}) });
      }
      await fetch(\`/api/agents/\${id}/triggers\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({triggers}) });
      expandedOutputs.delete('triggers-edit-' + id);
      refresh();
    }
    async function clearTriggers(id) {
      await fetch(\`/api/agents/\${id}/triggers\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({triggers: {}}) });
      expandedOutputs.delete('triggers-edit-' + id);
      refresh();
    }
    async function moveToGroup(agentId, group) {
      if (group === '__new__') {
        const name = prompt('New group name:');
        if (!name) { document.activeElement?.blur(); refresh(); return; }
        group = name.trim();
      }
      document.activeElement?.blur();
      await fetch(\`/api/agents/\${agentId}/group\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ group: group || null }) });
      refresh();
    }
    async function renameGroup(oldName) {
      const newName = prompt('Rename group "' + oldName + '" to:', oldName);
      if (!newName || newName === oldName) return;
      await fetch('/api/groups/rename', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ oldName, newName: newName.trim() }) });
      collapsedGroups.delete(oldName);
      refresh();
    }
    async function deleteGroup(name) {
      if (!confirm('Dissolve group "' + name + '"? Agents will move to Ungrouped.')) return;
      await fetch(\`/api/groups/\${encodeURIComponent(name)}\`, { method: 'DELETE' });
      collapsedGroups.delete(name);
      refresh();
    }

    async function emailOutput(agentId, agentName) {
      const res = await fetch(\`/api/agents/\${agentId}/email\`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to compose email');
      }
    }
    function toggleOutput(id) {
      if (expandedOutputs.has(id)) {
        expandedOutputs.delete(id);
      } else {
        expandedOutputs.add(id);
      }
      document.getElementById('output-' + id).classList.toggle('visible');
    }

    function openOutputModal(name, agentId) {
      const el = document.getElementById('output-' + agentId);
      const content = el ? el.innerHTML : '';
      document.getElementById('outputModalTitle').textContent = name + ' — Last Output';
      document.getElementById('outputModalBody').innerHTML = content;
      document.getElementById('outputModal').style.display = 'flex';
      document.getElementById('outputModalOverlay').classList.add('visible');
    }
    function closeOutputModal() {
      document.getElementById('outputModal').style.display = 'none';
      document.getElementById('outputModalOverlay').classList.remove('visible');
    }
    function toggleGroup(name) {
      if (collapsedGroups.has(name)) {
        collapsedGroups.delete(name);
      } else {
        collapsedGroups.add(name);
      }
      refresh();
    }

    function expandAllGroups() {
      collapsedGroups.clear();
      refresh();
    }

    function collapseAllGroups() {
      document.querySelectorAll('.group-header').forEach(h => {
        const name = h.textContent.replace(/[▾▸]/, '').trim().replace(/\s*\(\d+\)$/, '');
        collapsedGroups.add(name);
      });
      // Also add from last known groups
      if (window._lastGroupNames) window._lastGroupNames.forEach(n => collapsedGroups.add(n));
      refresh();
    }

    // ---- Add Agent Panel ----
    function openAddPanel() {
      document.getElementById('panelOverlay').classList.add('visible');
      document.getElementById('addPanel').classList.add('visible');
      loadRecentDirs();
    }
    function cloneAgent(agentId) {
      const agent = window._lastAgents?.find(a => a.agent_id === agentId);
      if (!agent?.config) return;
      const c = agent.config;
      openAddPanel();
      // Switch to manual tab
      const manualTab = document.querySelector('.panel-tab[onclick*="manual"]');
      if (manualTab) manualTab.click();
      // Pre-fill all fields from the source agent
      document.getElementById('add-id').value = '';
      document.getElementById('add-name').value = (c.name || '') + ' (copy)';
      document.getElementById('add-agent').value = c.agent || '';
      document.getElementById('add-cwd').value = c.cwd || '';
      document.getElementById('add-prompt').value = c.prompt || '';
      document.getElementById('add-schedule').value = c.schedule || '1h';
      document.getElementById('add-group').value = c.group || '';
      document.getElementById('add-copilotPath').value = c.copilotPath || '';
      document.getElementById('add-pluginDir').value = c.pluginDir || '';
      document.getElementById('add-mcpConfig').value = c.mcpConfig || '';
      document.getElementById('add-durable').checked = c.durable !== false;
      // Focus the name field so user can rename immediately
      document.getElementById('add-name').focus();
      document.getElementById('add-name').select();
    }
    function closeAddPanel() {
      document.getElementById('panelOverlay').classList.remove('visible');
      document.getElementById('addPanel').classList.remove('visible');
    }
    function switchTab(tab, btn) {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
    }

    async function browseFolder() {
      const res = await fetch('/api/browse-folder', { method: 'POST' });
      const data = await res.json();
      if (data.folder) {
        document.getElementById('scanDir').value = data.folder;
      }
    }

    async function loadRecentDirs() {
      try {
        const res = await fetch('/api/recent-dirs');
        const dirs = await res.json();
        const container = document.getElementById('recentDirs');
        container.innerHTML = dirs.map(d =>
          \`<button class="btn" style="font-size:0.7rem;padding:2px 8px" onclick="document.getElementById('scanDir').value='\${d.replace(/\\\\/g, '\\\\\\\\')}'">📁 \${d.split('\\\\').pop()}</button>\`
        ).join('');
      } catch {}
    }

    async function runDiscover() {
      const dir = document.getElementById('scanDir').value.trim();
      const list = document.getElementById('discoverList');
      list.innerHTML = '<span style="color:#8b949e">Scanning…</span>';
      try {
        const params = dir ? '?dirs=' + encodeURIComponent(dir) : '';
        const res = await fetch('/api/discover' + params);
        const data = await res.json();
        if (data.discovered.length === 0) {
          list.innerHTML = '<span style="color:#8b949e">No agents discovered. Try specifying a directory with copilot agents/plugins.</span>';
          return;
        }
        list.innerHTML = data.discovered.map(d => {
          const sourceLabel = {'installed-plugin':'installed','marketplace':'marketplace','repo-agent':'agent','repo-plugin':'local plugin'}[d.source] || d.source;
          const sourceClass = {'installed-plugin':'source-plugin','marketplace':'source-marketplace','repo-agent':'source-repo-agent','repo-plugin':'source-local-plugin'}[d.source] || 'source-plugin';
          const canInstall = !d.installed && d.installCmd;
          return \`
          <div class="discover-item \${d.registered ? 'registered' : ''}">
            <div class="discover-info">
              <div>
                <span class="discover-name">\${escapeHtml(d.displayName || d.name)}</span>
                <span class="source-badge \${sourceClass}">\${sourceLabel}</span>
                \${d.version ? \`<span style="color:#8b949e;font-size:0.7rem">v\${d.version}</span>\` : ''}
                \${d.repoName ? \`<span style="color:#8b949e;font-size:0.7rem">in \${escapeHtml(d.repoName)}</span>\` : ''}
              </div>
              \${d.description ? \`<div class="discover-desc">\${escapeHtml(d.description)}</div>\` : ''}
              \${d.cwd ? \`<div class="discover-meta">📁 \${escapeHtml(d.cwd)}</div>\` : ''}
              \${d.author ? \`<div class="discover-meta">👤 \${escapeHtml(d.author)}</div>\` : ''}
            </div>
            <div class="discover-actions" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
              \${d.registered
                ? '<span style="color:#3fb950;font-size:0.8rem">✓ Added</span>'
                : \`<button class="btn btn-primary" onclick='prefillFromDiscover(\${JSON.stringify(d).replace(/'/g,"&#39;")})'>+ Add</button>\`}
              \${canInstall
                ? \`<button class="btn" onclick='installPlugin(\${JSON.stringify(d.installCmd)}, null, null, this)'>📦 Install</button>\`
                : ''}
              \${d.pluginDir && !d.installed
                ? \`<button class="btn btn-primary" onclick='installPlugin(null, \${JSON.stringify(d.pluginDir)}, "overlay", this)' title="Install as supervisor-managed overlay (recommended)">🔧 Install Overlay</button>
                   <button class="btn" style="background:#1f6feb22;border-color:#58a6ff44;color:#58a6ff" onclick='installPlugin(null, \${JSON.stringify(d.pluginDir)}, "copilot-local", this)' title="Register in Copilot via junction + config.json">📦 Copilot Registry</button>
                   <button class="btn" style="background:#1f6feb22;border-color:#58a6ff44;color:#58a6ff" onclick='installPlugin(null, \${JSON.stringify(d.pluginDir)}, "agency", this)' title="Install via Agency registry">⚡ Agency</button>\`
                : ''}
              \${d.installed === false && !d.installCmd && !d.pluginDir
                ? '<span style="color:#f0883e;font-size:0.7rem">not installed</span>'
                : ''}
            </div>
          </div>\`;
        }).join('');
      } catch (e) {
        list.innerHTML = '<span style="color:#f85149">Error: ' + escapeHtml(e.message) + '</span>';
      }
    }

    function prefillFromDiscover(d) {
      switchTab('manual', document.querySelectorAll('.panel-tab')[1]);
      document.getElementById('add-id').value = d.id || '';
      document.getElementById('add-name').value = d.displayName || d.name || '';
      // For plugins, use plugin-id:agent-id format for the agent name
      const agentName = d.source === 'repo-plugin' || d.source === 'installed-plugin'
        ? (d.id + ':' + d.id) : (d.displayName || d.name || '');
      document.getElementById('add-agent').value = agentName;
      document.getElementById('add-cwd').value = d.cwd || '';
      document.getElementById('add-prompt').value = '';
      document.getElementById('add-schedule').value = '1h';
      document.getElementById('add-group').value = '';
      document.getElementById('add-copilotPath').value = '';
      document.getElementById('add-pluginDir').value = d.pluginDir || '';
      document.getElementById('add-mcpConfig').value = d.mcpConfig || '';
      document.getElementById('add-durable').checked = true;
      document.getElementById('add-prompt').focus();
    }

    async function installPlugin(installCmd, pluginDir, engine, btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Installing…';
      try {
        const body = {};
        if (installCmd) body.installCmd = installCmd;
        if (pluginDir) body.pluginDir = pluginDir;
        if (engine) body.engine = engine;
        const res = await fetch('/api/plugins/install', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Install failed');
          btn.textContent = engine === 'agency' ? '⚡ Install via Agency' : '📦 Install';
          btn.disabled = false;
          return false;
        }
        btn.textContent = '✓ Installed';
        btn.classList.add('btn-primary');
        setTimeout(() => runDiscover(), 1000);
        return true;
      } catch (e) {
        btn.textContent = '✗ Failed';
        btn.title = e.message;
        btn.disabled = false;
        setTimeout(() => { btn.textContent = engine === 'agency' ? '⚡ Install via Agency' : '📦 Install'; }, 3000);
        return false;
      }
    }

    async function installAndAdd(d, btn) {
      const ok = await installPlugin(null, d.pluginDir, 'agency', btn);
      if (ok) {
        // Auto-switch to Manual tab pre-filled
        prefillFromDiscover(d);
      }
    }

    async function submitAddAgent() {
      const errEl = document.getElementById('add-error');
      errEl.style.display = 'none';
      const config = {
        id: document.getElementById('add-id').value.trim(),
        name: document.getElementById('add-name').value.trim(),
        agent: document.getElementById('add-agent').value.trim(),
        cwd: document.getElementById('add-cwd').value.trim(),
        prompt: document.getElementById('add-prompt').value.trim(),
        schedule: document.getElementById('add-schedule').value.trim(),
        durable: document.getElementById('add-durable').checked
      };
      if (!document.getElementById('add-autoStart').checked) config.autoStart = false;
      const group = document.getElementById('add-group').value.trim();
      const copilotPath = document.getElementById('add-copilotPath').value.trim();
      const pluginDir = document.getElementById('add-pluginDir').value.trim();
      const mcpConfig = document.getElementById('add-mcpConfig').value.trim();
      if (group) config.group = group;
      if (copilotPath) config.copilotPath = copilotPath;
      if (pluginDir) config.pluginDir = pluginDir;
      if (mcpConfig) config.mcpConfig = mcpConfig;

      if (!config.id || !config.name || !config.agent || !config.cwd || !config.prompt || !config.schedule) {
        errEl.textContent = 'All required fields (*) must be filled.';
        errEl.style.display = 'block';
        return;
      }
      try {
        const res = await fetch('/api/agents', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add agent');
        closeAddPanel();
        refresh();
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    }

    async function deleteAgent(id) {
      if (!confirm('Delete agent "' + id + '"? This cannot be undone.')) return;
      await fetch(\`/api/agents/\${id}\`, { method: 'DELETE' });
      refresh();
    }

    async function refresh() {
      const agents = await fetchAgents();
      window._lastAgents = agents;
      renderAgents(agents);
    }

    // ---- Sessions Panel ----
    let allSessions = [];

    function openSessionsPanel() {
      document.getElementById('sessionsOverlay').classList.add('visible');
      document.getElementById('sessionsPanel').classList.add('visible');
      loadSessions();
    }
    function closeSessionsPanel() {
      document.getElementById('sessionsOverlay').classList.remove('visible');
      document.getElementById('sessionsPanel').classList.remove('visible');
    }

    async function loadSessions() {
      const hours = document.getElementById('sessionHours').value;
      const list = document.getElementById('sessionsList');
      list.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px">Loading sessions...</div>';
      try {
        const res = await fetch(\`/api/sessions?hours=\${hours}\`);
        allSessions = await res.json();
        renderSessions();
      } catch (e) {
        list.innerHTML = '<div style="color:#f85149;padding:12px">Failed to load sessions</div>';
      }
    }

    function filterSessions() {
      renderSessions();
    }

    const sessionGroupState = JSON.parse(localStorage.getItem('sessionGroupState') || '{}'); // track collapsed state per group

    function renderSessions() {
      const filter = (document.getElementById('sessionFilter').value || '').toLowerCase();
      const filtered = filter
        ? allSessions.filter(s => (s.agentName || s.name || '').toLowerCase().includes(filter) || s.name.toLowerCase().includes(filter) || s.repository.toLowerCase().includes(filter) || s.cwd.toLowerCase().includes(filter))
        : allSessions;
      const list = document.getElementById('sessionsList');
      if (filtered.length === 0) {
        list.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px">No sessions found</div>';
        return;
      }

      // Group by agent name (from subagent.selected), fall back to repo name
      const groups = {};
      for (const s of filtered) {
        const key = s.agentName || path_basename(s.cwd) || '(unknown)';
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      }

      let html = '';
      for (const [groupName, sessions] of Object.entries(groups)) {
        const collapsed = sessionGroupState[groupName] !== false;
        const latestTime = new Date(sessions[0].lastModified);
        const timeStr = latestTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = latestTime.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const repoShort = sessions[0].repository ? sessions[0].repository.split('/').pop() : path_basename(sessions[0].cwd);

        html += \`
          <div class="session-group" style="margin-bottom:12px">
            <div class="group-header" onclick="toggleSessionGroup('\${esc(groupName)}')" style="padding:8px 12px">
              <span class="group-toggle">\${collapsed ? '▶' : '▼'}</span>
              <span class="group-name" style="font-size:0.9rem">\${esc(groupName)}</span>
              <span class="group-count" style="margin-left:8px">\${sessions.length} session\${sessions.length !== 1 ? 's' : ''}</span>
              <span style="margin-left:auto;font-size:0.75rem;color:#8b949e">📁 \${repoShort} · \${dateStr} \${timeStr}</span>
            </div>
            <div class="group-body\${collapsed ? ' collapsed' : ''}" style="margin-top:6px;padding-left:0">\`;

        for (const s of sessions) {
          const time = new Date(s.lastModified);
          const sTimeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const sDateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
          const preview = (s.lastResult || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 200);
          const promptLabel = esc(s.name || '(no prompt)');
          html += \`
              <div class="session-card" id="session-\${s.id}" onclick="toggleSession('\${s.id}')">
                <div class="session-header">
                  <div>
                    <span style="font-size:0.8rem;color:#c9d1d9">\${sDateStr} \${sTimeStr}</span>
                    <span style="font-size:0.8rem;color:#8b949e;margin-left:8px">— \${promptLabel}</span>
                  </div>
                  <div style="font-size:0.75rem;color:#8b949e">
                    💬 \${s.turnCount} turn\${s.turnCount !== 1 ? 's' : ''}
                    <span style="margin-left:8px">🔑 \${s.id.substring(0,8)}</span>
                  </div>
                </div>
                \${preview ? \`<div class="session-preview">\${preview}</div>\` : ''}
                <div class="session-detail" id="detail-\${s.id}" onclick="event.stopPropagation()">
                  <div style="color:#8b949e;font-size:0.8rem;padding:8px">Loading conversation...</div>
                </div>
              </div>\`;
        }

        html += \`
            </div>
          </div>\`;
      }
      list.innerHTML = html;
    }

    function toggleSessionGroup(name) {
      sessionGroupState[name] = !sessionGroupState[name];
      localStorage.setItem('sessionGroupState', JSON.stringify(sessionGroupState));
      renderSessions();
    }

    function esc(s) { return (s||'').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function path_basename(p) { return (p||'').split(/[\\\\/]/).pop(); }
    function renderMd(s) {
      if (typeof marked !== 'undefined' && marked.parse) {
        try { return marked.parse(s || ''); } catch { }
      }
      return esc(s);
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
        const added = stats.linesAdded || 0, removed = stats.linesRemoved || 0;
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
          // Intermediate agent comment
          html += '<div class="tool-step" style="border-left:2px solid #58a6ff;background:#161b22;">' +
            '<div style="font-size:0.7rem;color:#58a6ff;margin-bottom:2px;">💭 Agent</div>' +
            '<div class="conv-content assistant-content" style="font-size:0.75rem;padding-left:6px;border:none;">' + renderMd(step.content) + '</div>' +
            '</div>';
          continue;
        }
        const statusClass = step.type === 'tool_start' ? 'pending' : (step.success !== false ? 'success' : 'failed');
        const icon = step.type === 'tool_start' ? '⏳' : (step.success !== false ? '✓' : '✗');
        const desc = step.args?.description || step.args?.command || step.args?.pattern || step.args?.path || step.args?.query || '';
        const stepId = 'step-' + Math.random().toString(36).slice(2, 8);
        html += '<div class="tool-step ' + statusClass + '">' +
          '<div class="tool-step-header" onclick="document.getElementById(\\\'' + stepId + '\\\').classList.toggle(\\\'visible\\\')">' +
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

    function buildConvoHtml(turns, containerId, showSteps, sessionMeta, tokenStats) {
      if (!turns || turns.length === 0) return '<div style="color:#8b949e;font-size:0.8rem;padding:8px">No conversation data</div>';
      let html = '<div class="session-conversation" id="' + containerId + '">';
      if (showSteps && sessionMeta) html += renderSessionMetaBanner(sessionMeta);
      for (const turn of turns) {
        html += '<div class="conv-turn">' +
          '<div class="conv-role user">👤 You</div>' +
          '<div class="conv-content">' + esc(turn.content) + '</div></div>';
        if (showSteps && turn.steps && turn.steps.length > 0) {
          html += renderStepsHtml(turn.steps);
        }
        if (turn.assistant) {
          html += '<div class="conv-turn">' +
            '<div class="conv-role assistant">🤖 Agent' + (showSteps ? renderModelBadge(turn.model) : '') + '</div>' +
            '<div class="conv-content assistant-content">' + renderMd(turn.assistant) + '</div></div>';
        }
      }
      if (showSteps && tokenStats) html += renderTokenStats(tokenStats);
      html += '</div>';
      return html;
    }

    async function toggleSession(id) {
      const card = document.getElementById(\`session-\${id}\`);
      const detail = document.getElementById(\`detail-\${id}\`);
      if (card.classList.contains('expanded')) {
        card.classList.remove('expanded');
        return;
      }
      document.querySelectorAll('.session-card.expanded').forEach(c => c.classList.remove('expanded'));
      card.classList.add('expanded');

      detail.innerHTML = '<div style="color:#8b949e;font-size:0.8rem;padding:8px">Loading conversation...</div>';
      try {
        const res = await fetch(\`/api/sessions/\${id}\`);
        const data = await res.json();
        renderSessionDetail(id, data);
      } catch (e) {
        detail.innerHTML = '<div style="color:#f85149;padding:8px">Failed to load session</div>';
      }
    }

    function renderSessionDetail(id, data) {
      const detail = document.getElementById(\`detail-\${id}\`);
      const convoHtml = buildConvoHtml(data.turns, 'convo-' + id);

      detail.innerHTML = \`
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="btn" onclick="event.stopPropagation();openFocus('\${id}')" title="Expand to focus view">🔍 Focus</button>
          <button class="btn" onclick="event.stopPropagation();openTerminal('\${id}')" title="Open in terminal">💻 Terminal</button>
        </div>
        \${convoHtml}
        <div class="session-chat" onclick="event.stopPropagation()">
          <input type="text" id="chat-input-\${id}" placeholder="Ask a follow-up question..."
                 onkeydown="if(event.key==='Enter')sendChat('\${id}')" onclick="event.stopPropagation()" />
          <button class="btn btn-primary" onclick="event.stopPropagation();sendChat('\${id}')">Send</button>
        </div>
        <div id="chat-status-\${id}"></div>
      \`;

      const convo = document.getElementById(\`convo-\${id}\`);
      if (convo) convo.scrollTop = convo.scrollHeight;
    }

    // ---- Focus Modal ----
    let focusSessionId = null;
    let focusSessionData = null;
    let focusPoller = null;
    let focusMinTurns = 0; // minimum expected turns after sending a chat
    let focusChatPending = false; // true after sending chat until user.message appears in events

    function isFocusVerbose() {
      return localStorage.getItem('focusVerbose') === '1';
    }

    function toggleFocusVerbose() {
      const checked = document.getElementById('focusVerbose').checked;
      localStorage.setItem('focusVerbose', checked ? '1' : '0');
      // Re-render conversation with/without steps
      if (focusSessionData && focusSessionData.turns) {
        const convoHtml = buildConvoHtml(focusSessionData.turns, 'focus-convo', checked, focusSessionData.sessionMeta, focusSessionData.tokenStats);
        document.getElementById('focusBody').innerHTML = convoHtml;
        const convo = document.getElementById('focus-convo');
        if (convo) convo.scrollTop = convo.scrollHeight;
      }
    }

    async function openFocus(id) {
      focusSessionId = id;
      document.getElementById('focusOverlay').classList.add('visible');
      document.getElementById('focusBody').innerHTML = '<div style="color:#8b949e;padding:20px">Loading session...</div>';
      // Restore sticky verbose toggle
      const verboseCheckbox = document.getElementById('focusVerbose');
      if (verboseCheckbox) verboseCheckbox.checked = isFocusVerbose();
      try {
        const res = await fetch(\`/api/sessions/\${id}\`);
        focusSessionData = await res.json();
        const agentName = focusSessionData.agentName || focusSessionData.name || id.substring(0,8);
        document.getElementById('focusTitle').textContent = agentName + ' — ' + (focusSessionData.name || '');
        const convoHtml = buildConvoHtml(focusSessionData.turns, 'focus-convo', isFocusVerbose());
        document.getElementById('focusBody').innerHTML = convoHtml;
        const convo = document.getElementById('focus-convo');
        if (convo) convo.scrollTop = convo.scrollHeight;
        document.getElementById('focusChatInput').focus();
        // Start live polling for this session
        startFocusPolling(id);
      } catch (e) {
        document.getElementById('focusBody').innerHTML = '<div style="color:#f85149;padding:20px">Failed to load session</div>';
      }
    }

    function startFocusPolling(sessionId) {
      stopFocusPolling();
      let lastTurnCount = -1;
      let lastStepCount = -1;
      let lastWasPending = false; // was last turn missing assistant response?
      let lastTokenStats = false; // did we have token stats last poll?
      const poll = async () => {
        if (focusSessionId !== sessionId) return;
        const verbose = isFocusVerbose();
        try {
          const res = await fetch(\`/api/sessions/\${sessionId}/poll?verbose=\${verbose ? '1' : '0'}\`);
          const data = await res.json();
          const convo = document.getElementById('focus-convo');
          if (!convo) return;

          // Count total steps to detect intermediate changes
          const totalSteps = (data.turns || []).reduce((sum, t) => sum + (t.steps ? t.steps.length : 0), 0);
          const turnCount = data.turns ? data.turns.length : 0;

          // Don't rebuild if poll has fewer turns than expected (event not written yet)
          if (turnCount < focusMinTurns) {
            // Chat was sent but user.message not yet in events — keep polling
            focusPoller = setTimeout(poll, 1000);
            return;
          }
          // User message appeared — clear chat pending
          if (focusChatPending && turnCount >= focusMinTurns) {
            focusChatPending = false;
          }

          // Detect changes: turn count, step count, pending→complete transition, new token stats
          const lastTurn = data.turns && data.turns.length > 0 ? data.turns[data.turns.length - 1] : null;
          const currentlyPending = lastTurn && !lastTurn.assistant;
          const hasTokenStats = !!data.tokenStats;
          const isFirstPoll = lastTurnCount < 0;
          const changed = isFirstPoll
            || turnCount !== lastTurnCount
            || (verbose && totalSteps !== lastStepCount)
            || (lastWasPending && !currentlyPending)  // response just arrived
            || (verbose && hasTokenStats !== lastTokenStats);  // session just finished

          if (changed) {
            const wasAtBottom = (convo.scrollHeight - convo.scrollTop - convo.clientHeight) < 40;
            let html = '';
            // Session metadata banner (verbose only)
            if (verbose && data.sessionMeta) {
              html += renderSessionMetaBanner(data.sessionMeta);
            }
            for (const turn of data.turns) {
              html += '<div class="conv-turn"><div class="conv-role user">👤 You</div>' +
                '<div class="conv-content">' + esc(turn.content) + '</div></div>';
              if (verbose && turn.steps && turn.steps.length > 0) {
                html += renderStepsHtml(turn.steps);
              }
              if (turn.assistant) {
                html += '<div class="conv-turn"><div class="conv-role assistant">🤖 Agent' +
                  (verbose ? renderModelBadge(turn.model) : '') +
                  '</div>' +
                  '<div class="conv-content assistant-content">' + renderMd(turn.assistant) + '</div></div>';
              } else {
                html += '<div class="conv-turn"><div class="conv-role assistant">🤖 Agent</div>' +
                  '<div class="conv-content assistant-content" style="color:#8b949e">Thinking...</div></div>';
              }
            }
            // Token stats footer (verbose, completed sessions only)
            if (verbose && data.tokenStats) {
              html += renderTokenStats(data.tokenStats);
            }
            convo.innerHTML = html;
            if (wasAtBottom) convo.scrollTop = convo.scrollHeight;
            // Update cached data for toggle re-renders
            focusSessionData = { ...focusSessionData, turns: data.turns, sessionMeta: data.sessionMeta, tokenStats: data.tokenStats };
          }

          // Show chat errors from the server
          if (data.chatError) {
            const convo = document.getElementById('focus-convo');
            if (convo) {
              // Remove any pending "Thinking..." indicator
              const pending = document.getElementById('focus-pending');
              if (pending) pending.remove();
              convo.innerHTML += '<div class="conv-turn" style="border-left:3px solid #f85149;padding-left:8px">' +
                '<div class="conv-role" style="color:#f85149">⚠️ System Error</div>' +
                '<div class="conv-content" style="color:#f85149;font-family:monospace;font-size:0.85rem;white-space:pre-wrap">' + esc(data.chatError) + '</div></div>';
              convo.scrollTop = convo.scrollHeight;
            }
            // Stop polling on error
            focusPoller = null;
            const status = document.getElementById('focusChatStatus');
            if (status) { const ind = status.querySelector('.focus-live-indicator'); if (ind) ind.remove(); }
            lastTurnCount = turnCount; lastStepCount = totalSteps;
            lastWasPending = currentlyPending; lastTokenStats = hasTokenStats;
            return;
          }

          // Update status indicator
          const status = document.getElementById('focusChatStatus');
          if ((data.isActive || currentlyPending) && status) {
            if (!status.querySelector('.focus-live-indicator')) {
              status.innerHTML = '<span class="focus-live-indicator" style="color:#f0883e;font-size:0.8rem"><span class="spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px"></span>Session is active — updating live</span>';
            }
          } else if (status) {
            const indicator = status.querySelector('.focus-live-indicator');
            if (indicator) indicator.remove();
          }

          // Keep polling if session is active, last turn has no response, chat pending,
          // or we just got the response but haven't seen token stats yet (session.shutdown pending)
          const needsMorePolls = (lastWasPending && !currentlyPending && verbose && !hasTokenStats);
          if (data.isActive || currentlyPending || focusChatPending || needsMorePolls) {
            focusPoller = setTimeout(poll, 2000);
          } else {
            focusPoller = null;
          }

          // Update tracking AFTER keep-polling decision
          lastTurnCount = turnCount;
          lastStepCount = totalSteps;
          lastWasPending = currentlyPending;
          lastTokenStats = hasTokenStats;
        } catch {
          focusPoller = null;
        }
      };
      focusPoller = setTimeout(poll, 1500);
    }

    function stopFocusPolling() {
      if (focusPoller) { clearTimeout(focusPoller); focusPoller = null; }
    }

    function closeFocus() {
      stopFocusPolling();
      document.getElementById('focusOverlay').classList.remove('visible');
      document.getElementById('focusEmailMenu')?.classList.remove('visible');
      focusSessionId = null;
      focusSessionData = null;
      focusMinTurns = 0;
      focusChatPending = false;
    }

    async function emailFocusSession(mode) {
      document.getElementById('focusEmailMenu').classList.remove('visible');
      if (!focusSessionId) return;
      try {
        const res = await fetch(\`/api/sessions/\${focusSessionId}/email\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        if (!res.ok) {
          const err = await res.json();
          alert(err.error || 'Failed to compose email');
        }
      } catch (e) {
        alert('Failed to send email: ' + e.message);
      }
    }

    async function sendFocusChat() {
      if (!focusSessionId) return;
      const input = document.getElementById('focusChatInput');
      const status = document.getElementById('focusChatStatus');
      const message = input.value.trim();
      if (!message) return;

      input.disabled = true;

      const convo = document.getElementById('focus-convo');
      if (convo) {
        convo.innerHTML +=
          '<div class="conv-turn"><div class="conv-role user">👤 You</div>' +
          '<div class="conv-content">' + esc(message) + '</div></div>' +
          '<div class="conv-turn" id="focus-pending"><div class="conv-role assistant">🤖 Agent</div>' +
          '<div class="conv-content assistant-content" style="color:#8b949e">Thinking...</div></div>';
        convo.scrollTop = convo.scrollHeight;
      }
      input.value = '';

      try {
        // Set minimum expected turns so polling won't rebuild with fewer
        const currentTurns = focusSessionData?.turns?.length || 0;
        focusMinTurns = currentTurns + 1;
        focusChatPending = true;
        await fetch(\`/api/sessions/\${focusSessionId}/chat\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        // Chat is now async — restart focus polling to show live updates
        startFocusPolling(focusSessionId);
      } catch (e) {
        const pending = document.getElementById('focus-pending');
        if (pending) pending.remove();
        status.innerHTML = '<div style="color:#f85149;font-size:0.8rem">Failed to send message</div>';
      }
      input.disabled = false;
      input.focus();
    }

    async function reloadFocusConversation() {
      if (!focusSessionId) return;
      const verbose = isFocusVerbose();
      try {
        const res = await fetch(\`/api/sessions/\${focusSessionId}/poll?verbose=\${verbose ? '1' : '0'}\`);
        const data = await res.json();
        if (!data.turns || data.turns.length === 0) return;
        focusSessionData = { ...focusSessionData, turns: data.turns, sessionMeta: data.sessionMeta, tokenStats: data.tokenStats };
        const convo = document.getElementById('focus-convo');
        if (!convo) return;
        let html = '';
        if (verbose && data.sessionMeta) html += renderSessionMetaBanner(data.sessionMeta);
        for (const turn of data.turns) {
          html += '<div class="conv-turn"><div class="conv-role user">👤 You</div>' +
            '<div class="conv-content">' + esc(turn.content) + '</div></div>';
          if (verbose && turn.steps && turn.steps.length > 0) {
            html += renderStepsHtml(turn.steps);
          }
          if (turn.assistant) {
            html += '<div class="conv-turn"><div class="conv-role assistant">🤖 Agent' +
              (verbose ? renderModelBadge(turn.model) : '') + '</div>' +
              '<div class="conv-content assistant-content">' + renderMd(turn.assistant) + '</div></div>';
          }
        }
        if (verbose && data.tokenStats) html += renderTokenStats(data.tokenStats);
        convo.innerHTML = html;
        convo.scrollTop = convo.scrollHeight;
      } catch {}
    }

    async function openTerminal(id) {
      await fetch(\`/api/sessions/\${id}/terminal\`, { method: 'POST' });
    }

    function showAgentSessions(agentName) {
      // Collapse all session groups, then expand only the matching one
      Object.keys(sessionGroupState).forEach(k => sessionGroupState[k] = true);
      sessionGroupState[agentName] = false; // false = expanded
      localStorage.setItem('sessionGroupState', JSON.stringify(sessionGroupState));
      // Open the panel (will load sessions which calls renderSessions with our state)
      document.getElementById('sessionsOverlay').classList.add('visible');
      document.getElementById('sessionsPanel').classList.add('visible');
      if (allSessions.length) {
        renderSessions();
      } else {
        loadSessions();
      }
    }

    async function openLastTerminal(agentId, agentCwd) {
      // Find the most recent session for this agent from the sessions API
      try {
        const res = await fetch('/api/sessions?hours=48');
        const sessions = await res.json();
        const match = sessions.find(s => (s.agentName || '').toLowerCase().includes(agentId.toLowerCase()) || (s.name || '').toLowerCase().includes(agentId.toLowerCase()));
        if (match) {
          await fetch(\`/api/sessions/\${match.id}/terminal\`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ cwd: agentCwd }) });
        } else if (agentCwd) {
          // No session found, just open copilot in the agent's CWD
          await fetch('/api/terminal/open', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ cwd: agentCwd, agentId }) });
        } else {
          alert('No recent session found for this agent');
        }
      } catch (e) {
        alert('Failed to find session: ' + e.message);
      }
    }

    async function openLastChat(agentId, sessionId) {
      // Use stored session ID if available, otherwise search for latest
      if (sessionId) { openFocus(sessionId); return; }
      try {
        const res = await fetch('/api/sessions?hours=72');
        const sessions = await res.json();
        const match = sessions.find(s => (s.agentName || '').toLowerCase().includes(agentId.toLowerCase()) || (s.name || '').toLowerCase().includes(agentId.toLowerCase()));
        if (match) {
          openFocus(match.id);
        } else {
          alert('No recent session found for this agent');
        }
      } catch (e) {
        alert('Failed to find session: ' + e.message);
      }
    }

    async function editAgentSource(agentId) {
      await fetch(\`/api/agents/\${agentId}/edit-source\`, { method: 'POST' });
    }

    async function reinstallPlugin(agentId) {
      if (!confirm('Reinstall this plugin? This will uninstall and re-install it.')) return;
      const res = await fetch(\`/api/agents/\${agentId}/reinstall\`, { method: 'POST' });
      const data = await res.json();
      if (data.error) alert('Reinstall failed: ' + data.error);
      else alert('Plugin reinstalled successfully');
    }

    // ---- Inline Chat (in side panel) ----
    async function sendChat(id) {
      const input = document.getElementById(\`chat-input-\${id}\`);
      const status = document.getElementById(\`chat-status-\${id}\`);
      const message = input.value.trim();
      if (!message) return;

      input.disabled = true;
      status.innerHTML = '<div class="chat-sending"><div class="spinner"></div>Sending to agent... this may take a minute</div>';

      const convo = document.getElementById(\`convo-\${id}\`);
      if (convo) {
        convo.innerHTML +=
          '<div class="conv-turn"><div class="conv-role user">👤 You</div>' +
          '<div class="conv-content">' + esc(message) + '</div></div>' +
          '<div class="conv-turn" id="pending-response-' + id + '"><div class="conv-role assistant">🤖 Agent</div>' +
          '<div class="conv-content assistant-content" style="color:#8b949e">Thinking...</div></div>';
        convo.scrollTop = convo.scrollHeight;
      }
      input.value = '';

      try {
        const res = await fetch(\`/api/sessions/\${id}/chat\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await res.json();
        const pending = document.getElementById(\`pending-response-\${id}\`);
        if (pending) {
          pending.innerHTML = '<div class="conv-role assistant">🤖 Agent</div>' +
            '<div class="conv-content assistant-content">' + renderMd(data.response) + '</div>';
        }
        status.innerHTML = '';
        if (convo) convo.scrollTop = convo.scrollHeight;
        // Start polling for continued activity
        pollSessionUpdates(id, \`pending-response-\${id}\`, \`convo-\${id}\`, data.response);
      } catch (e) {
        const pending = document.getElementById(\`pending-response-\${id}\`);
        if (pending) pending.remove();
        status.innerHTML = '<div style="color:#f85149;font-size:0.8rem">Failed to send message</div>';
      }
      input.disabled = false;
      input.focus();
    }

    // Poll session for continued agent activity after sending a chat
    async function pollSessionUpdates(sessionId, pendingElId, convoElId, initialResponse) {
      let lastContent = initialResponse;
      let pollCount = 0;
      const maxPolls = 30; // poll for up to ~60 seconds
      const pollInterval = 2000;

      const poll = async () => {
        if (pollCount++ >= maxPolls) return;
        try {
          const res = await fetch(\`/api/sessions/\${sessionId}/poll\`);
          const data = await res.json();
          if (data.lastAssistant && data.lastAssistant !== lastContent) {
            lastContent = data.lastAssistant;
            const pending = document.getElementById(pendingElId);
            if (pending) {
              pending.innerHTML = '<div class="conv-role assistant">🤖 Agent</div>' +
                '<div class="conv-content assistant-content">' + renderMd(lastContent) + '</div>';
              const convo = document.getElementById(convoElId);
              if (convo) convo.scrollTop = convo.scrollHeight;
            }
          }
          if (data.isActive) {
            // Session is still being written to — keep polling
            const pending = document.getElementById(pendingElId);
            if (pending && !pending.querySelector('.poll-indicator')) {
              pending.querySelector('.conv-content')?.insertAdjacentHTML('beforeend',
                '<span class="poll-indicator" style="display:inline-block;margin-left:8px;color:#8b949e;font-size:0.75rem">⏳ agent still working...</span>');
            }
            setTimeout(poll, pollInterval);
          } else {
            // Session stopped updating — remove indicator
            document.querySelectorAll('.poll-indicator').forEach(el => el.remove());
          }
        } catch { /* stop polling on error */ }
      };
      setTimeout(poll, pollInterval);
    }

    // Poll live output for running agents
    const livePollers = new Set();
    async function pollLiveOutput(agentId) {
      if (livePollers.has(agentId)) return;
      livePollers.add(agentId);
      const poll = async () => {
        const el = document.getElementById(\`live-\${agentId}\`);
        if (!el) { livePollers.delete(agentId); return; }
        try {
          const res = await fetch(\`/api/agents/\${agentId}/live\`);
          const data = await res.json();
          if (!data.running) {
            livePollers.delete(agentId);
            refresh(); // Agent finished — full refresh to show final output
            return;
          }
          if (data.output) {
            const wasAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
            el.innerHTML = (typeof marked !== 'undefined') ? marked.parse(data.output) : data.output.replace(/</g,'&lt;');
            if (wasAtBottom) el.scrollTop = el.scrollHeight;
            const statusEl = document.getElementById(\`live-status-\${agentId}\`);
            if (statusEl) statusEl.textContent = \`\${data.messageCount} response\${data.messageCount > 1 ? 's' : ''}\${data.isActive ? ' · updating...' : ''}\`;
            // Enable chat button once we have a session ID
            const chatBtnEl = document.getElementById(\`live-chat-btn-\${agentId}\`);
            if (chatBtnEl && data.sessionId) {
              chatBtnEl.innerHTML = '<button class="output-toggle" onclick="openFocus(\\\'' + data.sessionId + '\\\')" title="Chat with this session">💬 Chat</button>';
            }
          }
        } catch { }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 2000);
    }

    // After each refresh, start polling for any running agents
    function startLivePollers() {
      document.querySelectorAll('[id^="live-"]').forEach(el => {
        const agentId = el.id.replace('live-', '');
        if (agentId) pollLiveOutput(agentId);
      });
    }

    // Close email dropdown on outside click
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('focusEmailMenu');
      const wrap = document.getElementById('focusEmailWrap');
      if (menu && wrap && !wrap.contains(e.target)) menu.classList.remove('visible');
    });

    refresh();
    setInterval(() => { refresh(); startLivePollers(); }, 10000);
    setTimeout(startLivePollers, 1000);

    // Wire up import file input
    document.getElementById('importZipInput')?.addEventListener('change', function() { handleImportFile(this); });
  </script>
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

  <div id="app">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2>Managers</h2>
      <button class="btn btn-primary" onclick="showCreateManager()">+ New Manager</button>
    </div>
    <div id="managers-list" class="managers-grid"></div>
  </div>

  <!-- Create/Edit Manager Modal -->
  <div id="managerModal" class="modal-overlay">
    <div class="modal">
      <h3 id="managerModalTitle">Create Manager</h3>
      <div class="form-group">
        <label>ID (unique slug)</label>
        <input type="text" id="mgr-id" placeholder="e.g. helix-ops-manager">
      </div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="mgr-name" placeholder="e.g. Helix Ops Manager">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="mgr-desc" rows="2" placeholder="What this manager does..."></textarea>
      </div>
      <div class="form-group">
        <label>Agent Plugin</label>
        <select id="mgr-agent"></select>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeModal('managerModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveManager()">Save</button>
      </div>
    </div>
  </div>

  <!-- Assignment Modal -->
  <div id="assignmentModal" class="modal-overlay">
    <div class="modal">
      <h3>New Assignment</h3>
      <input type="hidden" id="asgn-manager-id">
      <div class="form-group">
        <label>ID (unique slug)</label>
        <input type="text" id="asgn-id" placeholder="e.g. monitor-azure">
      </div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="asgn-name" placeholder="e.g. Monitor Azure">
      </div>
      <div class="form-group">
        <label>Prompt</label>
        <textarea id="asgn-prompt" rows="4" placeholder="What should the manager do?"></textarea>
      </div>
      <div class="form-group">
        <label>Schedule</label>
        <input type="text" id="asgn-schedule" placeholder="e.g. 1h, daily at 9am, never" value="never">
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeModal('assignmentModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveAssignment()">Save</button>
      </div>
    </div>
  </div>

  <!-- Add Agent to Org Modal -->
  <div id="orgModal" class="modal-overlay">
    <div class="modal">
      <h3>Add Agent to Organization</h3>
      <input type="hidden" id="org-manager-id">
      <div class="form-group">
        <label>Available Agents</label>
        <select id="org-agent-select" size="8" style="height:auto;"></select>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeModal('orgModal')">Cancel</button>
        <button class="btn btn-primary" onclick="addAgentToOrg()">Add</button>
      </div>
    </div>
  </div>

  <!-- Agent Select Modal -->
  <div id="agentSelectModal" class="modal-overlay">
    <div class="modal">
      <h3>Select Agent Plugin</h3>
      <input type="hidden" id="agent-select-manager-id">
      <div class="form-group">
        <label>Agent Variant</label>
        <select id="agent-select-dropdown" size="1" style="width:100%;"></select>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeModal('agentSelectModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveAgentSelect()">Save</button>
      </div>
    </div>
  </div>

  <!-- Manager Chat Modal -->
  <div id="mgrChatOverlay" class="modal-overlay" onclick="if(event.target===this)closeMgrChat()">
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;width:90vw;max-width:900px;height:85vh;display:flex;flex-direction:column;overflow:hidden;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #30363d;flex-shrink:0;">
        <h2 id="mgrChatTitle" style="color:#f0f6fc;font-size:1.1rem;margin:0;">Chat</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;color:#8b949e;cursor:pointer;" title="Show orchestration steps">
            <input type="checkbox" id="mgrChatVerbose" onchange="toggleChatVerbose()" />
            🔧 Verbose
          </label>
          <button class="btn" style="padding:4px 10px;font-size:1rem;line-height:1;" onclick="closeMgrChat()">&times;</button>
        </div>
      </div>
      <div id="mgrChatBody" style="flex:1;overflow-y:auto;padding:20px;"></div>
      <div style="display:flex;gap:8px;padding:12px 20px;border-top:1px solid #30363d;flex-shrink:0;">
        <input type="text" id="mgrChatInput" placeholder="Ask the manager to do something..."
               style="flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:10px 12px;border-radius:6px;font-size:0.9rem;" />
        <button class="btn btn-primary" onclick="sendMgrChat()">Send</button>
      </div>
    </div>
  </div>

  <script>
    let managersData = [];

    async function loadManagers() {
      const res = await fetch('/api/managers');
      managersData = await res.json();
      renderManagers();
    }

    function renderManagers() {
      const container = document.getElementById('managers-list');
      if (managersData.length === 0) {
        container.innerHTML = '<div class="empty-state"><h3>No Managers Yet</h3><p>Create a manager to orchestrate your agents intelligently.</p></div>';
        return;
      }

      container.innerHTML = managersData.map(m => \`
        <div class="manager-card" id="mgr-\${m.manager_id}">
          <div class="manager-header">
            <span class="manager-name">\${m.config.name}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              <span class="status-badge status-\${m.status || 'idle'}">\${m.status || 'idle'}</span>
              <button class="btn btn-sm btn-danger" onclick="deleteManager('\${m.manager_id}')">✕</button>
            </div>
          </div>
          <div class="manager-desc">\${m.config.description || ''}</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
            <span style="font-size:0.8rem;color:#8b949e;">Agent:</span>
            <code style="font-size:0.8rem;color:#58a6ff;background:#1f6feb22;padding:2px 8px;border-radius:4px;">\${m.config.agent || 'manager:manager'}</code>
            <button class="btn btn-sm" onclick="editManagerAgent('\${m.manager_id}', '\${m.config.agent || 'manager:manager'}')">🔄 Change</button>
            <button class="btn btn-sm" onclick="openManagerAgentInEditor('\${m.manager_id}')">📝 Edit Prompt</button>
          </div>
          
          <div class="org-section">
            <div class="org-label">Organization (Agents)</div>
            <div class="org-agents">
              \${(m.orgDetails || []).map(a => \`
                <span class="org-chip">
                  \${a.name}
                  <span class="remove-btn" onclick="removeFromOrg('\${m.manager_id}', '\${a.id}')" title="Remove">✕</span>
                </span>
              \`).join('')}
              <button class="org-add-btn" onclick="showAddAgent('\${m.manager_id}')">+ Add</button>
            </div>
          </div>

          <div class="assignments-section">
            <div class="org-label">Assignments \${m.activeSchedules > 0 ? '<span style="color:#3fb950;font-size:11px;">(' + m.activeSchedules + ' scheduled)</span>' : ''}</div>
            <div class="assignment-list">
              \${(m.config.assignments || []).map(a => \`
                <div class="assignment-item">
                  <span class="assignment-name">\${a.name}</span>
                  <span class="assignment-schedule" title="\${escapeHtml(a.scheduleDescription || '')}">\${a.schedule || 'never'}\${a.scheduleDescription ? ' (' + a.scheduleDescription + ')' : ''}</span>
                  \${a.nextRun ? '<span style="font-size:10px;color:#8b949e;">next: ' + new Date(a.nextRun).toLocaleTimeString() + '</span>' : ''}
                  <span class="assignment-prompt" title="\${escapeHtml(a.prompt || '')}">\${escapeHtml(a.prompt || '')}</span>
                  <div class="assignment-actions">
                    <button class="btn btn-sm" onclick="toggleAssignment('\${m.manager_id}', '\${a.id}', \${a.enabled === false ? 'true' : 'false'})" title="\${a.enabled !== false ? 'Disable' : 'Enable'}">\${a.enabled !== false ? '⏸' : '▶️'}</button>
                    <button class="btn btn-sm" onclick="editAssignmentSchedule('\${m.manager_id}', '\${a.id}', '\${a.schedule || 'never'}')" title="Edit schedule">🕐</button>
                    <button class="btn btn-sm btn-primary" onclick="runAssignment('\${m.manager_id}', '\${a.id}')">▶ Run</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteAssignment('\${m.manager_id}', '\${a.id}')">✕</button>
                  </div>
                </div>
              \`).join('')}
              <button class="btn btn-sm" onclick="showAddAssignment('\${m.manager_id}')" style="margin-top:6px;">+ Add Assignment</button>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-primary" onclick="openManagerChat('\${m.manager_id}', '\${m.config.name}').then(() => loadChatHistory('\${m.manager_id}'))">💬 Chat with Manager</button>
            <button class="btn" onclick="toggleHistory('\${m.manager_id}')">📋 Run History</button>
          </div>

          <div class="history-section">
            <div id="history-\${m.manager_id}" class="history-list"></div>
          </div>
        </div>
      \`).join('');
    }

    async function showCreateManager() {
      document.getElementById('mgr-id').value = '';
      document.getElementById('mgr-name').value = '';
      document.getElementById('mgr-desc').value = '';
      document.getElementById('managerModalTitle').textContent = 'Create Manager';
      // Load agent variants into dropdown
      const select = document.getElementById('mgr-agent');
      try {
        const res = await fetch('/api/manager-agents');
        const variants = await res.json();
        select.innerHTML = variants.map(v => 
          \`<option value="\${v.id}">\${v.id} — \${v.description}</option>\`
        ).join('');
      } catch { select.innerHTML = '<option value="manager:manager">manager:manager</option>'; }
      document.getElementById('managerModal').classList.add('visible');
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('visible');
    }

    async function saveManager() {
      const config = {
        id: document.getElementById('mgr-id').value.trim(),
        name: document.getElementById('mgr-name').value.trim(),
        description: document.getElementById('mgr-desc').value.trim(),
        agent: document.getElementById('mgr-agent').value.trim() || 'manager:manager',
        org: [],
        assignments: []
      };
      if (!config.id || !config.name) return alert('ID and Name are required');

      // If editing existing, preserve org and assignments
      const existing = managersData.find(m => m.manager_id === config.id);
      if (existing) {
        config.org = existing.config.org || [];
        config.assignments = existing.config.assignments || [];
      }

      await fetch('/api/managers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) });
      closeModal('managerModal');
      loadManagers();
    }

    async function deleteManager(id) {
      if (!confirm('Delete this manager?')) return;
      await fetch('/api/managers/' + id, { method: 'DELETE' });
      loadManagers();
    }

    async function editManagerAgent(managerId, currentAgent) {
      // Fetch available variants and show select modal
      const res = await fetch('/api/manager-agents');
      const variants = await res.json();
      document.getElementById('agent-select-manager-id').value = managerId;
      const select = document.getElementById('agent-select-dropdown');
      select.innerHTML = variants.map(v => 
        \`<option value="\${v.id}" \${v.id === currentAgent ? 'selected' : ''}>\${v.id} — \${v.description}</option>\`
      ).join('');
      document.getElementById('agentSelectModal').classList.add('visible');
    }

    async function saveAgentSelect() {
      const managerId = document.getElementById('agent-select-manager-id').value;
      const newAgent = document.getElementById('agent-select-dropdown').value;
      const mgr = managersData.find(m => m.manager_id === managerId);
      if (!mgr) return;
      const config = { ...mgr.config, agent: newAgent };
      await fetch('/api/managers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) });
      closeModal('agentSelectModal');
      loadManagers();
    }

    function openManagerAgentInEditor(managerId) {
      fetch('/api/managers/' + managerId + '/edit-agent', { method: 'POST' });
    }

    async function showAddAgent(managerId) {
      document.getElementById('org-manager-id').value = managerId;
      const res = await fetch('/api/managers/' + managerId + '/available-agents');
      const agents = await res.json();
      const select = document.getElementById('org-agent-select');
      select.innerHTML = agents.map(a => \`<option value="\${a.id}">\${a.name} (\${a.id})</option>\`).join('');
      document.getElementById('orgModal').classList.add('visible');
    }

    async function addAgentToOrg() {
      const managerId = document.getElementById('org-manager-id').value;
      const agentId = document.getElementById('org-agent-select').value;
      if (!agentId) return;
      await fetch('/api/managers/' + managerId + '/org', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ agentId })
      });
      closeModal('orgModal');
      loadManagers();
    }

    async function removeFromOrg(managerId, agentId) {
      await fetch('/api/managers/' + managerId + '/org/' + agentId, { method: 'DELETE' });
      loadManagers();
    }

    function showAddAssignment(managerId) {
      document.getElementById('asgn-manager-id').value = managerId;
      document.getElementById('asgn-id').value = '';
      document.getElementById('asgn-name').value = '';
      document.getElementById('asgn-prompt').value = '';
      document.getElementById('asgn-schedule').value = 'never';
      document.getElementById('assignmentModal').classList.add('visible');
    }

    async function saveAssignment() {
      const managerId = document.getElementById('asgn-manager-id').value;
      const data = {
        id: document.getElementById('asgn-id').value.trim(),
        name: document.getElementById('asgn-name').value.trim(),
        prompt: document.getElementById('asgn-prompt').value.trim(),
        schedule: document.getElementById('asgn-schedule').value.trim() || 'never'
      };
      if (!data.id || !data.name || !data.prompt) return alert('ID, Name, and Prompt are required');
      await fetch('/api/managers/' + managerId + '/assignments', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
      });
      closeModal('assignmentModal');
      loadManagers();
    }

    async function deleteAssignment(managerId, assignmentId) {
      if (!confirm('Delete this assignment?')) return;
      await fetch('/api/managers/' + managerId + '/assignments/' + assignmentId, { method: 'DELETE' });
      loadManagers();
    }

    async function toggleAssignment(managerId, assignmentId, enabled) {
      await fetch('/api/managers/' + managerId + '/assignments/' + assignmentId + '/toggle', {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled })
      });
      loadManagers();
    }

    function editAssignmentSchedule(managerId, assignmentId, currentSchedule) {
      const newSchedule = prompt('Schedule for this assignment:\n\nExamples: 1h, 30m, daily at 9am, weekdays at 8am, never\n\nCurrent: ' + currentSchedule, currentSchedule);
      if (newSchedule === null) return;
      fetch('/api/managers/' + managerId + '/assignments/' + assignmentId + '/schedule', {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ schedule: newSchedule })
      }).then(r => r.json()).then(data => {
        if (data.error) alert('Invalid schedule: ' + data.error);
        else loadManagers();
      });
    }

    async function runAssignment(managerId, assignmentId) {
      // Open chat modal and run the assignment — results stream in via polling
      const mgr = managersData.find(m => m.manager_id === managerId);
      await openManagerChat(managerId, mgr?.config?.name || managerId);

      try {
        const res = await fetch('/api/managers/' + managerId + '/assignments/' + assignmentId + '/run', { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          document.getElementById('mgrChatBody').innerHTML += '<div style="color:#f85149;padding:12px;">Error: ' + data.error + '</div>';
          return;
        }
        // Reload history which detects the active run and starts polling
        await loadChatHistory(managerId);
      } catch (e) {
        document.getElementById('mgrChatBody').innerHTML += '<div style="color:#f85149;padding:12px;">Error: ' + e.message + '</div>';
      }
    }

    // ---- Manager Chat Modal ----
    let chatManagerId = null;
    let chatRunId = null;
    let chatPoller = null;
    let chatVerbose = localStorage.getItem('mgrVerbose') === 'true';

    async function openManagerChat(managerId, managerName) {
      chatManagerId = managerId;
      chatRunId = null;
      stopChatPolling();
      document.getElementById('mgrChatTitle').textContent = '💬 ' + managerName;
      document.getElementById('mgrChatBody').innerHTML = '<div style="color:#8b949e;padding:20px;text-align:center;">Loading...</div>';
      document.getElementById('mgrChatVerbose').checked = chatVerbose;
      document.getElementById('mgrChatOverlay').classList.add('visible');
      document.getElementById('mgrChatInput').value = '';
      document.getElementById('mgrChatInput').focus();
    }

    function closeMgrChat() {
      document.getElementById('mgrChatOverlay').classList.remove('visible');
      chatManagerId = null;
      stopChatPolling();
    }

    function toggleChatVerbose() {
      chatVerbose = document.getElementById('mgrChatVerbose').checked;
      localStorage.setItem('mgrVerbose', chatVerbose);
      if (chatRunId) pollChatRun();
    }

    async function loadChatHistory(managerId) {
      const res = await fetch('/api/managers/' + managerId + '/messages?limit=30');
      const messages = await res.json();
      const body = document.getElementById('mgrChatBody');
      if (messages.length === 0) {
        body.innerHTML = '<div style="color:#8b949e;padding:20px;text-align:center;">Send a message to start chatting with the manager.</div>';
      } else {
        body.innerHTML = messages.map(m => renderChatMessage(m.role, m.content, m.created_at)).join('');
        body.scrollTop = body.scrollHeight;
      }

      // Check if there's an active run and start polling for it
      try {
        const histRes = await fetch('/api/managers/' + managerId + '/history?limit=1');
        const runs = await histRes.json();
        if (runs.length > 0 && runs[0].status === 'running') {
          chatRunId = runs[0].id;
          body.innerHTML += '<div id="mgr-pending" class="mgr-chat-msg assistant"><div class="mgr-chat-role">🤖 Manager</div><div class="mgr-chat-content assistant-md" style="color:#8b949e;">🧠 Thinking...</div></div>';
          body.scrollTop = body.scrollHeight;
          startChatPolling();
        }
      } catch {}
    }

    function renderChatMessage(role, content, timestamp) {
      const timeStr = timestamp ? '<span style="color:#484f58;font-size:0.7rem;margin-left:8px;">' + new Date(timestamp).toLocaleTimeString() + '</span>' : '';
      if (role === 'user') {
        return '<div class="mgr-chat-msg user"><div class="mgr-chat-role">👤 You' + timeStr + '</div><div class="mgr-chat-content">' + escapeHtml(content) + '</div></div>';
      }
      const rendered = (typeof marked !== 'undefined') ? marked.parse(content) : escapeHtml(content);
      return '<div class="mgr-chat-msg assistant"><div class="mgr-chat-role">🤖 Manager' + timeStr + '</div><div class="mgr-chat-content assistant-md">' + rendered + '</div></div>';
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function renderStep(step) {
      const icons = { thinking: '🧠', run_agent: '▶️', agent_result: '✅', complete: '🏁', error: '❌', request_agent: '🔍' };
      const icon = icons[step.action] || '•';
      let detail = '';
      if (step.action === 'thinking') detail = 'Analyzing...';
      else if (step.action === 'run_agent') detail = \`Running <strong>\${step.agentId}</strong>: \${(step.prompt || '').substring(0, 100)}\`;
      else if (step.action === 'agent_result') detail = \`<strong>\${step.agentId}</strong> returned (exit \${step.exitCode}, \${step.outputLength} chars)\`;
      else if (step.action === 'complete') detail = 'Completed';
      else if (step.action === 'error') detail = step.message || 'Error';
      else if (step.action === 'request_agent') detail = \`Requesting <strong>\${step.agentId}</strong>: \${step.reason || ''}\`;
      const time = step.timestamp ? '<span style="color:#484f58;margin-left:8px;">' + new Date(step.timestamp).toLocaleTimeString() + '</span>' : '';
      return \`<div class="mgr-step \${step.action}">\${icon} \${detail}\${time}</div>\`;
    }

    async function sendMgrChat() {
      if (!chatManagerId) return;
      const input = document.getElementById('mgrChatInput');
      const prompt = input.value.trim();
      if (!prompt) return;
      input.value = '';
      input.disabled = true;

      const body = document.getElementById('mgrChatBody');
      // Clear placeholder if present
      if (body.querySelector('[style*="text-align:center"]')) body.innerHTML = '';
      body.innerHTML += renderChatMessage('user', prompt, new Date().toISOString());
      body.innerHTML += '<div id="mgr-pending" class="mgr-chat-msg assistant"><div class="mgr-chat-role">🤖 Manager</div><div class="mgr-chat-content assistant-md" style="color:#8b949e;">Thinking...</div></div>';
      body.scrollTop = body.scrollHeight;

      try {
        const res = await fetch('/api/managers/' + chatManagerId + '/prompt', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        if (data.runId) {
          chatRunId = data.runId;
          startChatPolling();
        }
      } catch (e) {
        const pending = document.getElementById('mgr-pending');
        if (pending) pending.innerHTML = '<div class="mgr-chat-role">🤖 Manager</div><div class="mgr-chat-content" style="color:#f85149;">Error: ' + e.message + '</div>';
      }
      input.disabled = false;
      input.focus();
    }

    function startChatPolling() {
      stopChatPolling();
      chatPoller = setInterval(pollChatRun, 2000);
      pollChatRun();
    }

    function stopChatPolling() {
      if (chatPoller) { clearInterval(chatPoller); chatPoller = null; }
    }

    async function pollChatRun() {
      if (!chatManagerId || !chatRunId) return;
      try {
        const res = await fetch(\`/api/managers/\${chatManagerId}/runs/\${chatRunId}\`);
        const run = await res.json();
        const body = document.getElementById('mgrChatBody');
        const pending = document.getElementById('mgr-pending');
        if (!pending) return;

        // Build verbose steps view
        let stepsHtml = '';
        if (chatVerbose && run.steps && run.steps.length > 0) {
          stepsHtml = '<div class="mgr-steps">' + run.steps.map(renderStep).join('') + '</div>';
        }

        if (run.status === 'running') {
          const lastStep = run.steps && run.steps.length > 0 ? run.steps[run.steps.length - 1] : null;
          let statusText = 'Thinking...';
          if (lastStep) {
            if (lastStep.action === 'run_agent') statusText = \`Running \${lastStep.agentId}...\`;
            else if (lastStep.action === 'agent_result') statusText = 'Analyzing results...';
          }
          pending.innerHTML = '<div class="mgr-chat-role">🤖 Manager</div>' + stepsHtml + '<div class="mgr-chat-content assistant-md" style="color:#8b949e;">' + statusText + '</div>';
        } else {
          // Completed or error
          stopChatPolling();
          const result = run.result || run.error || 'No response';
          const rendered = (typeof marked !== 'undefined') ? marked.parse(result) : escapeHtml(result);
          pending.innerHTML = '<div class="mgr-chat-role">🤖 Manager</div>' + stepsHtml + '<div class="mgr-chat-content assistant-md">' + rendered + '</div>';
          pending.id = ''; // Clear pending ID
          loadManagers();
        }
        body.scrollTop = body.scrollHeight;
      } catch (e) { /* ignore poll errors */ }
    }

    function toggleHistory(managerId) {
      const el = document.getElementById('history-' + managerId);
      el.classList.toggle('visible');
      if (el.classList.contains('visible')) {
        loadHistory(managerId);
      }
    }

    async function loadHistory(managerId) {
      const res = await fetch('/api/managers/' + managerId + '/history');
      const runs = await res.json();
      const el = document.getElementById('history-' + managerId);
      el.innerHTML = runs.map(r => {
        const steps = JSON.parse(r.steps || '[]');
        return \`
          <div class="history-item" onclick="viewRun('\${managerId}', \${r.id})" style="cursor:pointer;">
            <div>
              <span class="\${r.status === 'completed' ? 'status-ok' : 'status-err'}">\${r.status}</span>
              <span class="time">\${new Date(r.started_at).toLocaleString()}</span>
              \${r.assignment_id ? ' — ' + r.assignment_id : ' — ad-hoc'}
            </div>
            <div style="margin-top:4px;color:#8b949e;font-size:0.75rem;">\${(r.prompt || '').substring(0, 100)}</div>
            \${steps.length ? '<div class="steps-list">' + steps.filter(s => s.action !== 'thinking').map(s => \`<div class="step-item \${s.action}">\${s.action}: \${s.agentId || (s.result||'').substring(0, 80) || s.message || ''}</div>\`).join('') + '</div>' : ''}
          </div>
        \`;
      }).join('') || '<div style="color:#8b949e;font-size:0.85rem;">No runs yet.</div>';
    }

    async function viewRun(managerId, runId) {
      // Open chat modal showing this run's details
      const mgr = managersData.find(m => m.manager_id === managerId);
      await openManagerChat(managerId, mgr?.config?.name || managerId);
      const res = await fetch(\`/api/managers/\${managerId}/runs/\${runId}\`);
      const run = await res.json();
      const body = document.getElementById('mgrChatBody');
      let html = renderChatMessage('user', run.prompt || '', run.started_at);
      if (run.steps && run.steps.length > 0) {
        html += '<div class="mgr-steps">' + run.steps.map(renderStep).join('') + '</div>';
      }
      if (run.result) {
        html += renderChatMessage('assistant', run.result);
      }
      body.innerHTML = html;
    }

    // Handle Enter in chat modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'mgrChatInput') {
        e.preventDefault();
        sendMgrChat();
      }
    });

    // Initial load
    loadManagers();
    // Refresh every 10s
    setInterval(loadManagers, 10000);
  </script>
</body>
</html>`;
}
