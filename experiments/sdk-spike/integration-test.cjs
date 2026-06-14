// Phase 1 integration test: drive ONE real agent run through the patched
// Supervisor against a throwaway DB. Confirms (1) the run completes, (2) the
// stored agent_runs.session_id equals the pinned uuid and that session dir
// exists, (3) a parity record was appended to ~/.copilot/sdk-read-parity.jsonl.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase } = require('../../db');
const Supervisor = require('../../supervisor');

async function main() {
const dbPath = path.join(os.tmpdir(), `sdk-itest-${Date.now()}.db`);
const db = await openDatabase(dbPath);
const sup = new Supervisor(db);

const parityLog = path.join(os.homedir(), '.copilot', 'sdk-read-parity.jsonl');
const parityBefore = fs.existsSync(parityLog) ? fs.readFileSync(parityLog, 'utf8').length : 0;

const cfg = {
  id: 'sdk-itest-agent',
  name: 'Azure Status Observer',
  agent: 'Azure Status Observer',
  cwd: 'C:\\repos\\helix-observer',
  prompt: 'Reply with exactly the single word PONG and take no other action. Do not call any tools.',
  schedule: 'never',
  allowAll: true,
  autoStart: false,
};

sup.register(cfg);

sup.on('agent-completed', ({ agentId, code, sessionId }) => {
  setTimeout(() => {
    const row = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId);
    const dir = sessionId ? path.join(os.homedir(), '.copilot', 'session-state', sessionId) : null;
    const dirExists = dir ? fs.existsSync(dir) : false;

    const after = fs.existsSync(parityLog) ? fs.readFileSync(parityLog, 'utf8') : '';
    const newLines = after.slice(parityBefore).split('\n').filter(Boolean);
    const myRec = newLines.map(l => { try { return JSON.parse(l); } catch { return null; } })
                          .filter(Boolean).find(r => r.sessionId === sessionId);

    console.log('\n=== INTEGRATION RESULT ===');
    console.log('exit code:        ', code);
    console.log('stored sessionId: ', row && row.session_id);
    console.log('emitted sessionId:', sessionId);
    console.log('id == pinned uuid:', row && row.session_id === sessionId);
    console.log('session dir exists:', dirExists);
    console.log('output (first 120):', JSON.stringify((row && row.output || '').slice(0, 120)));
    console.log('parity record:    ', myRec ? JSON.stringify(myRec) : 'NOT FOUND');
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    process.exit(0);
  }, 2500);
});

sup.on('agent-error', ({ error }) => {
  console.error('agent-error:', error && error.message);
  process.exit(1);
});

console.log('Starting controlled run (mode=' + (process.env.SDK_READ_MODE || 'shadow') + ')...');
sup._executeAgent('sdk-itest-agent');

setTimeout(() => { console.error('TIMEOUT after 180s'); process.exit(2); }, 180000);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
