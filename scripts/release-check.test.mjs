// node --test scripts/: the release gate against a throwaway checkout, and
// against this one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-check.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-check-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Not yet.

## [1.4.0] - 2026-11-02

### Fixed

- **A fix**: what it fixed.

## [1.3.0] - 2026-10-01

- Older.

[Unreleased]: https://example.test/compare/v1.4.0...HEAD
[1.4.0]: https://example.test/compare/v1.3.0...v1.4.0
`;

let checkouts = 0;
function checkout({ pkg = "1.4.0", conf = "1.4.0", cargo = "1.4.0", changelog = CHANGELOG } = {}) {
  const root = path.join(tmp, `c${(checkouts += 1)}`);
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: pkg }));
  fs.writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "X", version: conf }));
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "x"\nversion = "${cargo}"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  return root;
}

function check(root, tag, ...extra) {
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--tag", tag, ...extra], { encoding: "utf8" });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("release-check", () => {
  it("passes a tag every manifest agrees with, and writes its CHANGELOG section as the notes", () => {
    const root = checkout();
    const notes = path.join(root, "notes.md");
    const res = check(root, "v1.4.0", "--notes-out", notes);
    assert.equal(res.code, 0, res.out);
    assert.equal(fs.readFileSync(notes, "utf8"), "### Fixed\n\n- **A fix**: what it fixed.\n");
  });

  it("names each manifest that disagrees with the tag", () => {
    const res = check(checkout({ conf: "1.3.0", cargo: "1.4.1" }), "v1.4.0");
    assert.equal(res.code, 1);
    assert.match(res.out, /tauri\.conf\.json says 1\.3\.0/);
    assert.match(res.out, /Cargo\.toml says 1\.4\.1/);
    assert.doesNotMatch(res.out, /package\.json says/);
  });

  it("reads the package's version, not a dependency's", () => {
    const res = check(checkout(), "v1.4.0");
    assert.equal(res.code, 0, res.out);
  });

  it("refuses a release the CHANGELOG does not describe", () => {
    const res = check(checkout({ pkg: "1.5.0", conf: "1.5.0", cargo: "1.5.0" }), "v1.5.0");
    assert.equal(res.code, 1);
    assert.match(res.out, /no "## \[1\.5\.0\] - YYYY-MM-DD" section/);
    const empty = checkout({ changelog: "# Changelog\n\n## [1.4.0] - 2026-11-02\n\n## [1.3.0] - 2026-10-01\n" });
    assert.match(check(empty, "v1.4.0").out, /section is empty/);
  });

  it("refuses something that is not a version tag", () => {
    for (const tag of ["1.4.0", "v1.4", "release-1.4.0", ""]) {
      assert.equal(check(checkout(), tag).code, 1, tag);
    }
  });

  it("agrees with this checkout's own current version", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const res = check(root, `v${version}`);
    assert.equal(res.code, 0, res.out);
  });
});
