import { createRunner, extractFns } from './lib/harness.mjs';
const t = createRunner('harness-selfcheck');

await t.test('extractFns pulls real server helpers', () => {
  const fns = extractFns('server.js', ['_hmToMin', '_minToHm']);
  t.eq(typeof fns._hmToMin, 'function');
  t.eq(fns._hmToMin('08:30'), 510);
  t.eq(fns._minToHm(510), '08:30');
});

await t.test('assert helpers work', () => {
  t.eq(1 + 1, 2);
  t.gt(3, 2);
  t.throws(() => { throw new Error('x'); });
  t.includes([1, 2, 3], 2);
});

const r = await t.done();
process.exit(r.fail ? 1 : 0);
