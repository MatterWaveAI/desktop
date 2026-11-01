// node --test scripts/: the repository is public and the tracker is not, so
// no tracked file names a ticket. Commit messages may; files may not.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TICKET = /\b[TB]-\d{3,4}\b/;

describe("tracked files", () => {
  it("name no ticket", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    assert.ok(files.length > 0);
    const hits = [];
    for (const file of files) {
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) continue;
      const bytes = fs.readFileSync(full);
      if (bytes.includes(0)) continue;
      bytes
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (TICKET.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    assert.deepEqual(hits, []);
  });
});
