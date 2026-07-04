// Build-time release-notes generator.
//
// Guarantees that every shipped version has a non-empty "What's new" entry in
// whats-new.json. Runs as part of the desktop build (before stage-sidecar), so
// the entry is baked into the installer and served by /api/whats-new. On upgrade
// the SPA shows every entry between the user's previous version and the new one
// (not just the latest), and the home "What's new" section reads the same file.
//
// Behavior:
//   * Idempotent — if whats-new.json already has a substantive entry for the
//     target version, it does nothing (safe to run on every build).
//   * Deterministic — turns git commit subjects since the previous entry into
//     grouped highlights/details. No network / AI dependency, so it can never
//     produce empty notes even offline or in CI.
//   * Falls back to a generic "maintenance build" entry if there are no commits
//     in range, so the file is never left without an entry for the version.
//
// Usage:
//   node scripts/generate-release-notes.mjs                 # auto version + range
//   node scripts/generate-release-notes.mjs --version 1.2.3 # override version
//   node scripts/generate-release-notes.mjs --since v1.0.3  # override git range
//   node scripts/generate-release-notes.mjs --dry-run       # print, don't write

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const repoRoot = join(here, '..');
const notesFile = join(repoRoot, 'whats-new.json');

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
}
const DRY = args.includes('--dry-run');

function log(m) { console.log(`[release-notes] ${m}`); }
function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}
function gitSafe(cmd, fallback = '') {
  try { return git(cmd); } catch { return fallback; }
}

// Numeric compare on dot/dash-split segments; mirrors the SPA's semverGt so the
// ordering written here agrees with what the app shows (handles X.Y.Z-preview.N).
function cmpVer(a, b) {
  const pa = String(a || '').split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  const pb = String(b || '').split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---- resolve target version -------------------------------------------------
function readJsonVersion(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')).version || ''; } catch { return ''; }
}
let version = String(argVal('--version') || '').trim();
if (!version) version = readJsonVersion(join(repoRoot, 'package.json'));
if (!version) version = readJsonVersion(join(repoRoot, 'desktop', 'package.json'));
if (!version) { console.error('[release-notes] could not determine version'); process.exit(1); }

// ---- load existing notes ----------------------------------------------------
let doc = { entries: [] };
if (existsSync(notesFile)) {
  try {
    const parsed = JSON.parse(readFileSync(notesFile, 'utf-8'));
    doc = Array.isArray(parsed) ? { entries: parsed } : (parsed || { entries: [] });
  } catch (e) { log(`WARNING: could not parse whats-new.json (${e.message}); starting fresh`); }
}
if (!Array.isArray(doc.entries)) doc.entries = [];

// Idempotent: skip if a substantive entry already exists for this version.
const existing = doc.entries.find(e => e && e.version === version);
if (existing && ((Array.isArray(existing.highlights) && existing.highlights.length) ||
                 (Array.isArray(existing.details) && existing.details.length) ||
                 (existing.summary && existing.summary.trim()))) {
  log(`entry for v${version} already exists — nothing to do`);
  process.exit(0);
}

// ---- determine commit range -------------------------------------------------
// Prefer the tag matching the most recent *other* entry's version, then the most
// recent tag reachable from HEAD (excluding HEAD itself), then a bounded window.
function resolveTag(v) {
  if (!v) return '';
  for (const cand of [`v${v}`, v]) {
    if (gitSafe(`rev-parse --verify --quiet ${cand}^{commit}`)) return cand;
  }
  return '';
}
let since = String(argVal('--since') || '').trim();
if (!since) {
  const priorEntry = doc.entries
    .filter(e => e && e.version && e.version !== version)
    .sort((a, b) => cmpVer(b.version, a.version))[0];
  if (priorEntry) since = resolveTag(priorEntry.version);
}
if (!since) {
  const headSha = gitSafe('rev-parse HEAD');
  const tags = gitSafe('tag --sort=-creatordate').split(/\r?\n/).filter(Boolean);
  for (const t of tags) {
    const sha = gitSafe(`rev-parse ${t}^{commit}`);
    if (sha && sha !== headSha && gitSafe(`merge-base --is-ancestor ${t} HEAD && echo ok`) === 'ok') { since = t; break; }
  }
}
const range = since ? `${since}..HEAD` : '-30';
log(`version=${version}  range=${range}`);

// ---- collect + classify commits ---------------------------------------------
const RS = '\x1e', US = '\x1f';
let raw = '';
try { raw = git(`--no-pager log ${range} --no-merges --format=%s${US}%b${RS}`); }
catch (e) { log(`WARNING: git log failed (${e.message}); using generic entry`); }

const commits = raw.split(RS).map(s => s.trim()).filter(Boolean).map(chunk => {
  const [subject, body = ''] = chunk.split(US);
  return { subject: (subject || '').trim(), body: (body || '').trim() };
});

const SKIP = /^(wip|fixup!|squash!|merge\b)/i;
function clean(t) {
  t = String(t || '').trim().replace(/\s+/g, ' ');
  t = t.replace(/[.\s]+$/, '');
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}
function classify(subject) {
  const m = subject.match(/^(\w+)(\([^)]*\))?!?:\s*(.*)$/);
  let type = '', text = subject;
  if (m) { type = m[1].toLowerCase(); text = m[3]; }
  const s = subject.toLowerCase();
  if (!type) {
    if (/^(add|introduce|implement|create|support|enable|new\b)/.test(s)) type = 'feat';
    else if (/^(fix|resolve|correct|prevent|repair|handle)/.test(s)) type = 'fix';
    else if (/^(improve|refine|polish|tweak|update|enhance|redesign|restyle)/.test(s)) type = 'improve';
  }
  let cat;
  switch (type) {
    case 'feat': cat = 'New'; break;
    case 'fix': cat = 'Fixes'; break;
    case 'perf': cat = 'Performance'; break;
    case 'improve': case 'refactor': case 'style': case 'ui': cat = 'Improvements'; break;
    case 'docs': case 'test': case 'build': case 'ci': case 'chore': cat = 'Under the hood'; break;
    default: cat = 'Improvements';
  }
  return { cat, text: clean(text) };
}

const groups = new Map(); // cat -> [text]
for (const c of commits) {
  if (!c.subject || SKIP.test(c.subject)) continue;
  const { cat, text } = classify(c.subject);
  if (!text) continue;
  if (!groups.has(cat)) groups.set(cat, []);
  const arr = groups.get(cat);
  if (!arr.includes(text)) arr.push(text);
}

// ---- assemble the entry -----------------------------------------------------
const CAT_ORDER = ['New', 'Fixes', 'Performance', 'Improvements', 'Under the hood'];
const orderedCats = CAT_ORDER.filter(c => groups.get(c) && groups.get(c).length);

const nNew = (groups.get('New') || []).length;
const nFix = (groups.get('Fixes') || []).length;
const nImp = (groups.get('Improvements') || []).length + (groups.get('Performance') || []).length;

function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
function listJoin(arr) {
  if (arr.length <= 1) return arr.join('');
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

let title, summary, highlights = [], details = [];

if (orderedCats.length) {
  const priority = ['New', 'Fixes', 'Performance', 'Improvements'];
  for (const cat of priority) {
    for (const t of (groups.get(cat) || [])) {
      if (highlights.length >= 4) break;
      highlights.push(t);
    }
    if (highlights.length >= 4) break;
  }
  if (!highlights.length) highlights = (groups.get('Under the hood') || []).slice(0, 3);

  details = orderedCats.map(cat => ({
    heading: cat === 'New' ? 'New features' : cat === 'Fixes' ? 'Fixes' : cat,
    items: groups.get(cat),
  }));

  const parts = [];
  if (nNew) parts.push(plural(nNew, 'new feature'));
  if (nFix) parts.push(plural(nFix, 'fix'));
  if (nImp) parts.push(plural(nImp, 'improvement'));
  summary = parts.length
    ? `This release includes ${listJoin(parts)}.`
    : 'This release rolls up behind-the-scenes maintenance and refinements.';

  if (nNew) title = `New: ${(groups.get('New')[0] || '').replace(/^./, m => m.toLowerCase())}`;
  else if (nFix) title = 'Fixes and improvements';
  else if (nImp) title = 'Refinements and polish';
  else title = 'Maintenance update';
  if (title.length > 80) title = title.slice(0, 77) + '…';
} else {
  // No commits in range — never leave the version without notes.
  title = 'Maintenance build';
  summary = 'Stability and packaging updates. No user-facing changes in this build.';
  highlights = ['Under-the-hood stability and packaging updates.'];
  details = [];
}

const date = gitSafe('log -1 --format=%cs') || new Date().toISOString().slice(0, 10);
const entry = { version, date, title, summary, highlights, details };

// ---- write ------------------------------------------------------------------
// Replace any pre-existing (empty) placeholder for this version, then sort
// newest-first so the file mirrors what the SPA displays.
doc.entries = doc.entries.filter(e => !(e && e.version === version));
doc.entries.unshift(entry);
doc.entries.sort((a, b) => cmpVer(b.version, a.version));

if (DRY) {
  log('dry run — entry that would be written:');
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

writeFileSync(notesFile, JSON.stringify(doc, null, 2) + '\n');
log(`wrote entry for v${version} (${highlights.length} highlights, ${details.length} detail groups) -> whats-new.json`);
