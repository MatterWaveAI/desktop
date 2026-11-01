// Starts the packaged app the way a person would get it -- the Windows
// installer run silently, the macOS app bundle, the Linux AppImage -- and
// fails unless it is still running after a while. What it catches is the
// class of break no unit test sees: a bundle missing a resource, a binary
// that will not load on the target, a panic in setup.
//
//   node scripts/smoke-packaged-app.mjs --bundle-dir <.../release/bundle> [--seconds 20]
//
// Linux needs a display: run it under `xvfb-run -a`. On Windows the
// installer installs into a temporary directory, and the uninstaller runs
// afterwards.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

/** The single file in `dir` whose name matches, or a failure naming what was there. */
function one(dir, pattern, what) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const found = names.filter((n) => pattern.test(n));
  if (found.length !== 1) fail(`expected one ${what} in ${dir}, found ${JSON.stringify(names)}`);
  return path.join(dir, found[0]);
}

/** The app's executable inside an installed or bundled directory: the one that is not the uninstaller. */
function mainExecutable(dir, pattern) {
  const found = fs.readdirSync(dir).filter((n) => pattern.test(n) && !/^uninstall/i.test(n));
  if (found.length !== 1) fail(`expected one app executable in ${dir}, found ${JSON.stringify(found)}`);
  return path.join(dir, found[0]);
}

/** Install (where the platform has an installer) and return how to start the app, and how to clean up. */
function prepare(bundleDir) {
  if (process.platform === "win32") {
    const installer = one(path.join(bundleDir, "nsis"), /-setup\.exe$/i, "NSIS installer");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mw-smoke-"));
    // /S silent, /D the install directory (NSIS wants it last and unquoted).
    const res = spawnSync(installer, ["/S", `/D=${target}`], { stdio: "inherit" });
    if (res.status !== 0) fail(`the installer exited ${res.status}`);
    const exe = mainExecutable(target, /\.exe$/i);
    return {
      command: exe,
      args: [],
      env: {},
      cleanup: () => {
        const uninstaller = path.join(target, "uninstall.exe");
        if (fs.existsSync(uninstaller)) spawnSync(uninstaller, ["/S"], { stdio: "inherit" });
      },
    };
  }
  if (process.platform === "darwin") {
    const app = one(path.join(bundleDir, "macos"), /\.app$/, "app bundle");
    const exe = mainExecutable(path.join(app, "Contents", "MacOS"), /.*/);
    return { command: exe, args: [], env: {}, cleanup: () => {} };
  }
  const appImage = one(path.join(bundleDir, "appimage"), /\.AppImage$/, "AppImage");
  fs.chmodSync(appImage, 0o755);
  // Extract-and-run: CI runners have no FUSE to mount the image with.
  return { command: appImage, args: [], env: { APPIMAGE_EXTRACT_AND_RUN: "1" }, cleanup: () => {} };
}

function stop(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

const bundleDir = arg("bundle-dir");
if (!bundleDir) fail("missing --bundle-dir");
const seconds = Number(arg("seconds") ?? 20);
const app = prepare(path.resolve(bundleDir));
console.log(`smoke: starting ${app.command}`);
const child = spawn(app.command, app.args, {
  env: { ...process.env, ...app.env },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
const ran = await Promise.race([
  exited,
  new Promise((resolve) => setTimeout(() => resolve(null), seconds * 1000)),
]);
if (!ran) {
  console.log(`smoke: still running after ${seconds} s`);
  stop(child);
  await exited;
}
app.cleanup();
if (ran) fail(`the app exited within ${seconds} s (code ${ran.code}, signal ${ran.signal})\n${output}`);
