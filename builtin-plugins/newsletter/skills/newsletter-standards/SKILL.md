---
name: newsletter-standards
description: Format, structure, and voice standards for producing a polished, emailable newsletter from the Connect impact diary — modeled on mainstream professional newsletters.
---

# Newsletter standards

Guidance for turning impact-diary evidence into a newsletter people actually enjoy reading. Model the format and rhythm of well-known professional newsletters (think a clean weekly digest: a strong masthead, a short intro, a few well-told stories, a data visual or two, and a light closer).

## Layout (top to bottom)

1. **Hero masthead** — a full-width inline `<svg>` banner (accent-colored or `<linearGradient>` background with the issue title set in `<text>` and light geometric/iconographic art — never a stock photo), immediately followed by an `# ` H1 that is a *specific, inviting issue title* (e.g. "Shipping Week: Autoscaler Goes Live", not "Weekly Newsletter"), a one-line **dek** (subtitle), and the **covered date range**.
2. **In this issue** — 2–3 sentence intro naming the theme of the period and teasing the highlights.
3. **Highlight stories** — 2–4 `## ` sections. Each: a punchy headline, then 2–4 tight sentences following **Action → Scale → Measurable impact → Business outcome**, with a link to the primary source (PR, work item, doc, thread) when the evidence has one, and **at least one visual** (captured screenshot, chart, or stat card).
4. **Charts & stat cards** — inline SVG visuals where real numbers support them (see below).
5. **By the numbers** — a short bulleted stat line (items shipped, PRs merged, meetings driven) — only figures you can substantiate.
6. **Up next / closer** — a brief forward-looking or thank-you sign-off.

**Imagery is required, not decorative-optional.** Open every issue with the hero banner and keep a visual roughly every screenful. A text-only newsletter is a failure.

## Voice

- Warm, confident, skimmable. Lead with outcomes, not activity.
- Short paragraphs (2–4 sentences). Strong verbs. Concrete nouns.
- Celebrate honestly: highlight wins and quantify **only where evidence supports it**. Never oversell or invent.
- First person or editorial "we" is fine — match what reads naturally for a personal impact digest.

## Charts & stat cards (inline SVG, email-safe)

- Self-contained `<svg width viewBox>` with `<rect>`/`<line>`/`<polyline>`/`<text>`/`<circle>`/`<linearGradient>` only.
- **No** `<script>`, external CSS, or web fonts. Inline `fill`/`stroke` attributes only.
- Bar chart for category counts; line/`<polyline>` for a trend over the weeks in the window; **stat cards** (big number + label in rounded rects) for headline figures.
- Label bars/axes/cards with `<text>`. Use the accent color if given, else `#0078d4`; a gradient for the hero.
- One bold caption line above each chart. Only chart numbers you actually derived.

## Screenshots — capture, don't just suggest

- **Try to capture the real thing first.** Deep-dive the referenced PRs, work items, builds, dashboards, wiki/spec pages, and repos in a browser (or via shell) and capture the telling view — a merged-PR checks-passed screen, a diff, a Grafana/dashboard panel, a build summary, a slide from a deck, a meeting recap.
- Save each capture into the assets directory and embed it with a caption:
  `![Merged PR #1234 — all checks green](assets/pr-1234-checks.png)` (optionally inside `<figure>…<figcaption>…</figcaption></figure>`).
- **Only** embed images that exist on disk after saving. If you genuinely cannot capture one, fall back to a clearly-marked suggestion the user can swap in:
  `> 📸 **Suggested screenshot:** <what to capture and why it helps>`

## Hard rules

- Ground everything in the diary evidence and your investigation of it. No fabricated metrics, quotes, or events.
- Keep it tight — a great newsletter is a few strong stories, not an exhaustive log.
- Output the newsletter Markdown (inline HTML/SVG/images allowed) wrapped in the `===NEWSLETTER-START===` / `===NEWSLETTER-END===` sentinels; no surrounding code fences.
