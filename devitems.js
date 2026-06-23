// Dev item git layer: app-managed clone + per-item worktree, status, sync.
//
// Model (chosen design): the app maintains ONE managed clone per AzDo repo
// under SUPERVISOR_DATA_DIR/dev-repos/<org>/<project>/<repo>, then adds a git
// worktree per Dev item under SUPERVISOR_DATA_DIR/dev-worktrees/<repo>__<devId>.
// This keeps every Dev item self-contained and avoids touching the user's own
// checkouts.
//
// Auth: network git operations (clone/fetch/pull) inject the Azure DevOps AAD
// bearer token from azdo.getToken() as a one-shot `http.extraheader`, so it
// works regardless of Git Credential Manager / stored PATs. The token is never
// written to disk or into the remote URL.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const azdo = require('./azdo');

let SUPERVISOR_DATA_DIR;
try {
  SUPERVISOR_DATA_DIR = require('./config-sync').SUPERVISOR_DATA_DIR;
} catch {
  SUPERVISOR_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
}

const DEV_REPOS = path.join(SUPERVISOR_DATA_DIR, 'dev-repos');
const DEV_WORKTREES = path.join(SUPERVISOR_DATA_DIR, 'dev-worktrees');

function _safe(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function clonePath(org, project, repo) {
  return path.join(DEV_REPOS, _safe(org), _safe(project), _safe(repo));
}

function worktreePath(repo, devId) {
  return path.join(DEV_WORKTREES, _safe(repo) + '__' + _safe(devId));
}

function _authArgs() {
  // git -c http.extraheader="AUTHORIZATION: bearer <token>" ...
  return ['-c', 'http.extraheader=AUTHORIZATION: bearer ' + azdo.getToken()];
}

// Run a git command, throwing on failure with a clean message.
function _git(args, cwd, { auth = false, timeout = 240_000 } = {}) {
  const full = (auth ? _authArgs() : []).concat(args);
  try {
    return execFileSync('git', full, {
      cwd: cwd || undefined,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }).toString();
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString().trim();
    const safeArgs = args.join(' ');
    throw new Error(`git ${safeArgs} failed: ${err.split('\n').slice(-3).join(' ').slice(0, 400)}`);
  }
}

// Run a git command without throwing. Returns { ok, out, err }.
function _gitTry(args, cwd, opts = {}) {
  try {
    return { ok: true, out: _git(args, cwd, opts).trim(), err: '' };
  } catch (e) {
    return { ok: false, out: '', err: (e.message || '').toString() };
  }
}

function _isRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// Ensure the managed clone exists and is fetched. Returns the clone path.
function ensureClone(org, project, repo) {
  const dir = clonePath(org, project, repo);
  if (_isRepo(dir)) {
    _gitTry(['fetch', '--prune', 'origin'], dir, { auth: true });
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const url = azdo.cloneUrl(org, project, repo);
  _git(['clone', url, dir], path.dirname(dir), { auth: true });
  return dir;
}

// Create (or reuse) a worktree for a Dev item. Returns { worktreePath, branch, reused }.
function createWorktree({ org, project, repo, baseBranch, branch, devId }) {
  const clone = ensureClone(org, project, repo);
  const base = (baseBranch || '').trim() || 'main';
  const br = (branch || '').trim() || ('dev/' + _safe(devId));
  const wt = worktreePath(repo, devId);

  if (_isRepo(wt)) {
    return { worktreePath: wt, branch: br, reused: true };
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });

  // Clear any stale worktree registrations (e.g. a prior worktree dir that was deleted
  // out from under git) so re-adding a branch whose old worktree is gone won't fail with
  // "already checked out" / "missing but locked".
  _gitTry(['worktree', 'prune'], clone);

  // Does the branch already exist locally in the managed clone? This happens when a
  // worktree was created before and later removed (remove-worktree deletes the worktree
  // dir but leaves the local branch behind). Attach the existing branch instead of
  // trying to (re-)create it, which would fail with "a branch named '…' already exists".
  const localHas = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok;
  // Does the branch already exist on origin?
  const remoteHas = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok;
  if (localHas) {
    // Check out the pre-existing local branch into the new worktree (no -b/-B so we
    // don't discard any local commits the branch already carries).
    _git(['worktree', 'add', wt, br], clone);
  } else if (remoteHas) {
    // Track the existing remote branch.
    _git(['worktree', 'add', '--track', '-B', br, wt, 'origin/' + br], clone);
  } else {
    // Brand-new branch off the base; no upstream yet (status compares vs origin/base).
    const baseRef = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + base], clone).ok
      ? 'origin/' + base : base;
    _git(['worktree', 'add', '-b', br, wt, baseRef], clone);
  }
  return { worktreePath: wt, branch: br, reused: false };
}

// Compute ahead/behind/dirty for a worktree. Optionally fetch first.
function worktreeStatus(wt, { fetch = true, baseBranch = 'main' } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });

  const branch = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt).out || '';
  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  const compare = up.ok && up.out ? '@{u}' : ('origin/' + (baseBranch || 'main'));

  let ahead = 0, behind = 0, comparable = false;
  const counts = _gitTry(['rev-list', '--left-right', '--count', compare + '...HEAD'], wt);
  if (counts.ok) {
    const m = counts.out.split(/\s+/);
    behind = parseInt(m[0], 10) || 0;
    ahead = parseInt(m[1], 10) || 0;
    comparable = true;
  }
  const dirty = (_gitTry(['status', '--porcelain'], wt).out || '').length > 0;

  return {
    branch,
    upstream: up.ok ? up.out : '',
    tracking: compare === '@{u}' ? (up.out || '') : compare,
    ahead, behind, comparable, dirty,
    lastChecked: new Date().toISOString()
  };
}

// Fetch + fast-forward the worktree. Returns { ok, message, status }.
function syncWorktree(wt, { baseBranch = 'main' } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to sync.' };
  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: true });

  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  let res;
  if (up.ok && up.out) {
    res = _gitTry(['pull', '--ff-only'], wt, { auth: true });
  } else {
    // No upstream: fast-forward onto the base branch instead.
    res = _gitTry(['merge', '--ff-only', 'origin/' + (baseBranch || 'main')], wt);
  }
  const status = worktreeStatus(wt, { fetch: false, baseBranch });
  if (!res.ok) {
    const diverged = /non-fast-forward|not possible to fast-forward|diverging|diverge/i.test(res.err);
    return {
      ok: false,
      message: diverged
        ? 'Branches have diverged — a fast-forward sync is not possible. Resolve locally (rebase/merge).'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Sync failed.'),
      status
    };
  }
  return { ok: true, message: 'Up to date with origin.', status };
}

// A compact textual summary of the code state for the AI summary prompt.
function diffSummary(wt, { baseBranch = 'main', maxLines = 40 } = {}) {
  if (!wt || !_isRepo(wt)) return '';
  const base = 'origin/' + (baseBranch || 'main');
  const out = [];
  const stat = _gitTry(['diff', '--stat', base + '...HEAD'], wt);
  if (stat.ok && stat.out) {
    out.push('Changed files (git diff --stat vs ' + base + '):');
    out.push(stat.out.split('\n').slice(0, maxLines).join('\n'));
  }
  const log = _gitTry(['log', '--oneline', '-15', base + '..HEAD'], wt);
  if (log.ok && log.out) {
    out.push('');
    out.push('Recent commits on this branch:');
    out.push(log.out);
  }
  const dirty = _gitTry(['status', '--porcelain'], wt);
  if (dirty.ok && dirty.out) {
    out.push('');
    out.push('Uncommitted working changes:');
    out.push(dirty.out.split('\n').slice(0, maxLines).join('\n'));
  }
  return out.join('\n').trim();
}

// Push the worktree's current branch (or a given branch) to origin, with auth.
// Returns { ok, branch, message }.
function pushBranch(wt, { branch } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, branch: '', message: 'No worktree to push.' };
  let br = String(branch || '').trim();
  if (!br) {
    const cur = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
    br = cur.ok ? cur.out.trim() : '';
  }
  if (!br || br === 'HEAD') return { ok: false, branch: '', message: 'Could not determine the branch to push.' };
  const res = _gitTry(['push', '-u', 'origin', br], wt, { auth: true });
  return {
    ok: res.ok,
    branch: br,
    message: res.ok ? 'Pushed.' : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Push failed.')
  };
}

// Add a path to the worktree's git exclude (so an app-managed file never shows
// in `git status` / gets committed). Resolves the correct exclude file even for
// a linked worktree via `git rev-parse --git-path`. Best-effort.
function addGitExclude(wt, relLine) {
  if (!wt || !_isRepo(wt) || !relLine) return false;
  let excl = '';
  const p = _gitTry(['rev-parse', '--git-path', 'info/exclude'], wt);
  if (p.ok && p.out) excl = p.out.trim();
  if (excl && !path.isAbsolute(excl)) excl = path.join(wt, excl);
  if (!excl) return false;
  try {
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    let cur = '';
    try { cur = fs.readFileSync(excl, 'utf-8'); } catch {}
    if (cur.split(/\r?\n/).includes(relLine)) return true;
    fs.appendFileSync(excl, (cur && !cur.endsWith('\n') ? '\n' : '') + relLine + '\n');
    return true;
  } catch { return false; }
}

// Remove a worktree (best-effort). Leaves the managed clone in place.
function removeWorktree(org, project, repo, devId, wt) {
  const target = wt || worktreePath(repo, devId);
  const clone = clonePath(org, project, repo);
  if (_isRepo(clone)) _gitTry(['worktree', 'remove', '--force', target], clone);
  try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch {}
  if (_isRepo(clone)) _gitTry(['worktree', 'prune'], clone);
  return true;
}

// Offload the (synchronous, potentially minutes-long) clone+worktree to a worker
// thread so the main HTTP event loop stays responsive while a large repo clones.
// Without this, execFileSync('git clone') blocks every other request — e.g. a Dev
// item's "Refresh summary" appears to do nothing until the clone finishes. The
// worker re-acquires its own AzDO token via `az`, so it is fully self-contained.
// Resolves to { worktreePath, branch, reused, git }.
function createWorktreeAsync(params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const { Worker } = require('worker_threads');
    const worker = new Worker(__filename, { workerData: { __wtJob: params } });
    worker.once('message', (msg) => {
      settled = true;
      if (msg && msg.ok) resolve(msg.result);
      else reject(new Error((msg && msg.error) || 'Worktree failed'));
      worker.terminate();
    });
    worker.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.once('exit', (code) => { if (!settled) { settled = true; reject(new Error('Worktree worker exited with code ' + code)); } });
  });
}

module.exports = {
  DEV_REPOS,
  DEV_WORKTREES,
  clonePath,
  worktreePath,
  ensureClone,
  createWorktree,
  createWorktreeAsync,
  worktreeStatus,
  syncWorktree,
  diffSummary,
  pushBranch,
  addGitExclude,
  removeWorktree
};

// Worker-thread entry: when this module is loaded inside a Worker carrying a
// __wtJob, run the blocking clone+worktree here (off the main event loop) and
// post the result back. No-op in the main thread.
try {
  const { isMainThread, parentPort, workerData } = require('worker_threads');
  if (!isMainThread && workerData && workerData.__wtJob && parentPort) {
    const job = workerData.__wtJob;
    try {
      const r = createWorktree(job);
      let git = null;
      try { git = worktreeStatus(r.worktreePath, { baseBranch: job.baseBranch }); } catch {}
      parentPort.postMessage({ ok: true, result: { ...r, git } });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: (e && e.message) || 'Worktree failed' });
    }
  }
} catch {}
