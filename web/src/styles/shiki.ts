/**
 * Syntax highlighting, loaded on first use and themed by the design system.
 *
 * Two jobs:
 *
 *   - Keep shiki out of the main chunk. Its core and the oniguruma engine are
 *     a large share of the bundle, and most pages never render a code block;
 *     the dynamic import fetches it the first time one does.
 *   - Own the colours. Shiki paints with CSS variables rather than a theme's
 *     own hex values, and styles.css points those at the theme's code
 *     tokens (`--mw-color-code-*`): keywords in the brand blue, strings in
 *     emerald, comments muted. So a block follows light and dark with the
 *     rest of the page, and tokens.test.ts holds every one of them at 4.5:1
 *     on the surfaces a block sits on. A caller's own `themes` is ignored
 *     for that reason.
 */

/** The prefix of the variables shiki's output reads; styles.css defines them. */
export const CODE_VARIABLE_PREFIX = "--mw-code-";

export async function codeToHtml(
  code: string,
  options: { lang: string; themes?: unknown },
): Promise<string> {
  const shiki = await import("shiki");
  const theme = shiki.createCssVariablesTheme({
    name: "mw-code",
    variablePrefix: CODE_VARIABLE_PREFIX,
    fontStyle: true,
  });
  return shiki.codeToHtml(code, { lang: options.lang, theme });
}
