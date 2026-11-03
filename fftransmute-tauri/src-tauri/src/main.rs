use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Manager;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "24590";

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// True when something answers on host:port (the embedded server is healthy
/// enough to reuse). Never kills a running server — reuse beats reaping.
fn server_listening(host: &str, port: &str) -> bool {
    let addr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Best-effort reaper for a previous app run's orphaned uvicorn. Called only
/// when NOTHING answers on the port, so a manually started dev server is safe.
fn reap_leftover_servers(port: &str) {
    let pattern = format!("uvicorn app.main:app .*--port {port}");
    let _ = Command::new("pkill").arg("-f").arg(&pattern).status();
    thread::sleep(Duration::from_millis(300));
}

fn main() {
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_exit = child.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: focus the already-running window instead of
            // starting a second app (and a port race with its server).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .setup(move |_app| {
            let host = env_or("FFM_HOST", DEFAULT_HOST);
            let port = env_or("FFM_PORT", DEFAULT_PORT);

            if !server_listening(&host, &port) {
                reap_leftover_servers(&port);
                let venv_py = env_or(
                    "FFM_VENV_PY",
                    "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project/.venv/bin/python",
                );
                let project_dir = env_or(
                    "FFM_PROJECT_DIR",
                    "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project",
                );
                let mut cmd = Command::new(&venv_py);
                cmd.arg("-m")
                    .arg("uvicorn")
                    .arg("app.main:app")
                    .arg("--host")
                    .arg(&host)
                    .arg("--port")
                    .arg(&port)
                    .arg("--log-level")
                    .arg("warning")
                    .current_dir(&project_dir)
                    // Scrub AppImage's poisoned PYTHONHOME/PYTHONPATH so the venv
                    // python uses its own stdlib, not the AppImage mount.
                    .env_remove("PYTHONHOME")
                    .env("PYTHONPATH", &project_dir)
                    .stdout(std::fs::File::create("/tmp/app_server.log").expect("log"))
                    .stderr(std::fs::File::create("/tmp/app_server.err").expect("err"));
                // Die with the launcher even when it is SIGKILLed or crashes:
                // the kernel delivers SIGTERM to the server once our process
                // vanishes. Closing the app must never leave an orphan.
                unsafe {
                    cmd.pre_exec(|| {
                        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                        // Fork/parent-death race: if the parent already died
                        // before prctl armed, refuse to start at all.
                        if libc::getppid() == 1 {
                            libc::_exit(1);
                        }
                        Ok(())
                    });
                }
                let spawned = cmd.spawn();
                match spawned {
                    Ok(c) => {
                        if let Ok(mut guard) = child.lock() {
                            *guard = Some(c);
                        }
                    }
                    Err(e) => eprintln!("fftransmute: server spawn failed: {e}"),
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_handle, event| {
        // Kill the server we spawned so closing the app never leaves an
        // orphaned uvicorn serving stale code on the next launch. A reused
        // external server is never touched (child stays None).
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            if let Ok(mut guard) = child_for_exit.lock() {
                if let Some(mut c) = guard.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }
    });
}
