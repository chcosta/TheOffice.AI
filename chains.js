// Task Chains — a first-class, visualizable DAG of conditionally-triggered tasks.
//
// A chain replaces ad-hoc inline task triggers. It is a named pipeline of steps
// (each referencing a task) connected by conditional edges. When the chain runs,
// entry steps execute first; as each step finishes, the engine evaluates the
// outgoing edges and runs the targets whose condition passes.
//
// Edge conditions are tiered:
//   - status      : exit-code based  (onSuccess | onFailure | onComplete)
//   - expression  : deterministic check on the source output
//                   (contains | notContains | regex | equals | gt | lt)
//   - ai          : an LLM judges the output against a natural-language predicate
//                   (optionally via a custom condition agent)
//
// Output of the upstream step is exposed to the downstream prompt as
// {{ task.output }} / {{ trigger.output }}.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Cron } = require('croner');
const { parseSchedule } = require('./scheduler');

const CHAINS_PATH = path.join(__dirname, 'chains.json');

class ChainEngine extends EventEmitter {
  constructor({ db, supervisor, loadTasks, broadcast, onPersist }) {
    super();
    this.db = db;
    this.supervisor = supervisor;
    this.loadTasks = loadTasks;
    this.broadcast = broadcast || (() => {});
    this.onPersist = onPersist || (() => {});
    this.runs = new Map();      // runId -> live run state
    this.jobs = new Map();      // chainId -> cron/interval handle
    this._initDb();
    this.rescheduleAll();
  }

  _initDb() {
    try {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS chain_runs (
        id TEXT PRIMARY KEY,
        chain_id TEXT,
        name TEXT,
        started_at TEXT,
        finished_at TEXT,
        status TEXT,
        state_json TEXT
      )`).run();
    } catch (e) { console.warn('[chains] could not init chain_runs table:', e.message); }
  }

  // ---------- Store ----------
  load() {
    try { return JSON.parse(fs.readFileSync(CHAINS_PATH, 'utf-8')); }
    catch { return []; }
  }
  save(chains) {
    fs.writeFileSync(CHAINS_PATH, JSON.stringify(chains, null, 2));
    this.onPersist();
  }
  list() { return this.load(); }
  get(id) { return this.load().find(c => c.id === id) || null; }

  create(chain) {
    const chains = this.load();
    if (!chain.id) chain.id = 'chain-' + Date.now().toString(36);
    if (chains.some(c => c.id === chain.id)) throw new Error(`Chain "${chain.id}" already exists`);
    const normalized = this._normalize(chain);
    chains.push(normalized);
    this.save(chains);
    this.schedule(normalized);
    this.broadcast('chain-created', normalized);
    return normalized;
  }

  update(id, patch) {
    const chains = this.load();
    const idx = chains.findIndex(c => c.id === id);
    if (idx < 0) throw new Error('Chain not found');
    const merged = this._normalize({ ...chains[idx], ...patch, id });
    chains[idx] = merged;
    this.save(chains);
    this.schedule(merged);
    this.broadcast('chain-updated', merged);
    return merged;
  }

  remove(id) {
    const chains = this.load();
    const filtered = chains.filter(c => c.id !== id);
    if (filtered.length === chains.length) return false;
    this.save(filtered);
    this.unschedule(id);
    this.broadcast('chain-deleted', { id });
    return true;
  }

  _normalize(chain) {
    return {
      id: chain.id,
      name: chain.name || 'Untitled chain',
      description: chain.description || '',
      schedule: chain.schedule || 'never',
      enabled: chain.enabled !== false,
      steps: (chain.steps || []).map(s => ({
        id: s.id || 'step-' + Math.random().toString(36).slice(2, 8),
        taskId: s.taskId || null,
        prompt: s.prompt || ''
      })),
      edges: (chain.edges || []).map(e => ({
        from: e.from,
        to: e.to,
        condition: this._normalizeCondition(e.condition)
      })),
      updatedAt: new Date().toISOString()
    };
  }

  _normalizeCondition(c) {
    if (!c) return { type: 'status', status: 'onSuccess' };
    if (c.type === 'expression') {
      return { type: 'expression', op: c.op || 'contains', value: c.value || '', source: c.source || 'output' };
    }
    if (c.type === 'ai') {
      return { type: 'ai', predicate: c.predicate || '', agentId: c.agentId || null };
    }
    return { type: 'status', status: c.status || 'onSuccess' };
  }

  // ---------- Scheduling ----------
  rescheduleAll() {
    for (const id of [...this.jobs.keys()]) this.unschedule(id);
    for (const chain of this.load()) this.schedule(chain);
  }
  unschedule(id) {
    const job = this.jobs.get(id);
    if (job) { try { job.stop(); } catch {} this.jobs.delete(id); }
  }
  schedule(chain) {
    this.unschedule(chain.id);
    if (!chain || chain.enabled === false) return;
    if (!chain.schedule || String(chain.schedule).toLowerCase() === 'never') return;
    let parsed;
    try { parsed = parseSchedule(chain.schedule); }
    catch (e) { console.warn(`[chains] bad schedule for "${chain.name}": ${e.message}`); return; }
    if (parsed.type === 'cron') {
      this.jobs.set(chain.id, new Cron(parsed.cron, () => this.runChain(chain.id, { scheduled: true })));
    } else if (parsed.type === 'interval') {
      const timer = setInterval(() => this.runChain(chain.id, { scheduled: true }), parsed.ms);
      this.jobs.set(chain.id, { stop: () => clearInterval(timer) });
    }
    console.log(`[chains] scheduled "${chain.name}": ${parsed.description}`);
  }

  // ---------- Execution ----------
  runChain(chainId, opts = {}) {
    const chain = this.get(chainId);
    if (!chain) throw new Error('Chain not found');
    if (chain.enabled === false && !opts.manual) return null;
    if (!chain.steps.length) throw new Error('Chain has no steps');

    const runId = `${chainId}-${Date.now().toString(36)}`;
    const incoming = new Set(chain.edges.map(e => e.to));
    const entrySteps = chain.steps.filter(s => !incoming.has(s.id));
    const startEntries = entrySteps.length ? entrySteps : [chain.steps[0]];

    const run = {
      id: runId,
      chainId,
      name: chain.name,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      trigger: opts.scheduled ? 'scheduled' : (opts.manual ? 'manual' : 'auto'),
      nodes: Object.fromEntries(chain.steps.map(s => [s.id, { status: 'pending' }])),
      edges: chain.edges.map(e => ({ from: e.from, to: e.to, type: e.condition.type, evaluated: null, reason: null })),
      log: []
    };
    this.runs.set(runId, run);
    this._started = this._started || {};
    run._started = new Set();
    run._active = 0;
    this._persist(run);
    this.broadcast('chain-run-started', this._public(run));

    for (const step of startEntries) {
      this._runStep(chain, run, step, null);
    }
    return runId;
  }

  _runStep(chain, run, step, inputContext) {
    if (run._started.has(step.id)) return;     // diamond join guard
    run._started.add(step.id);
    run._active++;

    const tasks = this.loadTasks();
    const task = tasks.find(t => t.id === step.taskId);
    const node = run.nodes[step.id];
    if (!task) {
      node.status = 'failed';
      node.reason = `Task "${step.taskId}" not found`;
      this._stepFinished(chain, run, step, { code: -1, output: '' });
      return;
    }
    node.status = 'running';
    node.startedAt = new Date().toISOString();
    node.taskName = task.name;
    node.output = '';
    node.streaming = true;
    this._persist(run);
    this.broadcast('chain-run-step', { runId: run.id, stepId: step.id, status: 'running' });

    const onStream = (chunk, full) => {
      node.output = full.slice(-20000);
      this.broadcast('chain-run-output', { runId: run.id, stepId: step.id, output: node.output });
    };

    this._runTaskAgent(task, { promptOverride: step.prompt, triggerContext: inputContext, onStream })
      .then((res) => {
        node.status = res.code === 0 ? 'succeeded' : 'failed';
        node.finishedAt = new Date().toISOString();
        node.code = res.code;
        node.output = (res.output || '').slice(-20000);
        node.streaming = false;
        if (res.busy) { node.status = 'skipped'; node.reason = res.output; }
        this._persist(run);
        this.broadcast('chain-run-step', { runId: run.id, stepId: step.id, status: node.status });
        this._stepFinished(chain, run, step, res);
      })
      .catch((err) => {
        node.status = 'failed';
        node.finishedAt = new Date().toISOString();
        node.reason = err.message;
        node.streaming = false;
        this._persist(run);
        this._stepFinished(chain, run, step, { code: -1, output: '' });
      });
  }

  async _stepFinished(chain, run, step, res) {
    const task = this.loadTasks().find(t => t.id === step.taskId) || { id: step.taskId, name: step.taskId };
    const payload = { id: task.id, name: task.name, output: res.output || '', exitCode: res.code };
    const outContext = { trigger: payload, task: payload };

    const outgoing = chain.edges.filter(e => e.from === step.id);
    for (const edge of outgoing) {
      const runEdge = run.edges.find(re => re.from === edge.from && re.to === edge.to);
      let pass = false, reason = '';
      try {
        const verdict = await this._evaluate(edge.condition, res, task);
        pass = verdict.pass; reason = verdict.reason;
      } catch (e) { pass = false; reason = 'evaluation error: ' + e.message; }
      if (runEdge) { runEdge.evaluated = pass; runEdge.reason = reason; }
      this._persist(run);
      this.broadcast('chain-run-edge', { runId: run.id, from: edge.from, to: edge.to, pass, reason });
      if (pass) {
        const target = chain.steps.find(s => s.id === edge.to);
        if (target) this._runStep(chain, run, target, outContext);
      }
    }

    run._active--;
    if (run._active <= 0) this._finishRun(run);
  }

  _finishRun(run) {
    run.finishedAt = new Date().toISOString();
    const anyFailed = Object.values(run.nodes).some(n => n.status === 'failed');
    run.status = anyFailed ? 'error' : 'completed';
    this._persist(run);
    this.broadcast('chain-run-finished', this._public(run));
    console.log(`[chains] run ${run.id} ${run.status}`);
  }

  // ---------- Condition evaluation ----------
  async _evaluate(condition, res, sourceTask) {
    const c = condition || { type: 'status', status: 'onSuccess' };
    const output = res.output || '';
    const succeeded = res.code === 0;

    if (c.type === 'status') {
      const pass = c.status === 'onComplete'
        || (c.status === 'onSuccess' && succeeded)
        || (c.status === 'onFailure' && !succeeded);
      return { pass, reason: `status ${c.status} vs exit ${res.code}` };
    }

    if (c.type === 'expression') {
      const hay = String(output);
      const val = c.value != null ? String(c.value) : '';
      let pass = false;
      switch (c.op) {
        case 'contains': pass = hay.toLowerCase().includes(val.toLowerCase()); break;
        case 'notContains': pass = !hay.toLowerCase().includes(val.toLowerCase()); break;
        case 'equals': pass = hay.trim() === val.trim(); break;
        case 'regex': try { pass = new RegExp(val, 'i').test(hay); } catch { pass = false; } break;
        case 'gt': pass = this._num(hay) > Number(val); break;
        case 'lt': pass = this._num(hay) < Number(val); break;
        default: pass = false;
      }
      return { pass, reason: `expression ${c.op} "${val}"` };
    }

    if (c.type === 'ai') {
      return this._evaluateAI(c.predicate, output, c.agentId);
    }

    return { pass: false, reason: 'unknown condition type' };
  }

  _num(s) {
    const m = String(s).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  // Built-in shared evaluator: ask copilot to judge a predicate against output.
  // Optionally routes through a custom condition agent (agentId).
  _evaluateAI(predicate, output, agentId) {
    return new Promise((resolve) => {
      const os = require('os');
      const file = path.join(os.tmpdir(), `chain-cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
      const instructions = [
        'You are a strict, deterministic condition evaluator inside an automation pipeline.',
        'Decide whether the PREDICATE is TRUE for the given task OUTPUT.',
        'Judge ONLY from the OUTPUT. Do not run tools or gather new information unless explicitly required by the predicate.',
        '',
        '## PREDICATE',
        predicate || '(no predicate provided)',
        '',
        '## OUTPUT',
        '```',
        String(output || '').slice(0, 20000),
        '```',
        '',
        '## RESPONSE',
        'Respond with ONLY a single-line JSON object and nothing else:',
        '{"pass": true|false, "reason": "<one short sentence>"}'
      ].join('\n');
      fs.writeFileSync(file, instructions, 'utf-8');

      const copilotCmd = process.env.COPILOT_PATH || 'copilot';
      let agentFlag = '';
      let cwd = __dirname;
      if (agentId) {
        const entry = this.supervisor.agents.get(agentId);
        if (entry && entry.config) {
          agentFlag = `--agent "${entry.config.agent}" `;
          cwd = entry.config.cwd || __dirname;
        }
      }
      const cmdLine = `"${copilotCmd}" ${agentFlag}-p "Follow instructions in file: ${file.replace(/\\/g, '/')}" --yolo`;
      const shellPath = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\system32\\cmd.exe' : '/bin/sh');
      const proc = spawn(cmdLine, [], { cwd, shell: shellPath, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });

      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { out += d.toString(); });
      const finish = (verdict) => { try { fs.unlinkSync(file); } catch {} resolve(verdict); };
      proc.on('close', () => finish(this._parseVerdict(out)));
      proc.on('error', (e) => finish({ pass: false, reason: 'evaluator failed: ' + e.message }));
      setTimeout(() => { try { proc.kill(); } catch {} finish({ pass: false, reason: 'evaluator timed out' }); }, 180000);
    });
  }

  _parseVerdict(text) {
    const m = text && text.match(/\{[^{}]*"pass"[^{}]*\}/);
    if (m) { try { const o = JSON.parse(m[0]); return { pass: !!o.pass, reason: o.reason || '' }; } catch {} }
    if (/\bpass(ed)?\b|\btrue\b|\byes\b/i.test(text || '')) return { pass: true, reason: '(loose parse)' };
    return { pass: false, reason: '(could not parse verdict)' };
  }

  // ---------- Task agent primitive ----------
  // Runs a task's agent (optionally with a prompt override and interpolated
  // trigger context) and resolves { code, output } once the run completes.
  _runTaskAgent(task, { promptOverride = null, triggerContext = null, onStream = null } = {}) {
    return new Promise((resolve) => {
      const entry = this.supervisor.agents.get(task.agentId);
      if (!entry) return resolve({ code: -1, output: `Agent "${task.agentId}" not found`, error: true });
      if (entry.running) return resolve({ code: -1, output: `Agent "${task.agentId}" is busy`, busy: true });

      let live = '';
      const onOut = ({ agentId, chunk }) => {
        if (agentId !== task.agentId) return;
        live += chunk;
        if (onStream) { try { onStream(chunk, live); } catch {} }
      };
      if (onStream) this.supervisor.on('agent-output', onOut);

      const onDone = ({ agentId, code, output }) => {
        if (agentId !== task.agentId) return;
        this.supervisor.off('agent-completed', onDone);
        if (onStream) this.supervisor.off('agent-output', onOut);
        resolve({ code, output: output || '' });
      };
      this.supervisor.on('agent-completed', onDone);

      const original = entry.config.prompt;
      entry.config.prompt = promptOverride || task.prompt;
      try {
        this.supervisor._executeAgent(task.agentId, triggerContext);
      } catch (e) {
        this.supervisor.off('agent-completed', onDone);
        if (onStream) this.supervisor.off('agent-output', onOut);
        entry.config.prompt = original;
        return resolve({ code: -1, output: String(e.message), error: true });
      }
      entry.config.prompt = original;
    });
  }

  // ---------- Run state / history ----------
  _public(run) {
    const { _started, _active, ...rest } = run;
    return rest;
  }
  _persist(run) {
    try {
      this.db.prepare(`INSERT INTO chain_runs (id, chain_id, name, started_at, finished_at, status, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, status=excluded.status, state_json=excluded.state_json`)
        .run(run.id, run.chainId, run.name, run.startedAt, run.finishedAt, run.status, JSON.stringify(this._public(run)));
    } catch (e) { /* best-effort */ }
  }
  getRun(runId) {
    if (this.runs.has(runId)) return this._public(this.runs.get(runId));
    try {
      const row = this.db.prepare('SELECT state_json FROM chain_runs WHERE id = ?').get(runId);
      return row ? JSON.parse(row.state_json) : null;
    } catch { return null; }
  }
  recentRuns(chainId, limit = 10) {
    try {
      const rows = this.db.prepare(
        'SELECT id, chain_id, name, started_at, finished_at, status FROM chain_runs WHERE chain_id = ? ORDER BY started_at DESC LIMIT ?'
      ).all(chainId, limit);
      return rows;
    } catch { return []; }
  }
}

module.exports = { ChainEngine, CHAINS_PATH };
