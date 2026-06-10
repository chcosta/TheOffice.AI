// Extension: manager-studio
// Interactive Manager Studio — Builder + Console for the manager orchestration system

import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map(); // instanceId → { server, url }
const API = "http://localhost:3847";

function renderPage() {
    return `<!doctype html>
<html data-color-mode="dark">
<head>
<meta charset="utf-8" />
<title>Manager Studio</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* Tabs */
.tab-bar {
    display: flex;
    gap: 0;
    background: var(--background-color-default, #010409);
    border-bottom: 1px solid var(--border-color-default, #30363d);
    flex-shrink: 0;
}
.tab {
    padding: 10px 20px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted, #8b949e);
    font-weight: 500;
    transition: all 0.15s;
}
.tab:hover { color: var(--text-color-default, #e6edf3); }
.tab.active {
    color: var(--text-color-default, #e6edf3);
    border-bottom-color: #58a6ff;
}
.tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
}
.tab-panel { display: none; height: 100%; }
.tab-panel.active { display: flex; flex-direction: column; gap: 16px; }

/* Cards */
.card {
    background: var(--background-color-default, #161b22);
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 8px;
    padding: 16px;
}
.card h3 {
    font-size: 15px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}
.badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
}
.badge-running { background: #1f6feb33; color: #58a6ff; }
.badge-idle { background: #23883033; color: #3fb950; }
.badge-error { background: #da363333; color: #f85149; }
.badge-done { background: #23883033; color: #3fb950; }

/* Lists */
.agent-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.agent-chip {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 16px;
    padding: 4px 12px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
}
.agent-chip .remove {
    cursor: pointer;
    color: #f85149;
    font-size: 14px;
    line-height: 1;
}

/* Assignments */
.assignment-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border: 1px solid #30363d;
    border-radius: 6px;
    margin-bottom: 8px;
}
.assignment-row .name { font-weight: 500; }
.assignment-row .schedule { color: #8b949e; font-size: 12px; }
.assignment-row .actions { display: flex; gap: 6px; }

/* Buttons */
.btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #30363d;
    background: #21262d;
    color: #e6edf3;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: background 0.15s;
}
.btn:hover { background: #30363d; }
.btn-primary { background: #238636; border-color: #2ea043; }
.btn-primary:hover { background: #2ea043; }
.btn-danger { background: #da3633; border-color: #f85149; }
.btn-danger:hover { background: #b62324; }
.btn-sm { padding: 4px 10px; font-size: 11px; }

/* Forms */
input, select, textarea {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px 12px;
    color: #e6edf3;
    font-size: 13px;
    width: 100%;
    font-family: inherit;
}
textarea { resize: vertical; min-height: 80px; }
select { cursor: pointer; }
label { font-size: 12px; color: #8b949e; margin-bottom: 4px; display: block; }
.form-group { margin-bottom: 12px; }

/* Console */
.console-log {
    font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
    font-size: 12px;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px;
    overflow-y: auto;
    flex: 1;
    min-height: 200px;
}
.log-entry { margin-bottom: 6px; padding: 4px 0; border-bottom: 1px solid #161b22; }
.log-entry .time { color: #484f58; margin-right: 8px; }
.log-entry .action { color: #58a6ff; }
.log-entry .agent { color: #d2a8ff; }
.log-entry .error { color: #f85149; }
.log-entry .result { color: #3fb950; }
.log-entry .output { color: #8b949e; white-space: pre-wrap; margin-top: 4px; padding-left: 16px; max-height: 200px; overflow-y: auto; }

/* Run detail panel */
.run-detail { display: flex; flex-direction: column; gap: 12px; flex: 1; }
.step-timeline { display: flex; flex-direction: column; gap: 4px; }
.step {
    padding: 8px 12px;
    border-left: 3px solid #30363d;
    background: #161b22;
    border-radius: 0 6px 6px 0;
}
.step.thinking { border-left-color: #d29922; }
.step.run_agent { border-left-color: #58a6ff; }
.step.agent_result { border-left-color: #3fb950; }
.step.complete { border-left-color: #a371f7; }
.step.error { border-left-color: #f85149; }

/* Split layout */
.split { display: flex; gap: 16px; flex: 1; min-height: 0; }
.split-left { flex: 1; overflow-y: auto; }
.split-right { flex: 1; overflow-y: auto; }

/* Toolbar */
.toolbar { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

/* Modal */
.modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
}
.modal {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 24px;
    min-width: 400px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
}
.modal h2 { margin-bottom: 16px; font-size: 18px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* Empty state */
.empty { text-align: center; color: #8b949e; padding: 32px; }
</style>
</head>
<body>
<div class="tab-bar">
    <div class="tab active" data-tab="builder">⚡ Builder</div>
    <div class="tab" data-tab="console">📋 Console</div>
    <div class="tab" data-tab="runs">🔄 Runs</div>
</div>
<div class="tab-content">
    <!-- BUILDER TAB -->
    <div class="tab-panel active" id="panel-builder">
        <div class="toolbar">
            <select id="manager-select" style="width: auto; flex:1;"><option value="">Loading managers...</option></select>
            <button class="btn btn-primary btn-sm" onclick="showNewManagerModal()">+ New Manager</button>
            <button class="btn btn-sm" onclick="refreshAll()">↻ Refresh</button>
        </div>

        <div id="manager-detail">
            <div class="empty">Select or create a manager to get started</div>
        </div>
    </div>

    <!-- CONSOLE TAB -->
    <div class="tab-panel" id="panel-console">
        <div class="toolbar">
            <span style="font-weight:500;">Live Console</span>
            <label style="display:flex;align-items:center;gap:4px;margin-left:auto;font-size:12px;">
                <input type="checkbox" id="console-auto-scroll" checked> Auto-scroll
            </label>
            <button class="btn btn-sm" onclick="clearConsole()">Clear</button>
        </div>
        <div class="console-log" id="console-log"></div>
    </div>

    <!-- RUNS TAB -->
    <div class="tab-panel" id="panel-runs">
        <div class="toolbar">
            <span style="font-weight:500;">Run History</span>
            <button class="btn btn-sm" onclick="loadRuns()">↻ Refresh</button>
        </div>
        <div id="runs-list"></div>
        <div id="run-detail-panel" style="display:none;margin-top:16px;">
            <div class="card run-detail" id="run-detail-content"></div>
        </div>
    </div>
</div>

<!-- Modal container -->
<div id="modal-root"></div>

<script>
const API = "${API}";
let managers = [];
let currentManager = null;
let consoleEntries = [];
let pollInterval = null;
let availableAgents = [];

// ===== Tab Navigation =====
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'runs') loadRuns();
    });
});

// ===== API Helpers =====
async function api(path, opts = {}) {
    const res = await fetch(API + path, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
    }
    return res.json().catch(() => null);
}

// ===== Manager Loading =====
async function loadManagers() {
    managers = await api('/api/managers');
    const sel = document.getElementById('manager-select');
    sel.innerHTML = '<option value="">— Select a manager —</option>' +
        managers.map(m => '<option value="' + m.manager_id + '"' +
            (currentManager?.manager_id === m.manager_id ? ' selected' : '') +
            '>' + (m.config?.name || m.manager_id) + '</option>').join('');
}

document.getElementById('manager-select').addEventListener('change', (e) => {
    const m = managers.find(x => x.manager_id === e.target.value);
    if (m) selectManager(m);
    else document.getElementById('manager-detail').innerHTML = '<div class="empty">Select or create a manager</div>';
});

async function selectManager(m) {
    currentManager = m;
    const cfg = m.config || {};
    const orgDetails = m.orgDetails || [];
    
    // Load available agents
    try { availableAgents = await api('/api/managers/' + m.manager_id + '/available-agents'); }
    catch(e) { availableAgents = []; }
    
    document.getElementById('manager-detail').innerHTML = \`
        <div class="card">
            <h3>\${cfg.name || cfg.id} <span class="badge badge-\${m.status}">\${m.status}</span></h3>
            <p style="color:#8b949e;font-size:13px;">\${cfg.description || 'No description'}</p>
            <div style="margin-top:12px; display:flex; gap:8px;">
                <button class="btn btn-sm \${m.status === 'running' ? 'btn-danger' : 'btn-primary'}" 
                    onclick="\${m.status === 'running' ? 'stopManager()' : 'startManager()'}">\${m.status === 'running' ? '⏹ Stop' : '▶ Start'}</button>
                <button class="btn btn-sm" onclick="deleteManager()">🗑 Delete</button>
            </div>
        </div>

        <div class="card">
            <h3>🤖 Organization (Agents)</h3>
            <div class="agent-list" id="org-agents">
                \${orgDetails.map(a => \`
                    <div class="agent-chip">
                        <span>\${a.name || a.id}</span>
                        <span class="badge badge-\${a.status}">\${a.status}</span>
                        <span class="remove" onclick="removeAgent('\${a.id}')">&times;</span>
                    </div>
                \`).join('')}
            </div>
            <div style="margin-top:10px; display:flex; gap:6px;">
                <select id="add-agent-select" style="width:auto; flex:1;">
                    <option value="">Add agent...</option>
                    \${availableAgents.filter(a => !cfg.org?.includes(a.id)).map(a =>
                        '<option value="' + a.id + '">' + (a.name || a.id) + '</option>'
                    ).join('')}
                </select>
                <button class="btn btn-sm btn-primary" onclick="addAgent()">Add</button>
            </div>
        </div>

        <div class="card">
            <h3>📋 Assignments</h3>
            <div id="assignments-list">
                \${(cfg.assignments || []).map(a => \`
                    <div class="assignment-row">
                        <div>
                            <div class="name">\${a.name || a.id}</div>
                            <div class="schedule">Schedule: \${a.schedule || 'manual'} | \${a.enabled ? '✅ Enabled' : '⏸ Disabled'}</div>
                            <div style="color:#8b949e;font-size:12px;margin-top:4px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${a.prompt}</div>
                        </div>
                        <div class="actions">
                            <button class="btn btn-sm btn-primary" onclick="runAssignment('\${a.id}')">▶ Run</button>
                            <button class="btn btn-sm" onclick="editAssignment('\${a.id}')">✏️</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteAssignment('\${a.id}')">🗑</button>
                        </div>
                    </div>
                \`).join('')}
                \${(cfg.assignments || []).length === 0 ? '<div class="empty">No assignments yet</div>' : ''}
            </div>
            <button class="btn btn-sm" style="margin-top:10px;" onclick="showNewAssignmentModal()">+ New Assignment</button>
        </div>
    \`;
}

// ===== Manager Actions =====
async function startManager() {
    await api('/api/managers/' + currentManager.manager_id + '/start', { method: 'POST' });
    await refreshAll();
    logConsole('action', 'Started manager: ' + currentManager.manager_id);
}

async function stopManager() {
    await api('/api/managers/' + currentManager.manager_id + '/stop', { method: 'POST' });
    await refreshAll();
    logConsole('action', 'Stopped manager: ' + currentManager.manager_id);
}

async function deleteManager() {
    if (!confirm('Delete manager "' + currentManager.config.name + '"?')) return;
    await api('/api/managers/' + currentManager.manager_id, { method: 'DELETE' });
    currentManager = null;
    await refreshAll();
}

async function addAgent() {
    const sel = document.getElementById('add-agent-select');
    if (!sel.value) return;
    await api('/api/managers/' + currentManager.manager_id + '/org', {
        method: 'POST', body: JSON.stringify({ agentId: sel.value })
    });
    logConsole('action', 'Added agent "' + sel.value + '" to org');
    await refreshAll();
}

async function removeAgent(agentId) {
    await api('/api/managers/' + currentManager.manager_id + '/org/' + agentId, { method: 'DELETE' });
    logConsole('action', 'Removed agent "' + agentId + '" from org');
    await refreshAll();
}

async function runAssignment(assignmentId) {
    const result = await api('/api/managers/' + currentManager.manager_id + '/assignments/' + assignmentId + '/run', { method: 'POST' });
    logConsole('action', 'Started assignment "' + assignmentId + '" → run #' + (result?.runId || '?'));
    startPolling(result?.runId);
}

async function deleteAssignment(assignmentId) {
    if (!confirm('Delete assignment "' + assignmentId + '"?')) return;
    await api('/api/managers/' + currentManager.manager_id + '/assignments/' + assignmentId, { method: 'DELETE' });
    await refreshAll();
}

// ===== Modals =====
function showModal(html) {
    document.getElementById('modal-root').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
            <div class="modal">\${html}</div>
        </div>\`;
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

function showNewManagerModal() {
    showModal(\`
        <h2>New Manager</h2>
        <div class="form-group"><label>Name</label><input id="nm-name" placeholder="My Manager"></div>
        <div class="form-group"><label>Description</label><input id="nm-desc" placeholder="What does this manager do?"></div>
        <div class="form-group"><label>Agent</label>
            <select id="nm-agent"><option value="">Loading...</option></select>
        </div>
        <div class="modal-actions">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="createManager()">Create</button>
        </div>
    \`);
    // Load manager agents
    api('/api/manager-agents').then(agents => {
        const sel = document.getElementById('nm-agent');
        sel.innerHTML = agents.map(a => '<option value="' + a.id + '">' + a.name + ' — ' + a.description + '</option>').join('');
    });
}

async function createManager() {
    const name = document.getElementById('nm-name').value.trim();
    const desc = document.getElementById('nm-desc').value.trim();
    const agent = document.getElementById('nm-agent').value;
    if (!name) return alert('Name required');
    await api('/api/managers', {
        method: 'POST',
        body: JSON.stringify({ id: name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), name, description: desc, agent })
    });
    closeModal();
    await refreshAll();
    logConsole('action', 'Created manager: ' + name);
}

function showNewAssignmentModal() {
    showModal(\`
        <h2>New Assignment</h2>
        <div class="form-group"><label>Name</label><input id="na-name" placeholder="monitor-azure"></div>
        <div class="form-group"><label>Prompt</label><textarea id="na-prompt" rows="4" placeholder="What should the manager do?"></textarea></div>
        <div class="form-group"><label>Schedule</label>
            <select id="na-schedule">
                <option value="">Manual only</option>
                <option value="5m">Every 5 minutes</option>
                <option value="15m">Every 15 minutes</option>
                <option value="1h">Every hour</option>
                <option value="6h">Every 6 hours</option>
                <option value="24h">Daily</option>
            </select>
        </div>
        <div class="modal-actions">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="createAssignment()">Create</button>
        </div>
    \`);
}

async function createAssignment() {
    const name = document.getElementById('na-name').value.trim();
    const prompt = document.getElementById('na-prompt').value.trim();
    const schedule = document.getElementById('na-schedule').value;
    if (!name || !prompt) return alert('Name and prompt required');
    await api('/api/managers/' + currentManager.manager_id + '/assignments', {
        method: 'POST',
        body: JSON.stringify({ id: name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), name, prompt, schedule, enabled: true })
    });
    closeModal();
    await refreshAll();
    logConsole('action', 'Created assignment: ' + name);
}

function editAssignment(assignmentId) {
    const cfg = currentManager.config;
    const a = cfg.assignments.find(x => x.id === assignmentId);
    if (!a) return;
    showModal(\`
        <h2>Edit Assignment: \${a.name}</h2>
        <div class="form-group"><label>Name</label><input id="ea-name" value="\${a.name}"></div>
        <div class="form-group"><label>Prompt</label><textarea id="ea-prompt" rows="4">\${a.prompt}</textarea></div>
        <div class="form-group"><label>Schedule</label>
            <select id="ea-schedule">
                <option value="" \${!a.schedule?'selected':''}>Manual only</option>
                <option value="5m" \${a.schedule==='5m'?'selected':''}>Every 5 minutes</option>
                <option value="15m" \${a.schedule==='15m'?'selected':''}>Every 15 minutes</option>
                <option value="1h" \${a.schedule==='1h'?'selected':''}>Every hour</option>
                <option value="6h" \${a.schedule==='6h'?'selected':''}>Every 6 hours</option>
                <option value="24h" \${a.schedule==='24h'?'selected':''}>Daily</option>
            </select>
        </div>
        <div class="form-group"><label><input type="checkbox" id="ea-enabled" \${a.enabled?'checked':''}> Enabled</label></div>
        <div class="modal-actions">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveAssignment('\${assignmentId}')">Save</button>
        </div>
    \`);
}

async function saveAssignment(assignmentId) {
    // Delete and recreate (API doesn't have PUT)
    await api('/api/managers/' + currentManager.manager_id + '/assignments/' + assignmentId, { method: 'DELETE' });
    await api('/api/managers/' + currentManager.manager_id + '/assignments', {
        method: 'POST',
        body: JSON.stringify({
            id: assignmentId,
            name: document.getElementById('ea-name').value.trim(),
            prompt: document.getElementById('ea-prompt').value.trim(),
            schedule: document.getElementById('ea-schedule').value,
            enabled: document.getElementById('ea-enabled').checked
        })
    });
    closeModal();
    await refreshAll();
}

// ===== Console =====
function logConsole(type, msg, detail) {
    const time = new Date().toLocaleTimeString();
    consoleEntries.push({ time, type, msg, detail });
    if (consoleEntries.length > 500) consoleEntries.shift();
    renderConsole();
}

function renderConsole() {
    const el = document.getElementById('console-log');
    el.innerHTML = consoleEntries.map(e => \`
        <div class="log-entry">
            <span class="time">\${e.time}</span>
            <span class="\${e.type}">\${e.msg}</span>
            \${e.detail ? '<div class="output">' + escapeHtml(e.detail) + '</div>' : ''}
        </div>
    \`).join('');
    if (document.getElementById('console-auto-scroll').checked) {
        el.scrollTop = el.scrollHeight;
    }
}

function clearConsole() { consoleEntries = []; renderConsole(); }

// ===== Run Polling =====
function startPolling(runId) {
    if (pollInterval) clearInterval(pollInterval);
    if (!currentManager || !runId) return;
    const mgId = currentManager.manager_id;
    
    pollInterval = setInterval(async () => {
        try {
            const run = await api('/api/managers/' + mgId + '/runs/' + runId);
            if (!run) return;
            
            const steps = JSON.parse(run.steps || '[]');
            steps.forEach(step => {
                const key = step.timestamp + step.action;
                if (!consoleEntries.find(e => e._key === key)) {
                    const entry = { time: new Date(step.timestamp).toLocaleTimeString(), type: step.action === 'error' ? 'error' : step.action === 'agent_result' ? 'result' : 'agent', msg: '', _key: key };
                    if (step.action === 'thinking') entry.msg = '💭 Manager is thinking...';
                    else if (step.action === 'run_agent') entry.msg = '🚀 Running agent: ' + step.agentId;
                    else if (step.action === 'agent_result') { entry.msg = '✅ Result from ' + step.agentId + ' (exit: ' + step.exitCode + ')'; entry.detail = step.output?.substring(0, 500); }
                    else entry.msg = step.action + (step.agentId ? ': ' + step.agentId : '');
                    consoleEntries.push(entry);
                    renderConsole();
                }
            });
            
            if (run.status !== 'running') {
                clearInterval(pollInterval);
                pollInterval = null;
                logConsole('result', '🏁 Run #' + runId + ' finished: ' + run.status, run.result?.substring(0, 300));
                await refreshAll();
            }
        } catch(e) { /* ignore poll errors */ }
    }, 2000);
}

// ===== Runs Tab =====
async function loadRuns() {
    if (!currentManager) {
        document.getElementById('runs-list').innerHTML = '<div class="empty">Select a manager first</div>';
        return;
    }
    const history = await api('/api/managers/' + currentManager.manager_id + '/history?limit=20');
    document.getElementById('runs-list').innerHTML = (history || []).map(r => \`
        <div class="assignment-row" style="cursor:pointer;" onclick="showRunDetail(\${r.id})">
            <div>
                <div class="name">Run #\${r.id} <span class="badge badge-\${r.status}">\${r.status}</span></div>
                <div class="schedule">\${r.assignment_id || 'ad-hoc'} — \${new Date(r.started_at).toLocaleString()}</div>
            </div>
            <div class="actions">
                <button class="btn btn-sm" onclick="event.stopPropagation();showRunDetail(\${r.id})">View</button>
            </div>
        </div>
    \`).join('') || '<div class="empty">No runs yet</div>';
}

async function showRunDetail(runId) {
    const run = await api('/api/managers/' + currentManager.manager_id + '/runs/' + runId);
    if (!run) return;
    const steps = JSON.parse(run.steps || '[]');
    const panel = document.getElementById('run-detail-panel');
    panel.style.display = 'block';
    document.getElementById('run-detail-content').innerHTML = \`
        <h3>Run #\${run.id} <span class="badge badge-\${run.status}">\${run.status}</span></h3>
        <div style="color:#8b949e;font-size:12px;">
            Started: \${new Date(run.started_at).toLocaleString()}
            \${run.finished_at ? ' | Finished: ' + new Date(run.finished_at).toLocaleString() : ''}
        </div>
        <div style="color:#8b949e;font-size:12px;margin-top:4px;">Prompt: \${escapeHtml(run.prompt?.substring(0,200) || '')}</div>
        <div class="step-timeline" style="margin-top:12px;">
            \${steps.map(s => \`
                <div class="step \${s.action}">
                    <div style="display:flex;justify-content:space-between;">
                        <span><strong>\${s.action}</strong>\${s.agentId ? ' → ' + s.agentId : ''}</span>
                        <span style="color:#484f58;font-size:11px;">\${new Date(s.timestamp).toLocaleTimeString()}</span>
                    </div>
                    \${s.prompt ? '<div style="color:#8b949e;font-size:12px;margin-top:4px;max-height:100px;overflow:auto;">' + escapeHtml(s.prompt.substring(0,300)) + '</div>' : ''}
                    \${s.output ? '<div style="color:#3fb950;font-size:12px;margin-top:4px;max-height:200px;overflow:auto;white-space:pre-wrap;">' + escapeHtml(s.output.substring(0,1000)) + '</div>' : ''}
                </div>
            \`).join('')}
        </div>
        \${run.result ? '<div class="card" style="margin-top:12px;background:#0d1117;"><h3>Result</h3><div style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(run.result.substring(0,2000)) + '</div></div>' : ''}
    \`;
}

// ===== Utilities =====
function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function refreshAll() {
    await loadManagers();
    if (currentManager) {
        const m = managers.find(x => x.manager_id === currentManager.manager_id);
        if (m) await selectManager(m);
        else { currentManager = null; document.getElementById('manager-detail').innerHTML = '<div class="empty">Manager not found</div>'; }
    }
}

// ===== Init =====
refreshAll();
logConsole('action', 'Manager Studio connected');

// Auto-detect running runs
if (managers.length > 0) {
    const running = managers.find(m => m.lastRun?.status === 'running');
    if (running) {
        currentManager = running;
        startPolling(running.lastRun.id);
    }
}
</script>
</body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderPage());
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    return { server, url };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "manager-studio",
            displayName: "Manager Studio",
            description: "Interactive dashboard for building, configuring, and debugging manager orchestration agents. View/edit managers, wire agents, create assignments, run them, and inspect live output.",
            actions: [
                {
                    name: "refresh",
                    description: "Trigger a refresh of the canvas data",
                    handler: async (ctx) => {
                        return { refreshed: true };
                    },
                },
                {
                    name: "run_assignment",
                    description: "Run a specific assignment on the currently selected manager",
                    inputSchema: {
                        type: "object",
                        properties: {
                            managerId: { type: "string", description: "Manager ID" },
                            assignmentId: { type: "string", description: "Assignment ID to run" },
                        },
                        required: ["managerId", "assignmentId"],
                    },
                    handler: async (ctx) => {
                        const { managerId, assignmentId } = ctx.input;
                        const res = await fetch(`${API}/api/managers/${managerId}/assignments/${assignmentId}/run`, { method: "POST" });
                        const data = await res.json();
                        return data;
                    },
                },
                {
                    name: "send_prompt",
                    description: "Send an ad-hoc prompt to a manager",
                    inputSchema: {
                        type: "object",
                        properties: {
                            managerId: { type: "string", description: "Manager ID" },
                            prompt: { type: "string", description: "Prompt text" },
                        },
                        required: ["managerId", "prompt"],
                    },
                    handler: async (ctx) => {
                        const { managerId, prompt } = ctx.input;
                        const res = await fetch(`${API}/api/managers/${managerId}/prompt`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ prompt }),
                        });
                        const data = await res.json();
                        return data;
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Manager Studio", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((r) => entry.server.close(() => r()));
                }
            },
        }),
    ],
});
