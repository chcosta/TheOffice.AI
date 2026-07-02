// Prevent an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

/// Node executable to run the sidecar with.
///
/// Order:
/// 1. `SUPERVISOR_NODE` env override.
/// 2. Bundled resource at `<resources>/node/node(.exe)` (packaged builds).
/// 3. `node` on PATH (dev fallback).
fn resolve_node_bin(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("SUPERVISOR_NODE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
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
/// 2. Bundled resource at `<resources>/server/server.js` (packaged builds).
/// 3. Dev fallback: repo root two levels up from this crate.
fn resolve_server_js(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("SUPERVISOR_SERVER_JS") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
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
            eprintln!(
                "[desktop] sidecar exited after {:?} — restarting in {}ms (crash #{})",
                uptime, delay_ms, consecutive_fast
            );
            // If it's crash-looping (dying almost instantly many times in a row),
            // pause longer so we don't spin the CPU or hammer the machine.
            if consecutive_fast >= 10 {
                eprintln!("[desktop] sidecar crash-looping — backing off 30s");
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
    println!("[desktop] sidecar: {} {}", node_bin.display(), server_js.display());

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
            eprintln!("[desktop] failed to spawn node sidecar: {e}");
            return;
        }
    };

    // Record the pid so the exit handler can force-kill the whole tree.
    if let Ok(mut guard) = state.pid.lock() {
        *guard = Some(child.id());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let err_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[sidecar:err] {line}");
            }
        }
    });

    let out_app = handle.clone();
    let out_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            const TOKEN: &str = "__READY__ ";
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                println!("[sidecar] {line}");
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

    // Block until the sidecar exits, then let the reader threads drain.
    let _ = child.wait();
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

fn main() {
    let state = Arc::new(SidecarState {
        pid: Mutex::new(None),
        shutting_down: AtomicBool::new(false),
    });
    let setup_state = state.clone();
    let exit_state = state.clone();
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![restart_sidecar])
        .setup(move |app| {
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
