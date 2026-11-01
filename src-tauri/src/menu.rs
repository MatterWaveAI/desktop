//! The app menu and the tray's menu: the native ways into the app's own
//! actions. An item that acts on the page -- New Chat, Settings, a recent
//! conversation -- is a navigation request (navigation.rs) the SPA carries
//! out; Check for Updates runs the updater's check; the rest are the
//! platform's own items (the clipboard, Hide, Quit, Minimize).
//!
//! Every menu event, the tray's included, reaches one handler (`handle`),
//! and what an item does is decided from its id alone (`action_for`), which
//! is what the tests drive.

use crate::navigation::{self, Target};
use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Wry};

const NEW_CHAT: &str = "new-chat";
const SETTINGS: &str = "settings";
const CHECK_FOR_UPDATES: &str = "check-for-updates";
const TOGGLE_FULLSCREEN: &str = "toggle-fullscreen";
const SHOW: &str = "show";
const QUIT: &str = "quit";
const RECENT: &str = "recent:";

/// How many recent conversations the tray lists.
pub(crate) const RECENT_LIMIT: usize = 3;
/// A tray item's longest title; past it the title is cut with an ellipsis.
const TITLE_LIMIT: usize = 40;

/// What one menu item asks for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MenuAction {
    Navigate(Target),
    CheckForUpdates,
    ToggleFullscreen,
    Show,
    Quit,
}

pub(crate) fn action_for(id: &str) -> Option<MenuAction> {
    if let Some(conversation) = id.strip_prefix(RECENT) {
        return navigation::is_id(conversation).then(|| {
            MenuAction::Navigate(Target::Conversation {
                id: conversation.to_string(),
                message: None,
            })
        });
    }
    match id {
        NEW_CHAT => Some(MenuAction::Navigate(Target::NewChat)),
        SETTINGS => Some(MenuAction::Navigate(Target::Settings)),
        CHECK_FOR_UPDATES => Some(MenuAction::CheckForUpdates),
        TOGGLE_FULLSCREEN => Some(MenuAction::ToggleFullscreen),
        SHOW => Some(MenuAction::Show),
        QUIT => Some(MenuAction::Quit),
        _ => None,
    }
}

/// A conversation the SPA lists first in its sidebar, as it hands it over.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct RecentConversation {
    pub id: String,
    pub title: String,
}

/// The tray's recent items as (menu id, label): the first few with a usable
/// id, titles trimmed to one line and cut to a tray-sized length.
pub(crate) fn recent_items(conversations: &[RecentConversation]) -> Vec<(String, String)> {
    conversations
        .iter()
        .filter(|c| navigation::is_id(&c.id))
        .take(RECENT_LIMIT)
        .map(|c| {
            let one_line = c.title.split_whitespace().collect::<Vec<_>>().join(" ");
            let label = if one_line.is_empty() {
                "Untitled conversation".to_string()
            } else if one_line.chars().count() > TITLE_LIMIT {
                let cut: String = one_line.chars().take(TITLE_LIMIT - 1).collect();
                format!("{}…", cut.trim_end())
            } else {
                one_line
            };
            (format!("{RECENT}{}", c.id), label)
        })
        .collect()
}

/// The window menu: on macOS the app menu first (About, Settings, Check for
/// Updates, Services, Hide, Quit), then File, Edit, View and Window; on
/// Windows and Linux the same items without the app menu, Settings and Quit
/// under File.
pub(crate) fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let new_chat = MenuItemBuilder::with_id(NEW_CHAT, "New Chat")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    // A build without the updater has nothing to check with; the item says
    // so by being off rather than by doing nothing.
    let check = MenuItemBuilder::with_id(CHECK_FOR_UPDATES, "Check for Updates…")
        .enabled(crate::updater::enabled())
        .build(app)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let app_name = app.package_info().name.clone();
        let app_submenu = SubmenuBuilder::new(app, app_name)
            .about(None)
            .separator()
            .item(&settings)
            .item(&check)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&new_chat)
            .separator()
            .close_window()
            .build()?;
        let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .bring_all_to_front()
            .build()?;
        MenuBuilder::new(app)
            .items(&[&app_submenu, &file, &edit, &view, &window])
            .build()
    }

    #[cfg(not(target_os = "macos"))]
    {
        let quit = MenuItemBuilder::with_id(QUIT, "Quit MatterWave")
            .accelerator("CmdOrCtrl+Q")
            .build(app)?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&new_chat)
            .separator()
            .item(&settings)
            .item(&check)
            .separator()
            .close_window()
            .item(&quit)
            .build()?;
        let fullscreen = MenuItemBuilder::with_id(TOGGLE_FULLSCREEN, "Toggle Full Screen")
            .accelerator("F11")
            .build(app)?;
        let view = SubmenuBuilder::new(app, "View").item(&fullscreen).build()?;
        let window = SubmenuBuilder::new(app, "Window").minimize().build()?;
        MenuBuilder::new(app)
            .items(&[&file, &edit, &view, &window])
            .build()
    }
}

/// The tray's menu: Show, New Chat, the recent conversations, Quit.
pub(crate) fn tray_menu(
    app: &AppHandle,
    conversations: &[RecentConversation],
) -> tauri::Result<Menu<Wry>> {
    let mut menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id(SHOW, "Show MatterWave").build(app)?)
        .item(&MenuItemBuilder::with_id(NEW_CHAT, "New Chat").build(app)?);
    let recent = recent_items(conversations);
    if !recent.is_empty() {
        menu = menu.separator();
        for (id, label) in recent {
            menu = menu.item(&MenuItemBuilder::with_id(id, label).build(app)?);
        }
    }
    menu.separator()
        .item(&MenuItemBuilder::with_id(QUIT, "Quit MatterWave").build(app)?)
        .build()
}

/// The tray's id, for rebuilding its menu when the recent list changes.
pub(crate) const TRAY_ID: &str = "matterwave";

/// The system tray, menu on left click too: a menu that needs a right click
/// is a menu half the world never finds. Its events go to `handle` with
/// every other menu's.
pub(crate) fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::InvalidIcon(std::io::Error::other(
                "the bundle has no window icon for the tray",
            ))
        })?)
        .menu(&tray_menu(app.handle(), &[])?)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// Swap the tray's recent conversations for `conversations`.
pub(crate) fn set_recent(
    app: &AppHandle,
    conversations: &[RecentConversation],
) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(tray_menu(app, conversations)?))?;
    }
    Ok(())
}

/// One menu event, from any menu.
pub(crate) fn handle(app: &AppHandle, id: &str) {
    match action_for(id) {
        Some(MenuAction::Navigate(target)) => {
            navigation::request(app, target);
            crate::summon::summon_main(app);
        }
        Some(MenuAction::CheckForUpdates) => crate::updater::check_from_menu(app.clone()),
        Some(MenuAction::ToggleFullscreen) => {
            if let Some(w) = app.get_webview_window("main") {
                let full = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!full);
            }
        }
        Some(MenuAction::Show) => crate::summon::summon_main(app),
        Some(MenuAction::Quit) => app.exit(0),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_item_asks_for_its_own_action() {
        assert_eq!(
            action_for("new-chat"),
            Some(MenuAction::Navigate(Target::NewChat))
        );
        assert_eq!(
            action_for("settings"),
            Some(MenuAction::Navigate(Target::Settings))
        );
        assert_eq!(
            action_for("check-for-updates"),
            Some(MenuAction::CheckForUpdates)
        );
        assert_eq!(
            action_for("toggle-fullscreen"),
            Some(MenuAction::ToggleFullscreen)
        );
        assert_eq!(action_for("show"), Some(MenuAction::Show));
        assert_eq!(action_for("quit"), Some(MenuAction::Quit));
        assert_eq!(action_for("something-else"), None);
    }

    #[test]
    fn a_recent_item_opens_its_conversation_and_nothing_malformed() {
        assert_eq!(
            action_for("recent:c_1-a"),
            Some(MenuAction::Navigate(Target::Conversation {
                id: "c_1-a".into(),
                message: None
            }))
        );
        assert_eq!(action_for("recent:"), None);
        assert_eq!(action_for("recent:../x"), None);
    }

    fn conversation(id: &str, title: &str) -> RecentConversation {
        RecentConversation {
            id: id.into(),
            title: title.into(),
        }
    }

    #[test]
    fn the_tray_lists_the_first_three_with_short_one_line_titles() {
        let items = recent_items(&[
            conversation("bad id", "skipped"),
            conversation("c1", "  Quarterly\nvelocity   planning "),
            conversation("c2", ""),
            conversation(
                "c3",
                "A title long enough that the tray would be as wide as the screen",
            ),
            conversation("c4", "the fourth is not listed"),
        ]);
        assert_eq!(
            items,
            vec![
                ("recent:c1".into(), "Quarterly velocity planning".into()),
                ("recent:c2".into(), "Untitled conversation".into()),
                (
                    "recent:c3".into(),
                    "A title long enough that the tray would…".into()
                ),
            ]
        );
        assert!(items
            .iter()
            .all(|(_, label)| label.chars().count() <= TITLE_LIMIT));
    }
}
