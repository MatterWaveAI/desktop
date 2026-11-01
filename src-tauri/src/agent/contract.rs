//! The agent tool contract as the native tool host enforces it: the tools,
//! the modes that gate them, the deny list, the limits and the sentences a
//! refusal returns to the model.
//!
//! The one source is the Python SDK's `contract.json`; `agent/contract.json`
//! beside this crate is a byte-for-byte copy of it. The values below are
//! restated rather than parsed at runtime on purpose: the host's behaviour
//! is in code that review can read, and the tests at the bottom fail the
//! moment the copy and the code disagree -- a new deny pattern, a renamed
//! argument, a changed limit. With `MATTERWAVE_AGENT_CONTRACT` naming the
//! Python SDK's file, the copy itself is also checked against the source;
//! CI does not have that file, so the check runs where it is set locally.

/// The contract version this host implements.
pub(crate) const CONTRACT_VERSION: &str = "1.0.0";

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

/// An approval mode as the host sees it: which tools it lets run at all.
/// Whether a tool needs the person's approval first (`ask`) is the SPA's
/// to show; what the host refuses outright is everything a mode denies --
/// `plan` never writes and never runs a command, whatever the webview asks.
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
/// What search skips besides the deny list.
pub(crate) const SEARCH_IGNORE_FILES: &[&str] = &[".gitignore", ".matterwaveignore"];
/// Readable, never writable.
pub(crate) const PROTECTED: &[&str] = &[".matterwaveignore"];

/// Why a path was refused, by the contract's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Empty,
    Parent,
    Outside,
    Symlink,
    Denied,
    Protected,
    /// The host's own, beyond the contract's six: a name Windows would not
    /// store as given (an alternate data stream, a device name, a trailing
    /// dot or space), so what was approved is not what would be touched.
    WindowsName,
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
            Refusal::WindowsName => "windows_name",
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
            Refusal::WindowsName => "Refused: {path} is not a plain file name on Windows (it names an alternate data stream or a device, or a part of it ends in a dot or a space).",
        }
    }

    /// The contract's refusals; `WindowsName` is the host's and not among them.
    pub const ALL: [Refusal; 6] = [
        Refusal::Empty,
        Refusal::Parent,
        Refusal::Outside,
        Refusal::Symlink,
        Refusal::Denied,
        Refusal::Protected,
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
    fn the_deny_list_and_ignore_files_match_the_contract() {
        let c = &contract()["confinement"];
        assert_eq!(strings(&c["deny"]), DEFAULT_DENY);
        assert_eq!(c["deny_file"], DENY_FILE);
        assert_eq!(strings(&c["search_ignore_files"]), SEARCH_IGNORE_FILES);
        assert_eq!(strings(&c["protected"]), PROTECTED);
    }

    #[test]
    fn the_refusals_and_edit_errors_are_the_contracts_sentences() {
        let c = contract();
        let refusals = c["confinement"]["refusals"].as_object().unwrap();
        assert_eq!(refusals.len(), Refusal::ALL.len());
        for r in Refusal::ALL {
            assert_eq!(refusals[r.code()], r.template(), "{}", r.code());
        }
        assert_eq!(c["edit"]["crlf_fallback"], EDIT_CRLF_FALLBACK);
        let errors = c["edit"]["errors"].as_object().unwrap();
        assert_eq!(errors.len(), EditFailure::ALL.len());
        for e in EditFailure::ALL {
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
        assert_eq!(
            l.as_object().unwrap().len(),
            7,
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

    /// The copy against its source, value for value, when the source is at
    /// hand: named by MATTERWAVE_AGENT_CONTRACT, or found by a checkout
    /// beside the Python SDK. Skipped (and says so) otherwise, as in CI.
    #[test]
    fn the_copy_matches_the_python_sdks_contract_when_present() {
        let configured = std::env::var("MATTERWAVE_AGENT_CONTRACT").ok();
        let sibling = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../python-sdk/src/matterwave_sdk/agent/contract.json");
        let source = configured
            .map(std::path::PathBuf::from)
            .or_else(|| sibling.exists().then_some(sibling));
        let Some(source) = source else {
            eprintln!(
                "skipped: no MATTERWAVE_AGENT_CONTRACT and no python-sdk beside this checkout"
            );
            return;
        };
        let theirs: Value =
            serde_json::from_str(&std::fs::read_to_string(&source).unwrap()).unwrap();
        assert_eq!(
            theirs,
            contract(),
            "agent/contract.json drifted from {source:?}"
        );
    }
}
