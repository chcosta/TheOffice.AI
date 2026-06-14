// 0A-service: prove the SDK runtime and the raw copilot CLI share the SAME auth
// dependency, so migrating CLI->SDK is auth-neutral. We strip GH_TOKEN from the
// child env (simulating a launch context that lacks the inherited token) and check
// that BOTH the SDK and the CLI react identically. Then we re-check WITH the token.

import { CopilotClient } from "@github/copilot-sdk";
import { spawnSync } from "node:child_process";

function cleanEnv() {
  const e = { ...process.env };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  delete e.COPILOT_API_KEY;
  return e;
}

async function sdkAuth(env) {
  // Run the SDK in a child node process so we control its environment exactly.
  const code = `
    import { CopilotClient } from "@github/copilot-sdk";
    const c = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
    try { await c.start(); const a = await c.getAuthStatus();
      console.log(JSON.stringify({ ok: !!a.isAuthenticated, authType: a.authType, login: a.login })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: String(e).split("\\n")[0] })); }
    finally { try { await c.stop(); } catch {} }
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env, encoding: "utf8", timeout: 60000,
  });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  try { return JSON.parse(line); } catch { return { ok: false, raw: line, stderr: (r.stderr||"").slice(-200) }; }
}

function cliAuth(env) {
  // `gh auth status` reflects the same GH_TOKEN the copilot CLI consumes.
  const r = spawnSync("gh", ["auth", "status"], { env, encoding: "utf8", shell: true, timeout: 30000 });
  const text = (r.stdout || "") + (r.stderr || "");
  return { ok: /Logged in to github\.com/.test(text), summary: text.split("\n").find(l=>/Logged in|not logged|error/i.test(l))?.trim() };
}

const results = {};
console.log("== WITH GH_TOKEN (current interactive context) ==");
results.withToken = { sdk: await sdkAuth({ ...process.env }), cli: cliAuth({ ...process.env }) };
console.log(JSON.stringify(results.withToken, null, 2));

console.log("\n== WITHOUT GH_TOKEN (simulates a launch ctx lacking the inherited token) ==");
results.withoutToken = { sdk: await sdkAuth(cleanEnv()), cli: cliAuth(cleanEnv()) };
console.log(JSON.stringify(results.withoutToken, null, 2));

const neutral =
  results.withToken.sdk.ok === results.withToken.cli.ok &&
  results.withoutToken.sdk.ok === results.withoutToken.cli.ok;
console.log("\nVERDICT:", neutral
  ? "AUTH-NEUTRAL — SDK and CLI authenticate (and fail) under identical conditions. Migration does not change auth posture."
  : "NOT NEUTRAL — SDK and CLI diverge on auth; investigate before migrating.");
console.log("NOTE: the only credential in this environment is the GH_TOKEN env var; whatever provides it to the CLI today must provide it to the SDK runtime (same inherited process.env).");
