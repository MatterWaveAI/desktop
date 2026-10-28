//! Updates: off unless the build says otherwise.
//!
//! tauri.conf.json names no endpoint on purpose. It used to carry a
//! placeholder (`updates.invalid`), and a plugin registered against that did
//! nothing useful while reading as configured. The release job writes the
//! real endpoint and public key (scripts/release-config.mjs) and builds with
//! `MW_DESKTOP_UPDATER=1`, which is what registers the plugin and runs the
//! launch-time check. A build without the flag has no updater at all: no
//! plugin, no request, and the SPA's check command fails.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Read at build time like MW_DESKTOP_BASE_URL: whether a binary checks for
/// updates is a property of the build, not of the machine it runs on.
const FLAG: Option<&str> = option_env!("MW_DESKTOP_UPDATER");

/// The event the SPA receives when a newer version is published; the
/// payload is that version.
pub const UPDATE_AVAILABLE_EVENT: &str = "update-available";
/// Progress while the chosen update downloads: `{ downloaded, total }`, the
/// total null until the server says how big the artifact is.
pub const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";
/// The artifact is complete and verified; the install (and the relaunch)
/// comes next.
pub const UPDATE_DOWNLOAD_FINISHED_EVENT: &str = "update-download-finished";

pub fn enabled() -> bool {
    flag_is_on(FLAG)
}

fn flag_is_on(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("true"))
}

/// The version the most recent check found, if any. The launch check runs
/// before the SPA has mounted anything to hear the event, so the banner asks
/// here instead of relying on having listened at the right moment.
static LAST_FOUND: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The version an update is waiting for, from the last completed check. A
/// check that finds nothing newer clears it.
pub fn pending() -> Option<String> {
    LAST_FOUND.lock().ok()?.clone()
}

fn remember(version: Option<String>) {
    if let Ok(mut found) = LAST_FOUND.lock() {
        *found = version;
    }
}

/// One check, shared by the launch path and the SPA's `check_for_updates`
/// command. It reports and stops: a newer version is announced to the SPA as
/// `update-available` with the version string, kept for `pending_update`, and
/// returned to the caller. Downloading or installing stays a deliberate step
/// (`download_and_install`). With the flag on but no endpoint (a dev build)
/// there is no plugin to ask, which surfaces as the returned error.
pub async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("not checking: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
    else {
        remember(None);
        return Ok(None);
    };
    let version = update.version.clone();
    remember(Some(version.clone()));
    let _ = app.emit(UPDATE_AVAILABLE_EVENT, version.clone());
    Ok(Some(version))
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Download the update the last check offered and hand it to the OS
/// installer, then relaunch: the one deliberate step the check holds back.
/// Progress goes to the SPA as events, so the banner can show something
/// moving. The plugin verifies the artifact's signature before installing
/// (the release job's key), and `restart` never returns -- from the SPA's
/// side the command ends when the old process does.
pub async fn download_and_install(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("not updating: {e}"))?;
    // A fresh check rather than a stored artifact: the manifest can have
    // moved on (or the found update been withdrawn) since the banner
    // appeared, and the plugin hands back the update to install.
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
    else {
        return Err("no update is available".into());
    };
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    UPDATE_DOWNLOAD_PROGRESS_EVENT,
                    DownloadProgress { downloaded, total },
                );
            },
            move || {
                let _ = finish_app.emit(UPDATE_DOWNLOAD_FINISHED_EVENT, ());
            },
        )
        .await
        .map_err(|e| format!("install failed: {e}"))?;
    app.restart()
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

    /// What `pending_update` hands the SPA: the last check's finding, and a
    /// check that found nothing clears it. One test, serially, because the
    /// memory is process-wide and the suite runs its tests in parallel.
    #[test]
    fn pending_is_the_last_check_s_finding_and_only_that() {
        assert_eq!(pending(), None);
        remember(Some("1.2.3".into()));
        assert_eq!(pending().as_deref(), Some("1.2.3"));
        remember(Some("1.3.0".into()));
        assert_eq!(pending().as_deref(), Some("1.3.0"));
        remember(None);
        assert_eq!(pending(), None);
    }

    /// The test build is made without MW_DESKTOP_UPDATER, so `check_for_updates`
    /// takes its disabled branch -- the clean "no update" -- and never reaches
    /// for the plugin this build does not carry.
    #[test]
    fn a_test_build_has_the_updater_off() {
        assert!(!enabled());
    }
}
