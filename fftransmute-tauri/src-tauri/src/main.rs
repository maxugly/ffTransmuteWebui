fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use std::process::{Command, Stdio};
            let venv_py = "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project/.venv/bin/python";
            let app_dir = "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project/app";
            let _child = Command::new(venv_py)
                .args(["-m","uvicorn","main:app","--host","127.0.0.1","--port","24590","--log-level","warning"])
                .current_dir(app_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
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
