// forge.js — provider dispatcher for the source/PR layer.
//
// Code Flow and Dev cards were written directly against azdo.js. To add GitHub
// as a first-class provider without rewriting every call site, records carry an
// optional `provider` ('azdo' | 'github'); forge(rec) returns the matching
// module. Both modules expose the same positional signatures — for GitHub the
// record stores the owner in `org` and leaves `project` empty (GitHub has no
// project), and the GitHub functions ignore the project slot. So a call site
//   azdo.listPullRequests(rec.org, rec.project, rec.repo, opts)
// becomes
//   forge(rec).listPullRequests(rec.org, rec.project, rec.repo, opts)
// with no other change.
//
// A missing `provider` on any record is treated as 'azdo' (back-compat, no
// migration). descKey/descSlug/validateDesc give one canonical identity so
// worktree paths, AI/report caches, posted-comment records, dev-card indexes,
// and attention caches all key off the same string (R5).

const azdo = require('./azdo');
let github = null;
try { github = require('./github'); }
catch (e) { console.warn('[forge] github.js unavailable:', e.message); }

const PROVIDERS = { azdo, github };

// Accepts a record ({provider,...}) or a bare provider string. Defaults azdo.
function providerOf(x) {
  const p = (x && typeof x === 'object') ? x.provider : x;
  const name = String(p || 'azdo').toLowerCase();
  return name === 'github' || name === 'gh' ? 'github' : 'azdo';
}

function forge(rec) {
  const name = providerOf(rec);
  const mod = PROVIDERS[name];
  if (!mod) throw new Error(`Provider "${name}" is not available (module failed to load).`);
  return mod;
}

// Normalize a record into the neutral descriptor fields. For GitHub, owner may
// arrive as `owner` or `org`; project is always '' .
function normalizeDesc(rec) {
  const r = rec || {};
  const provider = providerOf(r);
  if (provider === 'github') {
    return { provider, host: 'github.com', owner: (r.owner || r.org || '').trim(), org: (r.owner || r.org || '').trim(), project: '', repo: (r.repo || '').trim() };
  }
  return { provider, host: 'dev.azure.com', owner: (r.org || '').trim(), org: (r.org || '').trim(), project: (r.project || '').trim(), repo: (r.repo || '').trim() };
}

// Canonical, case-insensitive identity. Optionally include a PR/id suffix so
// callers can build a single prKey = provider|org|project|repo|prId (R5).
function descKey(rec, id) {
  const d = normalizeDesc(rec);
  const base = [d.provider, d.owner, d.project, d.repo].map(s => String(s || '').toLowerCase()).join('|');
  return (id === undefined || id === null || id === '') ? base : `${base}|${String(id).toLowerCase()}`;
}

// Filesystem-safe slug for worktree/cache directories.
function descSlug(rec, id) {
  return descKey(rec, id).replace(/[^a-z0-9|]+/gi, '_').replace(/\|/g, '__');
}

// Throw with a clear message when a record can't identify a repo for its
// provider. Returns the normalized descriptor on success.
function validateDesc(rec) {
  const d = normalizeDesc(rec);
  if (!d.repo) throw new Error('Missing repo in source descriptor.');
  if (d.provider === 'github') {
    if (!d.owner) throw new Error('GitHub source requires an owner (org/user).');
  } else {
    if (!d.owner) throw new Error('Azure DevOps source requires an org.');
    if (!d.project) throw new Error('Azure DevOps source requires a project.');
  }
  return d;
}

module.exports = { forge, providerOf, normalizeDesc, descKey, descSlug, validateDesc, PROVIDERS };
