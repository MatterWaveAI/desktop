// Writes src-tauri/tauri.release.json, merged over tauri.conf.json by
// `tauri build --config`. The committed config carries placeholders only: the
// updater public key and the per-channel endpoint belong to the release job,
// which has them in its secrets and environment, not to the repository.
//
//   MW_UPDATER_PUBKEY        the minisign public key (`tauri signer generate`)
//   MW_DESKTOP_CHANNEL       the channel, one per MW_ENV (e.g. dev, staging, prod)
//   MW_DESKTOP_UPDATES_URL   where the release job publishes manifests
//   MW_RELEASE               the version string the API reports, optional
//   MW_DESKTOP_UNSIGNED      set to 1 to build without the updater when the
//                            signing secrets are absent (the workflow's
//                            graceful path); plain installers, no manifests
//
// The private key never passes through here: the Tauri bundler reads it from
// TAURI_SIGNING_PRIVATE_KEY when it signs the updater artifacts.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const unsignedOk = process.env.MW_DESKTOP_UNSIGNED === "1";
const updaterEnv = ["MW_UPDATER_PUBKEY", "MW_DESKTOP_UPDATES_URL"];
const missingUpdater = updaterEnv.filter((name) => !process.env[name]);
if (missingUpdater.length) {
  if (!unsignedOk || missingUpdater.length < updaterEnv.length) {
    // Fully unconfigured and told that is fine, or nothing at all: otherwise
    // a half-configured release is a hard failure, because half a feed is
    // worse than none.
    const missing = ["MW_DESKTOP_CHANNEL", ...updaterEnv].filter((name) => !process.env[name]);
    console.error(`release-config: missing ${missing.join(", ")}`);
    process.exit(1);
  }
  // No signing setup at all, and the caller has said that is fine: the
  // build carries no updater (the Rust side registers the plugin only when
  // MW_DESKTOP_UPDATER is set, so the release job turns it off too) and the
  // installers ship unsigned.
  console.warn(
    "release-config: MW_DESKTOP_UNSIGNED=1 without " +
      `${missingUpdater.join(", ")} -- building UNSIGNED installers without the updater`,
  );
  const unsigned = {};
  if (process.env.MW_RELEASE && /^\d+\.\d+\.\d+/.test(process.env.MW_RELEASE)) {
    unsigned.version = process.env.MW_RELEASE;
  }
  const unsignedOut = fileURLToPath(new URL("../src-tauri/tauri.release.json", import.meta.url));
  writeFileSync(unsignedOut, `${JSON.stringify(unsigned, null, 2)}\n`);
  console.log(`release-config: wrote ${unsignedOut} (unsigned, no updater)`);
  process.exit(0);
}

const channel = process.env.MW_DESKTOP_CHANNEL;
if (!channel) {
  console.error("release-config: missing MW_DESKTOP_CHANNEL");
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(channel)) {
  console.error(`release-config: channel ${JSON.stringify(channel)} is not a plain name`);
  process.exit(1);
}
const base = process.env.MW_DESKTOP_UPDATES_URL.replace(/\/+$/, "");

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey: process.env.MW_UPDATER_PUBKEY,
      // Tauri fills the {{...}} variables; the manifest lives per channel so
      // a dev build never offers itself a prod update or the reverse.
      endpoints: [`${base}/desktop/${channel}/{{target}}/{{arch}}/{{current_version}}`],
    },
  },
};
// Tauri versions must be semver; MW_RELEASE is used when it is one so the
// app and the API report the same string.
if (process.env.MW_RELEASE && /^\d+\.\d+\.\d+/.test(process.env.MW_RELEASE)) {
  config.version = process.env.MW_RELEASE;
}

const out = fileURLToPath(new URL("../src-tauri/tauri.release.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`release-config: wrote ${out} for channel ${channel}`);
