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

## Distribution (not yet wired)

The current build runs the **dev fallback**: it spawns the system `node` against the
repo's `server.js`. A shippable installer still needs:

1. **Bundle the server as Tauri resources** — add `server.js` + its runtime deps
   (`supervisor.js`, `manager.js`, `public/`, `node_modules`, …) to
   `tauri.conf.json > bundle.resources`. `main.rs` already prefers
   `<resources>/server/server.js` when present.
2. **Ship a portable Node** — bundle a `node.exe` as a resource (or use a Node
   single-executable) and point `SUPERVISOR_NODE` at it, so end users don't need
   Node installed. (We deliberately do **not** use `pkg`/SEA for the server itself:
   it relies on real on-disk `__dirname` files and spawns real child processes —
   the Copilot CLI and `board-mcp.js` — which packed binaries break.)
3. **Per-OS CI + code signing** — Windows Authenticode, macOS notarization.
4. **Auto-updater** — Tauri's updater plugin.

These are Phase 2/3 follow-ups; the current scaffold proves the sidecar/`__READY__`
handshake and the native window end-to-end.

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
