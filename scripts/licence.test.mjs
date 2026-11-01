// node --test scripts/: one licence, Apache-2.0, in the LICENSE file and in
// every manifest that declares one, and the installers carry its text.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const read = (file) => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

describe("the licence", () => {
  it("is the Apache License 2.0, with a NOTICE naming the copyright holder", () => {
    assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
    assert.match(read("NOTICE"), /^Copyright \d{4} MatterWave AI Contributors$/m);
  });

  it("is what package.json, Cargo.toml and the Tauri bundle declare", () => {
    assert.equal(JSON.parse(read("package.json")).license, "Apache-2.0");
    assert.match(read("src-tauri/Cargo.toml"), /^\[package\][^[]*^license = "Apache-2\.0"$/m);
    const bundle = JSON.parse(read("src-tauri/tauri.conf.json")).bundle;
    assert.equal(bundle.license, "Apache-2.0");
    // Relative to src-tauri/, where the config lives.
    assert.equal(bundle.licenseFile, "../LICENSE");
  });
});
