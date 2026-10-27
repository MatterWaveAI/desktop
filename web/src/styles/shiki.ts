/**
 * Syntax highlighting, loaded on first use and themed by the design system.
 *
 * Two jobs:
 *
 *   - Keep shiki out of the main chunk. Its core and the oniguruma engine are
 *     a large share of the bundle, and most pages never render a code block;
 *     the dynamic import fetches it the first time one does.
 *   - Own the theme pair. The colours a code block shows are a contrast
 *     decision like any token, so they are fixed here and asserted in
 *     tokens.test.ts (every token colour at 4.5:1 on the surface it sits
 *     on). The previous dark theme, github-dark, put comments at 3.04:1.
 *     A caller's own `themes` is ignored for that reason.
 */

export const SHIKI_THEMES = {
  light: "github-light-high-contrast",
  dark: "github-dark-default",
} as const;

export async function codeToHtml(
  code: string,
  options: { lang: string; themes?: unknown },
): Promise<string> {
  const shiki = await import("shiki");
  return shiki.codeToHtml(code, { lang: options.lang, themes: SHIKI_THEMES });
}
