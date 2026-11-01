//! The native tool host behind the SPA's agent mode: the only place a
//! file is read or written, or a command run, on the model's behalf.
//!
//! **Off by default.** Nothing here does anything until the person turns
//! agent mode on in Preferences, and turning it on is confirmed in a native
//! dialog the webview cannot answer for itself. The same goes for the
//! choices that widen what a run may do: the workspace root is picked in
//! the OS folder picker (the webview never names a path to work in), a
//! folder's context file is loaded only after a native "trust this
//! folder", and `yolo` asks natively once per app session and is never
//! saved.
//!
//! The webview gets one narrow command per tool (`agent_read_file` ...
//! `agent_run_shell`) plus start/stop of a run, the root picker and the
//! checkpoints -- each in the capability file by name, with no `fs`,
//! `shell` or `dialog` plugin behind them. Every path it sends is confined
//! here (confine.rs); every tool a run's mode does not offer is refused
//! here (`plan` is read-only whatever the webview asks); approval of each
//! write and command in `ask` mode is the SPA's diff and its buttons,
//! which is the one control that lives in the webview -- the README says
//! so for the security review (T-406).

pub(crate) mod checkpoints;
pub(crate) mod confine;
pub(crate) mod contract;
pub(crate) mod edit;
pub(crate) mod shell;
pub(crate) mod tools;

use contract::ModeSpec;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;
use tools::{ToolOutput, Workspace, WritePreview};

/// The settings file, in the app's config directory.
const SETTINGS_FILE: &str = "agent.json";

/// The context files read from a trusted root, in order: the project's,
/// the cross-tool one, and the person's own override (which they keep out
/// of git themselves).
const CONTEXT_FILES: &[&str] = &["MATTERWAVE.md", "AGENTS.md", "MATTERWAVE.local.md"];
/// How much of each context file goes to the model.
const CONTEXT_MAX_BYTES: usize = 64 * 1024;

/// What persists: whether agent mode is on, and the folders whose context
/// files the person trusts. Never the mode, and never `yolo`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub(crate) struct Settings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trusted_roots: Vec<String>,
}

pub(crate) fn load_settings_from(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_settings_to(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SETTINGS_FILE), raw).map_err(|e| e.to_string())
}

/// One agent run: its mode, fixed at the start, and its stop switch.
struct Run {
    mode: &'static ModeSpec,
    label: Option<String>,
    cancelled: AtomicBool,
    stop: watch::Sender<bool>,
}

impl Run {
    fn stop(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let _ = self.stop.send(true);
    }
}

pub(crate) struct AgentState {
    config_dir: PathBuf,
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    /// The workspace root, canonical, as the folder picker returned it. Per
    /// app session: a restart asks again.
    root: Mutex<Option<PathBuf>>,
    /// `yolo` was confirmed natively in this app session.
    yolo_confirmed: AtomicBool,
    runs: Mutex<HashMap<String, Arc<Run>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AgentState {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        let settings = load_settings_from(&config_dir);
        AgentState {
            config_dir,
            data_dir,
            settings: Mutex::new(settings),
            root: Mutex::new(None),
            yolo_confirmed: AtomicBool::new(false),
            runs: Mutex::new(HashMap::new()),
        }
    }

    fn enabled(&self) -> bool {
        lock(&self.settings).enabled
    }

    fn root(&self) -> Option<PathBuf> {
        lock(&self.root).clone()
    }

    fn trusted(&self, root: &Path) -> bool {
        let key = root.to_string_lossy();
        lock(&self.settings).trusted_roots.iter().any(|t| *t == key)
    }

    fn stop_all(&self) {
        for (_, run) in lock(&self.runs).drain() {
            run.stop();
        }
    }

    fn status(&self) -> AgentStatus {
        let root = self.root();
        AgentStatus {
            enabled: self.enabled(),
            trusted: root.as_deref().is_some_and(|r| self.trusted(r)),
            root: root.map(|r| r.to_string_lossy().into_owned()),
            platform: contract::platform(),
            shell: contract::shell().0,
            contract_version: contract::CONTRACT_VERSION,
            yolo_confirmed: self.yolo_confirmed.load(Ordering::Relaxed),
        }
    }

    /// The root, when agent mode is on and one is picked.
    fn workspace_root(&self) -> Result<PathBuf, String> {
        if !self.enabled() {
            return Err("Agent mode is off. Turn it on in Settings -> Preferences.".into());
        }
        self.root()
            .ok_or_else(|| "No workspace folder is chosen. Choose one first.".into())
    }

    /// The run and the root a tool call works in, or why it may not run.
    /// A tool the run's mode does not offer is answered for the model, not
    /// raised: the model asked for something the mode denies.
    fn for_tool(
        &self,
        run_id: &str,
        tool: &str,
    ) -> Result<Result<(Arc<Run>, PathBuf), ToolOutput>, String> {
        let root = self.workspace_root()?;
        let run = lock(&self.runs)
            .get(run_id)
            .cloned()
            .ok_or_else(|| "This agent run has ended or was stopped.".to_string())?;
        if run.cancelled.load(Ordering::Relaxed) {
            return Err("This agent run was stopped.".into());
        }
        if contract::tool(tool).is_none() || !run.mode.offers(tool) {
            return Ok(Err(ToolOutput::error(format!(
                "Refused: {tool} is not available in {} mode.",
                run.mode.name
            ))));
        }
        Ok(Ok((run, root)))
    }
}

#[derive(Serialize, Debug)]
pub(crate) struct AgentStatus {
    enabled: bool,
    /// The workspace root, when one is picked this session.
    root: Option<String>,
    /// Whether the root's context files are trusted.
    trusted: bool,
    platform: &'static str,
    shell: &'static str,
    contract_version: &'static str,
    yolo_confirmed: bool,
}

/// A native yes/no, which the webview cannot answer for the person. On
/// Linux the dialog runs on the GTK main thread, as the dialog plugin runs
/// its own.
async fn confirm(app: &AppHandle, title: &str, body: &str, ok: &str) -> bool {
    let ok_label = ok.to_string();
    let accepted = move |r: rfd::MessageDialogResult| match r {
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => true,
        rfd::MessageDialogResult::Custom(label) => label == ok_label,
        _ => false,
    };
    let window = app.get_webview_window("main");
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (title, body, ok) = (title.to_string(), body.to_string(), ok.to_string());
        let ran = app.run_on_main_thread(move || {
            let mut dialog = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title(title)
                .set_description(body)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(ok, "Cancel".into()));
            if let Some(w) = &window {
                dialog = dialog.set_parent(w);
            }
            let _ = tx.send(dialog.show());
        });
        if ran.is_err() {
            return false;
        }
        rx.await.map(accepted).unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut dialog = rfd::AsyncMessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title(title)
            .set_description(body)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                ok.to_string(),
                "Cancel".into(),
            ));
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        accepted(dialog.show().await)
    }
}

const ENABLE_BODY: &str = "Agent mode lets the model read files in a folder you choose and, with your approval, change them and run commands on this computer as you. Commands are not sandboxed. Everything the model reads is sent to MatterWave and the model's provider.\n\nThis is experimental and off by default; its security review (T-406) is not finished. Turn it on?";

/// What the webview may read of agent mode: on or off, the root picked this
/// session and whether it is trusted, and the platform's shell.
#[tauri::command]
pub(crate) fn agent_state(state: State<'_, AgentState>) -> AgentStatus {
    state.status()
}

/// Turn agent mode on (after a native confirmation) or off (at once, with
/// every run stopped and the root forgotten).
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_set_enabled(
    app: AppHandle,
    state: State<'_, AgentState>,
    enabled: bool,
) -> Result<AgentStatus, String> {
    if enabled == state.enabled() {
        return Ok(state.status());
    }
    if enabled && !confirm(&app, "Turn on agent mode?", ENABLE_BODY, "Turn on").await {
        return Ok(state.status());
    }
    let next = {
        let mut settings = lock(&state.settings);
        settings.enabled = enabled;
        settings.clone()
    };
    save_settings_to(&state.config_dir, &next)?;
    if !enabled {
        state.stop_all();
        *lock(&state.root) = None;
        state.yolo_confirmed.store(false, Ordering::Relaxed);
    }
    Ok(state.status())
}

/// Folders too broad to be a workspace: a filesystem root, or the whole
/// home directory, where the deny list is all that stands between the
/// model and every key and mailbox on the machine.
fn too_broad(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .and_then(|h| confine::resolve_links(&h).ok());
    home.is_some_and(|h| confine::within(&h, path))
}

/// Choose the workspace root in the OS folder picker. Cancelled, the state
/// is unchanged. A new root ends the runs that worked in the old one.
#[tauri::command]
pub(crate) async fn agent_pick_root(
    app: AppHandle,
    state: State<'_, AgentState>,
) -> Result<AgentStatus, String> {
    if !state.enabled() {
        return Err("Agent mode is off. Turn it on in Settings -> Preferences.".into());
    }
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Choose the agent's workspace folder");
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    if let Some(current) = state.root() {
        dialog = dialog.set_directory(current);
    }
    let Some(picked) = dialog.pick_folder().await else {
        return Ok(state.status());
    };
    let root = confine::resolve_links(picked.path())?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    if too_broad(&root) {
        return Err(format!(
            "{} is too broad to work in: choose a project folder, not a drive or your whole home folder.",
            root.display()
        ));
    }
    state.stop_all();
    *lock(&state.root) = Some(root);
    Ok(state.status())
}

/// Trust the root's context files (MATTERWAVE.md, AGENTS.md and the local
/// override), after a native confirmation; remembered for this folder.
#[tauri::command]
pub(crate) async fn agent_trust_root(
    app: AppHandle,
    state: State<'_, AgentState>,
) -> Result<AgentStatus, String> {
    let root = state.workspace_root()?;
    if state.trusted(&root) {
        return Ok(state.status());
    }
    let body = format!(
        "{}\n\nIts MATTERWAVE.md and AGENTS.md will be sent to the model with every agent run as instructions. A cloned project can put anything in them. Trust this folder only if you trust whoever wrote those files.",
        root.display()
    );
    if !confirm(&app, "Trust this folder?", &body, "Trust").await {
        return Ok(state.status());
    }
    let next = {
        let mut settings = lock(&state.settings);
        settings
            .trusted_roots
            .push(root.to_string_lossy().into_owned());
        settings.clone()
    };
    save_settings_to(&state.config_dir, &next)?;
    Ok(state.status())
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct ContextFile {
    path: String,
    text: String,
    truncated: bool,
}

#[derive(Serialize, Debug)]
pub(crate) struct RunStarted {
    run_id: String,
    mode: &'static str,
    root: String,
    platform: &'static str,
    /// The trusted root's context files, in order.
    context: Vec<ContextFile>,
    /// Context files that exist but were not loaded: the root is not trusted.
    untrusted_context: Vec<String>,
}

/// The context files of `root`: loaded when it is trusted, only named when
/// it is not. Each goes through confinement like any tool path.
pub(crate) fn context_files(root: &Path, trusted: bool) -> (Vec<ContextFile>, Vec<String>) {
    let deny = confine::DenyList::load(root);
    let mut loaded = Vec::new();
    let mut skipped = Vec::new();
    for name in CONTEXT_FILES {
        let Ok(target) = confine::confine(root, name, &deny, false) else {
            continue;
        };
        if !target.absolute.is_file() {
            continue;
        }
        if !trusted {
            skipped.push(target.relative);
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&target.absolute) else {
            continue;
        };
        let truncated = text.len() > CONTEXT_MAX_BYTES;
        let mut cut = text.len().min(CONTEXT_MAX_BYTES);
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        loaded.push(ContextFile {
            path: target.relative,
            text: text[..cut].to_string(),
            truncated,
        });
    }
    (loaded, skipped)
}

/// Start a run in `mode` in the picked root. `yolo` asks natively the first
/// time in an app session. `label` is the conversation the run is stored
/// in, which its checkpoints carry.
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_start_run(
    app: AppHandle,
    state: State<'_, AgentState>,
    mode: String,
    label: Option<String>,
) -> Result<RunStarted, String> {
    let root = state.workspace_root()?;
    let spec = contract::mode(&mode).ok_or_else(|| format!("unknown approval mode {mode:?}"))?;
    if spec.requires_flag && !state.yolo_confirmed.load(Ordering::Relaxed) {
        let body = format!(
            "In yolo mode the agent changes files and runs commands in {} without asking you first, for the rest of this session. Commands are not sandboxed.",
            root.display()
        );
        if !confirm(&app, "Allow yolo for this session?", &body, "Allow yolo").await {
            return Err("yolo was not allowed. Pick another mode.".into());
        }
        state.yolo_confirmed.store(true, Ordering::Relaxed);
    }
    let run_id: String = {
        use rand::Rng;
        let bytes: [u8; 12] = rand::thread_rng().gen();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };
    let (stop, _) = watch::channel(false);
    lock(&state.runs).insert(
        run_id.clone(),
        Arc::new(Run {
            mode: spec,
            label,
            cancelled: AtomicBool::new(false),
            stop,
        }),
    );
    let trusted = state.trusted(&root);
    let (context, untrusted_context) = context_files(&root, trusted);
    Ok(RunStarted {
        run_id,
        mode: spec.name,
        root: root.to_string_lossy().into_owned(),
        platform: contract::platform(),
        context,
        untrusted_context,
    })
}

/// Stop a run: a running command and its children are killed, a search
/// stops at its next file, and every later call on the run is refused. Also
/// how the SPA ends a run that finished.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn agent_stop_run(state: State<'_, AgentState>, run_id: String) {
    if let Some(run) = lock(&state.runs).remove(&run_id) {
        run.stop();
    }
}

/// Runs a read tool on the blocking pool, so a long walk never holds the
/// async runtime.
async fn read_tool(
    state: &AgentState,
    run_id: &str,
    tool: &'static str,
    args: serde_json::Value,
    work: fn(&Workspace, serde_json::Value) -> ToolOutput,
) -> Result<ToolOutput, String> {
    let (run, root) = match state.for_tool(run_id, tool)? {
        Ok(found) => found,
        Err(refused) => return Ok(refused),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Workspace::new(&root, &run.cancelled);
        work(&ws, args)
    })
    .await
    .map_err(|e| e.to_string())
}

macro_rules! parsed {
    ($tool:literal, $args:expr) => {
        match tools::parse_args($tool, $args) {
            Ok(a) => a,
            Err(e) => return e,
        }
    };
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_read_file(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    read_tool(&state, &run_id, "read_file", args, |ws, a| {
        tools::read_file(ws, parsed!("read_file", a))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_list_dir(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    read_tool(&state, &run_id, "list_dir", args, |ws, a| {
        tools::list_dir(ws, parsed!("list_dir", a))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_glob(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    read_tool(&state, &run_id, "glob", args, |ws, a| {
        tools::glob(ws, parsed!("glob", a))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_grep(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    read_tool(&state, &run_id, "grep", args, |ws, a| {
        tools::grep(ws, parsed!("grep", a))
    })
    .await
}

/// A write's answer: the preview the approval shows, the applied change, or
/// the reason it could not be made (for the model).
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum WriteOutcome {
    Preview(WritePreview),
    Applied {
        output: String,
        relative: String,
        checkpoint: u64,
    },
    Error {
        output: String,
    },
}

/// Preview or apply one write. Apply recomputes the change from the file as
/// it is now and refuses when its bytes are not the ones the preview saw
/// (`expected_sha256`), so what lands is exactly the diff that was shown;
/// a checkpoint of the file is taken first, and without one nothing is
/// written.
pub(crate) fn write_step(
    ws: &Workspace,
    data_dir: &Path,
    label: Option<&str>,
    tool: &'static str,
    preview: impl Fn(&Workspace) -> Result<(confine::Confined, WritePreview), ToolOutput>,
    apply: bool,
    expected_sha256: Option<&str>,
) -> WriteOutcome {
    let (target, shown) = match preview(ws) {
        Ok(p) => p,
        Err(e) => return WriteOutcome::Error { output: e.output },
    };
    if !apply {
        return WriteOutcome::Preview(shown);
    }
    if expected_sha256.is_some_and(|expected| expected != shown.before_sha256) {
        return WriteOutcome::Error {
            output: format!(
                "{} changed after the change was shown, so nothing was written. Read it again and redo the change.",
                shown.relative
            ),
        };
    }
    let store = checkpoints::Store::for_root(data_dir, ws.root);
    let checkpoint = match store.snapshot(
        tool,
        label,
        &[(target.absolute.clone(), target.relative.clone())],
        crate::now(),
    ) {
        Ok(c) => c,
        Err(e) => {
            return WriteOutcome::Error {
                output: format!("Nothing was written: {e}"),
            }
        }
    };
    if let Err(e) = tools::write_confined(&target, &shown.after) {
        return WriteOutcome::Error {
            output: format!("{} could not be written: {e}", shown.relative),
        };
    }
    let output = match (tool, shown.before.is_some()) {
        ("edit", _) => format!("Edited {}.", shown.relative),
        (_, true) => format!("Wrote {} ({} bytes).", shown.relative, shown.after.len()),
        (_, false) => format!("Created {} ({} bytes).", shown.relative, shown.after.len()),
    };
    WriteOutcome::Applied {
        output,
        relative: shown.relative,
        checkpoint: checkpoint.id,
    }
}

async fn write_tool(
    state: &AgentState,
    run_id: &str,
    tool: &'static str,
    args: serde_json::Value,
    apply: bool,
    expected_sha256: Option<String>,
) -> Result<WriteOutcome, String> {
    let (run, root) = match state.for_tool(run_id, tool)? {
        Ok(found) => found,
        Err(refused) => {
            return Ok(WriteOutcome::Error {
                output: refused.output,
            })
        }
    };
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Workspace::new(&root, &run.cancelled);
        let label = run.label.as_deref();
        let expected = expected_sha256.as_deref();
        match tool {
            "edit" => match tools::parse_args::<tools::EditArgs>(tool, args) {
                Ok(a) => write_step(
                    &ws,
                    &data_dir,
                    label,
                    tool,
                    |w| tools::preview_edit(w, &a),
                    apply,
                    expected,
                ),
                Err(e) => WriteOutcome::Error { output: e.output },
            },
            _ => match tools::parse_args::<tools::WriteFileArgs>(tool, args) {
                Ok(a) => write_step(
                    &ws,
                    &data_dir,
                    label,
                    tool,
                    |w| tools::preview_write(w, &a),
                    apply,
                    expected,
                ),
                Err(e) => WriteOutcome::Error { output: e.output },
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_edit(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
    apply: bool,
    expected_sha256: Option<String>,
) -> Result<WriteOutcome, String> {
    write_tool(&state, &run_id, "edit", args, apply, expected_sha256).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_write_file(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
    apply: bool,
    expected_sha256: Option<String>,
) -> Result<WriteOutcome, String> {
    write_tool(&state, &run_id, "write_file", args, apply, expected_sha256).await
}

/// The timeout a `run_shell` call asked for, checked against the schema.
pub(crate) fn shell_timeout(asked: Option<u64>) -> Result<Duration, ToolOutput> {
    let secs = asked.unwrap_or(contract::SHELL_TIMEOUT_S_DEFAULT);
    if !(1..=contract::SHELL_TIMEOUT_S_MAX).contains(&secs) {
        return Err(ToolOutput::error(format!(
            "timeout_s must be between 1 and {} seconds.",
            contract::SHELL_TIMEOUT_S_MAX
        )));
    }
    Ok(Duration::from_secs(secs))
}

/// Run one command in the root with the platform's shell. Stop on the run
/// kills it and everything it started (shell.rs).
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_run_shell(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    let (run, root) = match state.for_tool(&run_id, "run_shell")? {
        Ok(found) => found,
        Err(refused) => return Ok(refused),
    };
    let args: tools::RunShellArgs = match tools::parse_args("run_shell", args) {
        Ok(a) => a,
        Err(e) => return Ok(e),
    };
    if args.command.trim().is_empty() {
        return Ok(ToolOutput::error("The command is empty."));
    }
    let timeout = match shell_timeout(args.timeout_s) {
        Ok(t) => t,
        Err(e) => return Ok(e),
    };
    let cap = contract::SHELL_OUTPUT_MAX_BYTES;
    let result = shell::run(
        contract::shell().1,
        &args.command,
        &root,
        timeout,
        cap,
        run.stop.subscribe(),
    )
    .await;
    Ok(match result {
        Ok(r) => ToolOutput {
            is_error: !matches!(r.ended, shell::Ended::Exited(Some(0))),
            output: r.render(cap, timeout),
        },
        Err(e) => ToolOutput::error(format!("The command could not run: {e}")),
    })
}

/// This root's checkpoints, newest first.
#[tauri::command]
pub(crate) fn agent_checkpoints(
    state: State<'_, AgentState>,
) -> Result<Vec<checkpoints::Checkpoint>, String> {
    let root = state.workspace_root()?;
    Ok(checkpoints::Store::for_root(&state.data_dir, &root).list())
}

#[derive(Serialize, Debug)]
pub(crate) struct Restored {
    restored: Vec<String>,
}

/// Put the root's files back as they were before checkpoint `checkpoint_id`
/// (and undo every later one with it).
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_restore(
    state: State<'_, AgentState>,
    checkpoint_id: u64,
) -> Result<Restored, String> {
    let root = state.workspace_root()?;
    let store = checkpoints::Store::for_root(&state.data_dir, &root);
    tauri::async_runtime::spawn_blocking(move || store.restore(&root, checkpoint_id))
        .await
        .map_err(|e| e.to_string())?
        .map(|restored| Restored { restored })
}

/// The commands this module adds, for build.rs's allow-list and the
/// capability file: one per tool, the run's start and stop, the root, the
/// switch and the checkpoints. Kept here so a test can hold the three
/// lists together.
#[cfg(test)]
pub(crate) const COMMANDS: &[&str] = &[
    "agent_state",
    "agent_set_enabled",
    "agent_pick_root",
    "agent_trust_root",
    "agent_start_run",
    "agent_stop_run",
    "agent_read_file",
    "agent_list_dir",
    "agent_glob",
    "agent_grep",
    "agent_edit",
    "agent_write_file",
    "agent_run_shell",
    "agent_checkpoints",
    "agent_restore",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn state_in(dir: &Path) -> AgentState {
        AgentState::new(dir.join("config"), dir.join("data"))
    }

    fn start(state: &AgentState, mode: &str) -> String {
        let spec = contract::mode(mode).unwrap();
        let (stop, _) = watch::channel(false);
        let id = format!("run-{mode}");
        lock(&state.runs).insert(
            id.clone(),
            Arc::new(Run {
                mode: spec,
                label: None,
                cancelled: AtomicBool::new(false),
                stop,
            }),
        );
        id
    }

    #[test]
    fn agent_mode_is_off_until_the_setting_says_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_in(dir.path());
        assert!(!state.status().enabled);
        assert!(state
            .workspace_root()
            .err()
            .unwrap()
            .contains("Agent mode is off"));
        // A run id that somehow exists still finds the switch off first.
        start(&state, "yolo");
        assert!(state.for_tool("run-yolo", "run_shell").is_err());

        save_settings_to(
            &dir.path().join("config"),
            &Settings {
                enabled: true,
                trusted_roots: vec![],
            },
        )
        .unwrap();
        assert!(
            state_in(dir.path()).status().enabled,
            "the setting persists"
        );
    }

    #[test]
    fn plan_refuses_writes_and_commands_whatever_the_webview_asks() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_in(dir.path());
        lock(&state.settings).enabled = true;
        *lock(&state.root) = Some(dir.path().to_path_buf());
        let run = start(&state, "plan");
        for tool in ["edit", "write_file", "run_shell", "web_fetch"] {
            let refused = state.for_tool(&run, tool).unwrap().err().unwrap();
            assert_eq!(
                refused.output,
                format!("Refused: {tool} is not available in plan mode.")
            );
        }
        for tool in ["read_file", "list_dir", "glob", "grep"] {
            assert!(state.for_tool(&run, tool).unwrap().is_ok(), "{tool}");
        }
        let ask = start(&state, "ask");
        assert!(state.for_tool(&ask, "run_shell").unwrap().is_ok());
    }

    #[test]
    fn a_stopped_run_refuses_every_later_call() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_in(dir.path());
        lock(&state.settings).enabled = true;
        *lock(&state.root) = Some(dir.path().to_path_buf());
        let run = start(&state, "ask");
        lock(&state.runs).get(&run).unwrap().stop();
        let refused = state.for_tool(&run, "read_file").err().unwrap();
        assert!(refused.contains("stopped"), "{refused}");
        state.stop_all();
        assert!(state.for_tool(&run, "read_file").is_err());
    }

    #[test]
    fn an_apply_writes_exactly_what_was_shown_and_checkpoints_first() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = confine::resolve_links(dir.path()).unwrap();
        std::fs::write(root.join("a.py"), "x = 1\n").unwrap();
        let stopped = AtomicBool::new(false);
        let ws = Workspace::new(&root, &stopped);
        let args = tools::EditArgs {
            path: "a.py".into(),
            old_string: "1".into(),
            new_string: "2".into(),
        };
        let preview = write_step(
            &ws,
            data.path(),
            None,
            "edit",
            |w| tools::preview_edit(w, &args),
            false,
            None,
        );
        let WriteOutcome::Preview(shown) = preview else {
            panic!("{preview:?}")
        };
        // Rejected: nothing else is called, and the file is byte-identical.
        assert_eq!(std::fs::read(root.join("a.py")).unwrap(), b"x = 1\n");

        // Changed underneath between the diff and the apply: refused.
        std::fs::write(root.join("a.py"), "x = 1  \n").unwrap();
        let stale = write_step(
            &ws,
            data.path(),
            None,
            "edit",
            |w| tools::preview_edit(w, &args),
            true,
            Some(&shown.before_sha256),
        );
        assert!(
            matches!(stale, WriteOutcome::Error { ref output } if output.contains("changed after")),
            "{stale:?}"
        );
        assert_eq!(std::fs::read(root.join("a.py")).unwrap(), b"x = 1  \n");

        std::fs::write(root.join("a.py"), "x = 1\n").unwrap();
        let applied = write_step(
            &ws,
            data.path(),
            Some("c1"),
            "edit",
            |w| tools::preview_edit(w, &args),
            true,
            Some(&shown.before_sha256),
        );
        let WriteOutcome::Applied { checkpoint, .. } = applied else {
            panic!("{applied:?}")
        };
        assert_eq!(
            std::fs::read_to_string(root.join("a.py")).unwrap(),
            "x = 2\n"
        );
        let store = checkpoints::Store::for_root(data.path(), &root);
        assert_eq!(store.list()[0].id, checkpoint);
        assert_eq!(store.list()[0].label.as_deref(), Some("c1"));
    }

    #[test]
    fn write_file_creates_parents_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = confine::resolve_links(dir.path()).unwrap();
        let stopped = AtomicBool::new(false);
        let ws = Workspace::new(&root, &stopped);
        let args = tools::WriteFileArgs {
            path: "new/dir/f.txt".into(),
            content: "hi".into(),
        };
        let out = write_step(
            &ws,
            data.path(),
            None,
            "write_file",
            |w| tools::preview_write(w, &args),
            true,
            Some("absent"),
        );
        assert!(
            matches!(out, WriteOutcome::Applied { ref output, .. } if output.starts_with("Created new/dir/f.txt")),
            "{out:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("new/dir/f.txt")).unwrap(),
            "hi"
        );
    }

    #[test]
    fn context_files_load_only_in_a_trusted_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = confine::resolve_links(dir.path()).unwrap();
        std::fs::write(root.join("MATTERWAVE.md"), "Use tabs.").unwrap();
        std::fs::write(root.join("AGENTS.md"), "Run make test.").unwrap();
        let (loaded, skipped) = context_files(&root, false);
        assert!(loaded.is_empty());
        assert_eq!(skipped, vec!["MATTERWAVE.md", "AGENTS.md"]);
        let (loaded, skipped) = context_files(&root, true);
        assert!(skipped.is_empty());
        assert_eq!(
            loaded.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
            vec!["MATTERWAVE.md", "AGENTS.md"]
        );
        assert_eq!(loaded[0].text, "Use tabs.");
    }

    #[test]
    fn the_shell_timeout_is_checked_against_the_schema() {
        assert_eq!(shell_timeout(None).unwrap(), Duration::from_secs(120));
        assert!(shell_timeout(Some(0)).is_err());
        assert!(shell_timeout(Some(601)).is_err());
        assert_eq!(shell_timeout(Some(600)).unwrap(), Duration::from_secs(600));
    }

    #[test]
    fn a_drive_or_the_home_folder_is_too_broad_to_be_a_root() {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
        let home = confine::resolve_links(Path::new(&home)).unwrap();
        assert!(too_broad(&home));
        let top: PathBuf = home
            .components()
            .take(if cfg!(windows) { 2 } else { 1 })
            .collect();
        assert!(too_broad(&top), "{top:?}");
        // A folder under home (the temp dir often is) is a fine root; only
        // home itself and what contains it are not.
        let project = tempfile::tempdir().unwrap();
        assert!(!too_broad(&confine::resolve_links(project.path()).unwrap()));
    }

    /// The commands the webview may call: build.rs declares each, the
    /// capability file grants each, and nothing else agent-shaped is there
    /// -- no fs, shell or dialog plugin permission.
    #[test]
    fn the_capability_file_grants_exactly_the_agent_commands_and_no_plugins() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let build = std::fs::read_to_string(Path::new(manifest).join("build.rs")).unwrap();
        let capability: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(manifest).join("capabilities/default.json"))
                .unwrap(),
        )
        .unwrap();
        let granted: Vec<String> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect();
        for command in COMMANDS {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "build.rs misses {command}"
            );
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(
                granted.contains(&permission),
                "the capability misses {permission}"
            );
        }
        let agent_grants = granted
            .iter()
            .filter(|p| p.starts_with("allow-agent-"))
            .count();
        assert_eq!(
            agent_grants,
            COMMANDS.len(),
            "an agent permission not in COMMANDS"
        );
        for p in &granted {
            assert!(
                !(p.starts_with("fs:") || p.starts_with("shell:") || p.starts_with("dialog:")),
                "{p} would hand the webview a plugin"
            );
        }
    }
}
