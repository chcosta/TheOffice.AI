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
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const azdo = require('./azdo');
const { forge } = require('./forge');

let SUPERVISOR_DATA_DIR;
try {
  SUPERVISOR_DATA_DIR = require('./config-sync').SUPERVISOR_DATA_DIR;
} catch {
  SUPERVISOR_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
}

const DEV_REPOS = path.join(SUPERVISOR_DATA_DIR, 'dev-repos');
const DEV_WORKTREES = path.join(SUPERVISOR_DATA_DIR, 'dev-worktrees');

// Where new worktrees are created. Prefers the user's configured `worktreeRoot`
// setting; otherwise a SHORT auto path (e.g. C:\a) to maximize Windows MAX_PATH
// (260) headroom for deep repos/obj paths. Existing worktree records store
// absolute paths, so only NEW worktrees follow a changed root. Never throws.
function _shortDefaultRoot() {
  try {
    if (process.platform === 'win32') {
      const root = path.parse(SUPERVISOR_DATA_DIR).root || 'C:\\';
      return path.join(root, 'a');
    }
  } catch {}
  return DEV_WORKTREES;
}

function worktreeRoot() {
  try {
    const s = require('./settings').getSettings();
    const r = s && typeof s.worktreeRoot === 'string' ? s.worktreeRoot.trim() : '';
    if (r) return r;
  } catch {}
  return _shortDefaultRoot();
}

function _safe(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function clonePath(org, project, repo, provider) {
  // GitHub sources live under a dedicated github/<owner>/<repo> subtree (GitHub
  // has no "project"); Azure DevOps keeps its <org>/<project>/<repo> layout.
  if (String(provider || '').toLowerCase() === 'github') {
    return path.join(DEV_REPOS, 'github', _safe(org), _safe(repo));
  }
  return path.join(DEV_REPOS, _safe(org), _safe(project), _safe(repo));
}

function worktreePath(repo, devId) {
  return path.join(worktreeRoot(), _safe(repo) + '__' + _safe(devId));
}

// Build host-scoped git auth args for the record's provider (R10 — the
// credential header only applies to that host so a mixed-provider environment
// can't leak one provider's token to another). AzDo uses a bearer token; GitHub
// uses HTTP basic with x-access-token (the gh/OAuth token as the password).
// `desc` is a {provider, org/owner, project, repo} record; null/true => azdo.
function _authArgs(desc) {
  const provider = String((desc && desc.provider) || 'azdo').toLowerCase();
  if (provider === 'github') {
    const token = forge(desc).getToken();
    const basic = Buffer.from('x-access-token:' + token).toString('base64');
    return ['-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + basic];
  }
  return ['-c', 'http.extraheader=AUTHORIZATION: bearer ' + azdo.getTokenSync()];
}

// Never let a git subprocess launch an interactive credential prompt. We supply
// the token ourselves via http.extraheader (see _authArgs), so git needs no
// credential helper at all — disabling it means a genuinely-unauthenticated op
// fails fast with a clean error instead of popping a Git Credential Manager GUI
// window (the "Connect to GitHub" swarm) or hanging on a stale askpass helper.
// `-c credential.helper=` resets the helper list to empty (kills GCM + any
// configured askpass); GIT_TERMINAL_PROMPT=0 blocks git's own terminal prompt;
// GCM_INTERACTIVE=never is belt-and-suspenders for any GCM still in the chain.
const _NO_PROMPT_ARGS = [
  '-c', 'credential.helper=',
  '-c', 'credential.interactive=false',
  '-c', 'core.askPass='
];
function _noPromptEnv() {
  const env = Object.assign({}, process.env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never'
  });
  // A configured askpass helper (GUI) would bypass the above — drop them.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
}

// Run a git command, throwing on failure with a clean message.
function _git(args, cwd, { auth = false, timeout = 240_000 } = {}) {
  // core.longpaths=true makes git use the \\?\ prefix so deep repo paths
  // (e.g. dotnet-helix-machines) don't exceed the Windows MAX_PATH (260) limit
  // during clone + worktree checkout.
  // `auth` may be false, true (=> azdo default), or a provider descriptor.
  const authArgs = auth ? _authArgs(auth === true ? null : auth) : [];
  const full = ['-c', 'core.longpaths=true']
    .concat(_NO_PROMPT_ARGS)
    .concat(authArgs)
    .concat(args);
  try {
    return execFileSync('git', full, {
      cwd: cwd || undefined,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: _noPromptEnv()
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

// Find the worktree (if any) that currently has local branch `br` checked out
// (non-detached) in this clone. Git allows a given local branch to be checked
// out in only ONE worktree at a time; a second `git worktree add <dir> <br>`
// dies with "fatal: '<br>' is already checked out at '<other>'". Dev cards and
// PR stewards can legitimately want the SAME source branch checked out (both
// need to commit to it), so we detect the existing checkout and SHARE it rather
// than let the add fail. Returns the absolute worktree path, or ''.
function _branchWorktree(clone, br) {
  const r = _gitTry(['worktree', 'list', '--porcelain'], clone);
  if (!r.ok || !r.out) return '';
  let cur = '';
  const want = 'refs/heads/' + br;
  for (const raw of r.out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) { cur = line.slice(9).trim(); continue; }
    if (line === 'branch ' + want || line === 'branch ' + br) return cur;
  }
  return '';
}

// Free local branch `br` from any FOREIGN worktree that currently has it checked
// out (i.e. a worktree other than `keepDir`). Under the current model a real
// branch lives in exactly one place: dev/<slug> in the dev card's own worktree,
// pr/<slug>-N in that PR's own worktree. Anything else holding it is a review
// checkout that should have been detached (legacy non-detached cfpr dirs squat
// the branch and block the rightful owner from `git worktree add`). We detach
// those in place — the working tree stays at the same commit, HEAD just goes
// detached — releasing the branch name. `git worktree add` can then reclaim it.
// Returns the list of dirs we freed (for logging). Never throws.
function _freeBranchFromForeignWorktrees(clone, br, keepDir) {
  const freed = [];
  const r = _gitTry(['worktree', 'list', '--porcelain'], clone);
  if (!r.ok || !r.out) return freed;
  const want = 'refs/heads/' + br;
  const keep = path.resolve(keepDir || '');
  let cur = '';
  const holders = [];
  for (const raw of r.out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) { cur = line.slice(9).trim(); continue; }
    if ((line === 'branch ' + want || line === 'branch ' + br) && cur) holders.push(cur);
  }
  for (const dir of holders) {
    if (keep && path.resolve(dir) === keep) continue;   // the rightful owner — leave it
    // Detach HEAD in place at the current commit so the branch name is released
    // but the checked-out tree (and any review artifacts) survive.
    if (_gitTry(['checkout', '--detach'], dir).ok || _gitTry(['switch', '--detach'], dir).ok) {
      freed.push(dir);
    }
  }
  if (freed.length) _gitTry(['worktree', 'prune'], clone);
  return freed;
}

// Add a worktree for local branch `br`, first freeing it from any foreign
// worktree that squats it (see _freeBranchFromForeignWorktrees). On the initial
// add failing with "already used by worktree", free + retry once. Throws (via
// _git) only if the retry also fails.
function _addBranchWorktreeReclaiming(clone, wt, br) {
  _freeBranchFromForeignWorktrees(clone, br, wt);
  const first = _gitTry(['worktree', 'add', wt, br], clone);
  if (first.ok) return;
  if (/already used by worktree|already checked out/i.test(first.err)) {
    _freeBranchFromForeignWorktrees(clone, br, wt);
    _git(['worktree', 'add', wt, br], clone);   // throw with a clean message if still stuck
    return;
  }
  throw new Error(first.err);
}

// Ensure the managed clone exists and is fetched. Returns the clone path.
// `desc` (optional) carries {provider, org/owner, project, repo}; when absent
// the record is treated as Azure DevOps (back-compat with positional callers).
function ensureClone(org, project, repo, desc) {
  const provider = String((desc && desc.provider) || 'azdo').toLowerCase();
  const auth = desc || true;
  const dir = clonePath(org, project, repo, provider);
  if (_isRepo(dir)) {
    _gitTry(['fetch', '--prune', 'origin'], dir, { auth });
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // Both providers expose cloneUrl(org/owner, project, repo) (GitHub ignores project).
  const url = forge(desc).cloneUrl(org, project, repo);
  _git(['clone', url, dir], path.dirname(dir), { auth });
  return dir;
}

// Resolve a usable base ref in `clone`, falling back to the remote's advertised default
// branch when the requested base can't be found. Guards the "dev card repo was changed"
// case: the old base branch (seeded from the previous repo) won't exist on the new
// remote, and blindly checking out a non-existent base fails with "invalid reference".
// Returns a resolvable ref string (e.g. 'origin/main') or null when nothing resolves.
function _resolveBaseRef(clone, base) {
  const want = (base || '').trim();
  if (want) {
    if (_gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + want], clone).ok) return 'origin/' + want;
    if (_gitTry(['rev-parse', '--verify', '--quiet', want], clone).ok) return want;
  }
  // Remote's advertised default branch (origin/HEAD → e.g. refs/remotes/origin/main).
  const sym = _gitTry(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], clone);
  if (sym.ok && sym.out) {
    const ref = sym.out.trim().replace(/^refs\/remotes\//, '');
    if (ref && _gitTry(['rev-parse', '--verify', '--quiet', ref], clone).ok) return ref;
  }
  for (const cand of ['origin/main', 'origin/master']) {
    if (_gitTry(['rev-parse', '--verify', '--quiet', cand], clone).ok) return cand;
  }
  return null;
}

// Create (or reuse) a worktree for a Dev item. Returns { worktreePath, branch, reused }.
function createWorktree({ org, project, repo, baseBranch, branch, devId, detach, provider }) {
  const desc = provider ? { provider, org, project, repo } : null;
  const clone = ensureClone(org, project, repo, desc);
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

  // NOTE: dev cards own `dev/<slug>` and PRs own `pr/<slug>-<N>` — distinct branch
  // namespaces, each in its OWN worktree dir. A local branch is therefore only ever
  // checked out in ONE worktree, so the old dev↔PR "already checked out → SHARE it"
  // collision guard is no longer needed (and was itself the source of the dev card
  // borrowing the PR's worktree). It has been removed intentionally.

  if (localHas) {
    // Check out the pre-existing local branch into the new worktree (no -b/-B so we
    // don't discard any local commits the branch already carries). If a foreign
    // worktree (e.g. a legacy non-detached PR-review checkout) is squatting the
    // branch, free it first and reclaim — this is the fix for dev cards that could
    // never (re)create their own worktree because a review dir held dev/<slug>.
    _addBranchWorktreeReclaiming(clone, wt, br);
  } else if (remoteHas) {
    // Track the existing remote branch.
    _git(['worktree', 'add', '--track', '-B', br, wt, 'origin/' + br], clone);
  } else {
    // Brand-new branch off the base; no upstream yet (status compares vs origin/base).
    // Resolve the base robustly: the requested base may not exist on this remote (e.g.
    // the card's repo was changed and the old base doesn't exist on the new repo), so
    // fall back to the remote's default branch instead of failing with "invalid
    // reference". Only throw when the remote has no resolvable base at all.
    const baseRef = _resolveBaseRef(clone, base);
    if (!baseRef) throw new Error('Cannot resolve a base branch for ' + repo + ' (tried "' + base + '" and the remote default).');
    _git(['worktree', 'add', '-b', br, wt, baseRef], clone);
  }
  return { worktreePath: wt, branch: br, reused: false };
}

// Create a PR's OWN attached, committable worktree on branch `prBranch`, seeded from
// `fromRef` (typically the dev card's `dev/<slug>` branch tip). The worktree dir is
// keyed by a synthetic devId (e.g. `<devId>--pr<N>`) so it can NEVER be the same dir
// as the dev card's own worktree, and the `pr/…` namespace means it can never be the
// same branch either. Different branch AND different dir ⇒ the old dev↔PR worktree
// collision is structurally impossible. Idempotent: reuses the dir if it already
// exists. Returns { worktreePath, branch, reused }.
function createPrWorktree({ org, project, repo, provider, prBranch, fromRef, wtDevId }) {
  const desc = provider ? { provider, org, project, repo } : null;
  const clone = ensureClone(org, project, repo, desc);
  const br = String(prBranch || '').trim();
  if (!br) throw new Error('createPrWorktree: prBranch is required');
  const wt = worktreePath(repo, wtDevId);
  if (_isRepo(wt)) return { worktreePath: wt, branch: br, reused: true };
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  _gitTry(['worktree', 'prune'], clone);
  const localHas = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok;
  if (localHas) {
    // Branch already exists (e.g. a re-open after the worktree dir was removed) — attach it,
    // freeing it from any foreign worktree squatting it first.
    _addBranchWorktreeReclaiming(clone, wt, br);
  } else {
    // Seed the new PR branch at the dev tip. `fromRef` is a local ref (the dev branch)
    // whose commit is a real object in this shared clone, so branching from it works
    // even though that branch is checked out in the dev worktree (we branch, not check out).
    const seed = String(fromRef || '').trim() || 'HEAD';
    _git(['worktree', 'add', '-b', br, wt, seed], clone);
  }
  return { worktreePath: wt, branch: br, reused: false };
}

// Divergence between a dev card's private working branch (dev/<slug>) and its
// published PR branch (pr/<slug>-<N>). Both are LOCAL refs in the same shared
// clone, so this is a pure local rev-list — no network, no worktree, no fetch.
//   promote = commits on dev not yet on the PR branch  (dev  -> pr, "to promote")
//   pull    = commits on the PR branch not yet on dev  (pr   -> dev, "to pull back")
// A non-zero `pull` means the PR branch moved on its own (review-time commits,
// a promote from a sibling, a squash) and the dev branch is behind it. Returns
// { promote, pull, comparable } — comparable=false when either ref is missing
// (e.g. no PR yet, or the clone hasn't been created). Never throws.
function devPrDivergence({ org, project, repo, provider = 'azdo', devBranch, prBranch } = {}) {
  const zero = { promote: 0, pull: 0, comparable: false };
  const dev = String(devBranch || '').replace(/^refs\/heads\//, '').trim();
  const pr = String(prBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!dev || !pr) return zero;
  const clone = clonePath(org, project, repo, String(provider || 'azdo').toLowerCase());
  if (!_isRepo(clone)) return zero;
  const devRef = 'refs/heads/' + dev;
  const prRef = 'refs/heads/' + pr;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', devRef], clone).ok) return zero;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', prRef], clone).ok) return zero;
  // `--left-right --count A...B`: left = reachable from A not B, right = from B not A.
  // A=prRef, B=devRef  =>  left = on pr not dev (pull), right = on dev not pr (promote).
  const counts = _gitTry(['rev-list', '--left-right', '--count', prRef + '...' + devRef], clone);
  if (!counts.ok) return zero;
  const m = counts.out.split(/\s+/);
  const pull = parseInt(m[0], 10) || 0;
  const promote = parseInt(m[1], 10) || 0;
  return { promote, pull, comparable: true };
}

// Promote a dev card's private work onto its PUBLISHED PR branch (dev -> pr) and
// push it so the open PR picks up the new commits. Runs inside the PR's OWN
// worktree (never the dev worktree — dev/<slug> and pr/<slug>-<N> are on distinct
// branches in distinct dirs, so this never fights the dev checkout). Fast-forwards
// when the PR branch is a strict ancestor of dev (the common case: PR seeded at the
// dev tip, dev advanced, PR untouched); otherwise creates a merge commit so
// review-time commits on the PR branch are preserved. `desc` carries provider auth
// for the push. Returns { ok, promoted, pushed, message }. Never throws.
function promoteToPr(prWt, { devBranch, prBranch, desc = null } = {}) {
  if (!prWt || !_isRepo(prWt)) return { ok: false, promoted: 0, pushed: false, message: 'PR worktree is missing — create the PR first.' };
  const dev = String(devBranch || '').replace(/^refs\/heads\//, '').trim();
  const pr = String(prBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!dev || !pr) return { ok: false, promoted: 0, pushed: false, message: 'devBranch and prBranch are required.' };
  const devRef = 'refs/heads/' + dev;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', devRef], prWt).ok) return { ok: false, promoted: 0, pushed: false, message: 'Dev branch ' + dev + ' not found.' };
  // Make sure the PR worktree is actually on the PR branch before we merge into it.
  const cur = (_gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], prWt).out || '').trim();
  if (cur !== pr) {
    const co = _gitTry(['checkout', pr], prWt);
    if (!co.ok) return { ok: false, promoted: 0, pushed: false, message: 'Could not switch the PR worktree to ' + pr + ': ' + co.err.split('\n').slice(-2).join(' ').slice(0, 200) };
  }
  const cnt = _gitTry(['rev-list', '--count', pr + '..' + dev], prWt);
  const n = cnt.ok ? (parseInt(cnt.out, 10) || 0) : 0;
  if (n === 0) return { ok: true, promoted: 0, pushed: false, message: 'The PR is already up to date with dev.' };
  _ensureGitIdentity(prWt);
  let merged = _gitTry(['merge', '--ff-only', devRef], prWt);
  if (!merged.ok) merged = _gitTry(['merge', '--no-edit', devRef], prWt);
  if (!merged.ok) {
    // Collect the conflicting paths, then abort so the PR worktree is left clean
    // (not mid-conflict). The caller surfaces { conflict, files } so the UI can
    // offer the merge-steward playbook instead of a raw failure.
    let files = [];
    try {
      const u = _gitTry(['diff', '--name-only', '--diff-filter=U'], prWt);
      files = (u.out || '').split('\n').map(s => s.trim()).filter(Boolean);
    } catch {}
    _gitTry(['merge', '--abort'], prWt);
    const isConflict = files.length > 0 || /conflict/i.test(merged.err || '');
    return {
      ok: false, promoted: n, pushed: false, conflict: isConflict, files,
      message: isConflict
        ? 'Promoting ' + dev + ' into ' + pr + ' hit ' + (files.length ? files.length + ' conflicting file' + (files.length === 1 ? '' : 's') : 'conflicts') + '. A merge steward can resolve them safely.'
        : 'Could not promote (merge failed): ' + merged.err.split('\n').slice(-2).join(' ').slice(0, 260)
    };
  }
  const push = _gitTry(['push', 'origin', pr], prWt, { auth: desc || true });
  if (!push.ok) return { ok: false, promoted: n, pushed: false, message: 'Promoted locally but the push failed: ' + push.err.split('\n').slice(-2).join(' ').slice(0, 260) };
  return { ok: true, promoted: n, pushed: true, message: 'Promoted ' + n + ' commit' + (n === 1 ? '' : 's') + ' to the PR.' };
}

// Pull review-time commits from the PUBLISHED PR branch back into the dev card's
// private working branch (pr -> dev). Runs inside the DEV worktree. The dev branch
// is never pushed, so this is a local merge only. Fast-forwards when dev is a strict
// ancestor of the PR branch; otherwise a merge commit. Returns
// { ok, pulled, message }. Never throws.
function pullFromPr(devWt, { devBranch, prBranch } = {}) {
  if (!devWt || !_isRepo(devWt)) return { ok: false, pulled: 0, message: 'Dev worktree is missing.' };
  const dev = String(devBranch || '').replace(/^refs\/heads\//, '').trim();
  const pr = String(prBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!dev || !pr) return { ok: false, pulled: 0, message: 'devBranch and prBranch are required.' };
  const prRef = 'refs/heads/' + pr;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', prRef], devWt).ok) return { ok: false, pulled: 0, message: 'PR branch ' + pr + ' not found.' };
  const cur = (_gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], devWt).out || '').trim();
  if (cur !== dev) {
    const co = _gitTry(['checkout', dev], devWt);
    if (!co.ok) return { ok: false, pulled: 0, message: 'Could not switch the dev worktree to ' + dev + ': ' + co.err.split('\n').slice(-2).join(' ').slice(0, 200) };
  }
  const cnt = _gitTry(['rev-list', '--count', dev + '..' + pr], devWt);
  const n = cnt.ok ? (parseInt(cnt.out, 10) || 0) : 0;
  if (n === 0) return { ok: true, pulled: 0, message: 'Dev is already up to date with the PR.' };
  _ensureGitIdentity(devWt);
  let merged = _gitTry(['merge', '--ff-only', prRef], devWt);
  if (!merged.ok) merged = _gitTry(['merge', '--no-edit', prRef], devWt);
  if (!merged.ok) return { ok: false, pulled: n, message: 'Could not pull (merge failed — resolve conflicts in the dev worktree): ' + merged.err.split('\n').slice(-2).join(' ').slice(0, 260) };
  return { ok: true, pulled: n, message: 'Pulled ' + n + ' review commit' + (n === 1 ? '' : 's') + ' into dev.' };
}

// Merge one aspect's branch INTO another aspect's branch, running inside the
// TARGET aspect's worktree. Both branches are local branches of the same shared
// clone (every aspect is a worktree of it), so this is a local merge only — the
// source branch is referenced as a ref and never checked out here. Nothing is
// pushed; the caller decides whether to promote/push afterwards (e.g. when the
// target aspect owns the repo PR). Fast-forwards when possible, else a merge
// commit. Returns { ok, merged, message }. Never throws.
function mergeAspectBranch(targetWt, { sourceBranch, targetBranch, desc = null } = {}) {
  if (!targetWt || !_isRepo(targetWt)) return { ok: false, merged: 0, message: 'Target aspect worktree is missing.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  const tgt = String(targetBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src || !tgt) return { ok: false, merged: 0, message: 'sourceBranch and targetBranch are required.' };
  if (src === tgt) return { ok: false, merged: 0, message: 'An aspect cannot merge into itself.' };
  const srcRef = 'refs/heads/' + src;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', srcRef], targetWt).ok) return { ok: false, merged: 0, message: 'Source aspect branch ' + src + ' not found.' };
  // Ensure the target worktree is actually on the target branch before merging.
  const cur = (_gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], targetWt).out || '').trim();
  if (cur !== tgt) {
    const co = _gitTry(['checkout', tgt], targetWt);
    if (!co.ok) return { ok: false, merged: 0, message: 'Could not switch the target aspect worktree to ' + tgt + ': ' + co.err.split('\n').slice(-2).join(' ').slice(0, 200) };
  }
  const cnt = _gitTry(['rev-list', '--count', tgt + '..' + src], targetWt);
  const n = cnt.ok ? (parseInt(cnt.out, 10) || 0) : 0;
  if (n === 0) return { ok: true, merged: 0, message: 'This aspect already contains everything from ' + src + '.' };
  _ensureGitIdentity(targetWt);
  let merged = _gitTry(['merge', '--ff-only', srcRef], targetWt);
  if (!merged.ok) merged = _gitTry(['merge', '--no-edit', srcRef], targetWt);
  if (!merged.ok) {
    // Abort a half-applied merge so the worktree is left clean, not mid-conflict.
    _gitTry(['merge', '--abort'], targetWt);
    return { ok: false, merged: n, conflict: true, message: 'Merge failed — resolve conflicts in the target aspect worktree: ' + merged.err.split('\n').slice(-2).join(' ').slice(0, 260) };
  }
  return { ok: true, merged: n, message: 'Merged ' + n + ' commit' + (n === 1 ? '' : 's') + ' from ' + src + '.' };
}

// Compute ahead/behind/dirty for a worktree. Optionally fetch first.
// `desc` (optional) is a provider descriptor ({provider, org/owner, project, repo});
// when present its host-scoped auth is used for the remote fetch (GitHub HTTP-basic
// vs AzDO bearer). Omitted ⇒ auth:true ⇒ the AzDO default (byte-identical, no change).
function worktreeStatus(wt, { fetch = true, baseBranch = 'main', desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });

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
  // Exclude agent-generated status reports (IMPLEMENTATION_SUMMARY.md, etc.) from
  // the dirty signal — they're surfaced on the card but intentionally never
  // committed, so they must not light up the worktree as "dirty".
  const cls = classifyPorcelain(_gitTry(['status', '--porcelain', '-uall'], wt).out || '');
  const dirty = cls.dirty;
  // HEAD commit sha — lets callers detect a new commit even when ahead/behind
  // don't move (e.g. an amend, or a commit that also pulled base in).
  const head = _gitTry(['rev-parse', 'HEAD'], wt).out || '';

  return {
    branch, head,
    upstream: up.ok ? up.out : '',
    tracking: compare === '@{u}' ? (up.out || '') : compare,
    ahead, behind, comparable, dirty,
    ignoredReports: cls.ignored,
    lastChecked: new Date().toISOString()
  };
}

// Detailed commit-level view of a worktree branch vs its tracked remote — the
// branch's own origin/<branch> when an upstream exists, else origin/<baseBranch>.
// Lets the UI show exactly which commits are local-only (unpushed), which exist
// on the remote but are missing locally (behind), and a recent-history list with
// each commit tagged pushed/local. For a branch with an open PR the upstream IS
// the PR's source branch, so this doubles as "local worktree vs PR branch".
// Never throws; returns null when the path is not a repo.
function branchCommits(wt, { baseBranch = 'main', limit = 40, fetch = false, desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });
  const branch = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt).out || '';
  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  const hasUpstream = up.ok && !!up.out;
  const tracking = hasUpstream ? up.out : ('origin/' + (baseBranch || 'main'));
  const trackingExists = _gitTry(['rev-parse', '--verify', '--quiet', tracking], wt).ok;
  const SEP = '\x1f';
  const FMT = ['%H', '%h', '%s', '%an', '%aI'].join(SEP);
  const parse = (out) => String(out || '').split('\n').filter(Boolean).map((l) => {
    const [sha, short, subject, author, date] = l.split(SEP);
    return { sha, short, subject, author, date };
  });
  let ahead = [], behind = [];
  if (trackingExists) {
    ahead = parse(_gitTry(['log', tracking + '..HEAD', '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
    behind = parse(_gitTry(['log', 'HEAD..' + tracking, '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
  }
  const recent = parse(_gitTry(['log', 'HEAD', '--pretty=format:' + FMT, '-n', String(limit)], wt).out);
  const aheadSet = new Set(ahead.map((c) => c.sha));
  for (const c of recent) c.pushed = trackingExists ? !aheadSet.has(c.sha) : false;
  return {
    branch, tracking, hasUpstream, trackingExists,
    ahead, behind, recent,
    aheadCount: ahead.length, behindCount: behind.length,
    truncated: recent.length >= limit,
    lastChecked: new Date().toISOString()
  };
}

// Fetch + fast-forward the worktree. Returns { ok, message, status }.
function syncWorktree(wt, { baseBranch = 'main', desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to sync.' };
  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });

  const up = _gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
  let res;
  if (up.ok && up.out) {
    res = _gitTry(['pull', '--ff-only'], wt, { auth: desc || true });
  } else {
    // No upstream: fast-forward onto the base branch instead.
    res = _gitTry(['merge', '--ff-only', 'origin/' + (baseBranch || 'main')], wt);
  }
  const status = worktreeStatus(wt, { fetch: false, baseBranch, desc });
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
function pushBranch(wt, { branch, desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, branch: '', message: 'No worktree to push.' };
  let br = String(branch || '').trim();
  if (!br) {
    const cur = _gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
    br = cur.ok ? cur.out.trim() : '';
  }
  if (!br || br === 'HEAD') return { ok: false, branch: '', message: 'Could not determine the branch to push.' };
  const res = _gitTry(['push', '-u', 'origin', br], wt, { auth: desc || true });
  return {
    ok: res.ok,
    branch: br,
    message: res.ok ? 'Pushed.' : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Push failed.')
  };
}

// Ensure the worktree has a committer identity so `git commit` won't fail on a
// machine with no global user.name/user.email. Sets a repo-local identity only
// when one is missing. Best-effort.
function _ensureGitIdentity(wt) {
  const name = _gitTry(['config', 'user.name'], wt);
  if (!name.ok || !name.out) _gitTry(['config', 'user.name', 'TheOffice.AI'], wt);
  const email = _gitTry(['config', 'user.email'], wt);
  if (!email.ok || !email.out) _gitTry(['config', 'user.email', 'noreply@theoffice.ai'], wt);
}

// Stage every change in the worktree and commit it. Used to make sure a user's
// uncommitted local edits are captured before a push / PR. Returns
// { ok, committed, files, message }. committed=false (ok:true) when nothing was
// staged (clean tree) — that is not an error.
// List a worktree's uncommitted changes, split into committable `changed` and
// ignorable agent-report `ignored`, each entry `{ path, xy }` where xy is the
// 2-char git porcelain status (e.g. " M", "??", "A "). Never throws.
function worktreeChanges(wt) {
  if (!wt || !_isRepo(wt)) return { dirty: false, changed: [], ignored: [] };
  // NB: parse the UNTRIMMED porcelain output. `git status --porcelain` is
  // column-aligned (2 status chars + space + path); a worktree-only change like
  // " M path" starts with a space, and _gitTry's global .trim() would eat that
  // leading space, shifting every slice by one and corrupting the first path.
  let out = '';
  try { out = _git(['status', '--porcelain', '-uall'], wt); } catch (_) { return { dirty: false, changed: [], ignored: [] }; }
  const changed = [], ignored = [];
  for (const raw of out.split('\n')) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    let p = raw.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    (isIgnorableWorktreePath(p) ? ignored : changed).push({ path: p, xy });
  }
  return { dirty: changed.length > 0, changed, ignored };
}

// Discard a worktree's uncommitted committable changes: hard-reset tracked edits
// and remove untracked files. Excluded agent reports (info/exclude) are left in
// place (git clean without -x skips ignored/excluded). Returns { ok, message }.
function discardWorktreeChanges(wt) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to clean.' };
  const reset = _gitTry(['reset', '--hard', 'HEAD'], wt);
  if (!reset.ok) return { ok: false, message: reset.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Reset failed.' };
  _gitTry(['clean', '-fd'], wt);  // remove untracked (keeps excluded reports)
  return { ok: true, message: 'Discarded uncommitted changes.' };
}

function commitAll(wt, { message } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, committed: false, files: 0, message: 'No worktree to commit.' };
  // Only committable paths — build output, generated reports and agent artifacts
  // are classified as ignorable and must never be swept into the user's PR, even
  // though git itself would happily stage them under `git add -A`.
  const wc = worktreeChanges(wt);
  const files = wc.changed.length;
  if (!files) return { ok: true, committed: false, files: 0, message: 'Nothing to commit.' };
  _ensureGitIdentity(wt);
  const paths = wc.changed.map(c => c.path);
  const add = _gitTry(['add', '--', ...paths], wt);   // stages edits, adds and deletions
  if (!add.ok) return { ok: false, committed: false, files, message: add.err.slice(0, 300) || 'git add failed.' };
  const msg = String(message || '').trim() || 'Commit local changes';
  const res = _gitTry(['commit', '-m', msg], wt);
  if (!res.ok) return { ok: false, committed: false, files, message: res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Commit failed.' };
  return { ok: true, committed: true, files, message: 'Committed ' + files + ' change' + (files === 1 ? '' : 's') + '.' };
}

// Drift of a worktree vs a specific remote PR/source branch (origin/<branch>).
// Unlike worktreeStatus (which compares to @{u} or origin/base), this always
// compares the local HEAD to the PR's own source branch on origin — the right
// signal for "does my local checkout match the PR branch?". Optionally fetches.
// Returns { sourceBranch, localHead, remoteHead, ahead, behind, dirty, comparable, inSync, lastChecked } or null.
function prDrift(wt, sourceBranch, { fetch = true, desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return null;
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (fetch) _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });
  const localHead = _gitTry(['rev-parse', 'HEAD'], wt).out || '';
  const remoteRef = src ? 'origin/' + src : '';
  const remoteHead = src ? (_gitTry(['rev-parse', '--verify', '--quiet', remoteRef], wt).out || '') : '';
  let ahead = 0, behind = 0, comparable = false;
  if (src && remoteHead) {
    const counts = _gitTry(['rev-list', '--left-right', '--count', remoteRef + '...HEAD'], wt);
    if (counts.ok) {
      const m = counts.out.split(/\s+/);
      behind = parseInt(m[0], 10) || 0;
      ahead = parseInt(m[1], 10) || 0;
      comparable = true;
    }
  }
  const cls = classifyPorcelain(_gitTry(['status', '--porcelain', '-uall'], wt).out || '');
  const dirty = cls.dirty;
  const inSync = comparable && ahead === 0 && behind === 0 && !dirty;
  return {
    sourceBranch: src, localHead, remoteHead,
    ahead, behind, dirty, comparable, inSync,
    ignoredReports: cls.ignored,
    lastChecked: new Date().toISOString()
  };
}

// Push the worktree's current HEAD up to the PR's source branch on origin. Works
// even when the worktree is on a detached HEAD (review worktrees) by pushing
// `HEAD:refs/heads/<sourceBranch>`. Commits any uncommitted changes first so the
// user's full local state lands on the PR. Returns { ok, committed, files, message, drift }.
function pushPrBranch(wt, { sourceBranch, message, desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to push.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src) return { ok: false, message: 'No PR source branch to push to.' };
  let committed = false, files = 0;
  const c = commitAll(wt, { message: message || ('Update ' + src) });
  if (!c.ok) return { ok: false, message: c.message };
  committed = c.committed; files = c.files;
  const res = _gitTry(['push', 'origin', 'HEAD:refs/heads/' + src], wt, { auth: desc || true });
  if (!res.ok) {
    const nonff = /non-fast-forward|fetch first|rejected/i.test(res.err);
    return {
      ok: false, committed, files,
      message: nonff
        ? 'Push rejected — the PR branch has moved on the server. Sync your worktree first, then push.'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Push failed.')
    };
  }
  const drift = prDrift(wt, src, { fetch: true, desc });
  return {
    ok: true, committed, files, drift,
    message: (committed ? ('Committed ' + files + ' change' + (files === 1 ? '' : 's') + ' and pushed.') : 'Pushed.')
  };
}

// ── Hardened self-push (Director PR shepherd) ──────────────────────────────
// Advance a PR's OWN head ref by a compare-and-swap fast-forward, with every
// guard the shepherd needs to touch a PR safely and unattended:
//   • CAS: the remote ref must EXACTLY equal `expectedOldSha` at push time
//     (--force-with-lease=<ref>:<oldSha>) — a branch that moved is rejected, not
//     clobbered.
//   • Fast-forward ONLY: local HEAD must descend from the remote head
//     (merge-base --is-ancestor) — history is advanced, never rewritten.
//   • Exact refspec HEAD:refs/heads/<src>; no tags, no deletes, no wildcards.
//   • The branch name is validated (no refs/, no '..', no leading '-', no ctl).
//   • Every changed path (remoteHead..HEAD) must be covered by the caller's grant
//     via isCovered() — a diff that strays outside the grant is refused.
//   • The tree must be clean of committable changes (the caller commits first),
//     so exactly the committed HEAD is what lands.
// It performs NO commit and NO merge — purely the push. Returns a rich result;
// never throws.
function _safeBranchName(src) {
  if (!src || typeof src !== 'string') return false;
  if (src.length > 255) return false;
  if (/^refs\//i.test(src)) return false;
  if (src.startsWith('-') || src.startsWith('/') || src.endsWith('/')) return false;
  if (src.includes('..') || src.includes('//')) return false;
  if (/[\s~^:?*\[\\\x00-\x1f]/.test(src)) return false;   // git ref-format illegals + whitespace/control
  if (/@\{/.test(src) || src === '@') return false;
  return /^[\w][\w.\-\/]*$/.test(src);
}
function pushPrBranchSafe(wt, { sourceBranch, expectedOldSha, isCovered = null, desc = null } = {}) {
  const fail = (reason, extra) => Object.assign({ ok: false, pushed: false, reason }, extra || {});
  if (!wt || !_isRepo(wt)) return fail('no-worktree');
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!_safeBranchName(src)) return fail('bad-branch-name', { branch: src });

  const localHead = _gitTry(['rev-parse', 'HEAD'], wt).out.trim();
  if (!/^[0-9a-f]{40}$/i.test(localHead)) return fail('no-local-head');

  // Committable tree must be clean — the caller stages+commits before pushing so
  // the pushed content is exactly this HEAD (ignorable agent reports don't count).
  if (worktreeChanges(wt).dirty) return fail('dirty-tree');

  // Truth from the server, not a stale tracking ref.
  const f = _gitTry(['fetch', '--prune', 'origin', src], wt, { auth: desc || true });
  if (!f.ok) return fail('fetch-failed', { detail: f.err.split('\n').slice(-2).join(' ').slice(0, 300) });
  const remoteHead = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + src], wt).out.trim();
  if (!/^[0-9a-f]{40}$/i.test(remoteHead)) return fail('remote-branch-missing', { branch: src });

  // Compare-and-swap precondition: the branch must not have moved since we observed it.
  if (expectedOldSha && String(expectedOldSha).toLowerCase() !== remoteHead.toLowerCase()) {
    return fail('remote-moved', { expectedOldSha, remoteHead });
  }
  if (localHead.toLowerCase() === remoteHead.toLowerCase()) return fail('no-change', { remoteHead });

  // Fast-forward only — local HEAD must be a descendant of the remote head.
  const anc = _gitTry(['merge-base', '--is-ancestor', remoteHead, 'HEAD'], wt);
  if (!anc.ok) return fail('not-fast-forward', { remoteHead, localHead });

  // Diff must stay inside the grant. Every changed path is checked; a single
  // stray path aborts the whole push.
  const diff = _gitTry(['diff', '--name-only', remoteHead + '..HEAD'], wt);
  if (!diff.ok) return fail('diff-failed', { detail: diff.err.slice(0, 200) });
  const changed = diff.out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!changed.length) return fail('no-diff');   // shouldn't happen given the SHAs differ, but be defensive
  if (typeof isCovered === 'function') {
    const rejected = changed.filter(p => !isCovered(p));
    if (rejected.length) return fail('path-outside-grant', { rejectedPaths: rejected.slice(0, 20), changed: changed.length });
  }

  // The push: exact refspec, CAS lease on the observed remote head, no force, no tags.
  const res = _gitTry([
    'push',
    '--force-with-lease=refs/heads/' + src + ':' + remoteHead,
    'origin', 'HEAD:refs/heads/' + src,
  ], wt, { auth: desc || true });
  if (!res.ok) {
    const stale = /stale info|force-with-lease|non-fast-forward|fetch first|rejected/i.test(res.err);
    return fail(stale ? 'push-rejected-moved' : 'push-failed', { detail: res.err.split('\n').slice(-2).join(' ').slice(0, 300) });
  }
  return { ok: true, pushed: true, reason: 'pushed', branch: src, oldHead: remoteHead, newHead: localHead, changed: changed.length };
}

// Bring the worktree in line with the PR's source branch tip on origin by a hard
// reset. Intended for read-only review worktrees (no local work to preserve).
// Refuses when the local checkout has its own unpushed commits or uncommitted
// edits unless force=true, so a user's work is never silently discarded.
// Returns { ok, message, drift }.
function syncToPrBranch(wt, { sourceBranch, force = false, desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to sync.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src) return { ok: false, message: 'No PR source branch to sync to.' };
  const pre = prDrift(wt, src, { fetch: true, desc });
  if (!pre || !pre.remoteHead) return { ok: false, message: 'The PR source branch was not found on origin.', drift: pre };
  if (!force && (pre.ahead > 0 || pre.dirty)) {
    return {
      ok: false, needsForce: true, drift: pre,
      message: 'Your local worktree has ' + (pre.ahead > 0 ? pre.ahead + ' unpushed commit' + (pre.ahead === 1 ? '' : 's') : '') +
        (pre.ahead > 0 && pre.dirty ? ' and ' : '') + (pre.dirty ? 'uncommitted changes' : '') +
        '. Syncing will discard them. Push first, or confirm to overwrite.'
    };
  }
  if (pre.inSync) return { ok: true, message: 'Already up to date with the PR branch.', drift: pre };
  const res = _gitTry(['reset', '--hard', 'origin/' + src], wt);
  if (!res.ok) return { ok: false, message: res.err.split('\n').slice(-2).join(' ').slice(0, 300) || 'Sync failed.', drift: pre };
  const drift = prDrift(wt, src, { fetch: false, desc });
  return { ok: true, message: 'Synced to the PR branch.', drift };
}

// True when the worktree has uncommitted changes to TRACKED files (staged or
// unstaged, minus ignorable agent/report artifacts). Untracked files — build
// output like artifacts/**, obj/**, generated files — are deliberately NOT
// counted: git merge/rebase run fine with them present and abort cleanly only if
// one would actually be overwritten. Gating merge/rebase-style "update" actions
// on this (instead of the -uall dirty check) stops stray build artifacts from
// blocking a pull the user's real (tracked) tree is perfectly clean for.
function _trackedDirty(wt) {
  const out = _gitTry(['status', '--porcelain', '-uno'], wt).out || '';
  return classifyPorcelain(out).dirty;
}

// Bring the PR/source branch up to date with its TARGET (base) branch by merging
// or rebasing origin/<targetBranch> into the worktree's HEAD — the classic "my PR
// is behind main, catch it up" operation. This is the OPPOSITE direction of
// syncToPrBranch (which pulls the PR branch down); here we pull the target branch
// INTO the PR branch. It never pushes — the caller pushes separately (steward-only)
// via pushPrBranch once satisfied. A merge/rebase needs a clean tree, so it refuses
// (needsClean) when there are uncommitted changes rather than silently stashing.
// On conflict it aborts cleanly (leaving the worktree usable) and returns
// { ok:false, conflict:true, strategy } so the UI can offer the other strategy or
// manual resolution. Returns { ok, message, drift, conflict?, needsClean?, noop? }.
function updateFromTargetBranch(wt, { sourceBranch, targetBranch, strategy = 'merge', desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to update.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  const tgt = String(targetBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!tgt) return { ok: false, message: 'No target branch to update from.' };
  const mode = strategy === 'rebase' ? 'rebase' : 'merge';

  // A merge/rebase needs a clean tree — never silently discard the user's work.
  // Only TRACKED changes block; untracked build output (artifacts/**, obj/**)
  // doesn't stop git and shouldn't stop us.
  if (_trackedDirty(wt)) {
    return { ok: false, needsClean: true, message: 'Commit or discard your uncommitted changes before updating from ' + tgt + '.' };
  }

  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });
  const tgtRef = 'origin/' + tgt;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', tgtRef], wt).ok) {
    return { ok: false, message: 'The target branch ' + tgt + ' was not found on origin.' };
  }

  // Already contains the target tip (target is an ancestor of HEAD) — nothing to do.
  if (_gitTry(['merge-base', '--is-ancestor', tgtRef, 'HEAD'], wt).ok) {
    const drift = src ? prDrift(wt, src, { fetch: false, desc }) : null;
    return { ok: true, noop: true, message: 'Already up to date with ' + tgt + '.', drift };
  }

  const res = mode === 'rebase'
    ? _gitTry(['rebase', tgtRef], wt)
    : _gitTry(['merge', '--no-edit', tgtRef], wt);
  if (!res.ok) {
    // Conflict (or other failure) — abort so the worktree is left clean and usable.
    _gitTry([mode, '--abort'], wt);
    const conflict = /conflict/i.test(res.err || '') || /CONFLICT/.test(res.err || '');
    return {
      ok: false, conflict, strategy: mode,
      message: conflict
        ? (mode === 'rebase' ? 'Rebase' : 'Merge') + ' onto ' + tgt + ' hit conflicts and was aborted. Try the other strategy or resolve manually in the worktree.'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || (mode + ' failed.'))
    };
  }
  const drift = src ? prDrift(wt, src, { fetch: false, desc }) : null;
  return { ok: true, message: (mode === 'rebase' ? 'Rebased onto ' : 'Merged in ') + tgt + '.', drift };
}

// Bring the local PR branch up to date with its OWN remote tip by merging (or
// rebasing) origin/<sourceBranch> INTO the worktree's HEAD — the "the PR branch
// moved on the server, pull those commits down while keeping my local commits"
// operation. Unlike syncToPrBranch (a hard reset that DISCARDS local commits),
// this preserves local work by integrating the two histories. Never pushes; the
// caller pushes separately once satisfied. Needs a clean tree (refuses with
// needsClean otherwise). On conflict it aborts cleanly and returns
// { ok:false, conflict:true, strategy } so the UI can offer the other strategy or
// manual resolution. Returns { ok, message, drift, conflict?, needsClean?, noop? }.
function pullPrBranch(wt, { sourceBranch, strategy = 'merge', desc = null } = {}) {
  if (!wt || !_isRepo(wt)) return { ok: false, message: 'No worktree to update.' };
  const src = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  if (!src) return { ok: false, message: 'No PR source branch to update from.' };
  const mode = strategy === 'rebase' ? 'rebase' : 'merge';

  // Only TRACKED changes block the merge/rebase; untracked build output
  // (artifacts/**, obj/**) is left to git and shouldn't stop the pull.
  if (_trackedDirty(wt)) {
    return { ok: false, needsClean: true, message: 'Commit or discard your uncommitted changes before updating from the PR branch.' };
  }

  _gitTry(['fetch', '--prune', 'origin'], wt, { auth: desc || true });
  const srcRef = 'origin/' + src;
  if (!_gitTry(['rev-parse', '--verify', '--quiet', srcRef], wt).ok) {
    return { ok: false, message: 'The PR branch ' + src + ' was not found on origin.' };
  }

  // Already contains the remote tip (remote is an ancestor of HEAD) — nothing to pull.
  if (_gitTry(['merge-base', '--is-ancestor', srcRef, 'HEAD'], wt).ok) {
    const drift = prDrift(wt, src, { fetch: false, desc });
    return { ok: true, noop: true, message: 'Already up to date with the PR branch.', drift };
  }

  const res = mode === 'rebase'
    ? _gitTry(['rebase', srcRef], wt)
    : _gitTry(['merge', '--no-edit', srcRef], wt);
  if (!res.ok) {
    _gitTry([mode, '--abort'], wt);
    const conflict = /conflict/i.test(res.err || '') || /CONFLICT/.test(res.err || '');
    return {
      ok: false, conflict, strategy: mode,
      message: conflict
        ? (mode === 'rebase' ? 'Rebase' : 'Merge') + ' of the PR branch hit conflicts and was aborted. Try the other strategy or resolve manually in the worktree.'
        : (res.err.split('\n').slice(-2).join(' ').slice(0, 300) || (mode + ' failed.'))
    };
  }
  const drift = prDrift(wt, src, { fetch: false, desc });
  return { ok: true, message: (mode === 'rebase' ? 'Rebased onto the PR branch.' : 'Merged in the PR branch.'), drift };
}
// [{ path, branch|null, detached }]. Empty on any problem.
function listWorktrees(org, project, repo, provider) {
  const clone = clonePath(org, project, repo, provider);
  if (!_isRepo(clone)) return [];
  const r = _gitTry(['worktree', 'list', '--porcelain'], clone);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null, detached: false };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && cur) {
      cur.detached = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Resolve a directly-usable (branch-attached) worktree directory for a PR branch,
// so opening "Open → CLI/Dev Cmd/Explorer" lands the user on the real branch — ready
// to fetch/rebase/push — instead of a detached read-only review snapshot.
//
// Preference order:
//  1. `current` is itself already checked out on the branch → use it.
//  2. Another worktree is checked out on the branch (e.g. a dev card's "Work
//     worktree") → reuse that directory.
//  3. The branch isn't checked out anywhere AND `current` is a clean detached
//     review checkout sitting exactly at the branch tip → attach it onto the
//     branch (no commits lost) so it becomes usable.
// Otherwise fall back to `current`. Returns { dir, branch, reused, attached }.
function resolveUsableWorktree({ org, project, repo, provider, sourceBranch, current, readOnly = false } = {}) {
  const br = String(sourceBranch || '').replace(/^refs\/heads\//, '').trim();
  const fallback = { dir: current || '', branch: br, reused: false, attached: false };
  if (!br) return fallback;
  const norm = (p) => { try { return path.resolve(String(p || '')).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
  let wts;
  try { wts = listWorktrees(org, project, repo, provider); } catch { return fallback; }
  const curN = norm(current);

  // 1. Current worktree already on the branch.
  const cur = wts.find(w => norm(w.path) === curN);
  if (cur && !cur.detached && cur.branch === br && fs.existsSync(cur.path)) {
    return { dir: cur.path, branch: br, reused: true, attached: false };
  }
  // 2. Another worktree checked out on the branch (e.g. a dev card Work worktree).
  const onBranch = wts.find(w => !w.detached && w.branch === br && norm(w.path) !== curN && fs.existsSync(w.path));
  if (onBranch) return { dir: onBranch.path, branch: br, reused: true, attached: false };

  // 3. Branch is free — attach the current detached review worktree onto it, but
  // only when it's clean and sitting exactly at the branch tip so no work is lost.
  // Skipped in read-only mode (used for presence checks) since it mutates git state.
  if (!readOnly && current && _isRepo(current)) {
    const clone = clonePath(org, project, repo);
    const localHas = _gitTry(['rev-parse', '--verify', '--quiet', 'refs/heads/' + br], clone).ok;
    const remoteHas = _gitTry(['rev-parse', '--verify', '--quiet', 'origin/' + br], clone).ok;
    const headSha = (_gitTry(['rev-parse', 'HEAD'], current).out || '').trim();
    const tgtRef = localHas ? ('refs/heads/' + br) : (remoteHas ? 'origin/' + br : '');
    const tgtSha = tgtRef ? (_gitTry(['rev-parse', tgtRef], clone).out || '').trim() : '';
    const clean = !(_gitTry(['status', '--porcelain'], current).out || '').trim();
    if (tgtRef && headSha && tgtSha && headSha === tgtSha && clean) {
      const sw = localHas
        ? _gitTry(['switch', br], current)
        : _gitTry(['switch', '-c', br, '--track', 'origin/' + br], current);
      if (sw.ok) return { dir: current, branch: br, reused: false, attached: true };
    }
  }
  return fallback;
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
function removeWorktree(org, project, repo, devId, wt, provider) {
  const target = wt || worktreePath(repo, devId);
  const clone = clonePath(org, project, repo, provider);
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

// A worktree change is "ignorable" when it's an agent-generated status report
// (e.g. IMPLEMENTATION_SUMMARY.md, dev-status-report.html) — files we surface on
// the card but intentionally never commit. They must not flip a card to "dirty".
// Matches the same name/extension heuristic used to discover reports.
function isIgnorableReportPath(rel) {
  if (!rel) return false;
  const base = String(rel).split('/').pop();
  const ext = path.extname(base).toLowerCase();
  if (!REPORT_EXTS.has(ext)) return false;
  return REPORT_NAME_RE.test(base);
}

// Copilot/agent tooling artifacts that land in a worktree purely as a side-effect
// of running the CLI (e.g. `.github/copilot-instructions.md` dropped by a Copilot
// session) or the `*.agent.md` files we write for review/dev work. These are never
// committed into the user's PR, so — like generated reports — they must not flip a
// worktree to "dirty" or block an update-from-main.
function isIgnorableAgentArtifact(rel) {
  if (!rel) return false;
  const base = String(rel).replace(/\\/g, '/').split('/').pop();
  if (base === 'copilot-instructions.md') return true;
  if (/\.agent\.md$/i.test(base)) return true;
  return false;
}

// Build-output directories that land in a worktree as a side-effect of compiling
// (arcade `artifacts/`, per-project `bin/`/`obj/`, node deps, VS/test junk). These
// are not source and must never flip a worktree to "dirty", inflate the change
// count, or get swept into a PR commit — even when the repo's .gitignore misses
// them (e.g. dotnet-helix-machines ignores `.artifacts` but not `artifacts/`). We
// match on any *directory* segment of the path so nested `src/Foo/bin/Debug/x.dll`
// is caught too, while a real file literally named `bin` at the root is not.
const BUILD_OUTPUT_SEGMENTS = new Set([
  'bin', 'obj', 'artifacts', '.artifacts', 'node_modules', '.vs', 'testresults'
]);
function isIgnorableBuildOutput(rel) {
  if (!rel) return false;
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {   // dir segments only (skip filename)
    if (BUILD_OUTPUT_SEGMENTS.has(parts[i].toLowerCase())) return true;
  }
  return false;
}

// Throwaway backup/temp droppings left by build & SDK bootstrap tooling (e.g. a
// dotnet build that pins global.json writes `global.json.bak`/`global.json.tmp`
// beside it; editors/patchers leave `*.orig`). These are never part of a PR, so —
// like build output — they must not flip a review worktree to "dirty", inflate the
// change count, or (critically) get swept into the user's PR commit by commitAll,
// which stages every non-ignorable change including untracked files.
const BUILD_DROPPING_EXTS = new Set(['.bak', '.tmp', '.orig']);
function isIgnorableBuildDropping(rel) {
  if (!rel) return false;
  const base = String(rel).replace(/\\/g, '/').split('/').pop();
  return BUILD_DROPPING_EXTS.has(path.extname(base).toLowerCase());
}

// A worktree change is ignorable when it's a generated report, a Copilot/agent
// tooling artifact, build output, OR a throwaway build/tool dropping — all
// surfaced/managed by us but never committed.
function isIgnorableWorktreePath(rel) {
  return isIgnorableReportPath(rel) || isIgnorableAgentArtifact(rel) || isIgnorableBuildOutput(rel) || isIgnorableBuildDropping(rel);
}

// Split `git status --porcelain` output into committable changes vs ignorable
// agent reports. Returns { dirty, changed:[], ignored:[] } where `dirty` reflects
// ONLY the committable changes — so a worktree whose only change is a generated
// report reads as clean.
function classifyPorcelain(out) {
  const changed = [], ignored = [];
  for (const raw of String(out || '').split('\n')) {
    if (!raw.trim()) continue;
    let p = raw.slice(3).trim();            // strip the 2-char XY status + space
    const arrow = p.indexOf(' -> ');         // rename entries: "old -> new"
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    (isIgnorableWorktreePath(p) ? ignored : changed).push(p);
  }
  return { dirty: changed.length > 0, changed, ignored };
}

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
// Worktree files. The dev agent frequently produces new/changed files that are
// NOT status reports — scripts (.ps1/.sh/.py), data (.csv/.json), source edits —
// and those have no home in the Reports list. Surface a worktree's uncommitted
// committable changes (git-untracked + modified) as an openable "Files" list so
// the agent's real work products are reachable from the card. Read-only, derived
// from `worktreeChanges` so already-shown reports + build noise (which live in
// `.ignored`) are excluded by construction. Files are NOT cached — they exist
// only while the worktree lives.
// ---------------------------------------------------------------------------

// Human-readable status from a 2-char `git status --porcelain` XY code.
function _porcelainStatus(xy) {
  const s = String(xy || '');
  if (s.indexOf('?') >= 0) return 'new';
  if (/[AC]/.test(s)) return 'added';
  if (/R/.test(s)) return 'renamed';
  if (/D/.test(s)) return 'deleted';
  if (/[MTU]/.test(s)) return 'modified';
  return 'changed';
}

// List a worktree's uncommitted committable files as
// { rel, name, status(new/added/modified/deleted/renamed/changed), kind(ext), deleted }.
// New/added first, then alphabetical by path. Capped with a `truncated` flag so a
// large source refactor can't flood the card. Never throws.
function listWorktreeFiles(wt) {
  try {
    if (!wt || !_isRepo(wt)) return { files: [], truncated: false };
    const wc = worktreeChanges(wt);
    const items = (wc.changed || []).map((c) => {
      const rel = c.path;
      const name = String(rel).replace(/\\/g, '/').split('/').pop();
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      const status = _porcelainStatus(c.xy);
      return { rel, name, status, kind: ext || 'file', deleted: status === 'deleted' };
    });
    const rank = (s) => (s === 'new' || s === 'added') ? 0 : 1;
    items.sort((a, b) => (rank(a.status) - rank(b.status)) || String(a.rel).localeCompare(String(b.rel)));
    const CAP = 60;
    return { files: items.slice(0, CAP), truncated: items.length > CAP };
  } catch { return { files: [], truncated: false }; }
}

// Text-safe extensions/names we allow the in-app viewer to read from a worktree.
// Broader than the report-only REPORT_EXTS: scripts, source, data, config, docs.
const WORKTREE_TEXT_EXTS = new Set([
  '.ps1', '.psm1', '.psd1', '.ps', '.sh', '.bash', '.zsh', '.bat', '.cmd',
  '.py', '.rb', '.pl', '.lua', '.r',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.cs', '.fs', '.vb', '.go', '.rs', '.java', '.kt', '.swift', '.scala',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.m',
  '.sql', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.xml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.md', '.markdown', '.txt', '.log', '.rst',
  '.html', '.htm', '.css', '.scss', '.less',
  '.env', '.props', '.targets', '.gradle', '.tf', '.bicep', '.proto', '.graphql'
]);
const WORKTREE_TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'jenkinsfile', 'procfile', 'rakefile',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore'
]);

// Safely read an arbitrary text file from a worktree for in-app viewing. Same
// traversal guard + size cap as _readReportFrom, but a broader text-safe
// allow-list; HTML serves text/html, everything else text/plain so scripts and
// data render as source. Returns { content, contentType, name } or throws with
// a `.status`.
function readWorktreeFile(rootDir, rel) {
  const err = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
  if (!rootDir || !fs.existsSync(rootDir)) throw err('Not found', 404);
  if (!rel || typeof rel !== 'string') throw err('Missing file', 400);
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) throw err('Forbidden path', 403);
  const base = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();
  const ok = WORKTREE_TEXT_EXTS.has(ext) || WORKTREE_TEXT_NAMES.has(base.toLowerCase());
  if (!ok) throw err('Unsupported file type', 415);
  let st;
  try { st = fs.statSync(abs); } catch { throw err('Not found', 404); }
  if (!st.isFile()) throw err('Not a file', 404);
  if (st.size > 8 * 1024 * 1024) throw err('File too large to preview', 413);
  const content = fs.readFileSync(abs);
  const isHtml = ext === '.html' || ext === '.htm';
  const contentType = isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  return { content, contentType, name: base };
}

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
//
// Before overwriting an existing cached report whose CONTENT has changed, the
// prior cached copy is snapshotted into a timestamped `__history/` file and
// recorded in the history manifest — so regenerating a report never silently
// destroys the previous version (a comparable audit trail).
function cacheReports(boardId, devId, wt, reports) {
  if (!boardId || !devId || !Array.isArray(reports) || !reports.length) return reports || [];
  const destRoot = reportCacheDir(boardId, devId);
  for (const r of reports) {
    if (!r || !r.rel) continue;
    try { _snapshotHistoryIfChanged(boardId, devId, wt, destRoot, r); } catch {}
    const ok = _cacheCopy(wt, destRoot, r.rel);
    if (ok || hasCachedReport(boardId, devId, r.rel)) r.cached = true;
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Report history. When a report is regenerated with new content we keep the
// prior cached copy under `<cache>/__history/<base>-<ISO>.<ext>` and append an
// entry to `<cache>/__history/index.json` so the card can list past versions
// with timestamps. Snapshots ONLY happen on a genuine content change, so
// routine drift-refresh polling (same content) never creates spurious history.
// ---------------------------------------------------------------------------
const HISTORY_SUBDIR = '__history';

function _historyDir(boardId, devId) {
  return path.join(reportCacheDir(boardId, devId), HISTORY_SUBDIR);
}
function _historyManifestPath(boardId, devId) {
  return path.join(_historyDir(boardId, devId), 'index.json');
}
function _readHistoryManifest(boardId, devId) {
  try {
    const raw = fs.readFileSync(_historyManifestPath(boardId, devId), 'utf-8');
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function _writeHistoryManifest(boardId, devId, list) {
  try {
    const dir = _historyDir(boardId, devId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_historyManifestPath(boardId, devId), JSON.stringify((list || []).slice(0, 40), null, 2));
  } catch {}
}
function _fileSha(abs) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch { return ''; }
}

// If a cached copy of `r.rel` already exists AND the incoming worktree version
// differs in content, snapshot the existing cached copy into __history before it
// gets overwritten. Best-effort; never throws.
//
// `ns` namespaces the cache for a specific repo slot (empty for the primary repo,
// back-compatible). History snapshots live under `<cache>/<ns>/__history/…` but the
// manifest rel is recorded RELATIVE TO THE CARD CACHE DIR (ns-qualified) so a single
// card-level manifest can list every repo's history and the report endpoint can serve
// each one. `repo`/`repoId` tag the entry so the UI can disambiguate across repos.
function _snapshotHistoryIfChanged(boardId, devId, wt, destRoot, r, ns = '', repo = '') {
  if (!wt || !r || !r.rel) return;
  const rootWt = path.resolve(wt);
  const src = path.resolve(rootWt, r.rel);
  if (!(src === rootWt || src.startsWith(rootWt + path.sep))) return;
  const rootDest = path.resolve(destRoot);
  const dest = path.resolve(rootDest, r.rel);
  if (!(dest === rootDest || dest.startsWith(rootDest + path.sep))) return;
  // Nothing to preserve if there's no prior cached copy, or no incoming file.
  if (!fs.existsSync(dest) || !fs.existsSync(src)) return;
  try { if (!fs.statSync(dest).isFile() || !fs.statSync(src).isFile()) return; } catch { return; }
  const prevSha = _fileSha(dest);
  const nextSha = _fileSha(src);
  if (!prevSha || prevSha === nextSha) return;  // unchanged → no snapshot
  const ext = path.extname(r.rel);
  const base = path.basename(r.rel, ext);
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, '-');
  // Snapshot file lives under destRoot; the manifest rel is card-cache-relative.
  const histRelLocal = HISTORY_SUBDIR + '/' + _sanitizeId(base) + '-' + stamp + ext;
  const histRel = ns ? (ns + '/' + histRelLocal) : histRelLocal;
  const histAbs = path.resolve(rootDest, histRelLocal);
  if (!histAbs.startsWith(rootDest + path.sep)) return;
  try {
    fs.mkdirSync(path.dirname(histAbs), { recursive: true });
    fs.copyFileSync(dest, histAbs);
  } catch { return; }
  let size = 0; try { size = fs.statSync(histAbs).size; } catch {}
  const isHtml = /\.html?$/i.test(ext);
  const cardRoot = path.resolve(reportCacheDir(boardId, devId));
  const manifest = _readHistoryManifest(boardId, devId);
  manifest.unshift({
    rel: histRel,
    name: path.basename(r.rel),
    of: ns ? (ns + '/' + r.rel) : r.rel,
    repoId: ns || 'primary',
    repo: repo || '',
    ts: ts.toISOString(),
    size,
    sha: prevSha,
    kind: isHtml ? 'html' : (/\.(md|markdown)$/i.test(ext) ? 'md' : 'txt')
  });
  // Prune oldest history files beyond the cap so the cache can't grow forever.
  // Rels are card-cache-relative, so resolve pruning against the card root.
  const KEEP = 30;
  for (const old of manifest.slice(KEEP)) {
    try { fs.rmSync(path.resolve(cardRoot, old.rel), { force: true }); } catch {}
  }
  _writeHistoryManifest(boardId, devId, manifest.slice(0, KEEP));
}

// List a card's cached report history (newest first), enriched with a stable,
// same-origin URL rel the card can link to via the existing report endpoint AND
// a clean `displayName` with a "(N)" suffix before the extension. The newest
// superseded version of a given report is "(1)", the next-older "(2)", etc.,
// grouped per source report name + repo so identically-named reports across
// repos number independently. The raw `name`/`ts` are preserved for callers.
function listReportHistory(boardId, devId) {
  if (!boardId || !devId) return [];
  const list = _readHistoryManifest(boardId, devId).filter(e => e && e.rel);
  const counts = Object.create(null);
  for (const e of list) {                     // manifest is newest-first
    const nm = e.name || path.basename(e.rel);
    const ext = path.extname(nm);
    const base = nm.slice(0, nm.length - ext.length);
    const key = (e.repoId || 'primary') + '|' + nm;
    const n = (counts[key] = (counts[key] || 0) + 1);
    e.displayName = base + '(' + n + ')' + ext;
  }
  return list;
}

// Find reports in the worktree AND durably cache them in one shot. Use this
// everywhere instead of bare findReports so nothing is lost on cleanup.
function findAndCacheReports(boardId, devId, wt) {
  const reports = findReports(wt);
  try { cacheReports(boardId, devId, wt, reports); } catch {}
  // Keep generated reports out of git so they never dirty the card or get swept
  // into a push/commit. Best-effort; harmless if already excluded or tracked.
  for (const r of reports) { try { addGitExclude(wt, r.rel); } catch {} }
  return reports;
}

function readReportCached(boardId, devId, rel) {
  return _readReportFrom(reportCacheDir(boardId, devId), rel);
}

// List the durably-cached "current" reports for a card WITHOUT needing a live
// worktree. Scans the persistent cache dir (mirrored copies made by
// findAndCacheReports), so a card's artifacts remain listable after its worktree
// is removed. Newest first; excludes the __history/ snapshots.
function listCachedReports(boardId, devId) {
  if (!boardId || !devId) return [];
  return findReports(reportCacheDir(boardId, devId));
}

function hasCachedReport(boardId, devId, rel) {
  try { readReportCached(boardId, devId, rel); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Multi-repo report support. A dev card can span several repos, each with its own
// worktree ("slot"). Reports surfaced from a non-primary repo are cached under a
// per-repo namespace (`<cache>/<repoId>/…`) so two repos exposing an identically
// named report never clobber each other. The primary repo keeps caching at the
// bare rel for byte-compatibility with existing single-repo cards. Every returned
// report is tagged with { repoId, repo, cacheRel } — cacheRel is the durable key
// the report endpoint serves from (survives worktree deletion).
// ---------------------------------------------------------------------------

// Cache one slot's reports under its namespace and tag them. `slot` = { id, repo,
// worktreePath }. Returns the tagged reports (newest first for that slot).
function _cacheSlotReports(boardId, devId, slot) {
  if (!slot || !slot.worktreePath) return [];
  const repoId = slot.id || 'primary';
  const ns = (repoId === 'primary') ? '' : _sanitizeId(repoId);
  const destRoot = ns ? path.join(reportCacheDir(boardId, devId), ns) : reportCacheDir(boardId, devId);
  let reports = [];
  try { reports = findReports(slot.worktreePath); } catch { reports = []; }
  for (const r of reports) {
    if (!r || !r.rel) continue;
    try { _snapshotHistoryIfChanged(boardId, devId, slot.worktreePath, destRoot, r, ns, slot.repo || ''); } catch {}
    const ok = _cacheCopy(slot.worktreePath, destRoot, r.rel);
    const cacheRel = ns ? (ns + '/' + r.rel) : r.rel;
    if (ok || hasCachedReport(boardId, devId, cacheRel)) r.cached = true;
    r.repoId = repoId;
    r.repo = slot.repo || '';
    r.cacheRel = cacheRel;
    // Per-approach tags (dev-worktree "approaches") when the caller supplied them.
    if (slot.wtId != null) r.wtId = slot.wtId;
    if (slot.aspect != null) r.aspect = slot.aspect;
    if (slot.active != null) r.approachActive = !!slot.active;
    if (slot.promotedPrId) r.promotedPrId = String(slot.promotedPrId);
    // Keep generated reports out of git so they never dirty the card / a push.
    try { addGitExclude(slot.worktreePath, r.rel); } catch {}
  }
  return reports;
}

// Scan + durably cache reports across EVERY live repo slot for a card. `slots` =
// [{ id, repo, worktreePath }]. Returns the combined, newest-first, tagged array.
function findAndCacheReportsForSlots(boardId, devId, slots) {
  const out = [];
  for (const s of (Array.isArray(slots) ? slots : [])) {
    for (const r of _cacheSlotReports(boardId, devId, s)) out.push(r);
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out.slice(0, 32);
}

// List durably-cached reports for slots that have NO live worktree (so a repo's
// artifacts survive worktree removal). `slots` = [{ id, repo }]. Tagged like the
// live scan (repoId/repo/cacheRel) so callers can merge the two seamlessly.
function listCachedReportsForSlots(boardId, devId, slots) {
  const out = [];
  for (const s of (Array.isArray(slots) ? slots : [])) {
    if (!s) continue;
    const repoId = s.id || 'primary';
    const ns = (repoId === 'primary') ? '' : _sanitizeId(repoId);
    const dir = ns ? path.join(reportCacheDir(boardId, devId), ns) : reportCacheDir(boardId, devId);
    let reports = [];
    try { reports = findReports(dir); } catch { reports = []; }
    for (const r of reports) {
      if (!r || !r.rel) continue;
      r.repoId = repoId;
      r.repo = s.repo || '';
      r.cacheRel = ns ? (ns + '/' + r.rel) : r.rel;
      r.cached = true;
      // Per-approach tags (dev-worktree "approaches") when the caller supplied them.
      if (s.wtId != null) r.wtId = s.wtId;
      if (s.aspect != null) r.aspect = s.aspect;
      if (s.active != null) r.approachActive = !!s.active;
      if (s.promotedPrId) r.promotedPrId = String(s.promotedPrId);
    }
    for (const r of reports) out.push(r);
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out.slice(0, 32);
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
  createPrWorktree,
  devPrDivergence,
  promoteToPr,
  pullFromPr,
  mergeAspectBranch,
  createWorktreeAsync,
  worktreeStatus,
  branchCommits,
  classifyPorcelain,
  isIgnorableReportPath,
  worktreeChanges,
  discardWorktreeChanges,
  syncWorktree,
  commitAll,
  prDrift,
  pushPrBranch,
  pushPrBranchSafe,
  syncToPrBranch,
  updateFromTargetBranch,
  pullPrBranch,
  listWorktrees,
  resolveUsableWorktree,
  diffSummary,
  pushBranch,
  addGitExclude,
  removeWorktree,
  openWorkspace,
  findReports,
  readReport,
  listWorktreeFiles,
  readWorktreeFile,
  isIgnorableWorktreePath,
  findAndCacheReports,
  findAndCacheReportsForSlots,
  cacheReports,
  listReportHistory,
  readReportCached,
  listCachedReports,
  listCachedReportsForSlots,
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
      const _desc = { provider: job.provider || 'azdo', org: job.org, project: job.project, repo: job.repo };
      try { git = worktreeStatus(r.worktreePath, { baseBranch: job.baseBranch, desc: _desc }); } catch {}
      parentPort.postMessage({ ok: true, result: { ...r, git } });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: (e && e.message) || 'Worktree failed' });
    }
  }
} catch {}
