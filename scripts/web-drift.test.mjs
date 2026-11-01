// node --test scripts/: the drift report against a throwaway platform
// repository and a throwaway desktop checkout synced from it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, compare, patternOf } from "./web-drift.mjs";

const DRIFT = fileURLToPath(new URL("./web-drift.mjs", import.meta.url));
const SYNC = fileURLToPath(new URL("./spa-sync.mjs", import.meta.url));

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
  git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function run(script, root, ...args) {
  const res = spawnSync(process.execPath, [script, ...args, "--root", root], { encoding: "utf8" });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("patternOf", () => {
  it("matches one segment with * and any depth with **", () => {
    assert.ok(patternOf("src/lib/desktop*.ts").test("src/lib/desktopAuth.ts"));
    assert.ok(!patternOf("src/lib/desktop*.ts").test("src/lib/x/desktopAuth.ts"));
    assert.ok(patternOf("src/**/tts.*").test("src/apps/chat/tts.test.ts"));
    assert.ok(patternOf("src/**/tts.ts").test("src/tts.ts"));
    assert.ok(!patternOf("src/main.tsx").test("src/mainXtsx"));
  });
});

describe("compare and classify", () => {
  it("names added, removed and changed files, and splits them by the adapted list", () => {
    const up = new Map([
      ["a.ts", Buffer.from("a")],
      ["b.ts", Buffer.from("b")],
      ["c.ts", Buffer.from("c")],
    ]);
    const ours = new Map([
      ["a.ts", Buffer.from("a")],
      ["b.ts", Buffer.from("B")],
      ["d.ts", Buffer.from("d")],
    ]);
    const changed = compare(up, ours);
    assert.deepEqual(changed, [
      { rel: "b.ts", status: "M" },
      { rel: "c.ts", status: "D" },
      { rel: "d.ts", status: "A" },
    ]);
    const adapted = ["d.ts", "e.ts"].map((key) => ({ key, why: "", re: patternOf(key) }));
    const { listed, drift, stale } = classify(changed, adapted);
    assert.deepEqual(listed.map((e) => e.rel), ["d.ts"]);
    assert.deepEqual(drift.map((e) => e.rel), ["b.ts", "c.ts"]);
    assert.deepEqual(stale, ["e.ts"]);
  });
});

describe("web-drift", () => {
  let tmp;
  let platform;
  let desktop;
  let first;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-drift-test-"));
    platform = repo(path.join(tmp, "platform"));
    first = commit(platform, {
      "web/package.json": '{ "name": "web" }\n',
      "web/src/app.ts": "export const app = 1;\n",
      "web/src/shell.ts": "export const shell = 1;\n",
      "web/e2e/smoke.spec.ts": "only the platform runs this\n",
    });
    desktop = repo(path.join(tmp, "desktop"));
    commit(desktop, { "README.md": "desktop\n" });
    const pulled = run(SYNC, desktop, "pull", "--source", platform, "--ref", first);
    assert.equal(pulled.code, 0, pulled.out);
    commit(desktop, {}, "sync");
    write(desktop, {
      "web/src/shell.ts": "export const shell = 2;\n",
      "web/src/desktopOnly.ts": "export const desktop = true;\n",
      "spa/adapted.json": JSON.stringify({ "src/shell.ts": "the desktop's shell", "src/desktop*.ts": "desktop only" }),
    });
    const refreshed = run(SYNC, desktop, "refresh");
    assert.equal(refreshed.code, 0, refreshed.out);
    commit(desktop, {}, "desktop changes");
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("passes against the pinned commit without a platform checkout when only adapted files differ", () => {
    const res = run(DRIFT, desktop);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /adapted \(2,/);
    assert.match(res.out, /A src\/desktopOnly\.ts/);
    assert.match(res.out, /M src\/shell\.ts/);
    assert.match(res.out, /no drift/);
  });

  it("fails on an unlisted difference that the patches carry", () => {
    write(desktop, { "web/src/app.ts": "export const app = 2;\n" });
    assert.equal(run(SYNC, desktop, "refresh").code, 0);
    const res = run(DRIFT, desktop);
    assert.equal(res.code, 1);
    assert.match(res.out, /not adapted \(1\):\n {2}M src\/app\.ts/);
    write(desktop, { "web/src/app.ts": "export const app = 1;\n" });
    assert.equal(run(SYNC, desktop, "refresh").code, 0);
  });

  it("refuses a web/ the patches do not rebuild, as spa-sync does", () => {
    write(desktop, { "web/src/app.ts": "export const app = 3;\n" });
    const res = run(DRIFT, desktop);
    assert.equal(res.code, 2);
    assert.match(res.out, /minus the patches is not platform/);
    write(desktop, { "web/src/app.ts": "export const app = 1;\n" });
  });

  it("measures against a newer platform commit, and against a directory", () => {
    const second = commit(platform, {
      "web/src/app.ts": "export const app = 10;\n",
      "web/src/added.ts": "export const added = 1;\n",
    });
    const res = run(DRIFT, desktop, "--source", platform, "--ref", second);
    assert.equal(res.code, 1);
    assert.match(res.out, new RegExp(`against platform ${second.slice(0, 12)}`));
    assert.match(res.out, /M src\/app\.ts/);
    assert.match(res.out, /D src\/added\.ts/);
    assert.doesNotMatch(res.out, /e2e/);

    const dir = path.join(tmp, "plain");
    write(dir, {
      "package.json": '{ "name": "web" }\n',
      "src/app.ts": "export const app = 1;\n",
      "src/shell.ts": "export const shell = 1;\n",
      "node_modules/x/index.js": "installed, not a source\n",
    });
    const plain = run(DRIFT, desktop, "--upstream", dir);
    assert.equal(plain.code, 0, plain.out);
  });

  it("lists adapted entries that no longer differ", () => {
    write(desktop, {
      "spa/adapted.json": JSON.stringify({
        "src/shell.ts": "the desktop's shell",
        "src/desktop*.ts": "desktop only",
        "src/app.ts": "no longer adapted",
      }),
    });
    const res = run(DRIFT, desktop);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /no different from the platform \(1\):\n {2}src\/app\.ts/);
  });
});
