// Validate sdk-runner routes a project agent through the generated package when
// MKT_PACKAGE_MODE is enabled, and still runs end-to-end.
// Run with: $env:SDK_RUN_MODE='all'; $env:MKT_PACKAGE_MODE='all'; node experiments/marketplace-spike/runner-package-spike.cjs
const { randomUUID } = require('crypto');
const runner = require('../../sdk-runner');

(async () => {
  const a = require('../../agents.json');
  const list = Array.isArray(a) ? a : (a.agents || []);
  const cfg = list.find(x => x.id === 'azure-status-observer');
  console.log('MKT_PACKAGE_MODE=', process.env.MKT_PACKAGE_MODE, 'SDK_RUN_MODE=', process.env.SDK_RUN_MODE);
  console.log('usePackage=', runner._usePackage ? runner._usePackage(cfg) : '(n/a)');

  let chunks = 0;
  const res = await runner.runAgent({
    config: cfg,
    prompt: 'In one short sentence, state your purpose. Do not call any tools.',
    sessionId: randomUUID(),
    onChunk: () => { chunks++; },
  });
  console.log('ok=', res.ok, 'code=', res.code, 'fallback=', res.fallback || false, 'chunks=', chunks);
  console.log('err=', res.error || 'none');
  console.log('output=', JSON.stringify((res.output || '').slice(0, 160)));
  console.log('VERDICT:', res.ok && /azure/i.test(res.output || '') ? 'PASS' : 'CHECK');
  process.exit(0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
