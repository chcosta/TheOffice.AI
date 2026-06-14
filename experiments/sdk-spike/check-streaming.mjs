// Quick check: do assistant.message_delta events actually stream for a longer
// reply? The manager live-stream UX depends on incremental deltas.
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";

const client = new CopilotClient({ useLoggedInUser: true, logLevel: "warning" });
await client.start();
const session = await client.createSession({ sessionId: randomUUID(), onPermissionRequest: approveAll, streaming: true });

let deltas = 0, firstDeltaAt = null, lastLen = 0;
const t0 = Date.now();
session.on("assistant.message_delta", (ev) => {
  deltas++;
  if (!firstDeltaAt) firstDeltaAt = Date.now() - t0;
  const txt = ev?.data?.deltaContent ?? ev?.data?.content ?? ev?.data?.delta ?? "";
  lastLen += String(txt).length;
});
const final = await session.sendAndWait(
  { prompt: "Count slowly from 1 to 20, one number per line, with a short note after each." },
  120000
);
console.log(JSON.stringify({
  deltas,
  firstDeltaAtMs: firstDeltaAt,
  totalMs: Date.now() - t0,
  streamedChars: lastLen,
  finalLen: (final?.data?.content || "").length,
  verdict: deltas > 1
    ? "DELTAS STREAM — live manager/sub-agent streaming is feasible via SDK"
    : "NO DELTAS — SDK only delivered a final message; live streaming would need another mechanism",
}, null, 2));
await session.disconnect();
await client.stop();
