//! Bringing the window forward, and putting it away: the global hotkey's
//! toggle, the tray's Show, and every native path that wants the person
//! looking at the app (a deep link, a finished sign-in, a second launch).
//!
//! The decision is a pure function of how the window is now, so it can be
//! tested without a window: focused is the one state in which the person is
//! already looking at it, and a press puts it away; hidden, minimized or
//! behind another window, one press brings it forward.

use tauri::{AppHandle, Manager};

/// What one toggle press does.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Toggle {
    Hide,
    Summon,
}

/// The window as the toggle reads it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WindowState {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

pub(crate) fn toggle_action(state: WindowState) -> Toggle {
    if state.visible && !state.minimized && state.focused {
        Toggle::Hide
    } else {
        Toggle::Summon
    }
}

/// Show, unminimize and focus: from hidden (the hotkey put it away),
/// minimized, or behind another window, all in one call.
pub(crate) fn summon_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The global hotkey: put a focused window away, bring any other forward.
/// A window whose state cannot be read is treated as not in front, so the
/// press still does something visible.
pub(crate) fn toggle_main(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let state = WindowState {
        visible: w.is_visible().unwrap_or(false),
        minimized: w.is_minimized().unwrap_or(false),
        focused: w.is_focused().unwrap_or(false),
    };
    match toggle_action(state) {
        Toggle::Hide => {
            let _ = w.hide();
        }
        Toggle::Summon => summon_main(app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(visible: bool, minimized: bool, focused: bool) -> WindowState {
        WindowState {
            visible,
            minimized,
            focused,
        }
    }

    #[test]
    fn a_focused_window_is_put_away() {
        assert_eq!(toggle_action(state(true, false, true)), Toggle::Hide);
    }

    #[test]
    fn a_window_behind_others_comes_forward_in_one_press() {
        assert_eq!(toggle_action(state(true, false, false)), Toggle::Summon);
    }

    #[test]
    fn a_minimized_window_comes_back_in_one_press() {
        assert_eq!(toggle_action(state(true, true, false)), Toggle::Summon);
        // Some platforms report a minimized window as still focused; it is
        // not in front, so it is summoned rather than hidden.
        assert_eq!(toggle_action(state(true, true, true)), Toggle::Summon);
    }

    #[test]
    fn a_hidden_window_is_shown() {
        assert_eq!(toggle_action(state(false, false, false)), Toggle::Summon);
        assert_eq!(toggle_action(state(false, true, false)), Toggle::Summon);
    }

    /// Press, press: a summoned window is focused, so the second press hides
    /// it; hidden, the third summons it again.
    #[test]
    fn presses_alternate_from_any_starting_state() {
        let summoned = state(true, false, true);
        let hidden = state(false, false, false);
        for start in [state(true, false, false), state(true, true, false), hidden] {
            assert_eq!(toggle_action(start), Toggle::Summon);
            assert_eq!(toggle_action(summoned), Toggle::Hide);
            assert_eq!(toggle_action(hidden), Toggle::Summon);
        }
    }
}
