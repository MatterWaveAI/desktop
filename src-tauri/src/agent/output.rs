//! What the read tools and run_shell return to the model, as the contract's
//! `outputs` spell it: the SDKs' `format_read_file`, `format_list_dir`,
//! `format_glob`, `format_grep` and `format_shell`, with the text helpers
//! they share. Pure: the tools in tools.rs and shell.rs read the files and
//! run the command, and these turn the result into the tool's text, so
//! the desktop numbers lines, marks a cut and words an error the way every
//! other client does (`conformance.rs` holds them to the contract's cases).

use super::confine::glob_to_regex;
use super::contract::{
    fill, outputs, ToolFailure, BINARY_SNIFF_BYTES, GREP_MAX_FILE_BYTES, LIST_MAX_ENTRIES,
    READ_MAX_BYTES, READ_MAX_FILE_BYTES, READ_MAX_LINES, SEARCH_MAX_RESULTS,
    SHELL_OUTPUT_MAX_BYTES,
};
use regex::Regex;

/// The contract's limits, which the conformance cases override one by one;
/// the host runs with `Limits::default()`, the contract's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    pub read_max_lines: usize,
    pub read_max_bytes: usize,
    pub list_max_entries: usize,
    pub search_max_results: usize,
    pub shell_output_max_bytes: usize,
    pub read_max_file_bytes: u64,
    pub grep_max_file_bytes: u64,
    pub binary_sniff_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            read_max_lines: READ_MAX_LINES,
            read_max_bytes: READ_MAX_BYTES,
            list_max_entries: LIST_MAX_ENTRIES,
            search_max_results: SEARCH_MAX_RESULTS,
            shell_output_max_bytes: SHELL_OUTPUT_MAX_BYTES,
            read_max_file_bytes: READ_MAX_FILE_BYTES,
            grep_max_file_bytes: GREP_MAX_FILE_BYTES,
            binary_sniff_bytes: BINARY_SNIFF_BYTES,
        }
    }
}

/// A tool that cannot answer: the contract's code and its sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolError {
    #[cfg_attr(not(test), allow(dead_code))]
    pub reason: ToolFailure,
    pub message: String,
}

impl ToolError {
    pub fn new(reason: ToolFailure, values: &[(&str, &str)]) -> Self {
        ToolError {
            reason,
            message: reason.message(values),
        }
    }
}

/// Whether a file whose bytes start with `data` is binary: a NUL byte in
/// its first `binary_sniff_bytes`.
pub(crate) fn is_binary(data: &[u8], limits: &Limits) -> bool {
    data[..data.len().min(limits.binary_sniff_bytes)].contains(&0)
}

/// A text file's bytes as text: UTF-8, an invalid byte becoming U+FFFD, a
/// byte-order mark kept.
pub(crate) fn decode_text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

/// The lines of `text` as the read tools count them: split at LF, each
/// line's trailing CR dropped, and a final LF starting no further line.
pub(crate) fn text_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = text.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|p| p.strip_suffix('\r').unwrap_or(p))
        .collect()
}

/// The longest start of `text` whose UTF-8 fits in `max_bytes`.
pub(crate) fn utf8_head(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    &text[..cut]
}

/// The argument errors read_file checks before it looks at the file: a
/// line number below 1, and an end before the start.
pub(crate) fn check_lines(start_line: Option<i64>, end_line: Option<i64>) -> Result<(), ToolError> {
    for (name, value) in [("start_line", start_line), ("end_line", end_line)] {
        if let Some(v) = value.filter(|v| *v < 1) {
            return Err(ToolError::new(
                ToolFailure::BadLine,
                &[("name", name), ("value", &v.to_string())],
            ));
        }
    }
    if let (Some(start), Some(end)) = (start_line, end_line) {
        if end < start {
            return Err(ToolError::new(
                ToolFailure::EndBeforeStart,
                &[
                    ("start_line", &start.to_string()),
                    ("end_line", &end.to_string()),
                ],
            ));
        }
    }
    Ok(())
}

/// read_file's result for a file whose text is `text`: the lines from
/// `start_line` to `end_line`, numbered, joined with LF (none after the
/// last), cut at the read limits with the contract's marker.
pub(crate) fn format_read_file(
    text: &str,
    path: &str,
    start_line: Option<i64>,
    end_line: Option<i64>,
    limits: &Limits,
) -> Result<String, ToolError> {
    check_lines(start_line, end_line)?;
    let lines = text_lines(text);
    let total = lines.len();
    if total == 0 {
        return Ok(fill(outputs::READ_EMPTY, &[("path", path)]));
    }
    // Both are at least 1 once checked.
    let first = start_line.unwrap_or(1) as usize;
    if first > total {
        return Err(ToolError::new(
            ToolFailure::PastEnd,
            &[
                ("start_line", &first.to_string()),
                ("path", path),
                ("total", &total.to_string()),
            ],
        ));
    }
    let last_wanted = end_line.map_or(total, |e| (e as usize).min(total));
    let mut out: Vec<String> = Vec::new();
    let mut size = 0usize;
    for n in first..=last_wanted {
        let line = fill(
            outputs::READ_LINE,
            &[("n", &n.to_string()), ("text", lines[n - 1])],
        );
        let bytes = line.len();
        if out.is_empty() && bytes > limits.read_max_bytes {
            let marker = fill(
                outputs::READ_LINE_CUT,
                &[
                    ("line", &n.to_string()),
                    ("max_bytes", &limits.read_max_bytes.to_string()),
                    ("next", &(n + 1).to_string()),
                ],
            );
            return Ok(format!(
                "{}\n{marker}",
                utf8_head(&line, limits.read_max_bytes)
            ));
        }
        if !out.is_empty()
            && (out.len() >= limits.read_max_lines || size + bytes + 1 > limits.read_max_bytes)
        {
            break;
        }
        out.push(line);
        size += bytes + 1;
    }
    let last = first + out.len() - 1;
    let mut body = out.join("\n");
    if last < last_wanted {
        body.push('\n');
        body.push_str(&fill(
            outputs::READ_CUT,
            &[
                ("first", &first.to_string()),
                ("last", &last.to_string()),
                ("total", &total.to_string()),
                ("next", &(last + 1).to_string()),
            ],
        ));
    }
    Ok(body)
}

/// list_dir's result for the `(name, is_dir)` entries left once denied and
/// ignored ones are out: directories first, then files, each in code-point
/// order, cut at `list_max_entries`.
pub(crate) fn format_list_dir(path: &str, entries: &[(String, bool)], limits: &Limits) -> String {
    let mut dirs: Vec<&str> = entries
        .iter()
        .filter(|(_, d)| *d)
        .map(|(n, _)| n.as_str())
        .collect();
    let mut files: Vec<&str> = entries
        .iter()
        .filter(|(_, d)| !*d)
        .map(|(n, _)| n.as_str())
        .collect();
    // `str`'s order is its UTF-8 bytes', which is code-point order.
    dirs.sort_unstable();
    files.sort_unstable();
    let mut lines: Vec<String> = dirs
        .into_iter()
        .map(|d| format!("{d}/"))
        .chain(files.into_iter().map(str::to_string))
        .collect();
    if lines.is_empty() {
        return fill(outputs::LIST_EMPTY, &[("path", path)]);
    }
    let cap = limits.list_max_entries;
    if lines.len() > cap {
        let more = lines.len() - cap;
        lines.truncate(cap);
        lines.push(fill(outputs::LIST_CUT, &[("more", &more.to_string())]));
    }
    lines.join("\n")
}

/// glob's result: one path per line, or the no-match sentence; `truncated`
/// adds the marker for a search that stopped at the limit.
pub(crate) fn format_glob(
    pattern: &str,
    paths: &[String],
    truncated: bool,
    limits: &Limits,
) -> String {
    if paths.is_empty() {
        return fill(outputs::GLOB_NONE, &[("pattern", pattern)]);
    }
    let mut lines = paths.to_vec();
    if truncated {
        lines.push(fill(
            outputs::GLOB_CUT,
            &[("limit", &limits.search_max_results.to_string())],
        ));
    }
    lines.join("\n")
}

/// A matching line as grep shows it: trailing whitespace gone, cut to
/// `line_max_chars` code points with an ellipsis.
pub(crate) fn grep_line(text: &str) -> String {
    let trimmed = text.trim_end_matches([' ', '\t', '\r', '\x0c', '\x0b']);
    match trimmed.char_indices().nth(outputs::GREP_LINE_MAX_CHARS) {
        Some((cut, _)) => format!("{}{}", &trimmed[..cut], outputs::GREP_ELLIPSIS),
        None => trimmed.to_string(),
    }
}

/// grep's result for `(path, line number, line text)` matches: one line
/// each, or the no-match sentence; `truncated` adds the marker.
pub(crate) fn format_grep(
    pattern: &str,
    matches: &[(String, usize, String)],
    truncated: bool,
    limits: &Limits,
) -> String {
    let mut lines: Vec<String> = matches
        .iter()
        .map(|(path, n, text)| {
            fill(
                outputs::GREP_MATCH,
                &[
                    ("path", path),
                    ("line", &n.to_string()),
                    ("text", &grep_line(text)),
                ],
            )
        })
        .collect();
    if lines.is_empty() {
        return fill(outputs::GREP_NONE, &[("pattern", pattern)]);
    }
    if truncated {
        lines.push(fill(
            outputs::GREP_CUT,
            &[("limit", &limits.search_max_results.to_string())],
        ));
    }
    lines.join("\n")
}

/// How a command ended, as run_shell's status line says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellEnd {
    /// It exited on its own with this code (none when a signal ended it).
    Exited(Option<i32>),
    TimedOut(u64),
    Stopped,
}

/// run_shell's status line. A timeout outranks a stop by the user, which
/// outranks the exit code; the caller passes the one that applies.
pub(crate) fn shell_status(end: ShellEnd) -> String {
    match end {
        ShellEnd::TimedOut(seconds) => fill(
            outputs::SHELL_TIMEOUT,
            &[("timeout_s", &seconds.to_string())],
        ),
        ShellEnd::Stopped => outputs::SHELL_STOPPED.to_string(),
        ShellEnd::Exited(None) => outputs::SHELL_SIGNAL.to_string(),
        ShellEnd::Exited(Some(code)) => fill(outputs::SHELL_EXIT, &[("code", &code.to_string())]),
    }
}

/// The length of the UTF-8 sequence `lead` starts (0 for a byte that
/// cannot start one: a continuation byte or one never valid in UTF-8).
fn sequence_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 0,
    }
}

/// Where the character that a cut at `at` would split starts, when one
/// does: a lead byte at most three bytes back whose sequence runs past
/// `at`. Bytes that are not UTF-8 are characters of their own (each
/// decodes to U+FFFD), so a cut next to one splits nothing.
fn split_at(bytes: &[u8], at: usize) -> Option<usize> {
    let mut start = at;
    while start > 0 && at - start < 3 && bytes.get(start).is_some_and(|b| b & 0xC0 == 0x80) {
        start -= 1;
    }
    (start < at && start + sequence_len(bytes[start]) > at).then_some(start)
}

/// The longest start of `bytes` within `max_bytes` that ends on a
/// character boundary: `utf8_head` on the bytes as the command wrote them.
fn byte_head(bytes: &[u8], max_bytes: usize) -> &[u8] {
    if bytes.len() <= max_bytes {
        return bytes;
    }
    &bytes[..split_at(bytes, max_bytes).unwrap_or(max_bytes)]
}

/// The longest end of `bytes` within `max_bytes` that starts on a
/// character boundary (the SDKs' `utf8_tail`), on the bytes as the
/// command wrote them.
fn byte_tail(bytes: &[u8], max_bytes: usize) -> &[u8] {
    if bytes.len() <= max_bytes {
        return bytes;
    }
    let at = bytes.len() - max_bytes;
    let start = split_at(bytes, at).map_or(at, |s| (s + sequence_len(bytes[s])).min(bytes.len()));
    &bytes[start..]
}

/// run_shell's result for output the host kept in two parts: `head`, the
/// first bytes the command wrote, and `tail`, the last, of `total` bytes in
/// all (when nothing was dropped, `head` is the whole output and `tail` is
/// empty). Output over `shell_output_max_bytes` keeps its first half and
/// its last half, each cut back to a character boundary, with the middle
/// marker between them counting the bytes left out. The cut and the count
/// are made on the bytes as written, so an invalid byte, which decodes to
/// the three bytes of U+FFFD, counts as the one byte it was; the kept
/// parts are decoded after.
pub(crate) fn format_shell_parts(
    end: ShellEnd,
    head: &[u8],
    tail: &[u8],
    total: usize,
    limits: &Limits,
) -> String {
    let status = shell_status(end);
    if total == 0 {
        return format!("{status}\n{}", outputs::SHELL_NO_OUTPUT);
    }
    let cap = limits.shell_output_max_bytes;
    let whole = tail.is_empty() && head.len() == total;
    if whole && total <= cap {
        return format!("{status}\n{}", String::from_utf8_lossy(head));
    }
    let half = cap / 2;
    let kept_head = byte_head(head, half);
    let kept_tail = byte_tail(if whole { head } else { tail }, cap - half);
    let omitted = total.saturating_sub(kept_head.len() + kept_tail.len());
    let marker = fill(outputs::SHELL_CUT, &[("omitted", &omitted.to_string())]);
    format!(
        "{status}\n{}\n{marker}\n{}",
        String::from_utf8_lossy(kept_head),
        String::from_utf8_lossy(kept_tail)
    )
}

/// run_shell's result for the whole of a command's output.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn format_shell(output: &str, end: ShellEnd, limits: &Limits) -> String {
    format_shell_parts(end, output.as_bytes(), b"", output.len(), limits)
}

/// glob's pattern as the search tools apply it (`globMatches`).
pub(crate) struct GlobMatcher {
    /// None for a pattern too large to compile even as a literal, which
    /// then matches nothing.
    regex: Option<Regex>,
    whole_path: bool,
}

impl GlobMatcher {
    /// A leading `./` is dropped and a leading `/` anchors the pattern at
    /// the search's path; a pattern with a `/` matches the path from there,
    /// one without matches a file's name at any depth. Case is ignored.
    pub fn new(pattern: &str) -> Self {
        let text = pattern.strip_prefix("./").unwrap_or(pattern);
        let anchored = text.starts_with('/');
        let text = text.trim_start_matches('/');
        let source = format!("(?i)^(?:{})$", glob_to_regex(text));
        // A class `regex` cannot compile is matched as the literal text.
        let regex = Regex::new(&source)
            .or_else(|_| Regex::new(&format!("(?i)^{}$", regex::escape(text))))
            .ok();
        GlobMatcher {
            regex,
            whole_path: anchored || text.contains('/'),
        }
    }

    /// Whether the file at `relative` (to the search's path, `/`-separated)
    /// matches.
    pub fn matches(&self, relative: &str) -> bool {
        let subject = if self.whole_path {
            relative
        } else {
            relative.rsplit('/').next().unwrap_or(relative)
        };
        self.regex.as_ref().is_some_and(|r| r.is_match(subject))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits::default()
    }

    #[test]
    fn lines_split_at_lf_drop_a_cr_and_a_final_lf() {
        assert_eq!(text_lines("a\r\nb\n"), vec!["a", "b"]);
        assert_eq!(text_lines("a\n\nb"), vec!["a", "", "b"]);
        assert!(text_lines("").is_empty());
        assert_eq!(text_lines("\n"), vec![""]);
    }

    #[test]
    fn heads_and_tails_end_on_character_boundaries() {
        assert_eq!(utf8_head("ééé", 3), "é");
        assert_eq!(byte_tail("ééé".as_bytes(), 3), "é".as_bytes());
        assert_eq!(utf8_head("abc", 9), "abc");
        assert_eq!(byte_tail(b"abc", 0), b"");
    }

    #[test]
    fn a_grep_line_is_trimmed_and_cut_at_400_code_points() {
        assert_eq!(grep_line("x = 1 \t\r"), "x = 1");
        let long = "é".repeat(401);
        let shown = grep_line(&long);
        assert_eq!(shown.chars().count(), 401);
        assert!(shown.ends_with('\u{2026}'));
        assert_eq!(grep_line(&"é".repeat(400)), "é".repeat(400));
    }

    #[test]
    fn read_file_has_no_lf_after_its_last_line() {
        let out = format_read_file("one\ntwo\n", "a.txt", None, None, &limits()).unwrap();
        assert_eq!(out, "1\tone\n2\ttwo");
    }

    #[test]
    fn the_shell_middle_cut_counts_what_it_leaves_out() {
        let small = Limits {
            shell_output_max_bytes: 10,
            ..Limits::default()
        };
        assert_eq!(
            format_shell("0123456789ABCDEF", ShellEnd::Exited(Some(0)), &small),
            "Exit code 0\n01234\n[... 6 bytes of output cut from the middle ...]\nBCDEF"
        );
        // Kept in parts, as the host keeps a long command's output.
        assert_eq!(
            format_shell_parts(
                ShellEnd::Exited(Some(0)),
                b"0123456789",
                b"6789ABCDEF",
                16,
                &small
            ),
            "Exit code 0\n01234\n[... 6 bytes of output cut from the middle ...]\nBCDEF"
        );
    }

    /// Bytes that are not UTF-8 count as the bytes they are, not as the
    /// U+FFFD each becomes; a character the cut lands in is left out whole.
    #[test]
    fn the_shell_cut_counts_invalid_utf8_as_written() {
        let small = Limits {
            shell_output_max_bytes: 10,
            ..Limits::default()
        };
        // Head: a, two invalid bytes, b, then a euro sign the cut at 5 splits.
        let head = b"a\xFF\xFEb\xE2\x82\xACcde";
        // Tail: a euro sign the cut at 5 splits, an invalid byte, z!.
        let tail = b"vwxy\xE2\x82\xAC\xFFz!";
        assert_eq!(
            format_shell_parts(ShellEnd::Exited(Some(0)), head, tail, 40, &small),
            "Exit code 0\na\u{FFFD}\u{FFFD}b\n[... 33 bytes of output cut from the middle ...]\n\u{FFFD}z!"
        );
        // All invalid: five bytes kept each side, 30 - 10 left out.
        assert_eq!(
            format_shell_parts(
                ShellEnd::Exited(Some(0)),
                &[0xFF; 10],
                &[0xFE; 10],
                30,
                &small
            ),
            format!(
                "Exit code 0\n{0}\n[... 20 bytes of output cut from the middle ...]\n{0}",
                "\u{FFFD}".repeat(5)
            )
        );
        // Under the cap as written, whole, though it decodes to more.
        assert_eq!(
            format_shell_parts(ShellEnd::Exited(Some(0)), &[0xFF; 8], b"", 8, &small),
            format!("Exit code 0\n{}", "\u{FFFD}".repeat(8))
        );
        // On valid text the byte cut is the character cut.
        assert_eq!(byte_head("ééé".as_bytes(), 3), "é".as_bytes());
        assert_eq!(byte_tail("ééé".as_bytes(), 3), "é".as_bytes());
        assert_eq!(byte_tail("a€".as_bytes(), 2), b"");
    }

    #[test]
    fn a_glob_without_a_slash_matches_names_at_any_depth_ignoring_case() {
        let g = GlobMatcher::new("*.py");
        assert!(g.matches("src/lib/deep.py") && g.matches("Upper.PY"));
        let anchored = GlobMatcher::new("/README.MD");
        assert!(anchored.matches("README.md") && !anchored.matches("docs/README.md"));
        let rooted = GlobMatcher::new("src/**/*.ts");
        assert!(rooted.matches("src/a.ts") && rooted.matches("src/x/y/b.ts"));
        assert!(!rooted.matches("lib/src/a.ts"));
    }
}
