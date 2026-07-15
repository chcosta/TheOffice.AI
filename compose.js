'use strict';

// compose.js
// Local storage + domain logic for the "Compose.AI" feature: a general-purpose
// composition studio that turns a brief (purpose, audience, format, sources)
// into a finished, sendable deliverable — proposals, alignment memos, status
// updates, one-pagers, technical & architecture docs, references, newsletters,
// or a self-contained prototype microsite.
//
// Compose.AI is the successor/superset of the Newsletter feature. Newsletter
// stays fully intact as its own studio (see ./newsletter); the "Newsletter"
// purpose in Compose links out to it. Everything else is composed here.
//
// Like Newsletter/Connect, the backing data is PER-USER runtime state that can
// reference sensitive work details, so it lives under the profile data dir by
// default — NEVER in the repo — and can be redirected to a OneDrive-synced
// folder via the composeStorageDir setting.
//
// Unlike Newsletter (a single draft), Compose holds MANY compositions, each with
// its own draft, version history, and assistant conversation.
//
// Files:
//   state.json  — { items:[ <composition> ], meta:{ createdAt } }
//
// Design guardrail (same as Newsletter): the AI is a DRAFTING ASSISTANT. Every
// generated deliverable is stored as an editable draft the user reviews before
// it is ever sent.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');

let _settings = null;
function settings() {
  if (!_settings) _settings = require('./settings');
  return _settings;
}

// ---- Purpose catalog --------------------------------------------------------
// The purpose governs structure, tone, default medium, and visual density. The
// UI renders this gallery; the server passes purpose+audience+format+brief into
// the writer/editor agents (which are purpose-agnostic and read these labels).
const PURPOSES = [
  { id: 'proposal',     label: 'Proposal',           blurb: 'Argue a recommendation and make the ask unmissable.', defaultFormat: 'doc',   icon: '📌' },
  { id: 'brainstorm',   label: 'Brainstorm & options', blurb: 'Explore options with honest pros/cons, score each, then recommend.', defaultFormat: 'doc', icon: '💡' },
  { id: 'alignment',    label: 'Alignment memo',     blurb: 'Build shared understanding and gain buy-in.',          defaultFormat: 'email', icon: '🤝' },
  { id: 'status',       label: 'Status update',      blurb: 'Report progress, risks, and asks at a glance.',        defaultFormat: 'email', icon: '📈' },
  { id: 'onepager',     label: 'One-pager',          blurb: 'The team’s epic one-pager: how the v-team will build & support it.', defaultFormat: 'doc', icon: '📄' },
  { id: 'technical',    label: 'Technical doc',      blurb: 'Specify a design, interface, or approach precisely.',  defaultFormat: 'doc',   icon: '🛠️' },
  { id: 'architecture', label: 'Architecture doc',   blurb: 'Context, components, decisions, and a diagram.',       defaultFormat: 'doc',   icon: '🏛️' },
  { id: 'reference',    label: 'Reference',          blurb: 'Scannable, complete, optimized for lookup.',           defaultFormat: 'doc',   icon: '📚' },
  { id: 'newsletter',   label: 'Newsletter / digest',blurb: 'Warm, story-driven impact digest.',                    defaultFormat: 'email', icon: '📰', linksTo: 'newsletter' },
  { id: 'prototype',    label: 'Prototype / demo',   blurb: 'A self-contained site that demonstrates an experience.', defaultFormat: 'site', icon: '✨' },
  { id: 'message',      label: 'Message / announcement', blurb: 'A short, punchy note for email or Teams.',          defaultFormat: 'teams', icon: '💬' },
];

const FORMATS = ['email', 'teams', 'doc', 'site'];

// Audience presets — steer tone, depth, and how chart-heavy the draft gets.
// Stored on a composition as the label string (so the writer reads it directly);
// the UI renders these as selectable choices, matching the Format treatment.
const AUDIENCES = [
  { id: 'peers',      label: 'Engineering peers' },
  { id: 'leadership', label: 'Leadership / execs' },
  { id: 'crossteam',  label: 'Cross-team stakeholders' },
  { id: 'external',   label: 'Customer / external' },
  { id: 'org',        label: 'Whole org' },
];

// ---- Source catalog ---------------------------------------------------------
// What Compose.AI reads & cites to ground the draft. Honesty mandate: `diary`
// and `pasted` are REAL local evidence the server hands the writer verbatim;
// the rest are REFERENCES the writer investigates (opening the PR, reading the
// pursuit compendium, querying work items, or pulling M365 via WorkIQ) and it
// cites only what it genuinely finds — never fabricated. `pr`/`pursuit`/
// `workitems` take a small reference string; `diary`/`m365` are toggles.
const SOURCES = [
  { id: 'diary',     label: 'Connect diary',          blurb: 'Recent activity from your work journal.',            kind: 'toggle' },
  { id: 'pr',        label: 'Pull request',           blurb: 'Open a PR and read its diff, description & threads.', kind: 'ref', placeholder: 'https://github.com/org/repo/pull/123' },
  { id: 'pursuit',   label: 'Pursuit compendium',     blurb: 'Read a pursuit’s findings & compendium.',            kind: 'ref', placeholder: 'Pursuit name or id' },
  { id: 'workitems', label: 'Work items',             blurb: 'Investigate linked Azure DevOps work items.',        kind: 'ref', placeholder: 'AB#123, AB#456 or a query' },
  { id: 'repos',     label: 'Repositories',           blurb: 'Pick repos to search for real code, docs & structure.', kind: 'ref', placeholder: 'org/repo, org/repo2 or a local path' },
  { id: 'composition', label: 'Another composition',  blurb: 'Reuse a Compose.AI report or your Newsletter as source material.', kind: 'ref', placeholder: 'Pick compositions or the Newsletter' },
  { id: 'agentruns', label: 'Agent task runs',       blurb: 'Fold one of your agents’ recent task runs — their output & findings — as evidence.', kind: 'ref', placeholder: 'Pick an agent' },
  { id: 'm365',      label: 'Microsoft 365 (WorkIQ)', blurb: 'Pull relevant mail, meetings & files.',              kind: 'toggle' },
  { id: 'pasted',    label: 'Pasted context',         blurb: 'Notes, links, or a spec you paste in.',              kind: 'text' },
];

// Sensible starting sources per purpose (mirrors the launcher blueprint). The
// user can toggle any of them; these just prime the brief.
const SOURCE_DEFAULTS = {
  proposal:     ['pursuit', 'workitems'],
  brainstorm:   ['workitems', 'pasted'],
  alignment:    ['pr'],
  status:       ['diary', 'workitems'],
  onepager:     ['workitems', 'pursuit'],
  technical:    ['pr', 'pasted'],
  architecture: ['pasted', 'pr'],
  reference:    ['pasted'],
  newsletter:   ['diary'],
  prototype:    ['pasted'],
  message:      ['diary'],
};

function purposeById(id) {
  return PURPOSES.find(p => p.id === id) || null;
}

// ---- Purpose blueprints -----------------------------------------------------
// Some purposes are a SPECIFIC team document with an established template, not a
// generic shape. A blueprint pins the required sections + naming/process rules so
// the writer and the paired editor produce THAT document — not a loose page. The
// UI also surfaces the section list so the user knows what they'll get.
//
// Only purposes with a real house template appear here; everything else stays
// intentionally open-ended (no blueprint ⇒ the assistant owns the structure).
//
// `onepager` mirrors the DNCEng Services Wiki one-pager template
// (Documentation › Project Docs › one pager template): the epic one-pager that
// captures HOW the v-team will implement and support a slice of an epic's goal.
const PURPOSE_BLUEPRINTS = {
  brainstorm: {
    title: 'Options brainstorm & recommendation',
    intro: 'A decision-support brief. Explore the solution space genuinely (breadth before judgement — don’t anchor on the first idea), weigh each option honestly, score them against explicit criteria, then land a clear recommendation. Look beyond the obvious in-house approach: research relevant industry best practices, established patterns, and modern technologies/tooling that apply to this problem, and fold the credible ones in as options (or as evidence strengthening an option). Ground every option and score in the real sources; where you’re inferring or drawing on outside practice, say so and cite it.',
    sections: [
      { h: 'Problem & decision criteria', ask: 'Restate the problem in one or two sentences, the goal a solution must achieve, the hard constraints, and the explicit criteria you will judge options against (e.g. measurability, engineering effort, durability, adoption/operational cost, time-to-value). These criteria are what you score against later — make them concrete.' },
      { h: 'Options', ask: 'Lay out at least 3–5 genuinely DIFFERENT options (distinct approaches, not variations of one). For each: a short name, a 1–2 sentence description of how it works, then an honest **Pros** list and **Cons** list. Include the obvious approaches AND at least one non-obvious or hybrid one. Draw on industry best practices and modern technologies/tools where they genuinely fit — name the specific pattern, product, or standard and note where it has worked. Do not favour any option yet — stay even-handed here.' },
      { h: 'Evaluation & strength scores', ask: 'Score EVERY option 0–100 (its “strength score”) against the criteria from section 1, with a one-line justification for each score. Present a compact comparison table (options as rows, criteria as columns, plus a total/strength score column). Be discriminating — spread the scores; do not cluster everything in a narrow band.' },
      { h: 'Recommendation', ask: 'Name the single recommended option (and any close runner-up), explain concisely WHY it wins on the criteria, state the trade-offs you are consciously accepting, and give the first 2–3 concrete steps to move on it plus what to validate earliest.' },
      { h: 'Risks & open questions', ask: 'The biggest risks of the recommended path, how you would de-risk each, and the open questions that still need a human decision before committing.' },
    ],
  },
  onepager: {
    title: 'DNCEng epic one-pager',
    intro: 'The team’s standard epic one-pager. Epics carry the high-level business objective; the one-pager brings clarity to HOW the v-team will implement and support a specific aspect of that goal — the practical thinking the epic leaves out. It is signed off by stakeholders and linked to the epic’s GitHub issue.',
    sections: [
      { h: 'Goal and motivation', ask: 'Which aspect of the epic’s business goal does this cover, and why does the v-team need a one-pager for it — what practical implementation thinking does the epic itself not capture?' },
      { h: 'Stakeholders', ask: 'Who is this work for — the stakeholders and those who should sign off on the POC — and what problem(s) are they asking us to solve?' },
      { h: 'Proof of concept (POC)', ask: 'What POC(s) prove the approach is viable? What gaps, assumptions, or feedback does each POC surface before we commit? (More than one POC is fine.)' },
      { h: 'Risk', ask: 'Breaking changes for existing consumers? Your assumptions and unknowns? Dependencies — and are they ready to consume now or do they need updating? A target date and the risk of missing it (OKRs, consumer pain, product release)? Any limited/throttled API resource — estimated max usage, intelligent back-off, and the plan for more capacity if the feature both must exist and needs more?' },
      { h: 'Usage telemetry', ask: 'How will we measure the “usefulness” to stakeholders, and how will we track usage of the new feature?' },
      { h: 'Serviceability of the feature', ask: 'How will the change be operated and supported once shipped — monitoring, alerting, runbooks, and on-call/support impact?' },
    ],
    naming: 'Name the document “<epic name> - <epic issue number>” (e.g. “Coordinate migration from master to main in all dotnet org repos - core-eng10412”). It lives under the wiki Documentation folder, discussion happens via the PR process, it is signed off by stakeholders, then linked to the epic’s GitHub issue for discoverability.',
    reference: 'Template: DNCEng Services Wiki › Documentation › Project Docs › one pager template.',
  },
};

// Blueprint for a purpose (or null when the purpose is open-ended).
function blueprintFor(id) {
  return PURPOSE_BLUEPRINTS[id] || null;
}


// Content format that the writer produces for a given medium. `site` is a full
// self-contained HTML document; everything else is Markdown.
function contentFormatFor(format) {
  return format === 'site' ? 'html' : 'markdown';
}

// ---- Storage ----------------------------------------------------------------

function storageDir() {
  let dir = '';
  try {
    const s = settings().getSettings();
    dir = (s.composeStorageDir || '').trim();
  } catch { /* settings not ready */ }
  if (!dir) dir = dataPath('compose');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

// Per-composition assets directory (charts, screenshots the agent captures).
function assetsDir(id) {
  const dir = path.join(storageDir(), 'assets', String(id || 'shared'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function _statePath() { return path.join(storageDir(), 'state.json'); }

const MAX_VERSIONS = 30;   // per composition
const MAX_CHAT = 80;       // per composition

function _readJson(file, fallback) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch { return fallback; }
}

function _writeJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[compose] failed to write', path.basename(file) + ':', e.message);
    return false;
  }
}

function _id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _clone(o) { return JSON.parse(JSON.stringify(o)); }

function _now() { return new Date().toISOString(); }

// ---- Composition shape ------------------------------------------------------

function _defaultSources() {
  return {
    // Pull the shared Connect diary as evidence (like Newsletter).
    diary: false,
    diaryDays: 14,
    // Reference sources the writer investigates (best-effort, cite only what's found).
    pr: false, prRef: '',
    pursuit: false, pursuitRef: '',
    workitems: false, workitemsRef: '',
    // Repositories to reference / search for grounding context (comma/newline list
    // of org/repo or local paths). The writer searches them and cites what it finds.
    repos: false, reposRef: '',
    // Reuse another composition (compose report) or the Newsletter as evidence.
    // compositionRef is a comma-joined list of composition ids; the token
    // 'newsletter' is a sentinel for the current Newsletter draft.
    composition: false, compositionRef: '',
    // Fold an agent's recent task runs (output/findings within a time window) as
    // evidence. agentRunsRef is an agent id; agentRunsDays is the lookback window.
    agentruns: false, agentRunsRef: '', agentRunsDays: 14,
    // Use the agent's M365 / WorkIQ access (mail, meetings, files).
    m365: false,
    // GitHub / Azure DevOps PR or issue URLs to investigate (best-effort).
    links: [],
    // Freeform pasted context the user supplies inline.
    pasted: '',
  };
}

function _defaultComposition(patch = {}) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const purpose = purposeById(p.purpose) ? p.purpose : 'proposal';
  const pdef = purposeById(purpose);
  const format = FORMATS.includes(p.format) ? p.format : (pdef ? pdef.defaultFormat : 'doc');
  const now = _now();
  return {
    id: _id('cmp'),
    title: (typeof p.title === 'string' && p.title.trim()) ? p.title.trim().slice(0, 200) : (pdef ? pdef.label : 'Untitled'),
    purpose,
    audience: typeof p.audience === 'string' ? p.audience.slice(0, 400) : '',
    format,
    brief: typeof p.brief === 'string' ? p.brief.slice(0, 8000) : '',
    sources: { ..._defaultSources(), ...(p.sources && typeof p.sources === 'object' ? p.sources : {}) },
    draft: {
      content: typeof p.content === 'string' ? p.content : '',
      contentFormat: contentFormatFor(format),
      source: 'manual',
      generatedAt: '',
      updatedAt: now,
    },
    versions: [],
    chat: [],
    meta: {
      createdAt: now,
      updatedAt: now,
      lastGeneratedAt: null,
      lastDeliveredAt: null,
      lastDeliveredVia: '',
    },
  };
}

// Merge a raw stored composition onto the default shape so newly-added fields
// are always present.
function _hydrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = _defaultComposition({ purpose: raw.purpose, format: raw.format });
  const c = { ...base, ...raw };
  c.sources = { ..._defaultSources(), ...(raw.sources || {}) };
  c.draft = { ...base.draft, ...(raw.draft || {}) };
  c.meta = { ...base.meta, ...(raw.meta || {}) };
  c.versions = Array.isArray(raw.versions) ? raw.versions : [];
  c.chat = Array.isArray(raw.chat) ? raw.chat : [];
  if (!FORMATS.includes(c.format)) c.format = 'doc';
  if (!purposeById(c.purpose)) c.purpose = 'proposal';
  return c;
}

function _readAll() {
  const raw = _readJson(_statePath(), null);
  if (!raw) {
    const seeded = { items: [], meta: { createdAt: _now() } };
    _writeJson(_statePath(), seeded);
    return seeded;
  }
  raw.items = Array.isArray(raw.items) ? raw.items.map(_hydrate).filter(Boolean) : [];
  raw.meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : { createdAt: _now() };
  return raw;
}

function _writeAll(state) { return _writeJson(_statePath(), state); }

// ---- Public API -------------------------------------------------------------

// Lightweight metadata for the launcher list (no big draft bodies).
function listCompositions() {
  const st = _readAll();
  return st.items
    .map(c => {
      const content = (c.draft && c.draft.content) || '';
      return {
        id: c.id,
        title: c.title,
        purpose: c.purpose,
        audience: c.audience,
        format: c.format,
        hasDraft: !!(content || '').trim(),
        draftSource: c.draft ? c.draft.source : 'manual',
        versionCount: (c.versions || []).length,
        size: Buffer.byteLength(content, 'utf8'),
        preview: String(content).replace(/[#*_`>\[\]!]|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
        createdAt: c.meta.createdAt,
        updatedAt: c.meta.updatedAt,
        lastGeneratedAt: c.meta.lastGeneratedAt,
        lastDeliveredAt: c.meta.lastDeliveredAt,
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getComposition(id) {
  const st = _readAll();
  return st.items.find(c => c.id === id) || null;
}

function createComposition(patch) {
  const st = _readAll();
  const c = _defaultComposition(patch);
  st.items.unshift(c);
  _writeAll(st);
  return c;
}

// Patch brief-level fields (title/purpose/audience/format/brief/sources). If the
// medium changes, keep the existing draft but leave its contentFormat until the
// next generation (an HTML site draft shouldn't silently become markdown).
function updateComposition(id, patch) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  if (typeof p.title === 'string') c.title = p.title.trim().slice(0, 200) || c.title;
  if (purposeById(p.purpose)) c.purpose = p.purpose;
  if (FORMATS.includes(p.format)) c.format = p.format;
  if (typeof p.audience === 'string') c.audience = p.audience.slice(0, 400);
  if (typeof p.brief === 'string') c.brief = p.brief.slice(0, 8000);
  if (p.sources && typeof p.sources === 'object') {
    c.sources = { ...c.sources, ...p.sources };
    if (Array.isArray(p.sources.links)) c.sources.links = p.sources.links.slice(0, 40).map(String);
    for (const k of ['prRef', 'pursuitRef', 'workitemsRef', 'compositionRef', 'reposRef', 'agentRunsRef']) {
      if (typeof c.sources[k] === 'string') c.sources[k] = c.sources[k].slice(0, 500);
    }
    if (c.sources.agentRunsDays != null) {
      const d = Math.round(Number(c.sources.agentRunsDays));
      c.sources.agentRunsDays = Number.isFinite(d) ? Math.max(1, Math.min(90, d)) : 14;
    }
    if (typeof c.sources.pasted === 'string') c.sources.pasted = c.sources.pasted.slice(0, 200000);
  }
  c.meta.updatedAt = _now();
  _writeAll(st);
  return c;
}

function deleteComposition(id) {
  const st = _readAll();
  const next = st.items.filter(c => c.id !== id);
  if (next.length === st.items.length) return false;
  st.items = next;
  _writeAll(st);
  try { fs.rmSync(assetsDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
  return true;
}

// Derive a display title from generated content: a leading "Subject:" line
// (bold or plain) wins, then the first H1. Returns '' when neither is present.
function _deriveTitleFromContent(content) {
  const raw = String(content || '');
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length) {
    const m = lines[i].replace(/[*_`]/g, '').trim().match(/^subject\s*:\s*(.+)$/i);
    if (m) return m[1].trim().slice(0, 200);
  }
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].replace(/[*_`]/g, '').trim().slice(0, 200);
  return '';
}

// A compact, human-readable snapshot of the framing (audience / format / sources)
// that produced a draft, so every iteration + history entry can show WHAT it was
// composed from — not just the body.
function _framingSnapshot(c) {
  if (!c || typeof c !== 'object') return null;
  const s = c.sources || {};
  const labels = [];
  if (s.diary) labels.push('Connect diary');
  if (s.pr) labels.push('PR');
  if (s.pursuit) labels.push('Pursuit');
  if (s.workitems) labels.push('Work items');
  if (s.repos) labels.push('Repos');
  if (s.composition) labels.push('Composition ref');
  if (s.m365) labels.push('M365');
  if (Array.isArray(s.links) && s.links.length) labels.push('Links');
  if (typeof s.pasted === 'string' && s.pasted.trim()) labels.push('Pasted context');
  return {
    purpose: c.purpose || '',
    audience: (c.audience || '').slice(0, 400),
    format: c.format || '',
    sources: labels,
  };
}

// Save the draft body. Snapshots the outgoing draft into per-composition history
// when the content meaningfully changes.
function saveDraft(id, patch, { source, prompt } = {}) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  const prev = { ...c.draft };
  const next = { ...c.draft };
  if (typeof p.content === 'string') next.content = p.content;
  if (p.contentFormat === 'html' || p.contentFormat === 'markdown') next.contentFormat = p.contentFormat;

  const prevBody = (prev.content || '').trim();
  const nextBody = (next.content || '').trim();
  if (prevBody && prevBody !== nextBody) {
    _pushVersion(c, prev, { reason: source === 'ai' ? 'replaced-by-ai' : 'edited' });
  }
  if (source === 'ai') {
    next.source = 'ai';
    next.generatedAt = _now();
    c.meta.lastGeneratedAt = next.generatedAt;
    // Title the composition from the generated content (Subject line → first H1)
    // while the title is still an auto placeholder, so the recent-compositions
    // list shows the real subject rather than the purpose label.
    const label = (purposeById(c.purpose) || {}).label || '';
    const isPlaceholder = !String(c.title || '').trim() || c.title === label || c.title === 'Untitled';
    if (isPlaceholder) {
      const t = _deriveTitleFromContent(next.content);
      if (t) c.title = t;
    }
  } else if (source === 'manual') {
    next.source = 'manual';
  }
  next.updatedAt = _now();
  // Provenance — the driving comment + the framing snapshot that produced THIS
  // draft, so the current iteration and (once superseded) its history entry can
  // show what it was composed from. A hand-edit with no comment records the
  // framing but leaves the prompt blank (rendered as "Manual edit").
  if (typeof prompt === 'string' && prompt.trim()) next.prompt = prompt.trim().slice(0, 2000);
  else if (source === 'manual') next.prompt = '';
  next.framing = _framingSnapshot(c);
  c.draft = next;
  c.meta.updatedAt = next.updatedAt;
  _writeAll(st);
  return c;
}

function _pushVersion(c, draft, { reason } = {}) {
  const body = (draft && draft.content || '');
  if (!body.trim()) return null;
  if (c.versions.length && (c.versions[0].content || '').trim() === body.trim()) return c.versions[0];
  const entry = {
    id: _id('cv'),
    content: body,
    contentFormat: draft.contentFormat === 'html' ? 'html' : 'markdown',
    title: c.title,
    source: draft.source === 'ai' ? 'ai' : 'manual',
    reason: reason || 'edited',
    prompt: typeof draft.prompt === 'string' ? draft.prompt : '',
    framing: draft.framing || null,
    createdAt: draft.updatedAt || draft.generatedAt || _now(),
    savedAt: _now(),
  };
  c.versions.unshift(entry);
  if (c.versions.length > MAX_VERSIONS) c.versions.length = MAX_VERSIONS;
  return entry;
}

function listVersions(id) {
  const c = getComposition(id);
  return c ? c.versions.map(v => ({ id: v.id, title: v.title, source: v.source, reason: v.reason, prompt: typeof v.prompt === 'string' ? v.prompt : '', framing: v.framing || null, contentFormat: v.contentFormat, savedAt: v.savedAt, createdAt: v.createdAt })) : [];
}

function getVersion(id, vid) {
  const c = getComposition(id);
  return c ? (c.versions.find(v => v.id === vid) || null) : null;
}

function deleteVersion(id, vid) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return false;
  const before = c.versions.length;
  c.versions = c.versions.filter(v => v.id !== vid);
  if (c.versions.length === before) return false;
  _writeAll(st);
  return true;
}

// Restore a version to be the current draft (snapshots the current draft first).
function restoreVersion(id, vid) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const v = c.versions.find(x => x.id === vid);
  if (!v) return null;
  _pushVersion(c, c.draft, { reason: 'pre-restore' });
  c.draft = {
    content: v.content,
    contentFormat: v.contentFormat === 'html' ? 'html' : 'markdown',
    source: v.source === 'ai' ? 'ai' : 'manual',
    generatedAt: v.createdAt || '',
    updatedAt: _now(),
  };
  c.meta.updatedAt = c.draft.updatedAt;
  _writeAll(st);
  return c;
}

// Promote a prior version into its OWN document: a NEW composition (fork) cloned
// from the parent's framing (purpose/format/audience/sources) + this version's
// content, with a new title. The parent composition and its versions are left
// untouched. The fork starts with fresh (empty) version + chat history. Returns
// the new composition, or null if the parent/version doesn't exist.
function promoteVersion(id, vid, title) {
  const st = _readAll();
  const parent = st.items.find(x => x.id === id);
  if (!parent) return null;
  const v = (parent.versions || []).find(x => x.id === vid);
  if (!v) return null;
  const newTitle = (typeof title === 'string' && title.trim())
    ? title.trim().slice(0, 200)
    : (v.title || parent.title || 'Untitled');
  let sources = {};
  try { sources = JSON.parse(JSON.stringify(parent.sources || {})); } catch (_) { sources = { ...(parent.sources || {}) }; }
  const c = _defaultComposition({
    purpose: parent.purpose,
    format: parent.format,
    title: newTitle,
    audience: parent.audience,
    brief: parent.brief,
    sources,
  });
  c.draft = {
    content: v.content || '',
    contentFormat: v.contentFormat === 'html' ? 'html' : 'markdown',
    source: v.source === 'ai' ? 'ai' : 'manual',
    generatedAt: v.createdAt || '',
    updatedAt: _now(),
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    framing: v.framing || null,
  };
  c.meta.updatedAt = c.draft.updatedAt;
  st.items.unshift(c);
  _writeAll(st);
  return c;
}
// Rename a prior version in place — the title sticks on that version row.
// Does NOT touch the current draft, the composition title, or fork a new
// document. Returns the updated version, or null if not found / empty title.
function renameVersion(id, vid, title) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const v = (c.versions || []).find(x => x.id === vid);
  if (!v) return null;
  const t = (typeof title === 'string' ? title.trim() : '').slice(0, 200);
  if (!t) return null;
  v.title = t;
  _writeAll(st);
  return v;
}
function appendChat(id, msg) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const role = msg && msg.role === 'assistant' ? 'assistant' : 'user';
  const text = String(msg && msg.text || '');
  const entry = { role, text, at: _now() };
  if (msg && msg.structure) entry.structure = true;
  c.chat.push(entry);
  if (c.chat.length > MAX_CHAT) c.chat = c.chat.slice(-MAX_CHAT);
  c.meta.updatedAt = _now();
  _writeAll(st);
  return c;
}

function markDelivered(id, via) {
  const st = _readAll();
  const c = st.items.find(x => x.id === id);
  if (!c) return null;
  const now = _now();
  c.meta.lastDeliveredAt = now;
  c.meta.lastDeliveredVia = String(via || '');
  c.meta.updatedAt = now;
  _writeAll(st);
  return c;
}

function exportComposition(id) {
  const c = getComposition(id);
  if (!c) return null;
  return { exportedAt: _now(), composition: c };
}

module.exports = {
  PURPOSES,
  FORMATS,
  AUDIENCES,
  SOURCES,
  SOURCE_DEFAULTS,
  PURPOSE_BLUEPRINTS,
  purposeById,
  blueprintFor,
  contentFormatFor,
  storageDir,
  assetsDir,
  listCompositions,
  getComposition,
  createComposition,
  updateComposition,
  deleteComposition,
  saveDraft,
  listVersions,
  getVersion,
  deleteVersion,
  restoreVersion,
  promoteVersion,
  renameVersion,
  appendChat,
  markDelivered,
  exportComposition,
};
