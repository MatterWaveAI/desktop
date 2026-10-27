import { describe, expect, it } from "vitest";

/**
 * The token contract, as a test so the evidence is repeatable instead of an
 * eyeball claim: every semantic token has a dark variant, and the token
 * PAIRS components actually compose pass WCAG 1.4.3 (4.5:1, normal text)
 * — in the light theme and in the dark theme, separately.
 *
 * The test reads theme.css itself, so a token edit that breaks contrast or
 * drops a dark variant fails here, not in review. (The file is read through
 * a dynamic node:fs import — `?raw` glob imports yield "" for .css files
 * under the Tailwind plugin, and the web tsconfig deliberately has no node
 * types.)
 */

const fsModuleName = "node:fs";
const processModuleName = "node:process";
const { readFileSync } = (await import(/* @vite-ignore */ fsModuleName)) as {
  readFileSync: (path: string, encoding: string) => string;
};
const { cwd } = (await import(/* @vite-ignore */ processModuleName)) as {
  cwd: () => string;
};

// vitest runs with the package root as cwd; a plain path sidesteps
// import.meta.url, which vite-node does not expose as a file: URL in
// modules with top-level await.
const source = readFileSync(`${cwd()}/src/styles/theme.css`, "utf8");

/** Extract a flat CSS block (first `}` closes it — our blocks nest nothing). */
function block(opener: RegExp, label: string): string {
  const match = opener.exec(source);
  if (!match) throw new Error(`theme.css: could not find the ${label} block`);
  const start = source.indexOf("{", match.index);
  const end = source.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error(`theme.css: unbalanced ${label} block`);
  return source.slice(start + 1, end);
}

function declarations(blockText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of blockText.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`theme.css: expected 6-digit hex, got "${hex}"`);
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const primitives = declarations(block(/@theme\s*\{/, "primitive @theme"));
const lightBlock = declarations(block(/:root\s*,\s*\.mw-theme-light\s*\{/, "light semantic"));
const darkBlock = declarations(block(/\.dark\s*,\s*\.mw-theme-dark\s*\{/, "dark semantic"));

/** Semantic colour declarations, var() values resolved to RGB. */
function semanticLayer(
  blockMap: Map<string, string>,
  label: string,
): Map<string, Rgb | null> {
  const out = new Map<string, Rgb | null>();
  for (const [name, value] of blockMap) {
    if (!name.startsWith("mw-color-")) continue;
    const varRef = /^var\(--([\w-]+)\)$/.exec(value);
    if (!varRef) {
      out.set(name, null); // e.g. the scrims' literal rgb() — not contrast-tested
      continue;
    }
    const hex = primitives.get(varRef[1]);
    if (hex === undefined) {
      throw new Error(`theme.css ${label}: --${name} references unknown --${varRef[1]}`);
    }
    out.set(name, parseHex(hex));
  }
  return out;
}

const light = semanticLayer(lightBlock, "light");
const dark = semanticLayer(darkBlock, "dark");

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** The foreground/background pairs components actually compose. */
const PAIRS: [foreground: string, background: string][] = [
  ["text", "surface"],
  ["text", "surface-raised"],
  ["text", "surface-hover"],
  ["text-secondary", "surface"],
  ["text-secondary", "surface-raised"],
  ["text-secondary", "surface-hover"],
  ["text-subtle", "surface"],
  ["text-subtle", "surface-raised"],
  ["text-muted", "surface"],
  ["text-muted", "surface-raised"],
  ["text-muted", "surface-hover"],
  // The primary button: white on the action blue.
  ["accent-foreground", "accent"],
  ["accent-foreground", "accent-hover"],
  // Links and blue text/icons, at rest and hovered.
  ["link", "surface"],
  ["link", "surface-raised"],
  ["link", "surface-hover"],
  ["link-hover", "surface"],
  ["link-hover", "surface-raised"],
  // The selected nav row.
  ["selection-foreground", "selection"],
  ["text-secondary", "selection"],
  ["positive", "surface"],
  ["positive", "surface-raised"],
  ["positive", "positive-subtle"],
  ["info", "info-subtle"],
  ["text", "info-subtle"],
  ["danger", "surface"],
  ["danger", "surface-raised"],
  ["danger", "danger-subtle"],
  ["text", "danger-subtle"],
  ["danger-foreground", "danger-strong"],
  ["warning", "surface"],
  ["warning", "surface-raised"],
  ["warning-foreground", "warning-subtle"],
  ["warning-body", "warning-subtle"],
  ["inverse-foreground", "inverse"],
];

describe("the semantic token layer", () => {
  it("defines every semantic colour token in both themes", () => {
    expect(light.size).toBeGreaterThan(0);
    expect(new Set(light.keys())).toEqual(new Set(dark.keys()));
  });

  it("lists every semantic token on the /dev/tokens page, in theme.css's order", async () => {
    const { SEMANTIC_TOKENS } = await import("../dev/semanticTokens");
    const fromCss = [...lightBlock.keys()]
      .filter((name) => name.startsWith("mw-color-"))
      .map((name) => name.slice("mw-color-".length));
    expect([...SEMANTIC_TOKENS]).toEqual(fromCss);
  });

  it("aliases only tokens the primitive layer defines (no dangling vars)", () => {
    // semanticLayer() throws on a dangling reference while building the maps.
    expect(light.size).toBe(dark.size);
  });

  for (const [themeName, layer] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    describe(`WCAG 1.4.3 contrast — ${themeName} theme`, () => {
      for (const [foreground, background] of PAIRS) {
        it(`${foreground} on ${background} reaches 4.5:1`, () => {
          const fg = layer.get(`mw-color-${foreground}`);
          const bg = layer.get(`mw-color-${background}`);
          if (!fg || !bg) {
            throw new Error(`token pair ${foreground}/${background} missing in ${themeName}`);
          }
          const ratio = contrast(fg, bg);
          expect(ratio, `${themeName}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(
            4.5,
          );
        });
      }
    });
  }
});

const { readdirSync } = (await import(/* @vite-ignore */ fsModuleName)) as {
  readdirSync: (path: string) => string[];
};
const UI_DIR = `${cwd()}/src/components/ui`;
const UI_FILES = readdirSync(UI_DIR).filter((name) => /\.tsx$/.test(name) && !/\.test\./.test(name));
const stylesCss = readFileSync(`${cwd()}/src/styles.css`, "utf8");

/**
 * WCAG 1.4.11 non-text contrast (3:1): the edges and indicators that ARE a
 * control. An input's border is how a sighted user finds the field, and the
 * focus ring is how a keyboard user finds where they are; both were faint
 * (the input border at 1.22:1 light / 1.34:1 dark, the ring at half
 * opacity, about 2.3:1).
 */
const NON_TEXT_PAIRS: [indicator: string, background: string][] = [
  ["border-strong", "surface"],
  ["border-strong", "surface-raised"],
  ["border-strong", "surface-hover"],
  // The focus ring: --ring aliases the focus blue.
  ["focus", "surface"],
  ["focus", "surface-raised"],
  ["focus", "surface-hover"],
  // The selected row's inset bar, against the row it marks.
  ["focus", "selection"],
  // A primary button is found by its fill.
  ["accent", "surface"],
  ["accent", "surface-raised"],
  // Dots, meters and their tracks.
  ["positive-strong", "surface"],
  ["positive-strong", "surface-raised"],
  ["brand-strong", "surface"],
  ["brand-strong", "surface-raised"],
  ["warning-strong", "warning-track"],
  ["warning-strong", "warning-subtle"],
];

/**
 * Text on fills PAIRS does not cover: the pressed/secondary surface, and the
 * dark theme's disabled primary button (text-muted on surface-hover at full
 * opacity, where it used to be indigo at half opacity, about 2:1).
 */
const MORE_TEXT_PAIRS: [foreground: string, background: string][] = [
  ["text", "surface-active"],
  ["text-muted", "surface-hover"],
  // Every disabled button: text-muted on the pressed fill.
  ["text-muted", "surface-active"],
  ["text-secondary", "surface-active"],
];

describe("controls and states", () => {
  for (const [themeName, layer] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    describe(`${themeName} theme`, () => {
      for (const [indicator, background] of NON_TEXT_PAIRS) {
        it(`${indicator} on ${background} reaches 3:1 (1.4.11)`, () => {
          const fg = layer.get(`mw-color-${indicator}`);
          const bg = layer.get(`mw-color-${background}`);
          if (!fg || !bg) throw new Error(`token pair ${indicator}/${background} missing`);
          expect(contrast(fg, bg), `${themeName}: ${indicator} on ${background}`).toBeGreaterThanOrEqual(3);
        });
      }
      for (const [foreground, background] of MORE_TEXT_PAIRS) {
        it(`${foreground} on ${background} reaches 4.5:1`, () => {
          const fg = layer.get(`mw-color-${foreground}`);
          const bg = layer.get(`mw-color-${background}`);
          if (!fg || !bg) throw new Error(`token pair ${foreground}/${background} missing`);
          expect(contrast(fg, bg), `${themeName}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }

  it("keeps the divider border light: border-strong is a separate token", () => {
    // Dividers at 3:1 would be heavy; only controls take the strong edge.
    expect(lightBlock.get("mw-color-border")).not.toBe(lightBlock.get("mw-color-border-strong"));
    expect(darkBlock.get("mw-color-border")).not.toBe(darkBlock.get("mw-color-border-strong"));
  });

  it("points the shadcn --input alias at the strong border", () => {
    expect(stylesCss).toMatch(/--input:\s*var\(--mw-color-border-strong\)/);
    expect(stylesCss).toMatch(/--ring:\s*var\(--mw-color-focus\)/);
  });

  it("draws every focus ring and outline at full strength", () => {
    // A ring at /50 halves its contrast; the pairs above hold only for the
    // solid colour.
    expect(UI_FILES.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    if (/outline-ring\/\d+/.test(stylesCss)) offenders.push("styles.css: outline-ring/N");
    for (const name of UI_FILES) {
      const text = readFileSync(`${UI_DIR}/${name}`, "utf8");
      for (const match of text.matchAll(/focus-visible:ring-(?:ring|destructive)\/\d+/g)) {
        offenders.push(`components/ui/${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Code blocks: shiki paints every token with its theme's colour, so the
 * theme pair is a contrast decision like the tokens above. Each token colour
 * a theme defines must reach 4.5:1 on the background it renders on: in dark,
 * the theme's own background (styles.css forces --shiki-dark-bg); in light,
 * the block is transparent over the page or a raised card, so both.
 *
 * Skipped: rules that paint their own background (diff markers, "invalid")
 * and deliberately de-emphasised markup -- not text a code answer contains.
 */
type ShikiTheme = {
  colors?: Record<string, string>;
  tokenColors?: {
    scope?: string | string[];
    settings?: { foreground?: string; background?: string };
  }[];
};

const SKIPPED_SCOPES = /carriage|ignored|untracked|invalid|deprecated|header|unimplemented|broken/;

function tokenColours(theme: ShikiTheme): [scope: string, colour: Rgb][] {
  const out: [string, Rgb][] = [];
  for (const rule of theme.tokenColors ?? []) {
    const scope = ([] as string[]).concat(rule.scope ?? "").join(",");
    const fg = rule.settings?.foreground;
    if (!fg || rule.settings?.background || SKIPPED_SCOPES.test(scope)) continue;
    if (!/^#[0-9a-fA-F]{6}$/.test(fg)) continue; // alpha variants are decorations, not text
    out.push([scope, parseHex(fg)]);
  }
  return out;
}

function shikiFailures(theme: ShikiTheme, backgrounds: [string, Rgb][]): string[] {
  const bad: string[] = [];
  for (const [scope, colour] of tokenColours(theme)) {
    for (const [bgName, bg] of backgrounds) {
      const ratio = contrast(colour, bg);
      if (ratio < 4.5) bad.push(`${scope.slice(0, 50)} on ${bgName}: ${ratio.toFixed(2)}`);
    }
  }
  return bad;
}

const { SHIKI_THEMES } = await import("./shiki");
const loadTheme = async (name: string): Promise<ShikiTheme> =>
  ((await import(/* @vite-ignore */ `shiki/themes/${name}.mjs`)) as { default: ShikiTheme })
    .default;

describe("code block themes", () => {
  it("dark theme tokens reach 4.5:1 on the theme's background", async () => {
    const theme = await loadTheme(SHIKI_THEMES.dark);
    const bg = parseHex(theme.colors!["editor.background"]);
    expect(tokenColours(theme).length).toBeGreaterThan(20);
    expect(shikiFailures(theme, [["editor.background", bg]])).toEqual([]);
  });

  it("light theme tokens reach 4.5:1 on the page and on a raised card", async () => {
    const theme = await loadTheme(SHIKI_THEMES.light);
    expect(tokenColours(theme).length).toBeGreaterThan(20);
    expect(
      shikiFailures(theme, [
        ["surface", light.get("mw-color-surface")!],
        ["surface-raised", light.get("mw-color-surface-raised")!],
      ]),
    ).toEqual([]);
  });
});
