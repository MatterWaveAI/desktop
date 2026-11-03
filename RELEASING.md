# Releasing MatterWave Desktop

Day-to-day development lands on `develop`. Shipping a desktop release (`vX.Y.Z`) happens on `main`, and `.github/workflows/release.yml` enforces that every release tag points to a commit on `origin/main` before building or publishing installers.

## 1. Pre-flight on `develop`

Before preparing a release, confirm the SPA pin/patches and repository checks are clean on `develop`:

```bash
pnpm spa:check
pnpm spa:drift
pnpm test:scripts
pnpm --dir web vitest run
cd src-tauri && cargo test
```

## 2. Bump the Version and Update `CHANGELOG.md`

Every release version `X.Y.Z` must match across all three manifests and have a non-empty section in `CHANGELOG.md`:

1. **`package.json`**: set `"version": "X.Y.Z"`.
2. **`src-tauri/Cargo.toml`**: set `version = "X.Y.Z"` under `[package]` (and refresh `src-tauri/Cargo.lock` via `cargo check --manifest-path src-tauri/Cargo.toml`).
3. **`src-tauri/tauri.conf.json`**: set `"version": "X.Y.Z"`.
4. **`CHANGELOG.md`**: move the release's entries from `## [Unreleased]` into a dated `## [X.Y.Z] - YYYY-MM-DD` section immediately below `## [Unreleased]`. This section becomes the GitHub Release notes.

Verify locally with the release gate script:

```bash
node scripts/release-check.mjs --tag vX.Y.Z
```

Commit the version bump and changelog update on `develop` and push to `origin/develop`.

## 3. Merge `develop` into `main`

Wait for `.github/workflows/ci.yml` to pass on `develop`, then merge `develop` into `main`:

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff origin/develop -m "Release vX.Y.Z"
git push origin main
```

## 4. Tag `vX.Y.Z` on `main`

Cut the annotated or lightweight `vX.Y.Z` tag directly from `main` after pushing `main`:

```bash
git checkout main
git merge-base --is-ancestor HEAD origin/main
git tag vX.Y.Z
git push origin vX.Y.Z
```

> **Release branch guard:** `.github/workflows/release.yml` checks out with `fetch-depth: 0`, fetches `origin main`, and verifies `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` in the `prepare` job. A tag pushed from `develop` or a feature branch that is not on `origin/main` is rejected before any installer is built.

## 5. Verify the Installer Release and Updater Feed

Pushing `vX.Y.Z` triggers `.github/workflows/release.yml`:

1. **`prepare`**: verifies `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` and runs `node scripts/release-check.mjs --tag "$GITHUB_REF_NAME"` to validate `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `CHANGELOG.md`.
2. **`build`**: builds and signs installers across all desktop targets into a draft GitHub Release and smoke-tests each packaged app (`scripts/smoke-packaged-app.mjs`):
   - Windows `x64` (`.msi`, `-setup.exe` NSIS) and `arm64` (`-setup.exe` NSIS)
   - macOS universal (`aarch64` + `x86_64` `.app.tar.gz` and `.dmg`)
   - Linux `x64` and `arm64` (`.AppImage` and `.deb`)
3. **`sbom`**: generates the CycloneDX SBOM (`matterwave-desktop-vX.Y.Z.cdx.json`) from `pnpm-lock.yaml`, `web/pnpm-lock.yaml`, and `src-tauri/Cargo.lock`, and attaches it to the draft release.
4. **`publish`**: publishes the GitHub Release (`--draft=false`) once every target has built and started cleanly.
5. **`feed`**: downloads the release artifacts and `latest.json`, lays out the per-platform Tauri updater feed (`scripts/publish-updater-manifest.mjs`), and uploads it to `MW_DESKTOP_UPDATES_URL` when signing secrets are configured.

After the workflow completes, confirm on the GitHub Release page that all platform installers, `.sig` files (when signed), `latest.json`, and `matterwave-desktop-vX.Y.Z.cdx.json` are attached and the release is published.
