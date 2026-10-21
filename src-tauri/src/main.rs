#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secure_store;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            secure_store::omemo_key_get,
            secure_store::omemo_key_set
        ])
        .run(tauri::generate_context!())
        .expect("failed to run gtk-llm-chat");
}
