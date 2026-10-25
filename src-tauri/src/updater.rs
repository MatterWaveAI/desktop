//! Updates: off unless the build says otherwise.
//!
//! tauri.conf.json names no endpoint on purpose. It used to carry a
//! placeholder (`updates.invalid`), and a plugin registered against that did
//! nothing useful while reading as configured. The release job writes the
//! real endpoint and public key (scripts/release-config.mjs) and builds with
//! `MW_DESKTOP_UPDATER=1`, which is what registers the plugin and runs the
//! launch-time check. A build without the flag has no updater at all: no
//! plugin, no request, nothing for the webview to call.

use tauri::{AppHandle, Emitter};

/// Read at build time like MW_DESKTOP_BASE_URL: whether a binary checks for
/// updates is a property of the build, not of the machine it runs on.
const FLAG: Option<&str> = option_env!("MW_DESKTOP_UPDATER");

/// The event the SPA receives when a newer version is published; the
/// payload is that version.
pub const UPDATE_AVAILABLE_EVENT: &str = "update-available";

pub fn enabled() -> bool {
    flag_is_on(FLAG)
}

fn flag_is_on(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("true"))
}

/// One check at launch, in the background. It reports and stops: the SPA is
/// told through `update-available`, and downloading or installing stays a
/// deliberate step rather than something that happens under a person's
/// open conversation. A build with the flag but no endpoint (a dev build)
/// logs that it is not checking and otherwise behaves as if off.
pub fn check_on_launch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("updater: not checking: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let _ = app.emit(UPDATE_AVAILABLE_EVENT, update.version.clone());
            }
            Ok(None) => {}
            Err(e) => eprintln!("updater: check failed: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_off_unless_set_to_1_or_true() {
        assert!(!flag_is_on(None));
        assert!(!flag_is_on(Some("")));
        assert!(!flag_is_on(Some("0")));
        assert!(!flag_is_on(Some("yes")));
        assert!(flag_is_on(Some("1")));
        assert!(flag_is_on(Some("true")));
        assert!(flag_is_on(Some(" 1 ")));
    }
}
