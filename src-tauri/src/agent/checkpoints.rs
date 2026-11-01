//! File checkpoints: before each applied `edit` or `write_file`, the file's
//! bytes as they were (or the fact that it did not exist) are kept in the
//! app's data directory, outside the project. `/restore` lists them and
//! puts files back as they were before one of them; the project's own
//! `.git` is never touched, because nothing here is a git operation.
//!
//! Layout: `<data>/agent-checkpoints/<root key>/<id>/manifest.json` plus one
//! `blob-<n>` per file that existed. The root key is a hash of the root's
//! path, so two workspaces never share a history. What `run_shell` changed
//! is not covered: a command can touch anything, and there is no knowing
//! what to snapshot before it runs.

use super::confine::{confine, DenyList};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Checkpoints kept per workspace; the oldest go first.
const KEEP: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct FileEntry {
    pub relative: String,
    /// Whether the file existed before the write; when it did not, a
    /// restore removes it.
    pub existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Checkpoint {
    pub id: u64,
    /// Unix seconds.
    pub created: u64,
    /// The tool whose write it guards (`edit`, `write_file`).
    pub tool: String,
    /// The conversation the run is stored in, when there is one, so a
    /// restore can be matched with the thread it came from.
    pub label: Option<String>,
    pub files: Vec<FileEntry>,
}

/// One workspace's checkpoints.
pub(crate) struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn for_root(data_dir: &Path, root: &Path) -> Store {
        let key: String = Sha256::digest(root.to_string_lossy().as_bytes())
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect();
        Store {
            dir: data_dir.join("agent-checkpoints").join(key),
        }
    }

    fn ids(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse().ok()))
            .collect();
        ids.sort_unstable();
        ids
    }

    fn manifest(&self, id: u64) -> Option<Checkpoint> {
        let raw =
            std::fs::read_to_string(self.dir.join(id.to_string()).join("manifest.json")).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Checkpoint> {
        let mut all: Vec<Checkpoint> = self
            .ids()
            .into_iter()
            .filter_map(|id| self.manifest(id))
            .collect();
        all.reverse();
        all
    }

    /// Keep `files` (absolute path, relative path) as they are now. Fails
    /// rather than half-records: a write with no checkpoint must not go on.
    pub fn snapshot(
        &self,
        tool: &str,
        label: Option<&str>,
        files: &[(PathBuf, String)],
        now: u64,
    ) -> Result<Checkpoint, String> {
        let id = self.ids().last().map_or(1, |last| last + 1);
        let dir = self.dir.join(id.to_string());
        std::fs::create_dir_all(&dir).map_err(|e| format!("checkpoint: {e}"))?;
        let mut entries = Vec::new();
        for (n, (absolute, relative)) in files.iter().enumerate() {
            let existed = absolute.exists();
            if existed {
                std::fs::copy(absolute, dir.join(format!("blob-{n}")))
                    .map_err(|e| format!("checkpoint of {relative}: {e}"))?;
            }
            entries.push(FileEntry {
                relative: relative.clone(),
                existed,
            });
        }
        let checkpoint = Checkpoint {
            id,
            created: now,
            tool: tool.to_string(),
            label: label.map(str::to_string),
            files: entries,
        };
        let manifest = serde_json::to_string_pretty(&checkpoint).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("manifest.json"), manifest)
            .map_err(|e| format!("checkpoint: {e}"))?;
        self.prune();
        Ok(checkpoint)
    }

    fn prune(&self) {
        let ids = self.ids();
        if ids.len() > KEEP {
            for id in &ids[..ids.len() - KEEP] {
                let _ = std::fs::remove_dir_all(self.dir.join(id.to_string()));
            }
        }
    }

    /// Put the workspace back as it was before checkpoint `id`: every
    /// checkpoint from the newest down to `id` is undone in turn, so later
    /// writes to the same file cannot survive an earlier restore. Each path
    /// is confined again before it is written. The undone checkpoints are
    /// then dropped. Answers with the files put back.
    pub fn restore(&self, root: &Path, id: u64) -> Result<Vec<String>, String> {
        let ids: Vec<u64> = self.ids().into_iter().filter(|&c| c >= id).collect();
        if !ids.contains(&id) {
            return Err(format!("There is no checkpoint {id}."));
        }
        let deny = DenyList::load(root);
        let mut restored: Vec<String> = Vec::new();
        for cid in ids.iter().rev() {
            let Some(checkpoint) = self.manifest(*cid) else {
                continue;
            };
            let dir = self.dir.join(cid.to_string());
            for (n, entry) in checkpoint.files.iter().enumerate() {
                let target = confine(root, &entry.relative, &deny, true)
                    .map_err(|r| format!("checkpoint {cid}: {}", r.message))?;
                if entry.existed {
                    if let Some(parent) = target.absolute.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    std::fs::copy(dir.join(format!("blob-{n}")), &target.absolute)
                        .map_err(|e| format!("restoring {}: {e}", entry.relative))?;
                } else if target.absolute.is_file() {
                    std::fs::remove_file(&target.absolute)
                        .map_err(|e| format!("restoring {}: {e}", entry.relative))?;
                }
                if !restored.contains(&entry.relative) {
                    restored.push(entry.relative.clone());
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        Ok(restored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn file_hash(path: &Path) -> String {
        Sha256::digest(std::fs::read(path).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// The P1 acceptance case: two applied edits, one restore, both files
    /// back to their bytes, and the project's own repository untouched.
    #[test]
    fn a_restore_after_two_edits_brings_both_files_back_and_leaves_git_alone() {
        let ws = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = super::super::confine::resolve_links(ws.path()).unwrap();
        std::fs::write(root.join("a.txt"), "a1\r\n").unwrap();
        std::fs::write(root.join("b.txt"), "b1\n").unwrap();
        let with_git = git(&root, &["init", "-q"]).is_some()
            && git(
                &root,
                &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"],
            )
            .is_some()
            && git(
                &root,
                &[
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "user.name=t",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    "base",
                ],
            )
            .is_some();
        let head_before = with_git.then(|| git(&root, &["rev-parse", "HEAD"]).unwrap());
        let index_before = with_git.then(|| file_hash(&root.join(".git/index")));

        let store = Store::for_root(data.path(), &root);
        let first = store
            .snapshot(
                "edit",
                Some("c1"),
                &[(root.join("a.txt"), "a.txt".into())],
                1,
            )
            .unwrap();
        std::fs::write(root.join("a.txt"), "a2\r\n").unwrap();
        store
            .snapshot(
                "write_file",
                Some("c1"),
                &[(root.join("b.txt"), "b.txt".into())],
                2,
            )
            .unwrap();
        std::fs::write(root.join("b.txt"), "b2\n").unwrap();
        store
            .snapshot(
                "write_file",
                Some("c1"),
                &[(root.join("new.txt"), "new.txt".into())],
                3,
            )
            .unwrap();
        std::fs::write(root.join("new.txt"), "fresh").unwrap();

        let listed = store.list();
        assert_eq!(
            listed.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert_eq!(listed[2].label.as_deref(), Some("c1"));

        let restored = store.restore(&root, first.id).unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"a1\r\n");
        assert_eq!(std::fs::read(root.join("b.txt")).unwrap(), b"b1\n");
        assert!(
            !root.join("new.txt").exists(),
            "a file the agent created is removed"
        );
        assert!(store.list().is_empty());

        if with_git {
            assert_eq!(git(&root, &["rev-parse", "HEAD"]), head_before);
            assert_eq!(Some(file_hash(&root.join(".git/index"))), index_before);
        } else {
            eprintln!("git not available: the HEAD and index check was skipped");
        }
    }

    #[test]
    fn an_unknown_checkpoint_is_an_error_and_restores_nothing() {
        let ws = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = Store::for_root(data.path(), ws.path());
        assert!(store.restore(ws.path(), 7).is_err());
    }

    #[test]
    fn two_workspaces_keep_separate_histories() {
        let data = tempfile::tempdir().unwrap();
        let a = Store::for_root(data.path(), Path::new("/w/a"));
        let b = Store::for_root(data.path(), Path::new("/w/b"));
        assert_ne!(a.dir, b.dir);
    }
}
