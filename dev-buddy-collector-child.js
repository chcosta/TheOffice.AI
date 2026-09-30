'use strict';

const crypto = require('crypto');
const sdkRunner = require('./sdk-runner');

let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await sdkRunner.stop(); } catch {}
}

process.once('message', async payload => {
  try {
    const timeoutMs = Number(payload && payload.timeoutMs) || 60_000;
    const pluginDir = String((payload && payload.pluginDir) || '');
    const cwd = String((payload && payload.cwd) || __dirname);
    const runAgent = async (agentName, prompt, category) => {
      let output = '';
      const result = await sdkRunner.runChat({
        config: { pluginDir, agent: agentName, cwd },
        prompt,
        sessionId: crypto.randomUUID(),
        resume: false,
        modelCategory: 'execution',
        timeoutMs,
        cwd,
        meta: { source: 'connect', category, record: false },
        onChunk: chunk => { output += chunk; },
      });
      if (result && result.fallback) {
        throw new Error(result.error || 'Connect agent runtime unavailable');
      }
      return output.trim() ? output : ((result && result.output) || '');
    };

    let response;
    if (payload.mode === 'models') {
      const models = await sdkRunner.listModels();
      response = { ok: true, models };
    } else if (payload.mode === 'prompt') {
      let output = '';
      const result = await sdkRunner.runChat({
        config: null,
        prompt: String(payload.prompt || ''),
        sessionId: crypto.randomUUID(),
        resume: false,
        cwd,
        availableTools: [],
        timeoutMs,
        model: payload.model || undefined,
        modelCategory: 'execution',
        meta: {
          source: 'dev-buddy',
          category: String(payload.category || 'system'),
          record: false,
        },
        onChunk: chunk => { output += chunk; },
      });
      if (result && result.fallback) {
        throw new Error(result.error || 'Copilot runtime unavailable');
      }
      response = {
        ok: true,
        text: output.trim() ? output : ((result && result.output) || ''),
      };
    } else if (payload.mode === 'single') {
      const text = await runAgent(
        String(payload.agentName || ''),
        String(payload.prompt || ''),
        String(payload.category || 'diary')
      );
      response = { ok: true, text };
    } else {
      const scopes = Array.isArray(payload && payload.scopes) ? payload.scopes : [];
      const results = await Promise.all(scopes.map(async scope => {
        try {
          const text = await runAgent('dev-buddy-collector', scope.prompt, 'diary');
          return { source: scope.name, text };
        } catch (error) {
          return { source: scope.name, text: '', error: error.message };
        }
      }));
      response = { ok: true, results };
    }
    await stop();
    if (process.connected) process.send(response);
  } catch (error) {
    await stop();
    if (process.connected) process.send({ ok: false, error: error.message });
  } finally {
    if (process.connected) process.disconnect();
  }
});

process.once('disconnect', () => {
  stop().finally(() => process.exit(0));
});
