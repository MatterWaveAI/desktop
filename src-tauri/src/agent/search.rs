//! What glob, grep and list_dir leave out, and the walk they share: a port
//! of the SDKs' `IgnoreFile`, `SearchIgnore` and `walk` (Python
//! `matterwave_sdk.agent.ignore` / `.search`, TypeScript `ignore.ts` /
//! `search.ts`), held to the contract's `conformance.ignore` and
//! `conformance.tools` cases (`conformance.rs`).
//!
//! The rules (the contract's `search.rules`):
//!
//! - every directory from the workspace root down may hold a `.gitignore`
//!   and a `.matterwaveignore`, read in that order; their patterns apply to
//!   that directory and everything under it, and no file above the root is
//!   read (nor `.git/info/exclude`, nor a global excludes file);
//! - the last rule that matches a path decides, so a `!` rule re-includes,
//!   but a path inside an ignored directory stays ignored;
//! - matching ignores case, on every platform;
//! - the deny list always wins, and cannot be re-included;
//! - the walk is depth first, a directory's files before its
//!   subdirectories, each in code-point order of their names; a link to a
//!   file is followed when it leads inside the root to a path that is not
//!   denied, and a link to a directory is listed but never walked into;
//! - only regular files and directories are walked: a pipe, socket or
//!   device, or a link to one, is left out (and never opened);
//! - a leading byte-order mark in an ignore file is dropped, and a line
//!   whose pattern is invalid (a `[...]` range that runs backwards) is
//!   skipped, as git skips it;
//! - the path a search is given is not itself checked against the ignore
//!   rules, though what is under it is.
//!
//! The host adds two things of its own: a walk stops at its next entry when
//! the run is stopped, and a run in a mode the person has not confirmed for
//! the folder this session leaves out the paths read only with their
//! native yes (`approval::read_gated`).

use super::confine::{glob_to_regex, relative_to, resolve_links, within, DenyList, GlobError, BOM};
use super::contract::SEARCH_IGNORE_FILES;
use regex::Regex;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

struct Rule {
    regex: Regex,
    negate: bool,
    dir_only: bool,
    anchored: bool,
}

/// One pattern's regular expression: the glob, with a backslash making the
/// next character literal. `GlobError` for a backwards `[...]` range.
fn pattern_regex(pattern: &str) -> Result<String, GlobError> {
    let mut out = String::new();
    let mut chunk = String::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push_str(&glob_to_regex(&chunk)?);
                out.push_str(&regex::escape(&next.to_string()));
                chunk.clear();
                continue;
            }
        }
        chunk.push(c);
    }
    out.push_str(&glob_to_regex(&chunk)?);
    Ok(out)
}

fn parse(line: &str) -> Option<Rule> {
    let mut text = line.strip_suffix('\r').unwrap_or(line);
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let negate = text.starts_with('!');
    if negate {
        text = &text[1..];
    }
    while text.ends_with(' ') && !text.ends_with("\\ ") {
        text = &text[..text.len() - 1];
    }
    let dir_only = text.ends_with('/');
    text = text.trim_end_matches('/');
    let anchored = text.contains('/');
    if let Some(rest) = text.strip_prefix('/') {
        text = rest;
    }
    if text.is_empty() {
        return None;
    }
    // An invalid line (a `[...]` range that runs backwards) is skipped, as
    // git skips it.
    let regex = Regex::new(&format!("(?i)^(?:{})$", pattern_regex(text).ok()?)).ok()?;
    Some(Rule {
        regex,
        negate,
        dir_only,
        anchored,
    })
}

/// The rules of one .gitignore-syntax file, for the directory holding it
/// (`base`, relative to the workspace root, empty for the root). A leading
/// byte-order mark is dropped, and an invalid line is skipped.
pub(crate) struct IgnoreFile {
    base: String,
    rules: Vec<Rule>,
}

impl IgnoreFile {
    pub fn new(text: &str, base: &str) -> Self {
        let text = text.strip_prefix(BOM).unwrap_or(text);
        IgnoreFile {
            base: base.trim_matches('/').to_string(),
            rules: text.split('\n').filter_map(parse).collect(),
        }
    }

    /// What this file says of `relative` (to the root, `/`-separated):
    /// `Some(true)` when its last matching rule ignores it, `Some(false)`
    /// when that rule re-includes it (`!`), `None` when no rule matches or
    /// the path is not under `base`. Only the path itself is matched;
    /// `SearchIgnore` checks the directories above it.
    pub fn verdict(&self, relative: &str, is_dir: bool) -> Option<bool> {
        let sub = if self.base.is_empty() {
            relative
        } else {
            relative.strip_prefix(&self.base)?.strip_prefix('/')?
        };
        let name = sub.rsplit('/').next().unwrap_or(sub);
        let mut verdict = None;
        for rule in &self.rules {
            if rule.dir_only && !is_dir {
                continue;
            }
            if rule.regex.is_match(if rule.anchored { sub } else { name }) {
                verdict = Some(!rule.negate);
            }
        }
        verdict
    }
}

/// Reads an ignore file by its path relative to the root; `None` when there
/// is no such file.
pub(crate) type ReadIgnoreFile = Box<dyn Fn(&str) -> Option<String>>;

/// The deny list plus every ignore file that applies to a path. Each
/// directory's files are read once, the first time a path under it is
/// checked.
pub(crate) struct SearchIgnore {
    pub deny: DenyList,
    read: ReadIgnoreFile,
    files: RefCell<HashMap<String, Rc<Vec<IgnoreFile>>>>,
}

impl SearchIgnore {
    pub fn new(read: ReadIgnoreFile, deny: DenyList) -> Self {
        SearchIgnore {
            deny,
            read,
            files: RefCell::new(HashMap::new()),
        }
    }

    /// The rules of the workspace at `root`, its ignore files read from
    /// disk (regular files only, as text with invalid bytes replaced).
    pub fn load(root: &Path, deny: DenyList) -> Self {
        let base = root.to_path_buf();
        let read: ReadIgnoreFile = Box::new(move |relative: &str| {
            let file = base.join(relative);
            if !std::fs::metadata(&file).is_ok_and(|m| m.is_file()) {
                return None;
            }
            std::fs::read(&file)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        });
        Self::new(read, deny)
    }

    /// The ignore files in `directory` (relative, empty for the root), the
    /// .gitignore before the .matterwaveignore.
    fn files_for(&self, directory: &str) -> Rc<Vec<IgnoreFile>> {
        let key = directory.trim_matches('/').to_string();
        if let Some(found) = self.files.borrow().get(&key) {
            return found.clone();
        }
        let loaded: Vec<IgnoreFile> = SEARCH_IGNORE_FILES
            .iter()
            .filter_map(|name| {
                let path = if key.is_empty() {
                    (*name).to_string()
                } else {
                    format!("{key}/{name}")
                };
                (self.read)(&path).map(|text| IgnoreFile::new(&text, &key))
            })
            .collect();
        let loaded = Rc::new(loaded);
        self.files.borrow_mut().insert(key, loaded.clone());
        loaded
    }

    fn ignored_here(&self, relative: &str, is_dir: bool) -> bool {
        let parts: Vec<&str> = relative.split('/').collect();
        let mut verdict = None;
        for depth in 0..parts.len() {
            for file in self.files_for(&parts[..depth].join("/")).iter() {
                if let Some(said) = file.verdict(relative, is_dir) {
                    verdict = Some(said);
                }
            }
        }
        verdict == Some(true)
    }

    /// Whether a search leaves `relative` (to the root, `/`-separated)
    /// out: denied, ignored, or (with `ancestors`) inside a directory that
    /// is. A walker that checks each directory before going into it passes
    /// `ancestors: false`.
    pub fn ignored(&self, relative: &str, is_dir: bool, ancestors: bool) -> bool {
        let path = relative
            .replace('\\', "/")
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .collect::<Vec<_>>()
            .join("/");
        if path.is_empty() {
            return false;
        }
        if self.deny.matches(&path, is_dir) {
            return true;
        }
        if ancestors {
            let parts: Vec<&str> = path.split('/').collect();
            for depth in 1..parts.len() {
                if self.ignored_here(&parts[..depth].join("/"), true) {
                    return true;
                }
            }
        }
        self.ignored_here(&path, is_dir)
    }
}

/// One entry a search may show.
pub(crate) struct Entry {
    /// Relative to the root, `/`-separated.
    pub relative: String,
    pub is_dir: bool,
    pub is_link: bool,
}

/// What an entry is, for one the tools may show: `(is_dir, is_link)`, or
/// `None` for a link that leads out of the root, dangles, loops or lands on
/// a denied path, and for anything that is neither a regular file nor a
/// directory (a pipe, a socket, a device), a link's target included.
fn kind_of(path: &Path, real_root: &Path, deny: &DenyList) -> Option<(bool, bool)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        let target = resolve_links(path).ok()?;
        if !within(&target, real_root) {
            return None;
        }
        let is_dir = target.is_dir();
        if !is_dir && !target.is_file() {
            return None;
        }
        let rel = relative_to(&target, real_root);
        if !rel.is_empty() && deny.matches(&rel, is_dir) {
            return None;
        }
        return Some((is_dir, true));
    }
    if meta.is_dir() {
        Some((true, false))
    } else if meta.is_file() {
        Some((false, false))
    } else {
        None
    }
}

/// The entries of `directory` (relative, empty for the root) a search
/// shows, in code-point order of their names. `hidden` leaves out more,
/// by relative path (the host's read gate).
pub(crate) fn entries(
    real_root: &Path,
    directory: &str,
    rules: &SearchIgnore,
    hidden: &dyn Fn(&str, bool) -> bool,
) -> Vec<Entry> {
    let absolute = if directory.is_empty() {
        real_root.to_path_buf()
    } else {
        real_root.join(directory)
    };
    let Ok(read) = std::fs::read_dir(&absolute) else {
        return Vec::new();
    };
    // A name that is not Unicode cannot be named back by the model; it is
    // left out rather than shown mangled.
    let mut names: Vec<String> = read
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort_unstable();
    let mut shown = Vec::new();
    for name in names {
        let Some((is_dir, is_link)) = kind_of(&absolute.join(&name), real_root, &rules.deny) else {
            continue;
        };
        let relative = if directory.is_empty() {
            name
        } else {
            format!("{directory}/{name}")
        };
        if rules.ignored(&relative, is_dir, false) || hidden(&relative, is_dir) {
            continue;
        }
        shown.push(Entry {
            relative,
            is_dir,
            is_link,
        });
    }
    shown
}

/// Whether a walk goes on after a file.
pub(crate) enum Walk {
    Next,
    Stop,
}

/// The files a search under `start` (relative to the root, `.` for the
/// root) sees, in walk order, each handed to `visit` until it says stop.
/// A file `start` is its own one result.
pub(crate) fn walk(
    real_root: &Path,
    start: &str,
    start_is_file: bool,
    rules: &SearchIgnore,
    hidden: &dyn Fn(&str, bool) -> bool,
    mut visit: impl FnMut(&str) -> Walk,
) {
    if start_is_file {
        visit(start);
        return;
    }
    let mut stack = vec![if start == "." {
        String::new()
    } else {
        start.to_string()
    }];
    while let Some(directory) = stack.pop() {
        let mut subdirs = Vec::new();
        for entry in entries(real_root, &directory, rules, hidden) {
            if !entry.is_dir {
                if let Walk::Stop = visit(&entry.relative) {
                    return;
                }
            } else if !entry.is_link {
                subdirs.push(entry.relative);
            }
        }
        stack.extend(subdirs.into_iter().rev());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(files: &[(&'static str, &'static str)]) -> SearchIgnore {
        let files: Vec<(&'static str, &'static str)> = files.to_vec();
        SearchIgnore::new(
            Box::new(move |relative: &str| {
                files
                    .iter()
                    .find(|(path, _)| *path == relative)
                    .map(|(_, text)| text.to_string())
            }),
            DenyList::defaults(),
        )
    }

    #[test]
    fn the_last_matching_rule_decides_and_a_bang_re_includes() {
        let r = rules(&[(".gitignore", "*.log\n!keep.log\n")]);
        assert!(r.ignored("app.log", false, true));
        assert!(!r.ignored("keep.log", false, true));
        assert!(r.ignored("APP.LOG", false, true), "case is ignored");
    }

    #[test]
    fn a_path_in_an_ignored_directory_stays_ignored() {
        let r = rules(&[(".gitignore", "build/\n!build/keep.txt\n")]);
        assert!(r.ignored("build/keep.txt", false, true));
        assert!(!r.ignored("build/keep.txt", false, false));
    }

    #[test]
    fn a_nested_file_applies_below_its_own_directory_only() {
        let r = rules(&[
            ("src/.gitignore", "generated/\n"),
            ("docs/.matterwaveignore", "*.draft\n"),
        ]);
        assert!(r.ignored("src/generated/x.py", false, true));
        assert!(!r.ignored("generated/x.py", false, true));
        assert!(r.ignored("docs/x.draft", false, true));
        assert!(!r.ignored("x.draft", false, true));
    }

    #[test]
    fn escapes_comments_and_trailing_spaces_follow_gitignore() {
        let r = rules(&[(
            ".gitignore",
            "# note\n\\#hash.txt\n\\!bang.txt\ntrail.txt   \n",
        )]);
        assert!(r.ignored("#hash.txt", false, true));
        assert!(r.ignored("!bang.txt", false, true));
        assert!(r.ignored("trail.txt", false, true));
        assert!(!r.ignored("# note", false, true));
    }

    #[test]
    fn a_bom_is_dropped_and_an_invalid_line_skipped_not_matched_literally() {
        let r = rules(&[
            (".gitignore", "\u{feff}*.log\n[z-a]*\n!keep.log\n"),
            ("src/.matterwaveignore", "\u{feff}gen/\n[9-0]\n"),
        ]);
        assert!(r.ignored("app.log", false, true));
        assert!(!r.ignored("keep.log", false, true));
        assert!(!r.ignored("z.py", false, true) && !r.ignored("[z-a]x", false, true));
        assert!(r.ignored("src/gen/x.py", false, true));
        assert!(!r.ignored("src/[9-0]", false, true));
    }

    #[test]
    fn the_deny_list_cannot_be_re_included() {
        let r = rules(&[(".gitignore", "!.env\n")]);
        assert!(r.ignored(".env", false, true));
        assert!(r.ignored(".git/HEAD", false, false));
    }
}
