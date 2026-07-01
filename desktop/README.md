# TheOffice.AI — Desktop (Tauri shell)

A native desktop wrapper around the existing TheOffice.AI web app. The Rust shell
(Tauri v2) launches the **unmodified `server.js` as a Node sidecar**, discovers the
port it bound to, and loads that local URL in the system WebView2 — so the desktop
app is the exact same SPA, just in its own native window instead of a browser tab.

This is a **sidecar architecture**, not a rewrite: the frontend (`public/app.html`)
and backend (`server.js`, `supervisor.js`, `manager.js`, …) are reused as-is.

---

## How it works

```
theoffice-desktop.exe  (Rust / Tauri)
        │
        │ spawns:  node server.js   with  PORT=0  SUPERVISOR_SIDECAR=1  SUPERVISOR_HOST=127.0.0.1
        ▼
   Node server  ──►  binds an OS-assigned free port, then prints to stdout:
                     [supervisor] __READY__ {"port":54889,"url":"http://127.0.0.1:54889"}
        │
        ▼
   Rust parses the __READY__ line  ──►  navigates the WebView to http://127.0.0.1:<port>
```

Key contract points (in `../server.js`, added in "Desktop migration Phase 0"):

- **`PORT=0`** — bind any free port (avoids clashing with a browser instance on 3847).
- **`SUPERVISOR_HOST=127.0.0.1`** — pin the sidecar to loopback (the browser/LAN build
  still binds all interfaces by default so the mobile/QR feature keeps working).
- **`__READY__` line** — emitted from the `onListen` callback once the real port is
  known: `[supervisor] __READY__ ` followed by `JSON.stringify({port, url})`. The Rust
  side matches the `__READY__ ` substring and parses the trailing JSON.
- **`SUPERVISOR_SIDECAR=1`** — enables stdin-close handling so the server shuts down
  cleanly when the desktop parent exits.

On window close, `RunEvent::Exit` in `src-tauri/src/main.rs` kills the Node child, so
no orphaned server is left behind.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js** (v18+) | The sidecar. The repo already targets Node; v24 is what dev runs. |
| **Rust toolchain** | `rustup` + `stable-x86_64-pc-windows-msvc`. Verify `cargo --version`. |
| **MSVC build tools** | Visual Studio 2019/2022 with "C++ build tools" (the MSVC linker). |
| **WebView2 runtime** | Pre-installed on Windows 10/11. The renderer. |
| **`@tauri-apps/cli`** | Installed as a devDependency here (`npm install` in `desktop/`). |

---

## Dev commands

Run all commands from `desktop/`.

```powershell
npm install                 # installs @tauri-apps/cli locally

# Run the app against the repo's live server.js (dev fallback path):
npx tauri dev

# Produce an optimized binary + installer (NSIS/WiX downloaded on first run):
npx tauri build

# Just the exe, no installer bundling:
npx tauri build --no-bundle

# Regenerate the icon set from icon-source.png:
node generate-icon.js && npx tauri icon icon-source.png
```

In **dev**, `main.rs` resolves `server.js` from the repo root (two levels up from
`src-tauri/`). For a real distributable it instead reads from bundled resources — see
below. Override the resolution explicitly with env vars:

- `SUPERVISOR_SERVER_JS` — absolute path to `server.js`.
- `SUPERVISOR_NODE` — path to the `node` binary to spawn.

---

## Project layout

```
desktop/
├── package.json            # tauri CLI scripts + devDep
├── generate-icon.js        # no-dep PNG encoder -> icon-source.png (gitignored)
├── dist/
│   └── index.html          # themed loading splash shown until the sidecar is ready
└── src-tauri/
    ├── Cargo.toml          # tauri 2 + serde_json; release profile (lto/strip)
    ├── Cargo.lock          # committed (binary app)
    ├── build.rs            # tauri_build::build()
    ├── tauri.conf.json     # window config, identifier ai.theoffice.desktop, frontendDist ../dist
    ├── capabilities/
    │   └── default.json    # core:default for the main window
    ├── icons/              # generated icon set (npx tauri icon)
    └── src/
        └── main.rs         # spawns sidecar, parses __READY__, navigates window, kills child on exit
```

---

## Download

**[⬇ Latest release](https://github.com/chcosta/TheOffice.AI/releases/latest)** ·
**[TheOffice.AI v1.0.2](https://github.com/chcosta/TheOffice.AI/releases/tag/v1.0.2)** (~215 MB, split into 5 parts — reassembly snippet on the release page)

Per-user NSIS install (no admin). On first launch the installer offers to install
optional prerequisites (Git, Azure CLI, ripgrep) via winget. Copilot CLI sign-in
(`~/.copilot`) is separate.

---

## Distribution (shipped)

The distributable is a **self-contained NSIS installer** — end users need neither
Node nor the repo. `npm run build` (which runs `stage-sidecar.mjs` via its
`prebuild` hook, then `tauri build`) produces:

```
desktop/src-tauri/target/release/bundle/nsis/TheOffice.AI_1.0.2_x64-setup.exe
```

**≈215 MB**, LZMA-compressed from an ~820 MB staged payload.

What's bundled (staged into `src-tauri/resources/`, gitignored, by
`stage-sidecar.mjs`):

1. **The server as Tauri resources** — `server.js` + all root `*.js`, `public/`,
   `builtin-plugins/`, and production `node_modules` (puppeteer-core pruned) are
   copied to `resources/server/`. `main.rs` prefers `<resources>/server/server.js`
   when present (falling back to the repo path only in dev). The vendored Copilot
   CLI/SDK + ripgrep ride along inside `node_modules`.
2. **A portable Node** — `process.execPath` is copied to `resources/node/node.exe`
   so end users don't need Node installed. `main.rs`'s `resolve_node_bin` finds it
   (dual-path: `<res>/node/` or `<res>/resources/node/`). We deliberately do **not**
   `pkg`/SEA the server — it relies on real on-disk `__dirname` files and spawns real
   child processes (Copilot CLI, `board-mcp.js`), which packed binaries break.
3. **Prereq installer** — `scripts/install-prerequisites.ps1` is staged to
   `resources/scripts/` and invoked by the NSIS post-install hook
   (`src-tauri/nsis/hooks.nsh`) to offer a per-user winget install of Git / Azure
   CLI / ripgrep. Non-fatal and skipped in silent mode.

### Rebuilding the installer

```powershell
cd desktop
npm install                 # first time only (installs @tauri-apps/cli)
npm run build               # stage-sidecar (prebuild) + tauri build → NSIS installer
npm run build -- --no-bundle  # just the exe, for fast iteration
```

Notes / gotchas:

- **NSIS toolchain download** — on the first `tauri build`, Tauri downloads its
  NSIS toolchain from github.com (cached at `%LOCALAPPDATA%\tauri\NSIS`). A transient
  DNS failure there aborts only the bundle step; the compiled exe survives, so a
  retry resumes quickly.
- **`time 0.3.51` pin** — held in `Cargo.lock` (a version skew in `time 0.3.52`
  broke `cookie 0.18.1`). Don't bump it casually.
- **Build time** — Rust ~7 min cold / ~2.5 min warm; makensis compression of ~14k
  files is slow (~10+ min).

### Publishing a release

The installer is hosted on **GitHub Releases** on `chcosta/TheOffice.AI`:

```powershell
gh release create v1.0.2 -R chcosta/TheOffice.AI `
  --title "TheOffice.AI v1.0.2 (Windows desktop)" `
  --notes "…" `
  "desktop/src-tauri/target/release/bundle/nsis/TheOffice.AI_1.0.2_x64-setup.exe"
```

Bump the `version` in `package.json` + `tauri.conf.json` and the tag together for
each release. The `releases/latest` link in this README and the root README always
resolves to the newest one.

### Still to come (Phase 3)

- **Per-OS CI + code signing** — Windows Authenticode, macOS notarization.
- **Auto-updater** — Tauri's updater plugin pointing at the Release assets
  (`latest.json` + signed artifacts).

---

## Troubleshooting

- **`time`/`cookie` compile error on first build** — a transient crates.io version
  skew (`time 0.3.52` broke `cookie 0.18.1`). Fixed here by pinning via
  `cargo update -p time --precise 0.3.51` (already reflected in `Cargo.lock`).
- **Window opens but stays on the splash** — the sidecar never printed `__READY__`.
  Run `node ../server.js` directly with `PORT=0 SUPERVISOR_SIDECAR=1` and check stdout.
- **"Another machine is leader / standby"** — harmless: the sidecar shares the same
  data store as any other running server instance and they negotiate a config-sync
  lease. Only one writes config; both serve the UI.
