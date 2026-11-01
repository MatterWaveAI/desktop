# Changelog

All notable changes to the MatterWave desktop app are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version here is the app's own (`package.json`, `tauri.conf.json` and
the API's `MW_RELEASE` all report it).

## [Unreleased]

### Changed

- **The bundled SPA is the platform's develop again** (platform commit
  `518e2a8`): the localised interface (en-GB, en-US, es-ES), the
  compaction fixes, Get help, the answer-ready signals, the terms notice,
  webhooks and the admin disputes view, with the desktop's own changes
  re-applied on top.
- **Re-syncing the SPA is one command** (`pnpm spa:pull`,
  `scripts/spa-sync.mjs`): `spa/upstream.json` names the platform commit
  `web/` is synced to, `spa/patches/` holds the desktop's changes one file
  at a time, and CI fails when `web/` is anything other than that commit
  plus those patches (`pnpm spa:check`).

- **Releases cover every desktop target and sign what the secrets
  allow**: Windows arm64 (NSIS), macOS universal (Apple silicon and Intel
  in one app) and Linux arm64 join the x64 builds; the rpm nobody
  installed is gone. With a code-signing certificate the Windows binaries
  and installers are Authenticode-signed and timestamped; with an Apple
  Developer ID the macOS app is signed under the hardened runtime and,
  with the notarization credentials, notarized. Each signing group is all
  or nothing, and a missing group builds unsigned with a warning.
- **A release is published only after every packaged app has started**:
  the installers go to a draft release, each is installed or opened once
  and must still be running after 20 s
  (`scripts/smoke-packaged-app.mjs`), and only then is the release made
  public and the updater feed laid out. CI's packaged build on Windows,
  macOS and Linux now gates too, with the same start.

### Security

- **The packaged app's CSP names the one host it talks to**: `connect-src`
  allowed any https host, so injected script could send data anywhere.
  `scripts/release-config.mjs` now rewrites it to the page itself, the IPC
  bridge and the origin of `MW_DESKTOP_BASE_URL`, which a release must
  set (https, or http on loopback).
- **Supply chain**: every action in the workflows runs at a commit SHA
  rather than a movable tag, the workflows' token is read-only unless a
  job needs more (only the release's build and publish jobs write), a
  `gitleaks` job and pre-commit hook refuse committed secrets
  (`.gitleaks.toml` allows the tests' made-up ones), and Dependabot opens
  weekly grouped updates for the tooling, the crates and the actions --
  not for `web/`, whose dependencies come with the platform's SPA.

### Fixed

- **GitHub runs the CI workflow again**: the Rust job read `runner.temp`
  in its job-level `env`, where the runner context does not exist, so
  GitHub rejected the whole file before any job started. The target
  directory is now set from a step, clippy fails on warnings as it does
  locally, and a test (`scripts/workflows.test.mjs`) checks every
  workflow's expressions against the contexts GitHub provides where they
  appear.
- **Update and stage events reach the SPA**: the window's capability now
  allows the event plugin's listen and unlisten, which it never did, so
  every `update-available`, download-progress and `update-stage` event was
  refused and the refusal swallowed. Unlisten now sends what the plugin
  expects (the event and its id), a refused listen is logged, and a test
  checks every bridge call in `web/src` against the capability file.
- **The global hotkey summons in one press**: it hid a window that was
  visible but not focused -- behind other windows, or minimized -- so
  bringing the app up took two presses, and it could not put away the
  window the person was looking at. Now a focused window is hidden and any
  other is shown, unminimized and focused (`src-tauri/src/summon.rs`).
  The tray's Show/Hide becomes Show, which always brings the window
  forward: opening the tray menu takes focus from the window, so a toggle
  there could not tell in front from behind. A deep link, a finished
  sign-in or a second launch now also shows a window the hotkey hid.
- **Dropping a file on the window reaches the page**: Tauri took the OS
  drop for itself (`dragDropEnabled` defaults to on), so the composer's
  drop-to-attach and Settings → Data's drop-to-import never fired. The
  window now leaves drops to the webview.
- **`matterwave://` links open what they name**: the native side emitted
  every link other than the sign-in callback as an event nothing listened
  to, and never read the link that launched the app. Conversation
  (`matterwave://conversation/<id>`, optionally `?m=<message>`) and share
  (`matterwave://share/<token>`) links are now parsed against an
  allow-list (`src-tauri/src/navigation.rs`), kept until the SPA takes
  them and routed there (`web/src/lib/desktopNavigation.ts`), warm or
  cold; anything else opens nothing.
- **Links out of the app open in the system browser**: `open_external`
  had no caller, so a reply's links and every other `target="_blank"`
  link opened inside the webview, without an address bar or the person's
  browser sessions. One document-level listener
  (`web/src/lib/desktopLinks.ts`) now sends any http(s) or mailto link
  that leaves the app's origin to the browser, after the page's own
  handlers have had their say.
- **Dictation can ask for the microphone on macOS**: the bundle had no
  `NSMicrophoneUsageDescription` and no audio-input entitlement, so
  WKWebView refused `getUserMedia` before macOS ever asked the person.
  `src-tauri/Info.plist` now says why the app wants the microphone, and
  the hardened-runtime bundle carries
  `com.apple.security.device.audio-input` (`src-tauri/Entitlements.plist`).
- **Upgrading from the desktop app no longer strands the person in the
  webview**: Checkout and the billing portal replaced the app with
  Stripe's page, and Stripe returned to the web origin, where the webview
  has no session. Both now open in the system browser
  (`web/src/lib/desktopBilling.ts`); the plans page and the billing pane
  say so and read the billing status again whenever the window is focused,
  and `matterwave://billing/return` opens Settings → Billing.

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
  included. The same checks passed locally; on GitHub the workflow file
  itself was refused (see Unreleased, Fixed). The tauri build matrix stays
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
