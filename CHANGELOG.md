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

[Unreleased]: https://github.com/MatterWaveAI/desktop/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/MatterWaveAI/desktop/releases/tag/v0.2.1
