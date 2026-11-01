//! The file tools: `read_file`, `list_dir`, `glob`, `grep`, and the two
//! writes, `edit` and `write_file`, each split into a preview (what the
//! change would be, for the diff) and an apply (the change, once approved).
//!
//! Every path goes through `confine` first; the walks behind `list_dir`,
//! `glob` and `grep` skip what `.gitignore` and `.matterwaveignore` ignore
//! and never descend into a denied directory, and a link met on the way is
//! confined like any other path before it is read. Refusals come back as
//! the tool's result, in the contract's words, for the model to read.

use super::confine::{confine, glob_to_regex, relative_to, Confined, DenyList};
use super::contract::{
    EditFailure, LIST_MAX_ENTRIES, READ_MAX_BYTES, READ_MAX_LINES, SEARCH_IGNORE_FILES,
    SEARCH_MAX_RESULTS,
};
use super::edit::{apply_edit, EditError};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Files larger than this are not read whole, searched, or snapshotted.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Bytes looked at to decide that a file is binary (a NUL among them).
const BINARY_SNIFF_BYTES: usize = 8000;
/// A grep match line is shown up to this many characters.
const GREP_LINE_CHARS: usize = 400;

/// What a tool hands back for the model: the text, and whether it is an
/// error (a refusal, a bad argument, a failed edit).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ToolOutput {
    pub output: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(output: impl Into<String>) -> Self {
        ToolOutput {
            output: output.into(),
            is_error: false,
        }
    }

    pub fn error(output: impl Into<String>) -> Self {
        ToolOutput {
            output: output.into(),
            is_error: true,
        }
    }
}

/// A workspace: the root the person picked, already canonical, and its
/// deny list as of this call. `cancelled` lets a long walk stop early when
/// the run is stopped.
pub(crate) struct Workspace<'a> {
    pub root: &'a Path,
    pub deny: DenyList,
    pub cancelled: &'a AtomicBool,
}

impl<'a> Workspace<'a> {
    pub fn new(root: &'a Path, cancelled: &'a AtomicBool) -> Self {
        Workspace {
            root,
            deny: DenyList::load(root),
            cancelled,
        }
    }

    fn confine(&self, path: &str, write: bool) -> Result<Confined, ToolOutput> {
        confine(self.root, path, &self.deny, write).map_err(|r| ToolOutput::error(r.message))
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
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
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
    pub timeout_s: Option<u64>,
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// The text of a file, or why it cannot be had as text.
fn read_text(path: &Path, shown: &str) -> Result<String, ToolOutput> {
    let meta = std::fs::metadata(path)
        .map_err(|_| ToolOutput::error(format!("{shown} does not exist.")))?;
    if meta.is_dir() {
        return Err(ToolOutput::error(format!(
            "{shown} is a directory. Use list_dir to see what is in it."
        )));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(ToolOutput::error(format!(
            "{shown} is {} bytes, over the {} bytes a tool reads.",
            meta.len(),
            MAX_FILE_BYTES
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| ToolOutput::error(format!("{shown} could not be read: {e}")))?;
    if is_binary(&bytes) {
        return Err(ToolOutput::error(format!(
            "{shown} is a binary file, not text."
        )));
    }
    String::from_utf8(bytes).map_err(|_| ToolOutput::error(format!("{shown} is not UTF-8 text.")))
}

pub(crate) fn read_file(ws: &Workspace, args: ReadFileArgs) -> ToolOutput {
    let target = match ws.confine(&args.path, false) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let text = match read_text(&target.absolute, &args.path) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if text.is_empty() {
        return ToolOutput::ok(format!("({} is empty.)", target.relative));
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total = lines.len();
    let start = args.start_line.unwrap_or(1).max(1) as usize;
    if start > total {
        return ToolOutput::error(format!(
            "start_line {start} is past the end of {} ({total} lines).",
            target.relative
        ));
    }
    let wanted_end = args
        .end_line
        .map(|e| (e as usize).min(total))
        .unwrap_or(total);
    if wanted_end < start {
        return ToolOutput::error(format!(
            "end_line {wanted_end} is before start_line {start}."
        ));
    }
    let mut out = String::new();
    let mut last = start - 1;
    for (n, line) in lines.iter().enumerate().take(wanted_end).skip(start - 1) {
        let shown = line.trim_end_matches('\n').trim_end_matches('\r');
        let entry = format!("{}\t{}\n", n + 1, shown);
        if n + 1 - start >= READ_MAX_LINES || out.len() + entry.len() > READ_MAX_BYTES {
            break;
        }
        out.push_str(&entry);
        last = n + 1;
    }
    if last < wanted_end {
        out.push_str(&format!(
            "[Cut off at the read limit: showing lines {start}-{last} of {total}. Pass start_line={} to read on.]\n",
            last + 1
        ));
    }
    ToolOutput::ok(out)
}

/// The walker every search uses: `.gitignore` (and git's own excludes) and
/// `.matterwaveignore` honoured whether or not the folder is a repository,
/// hidden files included (only ignore files decide what is skipped), links
/// not followed, and denied directories never entered.
fn walker(ws: &Workspace, start: &Path, max_depth: Option<usize>) -> ignore::Walk {
    let root = ws.root.to_path_buf();
    let deny = DenyList::load(ws.root);
    let mut builder = ignore::WalkBuilder::new(start);
    builder
        .hidden(false)
        .parents(true)
        .ignore(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(max_depth)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            let rel = relative_to(entry.path(), &root);
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            rel.is_empty() || !deny.matches(&rel, is_dir)
        });
    // `.gitignore` is git_ignore's; the contract's other ignore files are
    // read with the same syntax.
    for name in SEARCH_IGNORE_FILES.iter().filter(|n| **n != ".gitignore") {
        builder.add_custom_ignore_filename(name);
    }
    builder.build()
}

/// A walked entry the tools may report: inside the root after its links are
/// followed and not denied there. `None` for anything else.
fn admit(ws: &Workspace, entry: &ignore::DirEntry) -> Option<Confined> {
    let rel = relative_to(entry.path(), ws.root);
    if rel.is_empty() {
        return None;
    }
    if entry.path_is_symlink() {
        // A link is a path like any other: confined by where it leads.
        return confine(ws.root, &rel, &ws.deny, false).ok();
    }
    Some(Confined {
        absolute: entry.path().to_path_buf(),
        relative: rel,
    })
}

fn search_start(ws: &Workspace, path: Option<&str>) -> Result<Confined, ToolOutput> {
    match path {
        None => Ok(Confined {
            absolute: ws.root.to_path_buf(),
            relative: ".".into(),
        }),
        Some(p) if p.trim().is_empty() || p.trim() == "." => Ok(Confined {
            absolute: ws.root.to_path_buf(),
            relative: ".".into(),
        }),
        Some(p) => ws.confine(p, false),
    }
}

pub(crate) fn list_dir(ws: &Workspace, args: ListDirArgs) -> ToolOutput {
    let dir = match search_start(ws, args.path.as_deref()) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !dir.absolute.is_dir() {
        return ToolOutput::error(format!(
            "{} is not a directory. Use read_file to read a file.",
            args.path.as_deref().unwrap_or(".")
        ));
    }
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in walker(ws, &dir.absolute, Some(1)).flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Some(admitted) = admit(ws, &entry) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if admitted.absolute.is_dir() {
            dirs.push(format!("{name}/"));
        } else {
            files.push(name);
        }
    }
    let total = dirs.len() + files.len();
    if total == 0 {
        return ToolOutput::ok(format!("({} is empty.)", dir.relative));
    }
    let mut out: Vec<String> = dirs
        .into_iter()
        .chain(files)
        .take(LIST_MAX_ENTRIES)
        .collect();
    if total > LIST_MAX_ENTRIES {
        out.push(format!(
            "[{} more entries not shown.]",
            total - LIST_MAX_ENTRIES
        ));
    }
    ToolOutput::ok(out.join("\n"))
}

/// A glob as the search tools apply it: a pattern without `/` matches a
/// file's name at any depth (`*.ts`); one with `/` matches the path from
/// the search directory (`src/**/*.ts`).
struct PathGlob {
    regex: Regex,
    by_name: bool,
}

impl PathGlob {
    fn new(pattern: &str) -> Result<Self, ToolOutput> {
        let trimmed = pattern.trim().trim_start_matches("./");
        if trimmed.is_empty() {
            return Err(ToolOutput::error("The glob pattern is empty."));
        }
        let regex = Regex::new(&format!("^(?:{})$", glob_to_regex(trimmed)))
            .map_err(|e| ToolOutput::error(format!("Invalid glob pattern {pattern:?}: {e}")))?;
        Ok(PathGlob {
            regex,
            by_name: !trimmed.contains('/'),
        })
    }

    fn matches(&self, from_start: &str) -> bool {
        if self.by_name {
            let name = from_start.rsplit('/').next().unwrap_or(from_start);
            self.regex.is_match(name)
        } else {
            self.regex.is_match(from_start)
        }
    }
}

fn under(start: &Confined, relative: &str) -> String {
    if start.relative == "." {
        relative.to_string()
    } else {
        relative
            .strip_prefix(&format!("{}/", start.relative))
            .unwrap_or(relative)
            .to_string()
    }
}

pub(crate) fn glob(ws: &Workspace, args: GlobArgs) -> ToolOutput {
    let start = match search_start(ws, args.path.as_deref()) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let pattern = match PathGlob::new(&args.pattern) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let mut hits = Vec::new();
    let mut more = 0usize;
    for entry in walker(ws, &start.absolute, None).flatten() {
        if ws.stopped() {
            return ToolOutput::error("Stopped by the user.");
        }
        if !entry
            .file_type()
            .is_some_and(|t| t.is_file() || t.is_symlink())
        {
            continue;
        }
        let Some(admitted) = admit(ws, &entry) else {
            continue;
        };
        if !admitted.absolute.is_file() {
            continue;
        }
        let shown = relative_to(entry.path(), ws.root);
        if !pattern.matches(&under(&start, &shown)) {
            continue;
        }
        if hits.len() < SEARCH_MAX_RESULTS {
            hits.push(shown);
        } else {
            more += 1;
        }
    }
    if hits.is_empty() {
        return ToolOutput::ok(format!("No files match {}.", args.pattern));
    }
    if more > 0 {
        hits.push(format!(
            "[{more} more matches not shown; narrow the pattern.]"
        ));
    }
    ToolOutput::ok(hits.join("\n"))
}

pub(crate) fn grep(ws: &Workspace, args: GrepArgs) -> ToolOutput {
    let start = match search_start(ws, args.path.as_deref()) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let regex = match RegexBuilder::new(&args.pattern)
        .case_insensitive(args.ignore_case.unwrap_or(false))
        .size_limit(10 * 1024 * 1024)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return ToolOutput::error(format!(
                "Invalid regular expression {:?}: {e}",
                args.pattern
            ))
        }
    };
    let filter = match args.glob.as_deref().map(PathGlob::new).transpose() {
        Ok(f) => f,
        Err(e) => return e,
    };
    // One file named directly is searched as it is; a directory is walked.
    let files: Vec<(PathBuf, String)> = if start.absolute.is_file() {
        vec![(start.absolute.clone(), start.relative.clone())]
    } else {
        let mut files = Vec::new();
        for entry in walker(ws, &start.absolute, None).flatten() {
            if !entry
                .file_type()
                .is_some_and(|t| t.is_file() || t.is_symlink())
            {
                continue;
            }
            let Some(admitted) = admit(ws, &entry) else {
                continue;
            };
            if !admitted.absolute.is_file() {
                continue;
            }
            let shown = relative_to(entry.path(), ws.root);
            if let Some(f) = &filter {
                if !f.matches(&under(&start, &shown)) {
                    continue;
                }
            }
            files.push((admitted.absolute, shown));
        }
        files
    };
    let mut hits = Vec::new();
    let mut more = 0usize;
    for (path, shown) in files {
        if ws.stopped() {
            return ToolOutput::error("Stopped by the user.");
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if is_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (n, line) in text.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            if hits.len() >= SEARCH_MAX_RESULTS {
                more += 1;
                continue;
            }
            let mut shown_line: String = line.chars().take(GREP_LINE_CHARS).collect();
            if line.chars().count() > GREP_LINE_CHARS {
                shown_line.push('…');
            }
            hits.push(format!("{shown}:{}: {}", n + 1, shown_line.trim_end()));
        }
    }
    if hits.is_empty() {
        return ToolOutput::ok(format!("No matches for {}.", args.pattern));
    }
    if more > 0 {
        hits.push(format!(
            "[{more} more matches not shown; narrow the search.]"
        ));
    }
    ToolOutput::ok(hits.join("\n"))
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
pub(crate) fn fingerprint(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => hex(&Sha256::digest(&bytes)),
        Err(_) => "absent".to_string(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The new content an `edit` produces, or why it cannot.
pub(crate) fn preview_edit(
    ws: &Workspace,
    args: &EditArgs,
) -> Result<(Confined, WritePreview), ToolOutput> {
    let target = ws.confine(&args.path, true)?;
    if !target.absolute.exists() {
        return Err(ToolOutput::error(
            EditError::new(EditFailure::Missing, &args.path, 0).message,
        ));
    }
    let before = read_text(&target.absolute, &args.path)?;
    let after = apply_edit(&before, &args.old_string, &args.new_string, &args.path)
        .map_err(|e| ToolOutput::error(e.message))?;
    let preview = WritePreview {
        relative: target.relative.clone(),
        before_sha256: fingerprint(&target.absolute),
        before: Some(before),
        after,
    };
    Ok((target, preview))
}

/// The content a `write_file` leaves, and what it replaces.
pub(crate) fn preview_write(
    ws: &Workspace,
    args: &WriteFileArgs,
) -> Result<(Confined, WritePreview), ToolOutput> {
    let target = ws.confine(&args.path, true)?;
    if target.absolute.is_dir() {
        return Err(ToolOutput::error(format!(
            "{} is a directory; write_file writes files.",
            args.path
        )));
    }
    let before = if target.absolute.exists() {
        Some(read_text(&target.absolute, &args.path)?)
    } else {
        None
    };
    let preview = WritePreview {
        relative: target.relative.clone(),
        before_sha256: fingerprint(&target.absolute),
        before,
        after: args.content.clone(),
    };
    Ok((target, preview))
}

/// Writes `content` to the confined target, creating missing parents
/// (they are under the root: the target was confined, and so is each
/// parent of a path under the root).
pub(crate) fn write_confined(target: &Confined, content: &str) -> Result<(), String> {
    if let Some(parent) = target.absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target.absolute, content).map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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
        super::super::confine::resolve_links(dir.path()).unwrap()
    }

    static RUNNING: AtomicBool = AtomicBool::new(false);

    #[test]
    fn read_file_numbers_lines_and_honours_the_range() {
        let dir = ws_files(&[("a.txt", "one\r\ntwo\nthree\n")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let all = read_file(
            &ws,
            ReadFileArgs {
                path: "a.txt".into(),
                start_line: None,
                end_line: None,
            },
        );
        assert_eq!(all, ToolOutput::ok("1\tone\n2\ttwo\n3\tthree\n"));
        let some = read_file(
            &ws,
            ReadFileArgs {
                path: "a.txt".into(),
                start_line: Some(2),
                end_line: Some(2),
            },
        );
        assert_eq!(some.output, "2\ttwo\n");
        let past = read_file(
            &ws,
            ReadFileArgs {
                path: "a.txt".into(),
                start_line: Some(9),
                end_line: None,
            },
        );
        assert!(past.is_error);
    }

    #[test]
    fn read_file_stops_at_the_line_limit_and_says_where_to_go_on() {
        let body: String = (1..=2500).map(|n| format!("line {n}\n")).collect();
        let dir = ws_files(&[("big.txt", &body)]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let out = read_file(
            &ws,
            ReadFileArgs {
                path: "big.txt".into(),
                start_line: None,
                end_line: None,
            },
        );
        assert!(out.output.contains("2000\tline 2000\n"));
        assert!(!out.output.contains("2001\tline 2001"));
        assert!(out.output.contains("Pass start_line=2001"));
    }

    #[test]
    fn read_file_refuses_secrets_and_binaries() {
        let dir = ws_files(&[(".env", "KEY=1"), ("bin.dat", "a\0b")]);
        let root = canonical(&dir);
        let ws = Workspace::new(&root, &RUNNING);
        let env = read_file(
            &ws,
            ReadFileArgs {
                path: ".env".into(),
                start_line: None,
                end_line: None,
            },
        );
        assert!(env.is_error);
        assert!(
            env.output.starts_with("Refused: .env is protected"),
            "{}",
            env.output
        );
        let bin = read_file(
            &ws,
            ReadFileArgs {
                path: "bin.dat".into(),
                start_line: None,
                end_line: None,
            },
        );
        assert!(bin.is_error && bin.output.contains("binary"));
    }

    #[test]
    fn list_dir_puts_directories_first_and_leaves_out_ignored_and_denied_entries() {
        let dir = ws_files(&[
            ("src/main.rs", "fn main() {}"),
            ("README.md", "# hi"),
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
        assert_eq!(
            out.output, "src/\n.gitignore\n.matterwaveignore\nREADME.md",
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
        assert_eq!(names.output, "lib/c.ts\nsrc/a.ts\nsrc/deep/b.ts");
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
        assert!(pem.output.starts_with("No files match"), "{}", pem.output);
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
        )
        .unwrap();
        assert_eq!(preview.before.as_deref(), Some("x = 1\n"));
        assert_eq!(preview.after, "x = 2\n");
        assert_eq!(
            std::fs::read_to_string(root.join("a.py")).unwrap(),
            "x = 1\n"
        );
        assert_eq!(preview.before_sha256, fingerprint(&root.join("a.py")));
    }

    #[test]
    fn an_edit_of_a_missing_file_or_a_protected_one_is_refused() {
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
        )
        .err()
        .unwrap();
        assert_eq!(
            missing.output,
            "nope.py does not exist. Use write_file to create it."
        );
        let protected = preview_write(
            &ws,
            &WriteFileArgs {
                path: ".matterwaveignore".into(),
                content: "".into(),
            },
        )
        .err()
        .unwrap();
        assert!(protected.output.contains("can be read but not changed"));
    }
}
