// Lays out the updater feed from a release directory, so the release
// workflow can publish the manifest at the exact paths the app asks for
// (scripts/release-config.mjs names the endpoint
// `<MW_DESKTOP_UPDATES_URL>/desktop/<channel>/{{target}}/{{arch}}/{{current_version}}`;
// the server answers any current_version with this manifest).
//
//   node scripts/publish-updater-manifest.mjs \
//     --artifacts dist/release          # tauri-action's artifactPaths dir
//     --channel prod                    # MW_DESKTOP_CHANNEL
//     --base https://releases.example   # MW_DESKTOP_UPDATES_URL
//     --out dist/feed                   # the layout to upload
//
// For each platform in latest.json ("windows-x86_64", "darwin-aarch64", ...)
// it writes
//
//   <out>/desktop/<channel>/<os>/<arch>/latest.json   manifest, URL rewritten
//   <out>/desktop/<channel>/<os>/<arch>/<artifact>    the signed artifact
//
// and prints one line per file for the upload step. The manifest itself is
// plain JSON -- the signatures are what the app verifies, which is why a
// feed run by anyone else cannot substitute its own artifacts (tested in
// src-tauri/tests/updater_local.rs).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";

function arg(name) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const artifactsDir = arg("artifacts");
const channel = arg("channel");
const base = (arg("base") ?? process.env.MW_DESKTOP_UPDATES_URL ?? "").replace(/\/+$/, "");
const outDir = arg("out");

const missing = [
  ["--artifacts", artifactsDir],
  ["--channel", channel],
  ["--base or MW_DESKTOP_UPDATES_URL", base],
  ["--out", outDir],
].filter(([, v]) => !v);
if (missing.length) {
  console.error(`publish-updater-manifest: missing ${missing.map(([n]) => n).join(", ")}`);
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(channel)) {
  console.error(`publish-updater-manifest: channel ${JSON.stringify(channel)} is not a plain name`);
  process.exit(1);
}

const manifestPath = arg("manifest") ?? join(artifactsDir, "latest.json");
if (!existsSync(manifestPath)) {
  console.error(`publish-updater-manifest: no manifest at ${manifestPath} (pass --manifest)`);
  process.exit(1);
}
// A BOM survives some Windows tooling; JSON.parse refuses it.
const release = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
const platforms = release.platforms ?? {};
if (Object.keys(platforms).length === 0) {
  console.error("publish-updater-manifest: the manifest announces no platforms");
  process.exit(1);
}

const out = resolve(outDir);
const uploads = [];
for (const [platform, entry] of Object.entries(platforms)) {
  const artifact = basename(new URL(entry.url).pathname);
  const source = resolve(artifactsDir, artifact);
  if (!existsSync(source)) {
    console.error(`publish-updater-manifest: ${platform} names ${artifact}, which is not under ${artifactsDir}`);
    process.exit(1);
  }
  // "windows-x86_64" names the endpoint's {{target}}/{{arch}} pair.
  const [os, arch] = platform.split("-");
  if (!os || !arch) {
    console.error(`publish-updater-manifest: platform ${platform} is not <os>-<arch>`);
    process.exit(1);
  }
  const dir = join(out, "desktop", channel, os, arch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "latest.json"),
    `${JSON.stringify(
      {
        version: release.version,
        notes: release.notes,
        pub_date: release.pub_date,
        platforms: {
          [platform]: {
            signature: entry.signature,
            url: `${base}/desktop/${channel}/${os}/${arch}/${artifact}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync(source, join(dir, artifact));
  uploads.push(relative(process.cwd(), join(dir, "latest.json")), relative(process.cwd(), join(dir, artifact)));
}

console.log(`publish-updater-manifest: laid out ${release.version} for channel ${channel} at ${out}`);
for (const file of uploads) console.log(`upload ${file}`);
