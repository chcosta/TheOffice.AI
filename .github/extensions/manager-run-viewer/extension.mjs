// Extension: manager-run-viewer
// Live viewer for manager orchestration runs — shows real-time steps, agent output, and status

import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map(); // instanceId → { server, url, state }
const SERVER_BASE = "http://localhost:3847";

function renderHtml(instanceId, state) {
    const { managerId, runId } = state;
    return `<!doctype html>
<html data-color-mode="dark">
<head>
<meta charset="utf-8" />
<title>Run Viewer</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    padding: 16px;
    height: 100vh;
    overflow-y: auto;
}
h1 {
    font-size: var(--text-title-large, 20px);
    font-weight: var(--font-weight-semibold, 600);
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
}
.status {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}
.status.running { background: #1f6feb33; color: #58a6ff; }
.status.completed { background: #23863633; color: #3fb950; }
.status.error { background: #da363333; color: #f85149; }
.prompt {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
    color: #8b949e;
    font-style: italic;
}
.step {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px;
    border-left: 3px solid #30363d;
    margin-left: 8px;
    margin-bottom: 4px;
    transition: border-color 0.2s;
}
.step.thinking { border-color: #58a6ff; }
.step.run_agent { border-color: #d29922; }
.step.agent_result { border-color: #3fb950; }
.step.complete { border-color: #3fb950; }
.step.error { border-color: #f85149; }
.step-icon { font-size: 18px; flex-shrink: 0; }
.step-body { flex: 1; min-width: 0; }
.step-label { font-weight: 600; margin-bottom: 2px; }
.step-time { color: #484f58; font-size: 11px; margin-left: 8px; }
.step-detail { color: #8b949e; font-size: 13px; word-break: break-word; }
.output-block {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 6px;
    max-height: 300px;
    overflow-y: auto;
    font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    color: #c9d1d9;
}
.result-block {
    background: #0d1117;
    border: 1px solid #238636;
    border-radius: 8px;
    padding: 16px;
    margin-top: 16px;
}
.result-block h3 { color: #3fb950; margin-bottom: 8px; }
.spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid #30363d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }
#steps-container { margin-top: 8px; }
</style>
</head>
<body>
<h1>
    <span>🔄 Manager Run</span>
    <span id="status-badge" class="status running">loading...</span>
</h1>
<div class="prompt" id="prompt-text">Loading...</div>
<div id="steps-container"></div>
<div id="result-container"></div>

<script>
const MANAGER_ID = "${managerId}";
let RUN_ID = ${runId ? `"${runId}"` : "null"};
const API = "${SERVER_BASE}";
let pollTimer = null;

async function loadRun() {
    if (!RUN_ID) {
        // Find latest run
        const res = await fetch(API + "/api/managers/" + MANAGER_ID + "/history?limit=1");
        const runs = await res.json();
        if (runs.length > 0) RUN_ID = runs[0].id;
        else { document.getElementById("prompt-text").textContent = "No runs found"; return; }
    }
    poll();
}

async function poll() {
    try {
        const res = await fetch(API + "/api/managers/" + MANAGER_ID + "/runs/" + RUN_ID);
        const run = await res.json();
        render(run);
        if (run.status === "running") {
            pollTimer = setTimeout(poll, 1500);
        }
    } catch (e) {
        document.getElementById("status-badge").textContent = "error";
        document.getElementById("status-badge").className = "status error";
    }
}

function render(run) {
    const badge = document.getElementById("status-badge");
    badge.textContent = run.status;
    badge.className = "status " + run.status;

    document.getElementById("prompt-text").textContent = run.prompt || "";

    const container = document.getElementById("steps-container");
    const steps = run.steps || [];
    container.innerHTML = steps.map(renderStep).join("");

    const resultEl = document.getElementById("result-container");
    if (run.status === "completed" && run.result) {
        resultEl.innerHTML = '<div class="result-block"><h3>✅ Result</h3><div style="white-space:pre-wrap">' + escapeHtml(run.result) + '</div></div>';
    } else if (run.status === "error" && run.result) {
        resultEl.innerHTML = '<div class="result-block" style="border-color:#f85149"><h3>❌ Error</h3><div style="white-space:pre-wrap">' + escapeHtml(run.result) + '</div></div>';
    } else if (run.status === "running") {
        resultEl.innerHTML = '<div style="color:#58a6ff;margin-top:16px"><span class="spinner"></span> Running...</div>';
    } else {
        resultEl.innerHTML = "";
    }
}

function renderStep(step) {
    const icons = { thinking: "🧠", run_agent: "▶️", agent_result: "📋", complete: "🏁", error: "❌", request_agent: "🔍" };
    const icon = icons[step.action] || "•";
    const time = step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : "";
    let label = step.action;
    let detail = "";

    if (step.action === "thinking") { label = "Analyzing"; detail = "Manager is thinking..."; }
    else if (step.action === "run_agent") { label = "Running " + step.agentId; detail = step.prompt || ""; }
    else if (step.action === "agent_result") {
        label = step.agentId + " returned";
        detail = "Exit code: " + step.exitCode + " | Output: " + (step.outputLength || 0) + " chars";
        if (step.output) detail += '<div class="output-block">' + escapeHtml(step.output.substring(0, 3000)) + '</div>';
    }
    else if (step.action === "complete") { label = "Complete"; }
    else if (step.action === "error") { label = "Error"; detail = step.message || ""; }
    else if (step.action === "request_agent") { label = "Requesting " + step.agentId; detail = step.reason || ""; }

    return '<div class="step ' + step.action + '">' +
        '<span class="step-icon">' + icon + '</span>' +
        '<div class="step-body">' +
            '<div class="step-label">' + escapeHtml(label) + '<span class="step-time">' + time + '</span></div>' +
            '<div class="step-detail">' + detail + '</div>' +
        '</div></div>';
}

function escapeHtml(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

loadRun();
</script>
</body>
</html>`;
}

async function startServer(instanceId, state) {
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml(instanceId, state));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, state };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "manager-run-viewer",
            displayName: "Manager Run Viewer",
            description: "Live viewer for manager orchestration runs showing real-time steps, agent output, and completion status. Open to watch a running or completed manager run.",
            inputSchema: {
                type: "object",
                properties: {
                    managerId: { type: "string", description: "Manager ID to view runs for" },
                    runId: { type: "string", description: "Specific run ID to view (optional, shows latest if omitted)" }
                },
                required: ["managerId"]
            },
            actions: [
                {
                    name: "refresh",
                    description: "Force refresh the run viewer to show latest state",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) return { ok: false, error: "No active viewer" };
                        return { ok: true, message: "Viewer will auto-refresh via polling" };
                    },
                },
                {
                    name: "view_run",
                    description: "Switch the viewer to display a specific run",
                    inputSchema: {
                        type: "object",
                        properties: {
                            runId: { type: "string", description: "Run ID to view" }
                        },
                        required: ["runId"]
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) return { ok: false, error: "No active viewer" };
                        entry.state.runId = ctx.input.runId;
                        return { ok: true, message: `Switched to run ${ctx.input.runId}` };
                    },
                },
            ],
            open: async (ctx) => {
                const state = {
                    managerId: ctx.input?.managerId || "helix-ops-manager",
                    runId: ctx.input?.runId || null,
                };
                let entry = servers.get(ctx.instanceId);
                if (entry) {
                    // Update state and reuse server
                    entry.state = state;
                } else {
                    entry = await startServer(ctx.instanceId, state);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: `Run Viewer — ${state.managerId}`,
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
