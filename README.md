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
key's shape checks, the updater's build flag, the whole sign-in flow -- discovery,
authorize URL, loopback callback, PKCE exchange, refresh, revoke -- against a fake issuer on
127.0.0.1 with a closure standing in for the browser, and the updater's check and download against
a local feed whose artifact is signed with a test key, `src-tauri/tests/updater_local.rs`). The SPA
side, inside `web/`:
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
somewhere else works: `CARGO_TARGET_DIR=<an allowed path> cargo test`.

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

The webview may call only the app's own twelve commands (`src-tauri/capabilities/default.json`);
no filesystem, shell or HTTP plugin is exposed to it. The page runs under a restrictive CSP
(`tauri.conf.json`): no remote script (one hash, for the theme boot script inlined to avoid a
flash), `wasm-unsafe-eval` for the syntax highlighter, and network access only to the page's own
origin plus https for the API.

## Notifications

One OS notification, and one case for it: a generation finished while the window was not
focused. The SPA tells the native side when a stream ends in `done`
(`web/src/apps/chat/chatAdapter.ts`); the native side checks focus and shows the notification
only when the window is unfocused (`notify_generation_complete` in `src-tauri/src/lib.rs`) --
a focused window already shows the reply land. The copy is fixed ("Your reply is ready.");
reply text never goes into a notification. Clicking it does nothing (no notification actions
are wired), and an error or a cancellation sends none: the in-app notices cover those when the
person comes back.

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
`api-key`) are
credentials.
