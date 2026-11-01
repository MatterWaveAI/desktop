//! The global hotkey quick-summon: one chord, registered with the operating
//! system, that toggles the window from anywhere: a focused window is put
//! away, a hidden, minimized or buried one comes forward (summon.rs).
//! Default `Ctrl+Shift+M` (the plugin's
//! `CommandOrControl`, so macOS gets `Cmd+Shift+M` for free).
//!
//! The choice is persisted in the app's config directory (`hotkey.json`),
//! which is what makes the launch registration land on the person's chord
//! rather than the default: the SPA is not up yet when the OS hands us a
//! press, so "preferences" here means the native side's own file, written
//! by the `set_global_shortcut` command the pane calls. A chord another
//! application already holds is a refusal the pane shows; the previous
//! chord keeps working.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const DEFAULT_ACCELERATOR: &str = "CommandOrControl+Shift+M";

/// The settings file, inside the app's config directory.
const SETTINGS_FILE: &str = "hotkey.json";

/// What the hotkey may be made of: aliases first (the plugin accepts several
/// spellings; we keep the common ones and answer with one canonical form),
/// then the key whitelist -- letters, digits, F-keys and the named keys a
/// summon chord actually uses. Anything else is refused before the OS sees
/// it, so a mangled choice is a message in the pane and never a half-bound
/// chord.
pub(crate) fn normalize_accelerator(raw: &str) -> Option<String> {
    const MODIFIERS: &[(&str, &str)] = &[
        ("COMMANDORCONTROL", "CommandOrControl"),
        ("CMDORCTRL", "CommandOrControl"),
        ("CONTROL", "Ctrl"),
        ("CTRL", "Ctrl"),
        ("SHIFT", "Shift"),
        ("ALT", "Alt"),
        ("OPTION", "Alt"),
        ("COMMAND", "Command"),
        ("CMD", "Command"),
        ("SUPER", "Command"),
        ("META", "Command"),
    ];
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for token in raw.split('+') {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        let upper = token.to_ascii_uppercase();
        if let Some((_, canonical)) = MODIFIERS.iter().find(|(name, _)| *name == upper) {
            if mods.contains(canonical) {
                return None;
            }
            mods.push(canonical);
        } else if key.is_none() {
            key = Some(canonical_key(&upper)?);
        } else {
            // A second key: the plugin would refuse it; so do we, earlier.
            return None;
        }
    }
    let key = key?;
    if mods.is_empty() {
        // A bare letter as a global hotkey would fire on every keystroke
        // everywhere; a chord has at least one modifier.
        return None;
    }
    // Canonical modifier order, whatever order they came in.
    const ORDER: &[&str] = &["CommandOrControl", "Ctrl", "Command", "Shift", "Alt"];
    mods.sort_by_key(|m| ORDER.iter().position(|o| o == m).unwrap_or(usize::MAX));
    let mut parts: Vec<String> = mods.into_iter().map(str::to_string).collect();
    parts.push(key);
    Some(parts.join("+"))
}

/// The key half, upper case, whitelisted: one letter or digit, F1-F24, or
/// one of the named keys. These spellings are what the plugin's own parser
/// accepts (it matches the keyboard-types `Code` names, case-insensitively).
fn canonical_key(upper: &str) -> Option<String> {
    let chars: Vec<char> = upper.chars().collect();
    if chars.len() == 1 {
        let c = chars[0];
        return if c.is_ascii_alphanumeric() {
            Some(c.to_string())
        } else {
            None
        };
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(upper.to_string());
            }
        }
    }
    const NAMED: &[&str] = &[
        "SPACE",
        "TAB",
        "ENTER",
        "COMMA",
        "PERIOD",
        "MINUS",
        "EQUAL",
        "SLASH",
        "BACKQUOTE",
        "ARROWUP",
        "ARROWDOWN",
        "ARROWLEFT",
        "ARROWRIGHT",
    ];
    if NAMED.contains(&upper) {
        return Some(upper.to_string());
    }
    None
}

/// The persisted choice: the accelerator, or `null` for "off". A missing or
/// unreadable file reads as the default, which is also what a fresh install
/// sees.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Settings {
    pub accelerator: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            accelerator: Some(DEFAULT_ACCELERATOR.to_string()),
        }
    }
}

pub(crate) fn load_settings_from(dir: &std::path::Path) -> Settings {
    let Ok(raw) = std::fs::read_to_string(dir.join(SETTINGS_FILE)) else {
        return Settings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(crate) fn save_settings_to(dir: &std::path::Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create the settings directory: {e}"))?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SETTINGS_FILE), json)
        .map_err(|e| format!("could not write the hotkey settings: {e}"))
}

/// The registration half, as a seam: the plugin answers to this, and so
/// does the test's fake "OS". One chord at a time -- `unregister` means
/// everything this app registered, which is exactly one.
pub(crate) trait ShortcutSystem {
    fn register(&mut self, accelerator: &str) -> Result<(), String>;
    fn unregister(&mut self);
}

/// The chord as registered, plus the system that put it there.
pub(crate) struct Hotkey<S: ShortcutSystem> {
    system: S,
    current: Option<String>,
}

impl<S: ShortcutSystem> Hotkey<S> {
    pub(crate) fn new(system: S) -> Self {
        Self {
            system,
            current: None,
        }
    }

    pub(crate) fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }

    /// Point the hotkey at `accelerator`, or switch it off with `None`.
    ///
    /// The registration path: normalize first (a mangled shape is refused
    /// with the remedy in the message), do nothing when the choice is
    /// already the one registered, and otherwise unregister, register, and
    /// on a refusal put the previous chord back so a "taken" answer leaves
    /// the hotkey working.
    pub(crate) fn set(&mut self, accelerator: Option<&str>) -> Result<Option<String>, String> {
        let wanted = match accelerator {
            None => None,
            Some(raw) => Some(normalize_accelerator(raw).ok_or_else(|| {
                format!("\"{raw}\" is not a shortcut shape we can register; try Ctrl+Shift+M.")
            })?),
        };
        if wanted.as_deref() == self.current.as_deref() {
            return Ok(self.current.clone());
        }
        let previous = self.current.clone();
        if self.current.is_some() {
            // Only what we registered needs clearing; the first set has
            // nothing to replace and must not churn the OS registration.
            self.system.unregister();
        }
        self.current = None;
        if let Some(accel) = wanted {
            if let Err(e) = self.system.register(&accel) {
                if let Some(previous) = &previous {
                    if self.system.register(previous).is_ok() {
                        self.current = Some(previous.clone());
                    }
                }
                return Err(e);
            }
            self.current = Some(accel);
        }
        Ok(self.current.clone())
    }
}

/// The real registration, through the plugin. The refusal wording is the
/// one the pane shows: taken is the everyday case, so it is said plainly.
struct PluginShortcuts {
    app: AppHandle,
}

impl ShortcutSystem for PluginShortcuts {
    fn register(&mut self, accelerator: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
        let shortcut: Shortcut = accelerator.parse().map_err(|e| {
            format!("\"{accelerator}\" is not a shortcut this platform can register: {e}")
        })?;
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(|e| {
                format!(
                    "\"{accelerator}\" could not be registered -- the chord is already in use by another application: {e}"
                )
            })
    }

    fn unregister(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = self.app.global_shortcut().unregister_all();
    }
}

/// What the launch path and the commands share: the one registration and
/// where its choice is persisted.
pub(crate) struct HotkeyManager {
    hotkey: std::sync::Mutex<Hotkey<PluginShortcuts>>,
    settings_dir: Option<std::path::PathBuf>,
}

impl HotkeyManager {
    fn new(app: &AppHandle) -> Self {
        let settings_dir = app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join("hotkey"));
        Self {
            hotkey: std::sync::Mutex::new(Hotkey::new(PluginShortcuts { app: app.clone() })),
            settings_dir,
        }
    }

    fn set(&self, accelerator: Option<&str>) -> Result<Option<String>, String> {
        let mut hotkey = self
            .hotkey
            .lock()
            .map_err(|_| "the hotkey state is busy".to_string())?;
        let current = hotkey.set(accelerator)?;
        // Registration is the truth; a failed save only means the choice is
        // for this run. The pane has already been told the new state.
        if let Some(dir) = &self.settings_dir {
            if let Err(e) = save_settings_to(
                dir,
                &Settings {
                    accelerator: current.clone(),
                },
            ) {
                eprintln!("hotkey: {e}");
            }
        }
        Ok(current)
    }

    fn current(&self) -> Option<String> {
        self.hotkey
            .lock()
            .ok()
            .and_then(|hotkey| hotkey.current().map(str::to_string))
    }
}

/// What the pane renders: the chord now registered (null when off) and the
/// build's default, so the pane's "default" choice names itself.
#[derive(Serialize)]
pub(crate) struct GlobalShortcutState {
    pub accelerator: Option<String>,
    pub default: String,
}

pub(crate) fn state_of(current: Option<&str>) -> GlobalShortcutState {
    GlobalShortcutState {
        accelerator: current.map(str::to_string),
        default: DEFAULT_ACCELERATOR.to_string(),
    }
}

/// The command bodies. Registration succeeded is the state; a taken chord
/// is the error, with the previous chord still registered.
pub(crate) fn current_of(manager: &HotkeyManager) -> Option<String> {
    manager.current()
}

pub(crate) fn apply(
    manager: &HotkeyManager,
    shortcut: Option<&str>,
) -> Result<Option<String>, String> {
    manager.set(shortcut)
}

/// At launch: register whatever was persisted, or the default. A chord the
/// OS refuses (taken by something that started first) is logged, not fatal
/// -- the app works, and the pane shows the hotkey as off when asked.
pub(crate) fn register_on_launch(app: &tauri::App) {
    app.manage(HotkeyManager::new(app.handle()));
    let manager = app.state::<HotkeyManager>();
    let persisted: Settings = manager
        .settings_dir
        .as_deref()
        .map(load_settings_from)
        .unwrap_or_default();
    // Normalize what the file says, so an older or hand-edited entry is
    // read once and rewritten in the canonical shape on the next set.
    let wanted = persisted
        .accelerator
        .as_deref()
        .and_then(normalize_accelerator)
        .or_else(|| normalize_accelerator(DEFAULT_ACCELERATOR));
    if let Some(accel) = wanted {
        if let Err(e) = manager.set(Some(&accel)) {
            eprintln!("hotkey: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The "OS": registers what it is told, refuses the chords marked
    /// taken, and counts unregisters the way the plugin's unregister_all
    /// is one call.
    #[derive(Default)]
    struct FakeShortcuts {
        registered: Vec<String>,
        taken: Vec<String>,
        unregister_count: usize,
    }

    impl ShortcutSystem for FakeShortcuts {
        fn register(&mut self, accelerator: &str) -> Result<(), String> {
            if self.taken.iter().any(|t| t == accelerator) {
                return Err(format!(
                    "\"{accelerator}\" could not be registered -- the chord is already in use by another application"
                ));
            }
            self.registered.push(accelerator.to_string());
            Ok(())
        }

        fn unregister(&mut self) {
            self.unregister_count += 1;
            self.registered.clear();
        }
    }

    #[test]
    fn a_chord_normalizes_to_one_canonical_spelling() {
        assert_eq!(
            normalize_accelerator("Ctrl+Shift+M").as_deref(),
            Some("Ctrl+Shift+M")
        );
        assert_eq!(
            normalize_accelerator("ctrl + shift + m").as_deref(),
            Some("Ctrl+Shift+M")
        );
        assert_eq!(
            normalize_accelerator("Control+SHIFT+m").as_deref(),
            Some("Ctrl+Shift+M")
        );
        // The aliases fold onto the canonical words.
        assert_eq!(
            normalize_accelerator("CmdOrCtrl+Alt+P").as_deref(),
            Some("CommandOrControl+Alt+P")
        );
        assert_eq!(
            normalize_accelerator("option+Command+K").as_deref(),
            Some("Command+Alt+K")
        );
        // Modifier order is canonical, whatever order they came in.
        assert_eq!(
            normalize_accelerator("M+Shift+Ctrl").as_deref(),
            Some("Ctrl+Shift+M")
        );
        assert_eq!(
            normalize_accelerator("CommandOrControl+Shift+M").as_deref(),
            Some("CommandOrControl+Shift+M"),
            "the canonical spelling is idempotent"
        );
    }

    #[test]
    fn keys_beyond_a_letter_are_whitelisted_explicitly() {
        assert_eq!(normalize_accelerator("Ctrl+1").as_deref(), Some("Ctrl+1"));
        assert_eq!(
            normalize_accelerator("Ctrl+F13").as_deref(),
            Some("Ctrl+F13")
        );
        assert_eq!(
            normalize_accelerator("Ctrl+Space").as_deref(),
            Some("Ctrl+SPACE")
        );
        assert_eq!(normalize_accelerator("Ctrl+F25"), None, "no such key");
        assert_eq!(normalize_accelerator("Ctrl+Emoji"), None);
        assert_eq!(normalize_accelerator("Ctrl+;"), None);
    }

    #[test]
    fn anything_that_is_not_exactly_one_modifier_plus_one_key_is_refused() {
        assert_eq!(normalize_accelerator(""), None);
        assert_eq!(normalize_accelerator("   "), None);
        assert_eq!(normalize_accelerator("Ctrl+"), None);
        assert_eq!(normalize_accelerator("+Shift"), None);
        assert_eq!(normalize_accelerator("M"), None, "a bare key is no chord");
        assert_eq!(normalize_accelerator("Hyper+M"), None);
        assert_eq!(
            normalize_accelerator("Ctrl+Ctrl+M"),
            None,
            "twice the same modifier"
        );
        assert_eq!(normalize_accelerator("Ctrl+M+N"), None, "two keys");
    }

    /// The canonical spellings must be ones the real plugin will accept at
    /// registration time -- this is the parse, which needs no OS.
    #[test]
    fn the_canonical_form_is_what_the_plugin_parses() {
        use tauri_plugin_global_shortcut::Shortcut;
        for chord in [
            DEFAULT_ACCELERATOR,
            "CommandOrControl+Shift+K",
            "CommandOrControl+Alt+M",
            "CommandOrControl+Shift+SPACE",
            "Ctrl+1",
            "Ctrl+F13",
            "Command+Alt+K",
        ] {
            let normalized =
                normalize_accelerator(chord).unwrap_or_else(|| panic!("{chord} should normalize"));
            normalized
                .parse::<Shortcut>()
                .unwrap_or_else(|e| panic!("{normalized}: {e}"));
        }
    }

    #[test]
    fn the_first_set_registers_and_is_idempotent() {
        let mut hotkey = Hotkey::new(FakeShortcuts::default());
        assert_eq!(hotkey.current(), None);

        let current = hotkey.set(Some("ctrl+shift+m")).unwrap();
        assert_eq!(current.as_deref(), Some("Ctrl+Shift+M"));
        assert_eq!(hotkey.system.registered, ["Ctrl+Shift+M"]);
        assert_eq!(hotkey.system.unregister_count, 0, "nothing to replace");

        // The same chord again: no churn.
        let again = hotkey.set(Some("Ctrl+Shift+M")).unwrap();
        assert_eq!(again.as_deref(), Some("Ctrl+Shift+M"));
        assert_eq!(hotkey.system.registered, ["Ctrl+Shift+M"]);
        assert_eq!(hotkey.system.unregister_count, 0);
    }

    #[test]
    fn a_replacement_unregisters_the_old_chord_and_registers_the_new() {
        let mut hotkey = Hotkey::new(FakeShortcuts::default());
        hotkey.set(Some("Ctrl+Shift+M")).unwrap();

        hotkey.set(Some("Ctrl+Shift+K")).unwrap();
        assert_eq!(hotkey.current(), Some("Ctrl+Shift+K"));
        assert_eq!(hotkey.system.registered, ["Ctrl+Shift+K"]);
        assert_eq!(hotkey.system.unregister_count, 1);
    }

    #[test]
    fn a_taken_chord_is_refused_and_the_previous_one_keeps_working() {
        let mut hotkey = Hotkey::new(FakeShortcuts {
            taken: vec!["Ctrl+Alt+M".to_string()],
            ..FakeShortcuts::default()
        });
        hotkey.set(Some("Ctrl+Shift+M")).unwrap();

        let err = hotkey.set(Some("Ctrl+Alt+M")).unwrap_err();
        assert!(err.contains("already in use"), "{err}");
        // The old chord was put back: still registered, still the current.
        assert_eq!(hotkey.current(), Some("Ctrl+Shift+M"));
        assert_eq!(hotkey.system.registered, ["Ctrl+Shift+M"]);
    }

    #[test]
    fn a_mangled_shape_is_refused_before_the_os_sees_it() {
        let mut hotkey = Hotkey::new(FakeShortcuts::default());
        hotkey.set(Some("Ctrl+Shift+M")).unwrap();

        let err = hotkey.set(Some("not a chord")).unwrap_err();
        assert!(err.contains("not a shortcut shape"), "{err}");
        assert_eq!(hotkey.current(), Some("Ctrl+Shift+M"));
        assert_eq!(hotkey.system.unregister_count, 0, "nothing was touched");
    }

    #[test]
    fn none_is_off_and_the_next_set_registers_again() {
        let mut hotkey = Hotkey::new(FakeShortcuts::default());
        hotkey.set(Some("Ctrl+Shift+M")).unwrap();

        let current = hotkey.set(None).unwrap();
        assert_eq!(current, None);
        assert_eq!(hotkey.current(), None);
        assert_eq!(hotkey.system.unregister_count, 1);

        hotkey.set(Some("Ctrl+Shift+K")).unwrap();
        assert_eq!(hotkey.system.registered, ["Ctrl+Shift+K"]);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mw-hotkey-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_choice_persists_and_a_missing_or_corrupt_file_reads_as_the_default() {
        let dir = temp_dir("settings");

        // Nothing yet: the default.
        assert_eq!(load_settings_from(&dir), Settings::default());

        save_settings_to(
            &dir,
            &Settings {
                accelerator: Some("Ctrl+Shift+K".to_string()),
            },
        )
        .unwrap();
        assert_eq!(
            load_settings_from(&dir),
            Settings {
                accelerator: Some("Ctrl+Shift+K".to_string())
            }
        );

        // Off is a real choice and survives the round trip.
        save_settings_to(&dir, &Settings { accelerator: None }).unwrap();
        assert_eq!(load_settings_from(&dir), Settings { accelerator: None });

        // Corrupt content is the default, not a crash.
        std::fs::write(dir.join(SETTINGS_FILE), "{not json").unwrap();
        assert_eq!(load_settings_from(&dir), Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_state_the_pane_renders_names_the_default() {
        let state = state_of(Some("Ctrl+Shift+M"));
        assert_eq!(state.accelerator.as_deref(), Some("Ctrl+Shift+M"));
        assert_eq!(state.default, DEFAULT_ACCELERATOR);
        let off = state_of(None);
        assert_eq!(off.accelerator, None);
        assert_eq!(off.default, DEFAULT_ACCELERATOR);
    }
}
