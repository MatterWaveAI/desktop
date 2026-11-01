# MatterWave desktop

The web app (`web/`, bundled in this repo) in a native window, built with Tauri 2. The SPA is
bundled, not loaded from the server; the native side adds what a browser tab cannot: a sign-in
that survives restarts with the tokens in the OS keychain (or an API key in its place, for
machines nobody sits at), deep links (`matterwave://`), an OS notification when a reply lands
while the window is unfocused, a tray with Show/Hide and Quit, an update check and install the
SPA can run, and a window whose size and position survive a restart. Tauri rather than
Electron: the installer is about 10 MB because it uses the OS webview instead of shipping
Chromium, the renderer has no Node and its IPC is allow-listed per command, and the native
layer (sign-in, keychain, updater, notifications, tray, deep links) is a few hundred lines of
Rust.

## Prerequisites

All platforms: Rust (stable, `rustup`), Node 22, pnpm 10.

| OS | Also needs |
|---|---|
| Windows 10/11 | Microsoft C++ Build Tools ("Desktop development with C++"); WebView2 runtime (preinstalled on Windows 11; the installer bootstraps it elsewhere). MSI bundling downloads WiX on first build. |
| macOS 12+ | Xcode Command Line Tools (`xcode-select --install`). |
| Linux (Debian/Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, plus a Secret Service provider (GNOME Keyring or KWallet) for the keychain. |

## Develop

```
pnpm install            # the Tauri CLI at the root
pnpm --dir web install  # the SPA's dependencies
MW_DESKTOP_BASE_URL=https://app.matterwave.ai pnpm tauri dev   # the API to sign in against
```

`tauri dev` starts the web dev server (`pnpm --dir web dev`) and points the window at it, so
`/api` goes through Vite's proxy exactly as in a browser (`API_PROXY_TARGET` picks the API). The
native side still signs in against the API named by `MW_DESKTOP_BASE_URL`, which is read **at
build time**: change it and the Rust side rebuilds. A build without it starts, but sign-in says
the build has no base URL.

Unit tests: `cd src-tauri && cargo test` (PKCE, callback state check, token parsing, refresh
decision, loopback parsing, the keychain's save/load rules against an in-memory store, the API
key's shape checks, the device pairing's code normalization, redeem and unpair against a fake
platform on loopback, the updater's build flag, the whole sign-in flow -- discovery,
authorize URL, loopback callback, PKCE exchange, refresh, revoke -- against a fake issuer on
127.0.0.1 with a closure standing in for the browser, and the updater's check and download against
a local feed whose artifact is signed with a test key, `src-tauri/tests/updater_local.rs`, and
agent mode's tool host -- confinement, edits, search, checkpoints, the contract parity and
`run_shell`'s timeout, cap and process-tree Stop, `src-tauri/src/agent`; see "Agent mode" below).
The SPA side, inside `web/`:
`pnpm vitest run src/lib/desktopAuth.test.ts src/lib/desktopAuth.notify.test.ts
src/apps/chat/chatAdapter.test.ts` (the desktop bearer path, the reply-ready notification, the
streaming adapter), plus the settings pane and update banner tests
(`pnpm vitest run src/apps/settings/panes/AccountPane.test.ts src/apps/settings/panes/DevicesPane.test.ts
src/shell/UpdateBanner.test.tsx`).

What the tests do not cover: the real OS keychain (the `Store` seam in `keychain.rs` is what the
tests drive; the keyring-backed one needs a desktop session), the deep-link delivery (a Tauri
`AppHandle`), the webview itself, the focus-gated notification and the tray menu (they need a
real window and a real system tray), and the updater's **install and relaunch** (they need a real
OS installer; the check, download and signature verification run in `tests/updater_local.rs`
against a local feed, and the full pass with a release-signed artifact is the release QA checklist
under "Updates and channels").

On Windows, `cargo test` needs the MSVC build tools; the WebView2 SDK is pulled by the `tauri`
crate and links without the runtime installed. A machine whose application-control policy blocks
freshly built executables will see `os error 4551` on build scripts -- the build is fine, the
policy is refusing to run what it just produced. Where the policy is path-scoped, building
somewhere else works: `CARGO_TARGET_DIR=<an allowed path> cargo test`. Smart App Control is not
path-scoped: it judges each unsigned binary by what is in it, and it refused a test binary whose
test spelled out a hidden-window PowerShell launch. The agent tests start their child processes
without one; keep it that way.

## Build

```
MW_DESKTOP_BASE_URL=https://app.matterwave.ai pnpm build          # release bundle for this OS
MW_DESKTOP_BASE_URL=https://app.matterwave.ai pnpm tauri build --debug
```

`build:web` runs first (`pnpm --dir web build`: `tsc --noEmit` then the Vite build) and the bundle
takes `web/dist`. Output: `src-tauri/target/{release,debug}/bundle/` (MSI and NSIS on Windows,
`.app`/DMG on macOS, AppImage and `.deb` on Linux). Signing and notarisation belong to the
release job.

In the bundled app the page's origin is the webview's (`tauri://localhost`, or
`http://tauri.localhost` on Windows), so API calls are sent to `MW_DESKTOP_BASE_URL` with a
bearer and no cookie. The API allows both origins for CORS exactly when its
`MW_OIDC_NATIVE_CLIENT_ID` is set (`api/matterwave/config.py`), so a deployment without the
native client refuses the webview rather than half-working.

## Sign-in

1. The SPA's `/login` page, inside the shell, offers "Sign in with your browser" and calls
   `sign_in` (`web/src/shell/LoginPage.tsx`); it never starts the browser redirect the web app
   uses, because the webview has no cookie jar for that callback to fill. The native side reads
   `/api/auth-config` for the native the identity provider client (`native_client_id`, `authorization_endpoint`,
   `token_endpoint`).
2. It makes a PKCE verifier and a `state`, and opens the authorize URL in the **system browser**
   (never an embedded page: password managers and passkeys live there).
3. the identity provider redirects to `matterwave://auth/callback`. The deep-link plugin hands the URL to the
   running app (a second launch on Windows and Linux is folded into the first by the
   single-instance plugin). Where the scheme is not registered (a dev build on macOS, a Linux
   desktop without the `.desktop` entry), the redirect is `http://127.0.0.1:<port>/callback`
   instead, served once by a listener bound to loopback only. Both redirects are registered on
   the native client the gateway play provisions (`matterwave-desktop`,
   `deploy/ansible/roles/the identity provider/tasks/provision.yml`): the scheme as is, and the loopback as
   `http://127.0.0.1/callback` without a port, because the port is picked by the OS per sign-in
   and the identity provider matches loopback redirects of a native app on host and path only (RFC 8252 7.3).
4. The callback's `state` is checked before its code is used; the code is exchanged with the
   verifier; access and refresh tokens go to the OS keychain (Keychain, Credential Manager,
   Secret Service). Nothing is written to a file.
5. The SPA asks `get_access_token` for the bearer. The native side refreshes 60 s before expiry,
   and once more when the SPA reports a 401 (one retry). A refused refresh (`invalid_grant`, for
   example a device revoked in Settings -> Sessions) clears the keychain and the app is signed out.

`sign_out` revokes the refresh and access tokens at the identity provider (best effort) and clears the keychain
whether or not the revoke reached it. The shell's Sign out (`web/src/shell/signOut.ts`) calls it
and reloads the page into Boot; it never sends the webview to the identity provider's end_session, which is the
browser's path and would leave the window on the IdP. `open_external` opens http(s) and mailto
links in the system browser and refuses any other scheme.

### An API key instead of the browser

Settings -> Account ("Desktop app") takes a platform API key (`mw_<id>_<secret>`, the API keys
pane makes one) as this machine's credential, for CI boxes and shared workstations where a
browser dance has nobody to dance. `set_api_key` (`src-tauri/src/lib.rs`) validates the shape
(`api_key.rs`) before the key reaches the keychain as its own `api-key` entry; from then on
`get_access_token` answers with the key and every request carries it as the bearer, no OIDC
tokens involved. Only the id half is shown again (`api_key_state`). Removing the key falls back
to the browser session -- which stays signed in underneath -- while `sign_out` clears key and
tokens together. OIDC stays the default: a completed browser sign-in supersedes a stored key.

The webview may call only the app's own commands, each named in `src-tauri/capabilities/default.json`;
no filesystem, shell, dialog or HTTP plugin is exposed to it. The `agent_*` commands are agent mode's
native tool host, which is off until the person turns it on (below). The page runs under a restrictive CSP
(`tauri.conf.json`): no remote script (one hash, for the theme boot script inlined to avoid a
flash), `wasm-unsafe-eval` for the syntax highlighter, and network access only to the page's own
origin plus https for the API.

### Pairing this machine as a device

Settings -> Devices gains a desktop-only section, "Pair with the platform": a code minted on the
platform (`POST /api/sync/pairings`, by an owner or admin) is redeemed here at the platform's
anonymous route (`POST /api/sync/pair`), and the device key it grants -- `conversations:import`
and nothing else -- is kept in the OS keychain (`device-key` + `device-pairing` entries,
`src-tauri/src/device_pairing.rs`). The key is **not** the app's bearer: pairing never changes
how the app signs in, it registers the machine as one of the org's devices, listed and revocable
on the platform's Devices pane beside the paired boxes. Unpairing revokes with the key itself
(a key may always revoke itself) and forgets the pairing locally even when the platform is
unreachable; a re-pairing keeps the machine's device id. The section is open to any signed-in
person because redemption needs no role; only minting codes is an admin act.

## Notifications

One OS notification, and one case for it: a generation finished while the window was not
focused. The SPA tells the native side when a stream ends in `done`
(`web/src/apps/chat/chatAdapter.ts`); the native side checks focus and shows the notification
only when the window is unfocused (`notify_generation_complete` in `src-tauri/src/lib.rs`) --
a focused window already shows the reply land. The copy is fixed ("Your reply is ready.");
reply text never goes into a notification. Clicking it does nothing (no notification actions
are wired), and an error or a cancellation sends none: the in-app notices cover those when the
person comes back.

## Global hotkey

`Ctrl+Shift+M` by default (the plugin's `CommandOrControl+Shift+M`, so a Mac gets `Cmd+Shift+M`):
a quick-summon that toggles the window from anywhere, the tray's Show/Hide without finding the
tray (`src-tauri/src/hotkey.rs`, the `tauri-plugin-global-shortcut` plugin). The chord is
registered at launch -- before the SPA is up -- from the persisted choice, so the setting lives
on the native side, in the app's config directory (`hotkey.json`), and the Preferences pane's
"Global hotkey" select (desktop only) drives it through `set_global_shortcut`. A chord another
application holds is refused by the OS: the pane says so, and the previous chord stays
registered. A bare key (no modifier) is refused outright -- it would fire on every keystroke,
everywhere.

## Read aloud

The speaker button under every stored reply reads it with the webview's own
`speechSynthesis` (`web/src/apps/chat/tts.ts`, `useReadAloud.ts`) -- client-side only, the
words go to the OS voices and never over the network. Markdown is spoken as prose (code keeps
its contents, links their words, images nothing), one reply reads at a time, and a new
generation stops the narration. Voice and pace are on Preferences (this device); a webview
without speech synthesis renders neither the button nor the section.

## Updates and channels

**Off by default.** `tauri.conf.json` names no update endpoint, and a build made without
`MW_DESKTOP_UPDATER=1` does not register the updater plugin at all: no request leaves the app.
Both exposed entry points answer cleanly -- `check_for_updates` reports "no update" and
`install_update` says "updates are disabled in this build" (`src-tauri/src/updater.rs`). The
`pubkey` in the committed config is a placeholder the release job overwrites; it is harmless on
its own because nothing reads it until the plugin is on.

A build made with `MW_DESKTOP_UPDATER=1` (read at build time, like `MW_DESKTOP_BASE_URL`)
registers the plugin and runs **one check at launch** (`src-tauri/src/updater.rs`). The SPA can
run the same check itself with `check_for_updates`, which answers with the newer version string
(or nothing) and emits the same `update-available` event. A newer version is only ever
announced: the shell shows an "update available" banner (`web/src/shell/UpdateBanner.tsx`)
whose install button runs `install_update` -- the plugin downloads the artifact (progress goes
to the SPA as `update-download-progress` / `update-download-finished`), verifies it against the
release job's key, hands it to the OS installer and relaunches. Nothing downloads or installs
on its own; applying an update is the person pressing the button.

The endpoint and key come from the release job. `pnpm build:release` runs
`scripts/release-config.mjs`, which writes `src-tauri/tauri.release.json` (ignored by git) from:

| Variable | Meaning |
|---|---|
| `MW_UPDATER_PUBKEY` | Public half of the updater key (`pnpm tauri signer generate`). |
| `MW_DESKTOP_CHANNEL` | One channel per `MW_ENV` (`dev`, `staging`, `prod`). |
| `MW_DESKTOP_UPDATES_URL` | Where the release job publishes manifests. |
| `MW_DESKTOP_UPDATER` | `1` to build the updater in; the release job sets it with the three above. |
| `MW_RELEASE` | Optional; becomes the app version when it is semver, so app and API report the same string. |
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | Read by the bundler to sign the update artifacts; kept with the release secrets, never in the repo. |

The endpoint is `<MW_DESKTOP_UPDATES_URL>/desktop/<channel>/{{target}}/{{arch}}/{{current_version}}`,
so a build only ever sees its own channel's manifest. The six-hourly re-check and the rollback
test are not built; the install step is (the banner's button), but only ever on request.

### The signed round-trip pass (Windows first)

The Done for the release ticket is concrete: **a signed release installs and relaunches via the
updater on at least one OS**, walked by hand. The steps, Windows first:

1. **One-time setup.** Generate the updater key (`pnpm tauri signer generate`): the private half
   and its password go to the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   secrets, the public half to `MW_UPDATER_PUBKEY`, and a feed address to
   `MW_DESKTOP_UPDATES_URL` (Settings -> Secrets and variables -> Actions; the full table is at
   the top of `.github/workflows/release.yml`). Losing the private key means a new key and every
   installed app refusing updates from it, so it lives with the release credentials, never in
   the repo.
2. **Cut a signed tag.** Bump the version, tag `vX.Y.Z`, push the tag: the release job decides
   signed-vs-unsigned from the secrets, builds with `MW_DESKTOP_UPDATER=1`, signs the artifacts
   with the private key and publishes the feed (`scripts/publish-updater-manifest.mjs`). The
   release page must show `latest.json` and the `.sig` files; a release titled "(unsigned
   installers)" means a secret was missing -- stop and fix the secrets, the pass is meaningless
   against an unsigned feed.
3. **Install the previous release.** A build of the version just superseded, made with the same
   `MW_UPDATER_PUBKEY` (`MW_DESKTOP_UPDATER=1 pnpm build:release`).
4. **Walk the round trip, watching the dev pane** (Settings -> Desktop diagnostics, dev build):
   "Check for updates now" answers with the offered version, "Install X now" starts the
   download, and the stage log shows `checking` → `downloading` (with percentages in the
   banner) → `verified` (the signature, against the release key) → `installing` -- then the OS
   installer runs (passive on Windows), the app relaunches, and the capability flags report the
   new version. The same stages are visible from the shell's update banner without the dev pane.
5. **File what you found.** Anything that surprised you in the walk -- a stage that never
   arrived, a message that mis-names its remedy, an installer that left the old version
   running -- is a gap against `src-tauri/src/updater.rs` (and, for the SPA side,
   `web/src/lib/desktopAuth.ts`): fix it or open it against the file, with the stage the round
   trip stopped at and the feed's manifest for that release.
6. **Then run the full checklist below** for the channel you are about to publish -- the
   tampered-feed step and the rollback step especially.

### Release QA checklist

The updater's check and download are exercised in tests against a local feed
(`src-tauri/tests/updater_local.rs`: the endpoint template, the static manifest lookup, version
comparison, and signature verification of an artifact signed with a test key). What a test cannot
do is run a real installer on a real OS, so before publishing a channel, run this pass with the
release key's artifacts:

1. **Serve the real feed.** Point `MW_DESKTOP_UPDATES_URL` at the staging channel and confirm the
   manifest answers for the exact endpoint shape (any `current_version` path, e.g.
   `.../prod/windows/x86_64/0.1.9` returns the `latest.json` for the new release).
2. **Install the previous release.** A build of the version just superseded, made with
   `MW_DESKTOP_UPDATER=1` and the same `MW_UPDATER_PUBKEY`.
3. **The banner appears.** Launch, wait for the launch check (`update-available`), and confirm the
   banner names the new version. Check-for-updates from the app answers the same.
4. **Download reports progress.** The installing line shows percentages (`update-download-progress`),
   then the finished state (`update-download-finished`).
5. **Install and relaunch.** Press "Update and restart": the OS installer runs (passive on Windows),
   the app relaunches, and `app_info` reports the new version. On macOS and Linux the artifact is
   the app bundle/AppImage; confirm the replaced app starts and is the new version.
6. **A tampered feed is refused.** Edit `latest.json` (or swap an artifact) so the signature no
   longer matches; the download must fail with a signature error and the old app keeps running.
   This is what the tests assert against the local feed; here confirm the real feed's error reaches
   the banner's text.
7. **No update, no noise.** Re-check after the update is applied: no banner, and a channel with
   `latest.json` absent (or HTTP 204) reports "no update" rather than an error.
8. **Rollback stays possible.** Confirm the previous release's artifacts are still on the feed or in
   the release storage before deleting anything; the updater never downgrades on its own, but a
   broken release must be replaceable by re-pointing the manifest at the previous artifacts.

## Verifying the webview's seams (dev pane)

What code review cannot prove -- what the webview actually offers, what the OS does with a
notification, where an update round trip reaches -- has a pane, and the pane exists only in a
dev build inside the desktop shell (`web/src/lib/desktopDev.ts`): a release build never ships
it. Run `MW_DESKTOP_BASE_URL=... pnpm tauri dev`, sign in, open Settings -> Desktop diagnostics:

1. **Capability flags.** The readout is the gating's own answer, not a restatement of it. Expect,
   in the webview: "Passkeys offered: no" (the origin is not the rpId passkeys are bound to --
   this is the check that must hold), the dictation engine the composer will really use
   (`server` where the deployment advertises a transcriber; `none` means no control renders),
   and the webview origin the RP-ID check is made against.
2. **Send a test notification.** The button ignores focus on purpose (the real notification only
   fires when the window is unfocused). Shown: the OS plumbing works. Nothing appears: look at
   the OS's notification settings for the app, not at the app. The pane reports an OS refusal
   verbatim.
3. **Updater round trip.** "Check for updates now" runs a check and logs every stage the native side
    announces (`checking` → `downloading` → `verified` → `installing`, `update-stage` events);
    when the feed offers a newer version the pane offers "Install X now", and pressing it walks
    the same stages with percentages, then "Signature verified.", then the OS installer. A build
    without `MW_DESKTOP_UPDATER=1` answers the check with nothing and logs no stages -- that
    quiet "off" is itself worth confirming once.

The updater's install-and-relaunch pass with real signed artifacts is the release QA checklist
above; this pane is how you watch the stages of that pass from inside the app.

## Agent mode (experimental, off by default)

> **Not released, and off by default.** Agent mode is the desktop's half of T-1501 (coding clients
> parity), its P2 item "a native Rust tool host behind new, narrowly allow-listed Tauri commands".
> T-1501 gates that item on T-406, the agent and tool-use security gate, and **T-406 has not
> signed off on local tools.** The code ships switched off behind a setting; whether the setting
> is offered in a release is the owner's decision once T-406 has recorded one. Nothing below runs
> until a person turns it on.

**What it is.** The model works in one folder on this machine through the shared agent tool
contract (`read_file`, `list_dir`, `glob`, `grep`, `edit`, `write_file`, `run_shell`). The loop
runs in the SPA (`web/src/apps/agent/loop.ts`): it calls `/v1/chat/completions` with the tools the
mode offers, `/v1` hands the model's `tool_calls` back unexecuted, the native host runs them, and
the results go back as `role: "tool"` messages until the model answers without a call. The server
keeps metering, the budget, the model allow-list and moderation, and never sees the filesystem.
Each session's first run creates a conversation ("Agent: ...") and every request carries
`metadata.conversation_id`, so the run is in the sidebar and on the web. The API's
`agent-tools-api` branch stores the tool rounds too (`tool_call` / `tool_result` parts), reading
them from the shape the loop sends: the assistant message with its `tool_calls`, then one
`role: "tool"` message per call with the matching `tool_call_id`, in order (`loop.test.ts`
checks the shape). Calls a Stop left unanswered are answered "Not run" in the next run's history
but not stored, since that request ends on the user's message.

**Turning it on.** Settings -> Preferences -> "Agent mode (experimental)". The desktop app asks
for confirmation in a **native** dialog, which the webview cannot answer for the person; the
switch is persisted natively (`agent.json` in the app's config directory) and every agent command
refuses while it is off. Turning it off stops every run at once and forgets the folder.

**Using it.** On a new chat, the **Agent** toggle (beside Temporary) swaps the thread for the agent
panel. It is greyed out, with the reason, when `/api/me` says `local_agent_tools: false` (the
org's switch) or `/api/models` says the picked model has `supports_tools: false`; a flag the API
does not send counts as allowed. Then:

1. **Choose folder** opens the OS folder picker. The webview never names a path to work in; the
   native side takes the picked folder, resolves its links and refuses a drive root or the whole
   home folder. The folder is per app session.
2. **Pick a mode** (Shift+Tab cycles plan, ask and auto-edit; `/approval-mode <mode>` sets any).
   A run keeps the mode it started in, so the picker is locked while one runs:

   | Mode | Reads and searches | `edit`, `write_file` | `run_shell` |
   |---|---|---|---|
   | `plan` | yes | never offered to the model | never offered |
   | `ask` (default) | yes | diff in the panel, then **the desktop app's dialog** | **the desktop app's dialog**, command shown whole |
   | `auto-edit` | yes | applied, diff in the transcript; `MATTERWAVE.md`, `AGENTS.md` and `MATTERWAVE.local.md` still ask natively | **the desktop app's dialog** |
   | `yolo` | yes | applied | runs |

   `auto-edit` and `yolo` are each allowed in a native dialog the first time a run uses them for
   the folder in an app session (a new folder asks again); `yolo` is never remembered, the other
   modes are remembered on this device. A no, in the panel or in the dialog, reaches the model as
   an answer ("do not send the same change again"), not as an error.
3. **Send.** `@path` attaches a file (read through the host, so the deny list applies).
   `/restore` lists checkpoints and `/restore <id>` puts files back; `/init` asks the agent to
   draft a `MATTERWAVE.md`, through the same approvals; `/help` lists them.

**Stop** aborts the request to `/v1` and stops the run in the host, which kills a running command
and everything it started. A run also ends at its **step cap** (25 model calls by default) or its
**token cap** (200,000 tokens of `usage.total_tokens` by default), both adjustable in the panel, or
on a **402** (the chat's budget copy) or **429** (a rate-limit copy), with the request id.

**Context files.** A folder's `MATTERWAVE.md`, `AGENTS.md` and `MATTERWAVE.local.md` (a personal
override, kept out of git by its owner) are added to the system prompt only when the folder is
**trusted**: "Trust folder" in the panel asks natively and remembers the folder. In an untrusted
folder they are named in a notice and not sent. A cloned repository can put anything in them.

### The native tool host (`src-tauri/src/agent`)

The webview gets one command per tool (`agent_read_file`, `agent_list_dir`, `agent_glob`,
`agent_grep`, `agent_edit`, `agent_write_file`, `agent_run_shell`) plus `agent_state`,
`agent_set_enabled`, `agent_pick_root`, `agent_trust_root`, `agent_start_run`, `agent_stop_run`,
`agent_checkpoints` and `agent_restore`, each in `build.rs` and the capability file by name; a test
holds the three lists together, checks that no plugin permission (nothing with a `:`) is granted,
and that only the `main` window's bundled pages get them (no `remote` origin). The folder picker
and the confirmations use `rfd` (the crate the dialog plugin wraps) from Rust only.

- **Native approval** (`approval.rs`): the host, not the webview, asks the person, in an OS dialog
  the webview cannot answer, before every `run_shell` in `ask` and `auto-edit`, every applied
  write in `ask`, a write to a context file in `auto-edit`, starting `auto-edit` or `yolo`, turning
  agent mode on, trusting a folder and every `/restore`. The question is raised from inside the
  command, so script in the webview that calls `agent_run_shell` or `agent_edit` directly meets it
  too. A command is shown whole, with the folder it runs in and its timeout; one too long to show
  whole (2,000 characters or 40 lines) is refused with a hint to put it in a script file, never
  shortened. A write is shown with its full path and its changed lines (30 at most, with how many
  more), and after the yes the change is computed again and written only if the file is still byte
  for byte what the dialog showed. Control, bidirectional, zero-width and tag characters are shown
  as `<U+XXXX>`, so the command read is the command run. Cancel is the default button (Enter,
  Space and Escape answer no), one question is on screen at a time, and Stop answers an open
  question no (the dialog stays until it is clicked; its answer is dropped). The panel's diff is
  for reading: its **Apply…** only leads to the dialog.

- **Confinement** (`confine.rs`, a port of the SDKs' `confine`): every path the webview sends is
  resolved here. A `..` segment is refused outright; an absolute path only when it lies under the
  root; links (symbolic links, and junctions on Windows) are followed and must still lead under
  the root; the deny list (`.env*`, `*.pem`, `id_*`, `.git/`, plus the folder's
  `.matterwaveignore`) refuses reads as well as writes, matched case-insensitively and against
  where links (and Windows 8.3 short names) lead as well as the name given; `.matterwaveignore`
  itself can be read but not written. On Windows a path is also refused when a part of it names
  an alternate data stream (`a.txt:s`, `x::$DATA`), a device (`NUL`, `con.txt`, `COM1`) or ends in
  a dot or a space, each a way for the path approved to differ from the one touched; verbatim,
  device and UNC spellings (`\\?\`, `\\.\`, `\\host\share`) are outside the root. Search
  (`list_dir`, `glob`, `grep`) also skips what `.gitignore` and `.matterwaveignore` ignore, never
  enters a denied directory, and confines each link it meets. Reads stop at 16 MiB, checked on the
  handle that is read, and only regular files are read (a FIFO would block for ever).
- **Modes**: a run's mode is fixed when it starts, and the host refuses every tool the mode does
  not offer, so `plan` is read-only whatever the webview sends.
- **Writes** are two steps: a preview (the file before and after, which the SPA turns into the
  unified diff) and an apply, which must name the preview by its fingerprint, recomputes the change
  and refuses if the file's bytes are not the ones the preview saw, so what lands is what was
  shown. The file is written beside its target and renamed over it, so a hard link to a file
  outside the root is replaced rather than written through, a link swapped in after the check is
  replaced rather than followed, and the folder is checked once more just before the rename.
  Before every apply the file is
  **checkpointed** in the app's data directory, outside the project (`checkpoints.rs`); a write
  without a checkpoint does not happen. `/restore <id>` undoes that checkpoint and every later
  one, and never touches the project's `.git`. Changes made by `run_shell` are not checkpointed.
- **`run_shell`** (`shell.rs`) runs the contract's shell (`powershell.exe -NoLogo -NoProfile
  -NonInteractive -Command` on Windows, `/bin/sh -c` elsewhere) in the root, with a timeout
  (`timeout_s`, default 120, at most 600) and stdout and stderr together, cut at 64 KiB. The
  command runs in a **job object** (Windows, kill-on-close) or its own **process group** (Unix),
  and Stop or the timeout kills the whole tree; so does the command's own exit, so nothing it left
  in the background outlives the call. On Windows the shell is created suspended and joins its job
  before its first instruction. The command inherits the person's environment minus any
  MatterWave credential in it (`MATTERWAVE_*` / `MW_*` keys, tokens, secrets, passwords); the app's
  own sign-in is in the OS keychain, never in the environment.

**Where each control lives**, for the security review: the enable switch, the folder, folder
trust, the modes and what each lets through, **the approval of every command and every write that
asks**, confinement, the deny list, the checkpoints and the process-tree kill are all enforced in
Rust; nothing the webview does can approve on the person's behalf. What script in the webview
still can do: start runs in `plan` or `ask`, read and search the root (reads are never asked
about, in any mode), and, once the person has allowed `auto-edit` or `yolo` for the folder this
session, write (or, in `yolo`, run) as those modes let the model. The page's CSP (no remote
script, no inline script but the one hashed boot script) is what keeps the model's output from
being script; its `connect-src` still allows any `https:` origin, so script that did run could
send what it read anywhere.

**Known limits.** Confinement is not a sandbox: an approved command can reach anything the user
can, including the keychain that holds the app's own sign-in. The deny list is a floor, not a
guarantee; everything the agent reads goes to MatterWave and the model's provider. A hard link in
the root to a file outside it is read like any file (writes replace it instead). A process the
command has another service start (WMI `Win32_Process.Create`, the task scheduler, `-Verb RunAs`,
Explorer) is outside the job and outlives Stop; on Unix so does one that calls `setsid`. A native
dialog cannot be closed from code, so after Stop it stays until clicked. The native dialogs
follow the dialog plugin's threading (the GTK main thread on Linux) but have only been exercised
on Windows, and the Unix-only code paths (process group, FIFO check) are compiled and tested only
by CI on Linux and macOS.

**The contract.** `src-tauri/agent/contract.json` and `conformance.json` are byte-for-byte copies
of the Python SDK's `contract.json` and `tests/agent_conformance.json`, the one source both SDKs
are generated from. `contract.rs` restates the tools, modes, deny list, limits and messages, and
its tests fail when the copy and the code disagree; with `MATTERWAVE_AGENT_CONTRACT` naming the
Python SDK's file they also check the copy against it. The SPA's copy of the TypeScript SDK's
browser-safe agent helpers (`web/src/apps/agent/sdk/`) is tested against the same two files
(`sdk.test.ts`). To take a new contract version: copy both JSON files, copy the four TypeScript
files from the SDK's `src/agent/`, and fix what the tests name.

**Tests.** `cargo test agent` (confinement: `..`, absolute outside, a link out -- a junction where
a symbolic link needs privileges -- and `.env`; the shared deny, edit and confinement cases; and
the attacks, each named in its test: `.ENV` and other cases, 8.3 short names, `\\?\`, `\\.\` and
UNC spellings, alternate data streams, device names, trailing dots and spaces, a folder swapped
for a junction between preview and apply, a hard link out, grep/glob/list through a link out,
huge and binary files, an apply with no preview, every command while agent mode is off, a
MatterWave key in the app's environment. The native gate with a scripted person: a write and a
command each land only after a yes that shows the path or the command whole, a no leaves the file
byte-identical, a change on disk while the question is open is not written over, Stop while it is
open runs nothing, questions never overlap, hidden characters are shown, an over-long command is
refused, and `auto-edit` / `yolo` / enable / trust / restore each ask. Also checkpoints and
restore with the project's `.git` HEAD and index unchanged, the capability list, and Stop ending
`sleep 60` and the child it started within 2 s). In `web/`: `pnpm vitest run src/apps/agent`
(plan sends only the read tools; a rejected diff leaves the file byte-identical; where the
desktop's dialog asks in each mode; tool results, their stored shape and
`metadata.conversation_id` on the wire; the step and token caps; the 402 and 429 copy; Stop;
`@path`; the panel, its locked mode, the toggle and the Preferences switch).

## Offline: no send queue

A message is **never queued for later sending**. Offline, Send is disabled and the draft is kept;
a turn that was streaming when the link dropped resumes on reconnect. A prompt sent minutes later
lands in a thread whose context has moved and bills while the person is not watching. This is a
product rule; do not add a queue.

## Reporting a problem

Include:

- **The app version**: `await __TAURI_INTERNALS__.invoke("app_info")` in the devtools console (debug builds), or the installer's file name; it matches the API's `MW_RELEASE`.
- **The request id** shown with the error (`X-Request-Id`), if there was one.
- The OS and version, and whether sign-in went through the deep link or the loopback page
  ("Signed in. You can close this tab").

Never paste tokens: the keychain entries (`dev.matterwave.desktop`, `access` / `refresh` /
`api-key` / `device-key` / `device-pairing`) are credentials.
