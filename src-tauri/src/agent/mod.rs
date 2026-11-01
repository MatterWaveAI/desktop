//! The native tool host behind the SPA's agent mode: the only place a
//! file is read or written, or a command run, on the model's behalf.
//!
//! **Off by default.** Nothing here does anything until the person turns
//! agent mode on in Preferences, and turning it on is confirmed in a native
//! dialog the webview cannot answer for itself. The same goes for the
//! choices that widen what a run may do: the workspace root is picked in
//! the OS folder picker (the webview never names a path to work in), a
//! folder's context file is loaded only after a native "trust this
//! folder", and `auto-edit` and `yolo` each ask natively once per folder
//! per app session (`yolo` is never saved).
//!
//! **The org's switch is the host's to check.** Before a run starts the
//! host asks MatterWave itself, with the stored credential, whether the
//! person's organisation allows local agent tools (`/api/me`'s
//! `local_agent_tools`), and refuses the run when it says no -- the
//! webview's own greyed-out toggle is a courtesy, not the control.
//!
//! The webview gets one narrow command per tool (`agent_read_file` ...
//! `agent_run_shell`) plus start/stop of a run, the root picker and the
//! checkpoints -- each in the capability file by name, with no `fs`,
//! `shell` or `dialog` plugin behind them. Every path it sends is confined
//! here (confine.rs); every tool a run's mode does not offer is refused
//! here (`plan` is read-only whatever the webview asks); every command and
//! write the mode asks about, every protected write in every mode, and
//! every read of a read-gated path in a mode not confirmed for the folder,
//! is approved in a native dialog here (approval.rs), not in the webview;
//! and every answer is written to the approval log (audit.rs).
//!
//! The commands are thin: each hands its arguments to a method of
//! `AgentState`, which is what the tests drive, with a scripted
//! `Confirmer` in place of the dialog and a scripted org check.

pub(crate) mod approval;
pub(crate) mod audit;
pub(crate) mod checkpoints;
pub(crate) mod confine;
pub(crate) mod contract;
pub(crate) mod edit;
pub(crate) mod output;
pub(crate) mod search;
pub(crate) mod shell;
pub(crate) mod tools;

use approval::{Ask, Confirmer, Decision};
use audit::{Answer, Asked, AuditLog};
use confine::{Access, DenyList};
use contract::{ApprovalRefusal, ModeSpec, ToolFailure, CONTEXT_FILES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;
use tools::{ToolOutput, Workspace, WritePreview};

/// The settings file, in the app's config directory.
const SETTINGS_FILE: &str = "agent.json";

/// How much of each context file is read. The prompt keeps the contract's
/// 32768 characters of each (the SPA's `systemPrompt` cuts it, with the
/// contract's marker); this is that many characters at four bytes each, so
/// the host never cuts first.
const CONTEXT_MAX_BYTES: usize = 32_768 * 4;

/// What follows a tool's result when the person approved the call in the
/// native dialog and the run is stored, so the conversation on the server
/// keeps the record too.
pub(crate) const APPROVED_NOTE: &str =
    "[The user approved this call in the MatterWave desktop app's own dialog.]";

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

/// What MatterWave says of the person's organisation and local agent
/// tools: `Some(false)` is the org's no, `Some(true)` its yes, `None` an
/// API that does not say (an older one, which counts as allowed), and an
/// error that the host could not ask (signed out, offline), which refuses
/// the run: a check that cannot be made is not passed.
pub(crate) type OrgVerdict = Pin<Box<dyn Future<Output = Result<Option<bool>, String>> + Send>>;

/// Asks MatterWave for the org's verdict. The app's (lib.rs) fetches
/// `/api/me` with the stored credential; the tests' is a script.
pub(crate) type OrgCheck = Arc<dyn Fn() -> OrgVerdict + Send + Sync>;

/// `/api/me`'s `local_agent_tools`, read as the SDKs' `local_agent_tools_of`
/// reads it: only an explicit boolean says anything.
pub(crate) fn local_agent_tools_of(me: &serde_json::Value) -> Option<bool> {
    me.get("local_agent_tools")
        .and_then(serde_json::Value::as_bool)
}

const ORG_OFF: &str = "Your organisation has turned off local agent tools, so agent mode cannot run. The desktop app asked MatterWave itself; ask an organisation admin if you need it.";

/// One agent run: its mode, fixed at the start, and its stop switch.
struct Run {
    mode: &'static ModeSpec,
    label: Option<String>,
    cancelled: AtomicBool,
    stop: watch::Sender<bool>,
}

impl Run {
    fn new(mode: &'static ModeSpec, label: Option<String>) -> Run {
        let (stop, _) = watch::channel(false);
        Run {
            mode,
            label,
            cancelled: AtomicBool::new(false),
            stop,
        }
    }

    fn stop(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let _ = self.stop.send(true);
    }

    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// A question about one of this run's calls, as the approval log
    /// records it.
    fn asked(&self, question: &'static str, tool: &str, root: &Path) -> Asked {
        Asked {
            question,
            tool: Some(tool.to_string()),
            mode: Some(self.mode.name.to_string()),
            root: Some(root.display().to_string()),
            conversation: self.label.clone(),
            ..Asked::default()
        }
    }

    /// `output` with the approval note when the run is stored.
    fn noted(&self, output: String) -> String {
        if self.label.is_some() {
            format!("{output}\n{APPROVED_NOTE}")
        } else {
            output
        }
    }
}

const STOPPED: &str = "This agent run was stopped.";

pub(crate) struct AgentState {
    config_dir: PathBuf,
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    /// The workspace root, canonical, as the folder picker returned it. Per
    /// app session: a restart asks again.
    root: Mutex<Option<PathBuf>>,
    /// The modes that let writes through unasked (`auto-edit`, `yolo`) the
    /// person allowed natively for this root in this app session.
    widened: Mutex<Vec<&'static str>>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
    /// One native question on screen at a time, so each answer belongs to
    /// the question it was shown with.
    asking: tokio::sync::Mutex<()>,
    confirmer: Confirmer,
    audit: AuditLog,
    org: OrgCheck,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `work` on the blocking pool, so a long walk or a big write never
/// holds the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())
}

/// What the read gate makes of one call.
enum Gate {
    /// Not a read-gated path, or the run's mode is confirmed: go on, with
    /// a walk still leaving gated paths out when the run is gated.
    Clear,
    /// The person said yes to reading this path: go on, gate open.
    Approved,
    /// The person said no: the answer for the model.
    Refused(ToolOutput),
}

impl AgentState {
    pub fn new(
        config_dir: PathBuf,
        data_dir: PathBuf,
        confirmer: Confirmer,
        org: OrgCheck,
    ) -> Self {
        let settings = load_settings_from(&config_dir);
        AgentState {
            audit: AuditLog::new(data_dir.clone()),
            config_dir,
            data_dir,
            settings: Mutex::new(settings),
            root: Mutex::new(None),
            widened: Mutex::new(Vec::new()),
            runs: Mutex::new(HashMap::new()),
            asking: tokio::sync::Mutex::new(()),
            confirmer,
            org,
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

    fn widened_to(&self, mode: &str) -> bool {
        lock(&self.widened).contains(&mode)
    }

    /// Whether a run in `mode` reads the read-gated paths only with the
    /// person's yes: every mode they have not confirmed natively for this
    /// folder this session (`plan` and `ask`, which start unasked).
    fn gated(&self, mode: &ModeSpec) -> bool {
        !self.widened_to(mode.name)
    }

    fn stop_all(&self) {
        for (_, run) in lock(&self.runs).drain() {
            run.stop();
        }
    }

    /// A new root: every run in the old one ends, and the modes allowed
    /// for the old one are asked about again.
    fn set_root(&self, root: Option<PathBuf>) {
        self.stop_all();
        lock(&self.widened).clear();
        *lock(&self.root) = root;
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
            yolo_confirmed: self.widened_to("yolo"),
            auto_edit_confirmed: self.widened_to("auto-edit"),
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
        if run.stopped() {
            return Err(STOPPED.into());
        }
        if contract::tool(tool).is_none() {
            return Ok(Err(ToolOutput::error(
                ApprovalRefusal::UnknownTool.message(tool, run.mode.name, ""),
            )));
        }
        if !run.mode.offers(tool) {
            return Ok(Err(ToolOutput::error(ApprovalRefusal::Mode.message(
                tool,
                run.mode.name,
                "",
            ))));
        }
        Ok(Ok((run, root)))
    }

    /// After a native yes, before acting on it: the run is still live, agent
    /// mode still on, and the root the one the question named.
    fn still(&self, run_id: &str, tool: &str, root: &Path) -> Result<(), String> {
        match self.for_tool(run_id, tool)? {
            Ok((_, now)) if now == root => Ok(()),
            Ok(_) => Err(
                "The workspace folder changed while you were asked, so nothing was done.".into(),
            ),
            Err(refused) => Err(refused.output),
        }
    }

    /// Puts one question to the person, after any already on screen, and
    /// writes the answer to the approval log. A yes that cannot be written
    /// there is not acted on.
    async fn ask(&self, ask: Ask, asked: Asked) -> Result<bool, String> {
        let _turn = self.asking.lock().await;
        let yes = (self.confirmer)(ask).await;
        let answer = if yes {
            Answer::Approved
        } else {
            Answer::Rejected
        };
        match self.audit.append(&asked, answer, crate::now()) {
            Ok(()) => Ok(yes),
            Err(e) if yes => Err(format!(
                "Nothing was done: your yes could not be written to the approval log ({e})."
            )),
            Err(_) => Ok(false),
        }
    }

    /// A question about one call of `run`. Stopping the run answers it: a
    /// stopped run's call does not go ahead whatever is clicked later (the
    /// dialog itself stays until it is answered; its answer is dropped, and
    /// the log says the run stopped).
    async fn ask_for(&self, run: &Run, ask: Ask, asked: Asked) -> Result<bool, String> {
        let on_stop = asked.clone();
        let answer = tokio::select! {
            biased;
            _ = shell::stopped(run.stop.subscribe()) => {
                let _ = self.audit.append(&on_stop, Answer::Stopped, crate::now());
                return Err(STOPPED.into());
            }
            answer = self.ask(ask, asked) => answer?,
        };
        if run.stopped() {
            return Err(STOPPED.into());
        }
        Ok(answer)
    }

    /// Where `path` leads, relative to the root, when the run is gated and
    /// that is a read-gated path (by its name or where its links lead);
    /// `None` otherwise.
    async fn gated_target(
        &self,
        run: &Run,
        root: &Path,
        path: &str,
    ) -> Result<Option<String>, String> {
        if !self.gated(run.mode) {
            return Ok(None);
        }
        let (at, path) = (root.to_path_buf(), path.to_string());
        blocking(move || {
            let deny = DenyList::load(&at);
            confine::confine(&at, &path, &deny, Access::Read)
                .ok()
                .filter(approval::is_read_gated)
                .map(|c| c.relative)
        })
        .await
    }

    /// The read gate for one call that reads `path` (or, for a write's
    /// preview, hands its current text to the webview): in a gated run, a
    /// read-gated path is read only after the person's native yes.
    async fn read_gate(
        &self,
        run: &Run,
        root: &Path,
        tool: &str,
        path: Option<String>,
    ) -> Result<Gate, String> {
        let Some(path) = path else {
            return Ok(Gate::Clear);
        };
        let Some(relative) = self.gated_target(run, root, &path).await? else {
            return Ok(Gate::Clear);
        };
        let asked = Asked {
            path: Some(relative.clone()),
            ..run.asked("read", tool, root)
        };
        let ask = approval::read_ask(root, tool, &relative, run.mode.name);
        if self.ask_for(run, ask, asked).await? {
            Ok(Gate::Approved)
        } else {
            Ok(Gate::Refused(ToolOutput::rejected(
                ApprovalRefusal::Rejected.message(tool, run.mode.name, &relative),
            )))
        }
    }

    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<AgentStatus, String> {
        if enabled == self.enabled() {
            return Ok(self.status());
        }
        if enabled
            && !self
                .ask(
                    Ask {
                        title: "Turn on agent mode?".into(),
                        body: ENABLE_BODY.into(),
                        accept: "Turn on".into(),
                    },
                    Asked {
                        question: "enable",
                        ..Asked::default()
                    },
                )
                .await?
        {
            return Ok(self.status());
        }
        let next = {
            let mut settings = lock(&self.settings);
            settings.enabled = enabled;
            settings.clone()
        };
        save_settings_to(&self.config_dir, &next)?;
        if !enabled {
            self.set_root(None);
        }
        Ok(self.status())
    }

    pub(crate) async fn trust_root(&self) -> Result<AgentStatus, String> {
        let root = self.workspace_root()?;
        if self.trusted(&root) {
            return Ok(self.status());
        }
        let body = format!(
            "{}\n\nIts MATTERWAVE.md, MATTERWAVE.local.md and AGENTS.md will be sent to the model with every agent run as instructions. A cloned project can put anything in them. Trust this folder only if you trust whoever wrote those files.",
            approval::visible(&root.display().to_string())
        );
        let ask = Ask {
            title: "Trust this folder?".into(),
            body,
            accept: "Trust".into(),
        };
        let asked = Asked {
            question: "trust",
            root: Some(root.display().to_string()),
            ..Asked::default()
        };
        if !self.ask(ask, asked).await? || self.root().as_deref() != Some(root.as_path()) {
            return Ok(self.status());
        }
        let next = {
            let mut settings = lock(&self.settings);
            settings
                .trusted_roots
                .push(root.to_string_lossy().into_owned());
            settings.clone()
        };
        save_settings_to(&self.config_dir, &next)?;
        Ok(self.status())
    }

    /// Starts a run in `mode` in the picked root, once MatterWave has said
    /// the person's organisation allows local agent tools. A mode that lets
    /// writes through unasked is allowed natively first, once per root per
    /// app session.
    pub(crate) async fn start_run(
        &self,
        mode: &str,
        label: Option<String>,
    ) -> Result<RunStarted, String> {
        let root = self.workspace_root()?;
        let spec = contract::mode(mode).ok_or_else(|| format!("unknown approval mode {mode:?}"))?;
        match (self.org)().await {
            Ok(Some(false)) => return Err(ORG_OFF.into()),
            Ok(_) => {}
            Err(e) => {
                return Err(format!(
                    "The run did not start: the desktop app could not ask MatterWave whether your organisation allows local agent tools ({e})."
                ))
            }
        }
        let allowed = !approval::widens(spec) || self.widened_to(spec.name);
        if !allowed {
            let asked = Asked {
                question: "mode",
                mode: Some(spec.name.to_string()),
                root: Some(root.display().to_string()),
                conversation: label.clone(),
                ..Asked::default()
            };
            if !self.ask(approval::mode_ask(spec, &root), asked).await? {
                return Err(format!("{} was not allowed. Pick another mode.", spec.name));
            }
            if self.workspace_root()? != root {
                return Err(
                    "The workspace folder changed while you were asked. Start again.".into(),
                );
            }
            lock(&self.widened).push(spec.name);
        }
        let run_id: String = {
            use rand::Rng;
            let bytes: [u8; 12] = rand::thread_rng().gen();
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        };
        lock(&self.runs).insert(run_id.clone(), Arc::new(Run::new(spec, label)));
        let trusted = self.trusted(&root);
        let context_root = root.clone();
        let (context, untrusted_context) =
            blocking(move || context_files(&context_root, trusted)).await?;
        Ok(RunStarted {
            run_id,
            mode: spec.name,
            root: root.to_string_lossy().into_owned(),
            platform: contract::platform(),
            context,
            untrusted_context,
        })
    }

    pub(crate) fn stop_run(&self, run_id: &str) {
        if let Some(run) = lock(&self.runs).remove(run_id) {
            run.stop();
        }
    }

    /// One read tool. In a run whose mode the person has not confirmed for
    /// the folder, a read-gated `path` asks natively first, and a search
    /// leaves the gated paths out.
    pub(crate) async fn read(
        &self,
        run_id: &str,
        tool: &'static str,
        args: serde_json::Value,
        work: fn(&Workspace, serde_json::Value) -> ToolOutput,
    ) -> Result<ToolOutput, String> {
        let (run, root) = match self.for_tool(run_id, tool)? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let path = args
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let (gated, approved) = match self.read_gate(&run, &root, tool, path).await? {
            Gate::Refused(no) => return Ok(no),
            Gate::Approved => {
                self.still(run_id, tool, &root)?;
                (false, true)
            }
            Gate::Clear => (self.gated(run.mode), false),
        };
        let worker = run.clone();
        let mut out = blocking(move || {
            let ws = Workspace::new(&root, &worker.cancelled).gated(gated);
            work(&ws, args)
        })
        .await?;
        if approved {
            out.output = run.noted(out.output);
        }
        Ok(out)
    }

    /// Preview or apply one write.
    ///
    /// An apply names the preview it applies by the fingerprint of the
    /// bytes that preview saw (`expected_sha256`); without one it is
    /// refused. When the mode asks, or the file is protected, the person is
    /// asked natively with the full path and the changed lines as they are
    /// now; after a yes the change is computed once more and written only
    /// if the file is still byte for byte what the question showed, so
    /// neither the webview nor a change on disk while the question was open
    /// can slip in something else. A checkpoint of the file is taken first,
    /// and without one nothing is written. A preview hands the file's text
    /// to the webview, so in a gated run it is held to the read gate.
    pub(crate) async fn write(
        &self,
        run_id: &str,
        tool: &'static str,
        args: serde_json::Value,
        apply: bool,
        expected_sha256: Option<String>,
    ) -> Result<WriteOutcome, String> {
        let (run, root) = match self.for_tool(run_id, tool)? {
            Ok(found) => found,
            Err(refused) => {
                return Ok(WriteOutcome::Error {
                    output: refused.output,
                })
            }
        };
        let change = match WriteArgs::parse(tool, args) {
            Ok(c) => Arc::new(c),
            Err(e) => return Ok(WriteOutcome::Error { output: e.output }),
        };
        let in_ws = |work: Box<dyn FnOnce(&Workspace) -> WriteOutcome + Send>| {
            let (run, root) = (run.clone(), root.clone());
            blocking(move || work(&Workspace::new(&root, &run.cancelled)))
        };
        if !apply {
            match self
                .read_gate(&run, &root, tool, Some(change.path().to_string()))
                .await?
            {
                Gate::Refused(no) => return Ok(WriteOutcome::Rejected { output: no.output }),
                Gate::Approved => self.still(run_id, tool, &root)?,
                Gate::Clear => {}
            }
            let change = change.clone();
            return in_ws(Box::new(move |ws| {
                match change.preview(ws, Access::ApprovedWrite) {
                    Ok((_, shown)) => WriteOutcome::Preview(shown),
                    Err(e) => WriteOutcome::Error { output: e.output },
                }
            }))
            .await;
        }
        let Some(expected) = expected_sha256 else {
            return Ok(WriteOutcome::Error {
                output: "Nothing was written: an apply must name the preview it applies (expected_sha256).".into(),
            });
        };
        let prepared = {
            let change = change.clone();
            let (run, root) = (run.clone(), root.clone());
            blocking(move || prepare(&Workspace::new(&root, &run.cancelled), &change, &expected))
                .await?
        };
        let (protected, shown) = match prepared {
            Ok(prepared) => prepared,
            // In a gated run an apply's failure on a read-gated file would
            // say what the file holds without the person's yes (an edit's
            // text not found, or found n times), so it says only that the
            // change no longer matches the file.
            Err(outcome) => {
                return Ok(match self.gated_target(&run, &root, change.path()).await? {
                    Some(relative) => changed_since(&relative),
                    None => outcome,
                })
            }
        };
        let mut approved = false;
        if approval::decision_for(run.mode, tool, protected) == Decision::Ask {
            let asked = Asked {
                path: Some(shown.relative.clone()),
                ..run.asked("tool", tool, &root)
            };
            if !self
                .ask_for(&run, approval::write_ask(&root, &shown), asked)
                .await?
            {
                return Ok(WriteOutcome::Rejected {
                    output: ApprovalRefusal::Rejected.message(tool, run.mode.name, &shown.relative),
                });
            }
            self.still(run_id, tool, &root)?;
            approved = true;
        }
        let access = if approved {
            Access::ApprovedWrite
        } else {
            Access::Write
        };
        let data_dir = self.data_dir.clone();
        let label = run.label.clone();
        let outcome = in_ws(Box::new(move |ws| {
            commit(
                ws,
                &data_dir,
                label.as_deref(),
                tool,
                &change,
                &shown,
                access,
            )
        }))
        .await?;
        Ok(match outcome {
            WriteOutcome::Applied {
                output,
                relative,
                checkpoint,
            } if approved => WriteOutcome::Applied {
                output: run.noted(output),
                relative,
                checkpoint,
            },
            other => other,
        })
    }

    /// Runs one command in the root with the platform's shell, after the
    /// person's native yes when the mode asks. Stop on the run kills it and
    /// everything it started (shell.rs).
    pub(crate) async fn run_shell(
        &self,
        run_id: &str,
        args: serde_json::Value,
    ) -> Result<ToolOutput, String> {
        let (run, root) = match self.for_tool(run_id, "run_shell")? {
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
        let mut approved = false;
        if approval::decision(run.mode, "run_shell", None) == Decision::Ask {
            if let Err(why) = approval::command_fits(&args.command) {
                return Ok(ToolOutput::error(why));
            }
            let asked = Asked {
                command_sha256: Some(tools::hex(&Sha256::digest(args.command.as_bytes()))),
                ..run.asked("tool", "run_shell", &root)
            };
            let ask = approval::shell_ask(&args.command, &root, timeout);
            if !self.ask_for(&run, ask, asked).await? {
                return Ok(ToolOutput::rejected(ApprovalRefusal::Rejected.message(
                    "run_shell",
                    run.mode.name,
                    "",
                )));
            }
            self.still(run_id, "run_shell", &root)?;
            approved = true;
        }
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
            Ok(r) => {
                let output = r.render(cap, timeout);
                ToolOutput {
                    is_error: !matches!(r.ended, shell::Ended::Exited(Some(0))),
                    output: if approved { run.noted(output) } else { output },
                    rejected: false,
                }
            }
            Err(e) => ToolOutput::error(format!("The command could not run: {e}")),
        })
    }

    pub(crate) fn checkpoints(&self) -> Result<Vec<checkpoints::Checkpoint>, String> {
        let root = self.workspace_root()?;
        Ok(checkpoints::Store::for_root(&self.data_dir, &root).list())
    }

    /// Puts the root's files back as they were before `checkpoint_id` (and
    /// undoes every later one with it), once the person says yes natively
    /// to the list of files it puts back. That yes covers protected files
    /// among them.
    pub(crate) async fn restore(&self, checkpoint_id: u64) -> Result<Restored, String> {
        let root = self.workspace_root()?;
        let store = checkpoints::Store::for_root(&self.data_dir, &root);
        let files = store.files_restored_by(checkpoint_id)?;
        let asked = Asked {
            question: "restore",
            path: Some(files.join(", ")),
            root: Some(root.display().to_string()),
            ..Asked::default()
        };
        if !self
            .ask(approval::restore_ask(&root, checkpoint_id, &files), asked)
            .await?
        {
            return Err("Nothing was restored: you cancelled it.".into());
        }
        if self.workspace_root()? != root {
            return Err(
                "The workspace folder changed while you were asked, so nothing was restored."
                    .into(),
            );
        }
        blocking(move || store.restore(&root, checkpoint_id))
            .await?
            .map(|restored| Restored { restored })
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
    auto_edit_confirmed: bool,
}

const ENABLE_BODY: &str = "Agent mode lets the model read files in a folder you choose and, with your approval, change them and run commands on this computer as you. Commands are not sandboxed. Everything the model reads is sent to MatterWave and the model's provider.\n\nThis is experimental and off by default; its security review is not finished. Turn it on?";

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
    state: State<'_, AgentState>,
    enabled: bool,
) -> Result<AgentStatus, String> {
    state.set_enabled(enabled).await
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
    if !state.enabled() {
        return Err("Agent mode is off. Turn it on in Settings -> Preferences.".into());
    }
    state.set_root(Some(root));
    Ok(state.status())
}

/// Trust the root's context files (MATTERWAVE.md, MATTERWAVE.local.md and
/// AGENTS.md), after a native confirmation; remembered for this folder.
#[tauri::command]
pub(crate) async fn agent_trust_root(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    state.trust_root().await
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
    /// The trusted root's context files, in the contract's order.
    context: Vec<ContextFile>,
    /// Context files that exist but were not loaded: the root is not trusted.
    untrusted_context: Vec<String>,
}

/// The context files of `root`, in the contract's order (MATTERWAVE.md,
/// MATTERWAVE.local.md, AGENTS.md; where two disagree the later wins):
/// loaded when it is trusted, only named when it is not. Each goes through
/// confinement like any tool path, and only the first `CONTEXT_MAX_BYTES`
/// of each is read.
pub(crate) fn context_files(root: &Path, trusted: bool) -> (Vec<ContextFile>, Vec<String>) {
    let deny = DenyList::load(root);
    let mut loaded = Vec::new();
    let mut skipped = Vec::new();
    for name in CONTEXT_FILES {
        let Ok(target) = confine::confine(root, name, &deny, Access::Read) else {
            continue;
        };
        if !target.absolute.is_file() {
            continue;
        }
        if !trusted {
            skipped.push(target.relative);
            continue;
        }
        let Ok(mut bytes) = std::fs::File::open(&target.absolute).and_then(|f| {
            use std::io::Read;
            let mut bytes = Vec::new();
            f.take(CONTEXT_MAX_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        }) else {
            continue;
        };
        let truncated = bytes.len() > CONTEXT_MAX_BYTES;
        bytes.truncate(CONTEXT_MAX_BYTES);
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            // Cut inside a character: drop the partial one.
            Err(e) if truncated => {
                let valid = e.utf8_error().valid_up_to();
                let mut bytes = e.into_bytes();
                bytes.truncate(valid);
                String::from_utf8(bytes).unwrap_or_default()
            }
            Err(_) => continue,
        };
        loaded.push(ContextFile {
            path: target.relative,
            text,
            truncated,
        });
    }
    (loaded, skipped)
}

/// Start a run in `mode` in the picked root. The org's switch is checked
/// with MatterWave first; `auto-edit` and `yolo` ask natively the first
/// time for the root in an app session. `label` is the conversation the
/// run is stored in, which its checkpoints and approval log lines carry.
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_start_run(
    state: State<'_, AgentState>,
    mode: String,
    label: Option<String>,
) -> Result<RunStarted, String> {
    state.start_run(&mode, label).await
}

/// Stop a run: a running command and its children are killed, an open
/// question about it is answered no, a search stops at its next file, and
/// every later call on the run is refused. Also how the SPA ends a run
/// that finished.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn agent_stop_run(state: State<'_, AgentState>, run_id: String) {
    state.stop_run(&run_id);
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
    state
        .read(&run_id, "read_file", args, |ws, a| {
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
    state
        .read(&run_id, "list_dir", args, |ws, a| {
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
    state
        .read(&run_id, "glob", args, |ws, a| {
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
    state
        .read(&run_id, "grep", args, |ws, a| {
            tools::grep(ws, parsed!("grep", a))
        })
        .await
}

/// A write's answer: the preview the panel shows, the applied change, the
/// person's no in the native dialog, or the reason it could not be made
/// (each of the last two for the model).
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum WriteOutcome {
    Preview(WritePreview),
    Applied {
        output: String,
        relative: String,
        checkpoint: u64,
    },
    Rejected {
        output: String,
    },
    Error {
        output: String,
    },
}

/// A write's arguments, parsed.
pub(crate) enum WriteArgs {
    Edit(tools::EditArgs),
    Write(tools::WriteFileArgs),
}

impl WriteArgs {
    fn parse(tool: &str, args: serde_json::Value) -> Result<WriteArgs, ToolOutput> {
        match tool {
            "edit" => tools::parse_args(tool, args).map(WriteArgs::Edit),
            _ => tools::parse_args(tool, args).map(WriteArgs::Write),
        }
    }

    fn path(&self) -> &str {
        match self {
            WriteArgs::Edit(a) => &a.path,
            WriteArgs::Write(a) => &a.path,
        }
    }

    fn preview(
        &self,
        ws: &Workspace,
        access: Access,
    ) -> Result<(confine::Confined, WritePreview), ToolOutput> {
        match self {
            WriteArgs::Edit(a) => tools::preview_edit(ws, a, access),
            WriteArgs::Write(a) => tools::preview_write(ws, a, access),
        }
    }
}

fn changed_since(relative: &str) -> WriteOutcome {
    WriteOutcome::Error {
        output: format!(
            "{relative} changed after the change was shown, so nothing was written. Read it again and redo the change."
        ),
    }
}

/// The change as it would be made now, held to the preview it applies: the
/// file's bytes must be the ones that preview saw. Also whether the file is
/// protected, by its name or where its links lead, which makes the write
/// ask in every mode.
pub(crate) fn prepare(
    ws: &Workspace,
    change: &WriteArgs,
    expected_sha256: &str,
) -> Result<(bool, WritePreview), WriteOutcome> {
    let (target, shown) = change
        .preview(ws, Access::ApprovedWrite)
        .map_err(|e| WriteOutcome::Error { output: e.output })?;
    if shown.before_sha256 != expected_sha256 {
        return Err(changed_since(&shown.relative));
    }
    Ok((target.matched_by(&DenyList::protected()), shown))
}

/// Writes the change, computed once more, if it is still exactly the one
/// approved: the same file, the same bytes before, the same bytes after.
/// `access` is `ApprovedWrite` only after the person's native yes, so a
/// protected path is never reached otherwise. Checkpoints the file first;
/// without a checkpoint nothing is written.
pub(crate) fn commit(
    ws: &Workspace,
    data_dir: &Path,
    label: Option<&str>,
    tool: &'static str,
    change: &WriteArgs,
    approved: &WritePreview,
    access: Access,
) -> WriteOutcome {
    let (target, now) = match change.preview(ws, access) {
        Ok(p) => p,
        Err(e) => return WriteOutcome::Error { output: e.output },
    };
    if now.relative != approved.relative
        || now.before_sha256 != approved.before_sha256
        || now.after != approved.after
    {
        return changed_since(&approved.relative);
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
    if let Err(e) = tools::write_confined(&target, ws.root, now.after.as_bytes()) {
        return WriteOutcome::Error {
            output: format!("{} could not be written: {e}", now.relative),
        };
    }
    let output = match (tool, now.before.is_some()) {
        ("edit", _) => format!("Edited {}.", now.relative),
        (_, true) => format!("Wrote {} ({} bytes).", now.relative, now.after.len()),
        (_, false) => format!("Created {} ({} bytes).", now.relative, now.after.len()),
    };
    WriteOutcome::Applied {
        output,
        relative: now.relative,
        checkpoint: checkpoint.id,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_edit(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
    apply: bool,
    expected_sha256: Option<String>,
) -> Result<WriteOutcome, String> {
    state
        .write(&run_id, "edit", args, apply, expected_sha256)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_write_file(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
    apply: bool,
    expected_sha256: Option<String>,
) -> Result<WriteOutcome, String> {
    state
        .write(&run_id, "write_file", args, apply, expected_sha256)
        .await
}

/// The timeout a `run_shell` call asked for, checked against the schema:
/// a whole number of seconds from 1 to the contract's maximum.
pub(crate) fn shell_timeout(asked: Option<f64>) -> Result<Duration, ToolOutput> {
    let max = contract::SHELL_TIMEOUT_S_MAX;
    let Some(secs) = asked else {
        return Ok(Duration::from_secs(contract::SHELL_TIMEOUT_S_DEFAULT));
    };
    if secs.fract() != 0.0 || !(1.0..=max as f64).contains(&secs) {
        return Err(ToolOutput::error(
            ToolFailure::BadTimeout.message(&[("max", &max.to_string())]),
        ));
    }
    Ok(Duration::from_secs(secs as u64))
}

/// Run one command in the root with the platform's shell, once approved.
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_run_shell(
    state: State<'_, AgentState>,
    run_id: String,
    args: serde_json::Value,
) -> Result<ToolOutput, String> {
    state.run_shell(&run_id, args).await
}

/// This root's checkpoints, newest first.
#[tauri::command]
pub(crate) fn agent_checkpoints(
    state: State<'_, AgentState>,
) -> Result<Vec<checkpoints::Checkpoint>, String> {
    state.checkpoints()
}

#[derive(Serialize, Debug)]
pub(crate) struct Restored {
    restored: Vec<String>,
}

/// Put the root's files back as they were before checkpoint `checkpoint_id`
/// (and undo every later one with it), after a native confirmation.
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn agent_restore(
    state: State<'_, AgentState>,
    checkpoint_id: u64,
) -> Result<Restored, String> {
    state.restore(checkpoint_id).await
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
mod conformance;
#[cfg(test)]
mod tests;
