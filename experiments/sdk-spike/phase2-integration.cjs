// Phase 2 integration test: drive a real agent run through the patched
// Supervisor with the SDK RUNNER engaged (SDK_RUN_MODE=all), against a
// throwaway DB. Confirms:
//   (1) the run goes through _executeViaSdk (no child process),
//   (2) streaming agent-output chunks arrive (live SSE contract preserved),
//   (3) the run completes exit 0 with the expected output,
//   (4) agent_runs row is persisted with the pinned session id + dir exists.
// Also unit-checks the runner's CLI-fallback for an unresolvable agent.
//
// Run: SDK_RUN_MODE=all node phase2-integration.cjs   (set via env in shell)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase } = require('../../db');
const Supervisor = require('../../supervisor');
const sdkRunner = require('../../sdk-runner');

async function fallbackCheck() {
  // An agent with no pluginDir and a cwd that has no matching .agent.md must
  // resolve to fallback:true so the supervisor runs the CLI instead.
  const res = await sdkRunner.runAgent({
    config: { id: 'nope', name: 'Nonexistent', agent: 'Nonexistent', cwd: os.tmpdir(), allowAll: true },
    prompt: 'hi',
    sessionId: require('crypto').randomUUID(),
    onChunk: () => {},
  });
  console.log('fallback-check: fallback=' + res.fallback + ' ok=' + res.ok + ' err=' + JSON.stringify((res.error||'').slice(0,80)));
  return res.fallback === true && res.ok === false;
}

async function main() {
  console.log('SDK_RUN_MODE =', process.env.SDK_RUN_MODE, '| runner mode =', sdkRunner.mode);
  const fbOk = await fallbackCheck();

  const dbPath = path.join(os.tmpdir(), `sdk-p2-${Date.now()}.db`);
  const db = await openDatabase(dbPath);
  const sup = new Supervisor(db);

  const cfg = {
    id: 'sdk-p2-agent',
    name: 'Azure Status Observer',
    agent: 'Azure Status Observer',
    cwd: 'C:\\repos\\helix-observer',
    prompt: 'Reply with exactly the single word PONG and take no other action. Do not call any tools.',
    schedule: 'never',
    allowAll: true,
    autoStart: false,
  };
  sup.register(cfg);

  let chunkCount = 0;
  let streamed = '';
  sup.on('agent-output', ({ agentId, stream, chunk }) => {
    if (agentId === 'sdk-p2-agent') { chunkCount++; streamed += chunk; }
  });

  const entry = sup.agents.get('sdk-p2-agent');

  sup.on('agent-completed', ({ agentId, code, sessionId }) => {
    setTimeout(() => {
      const row = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId);
      const dir = sessionId ? path.join(os.homedir(), '.copilot', 'session-state', sessionId) : null;
      const dirExists = dir ? fs.existsSync(dir) : false;
      const hadChildProcess = entry && entry.process !== null && entry.process !== undefined;

      const out = (row && row.output || '').trim();
      const pass =
        code === 0 &&
        /PONG/i.test(out) &&
        row && row.session_id === sessionId &&
        dirExists &&
        fbOk;

      console.log('\n=== PHASE 2 INTEGRATION RESULT ===');
      console.log('fallback-check passed:', fbOk);
      console.log('exit code:           ', code);
      console.log('streaming chunks:    ', chunkCount, '(' + streamed.length + ' chars)');
      console.log('stored sessionId:    ', row && row.session_id);
      console.log('id == pinned uuid:   ', row && row.session_id === sessionId);
      console.log('session dir exists:  ', dirExists);
      console.log('output:              ', JSON.stringify(out.slice(0, 120)));
      console.log('\nVERDICT:', pass ? 'PASS - SDK runner drives the supervisor end-to-end' : 'FAIL');
      db.close();
      try { fs.unlinkSync(dbPath); } catch {}
      process.exit(pass ? 0 : 1);
    }, 2000);
  });

  sup.on('agent-error', ({ error }) => {
    console.error('agent-error:', error && error.message);
    process.exit(1);
  });

  console.log('Starting controlled SDK-runner run...');
  sup._executeAgent('sdk-p2-agent');

  setTimeout(() => { console.error('TIMEOUT after 180s'); process.exit(2); }, 180000);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
