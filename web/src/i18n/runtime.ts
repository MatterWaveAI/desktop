import { i18n } from "@lingui/core";
import { LinguiContext, type I18nContext } from "@lingui/react";
import { useContext } from "react";

/**
 * What the Lingui macros compile to (lingui.config.ts, runtimeConfigModule),
 * with `Trans` beside it in Trans.tsx.
 *
 * The app mounts one I18nProvider (main.tsx) and every component under it
 * re-renders when the locale changes. The unit tests mount components bare,
 * with no provider, as they always have; rather than wrap three hundred
 * tests, `useLingui` and `Trans` fall back to the global `i18n` -- which
 * test-setup.ts has activated as en-GB -- when there is no context above
 * them.
 */

export { i18n };

const bare: I18nContext = { i18n, _: i18n._.bind(i18n) };

export function useLingui(): I18nContext {
  return useContext(LinguiContext) ?? bare;
}
