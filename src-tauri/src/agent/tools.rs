//! The file tools: `read_file`, `list_dir`, `glob`, `grep`, and the two
//! writes, `edit` and `write_file`, each split into a preview (what the
//! change would be, for the diff) and an apply (the change, once approved).
//!
//! The read tools are the SDKs' `run_read_file`, `run_list_dir`, `run_glob`
//! and `run_grep` over the host's own I/O: every path goes through
//! `confine` first, the walk is search.rs's (ignore files from the root
//! down, files before subdirectories, links confined), and the text is
//! output.rs's, so what the model reads is what every client returns
//! (`conformance.rs` runs the contract's cases against these functions).
//! As the contract has it, a read stops one byte past the cap on the
//! handle it reads (a file that grows between the size check and the read
//! is still `too_large`), and only regular files and directories are used:
//! a pipe, socket or device is `special_file`, checked before anything is
//! opened, and opened without blocking where it could be swapped in (a
//! FIFO would otherwise wait for ever). The host keeps checks of its own
//! on top: a search stops when the run does, grep stops at a time limit
//! (`GREP_TIMEOUT`, the contract's `timeout`), and a run in a mode the
//! person has not confirmed for the folder leaves out the read-gated paths
//! (`approval::read_gate`).

use super::approval;
use super::confine::{confine, resolve_links, same_path, within, Access, Confined, DenyList};
use super::contract::{EditFailure, ToolFailure};
use super::edit::{apply_edit, EditError};
use super::output::{
    check_lines, decode_text, format_glob, format_grep, format_list_dir, format_read_file,
    is_binary, text_lines, GlobMatcher, Limits, ToolError,
};
use super::search::{entries, walk, SearchIgnore, Walk};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// What a tool hands back for the model: the text, whether it is an error
/// (a refusal, a bad argument, a failed edit), and whether the person said
/// no to it in the native dialog (which is an answer, not an error).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ToolOutput {
    pub output: String,
    pub is_error: bool,
    pub rejected: bool,
}

impl ToolOutput {
    pub fn ok(output: impl Into<String>) -> Self {
        ToolOutput {
            output: output.into(),
            is_error: false,
            rejected: false,
        }
    }

    pub fn error(output: impl Into<String>) -> Self {
        ToolOutput {
            output: output.into(),
            is_error: true,
            rejected: false,
        }
    }

    pub fn rejected(output: impl Into<String>) -> Self {
        ToolOutput {
            output: output.into(),
            is_error: false,
            rejected: true,
        }
    }
}

impl From<ToolError> for ToolOutput {
    fn from(e: ToolError) -> Self {
        ToolOutput::error(e.message)
    }
}

/// The sentence a search stopped by the run ends with.
const STOPPED: &str = "Stopped by the user.";

/// How long one grep may take, walk and match together, before it answers
/// with the contract's `timeout` and no matches. `regex` matches in linear
/// time, so this bounds a search over a huge tree rather than one
/// pathological line; the VS Code client uses the same 30 s.
pub(crate) const GREP_TIMEOUT: Duration = Duration::from_secs(30);

/// A workspace: the root the person picked, already canonical, its deny
/// list and search rules as of this call, and the limits the tools hold
/// to. `cancelled` lets a long walk stop early when the run is stopped;
/// `gated` leaves the read-gated paths out (a run in a mode the person has
/// not confirmed for the folder, reading without their yes for this path).
pub(crate) struct Workspace<'a> {
    pub root: &'a Path,
    pub deny: DenyList,
    pub rules: SearchIgnore,
    pub cancelled: &'a AtomicBool,
    pub limits: Limits,
    pub gated: bool,
    /// grep's time limit (`GREP_TIMEOUT`).
    pub grep_timeout: Duration,
}

impl<'a> Workspace<'a> {
    pub fn new(root: &'a Path, cancelled: &'a AtomicBool) -> Self {
        let deny = DenyList::load(root);
        Workspace {
            root,
            rules: SearchIgnore::load(root, DenyList::load(root)),
            deny,
            cancelled,
            limits: Limits::default(),
            gated: false,
            grep_timeout: GREP_TIMEOUT,
        }
    }

    /// The same workspace with the read gate closed (`true`) or open.
    pub fn gated(mut self, gated: bool) -> Self {
        self.gated = gated;
        self
    }

    fn confine(&self, path: &str, access: Access) -> Result<Confined, ToolOutput> {
        confine(self.root, path, &self.deny, access).map_err(|r| ToolOutput::error(r.message))
    }

    /// `confine` for a read tool, with the read gate on its path.
    fn confine_read(&self, path: &str) -> Result<Confined, ToolOutput> {
        let target = self.confine(path, Access::Read)?;
        if self.gated && approval::is_read_gated(&target) {
            return Err(ToolOutput::error(approval::read_gate_refusal(path)));
        }
        Ok(target)
    }

    /// Whether a walk leaves `relative` out besides what the rules ignore.
    fn hidden(&self, relative: &str, is_dir: bool) -> bool {
        self.gated && approval::read_gate().matches(relative, is_dir)
    }

    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

/// Arguments, checked against the contract's schema: a missing required
/// argument, a wrong type and an argument the tool does not take are each
/// an error the model reads.
pub(crate) fn parse_args<T: for<'de> Deserialize<'de>>(
    tool: &str,
    args: serde_json::Value,
) -> Result<T, ToolOutput> {
    let args = if args.is_null() {
        serde_json::Value::Object(Default::default())
    } else {
        args
    };
    serde_json::from_value(args)
        .map_err(|e| ToolOutput::error(format!("Invalid arguments for {tool}: {e}.")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadFileArgs {
    pub path: String,
    /// Signed, so a zero or a negative line is the contract's `bad_line`
    /// rather than a type error.
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListDirArgs {
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GlobArgs {
    pub pattern: String,
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GrepArgs {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub ignore_case: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditArgs {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteFileArgs {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RunShellArgs {
    pub command: String,
    /// A number, so a fraction or a value out of range is the contract's
    /// `bad_timeout` rather than a type error.
    pub timeout_s: Option<f64>,
}

/// At most `max` bytes of the file at `path`, or the reason it cannot be
/// had: missing, a directory, a pipe, socket or device (`special_file`:
/// one would block the read for ever), or longer than `max`. The kind is
/// checked before the file is opened, and the open does not wait (on Unix,
/// `O_NONBLOCK`), so a FIFO swapped in between is seen on the handle and
/// never read. The size is checked on that handle too, and the read itself
/// stops one byte past `max`, so a file that grows in between is still
/// too large.
pub(crate) fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, ReadRefusal> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|_| ReadRefusal::Missing)?;
    if meta.is_dir() {
        return Err(ReadRefusal::Directory);
    }
    if !meta.is_file() {
        return Err(ReadRefusal::Special);
    }
    let file = open_without_waiting(path).map_err(|e| ReadRefusal::Io(e.to_string()))?;
    let meta = file
        .metadata()
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(ReadRefusal::Special);
    }
    if meta.len() > max {
        return Err(ReadRefusal::TooLarge(meta.len()));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if bytes.len() as u64 > max {
        return Err(ReadRefusal::TooLarge(bytes.len() as u64));
    }
    Ok(bytes)
}

/// `path` opened for reading without waiting on it: on Unix with
/// `O_NONBLOCK`, so a FIFO swapped in after its kind was checked opens at
/// once (and its handle then says what it is) instead of waiting for a
/// writer. A regular file reads as it always does.
pub(crate) fn open_without_waiting(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    options.open(path)
}

/// Why `read_capped` read nothing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReadRefusal {
    Missing,
    Directory,
    /// A pipe, socket or device.
    Special,
    TooLarge(u64),
    Io(String),
}

impl ReadRefusal {
    /// The sentence for the model about the file at `path` (relative).
    fn message(self, path: &str, max: u64) -> String {
        match self {
            ReadRefusal::Missing => ToolFailure::NotFound.message(&[("path", path)]),
            ReadRefusal::Directory => ToolFailure::IsDirectory.message(&[("path", path)]),
            ReadRefusal::Special => ToolFailure::SpecialFile.message(&[("path", path)]),
            ReadRefusal::TooLarge(size) => ToolFailure::TooLarge.message(&[
                ("path", path),
                ("size", &size.to_string()),
                ("limit", &max.to_string()),
            ]),
            ReadRefusal::Io(e) => format!("{path} could not be read: {e}"),
        }
    }
}

/// read_file: the numbered lines of `path`.
pub(crate) fn read_file(ws: &Workspace, args: ReadFileArgs) -> ToolOutput {
    if let Err(e) = check_lines(args.start_line, args.end_line) {
        return e.into();
    }
    let target = match ws.confine_read(&args.path) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let max = ws.limits.read_max_file_bytes;
    let bytes = match read_capped(&target.absolute, max) {
        Ok(b) => b,
        Err(why) => return ToolOutput::error(why.message(&target.relative, max)),
    };
    if is_binary(&bytes, &ws.limits) {
        return ToolOutput::error(ToolFailure::Binary.message(&[("path", &target.relative)]));
    }
    match format_read_file(
        &decode_text(&bytes),
        &target.relative,
        args.start_line,
        args.end_line,
        &ws.limits,
    ) {
        Ok(text) => ToolOutput::ok(text),
        Err(e) => e.into(),
    }
}

/// Whether a tool's confined path is a regular file (`Ok(true)`) or a
/// directory (`Ok(false)`), its links followed; otherwise the error for
/// nothing there (`not_found`) or a pipe, socket or device
/// (`special_file`), which is only looked at, never opened.
fn file_or_dir(target: &Confined) -> Result<bool, ToolOutput> {
    let failure = match std::fs::metadata(&target.absolute) {
        Ok(meta) if meta.is_dir() => return Ok(false),
        Ok(meta) if meta.is_file() => return Ok(true),
        Ok(_) => ToolFailure::SpecialFile,
        Err(_) => ToolFailure::NotFound,
    };
    Err(ToolOutput::error(
        failure.message(&[("path", &target.relative)]),
    ))
}

/// The directory a search starts from: confined, gated, and a directory.
fn search_dir(ws: &Workspace, path: Option<&str>) -> Result<Confined, ToolOutput> {
    let target = ws.confine_read(path.unwrap_or("."))?;
    if file_or_dir(&target)? {
        return Err(ToolOutput::error(
            ToolFailure::NotDirectory.message(&[("path", &target.relative)]),
        ));
    }
    Ok(target)
}

/// list_dir: the entries of `path`, directories first.
pub(crate) fn list_dir(ws: &Workspace, args: ListDirArgs) -> ToolOutput {
    let target = match search_dir(ws, args.path.as_deref()) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let directory = if target.relative == "." {
        ""
    } else {
        target.relative.as_str()
    };
    let hidden = |relative: &str, is_dir: bool| ws.hidden(relative, is_dir);
    let listed: Vec<(String, bool)> = entries(ws.root, directory, &ws.rules, &hidden)
        .into_iter()
        .map(|e| {
            let name = e.relative.rsplit('/').next().unwrap_or("").to_string();
            (name, e.is_dir)
        })
        .collect();
    ToolOutput::ok(format_list_dir(&target.relative, &listed, &ws.limits))
}

/// `relative` (to the root) as seen from `base`, a directory it is under.
fn under<'r>(relative: &'r str, base: &str) -> &'r str {
    if base.is_empty() {
        return relative;
    }
    relative
        .strip_prefix(base)
        .and_then(|r| r.strip_prefix('/'))
        .unwrap_or(relative)
}

/// glob: the files under `path` whose path matches `pattern`.
pub(crate) fn glob(ws: &Workspace, args: GlobArgs) -> ToolOutput {
    if args.pattern.trim().is_empty() {
        return ToolOutput::error(ToolFailure::EmptyPattern.message(&[]));
    }
    // An invalid glob is answered before anything is searched.
    let matcher = match GlobMatcher::new(&args.pattern) {
        Ok(m) => m,
        Err(e) => return e.into(),
    };
    let target = match search_dir(ws, args.path.as_deref()) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let base = if target.relative == "." {
        ""
    } else {
        target.relative.as_str()
    };
    let cap = ws.limits.search_max_results;
    let mut found: Vec<String> = Vec::new();
    let (mut truncated, mut stopped) = (false, false);
    let hidden = |relative: &str, is_dir: bool| ws.hidden(relative, is_dir);
    walk(
        ws.root,
        &target.relative,
        false,
        &ws.rules,
        &hidden,
        |relative| {
            if ws.stopped() {
                stopped = true;
                return Walk::Stop;
            }
            if !matcher.matches(under(relative, base)) {
                return Walk::Next;
            }
            if found.len() == cap {
                truncated = true;
                return Walk::Stop;
            }
            found.push(relative.to_string());
            Walk::Next
        },
    );
    if stopped {
        return ToolOutput::error(STOPPED);
    }
    ToolOutput::ok(format_glob(&args.pattern, &found, truncated, &ws.limits))
}

/// grep: the lines matching `pattern` in the files under `path` (only
/// those `glob` matches, when given).
pub(crate) fn grep(ws: &Workspace, args: GrepArgs) -> ToolOutput {
    if args.pattern.is_empty() {
        return ToolOutput::error(ToolFailure::EmptyPattern.message(&[]));
    }
    let regex = match RegexBuilder::new(&args.pattern)
        .case_insensitive(args.ignore_case.unwrap_or(false))
        .size_limit(10 * 1024 * 1024)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return ToolOutput::error(
                ToolFailure::InvalidRegex
                    .message(&[("pattern", &args.pattern), ("error", &e.to_string())]),
            )
        }
    };
    // An invalid glob filter is answered before anything is searched.
    let filter = match args.glob.as_deref().filter(|g| !g.is_empty()) {
        Some(glob) => match GlobMatcher::new(glob) {
            Ok(m) => Some(m),
            Err(e) => return e.into(),
        },
        None => None,
    };
    let target = match ws.confine_read(args.path.as_deref().unwrap_or(".")) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let start_is_file = match file_or_dir(&target) {
        Ok(is_file) => is_file,
        Err(e) => return e,
    };
    let base = if start_is_file {
        target.relative.rsplit_once('/').map_or("", |(dir, _)| dir)
    } else if target.relative == "." {
        ""
    } else {
        target.relative.as_str()
    };
    let cap = ws.limits.search_max_results;
    let max_file = ws.limits.grep_max_file_bytes;
    let mut found: Vec<(String, usize, String)> = Vec::new();
    let (mut truncated, mut stopped, mut timed_out) = (false, false, false);
    let deadline = Instant::now() + ws.grep_timeout;
    let mut lines_since_check = 0u32;
    let hidden = |relative: &str, is_dir: bool| ws.hidden(relative, is_dir);
    walk(
        ws.root,
        &target.relative,
        start_is_file,
        &ws.rules,
        &hidden,
        |relative| {
            if ws.stopped() {
                stopped = true;
                return Walk::Stop;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                return Walk::Stop;
            }
            if filter
                .as_ref()
                .is_some_and(|f| !f.matches(under(relative, base)))
            {
                return Walk::Next;
            }
            let mut file = ws.root.join(relative);
            // A link is confined again just before it is read, so one
            // swapped in since the walk listed it cannot lead out; and held
            // to the read gate by where it leads, which the walk (by name)
            // cannot see.
            if std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
                match ws.confine_read(relative) {
                    Ok(c) => file = c.absolute,
                    Err(_) => return Walk::Next,
                }
            }
            let Ok(bytes) = read_capped(&file, max_file) else {
                return Walk::Next;
            };
            if is_binary(&bytes, &ws.limits) {
                return Walk::Next;
            }
            let text = decode_text(&bytes);
            for (n, line) in text_lines(&text).into_iter().enumerate() {
                lines_since_check += 1;
                if lines_since_check == 4096 {
                    lines_since_check = 0;
                    if Instant::now() >= deadline {
                        timed_out = true;
                        return Walk::Stop;
                    }
                }
                if !regex.is_match(line) {
                    continue;
                }
                if found.len() == cap {
                    truncated = true;
                    return Walk::Stop;
                }
                found.push((relative.to_string(), n + 1, line.to_string()));
            }
            Walk::Next
        },
    );
    if stopped {
        return ToolOutput::error(STOPPED);
    }
    if timed_out {
        return ToolOutput::error(ToolFailure::Timeout.message(&[
            ("pattern", &args.pattern),
            ("timeout_s", &seconds(ws.grep_timeout)),
        ]));
    }
    ToolOutput::ok(format_grep(&args.pattern, &found, truncated, &ws.limits))
}

/// A time limit as the contract's messages print it: `30` for whole
/// seconds, `0.5` otherwise.
fn seconds(limit: Duration) -> String {
    if limit.subsec_nanos() == 0 {
        limit.as_secs().to_string()
    } else {
        limit.as_secs_f64().to_string()
    }
}

/// What a write would do, for the approval's diff: the file as it is (none
/// when it does not exist yet) and as it would be, and a fingerprint of the
/// current bytes the apply step checks, so what is written is exactly what
/// was shown.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct WritePreview {
    pub relative: String,
    pub before: Option<String>,
    pub after: String,
    pub before_sha256: String,
}

/// The fingerprint of a file's current bytes; `absent` when there is none.
/// Never a whole read past the cap: such a file has no preview anyway.
pub(crate) fn fingerprint(path: &Path, max: u64) -> String {
    match read_capped(path, max) {
        Ok(bytes) => hex(&Sha256::digest(&bytes)),
        Err(ReadRefusal::Missing) => "absent".to_string(),
        Err(why) => format!("unreadable: {why:?}"),
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The text of a file a write would change, or why it cannot be had as
/// text: the read tools' refusals, and invalid UTF-8, which an edit would
/// otherwise rewrite with replacement characters.
fn read_text(ws: &Workspace, target: &Confined) -> Result<String, ToolOutput> {
    let max = ws.limits.read_max_file_bytes;
    let bytes = read_capped(&target.absolute, max)
        .map_err(|why| ToolOutput::error(why.message(&target.relative, max)))?;
    if is_binary(&bytes, &ws.limits) {
        return Err(ToolOutput::error(
            ToolFailure::Binary.message(&[("path", &target.relative)]),
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        ToolOutput::error(format!(
            "{} is not UTF-8 text, so it is not changed.",
            target.relative
        ))
    })
}

/// The new content an `edit` produces, or why it cannot. `access` is
/// `ApprovedWrite` for a preview (nothing is written; the apply asks) and
/// for an apply the person said yes to, `Write` otherwise.
pub(crate) fn preview_edit(
    ws: &Workspace,
    args: &EditArgs,
    access: Access,
) -> Result<(Confined, WritePreview), ToolOutput> {
    let target = ws.confine(&args.path, access)?;
    if !target.absolute.exists() {
        return Err(ToolOutput::error(
            EditError::new(EditFailure::Missing, &args.path, 0).message,
        ));
    }
    let before = read_text(ws, &target)?;
    let after = apply_edit(&before, &args.old_string, &args.new_string, &args.path)
        .map_err(|e| ToolOutput::error(e.message))?;
    let preview = WritePreview {
        relative: target.relative.clone(),
        before_sha256: fingerprint(&target.absolute, ws.limits.read_max_file_bytes),
        before: Some(before),
        after,
    };
    Ok((target, preview))
}

/// The content a `write_file` leaves, and what it replaces.
pub(crate) fn preview_write(
    ws: &Workspace,
    args: &WriteFileArgs,
    access: Access,
) -> Result<(Confined, WritePreview), ToolOutput> {
    let max = ws.limits.read_max_file_bytes;
    if args.content.len() as u64 > max {
        return Err(ToolOutput::error(format!(
            "The content is {} bytes, over the {max} bytes a tool writes.",
            args.content.len()
        )));
    }
    let target = ws.confine(&args.path, access)?;
    if target.absolute.is_dir() {
        return Err(ToolOutput::error(format!(
            "{} is a directory; write_file writes files.",
            target.relative
        )));
    }
    let before = if target.absolute.exists() {
        Some(read_text(ws, &target)?)
    } else {
        None
    };
    let preview = WritePreview {
        relative: target.relative.clone(),
        before_sha256: fingerprint(&target.absolute, max),
        before,
        after: args.content.clone(),
    };
    Ok((target, preview))
}

/// Writes `content` to the confined target, creating missing parents, by
/// writing a new file beside it and renaming that over the target.
///
/// The rename replaces the directory entry rather than writing through it,
/// so a target that is a hard link to a file outside the root (pnpm's
/// store, or a planted link to a dotfile) is unlinked from it rather than
/// overwritten, and a link put in the target's place since it was confined
/// is replaced, not followed. The parent is resolved again just before the
/// rename and must still be under `root`, which catches a directory on the
/// way swapped for a link out. A reader never sees a half-written file.
pub(crate) fn write_confined(target: &Confined, root: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = target
        .absolute
        .parent()
        .ok_or_else(|| "the target has no parent folder".to_string())?;
    let name = target
        .absolute
        .file_name()
        .ok_or_else(|| "the target has no file name".to_string())?
        .to_os_string();
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // The folder as it is now must be the one confined: not a link out of
    // the root, and not a link to some other folder inside it either.
    let moved = || {
        format!(
            "{} is not where it was when it was checked",
            target.relative
        )
    };
    let real_parent = resolve_links(parent).map_err(|_| moved())?;
    if !within(&real_parent, root) || !same_path(&real_parent, parent) {
        return Err(moved());
    }
    let existing = std::fs::symlink_metadata(&target.absolute).ok();
    let suffix: u64 = rand::random();
    let temp = real_parent.join(format!(".{}.mw-{suffix:016x}.tmp", name.to_string_lossy()));
    let written = (|| -> std::io::Result<()> {
        // create_new: never opens (or follows) something already there.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content)?;
        file.flush()?;
        drop(file);
        if let Some(meta) = existing.as_ref().filter(|m| m.is_file()) {
            // The file's own permissions carry over (the executable bit on
            // Unix); a read-only file stays read-only, and the rename over
            // it fails rather than forcing it.
            std::fs::set_permissions(&temp, meta.permissions())?;
        }
        std::fs::rename(&temp, parent.join(&name))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    pub(crate) fn ws_files(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        dir
    }

    fn canonical(dir: &tempfile::TempDir) -> PathBuf {
        resolve_links(dir.path()).unwrap()
    }

    static RUNNING: AtomicBool = AtomicBool::new(false);

    fn read(path: &str, start_line: Option<i64>, end_line: Option<i64>) -> ReadFileArgs {
        ReadFileArgs {
            path: path.into(),
            start_line,
            end_line,
        }
    }

    #[test]
    fn read_file_numbers_lines_and_honours_the_range() {
        let dir = ws_files(&[("a.txt", "one\r\ntwo\nthree\n")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let all = read_file(&ws, read("a.txt", None, None));
        assert_eq!(all, ToolOutput::ok("1\tone\n2\ttwo\n3\tthree"));
        let some = read_file(&ws, read("a.txt", Some(2), Some(2)));
        assert_eq!(some.output, "2\ttwo");
        let past = read_file(&ws, read("a.txt", Some(9), None));
        assert!(past.is_error);
        assert_eq!(
            past.output,
            "start_line 9 is past the end of a.txt (3 lines)."
        );
        let backwards = read_file(&ws, read("a.txt", Some(3), Some(2)));
        assert_eq!(backwards.output, "end_line 2 is before start_line 3.");
        let zero = read_file(&ws, read("a.txt", Some(-1), None));
        assert_eq!(
            zero.output,
            "start_line counts lines from 1; -1 is not a line number."
        );
    }

    #[test]
    fn read_file_stops_at_the_line_limit_and_says_where_to_go_on() {
        let body: String = (1..=2500).map(|n| format!("line {n}\n")).collect();
        let dir = ws_files(&[("big.txt", &body)]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let out = read_file(&ws, read("big.txt", None, None));
        assert!(out.output.contains("2000\tline 2000\n"));
        assert!(!out.output.contains("2001\tline 2001"));
        assert!(out.output.ends_with(
            "[Cut off at the read limit: showing lines 1-2000 of 2500. Pass start_line=2001 to read on.]"
        ));
    }

    #[test]
    fn read_file_refuses_secrets_and_binaries() {
        let dir = ws_files(&[(".env", "KEY=1"), ("bin.dat", "a\0b")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let env = read_file(&ws, read(".env", None, None));
        assert!(env.is_error);
        assert!(
            env.output.starts_with("Refused: .env is protected"),
            "{}",
            env.output
        );
        let bin = read_file(&ws, read("bin.dat", None, None));
        assert_eq!(
            bin,
            ToolOutput::error("bin.dat is a binary file; only text files are read.")
        );
    }

    /// Attack: a file past the cap (read whole, it would be in memory and
    /// sent on), and a write of content past it.
    #[test]
    fn a_huge_file_is_neither_read_nor_written() {
        let max = crate::agent::contract::READ_MAX_FILE_BYTES;
        let dir = ws_files(&[("small.txt", "s\n")]);
        let root = canonical(&dir);
        let big = std::fs::File::create(root.join("big.log")).unwrap();
        big.set_len(max + 1).unwrap();
        drop(big);
        let ws = Workspace::new(&root, &RUNNING);
        let out = read_file(&ws, read("big.log", None, None));
        assert_eq!(
            out.output,
            "big.log is 16777217 bytes, over the 16777216 bytes read_file reads."
        );
        assert_eq!(
            read_capped(&root.join("big.log"), max),
            Err(ReadRefusal::TooLarge(max + 1))
        );
        assert!(fingerprint(&root.join("big.log"), max).starts_with("unreadable"));
        let huge = "x".repeat(max as usize + 1);
        let refused = preview_write(
            &ws,
            &WriteFileArgs {
                path: "small.txt".into(),
                content: huge,
            },
            Access::Write,
        )
        .err()
        .unwrap();
        assert!(refused
            .output
            .contains("over the 16777216 bytes a tool writes"));
        assert_eq!(
            read_capped(&root.join("nope"), 10),
            Err(ReadRefusal::Missing)
        );
        assert_eq!(read_capped(&root, 10), Err(ReadRefusal::Directory));
    }

    /// A FIFO would block the read for ever, past Stop: every tool names it
    /// `special_file` without opening it, and searches leave it out.
    #[cfg(unix)]
    #[test]
    fn a_fifo_is_special_and_never_waited_on() {
        let dir = ws_files(&[("a.txt", "x\n")]);
        let root = canonical(&dir);
        let fifo = root.join("pipe");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a plain mkfifo(3) on a path this test owns.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(read_capped(&fifo, 10), Err(ReadRefusal::Special));
        let ws = Workspace::new(&root, &RUNNING);
        let special =
            "pipe is a pipe, socket or device, not a file or directory, so it is not opened.";
        assert_eq!(
            read_file(&ws, read("pipe", None, None)),
            ToolOutput::error(special)
        );
        let listed = list_dir(
            &ws,
            ListDirArgs {
                path: Some("pipe".into()),
            },
        );
        assert_eq!(listed, ToolOutput::error(special));
        let globbed = glob(
            &ws,
            GlobArgs {
                pattern: "*".into(),
                path: Some("pipe".into()),
            },
        );
        assert_eq!(globbed, ToolOutput::error(special));
        let grepped = grep(
            &ws,
            GrepArgs {
                pattern: "x".into(),
                path: Some("pipe".into()),
                glob: None,
                ignore_case: None,
            },
        );
        assert_eq!(grepped, ToolOutput::error(special));
        // Not listed, and not searched.
        assert_eq!(list_dir(&ws, ListDirArgs { path: None }).output, "a.txt");
        let all = grep(
            &ws,
            GrepArgs {
                pattern: ".".into(),
                path: None,
                glob: None,
                ignore_case: None,
            },
        );
        assert_eq!(all.output, "a.txt:1: x");
        // A device is special the same way.
        let ws_dev = Workspace::new(Path::new("/dev"), &RUNNING);
        let null = read_file(&ws_dev, read("null", None, None));
        assert!(
            null.is_error && null.output.contains("pipe, socket or device"),
            "{}",
            null.output
        );
    }

    /// grep's time limit ends the search with the contract's `timeout` and
    /// no matches.
    #[test]
    fn a_grep_past_its_time_limit_is_timeout() {
        let dir = ws_files(&[("a.txt", "TODO\n")]);
        let root = canonical(&dir);
        let mut ws = Workspace::new(&root, &RUNNING);
        let args = || GrepArgs {
            pattern: "TODO".into(),
            path: None,
            glob: None,
            ignore_case: None,
        };
        assert_eq!(grep(&ws, args()).output, "a.txt:1: TODO");
        ws.grep_timeout = Duration::ZERO;
        assert_eq!(
            grep(&ws, args()),
            ToolOutput::error(
                "The search for TODO stopped after 0 s without finishing. Try a simpler pattern, a narrower path or a glob."
            )
        );
        assert_eq!(seconds(Duration::from_millis(1500)), "1.5");
        assert_eq!(seconds(GREP_TIMEOUT), "30");
    }

    #[test]
    fn list_dir_puts_directories_first_and_leaves_out_ignored_and_denied_entries() {
        let dir = ws_files(&[
            ("src/main.rs", "fn main() {}"),
            ("README.md", "# hi"),
            ("AGENTS.md", "Be brief."),
            (".env", "KEY=1"),
            (".git/HEAD", "ref"),
            ("target/out.bin", "x"),
            (".gitignore", "target/\n"),
            ("private/notes.md", "n"),
            (".matterwaveignore", "private/\n"),
        ]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let out = list_dir(&ws, ListDirArgs { path: None });
        // Protected entries (AGENTS.md, .matterwaveignore) are listed.
        assert_eq!(
            out.output, "src/\n.gitignore\n.matterwaveignore\nAGENTS.md\nREADME.md",
            "{}",
            out.output
        );
    }

    #[test]
    fn glob_matches_names_anywhere_or_paths_from_the_search_root() {
        let dir = ws_files(&[
            ("src/a.ts", ""),
            ("src/deep/b.ts", ""),
            ("lib/c.ts", ""),
            ("src/d.js", ""),
            ("node_modules/x/e.ts", ""),
            (".gitignore", "node_modules/\n"),
            ("keys/k.pem", ""),
            ("top.TS", ""),
        ]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let names = glob(
            &ws,
            GlobArgs {
                pattern: "*.ts".into(),
                path: None,
            },
        );
        // Files before subdirectories in each directory, case ignored.
        assert_eq!(names.output, "top.TS\nlib/c.ts\nsrc/a.ts\nsrc/deep/b.ts");
        let rooted = glob(
            &ws,
            GlobArgs {
                pattern: "src/**/*.ts".into(),
                path: None,
            },
        );
        assert_eq!(rooted.output, "src/a.ts\nsrc/deep/b.ts");
        let under_src = glob(
            &ws,
            GlobArgs {
                pattern: "*.js".into(),
                path: Some("src".into()),
            },
        );
        assert_eq!(under_src.output, "src/d.js");
        let pem = glob(
            &ws,
            GlobArgs {
                pattern: "*.pem".into(),
                path: None,
            },
        );
        assert_eq!(pem.output, "No files match *.pem.");
    }

    #[test]
    fn grep_reports_path_line_and_text_and_skips_ignored_denied_and_binary_files() {
        let dir = ws_files(&[
            ("src/a.py", "def f():\n    return TODO\n"),
            ("src/b.txt", "todo lower\n"),
            (".env", "TODO=secret\n"),
            ("build/out.py", "TODO\n"),
            (".gitignore", "build/\n"),
            ("blob.bin", "TODO\0"),
        ]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let out = grep(
            &ws,
            GrepArgs {
                pattern: "TODO".into(),
                path: None,
                glob: None,
                ignore_case: None,
            },
        );
        assert_eq!(out.output, "src/a.py:2:     return TODO");
        let folded = grep(
            &ws,
            GrepArgs {
                pattern: "todo".into(),
                path: Some("src".into()),
                glob: Some("*.txt".into()),
                ignore_case: Some(true),
            },
        );
        assert_eq!(folded.output, "src/b.txt:1: todo lower");
        let bad = grep(
            &ws,
            GrepArgs {
                pattern: "(".into(),
                path: None,
                glob: None,
                ignore_case: None,
            },
        );
        assert!(bad.is_error);
        assert!(bad
            .output
            .starts_with("The pattern ( is not a valid regular expression: "));
    }

    /// A run whose mode the person has not confirmed for the folder reads
    /// the credential folders and shell startup files only with a yes: the
    /// tools refuse them by name, and a search leaves them out.
    #[test]
    fn a_gated_workspace_leaves_out_credential_folders_and_startup_files() {
        let dir = ws_files(&[
            (".aws/credentials", "aws_secret_access_key = SECRET\n"),
            (".bashrc", "export TOKEN=SECRET\n"),
            ("src/a.py", "SECRET = None\n"),
            ("AGENTS.md", "Be brief.\n"),
        ]);
        let root = canonical(&dir);
        let gated = Workspace::new(&root, &RUNNING).gated(true);
        let found = grep(
            &gated,
            GrepArgs {
                pattern: "SECRET".into(),
                path: None,
                glob: None,
                ignore_case: None,
            },
        );
        assert_eq!(found.output, "src/a.py:1: SECRET = None");
        let refused = read_file(&gated, read(".aws/credentials", None, None));
        assert!(refused.is_error && refused.output.starts_with("Refused: .aws/credentials"));
        assert_eq!(
            list_dir(&gated, ListDirArgs { path: None }).output,
            "src/\nAGENTS.md"
        );
        // The context files are read as before.
        assert_eq!(
            read_file(&gated, read("AGENTS.md", None, None)).output,
            "1\tBe brief."
        );
        let open = Workspace::new(&root, &RUNNING);
        assert_eq!(
            read_file(&open, read(".bashrc", None, None)).output,
            "1\texport TOKEN=SECRET"
        );
    }

    /// A link with an innocent name to a gated file is gated by where it
    /// leads: the walk lists it by name, so grep must not read through it.
    #[cfg(unix)]
    #[test]
    fn a_gated_grep_does_not_read_through_a_link_to_a_gated_file() {
        let dir = ws_files(&[
            (".bashrc", "export TOKEN=SECRET\n"),
            ("src/a.py", "SECRET = None\n"),
        ]);
        let root = canonical(&dir);
        std::os::unix::fs::symlink(root.join(".bashrc"), root.join("notes.txt")).unwrap();
        let args = || GrepArgs {
            pattern: "SECRET".into(),
            path: None,
            glob: None,
            ignore_case: None,
        };
        let gated = Workspace::new(&root, &RUNNING).gated(true);
        assert_eq!(grep(&gated, args()).output, "src/a.py:1: SECRET = None");
        let refused = read_file(&gated, read("notes.txt", None, None));
        assert!(refused.is_error, "{}", refused.output);
        let open = Workspace::new(&root, &RUNNING);
        assert!(grep(&open, args()).output.contains("notes.txt:1:"));
    }

    #[test]
    fn unknown_and_missing_arguments_are_errors_for_the_model() {
        let err =
            parse_args::<ReadFileArgs>("read_file", serde_json::json!({"path": "a", "mode": "x"}))
                .err()
                .unwrap();
        assert!(
            err.is_error && err.output.contains("unknown field"),
            "{}",
            err.output
        );
        let err = parse_args::<EditArgs>("edit", serde_json::json!({"path": "a"}))
            .err()
            .unwrap();
        assert!(err.output.contains("missing field"), "{}", err.output);
        assert!(parse_args::<ListDirArgs>("list_dir", serde_json::Value::Null).is_ok());
    }

    #[test]
    fn an_edit_preview_changes_nothing_and_fingerprints_what_it_saw() {
        let dir = ws_files(&[("a.py", "x = 1\n")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let (_, preview) = preview_edit(
            &ws,
            &EditArgs {
                path: "a.py".into(),
                old_string: "1".into(),
                new_string: "2".into(),
            },
            Access::Write,
        )
        .unwrap();
        assert_eq!(preview.before.as_deref(), Some("x = 1\n"));
        assert_eq!(preview.after, "x = 2\n");
        assert_eq!(
            std::fs::read_to_string(root.join("a.py")).unwrap(),
            "x = 1\n"
        );
        assert_eq!(
            preview.before_sha256,
            fingerprint(&root.join("a.py"), ws.limits.read_max_file_bytes)
        );
    }

    #[test]
    fn an_edit_of_a_missing_file_or_an_unapproved_protected_one_is_refused() {
        let dir = ws_files(&[(".matterwaveignore", "secret/\n")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let missing = preview_edit(
            &ws,
            &EditArgs {
                path: "nope.py".into(),
                old_string: "a".into(),
                new_string: "b".into(),
            },
            Access::Write,
        )
        .err()
        .unwrap();
        assert_eq!(
            missing.output,
            "nope.py does not exist. Use write_file to create it."
        );
        let args = WriteFileArgs {
            path: ".matterwaveignore".into(),
            content: "".into(),
        };
        let protected = preview_write(&ws, &args, Access::Write).err().unwrap();
        assert!(protected.output.contains("can be read but not changed"));
        // With the person's yes it can be previewed and applied.
        assert!(preview_write(&ws, &args, Access::ApprovedWrite).is_ok());
    }
}
