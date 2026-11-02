//! The approval log: every answer the person gives to a native question
//! (approval.rs), one JSON line each, appended to `agent-approvals.log` in
//! the app's data directory.
//!
//! Each line says when (`time`, UTC), what was asked (`question`: a tool
//! call, a read of a gated path, starting a mode, turning agent mode on,
//! trusting a folder, a restore), about what (`tool`, the `path` relative
//! to the root or the SHA-256 of a command, never the command itself), in
//! which `mode` and `root`, for which stored conversation (`conversation`,
//! when the run is stored), and the `result`: `approved`, `rejected`, or
//! `stopped` (the run ended while the question was open).
//!
//! The file is the person's own: created owner-only (0600 in a 0700
//! folder on Unix; on Windows a protected DACL with one entry, the current
//! user, so neither inherited nor group access applies), and rotated by
//! size so it cannot grow without bound (`agent-approvals.log.1` and `.2`
//! keep the two before). A yes that cannot be written is not acted on:
//! the caller treats a failed append as no approval.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The log's file name in the data directory.
pub(crate) const LOG_FILE: &str = "agent-approvals.log";
/// Past this size the log is rotated before the next line.
pub(crate) const MAX_BYTES: u64 = 1024 * 1024;
/// Rotated files kept besides the live one.
const KEEP: usize = 2;

/// One question, as the log records it; the answer is added on append.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub(crate) struct Asked {
    /// `tool`, `read`, `mode`, `enable`, `trust` or `restore`.
    pub question: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
}

/// How a question ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Answer {
    Approved,
    Rejected,
    Stopped,
}

#[derive(Serialize)]
struct Line<'a> {
    time: String,
    #[serde(flatten)]
    asked: &'a Asked,
    result: Answer,
}

/// The log in one directory, appended to one line at a time.
pub(crate) struct AuditLog {
    dir: PathBuf,
    max_bytes: u64,
    writing: Mutex<()>,
}

impl AuditLog {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limit(dir, MAX_BYTES)
    }

    pub fn with_limit(dir: PathBuf, max_bytes: u64) -> Self {
        AuditLog {
            dir,
            max_bytes,
            writing: Mutex::new(()),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(LOG_FILE)
    }

    fn rotated(&self, n: usize) -> PathBuf {
        self.dir.join(format!("{LOG_FILE}.{n}"))
    }

    /// Appends one answer, rotating first when the line would take the
    /// file past its limit.
    pub fn append(&self, asked: &Asked, result: Answer, now: u64) -> Result<(), String> {
        let line = serde_json::to_string(&Line {
            time: iso8601(now),
            asked,
            result,
        })
        .map_err(|e| e.to_string())?;
        let _turn = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        create_private_dir(&self.dir).map_err(|e| format!("the approval log's folder: {e}"))?;
        let path = self.path();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size + line.len() as u64 + 1 > self.max_bytes {
            self.rotate()
                .map_err(|e| format!("rotating the approval log: {e}"))?;
        }
        let mut file = open_private(&path).map_err(|e| format!("the approval log: {e}"))?;
        file.write_all(format!("{line}\n").as_bytes())
            .and_then(|_| file.flush())
            .map_err(|e| format!("the approval log: {e}"))
    }

    fn rotate(&self) -> std::io::Result<()> {
        let oldest = self.rotated(KEEP);
        if oldest.exists() {
            std::fs::remove_file(&oldest)?;
        }
        for n in (1..KEEP).rev() {
            let from = self.rotated(n);
            if from.exists() {
                std::fs::rename(&from, self.rotated(n + 1))?;
            }
        }
        std::fs::rename(self.path(), self.rotated(1))
    }
}

/// `secs` since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
pub(crate) fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The folder, made if missing; on Unix readable by its owner alone.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The log opened for appending, made owner-only before each write: not
/// only when it is new, so a log whose first restriction failed (or one
/// that was there before) is never written to as it was.
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    owner_only::restrict(path)?;
    Ok(file)
}

/// Windows: a protected DACL with one entry, full control for the user
/// the app runs as. Protected, so nothing is inherited from the folder.
#[cfg(windows)]
pub(crate) mod owner_only {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The current user's SID as text (`S-1-5-21-...`).
    pub fn current_user_sid() -> std::io::Result<String> {
        // SAFETY: a token handle and a buffer this function owns; the
        // buffer is u64-aligned for TOKEN_USER's pointer and sized by the
        // first call; the SID string is freed with LocalFree as documented.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buffer = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut len,
            );
            let error = std::io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut n = 0;
            while *text.add(n) != 0 {
                n += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            LocalFree(text.cast());
            Ok(sid)
        }
    }

    /// Gives `path` a protected DACL that admits the current user alone.
    pub fn restrict(path: &Path) -> std::io::Result<()> {
        let sddl = wide(&format!("D:P(A;;FA;;;{})", current_user_sid()?));
        let name: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: the descriptor is allocated by the conversion and freed
        // with LocalFree; the DACL pointer is into it and used before that.
        unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let result =
                if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
                    == 0
                    || present == 0
                {
                    Err(std::io::Error::other(
                        "the owner-only descriptor has no DACL",
                    ))
                } else {
                    match SetNamedSecurityInfoW(
                        name.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        dacl,
                        std::ptr::null(),
                    ) {
                        0 => Ok(()),
                        code => Err(std::io::Error::from_raw_os_error(code as i32)),
                    }
                };
            LocalFree(descriptor);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_call(result_path: &str) -> Asked {
        Asked {
            question: "tool",
            tool: Some("edit".into()),
            path: Some(result_path.into()),
            mode: Some("ask".into()),
            root: Some("/work/demo".into()),
            ..Asked::default()
        }
    }

    #[test]
    fn a_line_says_when_what_where_and_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("data"));
        log.append(&shell_call("src/a.py"), Answer::Approved, 1_793_489_772)
            .unwrap();
        let command = Asked {
            question: "tool",
            tool: Some("run_shell".into()),
            command_sha256: Some("ab".repeat(32)),
            mode: Some("auto-edit".into()),
            conversation: Some("c1".into()),
            ..Asked::default()
        };
        log.append(&command, Answer::Rejected, 1_793_489_773)
            .unwrap();
        let text = std::fs::read_to_string(log.path()).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            serde_json::json!({
                "time": "2026-10-31T23:36:12Z",
                "question": "tool",
                "tool": "edit",
                "path": "src/a.py",
                "mode": "ask",
                "root": "/work/demo",
                "result": "approved"
            })
        );
        assert_eq!(lines[1]["result"], "rejected");
        assert_eq!(lines[1]["command_sha256"], "ab".repeat(32));
        assert_eq!(lines[1]["conversation"], "c1");
        assert!(lines[1].get("path").is_none());
    }

    #[test]
    fn the_log_rotates_by_size_and_keeps_two() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::with_limit(dir.path().to_path_buf(), 300);
        for n in 0..20 {
            log.append(&shell_call(&format!("f{n}.txt")), Answer::Approved, 0)
                .unwrap();
        }
        assert!(std::fs::metadata(log.path()).unwrap().len() <= 300);
        assert!(log.rotated(1).exists() && log.rotated(2).exists());
        assert!(!log.rotated(3).exists());
        let newest = std::fs::read_to_string(log.path()).unwrap();
        assert!(newest.contains("f19.txt"));
    }

    #[test]
    fn dates_are_utc_civil_dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_793_489_772), "2026-10-31T23:36:12Z");
    }

    #[cfg(unix)]
    #[test]
    fn the_log_and_its_folder_are_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("data"));
        log.append(&shell_call("a"), Answer::Approved, 0).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&log.path()), 0o600);
        assert_eq!(mode(&dir.path().join("data")), 0o700);
    }

    /// Windows: the file's DACL is protected and names the current user
    /// alone (icacls lists one entry and no inherited ones).
    #[cfg(windows)]
    fn assert_owner_only(path: &Path) {
        let out = std::process::Command::new("icacls")
            .arg(path)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let entries: Vec<&str> = text.lines().filter(|l| l.contains(":(")).collect();
        assert_eq!(entries.len(), 1, "{text}");
        assert!(entries[0].contains("(F)"), "{text}");
        assert!(!text.contains("(I)"), "nothing inherited: {text}");
    }

    #[cfg(windows)]
    #[test]
    fn the_log_is_the_owners_alone() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("data"));
        log.append(&shell_call("a"), Answer::Approved, 0).unwrap();
        assert_owner_only(&log.path());
        let sid = owner_only::current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
    }

    /// Windows: a log already there with the folder's inherited access (a
    /// first restriction that failed, or a file made by something else) is
    /// made the owner's alone before the next line goes in.
    #[cfg(windows)]
    #[test]
    fn a_log_already_there_is_made_the_owners_alone_before_it_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().to_path_buf());
        std::fs::write(log.path(), "").unwrap();
        log.append(&shell_call("a"), Answer::Approved, 0).unwrap();
        assert_owner_only(&log.path());
    }
}
