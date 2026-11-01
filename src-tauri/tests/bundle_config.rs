//! The committed `tauri.conf.json`, read the way the bundler reads it: the
//! settings whose absence breaks a feature without breaking a build.

use serde_json::Value;

fn config() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses")
}

fn main_window(config: &Value) -> &Value {
    config["app"]["windows"]
        .as_array()
        .and_then(|windows| windows.iter().find(|w| w["label"] == "main"))
        .expect("a window labelled main")
}

/// Tauri takes the OS file drop by default and the page never sees it; the
/// SPA's own drop targets (the composer's attachments, Settings -> Data's
/// import) need the webview to receive the drop as HTML5 drag events.
#[test]
fn the_window_leaves_file_drops_to_the_page() {
    assert_eq!(
        main_window(&config())["dragDropEnabled"],
        Value::Bool(false)
    );
}

fn read(path: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The value after `<key>name</key>` in a plist, as written: `<true/>`, or a
/// `<string>`'s text.
fn plist_value(plist: &str, key: &str) -> Option<String> {
    let after = plist
        .split(&format!("<key>{key}</key>"))
        .nth(1)?
        .trim_start();
    if after.starts_with("<true/>") {
        return Some("true".into());
    }
    let text = after.strip_prefix("<string>")?;
    Some(text[..text.find("</string>")?].to_string())
}

/// WKWebView refuses `getUserMedia` in an app whose bundle does not say why
/// it wants the microphone, and a hardened-runtime app without the
/// audio-input entitlement never gets as far as asking: dictation needs
/// both. Tauri merges `Info.plist` beside the config into the bundle's.
#[test]
fn the_macos_bundle_may_ask_for_the_microphone() {
    let why = plist_value(&read("Info.plist"), "NSMicrophoneUsageDescription")
        .expect("Info.plist says why the app wants the microphone");
    assert!(why.len() > 20, "{why}");

    let mac = &config()["bundle"]["macOS"];
    assert_eq!(mac["hardenedRuntime"], Value::Bool(true));
    let entitlements = mac["entitlements"].as_str().expect("an entitlements file");
    assert_eq!(
        plist_value(&read(entitlements), "com.apple.security.device.audio-input").as_deref(),
        Some("true")
    );
}
