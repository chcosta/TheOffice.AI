// marketplace-design.js
//
// Marketplace Phase 4: "Design with AI". Given the marketplace catalog of
// available skills + MCP servers (and, optionally, an existing agent's current
// capabilities), build grounded prompts for a one-shot Copilot completion that
// proposes either:
//   - ENHANCE: creative capability attachments for an existing agent, or
//   - CREATE:  a brand-new agent spec (persona + tools + capabilities) composed
//              from what the catalog actually offers.
//
// This module is pure (prompt strings, JSON parsing, normalization, and writing
// a generated .agent.md). The SDK call + attach/register live in server.js,
// reusing marketplace.* and capabilities.* — mirroring the existing execution
// "Design with AI" feature.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const marketplace = require('./marketplace');

const SUPERVISOR_DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.copilot', 'agent-supervisor');
const GENERATED_AGENTS_DIR = path.join(SUPERVISOR_DATA_DIR, 'generated-agents');
// Brand-new skills the AI authors are written here, under the plugins store that
// capabilities.buildCatalog() scans for SKILL.md — so a generated skill
// immediately surfaces in the marketplace catalog (reusable on other agents),
// not just on the agent it was generated for.
const GENERATED_SKILLS_DIR = path.join(SUPERVISOR_DATA_DIR, 'plugins', '_generated-skills');

const KNOWN_TOOLS = ['powershell', 'bash', 'view', 'edit', 'create', 'grep', 'glob', 'web_search', 'web_fetch'];

function slugify(v, fallback = 'agent') {
  return String(v || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

// ---- compact catalog for the prompt -------------------------------------

// A small, model-friendly view of the catalog. Every capability gets a stable
// "ref" of the form "<type>:<name>" the model echoes back; we re-resolve refs
// server-side at apply time via marketplace.resolveByTypeName.
function compactCatalog() {
  const skills = marketplace.getCatalog({ type: 'skill' }).entries.map(e => ({
    ref: `skill:${e.name}`, name: e.name, source: e.sourceLabel, description: (e.description || '').slice(0, 160),
  }));
  const mcp = marketplace.getCatalog({ type: 'mcp' }).entries.map(e => ({
    ref: `mcp:${e.name}`, name: e.name, source: e.sourceLabel,
    description: (e.mcp && e.mcp.command) || e.description || '',
  }));
  // de-dupe by ref (catalog may merge the same cap from several sources)
  const dedupe = (arr) => {
    const seen = new Set(); const out = [];
    for (const x of arr) { const k = x.ref.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(x); }
    return out;
  };
  return { skills: dedupe(skills), mcp: dedupe(mcp) };
}

// ---- prompts -------------------------------------------------------------

function enhancePrompt(agentInfo, caps, catalog, hint) {
  const currentMcp = (caps.mcp || []).map(m => m.name);
  const currentSkills = (caps.skills || []).map(s => s.name);
  return [
    'You are a capability strategist for an agent-orchestration platform. An agent already exists; your job is to make it MORE capable or unlock a genuinely new use-case by attaching skills and MCP (tool) servers that are AVAILABLE in the marketplace catalog.',
    '',
    'TARGET AGENT:',
    JSON.stringify({ name: agentInfo.name, description: agentInfo.description }, null, 2),
    '',
    'IT ALREADY HAS these capabilities (do NOT propose re-adding these):',
    JSON.stringify({ mcp: currentMcp, skills: currentSkills }, null, 2),
    '',
    'AVAILABLE CAPABILITIES you may attach (reference each ONLY by its exact "ref"):',
    JSON.stringify(catalog, null, 2),
    '',
    hint ? ('USER FOCUS: ' + hint) : 'No specific focus — find the highest-leverage additions.',
    '',
    'Propose up to 3 distinct enhancement ideas. Each idea bundles one or more available capabilities that together unlock something the agent cannot currently do. Only reference capabilities that appear in AVAILABLE CAPABILITIES, by their exact ref. Do not invent refs.',
    '',
    'If — and ONLY if — no existing skill in the catalog covers a piece of know-how the idea needs, you may AUTHOR a brand-new skill for that idea. A skill is a SKILL.md document: focused instructions / domain knowledge that teaches the agent HOW to do something (it does NOT run code or call APIs by itself — pair it with an MCP server when the task needs live actions). Put authored skills in a top-level "newSkills" array (NOT in "attach"); they are attached automatically. Prefer reusing an existing "skill:" ref over authoring a new one.',
    '',
    'For each idea also write a "testPrompt": a concrete, ready-to-run instruction (1-3 sentences) that exercises EXACTLY the new behavior this idea unlocks, using the attached capabilities on realistic inputs — not a generic "what can you do" question. It should read like a real task the enhanced agent would be asked to perform.',
    '',
    'Respond with ONLY a JSON array (no prose) in this exact shape:',
    '```json',
    '[',
    '  {',
    '    "kind": "enhance",',
    '    "title": "short idea name",',
    '    "rationale": "one or two sentences on what this unlocks",',
    '    "testPrompt": "a concrete task that exercises the new behavior",',
    '    "attach": [ { "ref": "mcp:some-server", "why": "why this cap" }, { "ref": "skill:some-skill", "why": "..." } ],',
    '    "newSkills": [ { "name": "Human Friendly Skill Name", "slug": "kebab-case-slug", "description": "one line on when to use it", "body": "# Skill\\nMarkdown instructions teaching the agent how to do the task..." } ]',
    '  }',
    ']',
    '```',
    'Omit "newSkills" (or use an empty array) when the catalog already covers everything.',
  ].join('\n');
}

function createPrompt(catalog, inspirationAgents, hint) {
  return [
    'You are an agent designer for an orchestration platform. Design a brand-new, genuinely useful agent from scratch, composing its capabilities ONLY from the marketplace catalog below.',
    '',
    'AVAILABLE CAPABILITIES (reference each ONLY by its exact "ref"):',
    JSON.stringify(catalog, null, 2),
    '',
    'EXISTING AGENTS (for inspiration / to avoid duplicating):',
    JSON.stringify(inspirationAgents, null, 2),
    '',
    hint ? ('USER REQUEST: ' + hint) : 'No specific request — propose agents that turn the available capabilities into clear, actionable outcomes.',
    '',
    'Propose up to 3 new agent designs. Each agent has a focused persona and attaches a coherent set of available capabilities. The persona "body" is markdown describing the agent\'s role, how it should behave, and how it should use its tools/skills — but do NOT include any response-format or action-block section. Choose tools from this set only: ' + JSON.stringify(KNOWN_TOOLS) + '. Only reference catalog capabilities that exist, by exact ref.',
    '',
    'If — and ONLY if — no existing skill in the catalog covers a piece of know-how an agent needs, you may AUTHOR a brand-new skill for it. A skill is a SKILL.md document: focused instructions / domain knowledge that teaches the agent HOW to do something (it does NOT run code or call APIs by itself — pair it with an MCP server when the task needs live actions). Put authored skills in that agent\'s "newSkills" array (NOT in "attach"); they are attached automatically. Prefer reusing an existing "skill:" ref over authoring a new one.',
    '',
    'For each agent also write a "testPrompt": a concrete, ready-to-run instruction (1-3 sentences) that asks the agent to actually perform its core job on realistic inputs using its tools/skills — not a generic "what can you do" question. It should read like the first real task you would hand this agent.',
    '',
    'Respond with ONLY a JSON array (no prose) in this exact shape:',
    '```json',
    '[',
    '  {',
    '    "kind": "create",',
    '    "title": "short design name",',
    '    "rationale": "one line on why this agent is useful",',
    '    "testPrompt": "a concrete first task that exercises the agent\'s core job",',
    '    "agent": { "name": "Human Friendly Name", "slug": "kebab-case-slug", "description": "one line", "tools": ["powershell"], "body": "# Role\\n..." },',
    '    "attach": [ { "ref": "skill:some-skill", "why": "..." }, { "ref": "mcp:some-server", "why": "..." } ],',
    '    "newSkills": [ { "name": "Human Friendly Skill Name", "slug": "kebab-case-slug", "description": "one line on when to use it", "body": "# Skill\\nMarkdown instructions teaching the agent how to do the task..." } ]',
    '  }',
    ']',
    '```',
    'Omit "newSkills" (or use an empty array) when the catalog already covers everything.',
  ].join('\n');
}

// ---- parsing + normalization --------------------------------------------

// Pull a JSON array (or single object) out of an AI reply.
function parseProposals(text) {
  if (!text) return null;
  let body = null;
  const fence = String(text).match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) body = fence[1];
  if (!body) {
    const s = text.indexOf('['); const e = text.lastIndexOf(']');
    if (s >= 0 && e > s) body = text.slice(s, e + 1);
  }
  if (!body) {
    const s = text.indexOf('{'); const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) body = text.slice(s, e + 1);
  }
  if (!body) return null;
  try {
    const parsed = JSON.parse(body.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) { return null; }
}

// Resolve a list of { ref, why } against the live catalog. Drops unknown refs.
function resolveAttachments(rawAttach) {
  const out = [];
  for (const a of Array.isArray(rawAttach) ? rawAttach : []) {
    const ref = String((a && a.ref) || '').trim();
    const m = ref.match(/^(skill|mcp)\s*:\s*(.+)$/i);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const name = m[2].trim();
    const entry = marketplace.resolveByTypeName(type, name);
    if (!entry) continue;
    out.push({ type, name: entry.name, entryId: entry.id, why: String((a && a.why) || '').trim() });
  }
  // de-dupe by entryId
  const seen = new Set();
  return out.filter(x => (seen.has(x.entryId) ? false : (seen.add(x.entryId), true)));
}

// Normalize the AI's authored skills into clean { name, slug, description, body }
// specs. Drops entries without a usable name+body and de-dupes by slug.
function normalizeNewSkills(rawArr) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rawArr) ? rawArr : []) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || r.title || r.slug || '').trim();
    const body = String(r.body || '').trim();
    const description = String(r.description || '').replace(/\r?\n/g, ' ').trim();
    if (!name || (!body && !description)) continue;
    const slug = slugify(r.slug || name, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug, description, body: body || `# ${name}\n\n${description}` });
  }
  return out;
}

function normalizeEnhance(raw, agentId) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  const attach = resolveAttachments(raw.attach);
  const newSkills = normalizeNewSkills(raw.newSkills);
  if (!title || (!attach.length && !newSkills.length)) return null;
  return {
    id: 'mdz-' + crypto.randomBytes(5).toString('hex'),
    kind: 'enhance',
    agentId,
    title,
    rationale: String(raw.rationale || '').trim(),
    testPrompt: String(raw.testPrompt || '').trim(),
    attach,
    newSkills,
  };
}

function normalizeCreate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw.agent || {};
  const name = String(a.name || raw.title || '').trim();
  const body = String(a.body || '').trim();
  if (!name || !body) return null;
  const slug = slugify(a.slug || name);
  let tools = Array.isArray(a.tools) ? a.tools.filter(t => KNOWN_TOOLS.includes(t)) : [];
  if (!tools.length) tools = ['powershell'];
  return {
    id: 'mdz-' + crypto.randomBytes(5).toString('hex'),
    kind: 'create',
    title: String(raw.title || name).trim(),
    rationale: String(raw.rationale || '').trim(),
    testPrompt: String(raw.testPrompt || '').trim(),
    agent: { name, slug, description: String(a.description || '').trim(), tools, body },
    attach: resolveAttachments(raw.attach),
    newSkills: normalizeNewSkills(raw.newSkills),
  };
}

// ---- generated agent writer ---------------------------------------------

// Materialize a from-scratch agent as <dir>/.github/agents/<slug>.agent.md so the
// sdk-runner project-agent path can run it; attached caps are wired via overlay.
function writeGeneratedAgent(agentSpec) {
  const slug = slugify(agentSpec.slug || agentSpec.name);
  const dir = path.join(GENERATED_AGENTS_DIR, slug);
  const agentsDir = path.join(dir, '.github', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const fmTools = JSON.stringify(agentSpec.tools || ['powershell']);
  const md = [
    '---',
    `name: ${agentSpec.name}`,
    `description: ${JSON.stringify(agentSpec.description || '')}`,
    `tools: ${fmTools}`,
    '---',
    '',
    agentSpec.body || `# ${agentSpec.name}`,
    '',
  ].join('\n');
  const agentMdPath = path.join(agentsDir, `${slug}.agent.md`);
  fs.writeFileSync(agentMdPath, md);
  return { slug, dir, agentMdPath };
}

// Materialize an AI-authored skill as <GENERATED_SKILLS_DIR>/<slug>/SKILL.md.
// The leaf dir name becomes the catalog skill name (capabilities.buildCatalog
// uses basename(dirname(SKILL.md))), so the skill is both catalog-visible
// (reusable / "marketplace support") and attachable to the generated agent.
function writeGeneratedSkill(spec) {
  const slug = slugify(spec.slug || spec.name, '');
  const dir = path.join(GENERATED_SKILLS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const md = [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(spec.description || '')}`,
    '---',
    '',
    spec.body || `# ${spec.name}`,
    '',
  ].join('\n');
  const skillMdPath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skillMdPath, md);
  return { name: slug, slug, dir, skillMdPath };
}

module.exports = {
  GENERATED_AGENTS_DIR,
  GENERATED_SKILLS_DIR,
  KNOWN_TOOLS,
  slugify,
  compactCatalog,
  enhancePrompt,
  createPrompt,
  parseProposals,
  resolveAttachments,
  normalizeEnhance,
  normalizeCreate,
  normalizeNewSkills,
  writeGeneratedAgent,
  writeGeneratedSkill,
};
