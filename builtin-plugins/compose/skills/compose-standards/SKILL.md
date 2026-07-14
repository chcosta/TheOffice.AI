---
name: compose-standards
description: Craft standards for Compose.AI — how to shape a deliverable by purpose, audience, and medium; visual conventions (tables, inline SVG charts); tone; and the AI-drafts-only policy.
---

# Compose.AI craft standards

Compose.AI produces a **finished, sendable deliverable** from a brief. The brief has four levers:
**purpose** (why), **audience** (who), **medium/format** (how it's delivered), and **sources**
(what it's grounded in). Craft the artifact for that specific combination.

## First principle: weave a story, then support it

Every deliverable should do a job — persuade, align, inform, specify, or demonstrate. Decide the
**spine** (the one-line argument or takeaway) before writing, then make every section serve it.
Lead with what the audience cares about. Never open with throat-clearing.

## Structure by purpose

- **Proposal** — Recommendation up front (what you're proposing and the ask), then Why now /
  problem, Options considered, Recommended approach, Impact & cost, Risks & mitigations, Next
  steps / decision needed. Argue a position; make the ask unmissable.
- **Alignment memo** — Shared context, the decision or direction, what it means for each
  stakeholder, open questions, and the specific buy-in you need. Build understanding before
  asking for agreement.
- **Status update** — TL;DR (on track / at risk / blocked), progress since last, metrics,
  risks & blockers, asks, what's next. Lead with the health signal.
- **One-pager** — A single tight page: headline, the point in 2–3 sentences, a compact evidence
  block (a small table or a couple of stats), and a clear next step. Ruthlessly short.
- **Technical doc** — Overview/goal, context, design/approach, interfaces or APIs, data/flows,
  trade-offs, testing/rollout, open questions. Precise and complete; specify, don't hand-wave.
- **Architecture doc** — Context & goals, constraints, the architecture (with a diagram), key
  components and their responsibilities, data flow, key decisions (with rationale and
  alternatives), risks, and a roadmap.
- **Reference** — Scannable and exhaustive: a clear contents/index, consistent entry structure,
  tables for parameters/fields, examples. Optimized for lookup, not narrative.
- **Newsletter** — Warm, story-driven, human. A masthead, a short intro, a few stories with
  impact and a light chart or two, a friendly close. (This purpose can also hand off to the
  dedicated Newsletter studio.)
- **Prototype / demo site** — A self-contained, **interactive** microsite that *demonstrates* an
  experience or concept: a landing header, in-page nav, feature/flow sections with working UI
  rendered in HTML/CSS/JS, sample-data interactions (nav, forms, filterable lists, charts drawn
  from data, animated progress), and inline `<svg>` where a diagram helps. Build it to feel real.

## Medium conventions

- **email** — Subject as H1, skimmable body, one clear ask, short close. Sparse visuals.
- **teams** — Short and punchy, bullets over prose, one call to action, no long preamble.
- **doc** — Title, one-paragraph summary, well-headed sections; rich tables/charts as warranted.
- **site** — One self-contained `<!doctype html>` document, CSS in `<style>`, JS in `<script>`,
  no external assets, light + dark via `prefers-color-scheme`. Interactive and self-simulating,
  with ALL navigation kept in-page (never external/absolute links or `target="_blank"`). It runs
  in a locked-down sandbox (no storage/cookies/parent access) — use only in-memory JS state.

## Visuals

- **Tables** for comparisons, metrics, parameters, timelines, options.
- **Charts** are always inline `<svg>` — bar/line/simple diagrams. Self-contained: no scripts,
  no external CSS, no external images. Email- and sandbox-safe.
- **Diagrams** (architecture, flow) as inline `<svg>` or clean ASCII in a code block.
- Screenshots stay as clearly-marked placeholders unless a real captured image exists.
- Density scales with purpose: proposals / status updates / technical & architecture docs are
  visual; alignment memos and newsletters are lighter and more narrative.

## No pills as organization

Do not use rows of small rounded pill/chip shapes to label, tag, group, filter, or navigate. Use
plain text links, quiet headings, muted counts (`Label 12`), or a simple contents list instead.
Small status badges on an individual item are fine.

## Tone

Match the audience. Executives: crisp, outcome-first, low jargon. Peers/engineers: precise,
technical, assume context. External: clear, self-contained, no internal shorthand. Always concrete
over generic; specific numbers and names over vague claims.

## AI-drafts-only policy

Everything Compose.AI produces is a **draft for the user to review and edit before sending**.
Never fabricate results, numbers, names, quotes, or sources. Ground every claim in the provided
sources and investigation. When evidence is missing for something the purpose wants, flag it
plainly rather than inventing it.
