// Writes src-tauri/tauri.release.json, merged over tauri.conf.json by
// `tauri build --config`. The committed config carries placeholders only: the
// updater public key and the per-channel endpoint belong to the release job,
// which has them in its secrets and environment, not to the repository.
//
//   MW_UPDATER_PUBKEY        the minisign public key (`tauri signer generate`)
//   MW_DESKTOP_CHANNEL       the channel, one per MW_ENV (e.g. dev, staging, prod)
//   MW_DESKTOP_UPDATES_URL   where the release job publishes manifests
//   MW_RELEASE               the version string the API reports, optional
//
// The private key never passes through here: the Tauri bundler reads it from
// TAURI_SIGNING_PRIVATE_KEY when it signs the updater artifacts.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const required = ["MW_UPDATER_PUBKEY", "MW_DESKTOP_CHANNEL", "MW_DESKTOP_UPDATES_URL"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`release-config: missing ${missing.join(", ")}`);
  process.exit(1);
}

const channel = process.env.MW_DESKTOP_CHANNEL;
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
