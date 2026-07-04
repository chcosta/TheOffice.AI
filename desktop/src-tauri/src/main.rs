// Prevent an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;

/// On exit, if the in-app updater staged a downloaded installer, launch it
/// detached with `/UPDATE /P /R` (in-place upgrade, passive, relaunch) so the
/// upgrade applies seamlessly after the app closes. The marker is written by
/// `updater.js` at `%LOCALAPPDATA%\TheOffice.AI\pending-update.json`.
fn run_pending_update() {
    let base = match std::env::var("LOCALAPPDATA") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => return,
    };
    let marker = base.join("TheOffice.AI").join("pending-update.json");
    let raw = match std::fs::read_to_string(&marker) {
        Ok(s) => s,
        Err(_) => return,
    };
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            let _ = std::fs::remove_file(&marker);
            return;
        }
    };
    let installer = json.get("installer").and_then(|v| v.as_str()).unwrap_or("");
    if installer.is_empty() || !std::path::Path::new(installer).exists() {
        let _ = std::fs::remove_file(&marker);
        return;
    }
    let args: Vec<String> = json
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["/UPDATE".into(), "/P".into(), "/R".into()]);

    // Consume the marker before launching so a failed spawn can't loop.
    let _ = std::fs::remove_file(&marker);

    let mut cmd = Command::new(installer);
    cmd.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = cmd.spawn();
}

/// Directory where the desktop shell writes its rolling log
/// (`%LOCALAPPDATA%\TheOffice.AI\logs`). This is the single place we point users
/// to when the service crashes — see the recovery screen in `dist/index.html`.
fn log_base() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|v| PathBuf::from(v).join("TheOffice.AI").join("logs"))
}

fn desktop_log_path() -> Option<PathBuf> {
    log_base().map(|d| d.join("desktop.log"))
}

/// UTC timestamp `YYYY-MM-DD HH:MM:SS.mmmZ` computed without a date crate
/// (civil-from-days, per Howard Hinnant). Keeps the dependency footprint tiny.
fn now_stamp() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Append one timestamped line to the desktop log, rotating once it passes ~2 MB
/// (one backup kept as `desktop.log.1`). Also echoes to stderr so `tauri dev`
/// still shows it. Best effort — logging must never crash the shell.
fn log_line(msg: &str) {
    eprintln!("{msg}");
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock();
    let Some(path) = desktop_log_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2_000_000 {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", now_stamp(), msg);
    }
}

/// Navigate the main WebView window to `url` on the UI thread.
fn navigate_main(app: &tauri::AppHandle, url: String) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = h.get_webview_window("main") {
            if let Ok(u) = tauri::Url::parse(&url) {
                let _ = win.navigate(u);
            }
        }
    });
}

/// Shared sidecar supervision state.
///
/// - `pid`: the OS process id of the *current* Node sidecar, so the exit handler
///   can force-terminate its whole tree without holding the `Child` (the monitor
///   thread owns the `Child` and blocks on `wait()`).
/// - `shutting_down`: set true right before we intentionally kill the sidecar on
///   app exit, so the monitor thread can tell a deliberate teardown from a crash
///   and NOT respawn.
struct SidecarState {
    pid: Mutex<Option<u32>>,
    shutting_down: AtomicBool,
    /// URL of the bundled splash/recovery page captured at startup, so we can
    /// navigate back to it (instead of a raw ERR_CONNECTION_REFUSED) whenever the
    /// sidecar is down and we're respawning it.
    splash_url: Mutex<Option<String>>,
    /// Count of unexpected sidecar exits this session (shown in diagnostics).
    crash_count: AtomicU32,
    /// Human-readable summary of the most recent unexpected exit.
    last_reason: Mutex<String>,
}

/// Strip a Windows extended-length (`\\?\`) prefix from a path.
///
/// Tauri's `resource_dir()` can return verbatim paths like
/// `\\?\C:\Users\…\server.js`. Handing that to Node as the entry script makes
/// its module resolver fail with `EISDIR: illegal operation on a directory,
/// lstat 'C:'` — so the sidecar exits instantly and the splash hangs forever.
/// Normalizing back to a plain path (`C:\Users\…`) fixes the spawn. Idempotent
/// for already-clean paths.
fn de_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

// ─── Per-user runtime provisioning ──────────────────────────────────────────
// The Node runtime and the vendored server (which carries the Copilot CLI/SDK
// in node_modules) are bundled as Tauri `resources`, so the NSIS installer
// re-extracts them into $INSTDIR on EVERY upgrade — needlessly "reinstalling"
// Node/Copilot, and, worse, overwriting the very `node.exe` the running sidecar
// has open (Windows locks it → "Error opening file for writing" → the upgrade
// stalls). To break that, on the first launch of each app version we copy the
// bundled `node\` and `server\` trees into a stable per-user location
// (`%LOCALAPPDATA%\TheOffice.AI\runtime\<version>`) and run the sidecar from
// THERE. The live `node.exe` then lives outside $INSTDIR, so an upgrade never
// touches a locked file, and the copy happens once per version rather than
// every launch. If provisioning can't run (dev build, no LOCALAPPDATA, disk
// error) we fall back to the bundled resources exactly as before.
static RUNTIME_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Base dir for per-user runtimes: `%LOCALAPPDATA%\TheOffice.AI\runtime`.
fn runtime_base() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|v| PathBuf::from(v).join("TheOffice.AI").join("runtime"))
}

/// Recursively copy `src` → `dst`. Symlinks are dereferenced (copied as files)
/// so a symlinked entry in node_modules can't break the copy on a non-elevated
/// user account.
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Best-effort removal of runtime dirs for other (older) versions.
fn cleanup_old_runtimes(base: &std::path::Path, keep: &str) {
    if let Ok(rd) = std::fs::read_dir(base) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy() != keep && e.path().is_dir() {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

/// Ensure the per-user runtime for the current version exists, copying the
/// bundled `node\`/`server\` into it on first launch. Returns the runtime dir
/// (containing `node\` and `server\`), or `None` to signal "use bundled
/// resources". Runs at most once per process (cached in `RUNTIME_DIR`).
fn provision_runtime(app: &tauri::AppHandle) -> Option<PathBuf> {
    RUNTIME_DIR
        .get_or_init(|| {
            let r = provision_runtime_inner(app);
            match &r {
                Some(d) => log_line(&format!("[desktop] runtime ready at {}", d.display())),
                None => log_line("[desktop] runtime provisioning skipped — using bundled resources"),
            }
            r
        })
        .clone()
}

/// Read the cached runtime dir WITHOUT triggering provisioning (so the exit
/// path never kicks off a copy). `None` until `provision_runtime` has run.
fn runtime_dir() -> Option<PathBuf> {
    RUNTIME_DIR.get().and_then(|o| o.clone())
}

fn provision_runtime_inner(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = runtime_base()?;
    let version = app.package_info().version.to_string();
    let dir = base.join(&version);
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let node_bin = dir.join("node").join(exe);
    let server_js = dir.join("server").join("server.js");
    let marker = dir.join(".provisioned");

    // Already provisioned for this version — nothing to copy.
    if marker.exists() && node_bin.exists() && server_js.exists() {
        cleanup_old_runtimes(&base, &version);
        return Some(dir);
    }

    // Locate the bundled sources. Absent in a dev build → fall back to bundled.
    let res = de_verbatim(app.path().resource_dir().ok()?);
    let src_node = [res.join("node"), res.join("resources").join("node")]
        .into_iter()
        .find(|p| p.join(exe).exists())?;
    let src_server = [res.join("server"), res.join("resources").join("server")]
        .into_iter()
        .find(|p| p.join("server.js").exists())?;

    // Fresh (re)provision: clear any partial remains, then copy both trees.
    let _ = std::fs::remove_file(&marker);
    let _ = std::fs::remove_dir_all(dir.join("node"));
    let _ = std::fs::remove_dir_all(dir.join("server"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log_line(&format!("[desktop] runtime: create {} failed: {e}", dir.display()));
        return None;
    }
    log_line(&format!(
        "[desktop] provisioning runtime v{version} (first launch of this build)…"
    ));
    if let Err(e) = copy_dir_all(&src_node, &dir.join("node")) {
        log_line(&format!("[desktop] runtime: copy node failed: {e}"));
        return None;
    }
    if let Err(e) = copy_dir_all(&src_server, &dir.join("server")) {
        log_line(&format!("[desktop] runtime: copy server failed: {e}"));
        return None;
    }
    if !node_bin.exists() || !server_js.exists() {
        log_line("[desktop] runtime: copy finished but expected files are missing");
        return None;
    }
    let _ = std::fs::write(&marker, version.as_bytes());
    cleanup_old_runtimes(&base, &version);
    Some(dir)
}

/// Node executable to run the sidecar with.
///
/// Order:
/// 1. `SUPERVISOR_NODE` env override.
/// 2. Per-user runtime copy at `<runtime>/node/node(.exe)` (packaged builds,
///    after provisioning) — kept OUT of the install dir so upgrades never lock it.
/// 3. Bundled resource at `<resources>/node/node(.exe)` (fallback).
/// 4. `node` on PATH (dev fallback).
fn resolve_node_bin(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("SUPERVISOR_NODE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(rt) = runtime_dir() {
        let cand = rt.join("node").join(exe);
        if cand.exists() {
            return cand;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("node").join(exe),
            res.join("resources").join("node").join(exe),
        ] {
            if cand.exists() {
                return cand;
            }
        }
    }
    PathBuf::from("node")
}

/// Resolve the path to the Node server entrypoint.
///
/// Order:
/// 1. `SUPERVISOR_SERVER_JS` env override.
/// 2. Per-user runtime copy at `<runtime>/server/server.js` (packaged builds,
///    after provisioning).
/// 3. Bundled resource at `<resources>/server/server.js` (fallback).
/// 4. Dev fallback: repo root two levels up from this crate.
fn resolve_server_js(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("SUPERVISOR_SERVER_JS") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    if let Some(rt) = runtime_dir() {
        let cand = rt.join("server").join("server.js");
        if cand.exists() {
            return cand;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("server").join("server.js"),
            res.join("resources").join("server").join("server.js"),
        ] {
            if cand.exists() {
                return cand;
            }
        }
    }
    let mut pb = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    pb.pop(); // desktop/
    pb.pop(); // repo root
    pb.join("server.js")
}

/// Start the Node sidecar under a **supervisor thread** that respawns it if it
/// crashes. Each spawn streams the child's output and navigates the main window
/// to the localhost URL reported via the `__READY__` line. If the child exits
/// unexpectedly (not during app shutdown) the supervisor waits a backoff delay
/// and spawns a fresh one; because the port is stable (3848) the WebView's
/// `EventSource` reconnects on its own — and we also re-navigate as a belt-and-
/// suspenders reload.
fn start_sidecar(app: &tauri::AppHandle, state: Arc<SidecarState>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // Provision the per-user runtime BEFORE the first spawn so the sidecar
        // launches node/copilot from %LOCALAPPDATA%\TheOffice.AI\runtime rather
        // than the versioned install dir. This keeps $INSTDIR\node.exe unlocked,
        // so an in-place upgrade never stalls on a locked file, and Node/Copilot
        // are copied once per version instead of re-extracted every launch.
        let _ = provision_runtime(&handle);

        // Backoff between crash-restarts: start small, double up to a cap, and
        // reset once a spawn has stayed up long enough to be considered healthy.
        let mut delay_ms: u64 = 500;
        let mut consecutive_fast: u32 = 0;

        loop {
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let started = Instant::now();
            spawn_sidecar_once(&handle, &state);
            // spawn_sidecar_once blocks until the child exits (or returns
            // immediately if it couldn't be spawned).
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            let uptime = started.elapsed();
            if uptime >= Duration::from_secs(30) {
                // Healthy run — reset backoff.
                delay_ms = 500;
                consecutive_fast = 0;
            } else {
                consecutive_fast += 1;
                delay_ms = (delay_ms.saturating_mul(2)).min(10_000);
            }
            let total = state.crash_count.fetch_add(1, Ordering::SeqCst) + 1;
            let reason = format!("service stopped after {:.1}s", uptime.as_secs_f64());
            if let Ok(mut g) = state.last_reason.lock() {
                *g = reason.clone();
            }
            log_line(&format!(
                "[desktop] {reason} — restarting in {delay_ms}ms (exit #{total}, fast-streak {consecutive_fast})"
            ));
            // Show the friendly recovery screen instead of leaving the WebView on a
            // raw ERR_CONNECTION_REFUSED while we respawn. On the next __READY__ the
            // stdout reader thread navigates back to the live app automatically.
            if let Some(base) = state.splash_url.lock().ok().and_then(|g| g.clone()) {
                let sep = if base.contains('?') { '&' } else { '?' };
                navigate_main(&handle, format!("{base}{sep}state=recovering&crashes={total}"));
            }
            // If it's crash-looping (dying almost instantly many times in a row),
            // pause longer so we don't spin the CPU or hammer the machine.
            if consecutive_fast >= 10 {
                log_line("[desktop] sidecar crash-looping — backing off 30s");
                std::thread::sleep(Duration::from_secs(30));
                consecutive_fast = 0;
                delay_ms = 500;
            } else {
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    });
}

/// Spawn ONE Node sidecar, record its pid, stream stdout/stderr, navigate on
/// `__READY__`, and block until it exits. Returns when the child has exited (or
/// immediately if spawning failed).
fn spawn_sidecar_once(app: &tauri::AppHandle, state: &Arc<SidecarState>) {
    let handle = app.clone();
    let server_js = de_verbatim(resolve_server_js(&handle));
    let server_dir = server_js.parent().map(|p| p.to_path_buf());
    let node_bin = de_verbatim(resolve_node_bin(&handle));
    let node_dir = node_bin.parent().map(|p| p.to_path_buf());
    log_line(&format!("[desktop] sidecar: {} {}", node_bin.display(), server_js.display()));

    // Bind a STABLE port (not an ephemeral one) so the WebView origin stays
    // constant across restarts and upgrades. localStorage is partitioned by
    // origin (scheme+host+PORT), so a random port every launch would silently
    // drop all localStorage-backed preferences — theme, icon set, experience
    // level, basic features — which is exactly the "settings reset on upgrade"
    // bug. 3848 sits next to the browser-dev default (3847) to avoid colliding
    // with a developer's `npm start`. If it's busy, server.js retries briefly
    // then falls back to an ephemeral port so the window still opens.
    let mut cmd = Command::new(&node_bin);
    cmd.arg(&server_js)
        .env("PORT", "3848")
        .env("SUPERVISOR_SIDECAR", "1")
        .env("SUPERVISOR_HOST", "127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &server_dir {
        cmd.current_dir(dir);
    }
    // Put the bundled node dir on PATH so `command: "node"` MCP servers resolve.
    if let Some(ndir) = &node_dir {
        let prev = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(windows) { ";" } else { ":" };
        cmd.env("PATH", format!("{}{}{}", ndir.display(), sep, prev));
    }

    // Run the Node sidecar hidden — node.exe is a console-subsystem binary, so
    // spawning it from this GUI app would otherwise pop a visible cmd/console
    // window that the user could accidentally close (killing the service). The
    // process still runs in the user's own session with their credentials; we
    // just suppress its console. stdout/stderr stay piped for the __READY__
    // handshake and logging.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log_line(&format!("[desktop] failed to spawn node sidecar: {e}"));
            return;
        }
    };

    // Record the pid so the exit handler can force-kill the whole tree.
    if let Ok(mut guard) = state.pid.lock() {
        *guard = Some(child.id());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Keep the child's stdin write handle alive for the process lifetime. Do NOT
    // call `child.wait()` — Rust's std closes stdin before waiting (deadlock
    // avoidance), and an older server build treated that close as "parent gone"
    // and shut the sidecar down seconds after startup. Holding this handle +
    // polling with try_wait() below guarantees stdin stays open the whole time.
    let _child_stdin = child.stdin.take();

    let err_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&format!("[sidecar:err] {line}"));
            }
        }
    });

    let out_app = handle.clone();
    let out_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            const TOKEN: &str = "__READY__ ";
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&format!("[sidecar] {line}"));
                let Some(pos) = line.find(TOKEN) else { continue };
                let json = &line[pos + TOKEN.len()..];
                let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
                    continue;
                };
                let Some(url) = v.get("url").and_then(|x| x.as_str()) else {
                    continue;
                };
                let url = url.to_string();
                let h2 = out_app.clone();
                let _ = out_app.run_on_main_thread(move || {
                    if let Some(win) = h2.get_webview_window("main") {
                        if let Ok(u) = tauri::Url::parse(&url) {
                            let _ = win.navigate(u);
                        }
                    }
                });
            }
        }
    });

    // Block until the sidecar exits, then let the reader threads drain. We poll
    // with try_wait() instead of the blocking wait() specifically so we never
    // close the child's stdin handle (wait() would) — `_child_stdin` above is
    // held open for the whole run. When the child exits, drop stdin and return.
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
            Err(_) => break,
        }
    }
    drop(_child_stdin);
    // Clear the recorded pid; a new spawn will set it again.
    if let Ok(mut guard) = state.pid.lock() {
        *guard = None;
    }
    let _ = out_handle.join();
    let _ = err_handle.join();
}

/// Windows-only: force-terminate a process tree by PID. `/T` also kills
/// grandchildren (MCP / Copilot `node.exe` the sidecar spawned via PATH), which
/// hold the bundled `node.exe` open and would otherwise fail an in-place upgrade
/// with "Error opening file for writing: ...\node\node.exe".
#[cfg(windows)]
fn taskkill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Windows-only: kill any lingering `node.exe` whose image lives under `dir`
/// (e.g. an orphaned grandchild). Path-filtered so unrelated Node processes on the
/// machine — including the user's own dev servers — are never touched.
#[cfg(windows)]
fn kill_node_under(dir: &std::path::Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let d = dir.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.ExecutablePath -and $_.ExecutablePath.StartsWith('{d}', [System.StringComparison]::OrdinalIgnoreCase) }} | \
         ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Stop the Node sidecar (and its whole process tree), then block until the
/// bundled `node.exe` is no longer locked so a staged installer can overwrite it.
/// A running Windows image is opened by the loader WITHOUT `FILE_SHARE_WRITE`, so
/// probing it with an open-for-write reliably tells us when every process that was
/// executing it has exited. This is the primary fix for upgrade failures like
/// "Error opening file for writing: ...\node\node.exe".
fn stop_sidecar_and_wait(state: &Arc<SidecarState>, node_bin: &std::path::Path) {
    // Signal the supervisor thread that this teardown is intentional so it does
    // NOT respawn the sidecar after we kill it.
    state.shutting_down.store(true, Ordering::SeqCst);

    // 1. Terminate the tracked sidecar and its whole tree by pid.
    let pid = state.pid.lock().ok().and_then(|g| *g);
    if let Some(pid) = pid {
        #[cfg(windows)]
        taskkill_tree(pid);
        #[cfg(not(windows))]
        {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        }
    }

    // 2. Clean up any stray node.exe still running from the bundled node dir.
    let node_dir = node_bin.parent().map(|p| p.to_path_buf());
    #[cfg(windows)]
    if let Some(dir) = &node_dir {
        kill_node_under(dir);
    }
    #[cfg(not(windows))]
    let _ = &node_dir;

    // 3. Wait (up to ~8s) for the image-file lock to release before the installer runs.
    if node_bin.exists() {
        use std::fs::OpenOptions;
        for _ in 0..40 {
            if OpenOptions::new().write(true).open(node_bin).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

/// Manually restart the Node sidecar.
///
/// Invoked from the SPA (via `window.__TAURI__`) when the realtime connection is
/// stuck "reconnecting" — typically because the sidecar is alive but wedged
/// (unresponsive), a case the crash-only supervisor does NOT cover since it
/// blocks on `child.wait()`. Killing the tracked pid tree makes that `wait()`
/// return, and because `shutting_down` stays false the supervisor thread
/// respawns a fresh sidecar automatically.
#[tauri::command]
fn restart_sidecar(state: tauri::State<'_, Arc<SidecarState>>) -> Result<(), String> {
    let pid = state.pid.lock().ok().and_then(|g| *g);
    match pid {
        Some(pid) => {
            log_line(&format!("[desktop] manual service restart requested (pid {pid})"));
            #[cfg(windows)]
            taskkill_tree(pid);
            #[cfg(not(windows))]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            }
            Ok(())
        }
        None => Err("Service is not currently running; it should relaunch automatically.".into()),
    }
}

/// Open the desktop log folder in the OS file manager. Invoked from the recovery
/// screen and the in-app "View logs" affordance.
#[tauri::command]
fn open_logs_dir() -> Result<(), String> {
    let dir = log_base().ok_or_else(|| "Log directory is unavailable.".to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // explorer.exe returns a non-zero exit code even on success, so spawn
        // and ignore rather than checking status.
        Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(&dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return diagnostics for the recovery screen and its "Copy details" button.
#[tauri::command]
fn get_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SidecarState>>,
) -> serde_json::Value {
    let pid = state.pid.lock().ok().and_then(|g| *g);
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "port": 3848,
        "logPath": desktop_log_path().map(|p| p.display().to_string()).unwrap_or_default(),
        "logDir": log_base().map(|p| p.display().to_string()).unwrap_or_default(),
        "serverJs": de_verbatim(resolve_server_js(&app)).display().to_string(),
        "nodeBin": de_verbatim(resolve_node_bin(&app)).display().to_string(),
        "crashCount": state.crash_count.load(Ordering::SeqCst),
        "lastReason": state.last_reason.lock().ok().map(|g| g.clone()).unwrap_or_default(),
        "sidecarPid": pid,
        "running": pid.is_some(),
    })
}

/// Return the last `lines` (default 200) of the desktop log for inline display.
#[tauri::command]
fn read_log_tail(lines: Option<usize>) -> Result<String, String> {
    let path = desktop_log_path().ok_or_else(|| "Log path is unavailable.".to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let n = lines.unwrap_or(200);
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(n);
    Ok(all[start..].join("\n"))
}

fn main() {
    let state = Arc::new(SidecarState {
        pid: Mutex::new(None),
        shutting_down: AtomicBool::new(false),
        splash_url: Mutex::new(None),
        crash_count: AtomicU32::new(0),
        last_reason: Mutex::new(String::new()),
    });
    let setup_state = state.clone();
    let exit_state = state.clone();
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            restart_sidecar,
            open_logs_dir,
            get_diagnostics,
            read_log_tail
        ])
        .setup(move |app| {
            log_line("[desktop] --- session start ---");
            // Capture the bundled splash/recovery page URL so the supervisor can
            // navigate back to it whenever the sidecar is down.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(u) = win.url() {
                    if let Ok(mut g) = setup_state.splash_url.lock() {
                        *g = Some(u.to_string());
                    }
                }
            }
            start_sidecar(&app.handle().clone(), setup_state.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TheOffice.AI desktop app")
        .run(move |app, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop the sidecar tree and wait for the bundled node.exe lock to
                // release, THEN apply a staged update — otherwise the installer
                // races the still-running sidecar and fails to overwrite node.exe.
                let node_bin = resolve_node_bin(app);
                stop_sidecar_and_wait(&exit_state, &node_bin);
                run_pending_update();
            }
        });
}
