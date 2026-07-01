// Phase 6 harness: validate sdk-runner.runChat for a NEW session and a RESUME
// turn, that deltas stream, that the by-id events.jsonl flushes, and that the
// two turns parse out of the flushed log.
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.SDK_RUN_MODE = process.env.SDK_RUN_MODE || 'all';
const runner = require('../../sdk-runner');
const { randomUUID } = require('crypto');

const STATE = path.join(os.homedir(), '.copilot', 'session-state');

function parseTurns(sessionId) {
  const ep = path.join(STATE, sessionId, 'events.jsonl');
  if (!fs.existsSync(ep)) return [];
  const lines = fs.readFileSync(ep, 'utf8').split('\n').filter(Boolean);
  const turns = [];
  let cur = null;
  for (const l of lines) {
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'user.message' && ev.data?.content) { cur = { user: ev.data.content, assistant: '' }; turns.push(cur); }
    else if (ev.type === 'assistant.message' && ev.data?.content && cur) cur.assistant = ev.data.content;
  }
  return turns;
}

(async () => {
  const sid = randomUUID();
  console.log('sessionId =', sid);

  let deltas1 = 0;
  const r1 = await runner.runChat({
    config: {},
    prompt: 'Reply with exactly the single word PHASE6NEW and nothing else.',
    sessionId: sid,
    resume: false,
    onChunk: () => { deltas1++; },
  });
  console.log('turn1 ok=%s fallback=%s code=%s deltas=%s out=%j', r1.ok, r1.fallback, r1.code, deltas1, (r1.output || '').slice(0, 80));

  let deltas2 = 0;
  const r2 = await runner.runChat({
    config: {},
    prompt: 'Now reply with exactly the single word PHASE6RESUME and nothing else.',
    sessionId: sid,
    resume: true,
    onChunk: () => { deltas2++; },
  });
  console.log('turn2 ok=%s fallback=%s code=%s deltas=%s out=%j', r2.ok, r2.fallback, r2.code, deltas2, (r2.output || '').slice(0, 80));

  const turns = parseTurns(sid);
  console.log('parsed turns =', turns.length, JSON.stringify(turns.map(t => ({ u: t.user.slice(0, 20), a: t.assistant.slice(0, 20) }))));

  const ok = r1.ok && r2.ok && !r1.fallback && !r2.fallback && turns.length === 2 &&
             turns[0].assistant && turns[1].assistant && deltas1 > 0 && deltas2 > 0;
  console.log('\nSUMMARY: runChat new+resume =', ok ? 'PASS' : 'FAIL');

  await runner.stop();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('THREW', e); process.exit(1); });
