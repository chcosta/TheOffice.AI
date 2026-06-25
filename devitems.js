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
  // core.longpaths=true makes git use the \\?\ prefix so deep repo paths
  // (e.g. dotnet-helix-machines) don't exceed the Windows MAX_PATH (260) limit
  // during clone + worktree checkout.
  const full = ['-c', 'core.longpaths=true'].concat(auth ? _authArgs() : []).concat(args);
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
function createWorktree({ org, project, repo, baseBranch, branch, devId, detach }) {
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

  // Detached/read-only review checkout: snapshot the branch tip without occupying the
  // branch name, so it never collides with another worktree (e.g. a dev card) that has
  // the same branch checked out. Used for PR review worktrees.
  if (detach) {
    const ref = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok
      ? 'origin/' + br
      : (_gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok
        ? br
        : (_gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + base], clone).ok ? 'origin/' + base : base));
    _git(['worktree', 'add', '--detach', wt, ref], clone);
    return { worktreePath: wt, branch: br, reused: false, detached: true };
  }

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
  // HEAD commit sha — lets callers detect a new commit even when ahead/behind
  // don't move (e.g. an amend, or a commit that also pulled base in).
  const head = _gitTry(['rev-parse', 'HEAD'], wt).out || '';

  return {
    branch, head,
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

// Truncate a patch to a character budget on a line boundary, with a marker.
function _capPatch(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut) +
    '\n… [diff truncated, ' + (s.length - maxChars) + ' more chars]';
}

// Pathspecs for noisy/generated files we never want to spend the diff budget on.
const _DIFF_EXCLUDES = [
  ':(exclude)**/package-lock.json',
  ':(exclude)**/yarn.lock',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)**/*.min.js',
  ':(exclude)**/*.map',
  ':(exclude)**/dist/**',
  ':(exclude)**/build/**'
];

// A textual summary of the code state for the AI summary prompt. Includes the
// actual patch hunks (committed-vs-base, staged, and unstaged) so the model can
// reason about WHAT changed, not just which files — each section bounded by a
// character budget so the overall prompt stays manageable.
function diffSummary(wt, { baseBranch = 'main', maxLines = 40, maxDiffChars = 9000 } = {}) {
  if (!wt || !_isRepo(wt)) return '';
  const base = 'origin/' + (baseBranch || 'main');
  const out = [];

  // High-level overview: which files changed vs base + how much churn.
  const stat = _gitTry(['diff', '--stat', base + '...HEAD'], wt);
  if (stat.ok && stat.out) {
    out.push('Changed files (git diff --stat vs ' + base + '):');
    out.push(stat.out.split('\n').slice(0, maxLines).join('\n'));
  }

  // Commits unique to this branch.
  const log = _gitTry(['log', '--oneline', '-15', base + '..HEAD'], wt);
  if (log.ok && log.out) {
    out.push('');
    out.push('Recent commits on this branch:');
    out.push(log.out);
  }

  // The actual committed change set vs base — the primary "what changed" patch.
  const committed = _gitTry(['diff', '--unified=3', base + '...HEAD', '--'].concat(_DIFF_EXCLUDES), wt);
  if (committed.ok && committed.out && committed.out.trim()) {
    out.push('');
    out.push('Committed changes vs ' + base + ' (patch):');
    out.push(_capPatch(committed.out, maxDiffChars));
  }

  // In-progress edits, split into staged vs unstaged so the model can tell them apart.
  const staged = _gitTry(['diff', '--staged', '--unified=3', '--'].concat(_DIFF_EXCLUDES), wt);
  if (staged.ok && staged.out && staged.out.trim()) {
    out.push('');
    out.push('Staged (not yet committed) changes (patch):');
    out.push(_capPatch(staged.out, Math.floor(maxDiffChars / 2)));
  }
  const unstaged = _gitTry(['diff', '--unified=3', '--'].concat(_DIFF_EXCLUDES), wt);
  if (unstaged.ok && unstaged.out && unstaged.out.trim()) {
    out.push('');
    out.push('Unstaged working changes (patch):');
    out.push(_capPatch(unstaged.out, Math.floor(maxDiffChars / 2)));
  }

  // Porcelain status catches untracked files (and anything excluded above).
  const dirty = _gitTry(['status', '--porcelain'], wt);
  if (dirty.ok && dirty.out) {
    out.push('');
    out.push('Working tree status (git status --porcelain):');
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
// ---- Status reports surfaced from a worktree ---------------------------------
// The dev agent is instructed to write an HTML status report (default
// `dev-status-report.html`) into the worktree root when it completes major
// changes. Surface any such reports on the Dev card. Cheap, reflow-free scan:
// the worktree root plus a shallow `reports`/`docs`/`.reports` subfolder; match
// HTML/Markdown files whose name reads like a report. Never throws.
const REPORT_EXTS = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
const REPORT_NAME_RE = /(report|status|summary|metrics|results?)/i;
const REPORT_SUBDIRS = ['reports', 'report', 'docs', '.reports'];

function _scanReportDir(absDir, relPrefix, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    const ext = path.extname(name).toLowerCase();
    if (!REPORT_EXTS.has(ext)) continue;
    // Only surface files whose name reads like a report/status/summary, so we
    // don't list README.md, LICENSE.txt, source HTML, etc.
    if (!REPORT_NAME_RE.test(name)) continue;
    const isHtml = ext === '.html' || ext === '.htm';
    let st;
    try { st = fs.statSync(path.join(absDir, name)); } catch { continue; }
    // Skip absurdly large files (not a human-readable report).
    if (st.size > 8 * 1024 * 1024) continue;
    out.push({
      name,
      rel: (relPrefix ? relPrefix + '/' : '') + name,
      mtime: st.mtimeMs,
      size: st.size,
      kind: isHtml ? 'html' : (ext === '.md' || ext === '.markdown' ? 'md' : 'txt')
    });
  }
}

function findReports(wt) {
  const out = [];
  try {
    if (!wt || !fs.existsSync(wt)) return out;
    _scanReportDir(wt, '', out);
    for (const sub of REPORT_SUBDIRS) {
      const abs = path.join(wt, sub);
      try { if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) _scanReportDir(abs, sub, out); } catch {}
    }
  } catch {}
  // Newest first; cap to a sane number.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 16);
}

// Safely read a report file from a worktree. Resolves `rel` against the worktree
// root, blocks path traversal (the resolved path MUST stay inside the worktree),
// allows only report-ish extensions, and caps the read size. Returns
// { content, contentType, name } or throws an Error with a `.status`.
function _readReportFrom(rootDir, rel) {
  const err = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
  if (!rootDir || !fs.existsSync(rootDir)) throw err('Not found', 404);
  if (!rel || typeof rel !== 'string') throw err('Missing file', 400);
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) throw err('Forbidden path', 403);
  const ext = path.extname(abs).toLowerCase();
  if (!REPORT_EXTS.has(ext)) throw err('Unsupported file type', 415);
  let st;
  try { st = fs.statSync(abs); } catch { throw err('Not found', 404); }
  if (!st.isFile()) throw err('Not a file', 404);
  if (st.size > 8 * 1024 * 1024) throw err('Report too large to preview', 413);
  const content = fs.readFileSync(abs);
  const isHtml = ext === '.html' || ext === '.htm';
  const contentType = isHtml ? 'text/html; charset=utf-8'
    : (ext === '.md' || ext === '.markdown') ? 'text/markdown; charset=utf-8'
    : 'text/plain; charset=utf-8';
  return { content, contentType, name: path.basename(abs) };
}

function readReport(wt, rel) { return _readReportFrom(wt, rel); }

// ---------------------------------------------------------------------------
// Report cache. Reports surfaced from a worktree live inside that worktree, so
// they vanish the moment the user deletes the worktree. We mirror each surfaced
// report into a durable per-card store under the supervisor data dir, keyed by
// board + dev id, so the card's Reports/Links keep working after cleanup.
// ---------------------------------------------------------------------------
const REPORT_CACHE_DIR = path.join(SUPERVISOR_DATA_DIR, 'dev-report-cache');

function _sanitizeId(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_'; }

function reportCacheDir(boardId, devId) {
  return path.join(REPORT_CACHE_DIR, _sanitizeId(boardId), _sanitizeId(devId));
}

// Copy a worktree-relative file into the durable cache, mirroring `rel`. Both
// the source (inside the worktree) and the destination (inside the cache dir)
// are traversal-guarded. Returns true when a copy was made.
function _cacheCopy(wt, destRoot, rel) {
  try {
    if (!wt || !rel) return false;
    const rootWt = path.resolve(wt);
    const src = path.resolve(rootWt, rel);
    if (!(src === rootWt || src.startsWith(rootWt + path.sep))) return false;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return false;
    const rootDest = path.resolve(destRoot);
    const dest = path.resolve(rootDest, rel);
    if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch { return false; }
}

// Mirror a set of surfaced reports into the durable cache and flag each one that
// has a cached copy (so callers can persist `cached:true` on the dev item and
// keep serving the report after the worktree is removed). Mutates + returns the
// same array. Best-effort: never throws.
function cacheReports(boardId, devId, wt, reports) {
  if (!boardId || !devId || !Array.isArray(reports) || !reports.length) return reports || [];
  const destRoot = reportCacheDir(boardId, devId);
  for (const r of reports) {
    if (!r || !r.rel) continue;
    const ok = _cacheCopy(wt, destRoot, r.rel);
    if (ok || hasCachedReport(boardId, devId, r.rel)) r.cached = true;
  }
  return reports;
}

// Find reports in the worktree AND durably cache them in one shot. Use this
// everywhere instead of bare findReports so nothing is lost on cleanup.
function findAndCacheReports(boardId, devId, wt) {
  const reports = findReports(wt);
  try { cacheReports(boardId, devId, wt, reports); } catch {}
  return reports;
}

function readReportCached(boardId, devId, rel) {
  return _readReportFrom(reportCacheDir(boardId, devId), rel);
}

function hasCachedReport(boardId, devId, rel) {
  try { readReportCached(boardId, devId, rel); return true; } catch { return false; }
}

// Snapshot an arbitrary local file (e.g. the target of a file:// link that lives
// inside a worktree) into the cache under a `links/` namespace. Returns a cache
// rel (e.g. "links/dev-status-report.html") on success, or null. Only mirrors
// report-ish extensions within the size cap.
function cacheLinkFile(boardId, devId, absPath) {
  try {
    if (!boardId || !devId || !absPath) return null;
    const src = path.resolve(absPath);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
    if (fs.statSync(src).size > 8 * 1024 * 1024) return null;
    const ext = path.extname(src).toLowerCase();
    if (!REPORT_EXTS.has(ext)) return null;
    const base = _sanitizeId(path.basename(src));
    const rel = 'links/' + base;
    const rootDest = path.resolve(reportCacheDir(boardId, devId));
    const dest = path.resolve(rootDest, rel);
    if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return rel;
  } catch { return null; }
}

// Remove a card's whole report cache (call when a dev card is deleted).
function clearReportCache(boardId, devId) {
  try { fs.rmSync(reportCacheDir(boardId, devId), { recursive: true, force: true }); } catch {}
}

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

// Open all of a dev card's ready worktrees together. For target 'editor' we write
// a durable multi-root .code-workspace into the dev-worktrees ROOT (so deleting any
// one worktree never loses it) and open it; for 'cli' we launch Copilot CLI in the
// first worktree (the dev agent there is aware of the sibling worktrees).
function openWorkspace({ devId, title, slots, target = 'editor', agent = null }) {
  const { spawn, spawnSync } = require('child_process');
  const list = (slots || []).filter(s => s && s.worktreePath && fs.existsSync(s.worktreePath));
  if (!list.length) throw new Error('No ready worktrees to open');

  if (target === 'cli') {
    const dir = list[0].worktreePath;
    const args = ['/c', 'start', '', 'cmd', '/k', 'copilot'];
    if (agent) { args.push('--agent', agent); }
    spawn(process.env.ComSpec || 'cmd.exe', args, { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    return { target: 'cli', dir };
  }

  // Resolve the editor (VS Code Insiders preferred, then VS Code).
  let editor = 'code';
  const whichIns = spawnSync('where', ['code-insiders'], { shell: true, encoding: 'utf-8' });
  if (whichIns.status === 0 && (whichIns.stdout || '').trim()) editor = 'code-insiders';

  const wsName = _safe(title || devId) + '__' + _safe(devId) + '.code-workspace';
  const wsFile = path.join(DEV_WORKTREES, wsName);
  const ws = {
    folders: list.map(s => ({ path: s.worktreePath, name: s.repo || path.basename(s.worktreePath) })),
    settings: {}
  };
  fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2), 'utf-8');
  spawn(editor, [wsFile], { shell: true, detached: true, stdio: 'ignore' }).unref();
  return { target: 'editor', editor, workspace: wsFile, folders: ws.folders.length };
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
  removeWorktree,
  openWorkspace,
  findReports,
  readReport,
  findAndCacheReports,
  cacheReports,
  readReportCached,
  hasCachedReport,
  cacheLinkFile,
  clearReportCache,
  reportCacheDir
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
