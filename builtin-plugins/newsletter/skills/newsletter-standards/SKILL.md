---
name: newsletter-standards
description: Format, structure, and voice standards for producing a polished, emailable newsletter from the Connect impact diary — modeled on mainstream professional newsletters.
---

# Newsletter standards

Guidance for turning impact-diary evidence into a newsletter people actually enjoy reading. Model the format and rhythm of well-known professional newsletters (think a clean weekly digest: a strong masthead, a short intro, a few well-told stories, a data visual or two, and a light closer).

## Layout (top to bottom)

1. **Masthead** — an `# ` H1 that is a *specific, inviting issue title* (e.g. "Shipping Week: Autoscaler Goes Live", not "Weekly Newsletter"). Directly under it, a one-line **dek** (subtitle) and the **covered date range**. If an accent color is provided, you may wrap the masthead in a simple inline-styled `<div>` banner using that color.
2. **In this issue** — 2–3 sentence intro naming the theme of the period and teasing the highlights.
3. **Highlight stories** — 2–4 `## ` sections. Each: a punchy headline, then 2–4 tight sentences following **Action → Scale → Measurable impact → Business outcome**, with a link to the primary source (PR, work item, doc, thread) when the evidence has one.
4. **Charts** — one or two inline SVG visuals where real numbers support them (see below).
5. **By the numbers** — a short bulleted stat line (items shipped, PRs merged, meetings driven) — only figures you can substantiate.
6. **Up next / closer** — a brief forward-looking or thank-you sign-off.

## Voice

- Warm, confident, skimmable. Lead with outcomes, not activity.
- Short paragraphs (2–4 sentences). Strong verbs. Concrete nouns.
- Celebrate honestly: highlight wins and quantify **only where evidence supports it**. Never oversell or invent.
- First person or editorial "we" is fine — match what reads naturally for a personal impact digest.

## Charts (inline SVG, email-safe)

- Self-contained `<svg width viewBox>` with `<rect>`/`<line>`/`<polyline>`/`<text>` only.
- **No** `<script>`, external CSS, or web fonts. Inline `fill`/`stroke` attributes only.
- Bar chart for category counts; line/`<polyline>` for a trend over the weeks in the window.
- Label bars/axes with `<text>`. Use the accent color if given, else `#0078d4`.
- One bold caption line above each chart. Only chart numbers you actually derived.

## Screenshots

- Prefer a clearly-marked **suggestion** the user can swap in:
  `> 📸 **Suggested screenshot:** <what to capture and why it helps>`
- Embed a real image only if you captured/generated one into the assets directory:
  `![caption](assets/<file>.png)`. Never embed a path that doesn't exist.

## Hard rules

- Ground everything in the diary evidence and your investigation of it. No fabricated metrics, quotes, or events.
- Keep it tight — a great newsletter is a few strong stories, not an exhaustive log.
- Output Markdown only (inline HTML/SVG allowed), no surrounding code fences.
