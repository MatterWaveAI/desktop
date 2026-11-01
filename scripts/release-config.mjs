// Writes src-tauri/tauri.release.json, merged over tauri.conf.json by
// `tauri build --config`. The committed config carries placeholders only: the
// updater public key, the per-channel endpoint and the API's origin belong to
// the release job, which has them in its secrets and environment, not to the
// repository.
//
//   MW_DESKTOP_BASE_URL      the API the build talks to (the Rust side reads
//                            it at build time too); the page's CSP may connect
//                            to its origin and to no other host
//   MW_UPDATER_PUBKEY        the minisign public key (`tauri signer generate`)
//   MW_DESKTOP_CHANNEL       the channel, one per MW_ENV (e.g. dev, staging, prod)
//   MW_DESKTOP_UPDATES_URL   where the release job publishes manifests
//   MW_RELEASE               the version string the API reports, optional
//   MW_DESKTOP_UNSIGNED      set to 1 to build without the updater when the
//                            signing secrets are absent (the workflow's
//                            graceful path); plain installers, no manifests
//   MW_WINDOWS_CERT_THUMBPRINT  the Authenticode certificate the release job
//                            imported into the runner's store; with it the
//                            bundler signs the Windows binaries and installers
//   MW_WINDOWS_TIMESTAMP_URL the certificate vendor's RFC 3161 timestamp
//                            server, required with the thumbprint
//
// `--out <file>` writes somewhere else (the tests do).
//
// The private key never passes through here: the Tauri bundler reads it from
// TAURI_SIGNING_PRIVATE_KEY when it signs the updater artifacts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outArg = process.argv.indexOf("--out");
const out =
  outArg >= 0
    ? process.argv[outArg + 1]
    : fileURLToPath(new URL("../src-tauri/tauri.release.json", import.meta.url));

/**
 * The committed CSP with `connect-src` narrowed to the page itself, the IPC
 * bridge and the API's origin. The committed config allows any https host
 * because it cannot know the API; a release can, and script injected into
 * the page must not reach anywhere else. The webview never talks to the
 * identity provider -- sign-in and refresh are native -- so the issuer is
 * not on the list.
 */
function pinnedCsp(csp, origin) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) =>
      directive.split(/\s+/)[0] === "connect-src"
        ? `connect-src 'self' ipc: http://ipc.localhost ${origin}`
        : directive,
    )
    .join("; ");
}

/** The API's origin: https, or http on loopback only. */
function apiOrigin(raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    console.error("release-config: missing or malformed MW_DESKTOP_BASE_URL");
    process.exit(1);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    console.error(`release-config: MW_DESKTOP_BASE_URL must be https, not ${url.origin}`);
    process.exit(1);
  }
  return url.origin;
}

const committed = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const security = {
  csp: pinnedCsp(committed.app.security.csp, apiOrigin(process.env.MW_DESKTOP_BASE_URL)),
};

/**
 * Authenticode, when the release job has a certificate: SHA-256 and a
 * timestamp, so the signature outlives the certificate. A thumbprint
 * without a timestamp server is refused rather than signed in a way that
 * expires with the certificate.
 */
function windowsSigning() {
  const certificateThumbprint = process.env.MW_WINDOWS_CERT_THUMBPRINT;
  if (!certificateThumbprint) return undefined;
  const timestampUrl = process.env.MW_WINDOWS_TIMESTAMP_URL;
  if (!timestampUrl) {
    console.error("release-config: MW_WINDOWS_CERT_THUMBPRINT without MW_WINDOWS_TIMESTAMP_URL");
    process.exit(1);
  }
  return { windows: { certificateThumbprint, digestAlgorithm: "sha256", timestampUrl } };
}
const windows = windowsSigning();

// Tauri versions must be semver; MW_RELEASE is used when it is one so the
// app and the API report the same string.
const version =
  process.env.MW_RELEASE && /^\d+\.\d+\.\d+/.test(process.env.MW_RELEASE)
    ? process.env.MW_RELEASE
    : undefined;

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
  const unsigned = {
    app: { security },
    ...(windows ? { bundle: windows } : {}),
    ...(version ? { version } : {}),
  };
  writeFileSync(out, `${JSON.stringify(unsigned, null, 2)}\n`);
  console.log(`release-config: wrote ${out} (unsigned, no updater)`);
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
  app: { security },
  bundle: { createUpdaterArtifacts: true, ...windows },
  plugins: {
    updater: {
      pubkey: process.env.MW_UPDATER_PUBKEY,
      // Tauri fills the {{...}} variables; the manifest lives per channel so
      // a dev build never offers itself a prod update or the reverse.
      endpoints: [`${base}/desktop/${channel}/{{target}}/{{arch}}/{{current_version}}`],
    },
  },
  ...(version ? { version } : {}),
};

writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`release-config: wrote ${out} for channel ${channel}`);
