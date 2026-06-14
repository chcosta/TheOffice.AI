// Phase 0 spike for @github/copilot-sdk migration.
// THROWAWAY / DIAGNOSTIC ONLY. Not wired into the server.
// Validates: 0A auth-in-context, 0B SDK-created session E2E,
// 0C can the SDK read a CLI-created session (gates Phase 1), 0D flag map notes.
//
// Usage:  node run-spike.mjs            (runs 0A,0B,0C)
//         node run-spike.mjs 0a 0b      (runs a subset)
//
// Keep it isolated: by default uses the real ~/.copilot COPILOT_HOME so that 0C
// reflects production behavior. Pass --isolated to use a scratch baseDirectory
// (then 0C cannot see production CLI sessions — only sessions this script makes).

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const argv = process.argv.slice(2);
const isolated = argv.includes("--isolated");
const phases = argv.filter((a) => /^0[a-d]$/i.test(a)).map((a) => a.toLowerCase());
const want = (p) => phases.length === 0 || phases.includes(p);

const findings = { startedAt: new Date().toISOString(), node: process.version, env: {}, phases: {} };
const log = (...a) => console.log(...a);
const section = (t) => log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);

const baseDirectory = isolated
  ? path.join(os.tmpdir(), `sdk-spike-home-${Date.now()}`)
  : undefined; // undefined => SDK default (~/.copilot), shared with the CLI

findings.env = {
  isolated,
  baseDirectory: baseDirectory || path.join(os.homedir(), ".copilot (default)"),
  COPILOT_HOME: process.env.COPILOT_HOME || "(unset -> ~/.copilot)",
  USERPROFILE: process.env.USERPROFILE,
  USERNAME: process.env.USERNAME,
  COPILOT_PATH: process.env.COPILOT_PATH || "(unset -> 'copilot' on PATH)",
};
log("Spike config:", JSON.stringify(findings.env, null, 2));

function newClient() {
  return new CopilotClient({
    ...(baseDirectory ? { baseDirectory } : {}),
    useLoggedInUser: true,
    logLevel: process.env.SDK_LOG_LEVEL || "warning",
  });
}

// ---- 0A: auth in our process context -------------------------------------
async function phase0A(client) {
  section("0A  Auth / runtime status in this process context");
  const out = {};
  try {
    out.started = true;
    out.status = await client.getStatus();
    out.auth = await client.getAuthStatus();
    log("status:", JSON.stringify(out.status));
    log("auth:", JSON.stringify(out.auth));
    out.ok = !!out.auth?.isAuthenticated;
    out.verdict = out.ok
      ? `AUTHENTICATED as ${out.auth.login} via ${out.auth.authType}`
      : "NOT AUTHENTICATED in this context (useLoggedInUser did not pick up a login)";
  } catch (e) {
    out.ok = false;
    out.error = String(e?.stack || e);
    out.verdict = "FAILED to start/authenticate runtime";
  }
  log("VERDICT 0A:", out.verdict);
  findings.phases["0A"] = out;
  return out;
}

// ---- 0B: SDK-created session end to end ----------------------------------
async function phase0B(client) {
  section("0B  SDK-created session E2E (explicit sessionId, stream + getEvents)");
  const out = { sessionId: randomUUID() };
  const counts = { delta: 0, message: 0, idle: 0, error: 0, other: 0 };
  try {
    const session = await client.createSession({
      sessionId: out.sessionId,
      onPermissionRequest: approveAll,
    });
    out.created = true;
    out.workspacePath = session.workspacePath || null;
    session.on((ev) => {
      switch (ev.type) {
        case "assistant.message_delta": counts.delta++; break;
        case "assistant.message": counts.message++; break;
        case "session.idle": counts.idle++; break;
        case "session.error": counts.error++; log("  session.error:", JSON.stringify(ev.data)); break;
        default: counts.other++;
      }
    });
    const t0 = Date.now();
    const final = await session.sendAndWait(
      { prompt: "Reply with exactly the single word: pong" },
      120000
    );
    out.elapsedMs = Date.now() - t0;
    out.finalText = final?.data?.content ?? null;
    out.streamCounts = counts;
    const events = await session.getEvents();
    out.eventCount = events.length;
    out.eventTypes = [...new Set(events.map((e) => e.type))];
    log("final text:", JSON.stringify(out.finalText));
    log("stream counts:", JSON.stringify(counts));
    log(`getEvents(): ${out.eventCount} events, types: ${out.eventTypes.join(", ")}`);
    out.ok = !!out.finalText && counts.idle > 0;
    out.verdict = out.ok
      ? `SDK session works (${counts.delta} deltas streamed, ${out.eventCount} events readable)`
      : "SDK session did not complete as expected";
    await session.disconnect();
  } catch (e) {
    out.ok = false;
    out.error = String(e?.stack || e);
    out.verdict = "FAILED SDK-created session E2E";
  }
  log("VERDICT 0B:", out.verdict);
  findings.phases["0B"] = out;
  return out;
}

// ---- 0C: can the SDK read a CLI-created session? (THE GATE) ---------------
function runRawCli(sessionId) {
  return new Promise((resolve) => {
    const copilotCmd = process.env.COPILOT_PATH || "copilot";
    // Mirror production flags (minus --agent so we don't depend on a named agent):
    //   --prompt <text> --session-id <uuid> -s --yolo
    const args = [
      "--prompt", "Reply with exactly the single word: ping",
      "--session-id", sessionId,
      "-s",
      "--yolo",
    ];
    const useShell = process.platform === "win32";
    // Under shell:true on win32 the args are concatenated unescaped, so quote
    // the prompt exactly like supervisor.js does, otherwise the CLI mis-parses.
    const shellArgs = useShell
      ? [
          "--prompt", `"${"Reply with exactly the single word: ping".replace(/"/g, '\\"')}"`,
          "--session-id", `"${sessionId}"`,
          "-s",
          "--yolo",
        ]
      : args;
    log(`  spawning raw CLI: ${copilotCmd} ${shellArgs.join(" ")}`);
    const proc = spawn(copilotCmd, shellArgs, {
      shell: useShell,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

async function phase0C(client) {
  section("0C  Can the SDK SEE + READ a CLI-created session? (gates Phase 1)");
  const out = { sessionId: randomUUID() };
  if (isolated) {
    out.skipped = "running --isolated: SDK home differs from CLI home, 0C is moot";
    log(out.skipped);
    findings.phases["0C"] = out;
    return out;
  }
  try {
    const cli = await runRawCli(out.sessionId);
    out.cliExit = cli.code;
    out.cliStdoutTail = cli.stdout.slice(-300);
    out.cliStderrTail = cli.stderr.slice(-300);
    log(`  raw CLI exit=${cli.code}`);

    // 1) Direct metadata lookup by id
    let meta;
    try { meta = await client.getSessionMetadata(out.sessionId); } catch (e) { out.metaError = String(e); }
    out.sdkSeesViaMetadata = !!meta;
    log("  getSessionMetadata():", meta ? "FOUND" : "not found");

    // 2) listSessions enumeration
    let list = [];
    try { list = await client.listSessions(); } catch (e) { out.listError = String(e); }
    out.sdkListCount = list.length;
    out.sdkSeesViaList = list.some((s) => s.sessionId === out.sessionId);
    log(`  listSessions(): ${list.length} sessions; contains ours = ${out.sdkSeesViaList}`);

    // 3) resume + read history (the real capability we need for Phase 1)
    if (out.sdkSeesViaMetadata || out.sdkSeesViaList) {
      try {
        const resumed = await client.resumeSession(out.sessionId, { onPermissionRequest: approveAll });
        const events = await resumed.getEvents();
        out.resumeOk = true;
        out.resumedEventCount = events.length;
        out.resumedEventTypes = [...new Set(events.map((e) => e.type))];
        const lastAssistant = [...events].reverse().find((e) => e.type === "assistant.message");
        out.readBackText = lastAssistant?.data?.content ?? null;
        log(`  resumeSession+getEvents(): ${events.length} events, last assistant: ${JSON.stringify(out.readBackText)}`);
        await resumed.disconnect();
      } catch (e) {
        out.resumeOk = false;
        out.resumeError = String(e?.stack || e);
        log("  resume/getEvents FAILED:", out.resumeError);
      }
    }

    out.ok = !!(out.sdkSeesViaMetadata || out.sdkSeesViaList) && out.resumeOk === true && out.resumedEventCount > 0;
    out.verdict = out.ok
      ? "YES — SDK can read CLI-created sessions. Layer-first read migration (Phase 1 'keep spawn, read via SDK') is VIABLE."
      : "NO — SDK cannot reliably read CLI-created sessions. Must migrate spawn+read together per surface; do NOT do layer-first.";
  } catch (e) {
    out.ok = false;
    out.error = String(e?.stack || e);
    out.verdict = "0C errored";
  }
  log("VERDICT 0C:", out.verdict);
  findings.phases["0C"] = out;
  return out;
}

async function main() {
  const client = newClient();
  try {
    await client.start();
    if (want("0a")) await phase0A(client);
    if (want("0b")) await phase0B(client);
    if (want("0c")) await phase0C(client);
  } finally {
    try { await client.stop(); } catch (e) { log("stop() error:", String(e)); }
  }
  findings.finishedAt = new Date().toISOString();
  const outFile = path.join(process.cwd(), "spike-findings.json");
  fs.writeFileSync(outFile, JSON.stringify(findings, null, 2), "utf8");
  section("SUMMARY");
  for (const [k, v] of Object.entries(findings.phases)) {
    log(`${k}: ${v.ok ? "PASS" : v.skipped ? "SKIP" : "FAIL"} — ${v.verdict || v.skipped || ""}`);
  }
  log(`\nFindings written to ${outFile}`);
}

main().catch((e) => { console.error("SPIKE CRASHED:", e); process.exit(1); });
