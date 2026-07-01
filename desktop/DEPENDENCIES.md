# TheOffice.AI — Dependency inventory

Everything the app needs at runtime, split into **what we bundle inside the
installer** vs **what must already exist on the user's machine** (and therefore
what the installer's prerequisite step installs) vs **optional** extras.

This was derived by auditing every `spawn`/`exec`/`require` of an external tool in
`server.js`, `supervisor.js`, `manager.js`, `chains.js`, `azdo.js`, `devitems.js`,
`sdk-*.js`, and the `package.json` dependency tree.

---

## A. Bundled inside the app (shipped as Tauri resources — user installs nothing)

These are staged into `desktop/src-tauri/resources/` by `scripts/stage-sidecar.mjs`
and shipped inside the installer.

| Item | Size (approx) | Notes |
| --- | --- | --- |
| **Portable Node.js** (`node.exe`) | ~85 MB | Runs the sidecar (`server.js`), the board MCP (`board-mcp.js`), and any node-based MCP servers. One self-contained exe. |
| **Server app** | ~2 MB | `server.js` + all runtime `*.js` (supervisor, manager, chains, azdo, db, data-paths, sdk-runner/reader, mobile-handler, event-listener, devitems, mcpTest, …), `public/` (the SPA), `builtin-plugins/` (board + manager plugins, skills). |
| **Production `node_modules`** | **~660 MB** | Prod-only install (`npm install --omit=dev`), so `puppeteer-core` (dev/test only) is excluded. Dominated by the Copilot packages below. |

### What's inside the bundled `node_modules`

| Package | Size | Why it matters |
| --- | --- | --- |
| **`@github/copilot`** | ~462 MB | **The Copilot CLI itself**, pulled in transitively by `@github/copilot-sdk`. Vendors its own **ripgrep**, tree-sitter parsers (`*.wasm`), `foundry-local-sdk`, voice engine, prebuilds. Bin = `npm-loader.js` (the `copilot` command). |
| **`@github/copilot-win32-x64`** | ~144 MB | Contains **`copilot.exe`** — the actual platform binary the loader runs. npm installs only the win32-x64 platform dep on Windows (no linux/darwin bloat). |
| **`@github/copilot-sdk`** | ~1 MB | The in-process agent runtime — the sole transport used by `sdk-runner.js` / `sdk-reader.js` / `manager.js` / `chains.js`. Depends on `@github/copilot`, `vscode-jsonrpc`, `zod`. |
| `@azure/identity`, `@azure/service-bus`, `@azure/storage-blob` | ~44 MB | Azure config-sync (Blob leader lease) + relay/service-bus features. |
| `express`, `multer` | — | HTTP server + uploads. |
| `sql.js` | — | The SQLite store (WASM; no native build). |
| `croner`, `cronstrue` | — | Schedule engine + human-readable cron. |
| `marked` | — | Markdown rendering. |
| `qrcode` | — | Mobile-pairing QR. |
| `jsonwebtoken`, `jwks-rsa` | — | Mobile-companion auth. |
| `js-yaml` | — | Agent/plugin config parsing. |
| `yauzl`, `yazl` | — | Plugin zip pack/unpack. |

> **Consequence:** because the Copilot CLI (and its ripgrep) are vendored in
> `node_modules`, the user does **not** need a separate `npm i -g @github/copilot`.
> The server's `COPILOT_PATH` resolution prefers the bundled copilot.

---

## B. Prerequisites the user's machine must have (installer installs / verifies)

Handled by `scripts/install-prerequisites.ps1` (winget-based). None require the user
to hand-install anything; the script installs any that are missing.

| Prereq | Required? | Used for | Install source |
| --- | --- | --- | --- |
| **WebView2 Runtime** | **Required** | The renderer (native window). Preinstalled on current Win10/11; the Tauri NSIS installer can auto-provision if absent. | Tauri bundler / Evergreen bootstrapper |
| **Git** | **Required** | Every repo / worktree / PR / dev-card flow spawns `git` directly (`devitems.js`, `server.js` code-flow). | `winget install Git.Git` |
| **Azure CLI (`az`)** | **Required for Azure DevOps** | AzDo auth + REST: `az account get-access-token`, `az login` (`azdo.js`). Without it, AzDo boards/PRs/dev-cards don't work (GitHub-only usage is unaffected). | `winget install Microsoft.AzureCLI` |
| **Ripgrep (`rg`) on PATH** | Recommended | The server's `/api/...` code-search endpoint spawns `rg`. (Copilot vendors its own rg internally, but the server's PATH call wants a system rg.) Tiny. | `winget install BurntSushi.ripgrep.MSVC` |

### One-time user actions (cannot be installed — they're logins)

- **Copilot sign-in** — run the bundled `copilot` once (or first-run prompt) to
  authenticate; the SDK and CLI share credentials under `~/.copilot`.
- **`az login`** — needed before Azure DevOps features work.

---

## C. Optional / on-demand (not required for core function)

| Item | When it's used |
| --- | --- |
| **VS Code / `code-insiders`** | "Open in editor" / "open diff in editor" convenience actions only. |
| **Python + `uvx`** | Only for specific third-party MCP plugins (e.g. `microsoft-fabric-rti-mcp`). Installed on demand per-plugin, not by us. |
| **`agency` CLI** | Legacy alternate plugin engine (`agency plugin install …`). Optional/fallback path. |
| **VS Build Tools / `vswhere`** | "Open developer command prompt" convenience only. |
| **GitHub CLI (`gh`)** | **Not used** — no references in the codebase. |

---

## Where runtime data lives (no admin needed)

Per-user, under the profile — never in Program Files, so the app runs without
elevation after install:

- `~/.copilot/agent-supervisor/` — agents, managers, tasks, chains, boards, chats,
  the SQLite db (`SUPERVISOR_DATA_DIR` overrides).
- `~/.copilot/` — Copilot config + installed plugins + credentials.

---

## Summary: what the installer does

1. **Ships** (bundled): portable Node, the server app, and the full production
   `node_modules` — which already includes **Copilot CLI + SDK + ripgrep**.
2. **Installs if missing** (winget): Git, Azure CLI, ripgrep; provisions WebView2.
3. **Prompts once** (user action): Copilot sign-in and `az login`.
