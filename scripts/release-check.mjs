// The release gate: a tag ships only when every manifest already says its
// version and the CHANGELOG has a section for it. The section is also the
// release's notes.
//
//   node scripts/release-check.mjs --tag v0.3.0 [--notes-out notes.md] [--root <checkout>]
//
// Checked: package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json
// carry the tag's version (without the v), and CHANGELOG.md has a
// `## [X.Y.Z] - YYYY-MM-DD` section with something in it.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = path.resolve(arg("root") ?? fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const problems = [];

const tag = arg("tag") ?? "";
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  console.error(`release-check: ${JSON.stringify(tag)} is not a version tag (v1.2.3)`);
  process.exit(1);
}
const version = match[1];

const manifests = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  // The [package] table's version: the first `version =` after `[package]`.
  "src-tauri/Cargo.toml": /\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(read("src-tauri/Cargo.toml"))?.[1],
};
for (const [file, found] of Object.entries(manifests)) {
  if (found !== version) problems.push(`${file} says ${found ?? "no version"}, the tag says ${version}`);
}

/** The body of `## [version]`, up to the next `## ` heading, trimmed; null when there is none. */
function changelogSection(changelog) {
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replace(/[.]/g, "\\.");
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => !/^\[[^\]]+\]: /.test(l))
    .join("\n")
    .trim();
}

const notes = changelogSection(read("CHANGELOG.md"));
if (notes === null) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
else if (!notes) problems.push(`CHANGELOG.md's ${version} section is empty`);

if (problems.length) {
  console.error(`release-check: ${tag} cannot ship:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const out = arg("notes-out");
if (out) fs.writeFileSync(out, `${notes}\n`);
console.log(`release-check: ${tag} matches every manifest and has release notes.`);
