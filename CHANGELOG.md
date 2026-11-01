# Changelog

All notable changes to the MatterWave desktop app are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version here is the app's own (`package.json`, `tauri.conf.json` and
the API's `MW_RELEASE` all report it).

## [Unreleased]

### Added

- **Agent mode, off by default and not for release until T-406 signs off** (T-1501, its P2
  "native tool host" item): a local agent loop on new chats behind an Agent toggle, offered only
  after the person turns agent mode on in Preferences (a native confirmation). The model works in
  a folder chosen in the OS folder picker through the shared tool contract; the loop runs in the
  SPA against `/v1/chat/completions` (tool calls come back unexecuted, results go back as
  `role: "tool"`, `metadata.conversation_id` stores the run), and every file and process
  operation happens in a native tool host (`src-tauri/src/agent`) behind one allow-listed command
  per tool -- no fs, shell or dialog plugin reaches the webview. The host confines every path
  (`..`, absolute outside, links out, the deny list plus `.matterwaveignore`), fixes each run's
  mode (`plan` is read-only whatever the webview asks), applies a write only as previewed and
  after a checkpoint, and runs `run_shell` with a timeout, a 64 KiB output cap and a process-tree
  kill on Stop (a job object on Windows, a process group on Unix). Modes plan / ask (default) /
  auto-edit / yolo (each of the last two confirmed natively once per folder per session; yolo
  never saved); unified diffs to read before the native approval below; step and token caps; the chat's budget copy on a 402 and a rate-limit copy on a 429;
  greyed out when `/api/me` has `local_agent_tools: false` or the model `supports_tools: false`.
  Also `/approval-mode`, `/restore`, `/init`, `@path`, Shift+Tab through the modes, and a trusted
  folder's `MATTERWAVE.md` / `AGENTS.md`. The contract is the Python SDK's `contract.json`, copied,
  and tested against in Rust and in the SPA. README: "Agent mode".
- **Agent mode: approval is native.** Every `run_shell` in ask and auto-edit, every applied write
  in ask, a write to `MATTERWAVE.md` / `AGENTS.md` / `MATTERWAVE.local.md` in auto-edit, starting
  auto-edit or yolo (once per folder per session) and every `/restore` are confirmed in an OS
  dialog the host raises from inside the call, so script in the webview that calls the commands
  directly cannot skip it. The dialog shows the command whole (one too long to show whole is
  refused) or the file's full path and changed lines, with hidden and bidirectional characters
  spelled out; Cancel is the default; one question at a time; Stop answers an open one no; after a
  yes the write is recomputed and lands only if the file is still what was shown. The panel keeps
  the diff for reading, and its Apply… leads to the dialog. The mode picker is locked during a run.

### Changed

- **Agent mode speaks agent contract 1.1.0** (none of it released). The host and the SPA take the
  SDKs' 1.1 contract (`contract.json` and the shared conformance cases, copied byte for byte; the
  TypeScript helpers re-vendored with `web/scripts/vendor-agent-sdk.mjs`), and the Rust host runs
  every one of the contract's conformance cases (`paths`, `tools`, `ignore`, `shell`) in
  `cargo test`. Visible to the model: read_file has no LF after its last line; list_dir lists
  protected entries and says "has nothing to list" when empty; glob matches a pattern without `/`
  at any depth and ignores case; grep cuts lines at 400 characters and skips files over 4 MiB;
  search reads `.gitignore` and `.matterwaveignore` in every folder from the root down (and no
  longer `.git/info/exclude` or files above the root), case-insensitively, files before
  subfolders; run_shell says `Exit code N` and keeps the head and tail of long output around a
  middle marker; refusals and the person's no use the contract's sentences (`rejected`,
  `unknown_tool`, `mode`); a whole-number `timeout_s` is required. Context files go in the
  contract's fenced "Project instructions" section in its order (MATTERWAVE.md,
  MATTERWAVE.local.md, AGENTS.md), 32,768 characters each. Windows aliases are refused on every
  platform with the contract's `stream`, `trailing`, `device` and `unc` codes.
- **A send that folds first says so.** The API now opens such a send with a `compacting` frame
  and folds inside the stream; the chat restarts its one-minute wait for the first token on it
  and says the earlier messages are being summarised, instead of giving up on a turn that was
  working (the web app's change of 2026-10-26, caught up).

### Security

- **Agent mode: the gaps the T-406 security test left** (none of it released). The org's
  `local_agent_tools` switch is enforced by the native host, which asks `/api/me` itself with the
  stored credential before every run and refuses when the org says no or cannot be asked. Every
  native answer goes to an owner-only, size-rotated approval log in the app's data directory
  (`agent-approvals.log`: time, question, tool, path or command hash, mode, result), a yes the log
  cannot record is not acted on, and a stored run's results say what the person approved. The
  page's CSP `connect-src` is pinned at launch to the API's origin (the committed config no longer
  allows any `https:` host). A write to a protected file -- the contract's 1.1 list, now with
  `.matterwave/`, shell startup files, `.ssh/`, `.aws/` and `.config/matterwave` -- asks natively
  in every mode, yolo included (`.matterwaveignore`, refused outright before, now asks too), and in
  plan and ask reading the settings folder, a startup file or a credentials folder asks natively
  and search leaves them out. On Linux a command also runs in a cgroup of its own where the app's
  cgroup is delegated, so Stop ends processes that called `setsid`. CI runs the agent host's suite
  on Windows and macOS too. `docs/agent-mode-security.md` holds the design pattern and the
  prompt-injection analysis T-406 asks for.
- **Agent mode, from an adversarial review of the tool host** (none of it released): on Windows,
  a path naming an alternate data stream (`notes.txt:hidden`, `x:Zone.Identifier`) could be
  written, and device names and trailing dots or spaces were let through -- all now refused; a
  write to a hard link in the root went through to the file outside it, and a write followed a
  link swapped in after the check -- writes now land beside the target and are renamed over it,
  with the folder checked again; an apply could be sent without a preview; a webview could start
  an auto-edit run (unasked writes) without the person; `/restore` wrote files unasked; a command
  inherited a `MATTERWAVE_API_KEY` from the app's environment; on Windows the shell ran for an
  instant before joining its kill-on-Stop job (it now starts suspended); a huge context file was
  read whole, reads trusted a size taken before the open and would block on a FIFO, and
  `write_file` content had no cap; two applies at once could share a checkpoint; changing the mode
  mid-run looked like it applied but did not.

## [0.3.0] - 2026-10-31

### Added

- **Read-aloud of replies** (T-230): a speaker button on every stored reply,
  driven by the webview's own `speechSynthesis` -- client-side only, the words
  go to the OS voices and never over the network
  (`web/src/apps/chat/tts.ts`, `useReadAloud.ts`). Markdown is spoken as
  prose (code keeps its contents, links their words, images nothing); one
  reply reads at a time; a new generation stops the narration; and the same
  button is the stop button while its reply is the one speaking. Voice and
  pace are in Preferences (this device), offered only where the webview can
  speak at all.
- **The global hotkey quick-summon** (T-231): `Ctrl+Shift+M` by default
  (`CommandOrControl+Shift+M`, so macOS gets Cmd), toggling the window from
  anywhere -- the tray's Show/Hide without finding the tray
  (`src-tauri/src/hotkey.rs`, the `tauri-plugin-global-shortcut` plugin).
  The chord is registered at launch, before the SPA is up, from the choice
  persisted in the app's config directory; Preferences (desktop only)
  offers the default, three alternatives and Off. A chord another
  application holds is refused by the OS, the pane says so, and the
  previous chord keeps working; a bare key is refused outright.
- **Desktop diagnostics pane, dev builds only** (Settings → Desktop
  diagnostics; `web/src/lib/desktopDev.ts` gates it to a dev build inside
  the desktop shell, so release builds never ship it): the scaffolding to
  verify the webview seams for real. The capability flags readout shows
  what the app actually gated (passkeys off, dictation's engine pick, the
  webview's origin); "Send a test notification" proves OS notifications on
  demand, ignoring the focus rule the real notification honours
  (`send_test_notification` in `src-tauri/src/lib.rs`); and the updater
  section is the round trip -- a check logs each stage as it passes
  (`checking` / `downloading` / `verified` / `installing`,
  `update-stage` events from `src-tauri/src/updater.rs`), and an offered
  update can be installed from the pane (T-232's scaffolding), so a signed
  release's check → download → verify → install → relaunch can be watched
  end to end against a real feed. The manual pass itself is written down
  in README.md ("The signed round-trip pass (Windows first)").
- **The update banner names the stage** (`web/src/shell/UpdateBanner.tsx`):
  where the round trip is, next to the progress line -- so a stalled
  update says which step it stopped at.
- **Pair this machine with the platform** (Settings → Devices, desktop
  only): the redeeming half of the edge handshake. A pairing code minted on
  the platform (`POST /api/sync/pairings`) is redeemed here at the
  anonymous route (`POST /api/sync/pair`); the device key it grants --
  `conversations:import` and nothing else -- is kept in the OS keychain
  (`src-tauri/src/device_pairing.rs`, entries `device-key` +
  `device-pairing`), and the pane shows the pairing: name, key hint,
  device id, when, the platform address, and the last sync the
  `/api/sync/status` route reports. Unpairing revokes the key on the
  platform (a key may always revoke itself) and forgets it locally even
  offline. The key is never the app's bearer -- pairing does not change how
  the app signs in -- and the section is available to any signed-in
  person, not only admins, because redemption needs no role.

### Changed

- **CI runs test + lint on every push, not only main** (T-240,
  `.github/workflows/ci.yml`): the web job (lint, typecheck, vitest,
  build) and the Rust job (fmt, clippy, tests) already gated pushes and
  PRs; the push trigger now covers the long-lived branches, develop
  included. Verified green on this tree; the tauri build matrix stays
  `continue-on-error` while the runners' toolchains mature.
- **The release degrades to unsigned when the signing secrets are absent**
  (`.github/workflows/release.yml`, `scripts/release-config.mjs`): with none
  of `TAURI_SIGNING_PRIVATE_KEY`, `MW_UPDATER_PUBKEY` and
  `MW_DESKTOP_UPDATES_URL` set, the build carries no updater and plain
  installers attach to a release titled "(unsigned installers)"; the feed
  job is skipped. A release with only some of them still fails: half a feed
  is worse than none.

## [0.2.1] - 2026-10-28

### Added

- **The web SPA is bundled in this repo** (`web/`): the desktop app ships the
  web app instead of loading it from a server, and `tauri build` produces the
  bundle from it (`beforeBuildCommand` runs `pnpm build:web` into
  `web/dist`), which unblocks the desktop build.
- **Content Security Policy** for the webview (`tauri.conf.json`): no remote
  script (one hash for the inlined theme boot script), `wasm-unsafe-eval` for
  the syntax highlighter, and network access only to the page's own origin
  plus https. The IPC surface stays the app's own commands
  (`src-tauri/capabilities/default.json`); no filesystem, shell or HTTP
  plugin is exposed to the page.
- **Notifications**: one OS notification when a generation finishes while the
  window is unfocused (`notify_generation_complete`). The copy is fixed;
  reply text never goes into a notification, and a focused window gets
  nothing.
- **Updater**: an update check at launch and on request
  (`check_for_updates`), announced as a banner whose install button runs
  `install_update` -- download, verify against the release key, hand to the
  OS installer, relaunch. Off by default: a build without
  `MW_DESKTOP_UPDATER=1` registers no updater, and both entry points answer
  cleanly that updates are disabled.
- **Window state**: the window's size and position survive a restart
  (`tauri-plugin-window-state`), restored over the config's first-run
  defaults.
- **System tray** with Show/Hide and Quit.
- **API-key sign-in**: a platform API key (`mw_<id>_<secret>`) can stand in
  for the browser sign-in on machines nobody sits at. The shape is validated
  before it reaches the OS keychain, every request carries it as the bearer,
  and only its id half is ever shown again. OIDC stays the default; a
  completed browser sign-in supersedes a stored key.
- **CI** (`.github/workflows/ci.yml`): the web job (lint, typecheck, vitest,
  build), the Rust job (fmt, clippy, tests, building in a temp target
  directory for hosts whose application control refuses freshly built
  executables under the repo path), and a `tauri build` matrix over
  Windows/macOS/Linux that is allowed to fail while the runners' toolchains
  mature.

## [0.2.2] - 2026-10-30

### Added

- **Edge pairing in the desktop shell** (Settings → Devices): the pane the
  SPA ships is the platform's half of the pairing handshake -- an owner or
  admin names a box, `POST /api/sync/pairings` mints the once-usable,
  ten-minute code shown once with a countdown, `GET /api/sync/devices`
  lists the paired boxes and `DELETE /api/sync/devices/{id}` unpairs one.
  The desktop adaptation is the address the code is shown against: the
  webview's origin is the app's own (`http://tauri.localhost`), so the code
  names the API base the app was built with (`desktopAppInfo`) instead of
  `window.location.origin`
  (`web/src/apps/settings/panes/DevicesPane.tsx`). Gating and routes are
  the SPA's own; requests ride the desktop bearer exactly as every other
  API call does.
- **Updater verification against a signed local feed**
  (`src-tauri/tests/updater_local.rs`): the plugin's check and download are
  driven the way `updater.rs` drives them against a loopback server serving
  a static `latest.json` and an artifact signed with a Tauri test key
  (`pnpm tauri signer generate`) -- the endpoint template resolves to the
  release path, a newer release is offered and an older one is not,
  progress is reported, and tampered bytes or an artifact signed by another
  key are refused. The install and relaunch stay a manual pass with a real
  signed artifact; the checklist lives in README.md ("Release QA
  checklist"). Test binaries now carry an application manifest
  (`src-tauri/tests/windows.manifest`, compiled by the build script):
  without one, Common-Controls v6 imports make them fail to load on Windows
  (0xc0000139).
- **Release automation** (`.github/workflows/release.yml`): a tag push
  (`v0.2.2`) builds signed installers on all three OSes via
  `tauri-action` (secrets `TAURI_SIGNING_PRIVATE_KEY` +
  `_PASSWORD`, `MW_UPDATER_PUBKEY`, `MW_DESKTOP_UPDATES_URL`,
  `MW_UPDATER_FEED_TOKEN`; variables `MW_DESKTOP_CHANNEL`,
  `MW_DESKTOP_BASE_URL`), attaches them and `latest.json` to the GitHub
  release, and lays out the updater feed with
  `scripts/publish-updater-manifest.mjs` at the exact per-platform paths
  the app asks for. Without the feed token the release is published and the
  feed keeps the previous version.

[Unreleased]: https://github.com/MatterWaveAI/desktop/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MatterWaveAI/desktop/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MatterWaveAI/desktop/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MatterWaveAI/desktop/releases/tag/v0.2.1
