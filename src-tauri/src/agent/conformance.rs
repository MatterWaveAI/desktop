//! The contract's conformance cases, run against the host itself: every
//! case `agent/contract.json` carries under `conformance` (`paths`, `tools`,
//! `ignore`, `shell`, `alias_roots`, over the `tree` it describes, with its
//! `links` and `fifos` made where the platform can) and the approval cases
//! of the SDKs' helper file (`agent/conformance.json`: `decisions`,
//! `protected`, `refusals`). The SDKs run the same cases; these keep the
//! Rust port honest each time the contract changes.

use super::approval::{decision, Decision};
use super::confine::tests::{conformance as helper_cases, link_file, tree};
use super::confine::{confine, resolve_links, windows_alias, Access, DenyList};
use super::contract::{self, ApprovalRefusal, Refusal, CONTRACT_JSON};
use super::output::{format_shell_kept, Limits, ShellEnd};
use super::search::SearchIgnore;
use super::tools::{self, ToolOutput, Workspace};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

static RUNNING: AtomicBool = AtomicBool::new(false);

fn contract_cases() -> Value {
    let c: Value = serde_json::from_str(CONTRACT_JSON).expect("agent/contract.json parses");
    c["conformance"].clone()
}

fn list<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("conformance.{key}"))
}

/// The conformance tree as a workspace, its canonical root, and which of
/// `links` and `fifos` could be made in it after the tree (a case that
/// `needs` one that could not is skipped).
fn workspace(cases: &Value) -> (tempfile::TempDir, PathBuf, BTreeSet<&'static str>) {
    let dir = tree(cases["tree"].as_object().expect("conformance.tree"));
    let root = resolve_links(dir.path()).unwrap();
    let mut made = BTreeSet::new();
    match make_fifos(&root, list(cases, "fifos")) {
        Ok(()) => {
            made.insert("fifos");
        }
        Err(why) => eprintln!("fifos not made: {why}"),
    }
    let links = cases["links"].as_object().expect("conformance.links");
    let linked = links.iter().try_for_each(|(link, target)| {
        link_file(Path::new(target.as_str().unwrap()), &root.join(link))
    });
    match linked {
        Ok(()) => {
            made.insert("links");
        }
        Err(why) => eprintln!("links not made: {why}"),
    }
    (dir, root, made)
}

/// The named pipes `fifos` lists, made with mkfifo(3); none on Windows,
/// whose named pipes live outside the filesystem.
fn make_fifos(root: &Path, fifos: &[Value]) -> Result<(), String> {
    #[cfg(unix)]
    {
        for fifo in fifos {
            let path = root.join(fifo.as_str().unwrap());
            let c = std::ffi::CString::new(path.to_string_lossy().as_bytes())
                .map_err(|e| e.to_string())?;
            // SAFETY: a plain mkfifo(3) on a path in this test's own tree.
            if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (root, fifos);
        Err("Windows has no named pipes in the filesystem".into())
    }
}

/// Whether a case can run: everything it `needs` was made.
fn runnable(case: &Value, made: &BTreeSet<&str>) -> bool {
    case["needs"]
        .as_array()
        .is_none_or(|needs| needs.iter().all(|n| made.contains(n.as_str().unwrap())))
}

/// The contract's limits with a case's `limits` laid over them.
fn limits_of(case: &Value) -> Limits {
    let mut limits = Limits::default();
    if let Some(over) = case["limits"].as_object() {
        for (name, value) in over {
            let n = value.as_u64().expect("a limit is a whole number");
            match name.as_str() {
                "read_max_lines" => limits.read_max_lines = n as usize,
                "read_max_bytes" => limits.read_max_bytes = n as usize,
                "list_max_entries" => limits.list_max_entries = n as usize,
                "search_max_results" => limits.search_max_results = n as usize,
                "shell_output_max_bytes" => limits.shell_output_max_bytes = n as usize,
                "read_max_file_bytes" => limits.read_max_file_bytes = n,
                "grep_max_file_bytes" => limits.grep_max_file_bytes = n,
                "binary_sniff_bytes" => limits.binary_sniff_bytes = n as usize,
                other => panic!("a limit the host does not know: {other}"),
            }
        }
    }
    limits
}

#[test]
fn every_paths_case() {
    let cases = contract_cases();
    let (_dir, root, made) = workspace(&cases);
    let deny = DenyList::load(&root);
    let all = list(&cases, "paths");
    assert_eq!(all.len(), 59, "the contract's 59 paths cases");
    let mut skipped = 0;
    for case in all {
        if !runnable(case, &made) {
            skipped += 1;
            continue;
        }
        let path = case["path"].as_str().unwrap();
        let access = if case["write"].as_bool().unwrap_or(false) {
            Access::Write
        } else {
            Access::Read
        };
        let got = confine(&root, path, &deny, access);
        match case["refused"].as_str() {
            Some(code) => {
                let err = got.expect_err(path);
                assert_eq!(err.reason.code(), code, "{path:?}");
                assert_eq!(
                    Some(err.message.as_str()),
                    case["message"].as_str(),
                    "{path:?}"
                );
            }
            None => {
                let ok = got.unwrap_or_else(|e| panic!("{path:?}: {e:?}"));
                assert_eq!(ok.relative, case["relative"].as_str().unwrap(), "{path:?}");
            }
        }
    }
    report_skipped("paths", skipped, &made);
}

/// Says how many cases were skipped for a fixture the platform cannot make.
fn report_skipped(kind: &str, skipped: usize, made: &BTreeSet<&str>) {
    if skipped > 0 {
        eprintln!("skipped {skipped} {kind} cases: they need a link or a named pipe this platform could not make (made: {made:?})");
    }
}

fn run_tool(ws: &Workspace, tool: &str, args: Value) -> ToolOutput {
    macro_rules! call {
        ($f:expr) => {
            match tools::parse_args(tool, args) {
                Ok(a) => ($f)(ws, a),
                Err(e) => e,
            }
        };
    }
    match tool {
        "read_file" => call!(tools::read_file),
        "list_dir" => call!(tools::list_dir),
        "glob" => call!(tools::glob),
        "grep" => call!(tools::grep),
        other => panic!("a tools case for {other}"),
    }
}

#[test]
fn every_tools_case() {
    let cases = contract_cases();
    let (_dir, root, made) = workspace(&cases);
    let all = list(&cases, "tools");
    assert_eq!(all.len(), 59, "the contract's 59 tools cases");
    let mut skipped = 0;
    for case in all {
        if !runnable(case, &made) {
            skipped += 1;
            continue;
        }
        let tool = case["tool"].as_str().unwrap();
        let name = format!("{tool} {}", case["args"]);
        let mut ws = Workspace::new(&root, &RUNNING);
        ws.limits = limits_of(case);
        let out = run_tool(&ws, tool, case["args"].clone());
        if let Some(expected) = case["expected"].as_str() {
            assert!(!out.is_error, "{name}: {}", out.output);
            assert_eq!(out.output, expected, "{name}");
            continue;
        }
        assert!(out.is_error, "{name}: {}", out.output);
        assert!(
            case["error"].is_string() || case["refused"].is_string(),
            "{name}: a case with neither expected nor error"
        );
        if let Some(message) = case["message"].as_str() {
            assert_eq!(out.output, message, "{name}");
        } else {
            let prefix = case["message_prefix"].as_str().unwrap();
            assert!(out.output.starts_with(prefix), "{name}: {}", out.output);
        }
    }
    report_skipped("tools", skipped, &made);
}

#[test]
fn every_ignore_case() {
    let cases = contract_cases();
    let (_dir, root, _) = workspace(&cases);
    let rules = SearchIgnore::load(&root, DenyList::load(&root));
    let all = list(&cases, "ignore");
    assert_eq!(all.len(), 38, "the contract's 38 ignore cases");
    for case in all {
        let path = case["path"].as_str().unwrap();
        let is_dir = case["is_dir"].as_bool().unwrap_or(false);
        let ancestors = case["ancestors"].as_bool().unwrap_or(true);
        assert_eq!(
            rules.ignored(path, is_dir, ancestors),
            case["ignored"].as_bool().unwrap(),
            "{path} (is_dir {is_dir}, ancestors {ancestors})"
        );
    }
}

#[test]
fn every_shell_case() {
    let cases = contract_cases();
    let all = list(&cases, "shell");
    assert_eq!(all.len(), 10, "the contract's 10 shell cases");
    for case in all {
        let end = if case["timed_out"].as_bool().unwrap_or(false) {
            ShellEnd::TimedOut(case["timeout_s"].as_u64().unwrap())
        } else if case["stopped"].as_bool().unwrap_or(false) {
            ShellEnd::Stopped
        } else {
            ShellEnd::Exited(case["exit_code"].as_i64().map(|c| c as i32))
        };
        let output = case["output"].as_str().unwrap();
        // A case with `omitted` passes the kept ends of a longer output.
        let omitted = case["omitted"].as_u64().unwrap_or(0) as usize;
        assert_eq!(
            format_shell_kept(end, output.as_bytes(), omitted, &limits_of(case)),
            case["expected"].as_str().unwrap(),
            "{case}"
        );
    }
}

/// `windows_alias(path, root)` for roots inside folders whose names are
/// Windows aliases: only the names below the root count.
#[test]
fn every_alias_roots_case() {
    let cases = contract_cases();
    let all = list(&cases, "alias_roots");
    assert_eq!(all.len(), 13, "the contract's 13 alias_roots cases");
    for case in all {
        let root = case["root"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        let got = windows_alias(path, Some(root)).map(Refusal::code);
        assert_eq!(got, case["refused"].as_str(), "{path} under {root}");
    }
}

fn decision_named(code: &str) -> Decision {
    match code {
        "allow" => Decision::Allow,
        "ask" => Decision::Ask,
        "deny" => Decision::Deny,
        other => panic!("a decision the host does not know: {other}"),
    }
}

/// Each mode's decision for each tool, a client's own (`web_fetch`)
/// included: the host has none, so it denies one.
#[test]
fn every_mode_decision() {
    let c = helper_cases();
    for (mode, tools) in c["decisions"].as_object().unwrap() {
        let spec = contract::mode(mode).unwrap();
        for (tool, expected) in tools.as_object().unwrap() {
            assert_eq!(
                decision(spec, tool, None),
                decision_named(expected.as_str().unwrap()),
                "{tool} in {mode}"
            );
        }
    }
}

/// The protected cases: which paths are protected, and what each mode
/// decides for a write (and a read) of each.
#[test]
fn every_protected_case() {
    let c = helper_cases();
    let all = c["protected"].as_array().unwrap();
    assert!(!all.is_empty());
    for case in all {
        let path = case["path"].as_str().unwrap();
        assert_eq!(
            super::confine::is_protected(path, false),
            case["protected"].as_bool().unwrap(),
            "{path}"
        );
        for (key, expected) in case["decisions"].as_object().unwrap() {
            let (tool, mode) = key.split_once(' ').unwrap();
            let got = decision(contract::mode(mode).unwrap(), tool, Some(path));
            assert_eq!(got.code(), expected.as_str().unwrap(), "{path}: {key}");
        }
    }
}

/// The refusal sentences, approval and confinement alike, filled in.
#[test]
fn every_refusal_case() {
    let c = helper_cases();
    for case in c["refusals"].as_array().unwrap() {
        let code = case["code"].as_str().unwrap();
        let value = |k: &str| case["values"][k].as_str().unwrap_or("").to_string();
        let approval = ApprovalRefusal::ALL.into_iter().find(|r| r.code() == code);
        let got = match approval {
            Some(r) => r.message(&value("tool"), &value("mode"), &value("path")),
            None => {
                let r = Refusal::ALL
                    .into_iter()
                    .find(|r| r.code() == code)
                    .unwrap_or_else(|| panic!("a refusal the host does not know: {code}"));
                super::confine::PathRefused::new(r, &value("path")).message
            }
        };
        assert_eq!(got, case["expected"].as_str().unwrap(), "{code}");
    }
}
