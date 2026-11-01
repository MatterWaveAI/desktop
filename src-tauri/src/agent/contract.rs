//! The agent tool contract as the native tool host enforces it: the tools,
//! the modes that gate them, the deny and protected lists, the limits, the
//! text the read tools and run_shell return and the sentences a refusal
//! returns to the model.
//!
//! The one source is the Python SDK's `contract.json`; `agent/contract.json`
//! beside this crate is a byte-for-byte copy of it. The values below are
//! restated rather than parsed at runtime on purpose: the host's behaviour
//! is in code that review can read, and the tests at the bottom fail the
//! moment the copy and the code disagree -- a new deny pattern, a renamed
//! argument, a changed limit or output sentence. The copy's `conformance`
//! cases run against the host itself (`conformance.rs`). With
//! `MATTERWAVE_AGENT_CONTRACT` naming the Python SDK's file, or a
//! `python-sdk` checkout beside this one, the copy is also checked against
//! the source.

/// The contract version this host implements.
pub(crate) const CONTRACT_VERSION: &str = "1.1.0";

/// The contract's own copy, for the parity tests and nothing else.
#[cfg(test)]
pub(crate) const CONTRACT_JSON: &str = include_str!("../../agent/contract.json");

/// What a tool does to the workspace: `read` tools are the ones `plan` offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolKind {
    Read,
    Write,
    Shell,
}

/// One tool: its name, its kind, and the arguments it takes. Every tool's
/// schema has `additionalProperties: false`, which the host enforces by
/// refusing an argument it does not name (tools.rs's argument structs).
/// The kind and argument lists restate the contract for the parity tests;
/// the host itself dispatches on the name.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub kind: ToolKind,
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
}

pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "read_file",
        kind: ToolKind::Read,
        required: &["path"],
        optional: &["start_line", "end_line"],
    },
    ToolSpec {
        name: "list_dir",
        kind: ToolKind::Read,
        required: &[],
        optional: &["path"],
    },
    ToolSpec {
        name: "glob",
        kind: ToolKind::Read,
        required: &["pattern"],
        optional: &["path"],
    },
    ToolSpec {
        name: "grep",
        kind: ToolKind::Read,
        required: &["pattern"],
        optional: &["path", "glob", "ignore_case"],
    },
    ToolSpec {
        name: "edit",
        kind: ToolKind::Write,
        required: &["path", "old_string", "new_string"],
        optional: &[],
    },
    ToolSpec {
        name: "write_file",
        kind: ToolKind::Write,
        required: &["path", "content"],
        optional: &[],
    },
    ToolSpec {
        name: "run_shell",
        kind: ToolKind::Shell,
        required: &["command"],
        optional: &["timeout_s"],
    },
];

pub(crate) fn tool(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.name == name)
}

/// An approval mode as the host sees it: which tools it lets through
/// unasked (`allow`), which only after the person's yes (`ask`), and so
/// which it refuses outright -- `plan` never writes and never runs a
/// command, whatever the webview asks.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ModeSpec {
    pub name: &'static str,
    pub allow: &'static [&'static str],
    pub ask: &'static [&'static str],
    pub persistable: bool,
    pub requires_flag: bool,
}

const READS: &[&str] = &["read_file", "list_dir", "glob", "grep"];

pub(crate) const MODES: &[ModeSpec] = &[
    ModeSpec {
        name: "plan",
        allow: READS,
        ask: &[],
        persistable: true,
        requires_flag: false,
    },
    ModeSpec {
        name: "ask",
        allow: READS,
        ask: &["edit", "write_file", "run_shell"],
        persistable: true,
        requires_flag: false,
    },
    ModeSpec {
        name: "auto-edit",
        allow: &[
            "read_file",
            "list_dir",
            "glob",
            "grep",
            "edit",
            "write_file",
        ],
        ask: &["run_shell"],
        persistable: true,
        requires_flag: false,
    },
    ModeSpec {
        name: "yolo",
        allow: &[
            "read_file",
            "list_dir",
            "glob",
            "grep",
            "edit",
            "write_file",
            "run_shell",
        ],
        ask: &[],
        persistable: false,
        requires_flag: true,
    },
];

/// The SPA starts in this mode; restated for the parity tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const DEFAULT_MODE: &str = "ask";

pub(crate) fn mode(name: &str) -> Option<&'static ModeSpec> {
    MODES.iter().find(|m| m.name == name)
}

impl ModeSpec {
    /// Whether `tool` may run in this mode at all (with or without asking).
    pub fn offers(&self, tool: &str) -> bool {
        self.allow.contains(&tool) || self.ask.contains(&tool)
    }
}

/// The default deny list: applies to reads as well as writes, so secrets
/// are not uploaded to the model.
pub(crate) const DEFAULT_DENY: &[&str] = &[".env*", "*.pem", "id_*", ".git/"];
/// The workspace's own extra deny patterns.
pub(crate) const DENY_FILE: &str = ".matterwaveignore";
/// What search skips besides the deny list, read in every directory from
/// the root down, the .gitignore before the .matterwaveignore.
pub(crate) const SEARCH_IGNORE_FILES: &[&str] = &[".gitignore", ".matterwaveignore"];
/// Readable; a write to one asks the person in every mode that writes,
/// `yolo` included: the deny file, the agent's settings, the context
/// files, and the shell startup files and credential folders that matter
/// when a root holds them. Matched as the deny list is (`DenyList`).
pub(crate) const PROTECTED: &[&str] = &[
    ".matterwaveignore",
    ".matterwave/",
    "MATTERWAVE.md",
    "MATTERWAVE.local.md",
    "AGENTS.md",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".ssh/",
    ".aws/",
    "**/.config/matterwave",
];
/// The agent's settings folder in a workspace; restated for the parity
/// tests (the host protects it through `PROTECTED`).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const SETTINGS_DIR: &str = ".matterwave/";
/// The instruction files a trusted root's runs are given, in the
/// contract's order (where two disagree, the later one wins).
pub(crate) const CONTEXT_FILES: &[&str] = &["MATTERWAVE.md", "MATTERWAVE.local.md", "AGENTS.md"];

/// Why a path was refused, by the contract's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Empty,
    Parent,
    Outside,
    Symlink,
    Denied,
    Protected,
    /// A `:` in a name: an alternate data stream, or a drive-relative path.
    Stream,
    /// A name ending in a dot or a space, which Windows drops.
    Trailing,
    /// A reserved device name (`NUL`, `con.txt`, `COM1`).
    Device,
    /// A `\\?\`, `\\.\`, `\??\` or network path.
    Unc,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Empty => "empty",
            Refusal::Parent => "parent",
            Refusal::Outside => "outside",
            Refusal::Symlink => "symlink",
            Refusal::Denied => "denied",
            Refusal::Protected => "protected",
            Refusal::Stream => "stream",
            Refusal::Trailing => "trailing",
            Refusal::Device => "device",
            Refusal::Unc => "unc",
        }
    }

    /// The contract's sentence, before `{path}` is filled in.
    pub fn template(self) -> &'static str {
        match self {
            Refusal::Empty => "Refused: the path is empty.",
            Refusal::Parent => {
                "Refused: {path} goes through '..'. Paths must stay inside the workspace."
            }
            Refusal::Outside => "Refused: {path} is outside the workspace root.",
            Refusal::Symlink => "Refused: {path} is a link that leads outside the workspace root.",
            Refusal::Denied => "Refused: {path} is protected (a secret, a key, .git or an entry in .matterwaveignore) and is not sent to the model.",
            Refusal::Protected => "Refused: {path} can be read but not changed by the agent.",
            Refusal::Stream => "Refused: {path} has a ':' in a name, which Windows reads as an alternate data stream or another drive, not the file it seems to name.",
            Refusal::Trailing => "Refused: {path} has a name that ends in a dot or a space, which Windows drops, so it would reach a different file.",
            Refusal::Device => "Refused: {path} uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9), which Windows treats as a device, not a file.",
            Refusal::Unc => "Refused: {path} is a \\\\?\\, \\\\.\\ or network path. Paths must stay inside the workspace.",
        }
    }

    pub const ALL: [Refusal; 10] = [
        Refusal::Empty,
        Refusal::Parent,
        Refusal::Outside,
        Refusal::Symlink,
        Refusal::Denied,
        Refusal::Protected,
        Refusal::Stream,
        Refusal::Trailing,
        Refusal::Device,
        Refusal::Unc,
    ];
}

/// A refusal from the approval step rather than confinement, by the
/// contract's code (`approval.refusals`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApprovalRefusal {
    /// The run's mode does not offer the tool.
    Mode,
    /// The contract names no such tool.
    UnknownTool,
    /// The person said no; sent as an ordinary result, not an error.
    Rejected,
    /// No one can be asked. The desktop always can, so the host never
    /// sends it; restated for the parity test.
    #[cfg_attr(not(test), allow(dead_code))]
    Headless,
    /// A protected write without the person's yes. The desktop asks
    /// instead; restated for the parity test.
    #[cfg_attr(not(test), allow(dead_code))]
    NeedsApproval,
}

impl ApprovalRefusal {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn code(self) -> &'static str {
        match self {
            ApprovalRefusal::Mode => "mode",
            ApprovalRefusal::UnknownTool => "unknown_tool",
            ApprovalRefusal::Rejected => "rejected",
            ApprovalRefusal::Headless => "headless",
            ApprovalRefusal::NeedsApproval => "needs_approval",
        }
    }

    pub fn template(self) -> &'static str {
        match self {
            ApprovalRefusal::Mode => "Refused: {tool} is not available in {mode} mode.",
            ApprovalRefusal::UnknownTool => "Refused: there is no tool named {tool}. Use one of the tools you were given.",
            ApprovalRefusal::Rejected => "The user rejected this {tool} call, so nothing was done. Do not send it again: change course, or ask the user what they want.",
            ApprovalRefusal::Headless => "Refused: {tool} needs the user's approval in {mode} mode, and this run is non-interactive, so nothing was done.",
            ApprovalRefusal::NeedsApproval => "Refused: {path} is protected (the agent's settings or instructions, .matterwaveignore, a shell startup file or a credentials folder), so a change to it needs the user's approval, which it did not get.",
        }
    }

    /// The sentence with `tool`, `mode` and `path` filled in.
    pub fn message(self, tool: &str, mode: &str, path: &str) -> String {
        fill(
            self.template(),
            &[("tool", tool), ("mode", mode), ("path", path)],
        )
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ApprovalRefusal; 5] = [
        ApprovalRefusal::Mode,
        ApprovalRefusal::UnknownTool,
        ApprovalRefusal::Rejected,
        ApprovalRefusal::Headless,
        ApprovalRefusal::NeedsApproval,
    ];
}

/// Why an edit could not be applied, by the contract's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EditFailure {
    Missing,
    Empty,
    Unchanged,
    NotFound,
    NotUnique,
}

#[cfg_attr(not(test), allow(dead_code))]
impl EditFailure {
    pub fn code(self) -> &'static str {
        match self {
            EditFailure::Missing => "missing",
            EditFailure::Empty => "empty",
            EditFailure::Unchanged => "unchanged",
            EditFailure::NotFound => "not_found",
            EditFailure::NotUnique => "not_unique",
        }
    }

    pub fn template(self) -> &'static str {
        match self {
            EditFailure::Missing => "{path} does not exist. Use write_file to create it.",
            EditFailure::Empty => {
                "old_string is empty. Use write_file to create a file or replace all of it."
            }
            EditFailure::Unchanged => {
                "old_string and new_string are the same, so there is nothing to change."
            }
            EditFailure::NotFound => "old_string was not found in {path}. Read the file again and copy the text exactly, whitespace included.",
            EditFailure::NotUnique => "old_string occurs {count} times in {path}. Add neighbouring lines so it matches exactly once.",
        }
    }

    pub const ALL: [EditFailure; 5] = [
        EditFailure::Missing,
        EditFailure::Empty,
        EditFailure::Unchanged,
        EditFailure::NotFound,
        EditFailure::NotUnique,
    ];
}

/// When `old_string` is not found and the file uses CRLF, retry with CRLF.
pub(crate) const EDIT_CRLF_FALLBACK: bool = true;

pub(crate) const READ_MAX_LINES: usize = 2000;
pub(crate) const READ_MAX_BYTES: usize = 262_144;
pub(crate) const LIST_MAX_ENTRIES: usize = 1000;
pub(crate) const SEARCH_MAX_RESULTS: usize = 500;
pub(crate) const SHELL_TIMEOUT_S_DEFAULT: u64 = 120;
pub(crate) const SHELL_TIMEOUT_S_MAX: u64 = 600;
pub(crate) const SHELL_OUTPUT_MAX_BYTES: usize = 65_536;
/// read_file refuses a file larger than this; it is also the host's cap
/// on what an edit reads and a write_file writes.
pub(crate) const READ_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// grep skips a file larger than this.
pub(crate) const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// A NUL byte among a file's first this many bytes makes it binary.
pub(crate) const BINARY_SNIFF_BYTES: usize = 8000;

/// What the read tools and run_shell return (`outputs`): the templates,
/// filled with `fill`.
pub(crate) mod outputs {
    pub const READ_LINE: &str = "{n}\t{text}";
    pub const READ_EMPTY: &str = "({path} is empty.)";
    pub const READ_CUT: &str = "[Cut off at the read limit: showing lines {first}-{last} of {total}. Pass start_line={next} to read on.]";
    pub const READ_LINE_CUT: &str = "[Cut off at the read limit: line {line} is longer than {max_bytes} bytes and only its start is shown. Pass start_line={next} to read on.]";
    pub const LIST_EMPTY: &str =
        "({path} has nothing to list: it is empty or holds only ignored entries.)";
    pub const LIST_CUT: &str = "[{more} more entries not shown.]";
    pub const GLOB_NONE: &str = "No files match {pattern}.";
    pub const GLOB_CUT: &str =
        "[Stopped at {limit} results: narrow the pattern or the path to see the rest.]";
    pub const GREP_MATCH: &str = "{path}:{line}: {text}";
    pub const GREP_LINE_MAX_CHARS: usize = 400;
    pub const GREP_ELLIPSIS: &str = "\u{2026}";
    pub const GREP_NONE: &str = "No matches for {pattern}.";
    pub const GREP_CUT: &str =
        "[Stopped at {limit} matches: narrow the pattern, the path or the glob to see the rest.]";
    pub const SHELL_EXIT: &str = "Exit code {code}";
    pub const SHELL_SIGNAL: &str = "Exit code none: the process was ended by a signal.";
    pub const SHELL_TIMEOUT: &str = "Stopped after {timeout_s} s: the command ran past its timeout, and it and its child processes were ended.";
    pub const SHELL_STOPPED: &str =
        "Stopped by the user: the command and its child processes were ended.";
    pub const SHELL_NO_OUTPUT: &str = "(no output)";
    pub const SHELL_CUT: &str = "[... {omitted} bytes of output cut from the middle ...]";
}

/// Why a read tool or run_shell could not answer (`outputs.errors`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolFailure {
    NotFound,
    IsDirectory,
    NotDirectory,
    Binary,
    TooLarge,
    BadLine,
    EndBeforeStart,
    PastEnd,
    EmptyPattern,
    InvalidRegex,
    BadTimeout,
}

impl ToolFailure {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn code(self) -> &'static str {
        match self {
            ToolFailure::NotFound => "not_found",
            ToolFailure::IsDirectory => "is_directory",
            ToolFailure::NotDirectory => "not_directory",
            ToolFailure::Binary => "binary",
            ToolFailure::TooLarge => "too_large",
            ToolFailure::BadLine => "bad_line",
            ToolFailure::EndBeforeStart => "end_before_start",
            ToolFailure::PastEnd => "past_end",
            ToolFailure::EmptyPattern => "empty_pattern",
            ToolFailure::InvalidRegex => "invalid_regex",
            ToolFailure::BadTimeout => "bad_timeout",
        }
    }

    pub fn template(self) -> &'static str {
        match self {
            ToolFailure::NotFound => "{path} does not exist.",
            ToolFailure::IsDirectory => "{path} is a directory; use list_dir to see what is in it.",
            ToolFailure::NotDirectory => "{path} is not a directory; use read_file to read a file.",
            ToolFailure::Binary => "{path} is a binary file; only text files are read.",
            ToolFailure::TooLarge => {
                "{path} is {size} bytes, over the {limit} bytes read_file reads."
            }
            ToolFailure::BadLine => "{name} counts lines from 1; {value} is not a line number.",
            ToolFailure::EndBeforeStart => "end_line {end_line} is before start_line {start_line}.",
            ToolFailure::PastEnd => {
                "start_line {start_line} is past the end of {path} ({total} lines)."
            }
            ToolFailure::EmptyPattern => "The pattern is empty.",
            ToolFailure::InvalidRegex => {
                "The pattern {pattern} is not a valid regular expression: {error}"
            }
            ToolFailure::BadTimeout => {
                "timeout_s must be a whole number of seconds from 1 to {max}."
            }
        }
    }

    /// The sentence with `values` filled in.
    pub fn message(self, values: &[(&str, &str)]) -> String {
        fill(self.template(), values)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ToolFailure; 11] = [
        ToolFailure::NotFound,
        ToolFailure::IsDirectory,
        ToolFailure::NotDirectory,
        ToolFailure::Binary,
        ToolFailure::TooLarge,
        ToolFailure::BadLine,
        ToolFailure::EndBeforeStart,
        ToolFailure::PastEnd,
        ToolFailure::EmptyPattern,
        ToolFailure::InvalidRegex,
        ToolFailure::BadTimeout,
    ];
}

/// `template` with each `{name}` that `values` has replaced, literally and
/// in one pass, so a brace in a value stays as it is; a `{name}` it does
/// not have is left alone. The SDKs' `fill`.
pub(crate) fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let filled = after.find('}').and_then(|close| {
            let key = &after[..close];
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value, close))
        });
        match filled {
            Some((value, close)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The argv `run_shell` puts before the command, per platform family.
pub(crate) const SHELL_POSIX: (&str, &[&str]) = ("sh", &["/bin/sh", "-c"]);
pub(crate) const SHELL_WINDOWS: (&str, &[&str]) = (
    "PowerShell",
    &[
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
    ],
);

/// This platform's shell: its name, as the prompt gives it, and its argv.
pub(crate) fn shell() -> (&'static str, &'static [&'static str]) {
    if cfg!(windows) {
        SHELL_WINDOWS
    } else {
        SHELL_POSIX
    }
}

/// `windows`, `macos` or `linux`, the contract's platform names.
pub(crate) fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn contract() -> Value {
        serde_json::from_str(CONTRACT_JSON).expect("agent/contract.json parses")
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .expect("an array")
            .iter()
            .map(|s| s.as_str().expect("a string").to_string())
            .collect()
    }

    #[test]
    fn the_version_is_the_copys() {
        assert_eq!(contract()["contract_version"], CONTRACT_VERSION);
    }

    #[test]
    fn the_tools_match_the_contract_name_kind_and_arguments() {
        let c = contract();
        let tools = c["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        let ours: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        assert_eq!(names, ours, "the same tools, in the same order");
        for t in tools {
            let spec = tool(t["name"].as_str().unwrap()).unwrap();
            let kind = match spec.kind {
                ToolKind::Read => "read",
                ToolKind::Write => "write",
                ToolKind::Shell => "shell",
            };
            assert_eq!(t["kind"], kind, "{}", spec.name);
            assert_eq!(t["read_only"], spec.kind == ToolKind::Read, "{}", spec.name);
            let params = &t["parameters"];
            assert_eq!(params["additionalProperties"], false, "{}", spec.name);
            let required: BTreeSet<String> = strings(&params["required"]).into_iter().collect();
            let ours_required: BTreeSet<String> =
                spec.required.iter().map(|s| s.to_string()).collect();
            assert_eq!(required, ours_required, "{} required", spec.name);
            let properties: BTreeSet<String> = params["properties"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            let ours_all: BTreeSet<String> = spec
                .required
                .iter()
                .chain(spec.optional.iter())
                .map(|s| s.to_string())
                .collect();
            assert_eq!(properties, ours_all, "{} properties", spec.name);
        }
    }

    #[test]
    fn the_modes_match_the_contract() {
        let c = contract();
        assert_eq!(c["default_mode"], DEFAULT_MODE);
        let modes = c["approval_modes"].as_array().unwrap();
        assert_eq!(modes.len(), MODES.len());
        for (m, ours) in modes.iter().zip(MODES) {
            assert_eq!(m["name"], ours.name);
            assert_eq!(strings(&m["allow"]), ours.allow, "{} allow", ours.name);
            assert_eq!(strings(&m["ask"]), ours.ask, "{} ask", ours.name);
            assert_eq!(m["persistable"], ours.persistable, "{}", ours.name);
            assert_eq!(m["requires_flag"], ours.requires_flag, "{}", ours.name);
        }
    }

    #[test]
    fn the_deny_protected_and_context_lists_match_the_contract() {
        let c = &contract()["confinement"];
        assert_eq!(strings(&c["deny"]), DEFAULT_DENY);
        assert_eq!(c["deny_file"], DENY_FILE);
        assert_eq!(strings(&c["search_ignore_files"]), SEARCH_IGNORE_FILES);
        assert_eq!(strings(&c["protected"]), PROTECTED);
        assert_eq!(PROTECTED.len(), 13);
        assert_eq!(c["settings_dir"], SETTINGS_DIR);
        assert_eq!(strings(&c["context_files"]), CONTEXT_FILES);
    }

    #[test]
    fn the_refusals_and_edit_errors_are_the_contracts_sentences() {
        let c = contract();
        let refusals = c["confinement"]["refusals"].as_object().unwrap();
        assert_eq!(refusals.len(), Refusal::ALL.len());
        for r in Refusal::ALL {
            assert_eq!(refusals[r.code()], r.template(), "{}", r.code());
        }
        let approval = c["approval"]["refusals"].as_object().unwrap();
        assert_eq!(approval.len(), ApprovalRefusal::ALL.len());
        for r in ApprovalRefusal::ALL {
            assert_eq!(approval[r.code()], r.template(), "{}", r.code());
        }
        assert_eq!(c["edit"]["crlf_fallback"], EDIT_CRLF_FALLBACK);
        let errors = c["edit"]["errors"].as_object().unwrap();
        assert_eq!(errors.len(), EditFailure::ALL.len());
        for e in EditFailure::ALL {
            assert_eq!(errors[e.code()], e.template(), "{}", e.code());
        }
    }

    #[test]
    fn the_outputs_and_tool_errors_are_the_contracts_text() {
        use outputs::*;
        let c = contract();
        let o = &c["outputs"];
        let pairs = [
            (&o["read_file"]["line"], READ_LINE),
            (&o["read_file"]["empty"], READ_EMPTY),
            (&o["read_file"]["cut"], READ_CUT),
            (&o["read_file"]["line_cut"], READ_LINE_CUT),
            (&o["list_dir"]["empty"], LIST_EMPTY),
            (&o["list_dir"]["cut"], LIST_CUT),
            (&o["glob"]["none"], GLOB_NONE),
            (&o["glob"]["cut"], GLOB_CUT),
            (&o["grep"]["match"], GREP_MATCH),
            (&o["grep"]["ellipsis"], GREP_ELLIPSIS),
            (&o["grep"]["none"], GREP_NONE),
            (&o["grep"]["cut"], GREP_CUT),
            (&o["shell"]["exit"], SHELL_EXIT),
            (&o["shell"]["signal"], SHELL_SIGNAL),
            (&o["shell"]["timeout"], SHELL_TIMEOUT),
            (&o["shell"]["stopped"], SHELL_STOPPED),
            (&o["shell"]["no_output"], SHELL_NO_OUTPUT),
            (&o["shell"]["cut"], SHELL_CUT),
        ];
        for (theirs, ours) in pairs {
            assert_eq!(theirs.as_str(), Some(ours));
        }
        assert_eq!(o["grep"]["line_max_chars"], GREP_LINE_MAX_CHARS);
        let errors = o["errors"].as_object().unwrap();
        assert_eq!(errors.len(), ToolFailure::ALL.len());
        for e in ToolFailure::ALL {
            assert_eq!(errors[e.code()], e.template(), "{}", e.code());
        }
    }

    #[test]
    fn the_limits_and_shells_match_the_contract() {
        let c = contract();
        let l = &c["limits"];
        assert_eq!(l["read_max_lines"], READ_MAX_LINES);
        assert_eq!(l["read_max_bytes"], READ_MAX_BYTES);
        assert_eq!(l["list_max_entries"], LIST_MAX_ENTRIES);
        assert_eq!(l["search_max_results"], SEARCH_MAX_RESULTS);
        assert_eq!(l["shell_timeout_s_default"], SHELL_TIMEOUT_S_DEFAULT);
        assert_eq!(l["shell_timeout_s_max"], SHELL_TIMEOUT_S_MAX);
        assert_eq!(l["shell_output_max_bytes"], SHELL_OUTPUT_MAX_BYTES);
        assert_eq!(l["read_max_file_bytes"], READ_MAX_FILE_BYTES);
        assert_eq!(l["grep_max_file_bytes"], GREP_MAX_FILE_BYTES);
        assert_eq!(l["binary_sniff_bytes"], BINARY_SNIFF_BYTES);
        assert_eq!(
            l.as_object().unwrap().len(),
            10,
            "a new limit needs a constant here"
        );
        let run_shell = c["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "run_shell")
            .unwrap();
        assert_eq!(
            run_shell["parameters"]["properties"]["timeout_s"]["maximum"],
            SHELL_TIMEOUT_S_MAX
        );
        assert_eq!(c["shell"]["posix"]["name"], SHELL_POSIX.0);
        assert_eq!(strings(&c["shell"]["posix"]["argv"]), SHELL_POSIX.1);
        assert_eq!(c["shell"]["windows"]["name"], SHELL_WINDOWS.0);
        assert_eq!(strings(&c["shell"]["windows"]["argv"]), SHELL_WINDOWS.1);
    }

    #[test]
    fn fill_replaces_known_names_once_and_leaves_the_rest() {
        assert_eq!(
            fill("{a} and {b} and {c", &[("a", "{b}"), ("b", "B")]),
            "{b} and B and {c"
        );
        assert_eq!(fill("{x}{}", &[("x", "1")]), "1{}");
        assert_eq!(fill("no braces", &[]), "no braces");
    }

    /// A copy against its source, value for value, when the source is at
    /// hand: named by the environment variable, or found in a python-sdk
    /// checkout beside this one. Skipped (and says so) otherwise.
    fn matches_the_python_sdk(var: &str, sibling: &str, ours: Value) {
        let configured = std::env::var(var).ok();
        let sibling = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../python-sdk")
            .join(sibling);
        let source = configured
            .map(std::path::PathBuf::from)
            .or_else(|| sibling.exists().then_some(sibling));
        let Some(source) = source else {
            eprintln!("skipped: no {var} and no python-sdk beside this checkout");
            return;
        };
        let theirs: Value =
            serde_json::from_str(&std::fs::read_to_string(&source).unwrap()).unwrap();
        assert_eq!(theirs, ours, "the copy drifted from {source:?}");
    }

    #[test]
    fn the_copy_matches_the_python_sdks_contract_when_present() {
        matches_the_python_sdk(
            "MATTERWAVE_AGENT_CONTRACT",
            "src/matterwave_sdk/agent/contract.json",
            contract(),
        );
    }

    #[test]
    fn the_conformance_copy_matches_the_python_sdks_when_present() {
        matches_the_python_sdk(
            "MATTERWAVE_AGENT_CONFORMANCE",
            "tests/agent_conformance.json",
            crate::agent::confine::tests::conformance(),
        );
    }
}
