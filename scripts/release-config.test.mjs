// node --test scripts/: the release build config, generated the way the
// release job generates it, into a temporary file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-config.mjs", import.meta.url));
const COMMITTED = JSON.parse(
  fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-config-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SIGNED = {
  MW_DESKTOP_BASE_URL: "https://app.example.test/",
  MW_UPDATER_PUBKEY: "pubkey",
  MW_DESKTOP_CHANNEL: "prod",
  MW_DESKTOP_UPDATES_URL: "https://releases.example.test/",
  MW_RELEASE: "1.2.3",
};

let runs = 0;
function generate(env) {
  const out = path.join(tmp, `release-${(runs += 1)}.json`);
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("MW_") && k !== "TAURI_SIGNING_PRIVATE_KEY"),
  );
  const res = spawnSync(process.execPath, [SCRIPT, "--out", out], {
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  const config = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  return { code: res.status, out: `${res.stdout}${res.stderr}`, config };
}

/** A CSP as directive name -> its sources. */
function directives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name, sources]),
  );
}

describe("release-config", () => {
  it("pins the page's network access to the API's origin", () => {
    const { code, config, out } = generate(SIGNED);
    assert.equal(code, 0, out);
    const csp = directives(config.app.security.csp);
    assert.deepEqual(csp["connect-src"], ["'self'", "ipc:", "http://ipc.localhost", "https://app.example.test"]);
    assert.ok(!config.app.security.csp.includes(" https: "), "no bare https: source anywhere");
  });

  it("keeps every other directive exactly as committed", () => {
    const { config } = generate(SIGNED);
    const pinned = directives(config.app.security.csp);
    const committed = directives(COMMITTED.app.security.csp);
    delete pinned["connect-src"];
    delete committed["connect-src"];
    assert.deepEqual(pinned, committed);
  });

  it("pins the CSP on the unsigned path too", () => {
    const { code, config, out } = generate({
      MW_DESKTOP_BASE_URL: "https://staging.example.test",
      MW_DESKTOP_UNSIGNED: "1",
    });
    assert.equal(code, 0, out);
    assert.deepEqual(directives(config.app.security.csp)["connect-src"].at(-1), "https://staging.example.test");
    assert.equal(config.plugins, undefined, "no updater without the signing setup");
  });

  it("writes the updater endpoint and version for a signed release", () => {
    const { config } = generate(SIGNED);
    assert.deepEqual(config.plugins.updater.endpoints, [
      "https://releases.example.test/desktop/prod/{{target}}/{{arch}}/{{current_version}}",
    ]);
    assert.equal(config.bundle.createUpdaterArtifacts, true);
    assert.equal(config.version, "1.2.3");
  });

  it("refuses a build without an API, or with one over plain http", () => {
    const missing = generate({ ...SIGNED, MW_DESKTOP_BASE_URL: "" });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /MW_DESKTOP_BASE_URL/);
    const http = generate({ ...SIGNED, MW_DESKTOP_BASE_URL: "http://app.example.test" });
    assert.equal(http.code, 1);
    assert.match(http.out, /must be https/);
    const loopback = generate({ ...SIGNED, MW_DESKTOP_BASE_URL: "http://127.0.0.1:8000" });
    assert.equal(loopback.code, 0, loopback.out);
  });

  it("signs the Windows binaries when the job imported a certificate", () => {
    const signed = generate({ ...SIGNED, MW_WINDOWS_CERT_THUMBPRINT: "ABC123", MW_WINDOWS_TIMESTAMP_URL: "http://ts.example.test" });
    assert.deepEqual(signed.config.bundle.windows, {
      certificateThumbprint: "ABC123",
      digestAlgorithm: "sha256",
      timestampUrl: "http://ts.example.test",
    });
    assert.equal(signed.config.bundle.createUpdaterArtifacts, true);
    const unsignedUpdater = generate({
      MW_DESKTOP_BASE_URL: "https://app.example.test",
      MW_DESKTOP_UNSIGNED: "1",
      MW_WINDOWS_CERT_THUMBPRINT: "ABC123",
      MW_WINDOWS_TIMESTAMP_URL: "http://ts.example.test",
    });
    assert.equal(unsignedUpdater.config.bundle.windows.certificateThumbprint, "ABC123");
    assert.equal(generate(SIGNED).config.bundle.windows, undefined, "no certificate, no Authenticode");
    const noTimestamp = generate({ ...SIGNED, MW_WINDOWS_CERT_THUMBPRINT: "ABC123" });
    assert.equal(noTimestamp.code, 1);
    assert.match(noTimestamp.out, /MW_WINDOWS_TIMESTAMP_URL/);
  });

  it("still refuses half a signing setup", () => {
    const { code, out } = generate({ ...SIGNED, MW_UPDATER_PUBKEY: "" });
    assert.equal(code, 1);
    assert.match(out, /missing .*MW_UPDATER_PUBKEY/);
  });
});
