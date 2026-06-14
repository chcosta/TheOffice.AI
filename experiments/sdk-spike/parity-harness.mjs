// Phase 1 parity harness: does SDK getEvents() reproduce the events.jsonl
// scraper output for the SAME session id, over real historical sessions?
// Compares assistant-message extraction (joined by \n\n---\n\n) both ways.
//
// Usage: node parity-harness.mjs [N]   (default N=40 most-recent sessions)

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const N = parseInt(process.argv[2] || "40", 10);
const SEP = "\n\n---\n\n";
const STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

// Mirror supervisor.js mojibake repair just enough to compare fairly.
function repairMojibake(s) {
  if (!s || !/[\u00C0-\u00FF\u0080-\u00BF]/.test(s)) return s;
  try { return Buffer.from(s, "latin1").toString("utf8"); } catch { return s; }
}

function scrapeJsonl(sessionId) {
  const p = path.join(STATE_DIR, sessionId, "events.jsonl");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const parts = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant.message" && ev.data?.content) parts.push(ev.data.content);
    } catch {}
  }
  return parts.join(SEP);
}

function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }

const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
await client.start();

const all = await client.listSessions();
all.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
const sample = all.slice(0, N);
console.log(`Comparing ${sample.length} of ${all.length} sessions...\n`);

let exact = 0, repairedMatch = 0, sdkRicher = 0, scrapeMissing = 0, sdkError = 0, bothEmpty = 0;
const mismatches = [];

for (const meta of sample) {
  const id = meta.sessionId;
  const jsonlRaw = scrapeJsonl(id);
  if (jsonlRaw === null) scrapeMissing++;
  let sdkOut = null, evCount = 0;
  let session = null;
  try {
    session = await client.resumeSession(id, { onPermissionRequest: approveAll });
    const events = await session.getEvents();
    evCount = events.length;
    sdkOut = events.filter((e) => e.type === "assistant.message" && e.data?.content)
                   .map((e) => e.data.content).join(SEP);
  } catch (e) {
    sdkError++;
    mismatches.push({ id, kind: "sdk-error", error: String(e).split("\n")[0] });
    continue;
  } finally { if (session) { try { await session.disconnect(); } catch {} } }

  const jsonl = jsonlRaw ?? "";
  if (!jsonl && !sdkOut) { bothEmpty++; continue; }

  if (jsonl === sdkOut) { exact++; }
  else if (repairMojibake(jsonl) === sdkOut) { repairedMatch++; }
  else if (norm(sdkOut).includes(norm(jsonl)) || norm(jsonl) === norm(sdkOut)) { repairedMatch++; }
  else if (sdkOut && norm(sdkOut).length >= norm(jsonl).length) { sdkRicher++; }
  else {
    mismatches.push({
      id, kind: "diff", evCount,
      jsonlLen: jsonl.length, sdkLen: sdkOut.length,
      jsonlTail: norm(jsonl).slice(-120), sdkTail: norm(sdkOut).slice(-120),
    });
  }
}

await client.stop();

const total = sample.length;
const ok = exact + repairedMatch + sdkRicher + bothEmpty;
console.log("=== PARITY RESULTS ===");
console.log(`exact match (byte-identical):      ${exact}`);
console.log(`match after mojibake/normalize:    ${repairedMatch}`);
console.log(`SDK richer/cleaner (>= scraper):   ${sdkRicher}`);
console.log(`both empty:                        ${bothEmpty}`);
console.log(`scraper file missing (SDK-only):   ${scrapeMissing}`);
console.log(`SDK read error:                    ${sdkError}`);
console.log(`unreconciled diffs:                ${mismatches.filter(m=>m.kind==='diff').length}`);
console.log(`\nPARITY: ${ok}/${total} reconciled (${((ok/total)*100).toFixed(1)}%)`);
if (mismatches.length) {
  console.log("\n--- sample mismatches (first 8) ---");
  for (const m of mismatches.slice(0, 8)) console.log(JSON.stringify(m));
}
fs.writeFileSync("parity-results.json",
  JSON.stringify({ total, exact, repairedMatch, sdkRicher, bothEmpty, scrapeMissing, sdkError, mismatches }, null, 2));
