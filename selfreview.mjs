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
//   node selfreview.mjs --mechanical    # syntax gates only, VIA the server (no SDK)
//   node selfreview.mjs --offline       # syntax gates only, SERVER-FREE (git hook)
//   node selfreview.mjs --port 3847     # target a specific server port
//   node selfreview.mjs --json          # machine-readable verdict on stdout
//
// --offline is the mode the pre-commit hook (.githooks/pre-commit) uses: it runs
// the same deterministic syntax gates directly against the STAGED files without
// touching the running server or the SDK, so commits are guarded even when the
// dev server is down. Exit 0 = clean, 1 = a syntax check failed.

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const port = val('--port', process.env.ME_AI_PORT || '3847');
const mechanicalOnly = has('--mechanical') || has('-m');
const offline = has('--offline') || has('-o');
const asJson = has('--json');
const cwd = val('--cwd', process.cwd());

const url = `http://localhost:${port}/api/me-ai/self-review`;
const body = JSON.stringify({ cwd, review: !mechanicalOnly });

function color(s, c) { return process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s; }
const green = (s) => color(s, 32), red = (s) => color(s, 31), yellow = (s) => color(s, 33), dim = (s) => color(s, 90);

// SERVER-FREE mechanical gate for the pre-commit hook. Mirrors the server's
// _meAiMechChecks (design §19) but self-contained so it can run when the dev
// server is down: node --check on every staged root JS file, and BOTH
// `node _syntax.mjs` + a node --check of the largest inline <script> for app.html.
// Checks the STAGED content's working-tree file (matches how the gate is run by
// hand). Exit 0 = clean / nothing to check; 1 = a syntax check failed.
async function runOffline() {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const gitStaged = () => {
    try {
      const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], { cwd, encoding: 'utf8' });
      return out.split('\0').map((s) => s.trim()).filter(Boolean);
    } catch { return []; }
  };
  const runCheck = (name, file, extra) => {
    const abs = path.resolve(cwd, file);
    if (!fs.existsSync(abs)) return null; // staged-deleted / moved — skip
    try {
      execFileSync('node', extra ? [extra, abs] : ['--check', abs], { cwd, stdio: 'pipe' });
      return { name, pass: true };
    } catch (e) {
      const detail = ((e.stderr || e.stdout || e.message || '') + '').toString();
      return { name, pass: false, detail };
    }
  };

  const staged = gitStaged();
  const html = staged.filter((f) => /(^|[\\/])app\.html$/i.test(f));
  const js = staged.filter((f) => /\.(c|m)?js$/i.test(f) && !/[\\/]node_modules[\\/]/.test(f));

  const checks = [];
  for (const f of js) { const c = runCheck(`node --check ${f}`, f); if (c) checks.push(c); }
  for (const f of html) {
    // 1) all inline scripts via the project's syntax harness.
    if (fs.existsSync(path.resolve(cwd, '_syntax.mjs'))) {
      try {
        execFileSync('node', ['_syntax.mjs'], { cwd, stdio: 'pipe' });
        checks.push({ name: `node _syntax.mjs (${f})`, pass: true });
      } catch (e) {
        checks.push({ name: `node _syntax.mjs (${f})`, pass: false, detail: ((e.stderr || e.stdout || e.message || '') + '').toString() });
      }
    }
  }

  console.log('');
  console.log(`Self-review (offline)  ${dim('·')}  ${staged.length} staged file(s)  ${dim('·')}  ${checks.length} check(s)`);
  if (!checks.length) { console.log(dim('  No JS/app.html changes staged — nothing to gate.')); process.exit(0); }
  for (const c of checks) {
    console.log(`  ${c.pass ? green('✓') : red('✗')} ${c.name}`);
    if (!c.pass && c.detail) console.log(dim('      ' + c.detail.split(/\r?\n/).slice(0, 8).join('\n      ')));
  }
  const pass = checks.every((c) => c.pass);
  console.log('');
  if (pass) { console.log(green('✓ Syntax gate PASSED.')); process.exit(0); }
  console.log(red('✗ Syntax gate FAILED — fix the above (or bypass with `git commit --no-verify`).'));
  process.exit(1);
}

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

if (offline) {
  runOffline().catch((e) => { console.error(red('✗ ' + (e.message || e))); process.exit(1); });
} else {
  main().catch((e) => { console.error(red('✗ ' + (e.message || e))); process.exit(2); });
}
