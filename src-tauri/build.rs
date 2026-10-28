fn main() {
    // The API base is baked in at build time so an installer built for one
    // environment cannot be pointed at another by an env var on the desktop.
    println!("cargo:rerun-if-env-changed=MW_DESKTOP_BASE_URL");
    // Declaring the commands makes Tauri generate an `allow-<command>`
    // permission for each, so the capability file is the allow-list: a
    // command not named there cannot be invoked from the webview.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_access_token",
            "sign_in",
            "sign_out",
            "open_external",
            "app_info",
            "check_for_updates",
            "notify_generation_complete",
            "install_update",
            "pending_update",
            "set_api_key",
            "clear_api_key",
            "api_key_state",
        ]),
    ))
    .expect("tauri build script failed")
}
