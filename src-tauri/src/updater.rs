//! Updates: off unless the build says otherwise.
//!
//! tauri.conf.json names no endpoint on purpose. It used to carry a
//! placeholder (`updates.invalid`), and a plugin registered against that did
//! nothing useful while reading as configured. The release job writes the
//! real endpoint and public key (scripts/release-config.mjs) and builds with
//! `MW_DESKTOP_UPDATER=1`, which is what registers the plugin and runs the
//! launch-time check. A build without the flag has no updater at all: no
//! plugin, no request, and the SPA's check command fails.

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

/// One check, shared by the launch path and the SPA's `check_for_updates`
/// command. It reports and stops: a newer version is announced to the SPA as
/// `update-available` with the version string and returned to the caller, and
/// downloading or installing stays a deliberate step rather than something
/// that happens under a person's open conversation. With the flag on but no
/// endpoint (a dev build) there is no plugin to ask, which surfaces as the
/// returned error.
pub async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("not checking: {e}"))?;
    let Some(update) = updater.check().await.map_err(|e| format!("check failed: {e}"))? else {
        return Ok(None);
    };
    let version = update.version.clone();
    let _ = app.emit(UPDATE_AVAILABLE_EVENT, version.clone());
    Ok(Some(version))
}

/// One check at launch, in the background; failures are logged, never shown.
pub fn check_on_launch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check(&app).await {
            eprintln!("updater: {e}");
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
