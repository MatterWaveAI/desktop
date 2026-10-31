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
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
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
