'use strict';

const { parentPort, workerData } = require('worker_threads');
const sdkRunner = require('./sdk-runner');
const settings = require('./settings');

function hasCompleteRewrite(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    return !!String(JSON.parse(text.slice(start, end + 1)).rewrite || '').trim();
  } catch {
    return false;
  }
}

(async () => {
  let output = '';
  const result = await sdkRunner.runChat({
    config: null,
    prompt: workerData.prompt,
    sessionId: workerData.sessionId,
    resume: false,
    cwd: workerData.cwd,
    availableTools: [],
    reasoningEffort: workerData.mode === 'scratchpad' ? 'low' : undefined,
    timeoutMs: workerData.timeoutMs,
    completionText: '__PIXEL_COMPOSE_REVIEW_COMPLETE__',
    completionCheck: () => hasCompleteRewrite(output),
    model: (settings.resolveModel && settings.resolveModel('chat', null)) || undefined,
    modelCategory: 'chat',
    meta: { source: 'dev-buddy', category: 'compose-coach', record: false },
    onChunk: chunk => { output += chunk; },
  });
  parentPort.postMessage({ ok: true, output: output.trim() || result.output || '', result });
})().catch(error => {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
});
