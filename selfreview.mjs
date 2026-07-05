#!/usr/bin/env node
// REQ-6 self-validation quality gate (design §19) — CLI wrapper.
//
// A routine PRE-COMMIT self-review of agent-authored changes. Runs two passes
// over the current working tree via the running server's /api/me-ai/self-review:
//   (1) MECHANICAL — deterministic syntax gates (node --check on changed JS;
//       node _syntax.mjs + extracted largest-<script> node --check for app.html).
//   (2) REVIEW — the senior-review Me-agent on the live diff (high/medium block).
//
// Exit 0 = gate passes (safe to commit). Exit 1 = blocking findings or a failed
// syntax check. Exit 2 = could not reach the gate (server down / bad args).
//
// Usage:
//   node selfreview.mjs                 # full gate (mechanical + AI review)
//   node selfreview.mjs --mechanical    # syntax gates only (fast, no SDK)
//   node selfreview.mjs --port 3847     # target a specific server port
//   node selfreview.mjs --json          # machine-readable verdict on stdout

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const port = val('--port', process.env.ME_AI_PORT || '3847');
const mechanicalOnly = has('--mechanical') || has('-m');
const asJson = has('--json');
const cwd = val('--cwd', process.cwd());

const url = `http://localhost:${port}/api/me-ai/self-review`;
const body = JSON.stringify({ cwd, review: !mechanicalOnly });

function color(s, c) { return process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s; }
const green = (s) => color(s, 32), red = (s) => color(s, 31), yellow = (s) => color(s, 33), dim = (s) => color(s, 90);

async function main() {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  } catch (e) {
    console.error(red(`✗ Could not reach the self-review gate at ${url}`));
    console.error(dim(`  Is the dev server running on :${port}?  ${e.message || e}`));
    process.exit(2);
  }
  if (!resp.ok) {
    console.error(red(`✗ Gate returned HTTP ${resp.status}`));
    try { console.error(dim('  ' + (await resp.text()).slice(0, 400))); } catch {}
    process.exit(2);
  }
  const { verdict } = await resp.json();
  if (asJson) { console.log(JSON.stringify(verdict, null, 2)); process.exit(verdict.pass ? 0 : 1); }

  const b = verdict || {};
  console.log('');
  console.log(`Self-review gate  ${dim('·')}  ${b.changedFiles ? b.changedFiles.length : 0} changed file(s)`);
  if (b.changedFiles && b.changedFiles.length) console.log(dim('  ' + b.changedFiles.slice(0, 20).join('  ')));

  // Mechanical checks
  console.log('');
  console.log('Mechanical (syntax):');
  for (const c of (b.mechanical && b.mechanical.checks) || []) {
    console.log(`  ${c.pass ? green('✓') : red('✗')} ${c.name}`);
    if (!c.pass && c.detail) console.log(dim('      ' + c.detail.split(/\r?\n/).slice(0, 6).join('\n      ')));
  }

  // Review pass
  console.log('');
  const rv = b.review || {};
  if (rv.status === 'ok') {
    const cts = b.counts || {};
    console.log(`Review:  ${red(cts.high || 0)} high  ${yellow(cts.medium || 0)} medium  ${dim((cts.low || 0) + ' low')}`);
    if (rv.summary) console.log(dim('  ' + rv.summary));
    for (const f of rv.findings || []) {
      const tag = f.severity === 'high' ? red('HIGH') : f.severity === 'medium' ? yellow('MED ') : dim('low ');
      console.log(`  ${tag}  ${f.title}`);
      if (f.severity !== 'low' && f.detail) console.log(dim('        ' + f.detail.slice(0, 300)));
    }
  } else if (rv.status === 'skipped') {
    console.log(dim(`Review: skipped (${rv.reason}).`));
  } else {
    console.log(yellow(`Review: ${rv.status} — ${rv.error || 'unavailable'}. Mechanical result governs the gate.`));
  }

  console.log('');
  if (b.pass) {
    console.log(green('✓ Gate PASSED — no blocking issues. Safe to commit.'));
    if (b.counts && b.counts.low) console.log(dim(`  (${b.counts.low} low finding(s) surfaced — justify or dismiss with a note.)`));
    process.exit(0);
  } else {
    const why = [];
    if (b.mechanical && !b.mechanical.pass) why.push('a syntax check failed');
    if (b.blocking && b.blocking.length) why.push(`${b.blocking.length} blocking review finding(s)`);
    console.log(red(`✗ Gate FAILED — ${why.join(' and ') || 'blocking issues found'}. Fix before committing.`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(red('✗ ' + (e.message || e))); process.exit(2); });
