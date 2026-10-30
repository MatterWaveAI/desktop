# Changelog

All notable changes to the MatterWave desktop app are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version here is the app's own (`package.json`, `tauri.conf.json` and
the API's `MW_RELEASE` all report it).

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

## [Unreleased]

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

[Unreleased]: https://github.com/MatterWaveAI/desktop/compare/v0.2.1...HEAD
[0.2.2]: https://github.com/MatterWaveAI/desktop/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MatterWaveAI/desktop/releases/tag/v0.2.1
