// Aggregating test runner for TheOffice.AI browserless suites.
//
// Discovers every tests/*.suite.mjs (and a small explicit include list), runs
// each as its own child process, and aggregates pass/fail/skip into one exit
// code: 0 when nothing failed, 1 when any suite reported a failure or crashed.
//
// Board puppeteer regression suites (tests/board-*.regression.mjs) are NOT run
// here — they need a browser and are wired separately via `npm run test:board*`.
//
//   node tests/run-all.mjs            # run all discovered suites
//   node tests/run-all.mjs meai       # run only suites whose name matches "meai"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filter = (process.argv[2] || '').toLowerCase();

function discover() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.suite.mjs'))
    .sort();
  return files.map((f) => path.join(__dirname, f));
}

function runSuite(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { cwd: path.dirname(__dirname), timeout: 120000 }, (err, stdout, stderr) => {
      process.stdout.write(stdout || '');
      if (stderr) process.stderr.write(stderr);
      // Parse the "[suite] PASS  N passed, M failed, K skipped" summary line.
      let pass = 0, fail = 0, skip = 0, parsed = false;
      const m = (stdout || '').match(/\]\s+(?:PASS|FAIL)\s+(\d+) passed, (\d+) failed, (\d+) skipped/);
      if (m) { pass = +m[1]; fail = +m[2]; skip = +m[3]; parsed = true; }
      // A crash / non-zero exit with no parseable summary counts as a failure.
      if (!parsed && err) fail = Math.max(fail, 1);
      resolve({ file: path.basename(file), pass, fail, skip, crashed: !parsed && !!err });
    });
  });
}

const suites = discover().filter((f) => !filter || path.basename(f).toLowerCase().includes(filter));

if (!suites.length) {
  console.log(`No suites found${filter ? ` matching "${filter}"` : ''} (looked for tests/*.suite.mjs).`);
  process.exit(0);
}

console.log(`Running ${suites.length} suite(s)...\n`);
const results = [];
for (const s of suites) results.push(await runSuite(s));

const tot = results.reduce((a, r) => ({ pass: a.pass + r.pass, fail: a.fail + r.fail, skip: a.skip + r.skip }), { pass: 0, fail: 0, skip: 0 });
console.log('\n──────────────────────────────────────');
for (const r of results) {
  const tag = r.crashed ? 'CRASH' : r.fail ? 'FAIL ' : 'ok   ';
  console.log(`  ${tag} ${r.file}  (${r.pass}p ${r.fail}f ${r.skip}s)`);
}
console.log('──────────────────────────────────────');
console.log(`TOTAL  ${tot.pass} passed, ${tot.fail} failed, ${tot.skip} skipped  across ${results.length} suite(s)`);
process.exit(tot.fail ? 1 : 0);
