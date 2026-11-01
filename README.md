# MatterWave desktop

The web app (`web/`, bundled in this repo) in a native window, built with Tauri 2. The SPA is
bundled, not loaded from the server; the native side adds what a browser tab cannot: a sign-in
that survives restarts with the tokens in the OS keychain (or an API key in its place, for
machines nobody sits at), deep links (`matterwave://`), an OS notification when a reply lands
while the window is unfocused, an app menu and a tray with New Chat and the recent chats, a
switch to start at login, an update check and install the
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

Once per clone, `pre-commit install` (with [pre-commit](https://pre-commit.com)): gitleaks then
checks each commit's staged changes, with the rules CI runs (`.gitleaks.toml`).

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
127.0.0.1 with a closure standing in for the browser, the hotkey's toggle decision, the
`matterwave://` allow-list, the committed bundle config -- `src-tauri/tests/bundle_config.rs` --
and the updater's check and download against a local feed whose artifact is signed with a test
key, `src-tauri/tests/updater_local.rs`). The SPA side, `pnpm --dir web vitest run`: the platform's
suite plus the desktop's own -- the bearer path, the bridge calls against the capability file, links
in and out of the app, Stripe in the browser (`src/lib/desktop*.test.ts*`), the update banner
(`src/shell/UpdateBanner.test.tsx`) and the desktop sections of the settings panes. The repository
scripts, `pnpm test:scripts`: the SPA sync, the release config and gate, the workflow files, and
the scan for ticket ids.

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
`.app`/DMG on macOS, AppImage and `.deb` on Linux; no rpm). The macOS bundle merges
`src-tauri/Info.plist` (the microphone usage description WKWebView requires before dictation may
ask) and signs with `src-tauri/Entitlements.plist` (audio input under the hardened runtime).
`node scripts/smoke-packaged-app.mjs --bundle-dir <bundle dir>` installs (Windows, silently, into a
temporary directory) or opens the packaged app and fails unless it is still running after 20 s;
CI runs it on every OS.

The release job (`.github/workflows/release.yml`, on a `v*` tag) first refuses a tag that
`package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` do not all carry, or that
`CHANGELOG.md` has no section for (`node scripts/release-check.mjs --tag vX.Y.Z` runs the same check
locally); that section is the release's notes, and a CycloneDX SBOM of the crates and packages
the app is built from is attached beside the installers. It builds Windows x64 (MSI, NSIS)
and arm64 (NSIS), macOS universal (app bundle, DMG) and Linux x64 and arm64 (AppImage, `.deb`),
each into a draft release; every packaged app is started once, and only then is the release
published and the updater feed laid out. Signing follows the secrets, each group all or nothing:
the updater key signs the update artifacts, a Windows code-signing certificate
(`WINDOWS_CERTIFICATE`, its password and the `MW_WINDOWS_TIMESTAMP_URL` variable) signs the
Windows binaries and installers with Authenticode, and an Apple Developer ID certificate
(`APPLE_CERTIFICATE`, its password, `APPLE_SIGNING_IDENTITY`) signs the macOS app under the
hardened runtime, notarized and stapled when `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are
set too. A group left out builds unsigned for that platform, with a warning in the run; the full
table is at the top of the workflow.

### The bundled SPA

`web/` is the platform's SPA at one named commit plus this app's own changes to it, and nothing
else. `spa/upstream.json` names the commit (and a digest of its SPA as copied: the platform's
`web/` without its Playwright suites, its build cache and `index.html`); `spa/patches/` holds one
patch per file the desktop changes or adds, at the file's own path. `web/index.html` is the
desktop's own: the CSP allows its inline theme script by hash, so the two change together (a test
in `src-tauri/tests/bundle_config.rs` holds them to each other). `pnpm spa:check` proves the two agree --
`web/` minus the patches is exactly that commit, and the patches give `web/` back -- and CI runs
it, so an edit to `web/` that skipped the patches fails the build.

`spa/adapted.json` is the list of files the desktop is allowed to differ in, each with the reason
(a pattern such as `src/lib/desktopLinks.*` covers a module and its test). `pnpm spa:drift`
(`scripts/web-drift.mjs`) lists every file in `web/` that differs from the pinned commit -- `M`
changed, `A` only the desktop has it, `D` only the platform does -- with the listed ones apart,
and fails on any other. CI runs it after `spa:check`: a patch is not permission, so a platform
change ported by hand, or an edit to a file the desktop should copy unchanged, fails even after
`spa:refresh` wrote a patch for it. Neither check needs the platform's repository; the pin and
the patches are the record of what the commit holds.

```
pnpm spa:drift                                                  # web/ against the pin (CI)
pnpm spa:drift --source ../matterwave-app --ref origin/develop  # against a newer platform commit
pnpm spa:drift --upstream ../matterwave-app/web                 # against a working tree, uncommitted edits too
pnpm spa:pull --source ../matterwave-app --ref origin/develop   # re-sync to the platform
pnpm spa:refresh                                                # after editing web/ here
```

#### Porting the platform's changes

A platform change reaches the desktop by copying, never by re-implementing it here:

1. **Measure.** `pnpm spa:drift --source ../matterwave-app --ref <commit>` names what the
   platform changed since the pin (`M`/`D` lines outside the adapted list) and which adapted
   files it touched.
2. **Pull.** `pnpm spa:pull --source ../matterwave-app --ref <commit>` copies the platform's
   `web/` at that commit, replays the desktop's changes onto it with a three-way merge, and
   rewrites `spa/upstream.json` and `spa/patches/`. A change that collides with the platform's
   stays in `web/` with conflict markers and the command fails, naming the files: resolve them
   (usually keeping both sides: the platform's change and the desktop's adaptation), then
   `pnpm spa:refresh --source ../matterwave-app`.
3. **Check.** `pnpm spa:drift` reports no drift; then in `web/`: `pnpm install --frozen-lockfile`,
   `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm vitest run`, `pnpm i18n:check` and `pnpm build`.
   If the platform changed `web/package.json`, its lockfile came with it; the desktop's own
   dependencies (the Tauri CLI) live in the root `package.json`, not in `web/`.
4. **Commit** `web/` and `spa/` together, naming the platform commit in the message.

When the desktop has to behave differently, prefer a desktop-only file -- a module under
`src/lib/desktop*.ts`, a `*.desktop.test.ts(x)` beside the platform's test -- reached through the
hooks the platform already has: `src/lib/desktopAuth.ts` (`isDesktop()` and the bridge) and the
chat adapter's hooks (`onDone` in `ChatPage.tsx`). An edit to a platform file is the last
resort; list it in `spa/adapted.json` with the reason, then `pnpm spa:refresh`. Strings the
desktop adds stay plain English rather than `msg`/`Trans` macros, so the platform's catalogues
need no desktop entries and `lingui extract` stays clean.

In the bundled app the page's origin is the webview's (`tauri://localhost`, or
`http://tauri.localhost` on Windows), so API calls are sent to `MW_DESKTOP_BASE_URL` with a
bearer and no cookie. The API allows both origins for CORS exactly when its
`MW_OIDC_NATIVE_CLIENT_ID` is set (`api/matterwave/config.py`), so a deployment without the
native client refuses the webview rather than half-working.

## Sign-in

1. The SPA's `/login` page, inside the shell, offers "Sign in with your browser" and calls
   `sign_in` (`web/src/shell/LoginPage.tsx`); it never starts the browser redirect the web app
   uses, because the webview has no cookie jar for that callback to fill. The native side reads
   `/api/auth-config` for the native client (`native_client_id`, `authorization_endpoint`,
   `token_endpoint`).
2. It makes a PKCE verifier and a `state`, and opens the authorize URL in the **system browser**
   (never an embedded page: password managers and passkeys live there).
3. The identity provider redirects to `matterwave://auth/callback`. The deep-link plugin hands the URL to the
   running app (a second launch on Windows and Linux is folded into the first by the
   single-instance plugin). Where the scheme is not registered (a dev build on macOS, a Linux
   desktop without the `.desktop` entry), the redirect is `http://127.0.0.1:<port>/callback`
   instead, served once by a listener bound to loopback only. Both redirects are registered on
   the native client the gateway play provisions (`matterwave-desktop`; matterwave-infra,
   `ansible/roles/zitadel/tasks/provision_gateway_app.yml`): the scheme as is, and the loopback as
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
links in the system browser and refuses any other scheme, and every link out of the app goes
through it: one document-level click listener (`web/src/lib/desktopLinks.ts`) hands any `<a>`
whose URL leaves the app's own origin -- a reply's links, the help page's, the footer's -- to the
system browser instead of the webview.

### An API key instead of the browser

Settings -> Account ("Desktop app") takes a platform API key (`mw_<id>_<secret>`, the API keys
pane makes one) as this machine's credential, for CI boxes and shared workstations where a
browser dance has nobody to dance. `set_api_key` (`src-tauri/src/lib.rs`) validates the shape
(`api_key.rs`) before the key reaches the keychain as its own `api-key` entry; from then on
`get_access_token` answers with the key and every request carries it as the bearer, no OIDC
tokens involved. Only the id half is shown again (`api_key_state`). Removing the key falls back
to the browser session -- which stays signed in underneath -- while `sign_out` clears key and
tokens together. OIDC stays the default: a completed browser sign-in supersedes a stored key.

Passkeys are made in the browser, not in the window: a passkey is bound to the platform's origin and
the webview's is the app's own. Settings → Account lists, renames and removes them as on the web,
and its "Add a passkey in your browser" opens that pane of the web app (`MW_DESKTOP_BASE_URL` +
`/settings/account`) in the system browser. A passkey added there also serves the app, whose
sign-in runs in the browser.

The webview may call only the app's own commands and the event plugin's listen and unlisten
(`src-tauri/capabilities/default.json`, one `allow-<command>` per command declared in
`src-tauri/build.rs`); no filesystem, shell or HTTP plugin is exposed to it. The page runs under a restrictive CSP
(`tauri.conf.json`): no remote script (one hash, for the theme boot script inlined to avoid a
flash), `wasm-unsafe-eval` for the syntax highlighter, and network access only to the page's own
origin and the IPC bridge plus, in the committed config, any https host. A release narrows that
last part to the API: `scripts/release-config.mjs` rewrites `connect-src` to the origin of
`MW_DESKTOP_BASE_URL` and nothing else, so script injected into the packaged app cannot reach any
other host. The webview never talks to the identity provider (sign-in and refresh are native), so
the issuer is not on the list.

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

## Links into the app

`matterwave://conversation/<id>` (optionally `?m=<message id>`) opens that conversation,
`matterwave://share/<token>` opens a shared one and `matterwave://billing/return` opens Settings →
Billing, whether the app is running or the link is what starts it. The native side parses the link against that allow-list (`src-tauri/src/navigation.rs`;
anything else opens nothing, not even the window), keeps the target until the SPA takes it, and
announces it as the `navigate` event; the SPA takes it on start-up and on every event and routes
it itself (`web/src/lib/desktopNavigation.ts`). A link that needs a session while signed out is
remembered by the front door and opened after sign-in, as in the browser.
`matterwave://auth/callback` is the sign-in's own and never reaches the SPA.

### Billing

Stripe Checkout and the customer portal open in the system browser, not in the webview
(`web/src/lib/desktopBilling.ts`): inside the webview they would replace the app, and Stripe
returns to the web origin, where the webview has no session. The plans page and the billing pane
say the payment is open in the browser and read `/api/billing/status` again each time the window
comes back to the front, so the new plan shows as soon as Stripe has confirmed it. Stripe's return
URL is the platform's, so it still lands on the web app in the browser; `matterwave://billing/return`
is ready for a platform that sends desktop buyers back to the app.

## Notifications

One OS notification, and one case for it: a generation finished while the window was not
focused. The SPA tells the native side when a stream ends in `done` (the chat adapter's `onDone`
hook in `web/src/apps/chat/ChatPage.tsx`); the native side checks focus and shows the notification
only when the window is unfocused (`notify_generation_complete` in `src-tauri/src/lib.rs`) --
a focused window already shows the reply land. The copy is fixed ("Your reply is ready.");
reply text never goes into a notification, only the conversation's id, so clicking it brings the
window forward on that conversation (the plugin reports the click; on Windows only while the
toast is on screen, not from the Action Center). An error or a cancellation sends none: the
in-app notices cover those when the person comes back.

## Menus, tray and start at login

The window has a menu (`src-tauri/src/menu.rs`): New Chat (`Ctrl+N`, `Cmd+N` on macOS),
Settings (`Ctrl+,`), Check for Updates (off in a build without the updater; with it, a newer
version brings up the banner and "up to date" or a failed check is said in a notification), the
standard Edit items, full screen and Minimize -- on macOS under the usual app, File, Edit, View and
Window menus, on Windows and Linux in the window's menu bar with Settings and Quit under File.
`Ctrl` (`Cmd`) with `+`, `-` and `0` zoom the page. The tray's menu, on left click too, is Show,
New Chat, the three conversations the sidebar lists first (ids and titles only, handed over by
the SPA) and Quit. Every item that acts on the page is a navigation request, the same path links
take ("Links into the app"). Preferences (desktop only) has "Open MatterWave at login", the
operating system's own login item (`tauri-plugin-autostart`: a Launch Agent on macOS, the `Run`
key on Windows, an autostart entry on Linux).

## Global hotkey

`Ctrl+Shift+M` by default (the plugin's `CommandOrControl+Shift+M`, so a Mac gets `Cmd+Shift+M`):
a quick-summon that toggles the window from anywhere: one press puts a focused window away, and
one press brings it forward from any other state -- hidden, minimized or behind other windows
(`src-tauri/src/summon.rs`, `src-tauri/src/hotkey.rs`, the `tauri-plugin-global-shortcut`
plugin). The tray's Show always brings the window forward. The chord is
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
| `MW_DESKTOP_BASE_URL` | The API; required. Its origin is the only host the page's CSP may connect to. |
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

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
