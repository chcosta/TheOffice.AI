# Agent guidance — TheOffice.AI

Notes for any agent working in this repo. Read before making UI changes.

## UI conventions

### Do NOT use "pills" as an organizational structure

Pills — small rounded ("999px" radius), bordered/filled chips used to label, tag,
or index things — are banned as an **organizational/navigational** pattern. The
owner finds them cluttered and space-hungry, and prefers a calm, clean look.

When you'd reach for a pill, use one of these instead:
- **Inline text links** separated by space/middots (e.g. a "Jump to …" index row).
- **Plain text with a muted count** (`label 12`) rather than a badge bubble.
- A compact **dropdown / select** when the list is long.
- Quiet **underline or accent-on-active** to show selection — not a filled chip.

This applies across the board ecosystem (boards, insights, teams, CLI sessions).
Small status **badges** on an individual card (e.g. an origin/agent marker) are
fine; the ban is specifically about using rows of pills to group, tag, filter, or
navigate.

Keep `border-radius` modest (~8px) for genuine buttons; reserve `999px` for true
avatars/dots, never for text labels used as an index.
