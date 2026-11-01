// How far the bundled SPA is from the platform's, file by file. Every file
// in web/ that differs from the platform's web/ is either one the desktop
// adapts on purpose -- listed, with the reason, in spa/adapted.json -- or
// drift: a platform change that never reached the desktop, or a desktop
// edit to a file it should copy unchanged. Drift exits 1.
//
//   node scripts/web-drift.mjs
//       Against the commit spa/upstream.json pins, without a platform
//       checkout: spa-sync proves web/ minus spa/patches is that commit, so
//       the pinned commit's files come from web/ itself. CI runs this.
//
//   node scripts/web-drift.mjs --source <platform checkout> [--ref <rev>]
//       Against the platform's web/ at <rev> (default: the pinned commit),
//       read from the checkout's object store; its work tree is not touched.
//
//   node scripts/web-drift.mjs --upstream <dir>
//       Against a directory holding the platform's web/ as files (a working
//       checkout's web/, edits not yet committed included). Inside a git
//       work tree only what git tracks or would track is read.
//
// Paths are web/-relative. spa/adapted.json maps a path, or a pattern
// (`*` within one path segment, `**` across them), to why the desktop's copy
// differs. `--root` points at another desktop checkout, for tests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PATCHES,
  PIN,
  SPA,
  SyncError,
  patchesFrom,
  pristineOf,
  readPin,
  readTree,
  readWorking,
} from "./spa-sync.mjs";

export const ADAPTED = "spa/adapted.json";
const DEFAULT_EXCLUDE = ["e2e", "test-results", "tsconfig.tsbuildinfo", "index.html"];
// What a plain directory walk skips: installs and build output, never sources.
const NOT_SOURCES = new Set([".git", "node_modules", "dist", "coverage"]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function excluded(rel, exclude) {
  return exclude.some((e) => rel === e || rel.startsWith(`${e}/`));
}

/** A spa/adapted.json key as a whole-path matcher. */
export function patternOf(key) {
  const source = key
    .split(/(\*\*\/?|\*)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

export function readAdapted(root) {
  const file = path.join(root, ADAPTED);
  if (!fs.existsSync(file)) return [];
  const listed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.entries(listed).map(([key, why]) => ({ key, why, re: patternOf(key) }));
}

/**
 * The files that differ between the platform's SPA and the desktop's, each
 * with its status: `A` only the desktop has it, `D` only the platform does,
 * `M` both, with different content.
 */
export function compare(upstream, desktop) {
  const names = [...new Set([...upstream.keys(), ...desktop.keys()])].sort();
  const changed = [];
  for (const rel of names) {
    const ours = desktop.get(rel);
    const theirs = upstream.get(rel);
    if (!theirs) changed.push({ rel, status: "A" });
    else if (!ours) changed.push({ rel, status: "D" });
    else if (!ours.equals(theirs)) changed.push({ rel, status: "M" });
  }
  return changed;
}

/** Split the differences by spa/adapted.json; also the entries nothing matched. */
export function classify(changed, adapted) {
  const used = new Set();
  const listed = [];
  const drift = [];
  for (const entry of changed) {
    const hit = adapted.find((a) => a.re.test(entry.rel));
    if (hit) {
      used.add(hit.key);
      listed.push(entry);
    } else {
      drift.push(entry);
    }
  }
  const stale = adapted.filter((a) => !used.has(a.key)).map((a) => a.key);
  return { listed, drift, stale };
}

/** A plain directory's files, git-aware when it sits in a work tree. */
function readDirectory(dir, exclude) {
  const files = new Map();
  let listing = null;
  try {
    listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    listing = null;
  }
  if (listing) {
    for (const rel of new Set(listing)) {
      const full = path.join(dir, rel);
      if (!excluded(rel, exclude) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        files.set(rel, fs.readFileSync(full));
      }
    }
    return files;
  }
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (NOT_SOURCES.has(entry.name) || excluded(rel, exclude)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(path.join(dir, rel)));
    }
  };
  walk("");
  return files;
}

/** The platform's SPA to compare against, and how to name it. */
function upstreamOf(root, opts, current) {
  const pin = readPin(root);
  const exclude = pin?.exclude ?? DEFAULT_EXCLUDE;
  if (opts.upstream) {
    const dir = path.resolve(opts.upstream);
    if (!fs.existsSync(dir)) throw new SyncError(`${dir} does not exist`);
    const files = readDirectory(dir, exclude);
    if (!files.size) throw new SyncError(`${dir} holds no files`);
    return { files, label: dir };
  }
  if (opts.source) {
    const ref = opts.ref ?? pin?.commit;
    if (!ref) throw new SyncError(`no --ref and no ${PIN} to take the commit from`);
    let commit;
    try {
      commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: opts.source,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString("utf8")
        .trim();
    } catch {
      throw new SyncError(`${ref} is not a commit in ${opts.source}`);
    }
    const files = readTree(opts.source, commit, SPA, exclude);
    if (!files.size) throw new SyncError(`${commit.slice(0, 12)} has no ${SPA}/`);
    return { files, label: `platform ${commit.slice(0, 12)}` };
  }
  if (!pin) throw new SyncError(`no ${PIN}: name the platform with --source or --upstream`);
  const patches = patchesFrom(readWorking(root, PATCHES));
  return { files: pristineOf(pin, current, patches), label: `platform ${pin.commit.slice(0, 12)} (${PIN})` };
}

export function drift(root, opts = {}) {
  const current = readWorking(root, SPA);
  const { files, label } = upstreamOf(root, opts, current);
  return { label, ...classify(compare(files, current), readAdapted(root)) };
}

function report({ label, listed, drift: off, stale }) {
  const line = (e) => `  ${e.status} ${e.rel}`;
  console.log(`web-drift: web/ against ${label}`);
  console.log(`adapted (${listed.length}, ${ADAPTED}):`);
  for (const e of listed) console.log(line(e));
  if (stale.length) {
    console.log(`listed in ${ADAPTED} but no different from the platform (${stale.length}):`);
    for (const key of stale) console.log(`  ${key}`);
  }
  if (off.length) {
    console.log(`not adapted (${off.length}):`);
    for (const e of off) console.log(line(e));
    console.error(
      `web-drift: ${off.length} file(s) differ from the platform beyond ${ADAPTED}. ` +
        "Copy the platform's version, or list the file there with the reason it differs.",
    );
  } else {
    console.log("web-drift: no drift beyond the adapted files.");
  }
}

function main() {
  const root = path.resolve(arg("root") ?? fileURLToPath(new URL("..", import.meta.url)));
  const source = arg("source") && path.resolve(arg("source"));
  const opts = { source, ref: arg("ref"), upstream: arg("upstream") };
  try {
    if (opts.source && opts.upstream) throw new SyncError("--source and --upstream are alternatives");
    const result = drift(root, opts);
    report(result);
    process.exit(result.drift.length ? 1 : 0);
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    console.error(`web-drift: ${e.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
