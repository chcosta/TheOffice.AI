// Phase 6 spike: determine how an SDK-created session persists to disk.
// Q1: does createSession({sessionId}) + sendAndWait write ~/.copilot/session-state/<id>/events.jsonl?
// Q2: is it written incrementally (visible mid-run) or only after disconnect?
// Q3: does resumeSession(id) + sendAndWait append a second turn to the same file?
// Q4: does getEvents() after resume return BOTH turns (full history)?
const os = require('os');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const { CopilotClient, approveAll } = require('@github/copilot-sdk');
const SS = path.join(os.homedir(), '.copilot', 'session-state');

const sid = randomUUID();
const dir = path.join(SS, sid);
const evFile = path.join(dir, 'events.jsonl');

const peek = (label) => {
  const exists = fs.existsSync(evFile);
  let lines = 0, types = {};
  if (exists) {
    for (const l of fs.readFileSync(evFile, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue; lines++;
      try { const t = JSON.parse(l).type; types[t] = (types[t]||0)+1; } catch {}
    }
  }
  console.log(`  [${label}] events.jsonl exists=${exists} lines=${lines} types=${JSON.stringify(types)}`);
  // also list any files in the dir
  if (fs.existsSync(dir)) console.log(`         dir files: ${fs.readdirSync(dir).join(', ')}`);
};

(async () => {
  console.log('sessionId =', sid);
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: 'error' });
  await client.start();
  console.log('client started');

  // --- Turn 1: createSession with pinned id ---
  const s1 = await client.createSession({ sessionId: sid, workingDirectory: __dirname, streaming: true, onPermissionRequest: approveAll });
  console.log('createSession ok; actual session id =', s1.id ?? s1.sessionId ?? '(no id prop)');
  peek('after createSession, before send');

  let deltas = 0;
  s1.on?.('assistant.message_delta', () => { deltas++; if (deltas === 1) peek('on first delta (mid-run)'); });

  await s1.sendAndWait({ prompt: 'Reply with exactly the single word PHASE6 and nothing else.' }, 120000);
  console.log('turn1 sendAndWait done; deltas=', deltas);
  peek('after turn1 sendAndWait (before disconnect)');
  const ev1 = await s1.getEvents();
  console.log('turn1 getEvents count=', ev1.length, 'assistant msgs=', ev1.filter(e=>e.type==='assistant.message').length);
  await s1.disconnect();
  peek('after turn1 disconnect');

  // --- Turn 2: resume same id, second turn ---
  const s2 = await client.resumeSession(sid, { onPermissionRequest: approveAll, streaming: true });
  console.log('resumeSession ok');
  await s2.sendAndWait({ prompt: 'Now reply with exactly the single word SECOND and nothing else.' }, 120000);
  peek('after turn2 sendAndWait');
  const ev2 = await s2.getEvents();
  const asst = ev2.filter(e=>e.type==='assistant.message').map(e=>e.data?.content);
  console.log('turn2 getEvents count=', ev2.length, 'assistant contents=', JSON.stringify(asst));
  await s2.disconnect();

  await client.stop();
  console.log('\nSUMMARY: history-on-disk =', fs.existsSync(evFile), '| 2 assistant turns visible via getEvents =', asst.length >= 2);
  process.exit(0);
})().catch(e => { console.error('SPIKE ERROR', e); process.exit(1); });
