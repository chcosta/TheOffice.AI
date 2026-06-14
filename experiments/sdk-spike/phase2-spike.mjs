// Phase 2 spike — the make-or-break question:
// Can the SDK (default mode:"copilot-cli") create a session that resolves an
// INSTALLED agent by name (like the CLI's --agent) and run it, WITHOUT us
// re-implementing the CLI's config/plugin discovery?
//
// Test 1: plain installed agent ("Azure Status Observer", read-only) via
//         createSession({ agent }). Benign PONG prompt.
// Test 2: plugin agent that needs an MCP server ("markbot-dev:markbot-dev").
//         We DENY all tool calls so nothing executes; we only check the session
//         starts, the agent resolves, and MCP tools are registered.

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";

const deny = () => ({ kind: "deny", message: "spike: tool execution suppressed" });

async function test1() {
  console.log("\n=== TEST 1: installed agent resolution via createSession({agent}) ===");
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
  await client.start();
  const id = randomUUID();
  let ok = false, detail = "";
  try {
    const session = await client.createSession({
      sessionId: id,
      agent: "Azure Status Observer",
      workingDirectory: "C:\\repos\\helix-observer",
      onPermissionRequest: approveAll,
    });
    const res = await session.sendAndWait(
      { prompt: "Reply with exactly the single word PONG and take no other action. Do not call any tools." },
      120000
    );
    const events = await session.getEvents();
    const sel = events.find((e) => e.type === "subagent.selected" || e.type === "agent.selected");
    const assistant = events.filter((e) => e.type === "assistant.message" && e.data?.content).map((e) => e.data.content);
    detail = `replyType=${res?.type} assistantParts=${assistant.length} firstReply=${JSON.stringify((assistant[0]||res?.data?.content||"").slice(0,60))} selectedEvent=${sel ? JSON.stringify(sel.data).slice(0,120) : "none"}`;
    ok = !!(res && (assistant.length > 0 || res.data?.content));
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

async function test2() {
  console.log("\n=== TEST 2: plugin agent + MCP server spawn (tools DENIED) ===");
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
  await client.start();
  const id = randomUUID();
  let ok = false, detail = "";
  try {
    const session = await client.createSession({
      sessionId: id,
      agent: "markbot-dev:markbot-dev",
      workingDirectory: "C:\\repos\\agent-scripts",
      onPermissionRequest: deny,
    });
    // Ask it to just NAME a tool it has, so the model reveals tool availability
    // without us auto-approving any execution.
    const res = await session.sendAndWait(
      { prompt: "Do NOT call any tools. In one short sentence, list the names of the tools/MCP functions you have available." },
      120000
    );
    const events = await session.getEvents();
    const toolEvents = events.filter((e) => /tool|mcp/i.test(e.type));
    const assistant = events.filter((e) => e.type === "assistant.message" && e.data?.content).map((e) => e.data.content);
    detail = `replyType=${res?.type} assistantParts=${assistant.length} toolish_events=${toolEvents.length} reply=${JSON.stringify((assistant[0]||"").slice(0,160))}`;
    ok = !!(res && assistant.length > 0);
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

const t1 = await test1();
const t2 = await test2();
console.log("\n=== PHASE 2 SPIKE SUMMARY ===");
console.log("Test 1 (installed agent resolves):", t1 ? "PASS" : "FAIL");
console.log("Test 2 (plugin agent + MCP):      ", t2 ? "PASS" : "FAIL");
console.log(t1 && t2
  ? "\nVERDICT: SDK resolves installed agents/plugins in default mode — Phase 2 is a direct swap."
  : "\nVERDICT: SDK does NOT fully auto-resolve our installed config — Phase 2 needs explicit agent/plugin wiring (bigger).");
