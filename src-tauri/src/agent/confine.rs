//! Path confinement: the check every tool runs before it touches a path.
//!
//! A port of the SDKs' `confine` (Python `matterwave_sdk.agent.confine`,
//! TypeScript `src/agent/confine.ts`), run against the same conformance
//! cases (`agent/contract.json`'s `conformance.paths` and
//! `agent/conformance.json`). Every path the webview sends is resolved
//! against the workspace root here, never trusted as given:
//!
//! - an empty path, and a path with a `..` segment, are refused outright;
//! - so, on every platform, is a name below the root that Windows would
//!   read as another file or a device (`windows_alias`);
//! - an absolute path is allowed only when it lies under the root;
//! - links (symbolic links, and junctions on Windows) are followed, and
//!   the place they lead must still be under the root; a link that loops
//!   is refused as `loop`;
//! - the deny list (the contract's defaults plus `.matterwaveignore`)
//!   refuses a path by its own name or by where its links lead, for
//!   reading as well as writing, ignoring case;
//! - a write also refuses the protected paths unless the person approved
//!   it in the native dialog.
//!
//! Confinement is not a sandbox: it keeps the file tools inside the root,
//! and `run_shell` can reach anything the user can, which is why commands
//! ask first.

use super::contract::{Refusal, DEFAULT_DENY, DENY_FILE, PROTECTED};
use regex::Regex;
use std::path::{Component, Path, PathBuf};

const MAX_LINK_HOPS: usize = 40;
/// A UTF-8 byte-order mark, which an ignore or deny file may start with.
pub(crate) const BOM: char = '\u{feff}';

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

/// A glob the contract calls invalid: a `[...]` class with a range that
/// runs backwards (`[z-a]`). glob and grep answer it with `invalid_glob`;
/// an ignore or deny file skips the line, as git does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GlobError;

fn escape_char(c: char) -> String {
    regex::escape(c.encode_utf8(&mut [0; 4]))
}

/// The regex for the `[...]` class at `chars[start]` and the index after
/// it, or `None` when no `]` closes it (the `[` is then literal). A `!` or
/// `^` first negates it, a `]` right after that (or right after the `[`) is
/// literal, `a-z` is a range and every other character is itself, each
/// escaped, so every regex dialect reads the class alike.
fn glob_class(chars: &[char], start: usize) -> Result<Option<(String, usize)>, GlobError> {
    let mut i = start + 1;
    let negate = matches!(chars.get(i), Some('!' | '^'));
    if negate {
        i += 1;
    }
    let body_start = i;
    if chars.get(i) == Some(&']') {
        i += 1;
    }
    let Some(end) = (i..chars.len()).find(|&j| chars[j] == ']') else {
        return Ok(None);
    };
    let body = &chars[body_start..end];
    let mut out = String::from(if negate { "[^" } else { "[" });
    let mut k = 0;
    while k < body.len() {
        if k + 2 < body.len() && body[k + 1] == '-' {
            let (low, high) = (body[k], body[k + 2]);
            if low > high {
                return Err(GlobError);
            }
            out.push_str(&escape_char(low));
            out.push('-');
            out.push_str(&escape_char(high));
            k += 3;
        } else {
            out.push_str(&escape_char(body[k]));
            k += 1;
        }
    }
    out.push(']');
    Ok(Some((out, end + 1)))
}

/// The regular expression (to be matched whole) for one glob: `*` and `?`
/// stay within a segment, `**` followed by `/` spans any number of
/// segments, `[...]` is a class (`[!...]` or `[^...]` negated, a `]` first
/// in it literal), everything else is literal. `GlobError` when a class's
/// range runs backwards (`[z-a]`).
pub(crate) fn glob_to_regex(glob: &str) -> Result<String, GlobError> {
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
            if let Some((class, next)) = glob_class(&chars, i)? {
                out.push_str(&class);
                i = next;
                continue;
            }
            out.push_str("\\[");
        } else {
            out.push_str(&escape_char(c));
        }
        i += 1;
    }
    Ok(out)
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
    // An invalid line (a `[...]` range that runs backwards) is skipped, as
    // git skips it, rather than failing every search and every `confine`.
    let regex = Regex::new(&format!("(?i)^(?:{})$", glob_to_regex(text).ok()?)).ok()?;
    Some(Pattern {
        regex,
        dir_only,
        anchored,
    })
}

/// Patterns a path may not match: the contract's defaults plus the
/// workspace's `.matterwaveignore` lines. The syntax is the contract's
/// `pattern_syntax`, a subset of .gitignore's without negation; matching
/// ignores case, and a line whose pattern is invalid is skipped. The
/// protected list is matched the same way.
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

    /// The defaults plus every pattern line of a `.matterwaveignore`'s text,
    /// a leading byte-order mark dropped.
    pub fn with_ignore_file(text: &str) -> Self {
        let text = text.strip_prefix(BOM).unwrap_or(text);
        Self::new(DEFAULT_DENY.iter().copied().chain(text.lines()))
    }

    /// The defaults plus `<root>/.matterwaveignore`, when there is one.
    pub fn load(root: &Path) -> Self {
        match std::fs::read(root.join(DENY_FILE)) {
            Ok(bytes) => Self::with_ignore_file(&String::from_utf8_lossy(&bytes)),
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

/// Whether `relative` (to the root, `/`-separated) is protected, so a write
/// to it asks the person first in every mode that writes.
pub(crate) fn is_protected(relative: &str, is_dir: bool) -> bool {
    DenyList::protected().matches(relative, is_dir)
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

/// The refusal for a path Windows could read as something other than the
/// file it seems to name, or `None`; the SDKs' `windows_alias`, applied on
/// every platform so the clients agree on what they refuse:
///
/// - `unc` for a path whose first two characters are both separators
///   (`\\server\share`, `\\?\C:\x`, `\\.\pipe\x`, `//server/x`) or that
///   starts `\??\`;
/// - then, after a leading drive (`C:` followed by a separator or the end),
///   name by name: `stream` for a `:` (an alternate data stream such as
///   `key.pem:x`, which writes data no listing, diff or git shows, or a
///   drive-relative `C:foo`), `trailing` for a name that ends in a dot or a
///   space (Windows drops them: `key.pem.` is `key.pem`), and `device` for
///   CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$ or CONOUT$ (any case, the
///   superscript digits too, with or without an extension).
///
/// Each is a way for the path the person approved to differ from the one
/// touched.
///
/// With `root`, the names are those below the root: an absolute path whose
/// leading names are the root's (compared name by name, case ignored, `/`
/// and `\` both separators) is checked from the name after them, so a root
/// inside `/x/con/` still takes absolute paths into it. Any other path is
/// checked whole, and the UNC check always reads the whole path. Pure:
/// nothing is read from disk.
pub(crate) fn windows_alias(path: &str, root: Option<&str>) -> Option<Refusal> {
    let mut chars = path.chars();
    let separator = |c: Option<char>| matches!(c, Some('\\' | '/'));
    if separator(chars.next()) && separator(chars.next()) {
        return Some(Refusal::Unc);
    }
    if path.starts_with("\\??\\") || path.starts_with("/??/") {
        return Some(Refusal::Unc);
    }
    let below_root = root.filter(|_| is_absolute_any(path)).and_then(|root| {
        let root: Vec<String> = names(root).map(str::to_lowercase).collect();
        let given: Vec<&str> = names(path).collect();
        let leading = given.get(..root.len())?;
        leading
            .iter()
            .zip(&root)
            .all(|(g, r)| g.to_lowercase() == *r)
            .then(|| given[root.len()..].to_vec())
    });
    let checked = below_root.unwrap_or_else(|| {
        let b = path.as_bytes();
        let rest = if b.len() >= 2
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b.get(2), None | Some(b'\\' | b'/'))
        {
            &path[2..]
        } else {
            path
        };
        names(rest).collect()
    });
    for name in checked {
        if name.contains(':') {
            return Some(Refusal::Stream);
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return Some(Refusal::Trailing);
        }
        let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
        if is_device(stem) {
            return Some(Refusal::Device);
        }
    }
    None
}

/// The names of `path`, split at `/` and `\`, without empty ones and `.`.
fn names(path: &str) -> impl Iterator<Item = &str> {
    path.split(['\\', '/'])
        .filter(|name| !name.is_empty() && *name != ".")
}

/// CON, PRN, AUX, NUL, COM1-9, LPT1-9 (¹ ² ³ too), CONIN$, CONOUT$, any case.
fn is_device(stem: &str) -> bool {
    let upper = stem.to_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    ["COM", "LPT"].iter().any(|prefix| {
        upper.strip_prefix(prefix).is_some_and(|digit| {
            let mut d = digit.chars();
            matches!(
                (d.next(), d.next()),
                (Some('1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None)
            )
        })
    })
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

/// Why `resolve_links` could not say where a path leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinkError {
    /// The links loop, or take more than 40 hops.
    Loop,
    /// The path cannot be made absolute, or a link cannot be read.
    Io(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Loop => f.write_str("too many levels of links"),
            LinkError::Io(e) => f.write_str(e),
        }
    }
}

impl From<LinkError> for String {
    fn from(e: LinkError) -> String {
        e.to_string()
    }
}

/// `path` with every link in it followed, whether or not its target
/// exists: the deepest part that exists is resolved by the OS, and a
/// dangling link is read and followed by hand, so a write through it is
/// caught as well as a read. `LinkError::Loop` when the links loop, or
/// take more than 40 hops.
pub(crate) fn resolve_links(path: &Path) -> Result<PathBuf, LinkError> {
    let io = |e: std::io::Error| LinkError::Io(e.to_string());
    let mut current = lexical_normalize(&std::path::absolute(path).map_err(io)?);
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
            let target = strip_verbatim(std::fs::read_link(&head).map_err(io)?);
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
    Err(LinkError::Loop)
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

/// The same place, as `within` compares paths.
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
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

/// What a path is confined for: a read, a write, or a write the person has
/// approved in the native dialog. Only the last reaches a protected path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    Read,
    Write,
    ApprovedWrite,
}

/// Where a tool's path really leads: `absolute`, with every link followed,
/// and `relative`, the same place relative to the resolved root (`.` for
/// the root itself). `lexical` is the path as given, relative to the root
/// before any link is followed (`.` for the root), which a check by name
/// (the protected list, the read gate) looks at as well as `relative`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Confined {
    pub absolute: PathBuf,
    pub relative: String,
    pub lexical: String,
}

impl Confined {
    /// Whether `list` matches this path by its own name or by where its
    /// links lead.
    pub fn matched_by(&self, list: &DenyList) -> bool {
        let is_dir = self.absolute.is_dir();
        [&self.lexical, &self.relative]
            .into_iter()
            .any(|rel| rel != "." && list.matches(rel, is_dir))
    }
}

/// Where `path` leads inside `root`, or the refusal. `deny` is the root's
/// deny list (`DenyList::load`). A write also refuses the protected paths
/// unless the person approved it (`Access::ApprovedWrite`).
///
/// In order, as the SDKs check: an empty path, a NUL, a `..` segment, a
/// Windows alias in the names below the root (`windows_alias`), then the
/// path against the root, its links (a loop is `loop`), the deny list and,
/// for a write, the protected list. No I/O or path error escapes as
/// anything but a refusal.
pub(crate) fn confine(
    root: &Path,
    path: &str,
    deny: &DenyList,
    access: Access,
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
    // A loop of links is `loop` wherever it is met; any other failure to
    // follow them is the refusal the caller names.
    let unresolved = |e: LinkError, otherwise: Refusal| match e {
        LinkError::Loop => PathRefused::new(Refusal::Loop, path),
        LinkError::Io(_) => PathRefused::new(otherwise, path),
    };

    let given_root = lexical_normalize(&std::path::absolute(root).map_err(|_| outside())?);
    let real_root = resolve_links(&given_root).map_err(|e| unresolved(e, Refusal::Outside))?;
    // Only the names below the root are the agent's; the folders above it
    // are the person's, whatever they are called.
    let mut alias = windows_alias(path, Some(&given_root.to_string_lossy()));
    if alias.is_some() && real_root != given_root {
        alias = windows_alias(path, Some(&real_root.to_string_lossy()));
    }
    if let Some(alias) = alias {
        return Err(PathRefused::new(alias, path));
    }
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

    let real = resolve_links(&lexical).map_err(|e| unresolved(e, Refusal::Symlink))?;
    if !within(&real, &real_root) {
        return Err(PathRefused::new(Refusal::Symlink, path));
    }
    let real_rel = relative_to(&real, &real_root);
    // The host's own, beyond the SDKs': on Windows the place a link leads
    // is held to the same rule as the path given.
    if cfg!(windows) {
        if let Some(alias) = windows_alias(&real_rel, None) {
            return Err(PathRefused::new(alias, path));
        }
    }

    let is_dir = real.is_dir();
    for rel in [&lexical_rel, &real_rel] {
        if !rel.is_empty() && deny.matches(rel, is_dir) {
            return Err(PathRefused::new(Refusal::Denied, path));
        }
    }
    if access == Access::Write {
        let protected = DenyList::protected();
        for rel in [&lexical_rel, &real_rel] {
            if !rel.is_empty() && protected.matches(rel, is_dir) {
                return Err(PathRefused::new(Refusal::Protected, path));
            }
        }
    }
    let dot = |rel: String| if rel.is_empty() { ".".to_string() } else { rel };
    Ok(Confined {
        absolute: real,
        relative: dot(real_rel),
        lexical: dot(lexical_rel),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    pub(crate) const CONFORMANCE: &str = include_str!("../../agent/conformance.json");

    /// The SDKs' helper conformance file (`tests/agent_conformance.json`).
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
            let access = if case["write"].as_bool().unwrap_or(false) {
                Access::Write
            } else {
                Access::Read
            };
            let got = confine(root, path, &deny, access);
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
    fn the_protected_list_is_the_contracts_with_its_home_folder_entries() {
        for (path, is_dir) in [
            (".matterwaveignore", false),
            (".matterwave/settings.json", false),
            ("AGENTS.md", false),
            ("docs/agents.md", false),
            ("MATTERWAVE.local.md", false),
            (".bashrc", false),
            (".zprofile", false),
            (".ssh/config", false),
            (".ssh", true),
            ("me/.aws/credentials", false),
            (".config/matterwave/settings.json", false),
            ("home/me/.config/matterwave", true),
        ] {
            assert!(is_protected(path, is_dir), "{path}");
        }
        for (path, is_dir) in [
            ("src/app.py", false),
            (".matterwave", false),
            (".ssh", false),
            ("bashrc", false),
            (".config/other/x", false),
            ("AGENTS.md.bak", false),
        ] {
            assert!(!is_protected(path, is_dir), "{path}");
        }
    }

    #[test]
    fn an_approved_write_reaches_a_protected_path_and_an_unapproved_one_does_not() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join("AGENTS.md"), "Be brief.\n").unwrap();
        let deny = DenyList::load(ws.path());
        let err = confine(ws.path(), "AGENTS.md", &deny, Access::Write).unwrap_err();
        assert_eq!(err.reason, Refusal::Protected);
        let ok = confine(ws.path(), "AGENTS.md", &deny, Access::ApprovedWrite).unwrap();
        assert_eq!(ok.relative, "AGENTS.md");
        assert!(confine(ws.path(), "AGENTS.md", &deny, Access::Read).is_ok());
        // An approval never reaches past the deny list.
        let err = confine(ws.path(), ".env", &deny, Access::ApprovedWrite).unwrap_err();
        assert_eq!(err.reason, Refusal::Denied);
    }

    #[test]
    fn dot_dot_is_refused_in_any_spelling() {
        let ws = tempfile::tempdir().unwrap();
        let deny = DenyList::defaults();
        for path in ["..", "../x", "a/../../x", r"a\..\..\x", "a/..", "./../x"] {
            let err = confine(ws.path(), path, &deny, Access::Read).unwrap_err();
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
        let err = confine(&root, &outside.to_string_lossy(), &deny, Access::Read).unwrap_err();
        assert_eq!(err.reason, Refusal::Outside);
        // A sibling whose name starts with the root's is still outside.
        std::fs::create_dir_all(outer.path().join("ws-other")).unwrap();
        let sibling = outer.path().join("ws-other");
        let err = confine(&root, &sibling.to_string_lossy(), &deny, Access::Read).unwrap_err();
        assert_eq!(err.reason, Refusal::Outside);
        let system = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };
        assert_eq!(
            confine(&root, system, &deny, Access::Read)
                .unwrap_err()
                .reason,
            Refusal::Outside
        );

        let inside = root.join("src").join("a.txt");
        let ok = confine(&root, &inside.to_string_lossy(), &deny, Access::Read).unwrap();
        assert_eq!(ok.relative, "src/a.txt");
        // Rooted without a drive, on Windows: the root's own drive.
        if cfg!(windows) {
            let real = resolve_links(&inside).unwrap();
            let rooted = real.to_string_lossy()[2..].to_string();
            let ok = confine(&root, &rooted, &deny, Access::Read).unwrap();
            assert_eq!(ok.relative, "src/a.txt", "{rooted}");
        }
    }

    #[test]
    fn env_files_are_refused_for_reading_and_writing() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join(".env"), "KEY=1").unwrap();
        let deny = DenyList::load(ws.path());
        for (path, access) in [
            (".env", Access::Read),
            (".env", Access::Write),
            (".env.local", Access::Write),
            ("app/.env", Access::Read),
        ] {
            let err = confine(ws.path(), path, &deny, access).unwrap_err();
            assert_eq!(err.reason, Refusal::Denied, "{path}");
        }
    }

    /// Makes a link at `link` to `target`, or says why it cannot: Windows
    /// needs Developer Mode or the privilege for a symbolic link, so a
    /// directory junction stands in there, which is the link a Windows
    /// user's tooling makes anyway.
    pub(crate) fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
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
        for (path, access) in [
            ("escape/secret.txt", Access::Read),
            ("escape/new.txt", Access::Write),
            ("escape", Access::Read),
        ] {
            let err = confine(&root, path, &deny, access).unwrap_err();
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
        let ok = confine(root, "alias/a.txt", &deny, Access::Read).unwrap();
        assert_eq!(ok.relative, "real/a.txt");
        assert_eq!(ok.lexical, "alias/a.txt");
        // Denied by where it leads, not by its own name.
        let err = confine(root, "gitlink", &deny, Access::Read).unwrap_err();
        assert_eq!(err.reason, Refusal::Denied);
    }

    /// A link with an innocent name that leads to a protected path is
    /// protected for writing too.
    #[test]
    fn a_link_to_a_protected_path_is_protected_by_where_it_leads() {
        let ws = tempfile::tempdir().unwrap();
        let root = ws.path();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::write(root.join(".ssh/config"), "Host x\n").unwrap();
        if let Err(why) = link_dir(&root.join(".ssh"), &root.join("plain")) {
            eprintln!("skipped: cannot make a directory link here ({why})");
            return;
        }
        let deny = DenyList::defaults();
        let err = confine(root, "plain/config", &deny, Access::Write).unwrap_err();
        assert_eq!(err.reason, Refusal::Protected);
        let read = confine(root, "plain/config", &deny, Access::Read).unwrap();
        assert!(read.matched_by(&DenyList::protected()));
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_link_out_of_the_root_is_refused_for_a_write() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outer.path().join("not-yet"), root.join("out.txt")).unwrap();
        let err = confine(&root, "out.txt", &DenyList::defaults(), Access::Write).unwrap_err();
        assert_eq!(err.reason, Refusal::Symlink);
    }

    #[test]
    fn windows_aliases_are_spotted_and_look_alikes_pass() {
        for (path, code) in [
            ("a.txt:s", Refusal::Stream),
            ("a.txt::$DATA", Refusal::Stream),
            ("f:Zone.Identifier", Refusal::Stream),
            ("C:foo", Refusal::Stream),
            ("nul", Refusal::Device),
            ("NUL.txt", Refusal::Device),
            ("Com1", Refusal::Device),
            ("lpt9.log", Refusal::Device),
            ("COM\u{b9}", Refusal::Device),
            ("CONIN$", Refusal::Device),
            ("aux .py", Refusal::Device),
            ("src/con.h", Refusal::Device),
            ("key.pem.", Refusal::Trailing),
            ("key.pem ", Refusal::Trailing),
            ("dir./x.txt", Refusal::Trailing),
            ("...", Refusal::Trailing),
            (r"\\server\share", Refusal::Unc),
            (r"\\?\C:\x", Refusal::Unc),
            (r"\\.\pipe\x", Refusal::Unc),
            ("//server/x", Refusal::Unc),
            (r"\??\C:\x", Refusal::Unc),
            (r"/\server\x", Refusal::Unc),
        ] {
            assert_eq!(windows_alias(path, None), Some(code), "{path}");
        }
        for path in [
            "a.txt",
            ".env",
            "console.log",
            "nullable.rs",
            "com10",
            "lpt0.txt",
            "lpt",
            ".",
            "./src/x",
            "auxiliary.py",
            "conf",
            "clock$",
            ".gitignore",
            r"C:\Users\me\x.txt",
            "C:",
            "/etc/passwd",
            r"\Users\me",
        ] {
            assert_eq!(windows_alias(path, None), None, "{path}");
        }
    }

    /// Attack: alternate data streams, device names, and names Windows
    /// silently shortens -- each a path whose approval would name one thing
    /// while another is touched. Refused before anything is resolved, on
    /// every platform.
    #[test]
    fn streams_devices_and_dropped_dots_are_refused() {
        let ws = tempfile::tempdir().unwrap();
        let root = resolve_links(ws.path()).unwrap();
        std::fs::write(root.join("notes.txt"), "n").unwrap();
        std::fs::write(root.join("key.pem"), "PEM").unwrap();
        let deny = DenyList::load(&root);
        for (path, access, code) in [
            ("notes.txt:hidden", Access::Write, Refusal::Stream),
            ("notes.txt:hidden", Access::Read, Refusal::Stream),
            (
                "download.exe:Zone.Identifier",
                Access::Write,
                Refusal::Stream,
            ),
            ("key.pem::$DATA", Access::Read, Refusal::Stream),
            ("NUL", Access::Write, Refusal::Device),
            ("con.txt", Access::Read, Refusal::Device),
            ("aux.py", Access::ApprovedWrite, Refusal::Device),
            ("sub/COM1", Access::Write, Refusal::Device),
            ("secrets.pem.", Access::Write, Refusal::Trailing),
            ("new.txt ", Access::Write, Refusal::Trailing),
            ("dir./x.txt", Access::Write, Refusal::Trailing),
        ] {
            let err = confine(&root, path, &deny, access).unwrap_err();
            assert_eq!(err.reason, code, "{path}");
        }
        assert!(confine(&root, "notes.txt", &deny, Access::Write).is_ok());
    }

    /// Attack (Windows): the deny list matched in another case, through an
    /// 8.3 short name, or through a verbatim, device or UNC spelling of a
    /// path in the root.
    #[cfg(windows)]
    #[test]
    fn the_deny_list_holds_against_case_short_names_and_other_spellings() {
        let outer = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outer.path().join("ws/.git")).unwrap();
        let root = resolve_links(&outer.path().join("ws")).unwrap();
        std::fs::write(root.join(".env.production"), "K=1").unwrap();
        std::fs::write(root.join("deploy.pem"), "PEM").unwrap();
        std::fs::write(root.join(".git/config"), "c").unwrap();
        std::fs::write(root.join("notes.txt"), "n").unwrap();
        let deny = DenyList::load(&root);
        for path in [
            ".ENV.PRODUCTION",
            "Deploy.PEM",
            ".GIT/config",
            ".Git\\CONFIG",
        ] {
            let err = confine(&root, path, &deny, Access::Read).unwrap_err();
            assert_eq!(err.reason, Refusal::Denied, "{path}");
        }
        // The short names Windows gave the files, when it gives them.
        let short = |name: &str| -> Option<String> {
            let out = std::process::Command::new("cmd")
                .args(["/C", &format!("for %I in ({name}) do @echo %~snxI")])
                .current_dir(&root)
                .output()
                .ok()?;
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!s.is_empty() && s != name).then_some(s)
        };
        for name in [".env.production", ".git"] {
            match short(name) {
                Some(s) => {
                    let err = confine(&root, &s, &deny, Access::Read).unwrap_err();
                    assert_eq!(err.reason, Refusal::Denied, "{name} as {s}");
                }
                None => eprintln!("skipped: no 8.3 name for {name} on this volume"),
            }
        }
        let r = root.display().to_string();
        for path in [
            format!("\\\\?\\{r}\\.env.production"),
            format!("\\\\.\\{r}\\notes.txt"),
            format!("\\\\localhost\\C$\\{}\\notes.txt", &r[3..]),
            format!("//?/{}/notes.txt", r.replace('\\', "/")),
        ] {
            let err = confine(&root, &path, &deny, Access::Read).unwrap_err();
            assert_eq!(err.reason, Refusal::Unc, "{path}");
        }
        // The same path in another case is the same file.
        let upper = format!("{}\\NOTES.TXT", r.to_uppercase());
        assert_eq!(
            confine(&root, &upper, &deny, Access::Read)
                .unwrap()
                .relative,
            "notes.txt"
        );
    }

    #[test]
    fn globs_compile_as_the_sdks_do() {
        let g = |glob: &str| glob_to_regex(glob).unwrap();
        assert_eq!(g("*.py"), "[^/]*\\.py");
        assert_eq!(g("src/**/*.ts"), "src/(?:.*/)?[^/]*\\.ts");
        assert_eq!(g("a?c"), "a[^/]c");
        assert_eq!(g("[!x]y"), "[^x]y");
        assert_eq!(g("[abc"), "\\[abc");
        let re = Regex::new(&format!("^{}$", g("**/cache"))).unwrap();
        assert!(re.is_match("cache"));
        assert!(re.is_match("a/b/cache"));
    }

    /// The contract's class rules: `!` or `^` first negates, a `]` right
    /// after the `[` (or the negation) is literal, `a-z` is a range, every
    /// other character stands for itself, and a backwards range is invalid.
    #[test]
    fn glob_classes_translate_alike_in_every_dialect() {
        let matches = |glob: &str, name: &str| {
            Regex::new(&format!("(?i)^(?:{})$", glob_to_regex(glob).unwrap()))
                .unwrap()
                .is_match(name)
        };
        assert!(matches("[!bm]*.py", "util.py") && !matches("[!bm]*.py", "main.py"));
        assert!(matches("[^bm]*", "x") && !matches("[^bm]*", "B"));
        assert!(matches("[]w]*", "wide.txt") && matches("[]w]*", "]x"));
        assert!(matches("[!]]", "a") && !matches("[!]]", "]"));
        assert!(matches("[!]", "[!]"), "no ] closes it: a literal [!]");
        assert!(matches("[a-c]", "B") && !matches("[a-c]", "d"));
        assert!(matches("[-a]", "-") && matches("[a-]", "-"));
        assert!(matches("[\\]", "\\") && matches("[&~]", "~") && matches("[[]", "["));
        assert!(matches("[^]", "[^]") && !matches("[^]", "^"));
        assert_eq!(glob_to_regex("[z-a].py"), Err(GlobError));
        assert_eq!(glob_to_regex("src/[9-0]*"), Err(GlobError));
    }

    /// A byte-order mark is dropped and a line with a backwards range is
    /// skipped, as git skips it, rather than failing the whole list.
    #[test]
    fn a_deny_file_drops_its_bom_and_skips_an_invalid_line() {
        let deny = DenyList::with_ignore_file("\u{feff}private/\n[z-a]\nkeys/\n");
        assert!(deny.matches("private/a.md", false));
        assert!(deny.matches("keys/k", false));
        assert!(!deny.matches("z", false));
        assert!(deny.matches(".env", false), "the defaults still hold");
    }

    #[test]
    fn only_the_names_below_the_root_are_checked_for_aliases() {
        let root = Some("/x/con/repo");
        assert_eq!(windows_alias("/x/con/repo/src/main.py", root), None);
        assert_eq!(windows_alias("/X/CON/Repo\\a.txt", root), None);
        assert_eq!(
            windows_alias("/x/con/repo/nul.txt", root),
            Some(Refusal::Device)
        );
        assert_eq!(
            windows_alias("/x/con/other/a.txt", root),
            Some(Refusal::Device)
        );
        assert_eq!(windows_alias("src/con.h", root), Some(Refusal::Device));
        assert_eq!(
            windows_alias("//x/con/repo/a.txt", root),
            Some(Refusal::Unc)
        );
        assert_eq!(windows_alias("/x/con", root), Some(Refusal::Device));
    }

    /// A link to itself, and a pair that point at each other, are `loop`,
    /// whether the path ends at the link or goes through it.
    #[test]
    fn a_loop_of_links_is_refused_as_loop() {
        let ws = tempfile::tempdir().unwrap();
        let root = resolve_links(ws.path()).unwrap();
        if let Err(why) = link_file(Path::new("self.lnk"), &root.join("self.lnk")) {
            eprintln!("skipped: cannot make a file link here ({why})");
            return;
        }
        link_file(Path::new("b.lnk"), &root.join("a.lnk")).unwrap();
        link_file(Path::new("a.lnk"), &root.join("b.lnk")).unwrap();
        assert_eq!(resolve_links(&root.join("self.lnk")), Err(LinkError::Loop));
        let deny = DenyList::defaults();
        for (path, access) in [
            ("self.lnk", Access::Read),
            ("self.lnk/x.txt", Access::Write),
            ("a.lnk", Access::Read),
            ("b.lnk/deeper/x", Access::ApprovedWrite),
        ] {
            let err = confine(&root, path, &deny, access).unwrap_err();
            assert_eq!(err.reason, Refusal::Loop, "{path}");
        }
        // A workspace root that is itself a loop is refused the same way.
        let err = confine(&root.join("self.lnk"), "x", &deny, Access::Read).unwrap_err();
        assert_eq!(err.reason, Refusal::Loop);
    }

    /// A link at `link` to `target` (relative to the link's folder when
    /// relative), which need not exist, or why it cannot be made. Windows
    /// needs Developer Mode or the privilege for a symbolic link, so a
    /// directory junction to the same place stands in there: for a link
    /// that loops or dangles, which is what the tests make, either reads
    /// the same to `resolve_links` and the walk.
    pub(crate) fn link_file(target: &Path, link: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(target, link).is_ok() {
                return Ok(());
            }
            let absolute = link.parent().ok_or("a link needs a folder")?.join(target);
            link_dir(&absolute, link)
        }
    }
}
