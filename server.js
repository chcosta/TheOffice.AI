const express = require('express');
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('./db');
const Supervisor = require('./supervisor');

const PORT = process.env.PORT || 3847;
const DB_PATH = path.join(__dirname, 'supervisor.db');
const AGENTS_PATH = path.join(__dirname, 'agents.json');

async function main() {

// Initialize database
const db = await openDatabase(DB_PATH);

// Initialize supervisor
const supervisor = new Supervisor(db);

// Load agent configs
function loadAgents() {
  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  agents.forEach(agent => supervisor.register(agent));
  return agents;
}

loadAgents();

// Express app
const app = express();
app.use(express.json());

// Dashboard HTML
app.get('/', (req, res) => {
  res.send(getDashboardHtml());
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

// Start all enabled agents
supervisor.startAll();

app.listen(PORT, () => {
  console.log(`[supervisor] Dashboard running at http://localhost:${PORT}`);
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
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { color: #58a6ff; margin-bottom: 24px; font-size: 1.5rem; }
    .agents { display: grid; gap: 16px; }
    .agent-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px;
      transition: border-color 0.2s;
    }
    .agent-card:hover { border-color: #58a6ff; }
    .agent-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .agent-name { font-size: 1.1rem; font-weight: 600; color: #f0f6fc; }
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
      border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap;
      max-height: 300px; overflow-y: auto; display: none;
    }
    .output-content.visible { display: block; }
    .schedule-input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-family: monospace; width: 200px; }
    .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .auto-refresh { font-size: 0.8rem; color: #8b949e; }
  </style>
</head>
<body>
  <div class="refresh-bar">
    <h1>&#x1F916; Copilot Agent Supervisor</h1>
    <div>
      <button class="btn" onclick="openInCode()">&#x1F4DD; Edit in VS Code</button>
      <span class="auto-refresh">Auto-refreshes every 10s</span>
    </div>
  </div>
  <div class="agents" id="agents"></div>

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

    // Track which output panels are expanded
    const expandedOutputs = new Set();

    function renderAgents(agents) {
      const container = document.getElementById('agents');
      container.innerHTML = agents.map(agent => \`
        <div class="agent-card">
          <div class="agent-header">
            <span class="agent-name">\${agent.config?.name || agent.agent_id}</span>
            <span class="status-badge status-\${agent.status || 'idle'}">\${agent.status || 'idle'}</span>
          </div>
          <div class="agent-meta">
            <div class="meta-item"><span class="meta-label">Schedule:</span> <span class="meta-value" title="\${agent.scheduleDescription || ''}">\${agent.schedule} (\${agent.scheduleDescription || ''})</span></div>
            <div class="meta-item"><span class="meta-label">Next run:</span> <span class="meta-value">\${timeUntil(agent.next_run)}</span></div>
            <div class="meta-item"><span class="meta-label">Last run:</span> <span class="meta-value">\${timeAgo(agent.last_run)}</span></div>
            <div class="meta-item"><span class="meta-label">Durable:</span> <span class="meta-value">\${agent.config?.durable ? '✓' : '✗'}</span></div>
            <div class="meta-item"><span class="meta-label">CWD:</span> <span class="meta-value">\${agent.config?.cwd || '-'}</span></div>
            <div class="meta-item"><span class="meta-label">Last exit:</span> <span class="meta-value">\${agent.lastRun?.exit_code ?? '-'}</span></div>
          </div>
          <div class="agent-actions">
            <button class="btn btn-primary" onclick="startAgent('\${agent.agent_id}')">▶ Start</button>
            <button class="btn btn-danger" onclick="stopAgent('\${agent.agent_id}')">■ Stop</button>
            <button class="btn" onclick="runNow('\${agent.agent_id}')">⚡ Run Now</button>
            <input class="schedule-input" id="sched-\${agent.agent_id}" value="\${agent.schedule}" />
            <button class="btn" onclick="updateSchedule('\${agent.agent_id}')">Set</button>
          </div>
          \${agent.lastRun?.output ? \`
            <div class="output-section">
              <button class="output-toggle" onclick="toggleOutput('\${agent.agent_id}')">\${expandedOutputs.has(agent.agent_id) ? '▾' : '▸'} Last output</button>
              <pre class="output-content\${expandedOutputs.has(agent.agent_id) ? ' visible' : ''}" id="output-\${agent.agent_id}">\${escapeHtml(agent.lastRun.output)}</pre>
            </div>
          \` : ''}
        </div>
      \`).join('');
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    async function startAgent(id) { await fetch(\`/api/agents/\${id}/start\`, { method: 'POST' }); refresh(); }
    async function stopAgent(id) { await fetch(\`/api/agents/\${id}/stop\`, { method: 'POST' }); refresh(); }
    async function runNow(id) { await fetch(\`/api/agents/\${id}/run\`, { method: 'POST' }); refresh(); }
    async function openInCode() { await fetch('/api/open-editor', { method: 'POST' }); }
    async function updateSchedule(id) {
      const val = document.getElementById('sched-' + id).value;
      await fetch(\`/api/agents/\${id}/schedule\`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schedule: val}) });
      refresh();
    }
    function toggleOutput(id) {
      if (expandedOutputs.has(id)) {
        expandedOutputs.delete(id);
      } else {
        expandedOutputs.add(id);
      }
      document.getElementById('output-' + id).classList.toggle('visible');
    }

    async function refresh() {
      const agents = await fetchAgents();
      renderAgents(agents);
    }

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}
