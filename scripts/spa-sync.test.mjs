// node --test scripts/: the SPA sync against a throwaway platform repository
// and a throwaway desktop checkout, both a handful of files.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./spa-sync.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@localhost");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(full, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commit(dir, files, message = "change") {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function sync(root, ...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8" });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const LINES = (n, edit = {}) =>
  Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join("\n") + "\n";

describe("spa-sync", () => {
  let tmp;
  let platform;
  let desktop;
  let first;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spa-sync-test-"));
    platform = repo(path.join(tmp, "platform"));
    first = commit(platform, {
      "web/package.json": '{ "name": "web" }\n',
      "web/src/app.ts": LINES(20),
      "web/src/shell.ts": LINES(20),
      "web/src/gone.ts": "export {};\n",
      "web/public/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]),
      "web/e2e/smoke.spec.ts": "only the platform runs this\n",
      "web/tsconfig.tsbuildinfo": "{}\n",
      "api/main.py": "not the SPA\n",
    });
    desktop = repo(path.join(tmp, "desktop"));
    commit(desktop, { "README.md": "desktop\n" });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("copies the platform's SPA at a commit, without its e2e suites or build cache, and pins it", () => {
    const res = sync(desktop, "pull", "--source", platform, "--ref", first);
    assert.equal(res.code, 0, res.out);
    assert.equal(read(desktop, "web/src/app.ts"), LINES(20));
    assert.ok(fs.existsSync(path.join(desktop, "web/public/icon.png")));
    assert.ok(!fs.existsSync(path.join(desktop, "web/e2e")));
    assert.ok(!fs.existsSync(path.join(desktop, "web/tsconfig.tsbuildinfo")));
    assert.ok(!fs.existsSync(path.join(desktop, "api")));
    const pin = JSON.parse(read(desktop, "spa/upstream.json"));
    assert.equal(pin.commit, first);
    assert.match(pin.digest, /^sha256-[0-9a-f]{64}$/);
    assert.equal(sync(desktop, "check").code, 0);
    commit(desktop, {}, "sync");
  });

  it("refuses an edit to web/ that the patches do not carry, and keeps it once refreshed", () => {
    write(desktop, {
      "web/src/app.ts": LINES(20, { 2: "desktop: line 2" }),
      "web/src/desktop.ts": "export const desktop = true;\n",
      "web/src/gone.ts": null,
    });
    const drift = sync(desktop, "check");
    assert.equal(drift.code, 1);
    assert.match(drift.out, /web\/ minus the patches is not platform/);

    const res = sync(desktop, "refresh");
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(
      fs.readdirSync(path.join(desktop, "spa/patches/src")).sort(),
      ["app.ts.patch", "desktop.ts.patch", "gone.ts.patch"],
    );
    assert.equal(sync(desktop, "check").code, 0);
    commit(desktop, {}, "desktop changes");
  });

  it("fails the check when a patch is edited by hand", () => {
    const patch = path.join(desktop, "spa/patches/src/app.ts.patch");
    const original = fs.readFileSync(patch, "utf8");
    fs.writeFileSync(patch, original.replace("+desktop: line 2", "+desktop: line two"));
    const res = sync(desktop, "check");
    assert.equal(res.code, 1);
    assert.match(res.out, /no longer match web\//);
    fs.writeFileSync(patch, original);
    assert.equal(sync(desktop, "check").code, 0);
  });

  it("replays the desktop's changes onto a newer platform commit", () => {
    const second = commit(platform, {
      "web/src/app.ts": LINES(20, { 15: "platform: line 15" }),
      "web/src/new.ts": "export const added = 1;\n",
    });
    const res = sync(desktop, "pull", "--source", platform, "--ref", second);
    assert.equal(res.code, 0, res.out);
    assert.equal(read(desktop, "web/src/app.ts"), LINES(20, { 2: "desktop: line 2", 15: "platform: line 15" }));
    assert.equal(read(desktop, "web/src/new.ts"), "export const added = 1;\n");
    assert.equal(read(desktop, "web/src/desktop.ts"), "export const desktop = true;\n");
    assert.ok(!fs.existsSync(path.join(desktop, "web/src/gone.ts")));
    assert.equal(JSON.parse(read(desktop, "spa/upstream.json")).commit, second);
    assert.equal(sync(desktop, "check").code, 0);
    commit(desktop, {}, "resync");
  });

  it("stops on a collision with markers in web/, and a resolution plus refresh lands it", () => {
    const third = commit(platform, { "web/src/app.ts": LINES(20, { 2: "platform: line 2", 15: "platform: line 15" }) });
    const res = sync(desktop, "pull", "--source", platform, "--ref", third);
    assert.equal(res.code, 1);
    assert.match(res.out, /src\/app\.ts/);
    assert.match(read(desktop, "web/src/app.ts"), /^<{7} /m);

    const early = sync(desktop, "refresh", "--source", platform);
    assert.equal(early.code, 1);
    assert.match(early.out, /conflict markers remain/);

    write(desktop, { "web/src/app.ts": LINES(20, { 2: "platform and desktop: line 2", 15: "platform: line 15" }) });
    const done = sync(desktop, "refresh", "--source", platform);
    assert.equal(done.code, 0, done.out);
    assert.equal(JSON.parse(read(desktop, "spa/upstream.json")).commit, third);
    assert.equal(sync(desktop, "check").code, 0);
  });

  it("will not pull over a web/ that has no pin without being told its base", () => {
    const other = repo(path.join(tmp, "other"));
    commit(other, { "web/src/app.ts": LINES(20) });
    const res = sync(other, "pull", "--source", platform, "--ref", first);
    assert.equal(res.code, 1);
    assert.match(res.out, /--base/);
    const based = sync(other, "pull", "--source", platform, "--ref", first, "--base", first);
    assert.equal(based.code, 0, based.out);
  });
});
