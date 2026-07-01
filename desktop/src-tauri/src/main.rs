// Prevent an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

/// Holds the spawned Node sidecar so we can terminate it on app exit.
struct SidecarState(Mutex<Option<Child>>);

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

/// Spawn the Node server as a sidecar, stream its output, and navigate the main
/// window to the localhost URL it reports via the `__READY__` line.
fn start_sidecar(app: &tauri::AppHandle) {
    let handle = app.clone();
    let server_js = resolve_server_js(&handle);
    let server_dir = server_js.parent().map(|p| p.to_path_buf());
    let node_bin = resolve_node_bin(&handle);
    let node_dir = node_bin.parent().map(|p| p.to_path_buf());
    println!("[desktop] sidecar: {} {}", node_bin.display(), server_js.display());

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&server_js)
        .env("PORT", "0")
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

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[desktop] failed to spawn node sidecar: {e}");
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Keep the child so we can kill it on exit.
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[sidecar:err] {line}");
            }
        });
    }

    if let Some(stdout) = stdout {
        let h = handle.clone();
        std::thread::spawn(move || {
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
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(win) = h2.get_webview_window("main") {
                        if let Ok(u) = tauri::Url::parse(&url) {
                            let _ = win.navigate(u);
                        }
                    }
                });
            }
        });
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            start_sidecar(&app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TheOffice.AI desktop app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
