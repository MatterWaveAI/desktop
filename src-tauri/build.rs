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
            "send_test_notification",
            "install_update",
            "pending_update",
            "set_api_key",
            "clear_api_key",
            "api_key_state",
            "pair_device",
            "device_pairing_state",
            "unpair_device",
            "global_shortcut_state",
            "set_global_shortcut",
            "take_navigation",
            "autostart_state",
            "set_autostart",
            "set_recent_conversations",
            // Agent mode's tool host (src/agent): one command per tool, the
            // run's start and stop, the root, the switch and the
            // checkpoints. Off until the person turns it on.
            "agent_state",
            "agent_set_enabled",
            "agent_pick_root",
            "agent_trust_root",
            "agent_start_run",
            "agent_stop_run",
            "agent_read_file",
            "agent_list_dir",
            "agent_glob",
            "agent_grep",
            "agent_edit",
            "agent_write_file",
            "agent_run_shell",
            "agent_checkpoints",
            "agent_restore",
        ]),
    ))
    .expect("tauri build script failed");
    // Windows test targets need an application manifest: tauri code the
    // updater test links imports `TaskDialogIndirect` from comctl32, a
    // Common-Controls v6 export, and a test binary with no manifest gets
    // comctl32 v5, which lacks it -- it fails to load with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). The built app carries its
    // manifest in the resource tauri-build compiles for bins; the test
    // binaries get the same treatment here, scoped to `cargo test` only.
    // RT_MANIFEST id 1 replaces rustc's default manifest, exactly as the
    // linked resource replaces it for the app binary.
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        // Read when the script runs, not baked in when it was compiled: a
        // build script binary is reused when the checkout moves.
        let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let manifest = std::path::Path::new(&dir)
            .join("tests/windows.manifest")
            .display()
            .to_string()
            .replace('\\', "/");
        let rc = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
            .join("tests-manifest.rc");
        std::fs::write(&rc, format!("1 24 \"{manifest}\"\n")).expect("write tests-manifest.rc");
        // A failed resource compile (no rc.exe, a bad manifest) is a real
        // failure: the test binaries would not load without it.
        match embed_resource::compile_for_tests(&rc, embed_resource::NONE) {
            embed_resource::CompilationResult::Ok => {}
            other => panic!("compiling the tests' Windows manifest: {other:?}"),
        }
        println!("cargo:rerun-if-changed=tests/windows.manifest");
    }
}
