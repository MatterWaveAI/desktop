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

/// The installers a release ships and nothing else: an rpm nobody installs
/// and the updater feed has no entry for is not built.
#[test]
fn the_bundle_targets_are_the_released_installers() {
    let config = config();
    let targets: Vec<&str> = config["bundle"]["targets"]
        .as_array()
        .expect("an explicit target list, not \"all\"")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(targets, ["msi", "nsis", "app", "dmg", "appimage", "deb"]);
}

/// The CSP allows the one inline script in `web/index.html` -- the theme
/// boot script, inlined so the first paint is in the right palette -- by
/// its hash. Edit the script and the hash must follow, or the page loads
/// without it and flashes.
#[test]
fn the_csp_allows_the_inline_theme_script_by_its_hash() {
    use base64::Engine;
    use sha2::Digest;
    let html = read("../web/index.html");
    let inline: Vec<&str> = html
        .split("<script>")
        .skip(1)
        .filter_map(|rest| rest.split("</script>").next())
        .collect();
    assert_eq!(inline.len(), 1, "one inline script");
    let hash = base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(inline[0]));
    let csp = config()["app"]["security"]["csp"]
        .as_str()
        .expect("a CSP")
        .to_string();
    assert!(
        csp.contains(&format!("'sha256-{hash}'")),
        "script-src should allow 'sha256-{hash}': {csp}"
    );
}

/// Ctrl (Cmd on macOS) with +, - and 0 zoom the page. On macOS and Linux
/// Tauri does it with a script that calls the webview's zoom command, which
/// the capability has to allow or every press is refused.
#[test]
fn the_window_zooms_on_the_standard_shortcuts() {
    assert_eq!(
        main_window(&config())["zoomHotkeysEnabled"],
        Value::Bool(true)
    );
    let capability: Value =
        serde_json::from_str(&read("capabilities/default.json")).expect("the capability parses");
    assert!(capability["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .any(|p| p == "core:webview:allow-set-webview-zoom"));
}
