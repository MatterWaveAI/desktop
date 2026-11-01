//! The native approval gate: every question agent mode puts to the person
//! is asked here, in an OS dialog the webview cannot see into, answer or
//! dismiss. Script running in the webview can call any agent command it
//! likes; it still cannot make a command run, or a file change, without
//! the person choosing the dialog's yes.
//!
//! What is asked, and when (`needs_native`):
//!
//! - every `run_shell` in `ask` and `auto-edit`, with the command shown
//!   whole (a command too long to show whole is refused, not shortened);
//! - every applied `edit` and `write_file` in `ask`, with the file's full
//!   path and the changed lines (the panel's diff is for reading; this is
//!   the gate);
//! - in `auto-edit` too, a write to the files the app loads into every
//!   run's prompt as the person's own instructions (MATTERWAVE.md,
//!   AGENTS.md, MATTERWAVE.local.md), so a run cannot plant instructions
//!   for the next one unasked;
//! - starting `auto-edit` or `yolo` (once per folder per app session),
//!   turning agent mode on, trusting a folder, and restoring a checkpoint.
//!
//! Text from the model reaches the dialog through `visible`, which shows
//! control, bidirectional and invisible characters as `<U+XXXX>`, so the
//! command shown is the command run. "Cancel" is the dialog's default
//! button: Enter, Space and Escape all answer no, so a dialog raised under
//! the person's typing is not answered by it. One question is on screen at
//! a time (`AgentState::ask`).

use super::contract::{self, ModeSpec, ToolKind};
use super::tools::WritePreview;
use super::CONTEXT_FILES;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// One question for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ask {
    pub title: String,
    pub body: String,
    /// The yes button's label. The other button is `CANCEL`, the default.
    pub accept: String,
}

pub(crate) type Answer = Pin<Box<dyn Future<Output = bool> + Send>>;

/// Puts an `Ask` to the person and answers whether they chose its yes. The
/// app's is the native dialog (`native`); the tests' is a script.
pub(crate) type Confirmer = Arc<dyn Fn(Ask) -> Answer + Send + Sync>;

pub(crate) const CANCEL: &str = "Cancel";

/// Whether the dialog's result is the person choosing `accept`. Only that
/// button counts: Cancel, Escape, closing the dialog and a dialog that
/// could not be shown are all no.
pub(crate) fn accepted(result: &rfd::MessageDialogResult, accept: &str) -> bool {
    matches!(result, rfd::MessageDialogResult::Custom(label) if label == accept && label != CANCEL)
}

/// The app's confirmer: a native dialog over the main window, which is
/// brought forward first so a question is never asked behind it.
pub(crate) fn native(app: tauri::AppHandle) -> Confirmer {
    Arc::new(move |ask| {
        let app = app.clone();
        Box::pin(async move { show(&app, ask).await })
    })
}

/// The dialog itself. The buttons are given Cancel first: rfd makes the
/// first button the default on Windows (TaskDialog) and macOS (NSAlert),
/// and on GTK the yes button answers with the "cancel" response, which
/// Escape (a delete event) does not. Each backend hands back the label of
/// the button chosen, which `accepted` reads; rfd's zenity fallback would
/// not (it answers a closed dialog with the second label), and is not
/// built: the crate is used with `gtk3` alone.
async fn show(app: &tauri::AppHandle, ask: Ask) -> bool {
    use tauri::Manager;
    let window = app.get_webview_window("main");
    if let Some(w) = &window {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let buttons = rfd::MessageButtons::OkCancelCustom(CANCEL.to_string(), ask.accept.clone());
    #[cfg(target_os = "linux")]
    {
        // GTK dialogs run on the main thread, as the dialog plugin's do.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (title, body) = (ask.title.clone(), ask.body.clone());
        let ran = app.run_on_main_thread(move || {
            let mut dialog = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title(title)
                .set_description(body)
                .set_buttons(buttons);
            if let Some(w) = &window {
                dialog = dialog.set_parent(w);
            }
            let _ = tx.send(dialog.show());
        });
        if ran.is_err() {
            return false;
        }
        rx.await.is_ok_and(|r| accepted(&r, &ask.accept))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut dialog = rfd::AsyncMessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title(&ask.title)
            .set_description(&ask.body)
            .set_buttons(buttons);
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        accepted(&dialog.show().await, &ask.accept)
    }
}

/// Whether a character would not show as itself in a dialog: a control
/// character (a carriage return can hide what came before it on the
/// line), a bidirectional control (which reorders what is shown: "Trojan
/// Source"), a zero-width or otherwise invisible character, a variation
/// selector, or a Unicode tag (text no font draws). Newline and tab show.
fn hidden(c: char) -> bool {
    if c == '\n' || c == '\t' {
        return false;
    }
    c.is_control()
        || matches!(
            c as u32,
            0x00AD
                | 0x034F
                | 0x061C
                | 0x115F
                | 0x1160
                | 0x17B4
                | 0x17B5
                | 0x180B..=0x180F
                | 0x200B..=0x200F
                | 0x2028..=0x202E
                | 0x2060..=0x206F
                | 0x3164
                | 0xFE00..=0xFE0F
                | 0xFEFF
                | 0xFFA0
                | 0xFFF9..=0xFFFB
                | 0x1D173..=0x1D17A
                | 0xE0000..=0xE0FFF
        )
}

/// `text` as a dialog may show it: each hidden character as `<U+XXXX>`.
pub(crate) fn visible(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if hidden(c) {
            out.push_str(&format!("<U+{:04X}>", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// The longest command a dialog is trusted to show whole.
pub(crate) const ASK_COMMAND_MAX_CHARS: usize = 2000;
pub(crate) const ASK_COMMAND_MAX_LINES: usize = 40;

/// A command is asked about only when the dialog can show all of it: the
/// person approves what runs, never a shortened version of it.
pub(crate) fn command_fits(command: &str) -> Result<(), String> {
    let chars = command.chars().count();
    let lines = command.lines().count();
    if chars > ASK_COMMAND_MAX_CHARS || lines > ASK_COMMAND_MAX_LINES {
        return Err(format!(
            "Not run: the command is {chars} characters on {lines} lines, more than the approval dialog shows whole ({ASK_COMMAND_MAX_CHARS} characters, {ASK_COMMAND_MAX_LINES} lines). Write it to a script file with write_file, which is approved with its diff, and run that."
        ));
    }
    Ok(())
}

pub(crate) fn shell_ask(command: &str, root: &Path, timeout: Duration) -> Ask {
    Ask {
        title: "Run this command?".into(),
        body: format!(
            "{}\n\nIn {}, as you, with no sandbox. Stopped after {} s.\n\nThe agent asked to run this. Nothing runs unless you choose Run command.",
            visible(command),
            visible(&root.display().to_string()),
            timeout.as_secs()
        ),
        accept: "Run command".into(),
    }
}

/// The changed lines a dialog shows of a write.
pub(crate) const ASK_DIFF_LINES: usize = 30;
const ASK_LINE_CHARS: usize = 200;

fn shown_line(sign: char, line: &str) -> String {
    let mut cut: String = line.chars().take(ASK_LINE_CHARS).collect();
    if line.chars().count() > ASK_LINE_CHARS {
        cut.push('…');
    }
    format!("{sign} {}", visible(cut.trim_end_matches(['\r', '\n'])))
}

/// What a write changes, as a dialog shows it: one line saying where and
/// how much, then the changed lines (`-` before, `+` after), at most
/// `ASK_DIFF_LINES` of them. The span runs from the first changed line to
/// the last, so nothing outside it changes; it can include unchanged lines
/// between two changes, which is longer than a minimal diff, never shorter.
pub(crate) fn change_excerpt(before: Option<&str>, after: &str) -> (String, Vec<String>) {
    let after_lines: Vec<&str> = after.split_inclusive('\n').collect();
    let Some(before) = before else {
        let summary = format!(
            "A new file: {} lines, {} bytes.",
            after_lines.len(),
            after.len()
        );
        return (
            summary,
            cap(after_lines.iter().map(|l| shown_line('+', l)).collect()),
        );
    };
    let before_lines: Vec<&str> = before.split_inclusive('\n').collect();
    let prefix = before_lines
        .iter()
        .zip(&after_lines)
        .take_while(|(a, b)| a == b)
        .count();
    let room = before_lines.len().min(after_lines.len()) - prefix;
    let suffix = before_lines
        .iter()
        .rev()
        .zip(after_lines.iter().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    let removed = &before_lines[prefix..before_lines.len() - suffix];
    let added = &after_lines[prefix..after_lines.len() - suffix];
    let summary = if removed.is_empty() && added.is_empty() {
        "Nothing changes.".to_string()
    } else if removed.is_empty() {
        format!("{} lines added after line {prefix}.", added.len())
    } else {
        format!(
            "Lines {}-{}: {} removed, {} added.",
            prefix + 1,
            prefix + removed.len(),
            removed.len(),
            added.len()
        )
    };
    let lines = removed
        .iter()
        .map(|l| shown_line('-', l))
        .chain(added.iter().map(|l| shown_line('+', l)))
        .collect();
    (summary, cap(lines))
}

fn cap(mut lines: Vec<String>) -> Vec<String> {
    if lines.len() > ASK_DIFF_LINES {
        let more = lines.len() - ASK_DIFF_LINES;
        lines.truncate(ASK_DIFF_LINES);
        lines.push(format!("… and {more} more changed lines."));
    }
    lines
}

/// `relative` (`/`-separated) under `root`, as the platform writes paths.
fn full_path(root: &Path, relative: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    format!(
        "{}{sep}{}",
        root.display().to_string().trim_end_matches(['/', '\\']),
        relative.replace('/', &sep)
    )
}

pub(crate) fn write_ask(root: &Path, preview: &WritePreview) -> Ask {
    let created = preview.before.is_none();
    let (summary, lines) = change_excerpt(preview.before.as_deref(), &preview.after);
    let accept = if created {
        "Create file"
    } else {
        "Apply change"
    };
    let context = if is_context_file(&preview.relative) {
        "\n\nThis file is sent to the model as your instructions at the start of every agent run in this folder."
    } else {
        ""
    };
    Ask {
        title: if created {
            "Create this file?".into()
        } else {
            "Apply this change?".into()
        },
        body: format!(
            "{} {}\n{summary}\n\n{}{context}\n\nThe agent panel shows the whole change. Nothing is written unless you choose {accept}.",
            if created { "Create" } else { "Change" },
            visible(&full_path(root, &preview.relative)),
            lines.join("\n"),
        ),
        accept: accept.into(),
    }
}

pub(crate) fn restore_ask(root: &Path, checkpoint: u64, files: &[String]) -> Ask {
    let mut listed: Vec<String> = files.iter().take(20).map(|f| visible(f)).collect();
    if files.len() > 20 {
        listed.push(format!("… and {} more", files.len() - 20));
    }
    Ask {
        title: "Restore these files?".into(),
        body: format!(
            "Put back, in {}, as they were before checkpoint {checkpoint}:\n{}\n\nWhat has changed in them since, by the agent or anyone else, is lost, and a file the agent created is deleted.",
            visible(&root.display().to_string()),
            listed.join("\n")
        ),
        accept: "Restore".into(),
    }
}

/// Whether `mode` lets something other than reads through unasked, which
/// starting it needs the person's yes for (once per folder per session).
pub(crate) fn widens(mode: &ModeSpec) -> bool {
    mode.allow
        .iter()
        .any(|t| contract::tool(t).is_some_and(|spec| spec.kind != ToolKind::Read))
}

pub(crate) fn mode_ask(mode: &ModeSpec, root: &Path) -> Ask {
    let root = visible(&root.display().to_string());
    if mode.requires_flag {
        Ask {
            title: "Allow yolo for this session?".into(),
            body: format!(
                "In yolo mode the agent changes files and runs commands in {root} without asking you first, for the rest of this session. Commands are not sandboxed."
            ),
            accept: "Allow yolo".into(),
        }
    } else {
        Ask {
            title: format!("Allow {} for this session?", mode.name),
            body: format!(
                "In {} mode the agent changes files in {root} without asking you first, for the rest of this session. It still asks before each command, and before changing MATTERWAVE.md or AGENTS.md.",
                mode.name
            ),
            accept: format!("Allow {}", mode.name),
        }
    }
}

/// Whether `relative` is one of the root's context files.
pub(crate) fn is_context_file(relative: &str) -> bool {
    CONTEXT_FILES
        .iter()
        .any(|name| name.eq_ignore_ascii_case(relative))
}

/// Whether `tool` (on `relative`, for a write) needs the person's native
/// yes in `mode`. A tool the mode does not offer at all is refused before
/// this is asked.
pub(crate) fn needs_native(mode: &ModeSpec, tool: &str, relative: Option<&str>) -> bool {
    if mode.ask.contains(&tool) {
        return true;
    }
    let writes = contract::tool(tool).is_some_and(|t| t.kind == ToolKind::Write);
    writes && !mode.requires_flag && relative.is_some_and(is_context_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rfd::MessageDialogResult;

    #[test]
    fn only_the_yes_buttons_own_label_is_a_yes() {
        assert!(accepted(
            &MessageDialogResult::Custom("Run command".into()),
            "Run command"
        ));
        for no in [
            MessageDialogResult::Custom(CANCEL.into()),
            MessageDialogResult::Cancel,
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Custom("Run".into()),
        ] {
            assert!(!accepted(&no, "Run command"), "{no:?}");
        }
        assert!(!accepted(
            &MessageDialogResult::Custom(CANCEL.into()),
            CANCEL
        ));
    }

    /// rfd's features decide which backend answers; the zenity one maps a
    /// closed dialog to the second button's label, which here is the yes.
    #[test]
    fn the_dialog_crate_is_built_without_its_zenity_or_portal_backends() {
        let manifest =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
                .unwrap();
        let rfd = manifest
            .lines()
            .find(|l| l.trim_start().starts_with("rfd ="))
            .unwrap();
        assert!(rfd.contains("default-features = false"), "{rfd}");
        assert!(!rfd.contains("xdg-portal"), "{rfd}");
    }

    #[test]
    fn hidden_characters_are_shown_by_their_code_point() {
        // A carriage return that hides the start of the line, a
        // right-to-left override, a zero-width space and a tag character.
        let sly = "echo safe\rrm -rf ~ \u{202E}txt.exe\u{200B} \u{E0041}";
        assert_eq!(
            visible(sly),
            "echo safe<U+000D>rm -rf ~ <U+202E>txt.exe<U+200B> <U+E0041>"
        );
        assert_eq!(visible("a\n\tb ü 日本"), "a\n\tb ü 日本");
        assert_eq!(visible("\u{1b}[31m"), "<U+001B>[31m");
    }

    #[test]
    fn a_command_is_asked_about_whole_or_not_at_all() {
        let root = Path::new("/work/demo");
        let ask = shell_ask("make test && rm -rf build", root, Duration::from_secs(30));
        assert!(ask.body.starts_with("make test && rm -rf build\n\nIn "));
        assert!(ask.body.contains("Stopped after 30 s."));
        assert_eq!(ask.accept, "Run command");
        assert!(command_fits(&"x".repeat(ASK_COMMAND_MAX_CHARS)).is_ok());
        let long = command_fits(&"x".repeat(ASK_COMMAND_MAX_CHARS + 1)).unwrap_err();
        assert!(long.starts_with("Not run: the command is 2001 characters"));
        assert!(command_fits(&"a\n".repeat(ASK_COMMAND_MAX_LINES + 1)).is_err());
    }

    #[test]
    fn a_write_is_shown_with_its_full_path_and_the_lines_it_changes() {
        let root = Path::new(if cfg!(windows) {
            r"C:\work\demo"
        } else {
            "/work/demo"
        });
        let preview = WritePreview {
            relative: "src/app.py".into(),
            before: Some("a\nb\nc\nd\n".into()),
            after: "a\nB\nc\nd\nextra\n".into(),
            before_sha256: "x".into(),
        };
        let ask = write_ask(root, &preview);
        let sep = std::path::MAIN_SEPARATOR;
        assert!(
            ask.body.starts_with(&format!(
                "Change {}{sep}src{sep}app.py\nLines 2-4: 3 removed, 4 added.\n\n- b\n- c\n- d\n+ B\n+ c\n+ d\n+ extra\n",
                root.display()
            )),
            "{}",
            ask.body
        );
        assert_eq!(ask.accept, "Apply change");

        let created = write_ask(
            root,
            &WritePreview {
                relative: "MATTERWAVE.md".into(),
                before: None,
                after: "Use tabs.\n".into(),
                before_sha256: "absent".into(),
            },
        );
        assert_eq!(created.title, "Create this file?");
        assert!(created
            .body
            .contains("A new file: 1 lines, 10 bytes.\n\n+ Use tabs."));
        assert!(created
            .body
            .contains("sent to the model as your instructions"));
    }

    #[test]
    fn a_long_change_is_cut_in_the_dialog_and_says_how_much_is_left() {
        let after: String = (0..100).map(|n| format!("{n}\n")).collect();
        let (summary, lines) = change_excerpt(Some(""), &after);
        assert_eq!(summary, "100 lines added after line 0.");
        assert_eq!(lines.len(), ASK_DIFF_LINES + 1);
        assert_eq!(lines.last().unwrap(), "… and 70 more changed lines.");
        let (same, none) = change_excerpt(Some("x\n"), "x\n");
        assert_eq!((same.as_str(), none.len()), ("Nothing changes.", 0));
    }

    #[test]
    fn which_calls_ask_in_which_mode() {
        let m = |name| contract::mode(name).unwrap();
        // ask: every write and command.
        assert!(needs_native(m("ask"), "run_shell", None));
        assert!(needs_native(m("ask"), "edit", Some("a.py")));
        assert!(needs_native(m("ask"), "write_file", Some("a.py")));
        assert!(!needs_native(m("ask"), "read_file", Some("a.py")));
        // auto-edit: commands, and writes to the context files only.
        assert!(needs_native(m("auto-edit"), "run_shell", None));
        assert!(!needs_native(m("auto-edit"), "edit", Some("src/a.py")));
        assert!(needs_native(
            m("auto-edit"),
            "write_file",
            Some("MATTERWAVE.md")
        ));
        assert!(needs_native(m("auto-edit"), "edit", Some("agents.md")));
        assert!(!needs_native(
            m("auto-edit"),
            "edit",
            Some("docs/AGENTS.md")
        ));
        // yolo: nothing.
        for tool in ["run_shell", "edit", "write_file"] {
            assert!(
                !needs_native(m("yolo"), tool, Some("MATTERWAVE.md")),
                "{tool}"
            );
        }
        assert!(!widens(m("plan")) && !widens(m("ask")));
        assert!(widens(m("auto-edit")) && widens(m("yolo")));
        assert_eq!(
            mode_ask(m("auto-edit"), Path::new("/w")).accept,
            "Allow auto-edit"
        );
        assert_eq!(mode_ask(m("yolo"), Path::new("/w")).accept, "Allow yolo");
    }
}
