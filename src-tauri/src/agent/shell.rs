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
//! - **Linux**, besides, best effort: when the app runs in a cgroup v2 the
//!   person owns (a systemd user session delegates one to each app), the
//!   command starts in a cgroup of its own under it, joined in the child
//!   before `exec`, and Stop writes `cgroup.kill`, which ends every process
//!   in it, `setsid` or double fork included. Where the cgroup cannot be
//!   made (no delegation, cgroup v1, a container) the process group is all
//!   there is. A child subreaper (`PR_SET_CHILD_SUBREAPER`) is not used: it
//!   would adopt every detached process the app starts, the browser opened
//!   for sign-in among them, and still could not tell one run's from
//!   another's.
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

use super::output::{format_shell_parts, Limits, ShellEnd};
use std::collections::VecDeque;
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
    /// stdout and stderr together, in arrival order: the first `cap` bytes.
    pub head: Vec<u8>,
    /// The last `cap` bytes, for output longer than the cap (else empty).
    pub tail: Vec<u8>,
    /// Bytes the command wrote in all, kept or not.
    pub total_bytes: usize,
}

impl ShellResult {
    pub fn truncated(&self, cap: usize) -> bool {
        self.total_bytes > cap
    }

    /// The tool result the model reads, as the contract's `outputs.shell`
    /// spells it: the status line, then the output, its middle cut out
    /// past `cap` with the marker counting the bytes left out.
    pub fn render(&self, cap: usize, timeout: Duration) -> String {
        let end = match self.ended {
            Ended::Exited(code) => ShellEnd::Exited(code),
            Ended::TimedOut => ShellEnd::TimedOut(timeout.as_secs()),
            Ended::Stopped => ShellEnd::Stopped,
        };
        let limits = Limits {
            shell_output_max_bytes: cap,
            ..Limits::default()
        };
        // The raw bytes, so the cut and its count are in bytes as written.
        let tail: &[u8] = if self.truncated(cap) { &self.tail } else { b"" };
        format_shell_parts(end, &self.head, tail, self.total_bytes, &limits)
    }
}

/// The command's output as it is kept: its first `cap` bytes and its last
/// `cap` bytes; the rest is read and counted but dropped, so a chatty
/// command never blocks on a full pipe and memory stays bounded.
struct Capped {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
    cap: usize,
}

impl Capped {
    fn take(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let room = self.cap.saturating_sub(self.head.len());
        self.head.extend_from_slice(&chunk[..room.min(chunk.len())]);
        self.tail.extend(chunk.iter().copied());
        if self.tail.len() > self.cap {
            let extra = self.tail.len() - self.cap;
            self.tail.drain(..extra);
        }
    }
}

async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin, sink: Arc<Mutex<Capped>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => sink
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(&chunk[..n]),
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
    #[cfg(target_os = "linux")]
    cgroup: Option<cgroup::Group>,
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
        #[cfg(target_os = "linux")]
        if let Some(group) = &self.cgroup {
            group.kill();
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

/// Linux: the command's own cgroup v2, under the app's, when the app's is
/// the person's to divide (delegated, as a systemd user session does for
/// each app). Best effort throughout: any step that fails leaves the
/// command with its process group alone.
#[cfg(target_os = "linux")]
pub(crate) mod cgroup {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    pub(crate) struct Group {
        path: PathBuf,
        /// `<group>/cgroup.procs`, ready for the child to open between
        /// fork and exec, where nothing may allocate.
        procs: CString,
    }

    impl Group {
        /// A fresh, empty group under the app's own, or `None` where one
        /// cannot be made.
        pub fn new() -> Option<Group> {
            let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
            // cgroup v2 alone: one line, `0::/the/path`.
            let relative = own.lines().find_map(|l| l.strip_prefix("0::"))?;
            let base = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
            let path = base.join(format!("matterwave-agent-{:016x}", rand::random::<u64>()));
            std::fs::create_dir(&path).ok()?;
            let procs = CString::new(path.join("cgroup.procs").as_os_str().as_bytes()).ok();
            match procs {
                Some(procs) => Some(Group { path, procs }),
                None => {
                    let _ = std::fs::remove_dir(&path);
                    None
                }
            }
        }

        /// The path the child writes its pid to.
        pub fn procs(&self) -> CString {
            self.procs.clone()
        }

        /// Moves the calling process into the group whose `cgroup.procs` is
        /// `procs`. Called in the child after fork and before exec, so it
        /// uses only async-signal-safe calls and no allocation.
        pub fn join(procs: &CString) {
            // SAFETY: getpid, open, write and close are async-signal-safe;
            // the buffer is on the stack.
            unsafe {
                let mut digits = [0u8; 20];
                let mut pid = libc::getpid() as u64;
                let mut at = digits.len();
                loop {
                    at -= 1;
                    digits[at] = b'0' + (pid % 10) as u8;
                    pid /= 10;
                    if pid == 0 {
                        break;
                    }
                }
                let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                if fd >= 0 {
                    libc::write(fd, digits[at..].as_ptr().cast(), digits.len() - at);
                    libc::close(fd);
                }
            }
        }

        /// Ends every process in the group: `cgroup.kill` (Linux 5.14) at
        /// once, else each pid `cgroup.procs` lists, until it lists none.
        pub fn kill(&self) {
            if std::fs::write(self.path.join("cgroup.kill"), "1").is_ok() {
                return;
            }
            for _ in 0..20 {
                let Ok(listed) = std::fs::read_to_string(self.path.join("cgroup.procs")) else {
                    return;
                };
                let pids: Vec<i32> = listed
                    .lines()
                    .filter_map(|l| l.trim().parse().ok())
                    .collect();
                if pids.is_empty() {
                    return;
                }
                for pid in pids {
                    // SAFETY: kill(2) on a pid the group lists.
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
    }

    impl Drop for Group {
        /// The group is removed once it is empty, on a thread of its own
        /// so the wait never holds the async runtime.
        fn drop(&mut self) {
            self.kill();
            let path = self.path.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    if std::fs::remove_dir(&path).is_ok() || !path.exists() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
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
    #[cfg(target_os = "linux")]
    let group = cgroup::Group::new();
    #[cfg(target_os = "linux")]
    if let Some(group) = &group {
        let procs = group.procs();
        // SAFETY: the closure runs in the child between fork and exec and
        // does only what `Group::join` documents as safe there.
        unsafe {
            cmd.pre_exec(move || {
                cgroup::Group::join(&procs);
                Ok(())
            });
        }
    }
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
        #[cfg(target_os = "linux")]
        cgroup: group,
    };

    let sink = Arc::new(Mutex::new(Capped {
        head: Vec::new(),
        tail: VecDeque::new(),
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
    let truncated = captured.total > cap;
    Ok(ShellResult {
        ended,
        head: captured.head.clone(),
        tail: if truncated {
            captured.tail.iter().copied().collect()
        } else {
            Vec::new()
        },
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
        let text = r.render(1024, Duration::from_secs(60));
        assert!(text.starts_with("Exit code 3\n"), "{text}");
        assert!(text.contains("out") && text.contains("err"), "{text}");
    }

    #[test]
    fn the_capture_keeps_the_first_and_last_cap_bytes() {
        let mut c = Capped {
            head: Vec::new(),
            tail: VecDeque::new(),
            total: 0,
            cap: 10,
        };
        c.take(b"0123456");
        c.take(b"789ABC");
        assert_eq!(c.total, 13);
        assert_eq!(c.head, b"0123456789");
        assert_eq!(c.tail.iter().copied().collect::<Vec<u8>>(), b"3456789ABC");
        let r = ShellResult {
            ended: Ended::Exited(Some(0)),
            head: c.head.clone(),
            tail: c.tail.iter().copied().collect(),
            total_bytes: c.total,
        };
        assert_eq!(
            r.render(10, Duration::from_secs(1)),
            "Exit code 0\n01234\n[... 3 bytes of output cut from the middle ...]\n89ABC"
        );
        let quiet = ShellResult {
            ended: Ended::Exited(None),
            head: Vec::new(),
            tail: Vec::new(),
            total_bytes: 0,
        };
        assert_eq!(
            quiet.render(10, Duration::from_secs(1)),
            "Exit code none: the process was ended by a signal.\n(no output)"
        );
    }

    /// The contract's `shell` cases with `omitted` give a client's kept
    /// ends; the host keeps the first and last `cap` bytes of the stream,
    /// so the same output streamed through its capture must read the same.
    /// A case that keeps less than half the cap at an end is one the host
    /// never produces, and is left to `format_shell_kept`.
    #[test]
    fn the_capture_reads_as_the_contracts_omitted_cases() {
        let contract: serde_json::Value =
            serde_json::from_str(crate::agent::contract::CONTRACT_JSON).unwrap();
        let mut checked = 0;
        for case in contract["conformance"]["shell"].as_array().unwrap() {
            let Some(omitted) = case["omitted"].as_u64() else {
                continue;
            };
            let cap = case["limits"]["shell_output_max_bytes"]
                .as_u64()
                .map_or(crate::agent::contract::SHELL_OUTPUT_MAX_BYTES, |c| {
                    c as usize
                });
            let kept = case["output"].as_str().unwrap().as_bytes();
            let half = cap / 2;
            if kept.len() < half + (cap - half) {
                continue;
            }
            let mut stream = kept[..half].to_vec();
            stream.extend(std::iter::repeat_n(b'.', omitted as usize));
            stream.extend_from_slice(&kept[half..]);
            let mut c = Capped {
                head: Vec::new(),
                tail: VecDeque::new(),
                total: 0,
                cap,
            };
            for chunk in stream.chunks(3) {
                c.take(chunk);
            }
            let r = ShellResult {
                ended: Ended::Exited(case["exit_code"].as_i64().map(|n| n as i32)),
                head: c.head.clone(),
                tail: c.tail.iter().copied().collect(),
                total_bytes: c.total,
            };
            assert_eq!(
                r.render(cap, Duration::from_secs(1)),
                case["expected"].as_str().unwrap(),
                "{case}"
            );
            checked += 1;
        }
        assert_eq!(
            checked, 2,
            "the two cases that keep half the cap at each end"
        );
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
        let text = r.render(1024, Duration::from_secs(60));
        assert!(text.contains("key=[] plain=[kept]"), "{text}");
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
        assert!(r.render(1024, Duration::from_secs(60)).contains("here"));
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
        assert_eq!((r.head.len(), r.tail.len()), (65_536, 65_536));
        assert!(r.total_bytes >= 200_000, "{}", r.total_bytes);
        let text = r.render(65_536, Duration::from_secs(60));
        let omitted = r.total_bytes - 65_536;
        assert!(
            text.contains(&format!(
                "\n[... {omitted} bytes of output cut from the middle ...]\n"
            )),
            "{}",
            &text[..200]
        );
        // The head and the tail, a half each, around the marker.
        let (head, rest) = text.split_once("\n[...").unwrap();
        assert_eq!(head.len(), "Exit code 0\n".len() + 32_768);
        assert!(rest.trim_end().ends_with('x'));
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
        assert!(r
            .render(1024, Duration::from_secs(1))
            .starts_with("Stopped after 1 s: the command ran past its timeout"));
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

    /// Linux, where the app's cgroup is the person's to divide: a process
    /// that leaves the process group with `setsid` still ends on Stop.
    /// Skipped (and says so) where no cgroup can be made, as on CI runners.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_ends_a_process_that_called_setsid_when_a_cgroup_can_be_made() {
        if cgroup::Group::new().is_none() {
            eprintln!("skipped: no delegated cgroup v2 here");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let command = "setsid sleep 60 & echo $! > child.pid; sleep 60";
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
                .and_then(|s| s.trim().parse::<u32>().ok())
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "the command never started its child"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        tx.send(true).unwrap();
        task.await.unwrap().unwrap();
        let gone_by = Instant::now() + Duration::from_secs(2);
        while alive(child_pid) {
            assert!(
                Instant::now() < gone_by,
                "the setsid child {child_pid} outlived Stop"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
