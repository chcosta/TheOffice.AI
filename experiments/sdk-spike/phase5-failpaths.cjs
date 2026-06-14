// Phase 5 verification: with the CLI fallback removed, _executeViaSdk must record
// a FAILED run (exit 1) on both res.fallback and a thrown runner error — instead
// of calling the (now-deleted) _spawnCliRun. Likewise the manager/chain wrappers
// must surface failures terminally. Stubs sdkRunner so nothing real is spawned.
const path = require('path');
const sdkRunner = require('../../sdk-runner');
const Supervisor = require('../../supervisor');
const ManagerAgent = require('../../manager');
const { ChainEngine } = require('../../chains');

let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name))); };

const baseCtx = () => ({
  agentId: 'a1', entry: {}, config: { name: 'T', cwd: __dirname },
  startedAt: new Date().toISOString(), prompt: 'hi', pinnedSessionId: 'sid-1',
  triggerFiles: [], taskId: null,
});

async function run() {
  const origRunAgent = sdkRunner.runAgent;

  // --- supervisor._executeViaSdk : res.fallback => recordCompletion(code:1) ---
  {
    sdkRunner.runAgent = async () => ({ fallback: true, error: 'unresolvable' });
    let captured = null;
    const fakeThis = { emit() {}, _recordCompletion: (ctx, res) => { captured = res; } };
    Supervisor.prototype._executeViaSdk.call(fakeThis, baseCtx());
    await new Promise(r => setTimeout(r, 50));
    ok('supervisor fallback -> code 1', captured && captured.code === 1 && captured.origin === 'sdk');
    ok('supervisor fallback -> error message', captured && /unresolvable/.test(captured.error));
  }

  // --- supervisor._executeViaSdk : thrown runner error => recordCompletion(code:1) ---
  {
    sdkRunner.runAgent = async () => { throw new Error('boom'); };
    let captured = null;
    const fakeThis = { emit() {}, _recordCompletion: (ctx, res) => { captured = res; } };
    Supervisor.prototype._executeViaSdk.call(fakeThis, baseCtx());
    await new Promise(r => setTimeout(r, 50));
    ok('supervisor throw -> code 1', captured && captured.code === 1);
    ok('supervisor throw -> error message', captured && /boom/.test(captured.error));
  }

  // --- supervisor._executeViaSdk : success => passthrough code/steps ---
  {
    sdkRunner.runAgent = async ({ onChunk }) => { if (onChunk) onChunk('partial'); return { code: 0, output: 'OUT', steps: [{ type: 'agent' }] }; };
    let captured = null, emitted = [];
    const fakeThis = { emit(ev, p) { emitted.push([ev, p]); }, _recordCompletion: (ctx, res) => { captured = res; } };
    Supervisor.prototype._executeViaSdk.call(fakeThis, baseCtx());
    await new Promise(r => setTimeout(r, 50));
    ok('supervisor success -> code 0 + output', captured && captured.code === 0 && captured.output === 'OUT');
    ok('supervisor success -> steps preserved', captured && Array.isArray(captured.steps) && captured.steps.length === 1);
    ok('supervisor success -> streamed chunk (no mojibake wrap)', emitted.some(([ev, p]) => ev === 'agent-output' && p.chunk === 'partial'));
  }

  // --- manager._askManager : SDK miss => throws (caught by orchestration wrapper) ---
  {
    sdkRunner.runAgent = async () => ({ fallback: true });
    let threw = false;
    try { await ManagerAgent.prototype._askManager.call({ _askManagerSdk: ManagerAgent.prototype._askManagerSdk }, { id: 'm', cwd: __dirname }, 'p', null); }
    catch (e) { threw = /SDK runner returned no output/.test(e.message); }
    ok('manager _askManager miss -> throws', threw);
  }

  // --- manager._runSubAgent : SDK miss => error result (exitCode -1) ---
  {
    sdkRunner.runAgent = async () => ({ fallback: true });
    const fakeThis = {
      supervisor: { agents: new Map([['x', { config: { name: 'X', cwd: __dirname } }]]) },
      _runSubAgentSdk: ManagerAgent.prototype._runSubAgentSdk,
    };
    const r = await ManagerAgent.prototype._runSubAgent.call(fakeThis, 'x', 'p', null);
    ok('manager _runSubAgent miss -> exitCode -1', r && r.exitCode === -1 && /SDK runner returned no output/.test(r.output));
  }

  // --- chains._evaluateAI : SDK miss => safe default { pass:false } ---
  {
    sdkRunner.runAgent = async () => ({ fallback: true });
    sdkRunner.runPrompt = async () => ({ fallback: true });
    const fakeThis = {
      supervisor: { agents: new Map() },
      _buildJudgePrompt: ChainEngine.prototype._buildJudgePrompt,
      _evaluateAiSdk: ChainEngine.prototype._evaluateAiSdk,
      _parseVerdict: ChainEngine.prototype._parseVerdict,
    };
    const verdict = await ChainEngine.prototype._evaluateAI.call(fakeThis, 'is healthy', 'all good', null);
    ok('chains _evaluateAI miss -> pass:false safe default', verdict && verdict.pass === false);
  }

  sdkRunner.runAgent = origRunAgent;
  console.log(`\nphase5-failpaths: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
