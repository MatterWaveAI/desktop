//! Path confinement: the check every tool runs before it touches a path.
//!
//! A port of the SDKs' `confine` (Python `matterwave_sdk.agent.confine`,
//! TypeScript `src/agent/confine.ts`), run against the same conformance
//! cases (`agent/conformance.json`). Every path the webview sends is
//! resolved against the workspace root here, never trusted as given:
//!
//! - an empty path, and a path with a `..` segment, are refused outright;
//! - an absolute path is allowed only when it lies under the root;
//! - links (symbolic links, and junctions on Windows) are followed, and
//!   the place they lead must still be under the root;
//! - the deny list (the contract's defaults plus `.matterwaveignore`)
//!   refuses a path by its own name or by where its links lead, for
//!   reading as well as writing;
//! - a write also refuses the protected paths, which can be read only.
//!
//! Confinement is not a sandbox: it keeps the file tools inside the root,
//! and `run_shell` can reach anything the user can, which is why commands
//! ask first.

use super::contract::{Refusal, DEFAULT_DENY, DENY_FILE, PROTECTED};
use regex::Regex;
use std::path::{Component, Path, PathBuf};

const MAX_LINK_HOPS: usize = 40;

/// A path the agent may not use: the contract's code and its sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PathRefused {
    pub reason: Refusal,
    pub message: String,
}

impl PathRefused {
    pub fn new(reason: Refusal, path: &str) -> Self {
        PathRefused {
            reason,
            message: reason.template().replace("{path}", path),
        }
    }
}

/// The regular expression (to be matched whole) for one glob: `*` and `?`
/// stay within a segment, `**` followed by `/` spans any number of
/// segments, `[...]` is a class (`[!...]` negated), everything else is
/// literal.
pub(crate) fn glob_to_regex(glob: &str) -> String {
    let chars: Vec<char> = glob.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                if chars.get(i + 2) == Some(&'/') {
                    out.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    out.push_str(".*");
                    i += 2;
                }
                continue;
            }
            out.push_str("[^/]*");
        } else if c == '?' {
            out.push_str("[^/]");
        } else if c == '[' {
            // The class runs to the next `]` after at least one character.
            let end = (i + 2..chars.len()).find(|&j| chars[j] == ']');
            match end {
                None => out.push_str("\\["),
                Some(end) => {
                    let mut body: String = chars[i + 1..end].iter().collect();
                    if let Some(rest) = body.strip_prefix('!') {
                        body = format!("^{rest}");
                    }
                    // Within a class only `\`, `[` and the set operators mean
                    // anything to `regex` beyond what a glob class means;
                    // they are taken literally.
                    let escaped: String = body
                        .chars()
                        .enumerate()
                        .map(|(n, ch)| match ch {
                            '\\' | '[' | '&' | '~' => format!("\\{ch}"),
                            '-' if n == 0 => "\\-".to_string(),
                            other => other.to_string(),
                        })
                        .collect();
                    out.push('[');
                    out.push_str(&escaped);
                    out.push(']');
                    i = end + 1;
                    continue;
                }
            }
        } else {
            out.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    out
}

struct Pattern {
    regex: Regex,
    dir_only: bool,
    anchored: bool,
}

fn compile(pattern: &str) -> Option<Pattern> {
    let mut text = pattern.trim();
    if text.is_empty() || text.starts_with('#') || text.starts_with('!') {
        return None;
    }
    let dir_only = text.ends_with('/');
    text = text.trim_end_matches('/');
    let anchored = text.starts_with('/') || text.contains('/');
    text = text.trim_start_matches('/');
    if text.is_empty() {
        return None;
    }
    let source = format!("(?i)^(?:{})$", glob_to_regex(text));
    // A pattern `regex` cannot compile is taken literally rather than
    // dropped: a deny list fails closed.
    let regex = Regex::new(&source)
        .or_else(|_| Regex::new(&format!("(?i)^{}$", regex::escape(text))))
        .ok()?;
    Some(Pattern {
        regex,
        dir_only,
        anchored,
    })
}

/// Patterns a path may not match: the contract's defaults plus the
/// workspace's `.matterwaveignore` lines. The syntax is the contract's
/// `pattern_syntax`, a subset of .gitignore's without negation.
pub(crate) struct DenyList {
    compiled: Vec<Pattern>,
}

impl DenyList {
    pub fn new<'a>(patterns: impl IntoIterator<Item = &'a str>) -> Self {
        DenyList {
            compiled: patterns.into_iter().filter_map(compile).collect(),
        }
    }

    pub fn defaults() -> Self {
        Self::new(DEFAULT_DENY.iter().copied())
    }

    /// The defaults plus every pattern line of a `.matterwaveignore`'s text.
    pub fn with_ignore_file(text: &str) -> Self {
        Self::new(DEFAULT_DENY.iter().copied().chain(text.lines()))
    }

    /// The defaults plus `<root>/.matterwaveignore`, when there is one.
    pub fn load(root: &Path) -> Self {
        match std::fs::read_to_string(root.join(DENY_FILE)) {
            Ok(text) => Self::with_ignore_file(&text),
            Err(_) => Self::defaults(),
        }
    }

    pub fn protected() -> Self {
        Self::new(PROTECTED.iter().copied())
    }

    /// Whether `relative` (to the root, `/`-separated) is denied. A pattern
    /// that matches a directory on the way denies everything under it;
    /// `is_dir` says whether the last segment is a directory.
    pub fn matches(&self, relative: &str, is_dir: bool) -> bool {
        let normal = relative.replace('\\', "/");
        let segments: Vec<&str> = normal
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .collect();
        let last = segments.len().saturating_sub(1);
        for pattern in &self.compiled {
            for index in 0..segments.len() {
                let segment_is_dir = index < last || is_dir;
                if pattern.dir_only && !segment_is_dir {
                    continue;
                }
                let subject = if pattern.anchored {
                    segments[..=index].join("/")
                } else {
                    segments[index].to_string()
                };
                if pattern.regex.is_match(&subject) {
                    return true;
                }
            }
        }
        false
    }
}

/// Absolute on any platform: a leading `/` or `\`, or a drive letter, so a
/// Windows path is not taken for a relative one on POSIX, nor `/etc` for a
/// relative one on Windows.
pub(crate) fn is_absolute_any(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// `\\?\C:\x` -> `C:\x`, `\\?\UNC\host\share` -> `\\host\share`: what
/// `canonicalize` and `read_link` hand back on Windows, made comparable with
/// the paths a person types.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    for prefix in [r"\\?\", r"\??\"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return PathBuf::from(rest);
        }
    }
    path
}

/// `.` and `..` folded away without touching the filesystem.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root or the prefix.
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir) | Some(Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// `path` with every link in it followed, whether or not its target
/// exists: the deepest part that exists is resolved by the OS, and a
/// dangling link is read and followed by hand, so a write through it is
/// caught as well as a read.
pub(crate) fn resolve_links(path: &Path) -> Result<PathBuf, String> {
    let mut current = lexical_normalize(&std::path::absolute(path).map_err(|e| e.to_string())?);
    for _ in 0..MAX_LINK_HOPS {
        let mut head = current.clone();
        let mut rest: Vec<std::ffi::OsString> = Vec::new();
        while std::fs::symlink_metadata(&head).is_err() {
            match (head.parent(), head.file_name()) {
                (Some(parent), Some(name)) if parent != head => {
                    rest.push(name.to_os_string());
                    head = parent.to_path_buf();
                }
                _ => break,
            }
        }
        let rest_path: PathBuf = rest.iter().rev().collect();
        if is_link(&head) && !head.exists() {
            let target = strip_verbatim(std::fs::read_link(&head).map_err(|e| e.to_string())?);
            let base = if target.is_absolute() {
                target
            } else {
                head.parent().unwrap_or(&head).join(target)
            };
            current = lexical_normalize(&base.join(rest_path));
            continue;
        }
        let real = std::fs::canonicalize(&head)
            .map(strip_verbatim)
            .unwrap_or(head);
        return Ok(if rest.is_empty() {
            real
        } else {
            real.join(rest_path)
        });
    }
    Err(format!(
        "too many levels of links resolving {}",
        path.display()
    ))
}

/// The comparable form of a path: `/`-separated, without a trailing
/// separator, lower-cased where the filesystem ignores case (Windows).
fn comparable(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

pub(crate) fn within(child: &Path, parent: &Path) -> bool {
    let c = comparable(child);
    let p = comparable(parent);
    c == p || c.starts_with(&format!("{p}/"))
}

/// `child` relative to `parent`, `/`-separated; empty for the parent itself.
/// Only called once `within` holds.
pub(crate) fn relative_to(child: &Path, parent: &Path) -> String {
    let c = child.to_string_lossy().replace('\\', "/");
    let p = parent
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    c.get(p.len()..)
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string()
}

/// Where a tool's path really leads: `absolute`, with every link followed,
/// and `relative`, the same place relative to the resolved root (`.` for
/// the root itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Confined {
    pub absolute: PathBuf,
    pub relative: String,
}

/// Where `path` leads inside `root`, or the refusal. `deny` is the root's
/// deny list (`DenyList::load`); `write` also refuses the protected paths.
pub(crate) fn confine(
    root: &Path,
    path: &str,
    deny: &DenyList,
    write: bool,
) -> Result<Confined, PathRefused> {
    if path.trim().is_empty() {
        return Err(PathRefused::new(Refusal::Empty, path));
    }
    if path.contains('\0') {
        return Err(PathRefused::new(Refusal::Outside, &path.replace('\0', "")));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(PathRefused::new(Refusal::Parent, path));
    }
    let outside = || PathRefused::new(Refusal::Outside, path);

    let given_root = lexical_normalize(&std::path::absolute(root).map_err(|_| outside())?);
    let real_root = resolve_links(&given_root).map_err(|_| outside())?;
    let (lexical, lexical_rel) = if is_absolute_any(path) {
        let mut candidate = PathBuf::from(path);
        // `/etc/passwd` on Windows has no drive; it is on the root's drive.
        if !candidate.is_absolute() {
            let prefix: PathBuf = real_root
                .components()
                .take_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
                .collect();
            candidate = prefix.join(path.trim_start_matches(['/', '\\']));
        }
        let lexical = lexical_normalize(&candidate);
        if within(&lexical, &real_root) {
            let rel = relative_to(&lexical, &real_root);
            (lexical, rel)
        } else if within(&lexical, &given_root) {
            let rel = relative_to(&lexical, &given_root);
            (lexical, rel)
        } else {
            return Err(outside());
        }
    } else {
        let lexical = lexical_normalize(&real_root.join(path));
        let rel = relative_to(&lexical, &real_root);
        (lexical, rel)
    };

    let real = resolve_links(&lexical).map_err(|_| PathRefused::new(Refusal::Symlink, path))?;
    if !within(&real, &real_root) {
        return Err(PathRefused::new(Refusal::Symlink, path));
    }
    let real_rel = relative_to(&real, &real_root);

    let is_dir = real.is_dir();
    for rel in [&lexical_rel, &real_rel] {
        if !rel.is_empty() && deny.matches(rel, is_dir) {
            return Err(PathRefused::new(Refusal::Denied, path));
        }
    }
    if write {
        let protected = DenyList::protected();
        for rel in [&lexical_rel, &real_rel] {
            if !rel.is_empty() && protected.matches(rel, is_dir) {
                return Err(PathRefused::new(Refusal::Protected, path));
            }
        }
    }
    Ok(Confined {
        absolute: real,
        relative: if real_rel.is_empty() {
            ".".to_string()
        } else {
            real_rel
        },
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    pub(crate) const CONFORMANCE: &str = include_str!("../../agent/conformance.json");

    pub(crate) fn conformance() -> Value {
        serde_json::from_str(CONFORMANCE).expect("agent/conformance.json parses")
    }

    /// A workspace built from a `{path: content}` map, in a fresh temp dir.
    pub(crate) fn tree(files: &serde_json::Map<String, Value>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content.as_str().unwrap()).unwrap();
        }
        dir
    }

    #[test]
    fn the_deny_cases_of_the_shared_conformance_set() {
        let c = conformance();
        let extra: Vec<&str> = c["deny"]["extra_patterns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        let deny = DenyList::new(DEFAULT_DENY.iter().copied().chain(extra));
        for case in c["deny"]["cases"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let is_dir = case["is_dir"].as_bool().unwrap_or(false);
            assert_eq!(
                deny.matches(path, is_dir),
                case["denied"].as_bool().unwrap(),
                "{path} (is_dir {is_dir})"
            );
        }
    }

    #[test]
    fn the_confinement_cases_of_the_shared_conformance_set() {
        let c = conformance();
        let ws = tree(c["confinement"]["tree"].as_object().unwrap());
        let root = ws.path();
        let deny = DenyList::load(root);
        for case in c["confinement"]["cases"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let write = case["write"].as_bool().unwrap_or(false);
            let got = confine(root, path, &deny, write);
            match case["refused"].as_str() {
                Some(code) => {
                    let err = got.expect_err(path);
                    assert_eq!(err.reason.code(), code, "{path}");
                    if let Some(message) = case["message"].as_str() {
                        assert_eq!(err.message, message, "{path}");
                    }
                }
                None => {
                    let ok = got.unwrap_or_else(|e| panic!("{path}: {e:?}"));
                    assert_eq!(ok.relative, case["relative"].as_str().unwrap(), "{path}");
                }
            }
        }
    }

    #[test]
    fn dot_dot_is_refused_in_any_spelling() {
        let ws = tempfile::tempdir().unwrap();
        let deny = DenyList::defaults();
        for path in ["..", "../x", "a/../../x", r"a\..\..\x", "a/..", "./../x"] {
            let err = confine(ws.path(), path, &deny, false).unwrap_err();
            assert_eq!(err.reason, Refusal::Parent, "{path}");
        }
    }

    #[test]
    fn an_absolute_path_outside_the_root_is_refused_and_one_inside_is_not() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("ws");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "a").unwrap();
        std::fs::write(outer.path().join("secret.txt"), "s").unwrap();
        let deny = DenyList::defaults();

        let outside = outer.path().join("secret.txt");
        let err = confine(&root, &outside.to_string_lossy(), &deny, false).unwrap_err();
        assert_eq!(err.reason, Refusal::Outside);
        // A sibling whose name starts with the root's is still outside.
        std::fs::create_dir_all(outer.path().join("ws-other")).unwrap();
        let sibling = outer.path().join("ws-other");
        let err = confine(&root, &sibling.to_string_lossy(), &deny, false).unwrap_err();
        assert_eq!(err.reason, Refusal::Outside);
        let system = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };
        assert_eq!(
            confine(&root, system, &deny, false).unwrap_err().reason,
            Refusal::Outside
        );

        let inside = root.join("src").join("a.txt");
        let ok = confine(&root, &inside.to_string_lossy(), &deny, false).unwrap();
        assert_eq!(ok.relative, "src/a.txt");
        // Rooted without a drive, on Windows: the root's own drive.
        if cfg!(windows) {
            let real = resolve_links(&inside).unwrap();
            let rooted = real.to_string_lossy()[2..].to_string();
            let ok = confine(&root, &rooted, &deny, false).unwrap();
            assert_eq!(ok.relative, "src/a.txt", "{rooted}");
        }
    }

    #[test]
    fn env_files_are_refused_for_reading_and_writing() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join(".env"), "KEY=1").unwrap();
        let deny = DenyList::load(ws.path());
        for (path, write) in [
            (".env", false),
            (".env", true),
            (".env.local", true),
            ("app/.env", false),
        ] {
            let err = confine(ws.path(), path, &deny, write).unwrap_err();
            assert_eq!(err.reason, Refusal::Denied, "{path}");
        }
    }

    /// Makes a link at `link` to `target`, or says why it cannot: Windows
    /// needs Developer Mode or the privilege for a symbolic link, so a
    /// directory junction stands in there, which is the link a Windows
    /// user's tooling makes anyway.
    fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return Ok(());
            }
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("mklink /J failed: {status}"))
            }
        }
    }

    #[test]
    fn a_link_out_of_the_root_is_refused_for_reads_and_writes() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("ws");
        let away = outer.path().join("away");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&away).unwrap();
        std::fs::write(away.join("secret.txt"), "s").unwrap();
        if let Err(why) = link_dir(&away, &root.join("escape")) {
            eprintln!("skipped: cannot make a directory link here ({why})");
            return;
        }
        let deny = DenyList::defaults();
        for (path, write) in [
            ("escape/secret.txt", false),
            ("escape/new.txt", true),
            ("escape", false),
        ] {
            let err = confine(&root, path, &deny, write).unwrap_err();
            assert_eq!(err.reason, Refusal::Symlink, "{path}");
        }
    }

    #[test]
    fn a_link_inside_the_root_resolves_to_its_target_and_its_deny_entry() {
        let ws = tempfile::tempdir().unwrap();
        let root = ws.path();
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/a.txt"), "a").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        if let Err(why) = link_dir(&root.join("real"), &root.join("alias")) {
            eprintln!("skipped: cannot make a directory link here ({why})");
            return;
        }
        link_dir(&root.join(".git"), &root.join("gitlink")).unwrap();
        let deny = DenyList::defaults();
        let ok = confine(root, "alias/a.txt", &deny, false).unwrap();
        assert_eq!(ok.relative, "real/a.txt");
        // Denied by where it leads, not by its own name.
        let err = confine(root, "gitlink", &deny, false).unwrap_err();
        assert_eq!(err.reason, Refusal::Denied);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_link_out_of_the_root_is_refused_for_a_write() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outer.path().join("not-yet"), root.join("out.txt")).unwrap();
        let err = confine(&root, "out.txt", &DenyList::defaults(), true).unwrap_err();
        assert_eq!(err.reason, Refusal::Symlink);
    }

    #[test]
    fn globs_compile_as_the_sdks_do() {
        assert_eq!(glob_to_regex("*.py"), "[^/]*\\.py");
        assert_eq!(glob_to_regex("src/**/*.ts"), "src/(?:.*/)?[^/]*\\.ts");
        assert_eq!(glob_to_regex("a?c"), "a[^/]c");
        assert_eq!(glob_to_regex("[!x]y"), "[^x]y");
        assert_eq!(glob_to_regex("[abc"), "\\[abc");
        let re = Regex::new(&format!("^{}$", glob_to_regex("**/cache"))).unwrap();
        assert!(re.is_match("cache"));
        assert!(re.is_match("a/b/cache"));
    }
}
