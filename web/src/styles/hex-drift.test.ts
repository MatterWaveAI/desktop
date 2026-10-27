import { describe, expect, it } from "vitest";

/**
 * The design-system rule, as a check: "a grep for hex literals outside theme.css
 * returns nothing." theme.css is the single home for colour values; anywhere
 * else a hex colour appears is drift.
 *
 * The scan walks web/src on disk (dynamic node:fs import — the web tsconfig
 * deliberately has no node types) and the pattern is scoped to colour usages
 * so anchors, URL fragments and DOM ids do not false-positive: a match is
 * ignored when the text immediately before it shows it is a fragment
 * reference (href="#…", url(#…), querySelector('#…'), getElementById('#…'),
 * id="#…", aria-*="#…").
 */

const fsModuleName = "node:fs";
const processModuleName = "node:process";
const { readdirSync, readFileSync, statSync } = (await import(
  /* @vite-ignore */ fsModuleName
)) as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: string) => string;
  statSync: (path: string) => { isDirectory(): boolean };
};
const { cwd } = (await import(/* @vite-ignore */ processModuleName)) as {
  cwd: () => string;
};

// vitest runs with the package root as cwd; plain paths sidestep
// import.meta.url, which vite-node does not expose as a file: URL in
// modules with top-level await.
const SRC_ROOT = `${cwd()}/src`;
const THEME_CSS = `${SRC_ROOT}/styles/theme.css`;
const ALLOWED = new Set([THEME_CSS]);

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const HEX_COLOUR =
  /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

/** Tailwind arbitrary lengths - a bracketed px/rem/em value on any utility. */
const ARBITRARY_LENGTH = /\[[0-9.]+(?:px|rem|em)\]/g;

/** Matches when the text preceding a `#` marks it as a fragment reference. */
const FRAGMENT_CONTEXT =
  /(?:href\s*=\s*["'][# ]*|url\(\s*["']?|querySelector\(\s*["']|getElementById\(\s*["']|closest\(\s*["']|id\s*=\s*["']|aria-[\w-]+\s*=\s*["'])$/;

function isColourLiteral(line: string, match: string): boolean {
  const before = line.slice(0, line.indexOf(match));
  return !FRAGMENT_CONTEXT.test(before);
}

describe("hex colour literals outside theme.css", () => {
  it("returns nothing across web/src", () => {
    const files = listFiles(SRC_ROOT).filter(
      (file) => /\.(ts|tsx|css)$/.test(file) && !ALLOWED.has(file),
    );
    expect(files.length, "the scan found source files to check").toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const relPath = file.slice(SRC_ROOT.length);
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          for (const match of line.matchAll(HEX_COLOUR)) {
            if (isColourLiteral(line, match[0])) {
              violations.push(`${relPath}:${index + 1}: ${match[0]}`);
            }
          }
        });
    }
    expect(violations, "hex colour literals found outside theme.css").toEqual([]);
  });

  it("finds no hardcoded radius or spacing either", () => {
    // The rule says colour, radius AND spacing come from a token, but
    // the hex scan only covers colour. Bracketed ring, min-width and radius
    // lengths all passed it while the clause read as enforced - seven were
    // sitting in the vendored set.
    const files = listFiles(SRC_ROOT).filter(
      (file) => /\.(ts|tsx|css)$/.test(file) && !ALLOWED.has(file),
    );
    expect(files.length, "the scan found source files to check").toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const relPath = file.slice(SRC_ROOT.length);
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          // calc() may offset a token by a raw value; the token is still the
          // source of the size.
          if (/calc\(/.test(line)) return;
          for (const match of line.matchAll(ARBITRARY_LENGTH)) {
            violations.push(`${relPath}:${index + 1}: ${match[0]}`);
          }
        });
    }
    expect(
      violations,
      "hardcoded px/rem/em lengths outside theme.css - use a token",
    ).toEqual([]);
  });

  it("keeps components/ui on the radius scale", () => {
    // The vendored set had arbitrary radii (`rounded-[min(var(--radius-md),
    // 10px)]`) and steps the scale does not define (`rounded-4xl`), which
    // the length scan above cannot see. Every radius in the primitives must
    // be a named step from theme.css, `full`, `none`, or `[inherit]`; bare
    // `rounded` is out too, since it is Tailwind's default rather than one
    // of ours.
    const SCALE = new Set(["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "full"]);
    const SIDE = "(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee)";
    const RADIUS = new RegExp(
      `(?<![\\w-])rounded(?:-${SIDE})?(?:-(\\[[^\\]]*\\]|\\([^)]*\\)|[\\w.]+))?(?![\\w-])`,
      "g",
    );
    const uiDir = `${SRC_ROOT}/components/ui`;
    const files = listFiles(uiDir).filter((file) => /\.tsx$/.test(file) && !/\.test\./.test(file));
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of files) {
      const relPath = file.slice(SRC_ROOT.length);
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          // Prose in comments may say "rounded"; only class strings count.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          for (const match of line.matchAll(RADIUS)) {
            const step = match[1];
            if (step !== undefined && (SCALE.has(step) || step === "[inherit]")) continue;
            violations.push(`${relPath}:${index + 1}: ${match[0]}`);
          }
        });
    }
    expect(violations, "radius off the scale in components/ui").toEqual([]);
  });

  it("still scans theme.css's neighbours (the check is not a no-op)", () => {
    // If the allowlist ever whitelisted the whole tree, the first test proves
    // nothing. theme.css itself must contain hex values, and it must be the
    // only file the scan skips.
    expect(readFileSync(THEME_CSS, "utf8").match(HEX_COLOUR)!.length).toBeGreaterThan(30);
    expect(ALLOWED.size).toBe(1);
  });
});
