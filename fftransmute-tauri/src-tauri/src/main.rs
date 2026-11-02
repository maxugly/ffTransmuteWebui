use std::process::{Command, Child, Stdio};
use std::sync::{Arc, Mutex};

fn main() {
    let child = Arc::new(Mutex::new(None::<Child>));
    let child_clone = child.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let venv_py = "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project/.venv/bin/python";
            let project_dir = "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project";
            if let Ok(mut c) = child_clone.lock() {
                *c = Some(Command::new(venv_py)
                    .arg("-m")
                    .arg("uvicorn")
                    .arg("app.main:app")
                    .arg("--host").arg("127.0.0.1")
                    .arg("--port").arg("24590")
                    .arg("--log-level").arg("warning")
                    .current_dir(project_dir)
                    // Scrub AppImage's poisoned PYTHONHOME/PYTHONPATH so the venv
                    // python uses its own stdlib, not the AppImage mount.
                    .env_remove("PYTHONHOME")
                    .env("PYTHONPATH", project_dir)
                    .stdout(std::fs::File::create("/tmp/app_server.log").expect("log"))
                    .stderr(std::fs::File::create("/tmp/app_server.err").expect("err"))
                    .spawn().expect("server spawn"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! ffTransmute embedded server running.", name)
}
