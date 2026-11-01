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
