//! `run_shell`: one command in the workspace root, with a timeout, a cap on
//! the output, and a stop that takes the whole process tree with it.
//!
//! The tree is what makes Stop mean stop. A shell that started a test
//! runner that started a browser has three processes; killing the shell
//! alone leaves the other two running, holding the output pipes open. So
//! the command starts in a group of its own and the group is what gets
//! killed:
//!
//! - **Windows**: a job object with `KILL_ON_JOB_CLOSE`. Every process the
//!   command starts joins the job (unless it asks to break away, which the
//!   job does not allow), and terminating the job ends them all. The shell
//!   is created suspended, put in the job, and only then let run, so not
//!   even its first instruction runs outside the job. What the job cannot
//!   hold: a process another service starts on the command's behalf (WMI's
//!   `Win32_Process.Create`, the task scheduler, an elevated `-Verb RunAs`,
//!   a document handed to an already-running Explorer). Those outlive Stop.
//! - **Unix**: a process group (`setpgid(0, 0)` at spawn), killed with
//!   `SIGKILL` to the group. A process that calls `setsid` to leave the
//!   group escapes it; that is a daemon, and confinement is not a sandbox.
//!
//! When the command exits on its own the rest of its tree is ended too:
//! a background process it left behind would keep the pipes open and run
//! on after the run, unseen.
//!
//! The command inherits the app's environment, which is the person's,
//! minus any MatterWave credential in it (`MATTERWAVE_API_KEY` and the
//! like, `credential_vars`): the app keeps its own sign-in in the OS
//! keychain, never in the environment, and a command has no business with
//! a key the person exported for the SDK. That is hygiene, not a wall: a
//! command runs as the person and can read their keychain too.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    /// It exited on its own, with this code (none when a signal ended it).
    Exited(Option<i32>),
    TimedOut,
    Stopped,
}

#[derive(Debug)]
pub(crate) struct ShellResult {
    pub ended: Ended,
    /// stdout and stderr together, in arrival order, up to the cap.
    pub output: String,
    /// Bytes the command wrote in all, kept or not.
    pub total_bytes: usize,
}

impl ShellResult {
    pub fn truncated(&self, cap: usize) -> bool {
        self.total_bytes > cap
    }

    /// The tool result the model reads.
    pub fn render(&self, cap: usize, timeout: Duration) -> String {
        let head = match self.ended {
            Ended::Exited(Some(code)) => format!("Exit code: {code}"),
            Ended::Exited(None) => "Exit code: none (the process was ended by a signal)".into(),
            Ended::TimedOut => format!(
                "Stopped after {} s: the command ran past its timeout, and it and its child processes were ended.",
                timeout.as_secs()
            ),
            Ended::Stopped => {
                "Stopped by the user: the command and its child processes were ended.".into()
            }
        };
        let mut out = head;
        out.push('\n');
        if self.output.is_empty() {
            out.push_str("(no output)");
        } else {
            out.push_str(&self.output);
        }
        if self.truncated(cap) {
            out.push_str(&format!(
                "\n[Output cut off at {cap} bytes; the command wrote {} bytes in all.]",
                self.total_bytes
            ));
        }
        out
    }
}

/// The command's output, kept up to `cap` bytes; the rest is read and
/// counted but dropped, so a chatty command never blocks on a full pipe.
struct Capped {
    kept: Vec<u8>,
    total: usize,
    cap: usize,
}

async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin, sink: Arc<Mutex<Capped>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut s = sink.lock().unwrap_or_else(|e| e.into_inner());
                s.total += n;
                let room = s.cap.saturating_sub(s.kept.len());
                let take = room.min(n);
                s.kept.extend_from_slice(&chunk[..take]);
            }
        }
    }
}

/// The process group (Unix) or job (Windows) the command runs in.
/// Killed when `kill` is called and, failing that, when it is dropped: a
/// call whose future is dropped part way (the webview went away) still
/// takes the tree with it. On Windows the job's last handle closing does
/// the same (`KILL_ON_JOB_CLOSE`).
struct Tree {
    #[cfg(unix)]
    pgid: Option<i32>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Tree {
    fn kill(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid.take() {
            // SAFETY: kill(2) with a negative pid signals the group; it has
            // no memory effects on this process.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Whether an environment variable holds a MatterWave credential the
/// command should not inherit: `MATTERWAVE_*` or `MW_*` naming a key, a
/// token, a secret or a password.
pub(crate) fn is_credential_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    (upper.starts_with("MATTERWAVE_") || upper.starts_with("MW_"))
        && ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
            .iter()
            .any(|w| upper.contains(w))
}

/// The credential variables in this process's environment, by name.
fn credential_vars() -> Vec<std::ffi::OsString> {
    std::env::vars_os()
        .map(|(name, _)| name)
        .filter(|name| is_credential_var(&name.to_string_lossy()))
        .collect()
}

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object that ends every process in it when it is terminated or
    /// when its last handle closes.
    pub(super) struct Job(HANDLE);

    // SAFETY: a job handle is a kernel handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Job> {
            // SAFETY: plain Win32 calls on a handle this function owns; the
            // limit struct is zeroed and then filled as the API documents.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn assign(&self, process: HANDLE) -> std::io::Result<()> {
            // SAFETY: both handles are live for the duration of the call.
            if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn terminate(&self) {
            // SAFETY: the job handle is live until Drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    /// Lets a process created suspended run: resumes each of its threads
    /// (a fresh process has the one). An error when there was none to
    /// resume, so a process that never started is not waited on.
    pub fn resume(pid: u32) -> std::io::Result<()> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        use windows_sys::Win32::System::Threading::{
            OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        };
        // SAFETY: a snapshot handle and thread handles this function opens
        // and closes; the entry struct is sized as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut resumed = 0;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            if resumed == 0 {
                return Err(std::io::Error::other("no thread of the command to start"));
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing the last handle also ends whatever is left in
            // the job (KILL_ON_JOB_CLOSE).
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Resolves once the run's stop flag is set (or its sender is gone, which
/// means the run is over too).
pub(crate) async fn stopped(mut stop: watch::Receiver<bool>) {
    loop {
        if *stop.borrow_and_update() {
            return;
        }
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Run `command` with `argv` before it (the contract's shell for this
/// platform) in `cwd`. Ends on exit, on `timeout`, or when `stop` turns
/// true, and in the last two cases the whole tree is killed first.
pub(crate) async fn run(
    argv: &[&str],
    command: &str,
    cwd: &std::path::Path,
    timeout: Duration,
    cap: usize,
    stop: watch::Receiver<bool>,
) -> Result<ShellResult, String> {
    let (program, prefix) = argv
        .split_first()
        .ok_or_else(|| "no shell configured".to_string())?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(prefix)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in credential_vars() {
        cmd.env_remove(name);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        // No console window flashing up behind a GUI app; and suspended,
        // so it joins the job before it runs at all.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    // The job exists before the process does, so a failure to make one is
    // a refusal to run rather than a command that cannot be stopped.
    #[cfg(windows)]
    let job = job::Job::new().map_err(|e| format!("could not make a job object: {e}"))?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {program}: {e}"))?;

    #[cfg(windows)]
    let mut tree = {
        let handle = child
            .raw_handle()
            .ok_or_else(|| "the shell exited before it could be tracked".to_string())?;
        if let Err(e) = job.assign(handle as _) {
            let _ = child.start_kill();
            return Err(format!("could not track the command's processes: {e}"));
        }
        let tree = Tree { job: Some(job) };
        if let Err(e) = child.id().map_or_else(
            || Err(std::io::Error::other("the shell has no process id")),
            job::resume,
        ) {
            // Dropping the tree ends the suspended shell with its job.
            return Err(format!("could not start the command: {e}"));
        }
        tree
    };
    #[cfg(unix)]
    let mut tree = Tree {
        pgid: child.id().map(|id| id as i32),
    };

    let sink = Arc::new(Mutex::new(Capped {
        kept: Vec::new(),
        total: 0,
        cap,
    }));
    let readers = {
        let out = child
            .stdout
            .take()
            .map(|p| tokio::spawn(drain(p, sink.clone())));
        let err = child
            .stderr
            .take()
            .map(|p| tokio::spawn(drain(p, sink.clone())));
        async move {
            if let Some(t) = out {
                let _ = t.await;
            }
            if let Some(t) = err {
                let _ = t.await;
            }
        }
    };

    let ended = tokio::select! {
        status = child.wait() => Ended::Exited(status.ok().and_then(|s| s.code())),
        _ = tokio::time::sleep(timeout) => Ended::TimedOut,
        _ = stopped(stop) => Ended::Stopped,
    };
    // Whatever ended it, nothing of the tree outlives the call.
    tree.kill();
    if !matches!(ended, Ended::Exited(_)) {
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
    // Pipes close once every holder is gone; a straggler outside the tree
    // (one that broke away) cannot hold the answer hostage.
    let _ = tokio::time::timeout(Duration::from_secs(1), readers).await;

    let captured = sink.lock().unwrap_or_else(|e| e.into_inner());
    Ok(ShellResult {
        ended,
        output: String::from_utf8_lossy(&captured.kept).into_owned(),
        total_bytes: captured.total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::contract;
    use std::time::Instant;

    fn argv() -> &'static [&'static str] {
        contract::shell().1
    }

    fn never_stopped() -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        // Kept alive for the test's length: a dropped sender reads as stop.
        std::mem::forget(tx);
        rx
    }

    fn alive(pid: u32) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: signal 0 only checks that the process exists.
            unsafe { libc::kill(pid as i32, 0) == 0 }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            const STILL_ACTIVE: u32 = 259;
            // SAFETY: a query-only handle, closed before returning.
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    return false;
                }
                let mut code = 0u32;
                let ok = GetExitCodeProcess(h, &mut code);
                CloseHandle(h);
                ok != 0 && code == STILL_ACTIVE
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_exit_code_and_both_streams_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let command = if cfg!(windows) {
            "Write-Output out; [Console]::Error.WriteLine('err'); exit 3"
        } else {
            "echo out; echo err >&2; exit 3"
        };
        let r = run(
            argv(),
            command,
            dir.path(),
            Duration::from_secs(60),
            1024,
            never_stopped(),
        )
        .await
        .unwrap();
        assert_eq!(r.ended, Ended::Exited(Some(3)));
        assert!(r.output.contains("out"), "{}", r.output);
        assert!(r.output.contains("err"), "{}", r.output);
        assert!(r
            .render(1024, Duration::from_secs(60))
            .starts_with("Exit code: 3\n"));
    }

    #[test]
    fn matterwave_credentials_are_named_and_nothing_else() {
        for name in [
            "MATTERWAVE_API_KEY",
            "matterwave_api_key",
            "MW_TOKEN",
            "MW_OIDC_CLIENT_SECRET",
            "MATTERWAVE_REFRESH_TOKEN",
            "MW_DB_PASSWORD",
        ] {
            assert!(is_credential_var(name), "{name}");
        }
        for name in [
            "PATH",
            "MW_ENV",
            "MATTERWAVE_AGENT_CONTRACT",
            "OPENAI_API_KEY",
            "HOME",
        ] {
            assert!(!is_credential_var(name), "{name}");
        }
    }

    /// Attack: a command reading the app's environment for a MatterWave
    /// key the person exported for the SDK.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_matterwave_key_in_the_apps_environment_does_not_reach_the_command() {
        // SAFETY (edition 2024 makes this unsafe): no other test reads or
        // writes these two names.
        std::env::set_var("MATTERWAVE_API_KEY", "mw_live_secret");
        std::env::set_var("MW_AGENT_TEST_PLAIN", "kept");
        let dir = tempfile::tempdir().unwrap();
        let command = if cfg!(windows) {
            "Write-Output \"key=[$env:MATTERWAVE_API_KEY] plain=[$env:MW_AGENT_TEST_PLAIN]\""
        } else {
            "echo \"key=[$MATTERWAVE_API_KEY] plain=[$MW_AGENT_TEST_PLAIN]\""
        };
        let r = run(
            argv(),
            command,
            dir.path(),
            Duration::from_secs(60),
            1024,
            never_stopped(),
        )
        .await
        .unwrap();
        assert!(r.output.contains("key=[] plain=[kept]"), "{}", r.output);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn it_runs_in_the_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "here").unwrap();
        let command = if cfg!(windows) {
            "Get-Content marker.txt"
        } else {
            "cat marker.txt"
        };
        let r = run(
            argv(),
            command,
            dir.path(),
            Duration::from_secs(60),
            1024,
            never_stopped(),
        )
        .await
        .unwrap();
        assert!(r.output.contains("here"), "{}", r.output);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_output_is_cut_at_the_cap_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let command = if cfg!(windows) {
            "Write-Output ('x' * 200000)"
        } else {
            "head -c 200000 /dev/zero | tr '\\0' x"
        };
        let r = run(
            argv(),
            command,
            dir.path(),
            Duration::from_secs(60),
            65_536,
            never_stopped(),
        )
        .await
        .unwrap();
        assert_eq!(r.output.len(), 65_536);
        assert!(r.total_bytes >= 200_000, "{}", r.total_bytes);
        assert!(r
            .render(65_536, Duration::from_secs(60))
            .contains("[Output cut off at 65536 bytes"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_timeout_ends_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 60"
        } else {
            "sleep 60"
        };
        let started = Instant::now();
        let r = run(
            argv(),
            command,
            dir.path(),
            Duration::from_secs(1),
            1024,
            never_stopped(),
        )
        .await
        .unwrap();
        assert_eq!(r.ended, Ended::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    /// The acceptance case: Stop during a 60-second command ends it, and
    /// the child it started, within 2 s.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_kills_the_command_and_its_children_within_two_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let command = if cfg!(windows) {
            "$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','60','127.0.0.1'; Set-Content -Path child.pid -Value $p.Id; Start-Sleep -Seconds 60"
        } else {
            "sleep 60 & echo $! > child.pid; sleep 60"
        };
        let (tx, rx) = watch::channel(false);
        let cwd = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            run(argv(), command, &cwd, Duration::from_secs(120), 1024, rx).await
        });
        let pid_file = dir.path().join("child.pid");
        let deadline = Instant::now() + Duration::from_secs(30);
        let child_pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().trim_start_matches('\u{feff}').parse::<u32>().ok())
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "the command never started its child"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert!(alive(child_pid), "the child should be running before Stop");

        let stopped_at = Instant::now();
        tx.send(true).unwrap();
        let r = task.await.unwrap().unwrap();
        assert_eq!(r.ended, Ended::Stopped);
        assert!(
            stopped_at.elapsed() < Duration::from_secs(2),
            "Stop took {:?}",
            stopped_at.elapsed()
        );
        let gone_by = Instant::now() + Duration::from_secs(2);
        while alive(child_pid) {
            assert!(
                Instant::now() < gone_by,
                "the child {child_pid} outlived Stop by 2 s"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(stopped_at.elapsed() < Duration::from_secs(2));
    }
}
