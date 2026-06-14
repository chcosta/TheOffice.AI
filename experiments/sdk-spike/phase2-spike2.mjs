// Phase 2 spike (round 2): wire our installed agents into the SDK explicitly,
// since createSession({agent}) alone does NOT auto-discover them.
//
// Test 3: PROJECT agent (.github/agents/<x>.agent.md in the run cwd) parsed into
//         a CustomAgentConfig and run via createSession({ customAgents, agent }).
// Test 4: PLUGIN agent (Open-Plugins dir under ~/.copilot/.../plugins/<p>) loaded
//         via createSession({ pluginDirectories }). Tools DENIED (no execution).

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

const deny = () => ({ kind: "deny", message: "spike: suppressed" });

function parseAgentMd(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: path.basename(file), prompt: raw, tools: null };
  const fm = yaml.load(m[1]) || {};
  return {
    name: fm.name || path.basename(file).replace(/\.agent\.md$/, ""),
    displayName: fm.name,
    description: fm.description,
    tools: Array.isArray(fm.tools) ? fm.tools : null,
    prompt: (m[2] || "").trim() || "(no body)",
  };
}

async function test3() {
  console.log("\n=== TEST 3: project agent via parsed customAgents ===");
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
  await client.start();
  const id = randomUUID();
  let ok = false, detail = "";
  try {
    const cwd = "C:\\repos\\helix-observer";
    const file = path.join(cwd, ".github", "agents", "azure-status-observer.agent.md");
    const cfg = parseAgentMd(file);
    const session = await client.createSession({
      sessionId: id,
      customAgents: [cfg],
      agent: cfg.name,
      workingDirectory: cwd,
      onPermissionRequest: approveAll,
    });
    const res = await session.sendAndWait(
      { prompt: "Reply with exactly the single word PONG and take no other action. Do not call any tools." },
      120000
    );
    const events = await session.getEvents();
    const assistant = events.filter((e) => e.type === "assistant.message" && e.data?.content).map((e) => e.data.content);
    detail = `agentName=${JSON.stringify(cfg.name)} parsedTools=${JSON.stringify(cfg.tools)} promptLen=${cfg.prompt.length} replyType=${res?.type} reply=${JSON.stringify((assistant[0]||res?.data?.content||"").slice(0,60))}`;
    ok = !!(res && (assistant.length || res.data?.content));
    await session.disconnect();
  } catch (e) {
    detail = "ERROR: " + (e.message || String(e)).split("\n")[0];
  } finally {
    try { await client.deleteSession(id); } catch {}
    await client.stop();
  }
  console.log(ok ? "PASS" : "FAIL", "-", detail);
  return ok;
}

async function test4() {
  console.log("\n=== TEST 4: plugin agent via pluginDirectories (tools denied) ===");
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
  await client.start();
  const pluginRoot = path.join(os.homedir(), ".copilot", "agent-supervisor", "plugins", "markbot-dev");
  const candidates = ["markbot-dev:markbot-dev", "markbot-dev"];
  let ok = false, detail = "";
  for (const agentName of candidates) {
    const id = randomUUID();
    try {
      const session = await client.createSession({
        sessionId: id,
        pluginDirectories: [pluginRoot],
        agent: agentName,
        workingDirectory: "C:\\repos\\agent-scripts",
        onPermissionRequest: deny,
      });
      const res = await session.sendAndWait(
        { prompt: "Do NOT call any tools. Reply with exactly: READY" },
        120000
      );
      const events = await session.getEvents();
      const assistant = events.filter((e) => e.type === "assistant.message" && e.data?.content).map((e) => e.data.content);
      const mcpish = events.filter((e) => /mcp|tool/i.test(e.type)).length;
      detail = `resolvedAs=${JSON.stringify(agentName)} replyType=${res?.type} mcpish_events=${mcpish} reply=${JSON.stringify((assistant[0]||"").slice(0,80))}`;
      ok = !!(res && assistant.length);
      await session.disconnect();
      try { await client.deleteSession(id); } catch {}
      if (ok) break;
    } catch (e) {
      detail = `agent=${JSON.stringify(agentName)} ERROR: ` + (e.message || String(e)).split("\n")[0];
      try { await client.deleteSession(id); } catch {}
    }
  }
  await client.stop();
  console.log(ok ? "PASS" : "FAIL", "-", detail);
  return ok;
}

const t3 = await test3();
const t4 = await test4();
console.log("\n=== PHASE 2 SPIKE (round 2) SUMMARY ===");
console.log("Test 3 (project agent via customAgents):  ", t3 ? "PASS" : "FAIL");
console.log("Test 4 (plugin agent via pluginDirectories):", t4 ? "PASS" : "FAIL");
console.log(t3 && t4
  ? "\nVERDICT: Phase 2 is tractable — parse .github/agents into customAgents; load plugins via pluginDirectories."
  : "\nVERDICT: one or both wiring paths need more work (see details).");
