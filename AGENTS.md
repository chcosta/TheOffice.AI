# Agent guidance — TheOffice.AI

Notes for any agent working in this repo. **Read before making changes** — especially
the *Feature tiers* section before adding any new feature or page.

## Architecture at a glance

- **`server.js`** (repo root) — Node/Express backend; ~258 route handlers wired
  directly (no router module). Serves the SPA and all `/api/*` routes.
- **`public/app.html`** — a single ~1.8 MB **Alpine.js SPA** (the entire frontend
  lives in this one file). All UI state + methods are in one big Alpine component.
- Supporting root modules: **`supervisor.js`** (scheduling/execution), **`manager.js`**
  (orchestration + chat), **`config-sync.js`** (cloud sync + leader election),
  **`settings.js`** (per-user settings store), **`data-paths.js`** (`dataPath(name)`
  → `~/.copilot/agent-supervisor`), **`scheduler.js`** (schedule-string parser only),
  **`dependencies.js`** (managed-dependency updater).
- **Browser and desktop coexist — the desktop app is NOT a rewrite.** `desktop/`
  is a Tauri v2 shell that spawns the *unmodified* `server.js` as a Node **sidecar**
  and loads the same `public/app.html` in WebView2. Anything you change in the server
  or SPA applies to both. The browser/LAN path (default bind on all interfaces, used
  by the mobile/QR feature) stays intact; the desktop shell just pins to loopback
  with `PORT=0`. See `desktop/README.md` for the `__READY__` sidecar contract.

## Build, run & test

Run the server for development (browser at **http://localhost:3847**):

```powershell
npm start          # or: npm run dev  (file watching)
```

**Validate SPA + server edits before declaring done** (browser regression tooling —
puppeteer/Edge — is unreliable in this env, so rely on these):

```powershell
node _syntax.mjs                     # compiles every inline <script> in app.html → "checked N scripts, 0 errors"
node -c server.js                    # syntax-check a changed server module (also settings.js, dependencies.js, …)
```

Restarting the dev server on **:3847** (env vars matter for the SDK path):

```powershell
# find + kill the PID on 3847, then relaunch
Get-NetTCPConnection -LocalPort 3847 | Select-Object -Expand OwningProcess   # → PID
Stop-Process -Id <PID> -Force
$env:SDK_READ_MODE='authoritative'; $env:SDK_RUN_MODE='all'; Start-Process node server.js -WindowStyle Hidden
```

Smoke-test routes with `Invoke-RestMethod` (there is **no `/api/health`** — use
`/api/settings` or `/api/dependencies` to confirm the server is live).

Building the **desktop installer** is documented in `desktop/README.md` (`cd desktop;
npm run build` → NSIS installer). Don't block on it for server/SPA work.

## Feature tiers: Basic vs Advanced (read before adding a feature)

The app ships in two experience levels. **When you add a feature, decide where it
belongs — don't just drop it into the main nav for everyone.**

- **`experienceLevel`** (`localStorage: experience-level`) — **`'basic'` (default)**
  vs `'advanced'`. Basic is a single flat sidebar with no Productivity/Management
  split. Advanced unlocks everything.
- **`appMode`** (`localStorage: app-mode`) — **`'workspace'` (Productivity: boards,
  insights, code flow) vs `'workforce'` (Management: managers, agents, tasks, flows)**.
  This split **only exists in Advanced mode**; in Basic, `appMode` is pinned to
  `'workspace'`. `routeMode(route)` maps each route to its owning mode (or `null` for
  shared routes like home/settings/marketplace).
- **`basicFeatures`** (`localStorage: basic-features`) — a map of **optional features
  the user can toggle on while staying in Basic**. Defaults: `tasks: true`, everything
  else off (`insights, managers, flows, watercooler, teams, sessions, news`). The
  toggle checklist is driven by **`basicFeatureCatalog()`**; the flat sidebar is built
  in the `experienceLevel === 'basic'` branch of the nav builder (~L15187).
- **Always-on in Basic** (no toggle): Home, Boards, Code Flow, Agents, Marketplace
  (plus Settings). These are the curated "simple" surface.
- **Teams gating** — `teamSelectorVisible()` returns true always in Advanced, but in
  Basic only when `basicFeatures.teams` is on. **Do not surface team-scoped UI or
  silently change the team scope when the selector is hidden** — Basic-without-Teams
  users have no way to see or change scope (this bit us before; see the guards in
  `setExperienceLevel`/`toggleBasicFeature`/quick-launch).
- **Getting Started onboarding** is **Basic-only** (guided standup-agent → daily task
  → board flow). `gsPreview` (`localStorage: gs-preview`) force-replays it.

**Decision guide for a new feature:**

1. Is it core to the simple experience (something a brand-new user needs)? → make it
   always-on in Basic *and* available in Advanced.
2. Is it a power feature most users won't need? → **default it OFF in Basic** by adding
   a `basicFeatures` key + a `basicFeatureCatalog()` entry (so it's discoverable as an
   opt-in), and place it in the appropriate Advanced `workspace`/`workforce` group.
3. Is it advanced-only / operationally complex? → surface it **only in Advanced**
   (don't add a Basic toggle) and pick the right `appMode` group via `routeMode`.
4. Whatever you choose: add the route to **`basicRouteVisible()`** so users aren't
   stranded on a hidden page after switching to Basic, and respect `teamSelectorVisible()`
   for anything team-scoped.

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
