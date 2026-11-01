// Keeps web/ -- the platform's SPA, bundled into this app -- equal to one
// named platform commit plus this app's own changes to it.
//
//   spa/upstream.json     the platform commit web/ is synced to, and a digest
//                         of that commit's SPA as copied (what `check` proves)
//   spa/patches/**.patch  one patch per file the desktop changes or adds,
//                         at the file's own path under web/
//
// Commands (run from anywhere; `--root` points at another checkout, for tests):
//
//   node scripts/spa-sync.mjs check
//       web/ minus the patches must be exactly the pinned commit's SPA, and
//       the patches must re-apply to give web/ back. CI runs this; it needs
//       no platform checkout.
//
//   node scripts/spa-sync.mjs pull --source <platform checkout> [--ref develop]
//       Re-sync: copy the platform's web/ at <ref>, re-apply the desktop's
//       changes with a three-way merge, rewrite the patches and the pin. A
//       change that collides with the platform's is left in web/ with
//       conflict markers and the command fails, naming the files; resolve
//       them, then run `refresh --source <platform checkout>`.
//       `--base <ref>` names the commit web/ was copied from when there is no
//       pin yet (the first sync).
//
//   node scripts/spa-sync.mjs refresh [--source <platform checkout>]
//       Rewrite the patches from web/ as it is now -- after editing the SPA
//       here, or after resolving a pull's conflicts. Without --source the
//       pinned commit's SPA is rebuilt from the committed tree.
//
// Copied: the platform's web/ except what only the platform runs (its
// Playwright suites and their output, the TypeScript build cache): the
// `exclude` list in spa/upstream.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SPA = "web";
const PIN = "spa/upstream.json";
const PATCHES = "spa/patches";
const DEFAULT_EXCLUDE = ["e2e", "test-results", "tsconfig.tsbuildinfo"];

class SyncError extends Error {}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitText(cwd, args, input) {
  return git(cwd, args, input).toString("utf8");
}

/** Like `git`, but a non-zero exit is an answer, not a crash. */
function gitTry(cwd, args, input) {
  try {
    return { ok: true, out: gitText(cwd, args, input) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The digest the pin records: every file's path and content hash, sorted.
 * File modes are left out -- a Windows checkout has no executable bit to
 * agree on.
 */
export function digestOf(files) {
  const lines = [...files.keys()].sort().map((p) => `${p}\0${sha256(files.get(p))}\n`);
  return `sha256-${sha256(lines.join(""))}`;
}

function excluded(rel, exclude) {
  return exclude.some((e) => rel === e || rel.startsWith(`${e}/`));
}

/** Blobs by object id, read through one `cat-file --batch`. */
function readBlobs(repo, oids) {
  if (!oids.length) return new Map();
  const out = git(repo, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  const blobs = new Map();
  let at = 0;
  for (const oid of oids) {
    const eol = out.indexOf(0x0a, at);
    const [, , size] = out.subarray(at, eol).toString("utf8").split(" ");
    const start = eol + 1;
    blobs.set(oid, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}

/** `<rev>:<dir>` as a path -> content map, relative to `dir`. */
function readTree(repo, rev, dir, exclude = []) {
  const listing = gitText(repo, ["ls-tree", "-r", "-z", "--full-tree", rev, "--", dir]);
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [, type, oid] = meta.split(" ");
      return { type, oid, rel: file.slice(dir.length + 1) };
    })
    .filter((e) => e.type === "blob" && !excluded(e.rel, exclude));
  const blobs = readBlobs(repo, [...new Set(entries.map((e) => e.oid))]);
  return new Map(entries.map((e) => [e.rel, blobs.get(e.oid)]));
}

/** The working tree's files under `dir`: tracked, plus new ones git does not ignore. */
function readWorking(root, dir) {
  const listing = gitText(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir]);
  const files = new Map();
  for (const file of new Set(listing.split("\0").filter(Boolean))) {
    const full = path.join(root, file);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      files.set(file.slice(dir.length + 1), fs.readFileSync(full));
    }
  }
  return files;
}

/** spa/patches as `web/`-relative path -> patch text. */
function patchesFrom(files) {
  const patches = new Map();
  for (const [rel, content] of files) {
    if (rel.endsWith(".patch")) patches.set(rel.slice(0, -".patch".length), content);
  }
  return patches;
}

function readPin(root) {
  const file = path.join(root, PIN);
  if (!fs.existsSync(file)) return null;
  const pin = JSON.parse(fs.readFileSync(file, "utf8"));
  return { exclude: DEFAULT_EXCLUDE, ...pin };
}

function writePin(root, pin) {
  const file = path.join(root, PIN);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { commit, exclude, digest } = pin;
  fs.writeFileSync(file, `${JSON.stringify({ commit, exclude, digest }, null, 2)}\n`);
}

/** A scratch repository holding `files`; removed by the caller. */
function scratchRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spa-sync-"));
  // No template (no sample hooks to copy), and the settings written straight
  // into the config: every git process costs, and this runs a few dozen.
  git(dir, ["init", "-q", "--template="]);
  fs.appendFileSync(
    path.join(dir, ".git", "config"),
    "[user]\n\tname = spa-sync\n\temail = spa-sync@localhost\n" +
      "[core]\n\tautocrlf = false\n\tfilemode = false\n" +
      "[commit]\n\tgpgsign = false\n",
  );
  if (files) writeFiles(dir, files);
  return dir;
}

function writeFiles(dir, files) {
  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Every file in a scratch repo's work tree, `.git` aside. */
function listFiles(dir) {
  const files = new Map();
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (!sub && entry.name === ".git") continue;
      if (entry.isDirectory()) walk(rel);
      else files.set(rel, fs.readFileSync(path.join(dir, rel)));
    }
  };
  walk("");
  return files;
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", message]);
}

function replaceWorkTree(dir, files) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== ".git") fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  writeFiles(dir, files);
}

function withScratch(files, fn) {
  const dir = scratchRepo(files);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply each patch to a scratch copy of `files`, forwards or in reverse. */
function applyPatches(files, patches, reverse) {
  return withScratch(files, (dir) => {
    const failed = [];
    for (const [rel, patch] of patches) {
      const args = ["apply", "--binary", "--whitespace=nowarn"];
      if (reverse) args.push("--reverse");
      const res = gitTry(dir, args, patch);
      if (!res.ok) failed.push(`${rel}: ${res.out.trim()}`);
    }
    return { files: listFiles(dir), failed };
  });
}

/** One patch per changed file, from `pristine` to `current`. */
export function makePatches(pristine, current) {
  return withScratch(pristine, (dir) => {
    commitAll(dir, "pristine");
    replaceWorkTree(dir, current);
    git(dir, ["add", "-A"]);
    const changed = gitText(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames"])
      .split("\0")
      .filter(Boolean);
    const patches = new Map();
    for (const rel of changed) {
      patches.set(
        rel,
        git(dir, [
          "diff",
          "--cached",
          "--binary",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          rel,
        ]),
      );
    }
    return patches;
  });
}

function writePatches(root, patches) {
  fs.rmSync(path.join(root, PATCHES), { recursive: true, force: true });
  for (const [rel, patch] of patches) {
    const full = path.join(root, PATCHES, `${rel}.patch`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, patch);
  }
}

function sameFiles(a, b) {
  if (a.size !== b.size) return false;
  for (const [rel, content] of a) {
    if (!b.has(rel) || !b.get(rel).equals(content)) return false;
  }
  return true;
}

function differences(a, b) {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((rel) => !a.has(rel) || !b.has(rel) || !a.get(rel).equals(b.get(rel))).sort();
}

/**
 * The pinned commit's SPA, rebuilt from web/ and the patches: reverse the
 * patches, prove the result is what the pin's digest names, and prove the
 * patches give `current` back.
 */
function pristineOf(pin, current, patches) {
  const back = applyPatches(current, patches, true);
  if (back.failed.length) {
    throw new SyncError(
      `these patches no longer match web/:\n  ${back.failed.join("\n  ")}\n` +
        "web/ was edited without `refresh`, or a patch was edited by hand.",
    );
  }
  const digest = digestOf(back.files);
  if (digest !== pin.digest) {
    throw new SyncError(
      `web/ minus the patches is not platform ${pin.commit.slice(0, 12)} (digest ${digest}, ` +
        `pinned ${pin.digest}).\nweb/ changed without \`refresh\`, or the pin was edited by hand.`,
    );
  }
  const forth = applyPatches(back.files, patches, false);
  if (forth.failed.length || !sameFiles(forth.files, current)) {
    const off = forth.failed.length ? forth.failed : differences(forth.files, current);
    throw new SyncError(`the patches do not rebuild web/ exactly:\n  ${off.join("\n  ")}`);
  }
  return back.files;
}

function resolveCommit(source, ref) {
  const res = gitTry(source, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!res.ok) throw new SyncError(`${ref} is not a commit in ${source}`);
  return res.out.trim();
}

/** The platform's SPA at `commit`, as this app copies it. */
function exportUpstream(source, commit, exclude) {
  const files = readTree(source, commit, SPA, exclude);
  if (!files.size) throw new SyncError(`${commit.slice(0, 12)} has no ${SPA}/ to copy`);
  return files;
}

function check(root) {
  const pin = readPin(root);
  if (!pin) throw new SyncError(`no ${PIN}: run \`pull\` first`);
  const current = readWorking(root, SPA);
  const patches = patchesFrom(readWorking(root, PATCHES));
  pristineOf(pin, current, patches);
  console.log(
    `spa-sync: web/ is platform ${pin.commit.slice(0, 12)} plus ${patches.size} desktop patch(es).`,
  );
}

function refresh(root, source) {
  const pin = readPin(root);
  if (!pin) throw new SyncError(`no ${PIN}: run \`pull\` first`);
  let pristine;
  if (source) {
    pristine = exportUpstream(source, pin.commit, pin.exclude);
  } else {
    // The committed tree is the pinned commit plus the committed patches,
    // which holds until a pull moves the pin; then the platform is needed.
    const committed = readTree(root, "HEAD", SPA);
    const committedPatches = patchesFrom(readTree(root, "HEAD", PATCHES));
    try {
      pristine = pristineOf(pin, committed, committedPatches);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      throw new SyncError(
        `${e.message}\nThe committed tree cannot rebuild the pinned commit; pass --source <platform checkout>.`,
      );
    }
  }
  if (digestOf(pristine) !== pin.digest) {
    throw new SyncError(`platform ${pin.commit.slice(0, 12)} does not match the pinned digest`);
  }
  const current = readWorking(root, SPA);
  const conflicted = [...current].filter(([, c]) => /^<{7} |^>{7} /m.test(c.toString("utf8")));
  if (conflicted.length) {
    throw new SyncError(`conflict markers remain in:\n  ${conflicted.map(([r]) => r).join("\n  ")}`);
  }
  const patches = makePatches(pristine, current);
  writePatches(root, patches);
  console.log(`spa-sync: ${patches.size} desktop patch(es) written to ${PATCHES}/.`);
  check(root);
}

function pull(root, source, ref, baseRef) {
  const pin = readPin(root);
  const exclude = pin?.exclude ?? DEFAULT_EXCLUDE;
  const current = readWorking(root, SPA);
  let oldPristine;
  if (baseRef) {
    oldPristine = exportUpstream(source, resolveCommit(source, baseRef), exclude);
  } else if (pin) {
    oldPristine = pristineOf(pin, current, patchesFrom(readWorking(root, PATCHES)));
  } else if (current.size) {
    throw new SyncError(`web/ exists without ${PIN}: pass --base <the commit it was copied from>`);
  } else {
    oldPristine = new Map();
  }
  const commit = resolveCommit(source, ref);
  const next = exportUpstream(source, commit, exclude);

  // The three-way merge, in a scratch repository: the old commit, the
  // desktop's tree on top of it, and the new commit the desktop's change is
  // replayed onto.
  const { merged, conflicts } = withScratch(oldPristine, (dir) => {
    commitAll(dir, "platform, old");
    git(dir, ["branch", "-q", "desktop"]);
    git(dir, ["checkout", "-q", "desktop"]);
    replaceWorkTree(dir, current);
    commitAll(dir, "desktop");
    git(dir, ["checkout", "-q", "-"]);
    replaceWorkTree(dir, next);
    commitAll(dir, "platform, new");
    const picked = gitTry(dir, ["cherry-pick", "--allow-empty", "--keep-redundant-commits", "desktop"]);
    const unmerged = picked.ok
      ? []
      : gitText(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    if (!picked.ok && !unmerged.length) throw new SyncError(`the merge failed:\n${picked.out}`);
    return { merged: listFiles(dir), conflicts: unmerged };
  });

  for (const rel of current.keys()) {
    if (!merged.has(rel)) fs.rmSync(path.join(root, SPA, rel), { force: true });
  }
  writeFiles(path.join(root, SPA), merged);
  writePin(root, { commit, exclude, digest: digestOf(next) });

  if (conflicts.length) {
    throw new SyncError(
      `web/ is now platform ${commit.slice(0, 12)}, but the desktop's changes to these files collide ` +
        `with the platform's and carry conflict markers:\n  ${conflicts.join("\n  ")}\n` +
        `Resolve them in web/, then run: node scripts/spa-sync.mjs refresh --source ${source}`,
    );
  }
  const patches = makePatches(next, merged);
  writePatches(root, patches);
  console.log(
    `spa-sync: web/ is platform ${commit.slice(0, 12)} plus ${patches.size} desktop patch(es).`,
  );
  check(root);
}

function main() {
  const command = process.argv[2];
  const root = path.resolve(arg("root") ?? fileURLToPath(new URL("..", import.meta.url)));
  const source = arg("source") && path.resolve(arg("source"));
  try {
    if (command === "check") check(root);
    else if (command === "refresh") refresh(root, source);
    else if (command === "pull") {
      if (!source) throw new SyncError("pull needs --source <platform checkout>");
      pull(root, source, arg("ref") ?? "develop", arg("base"));
    } else {
      throw new SyncError("usage: spa-sync.mjs check | refresh [--source DIR] | pull --source DIR [--ref REF] [--base REF]");
    }
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    console.error(`spa-sync: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
