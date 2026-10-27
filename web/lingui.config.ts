import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

/**
 * The message catalogues. en-GB is the source: the English in the components
 * IS the en-GB catalogue, and the other locales translate it. en-US falls
 * back to en-GB so its catalogue holds only the spellings that differ; es-ES
 * has no fallback, so a string it lacks fails `pnpm i18n:check` rather than
 * rendering a hash. docs/i18n.md has the workflow.
 */
export default defineConfig({
  sourceLocale: "en-GB",
  locales: ["en-GB", "en-US", "es-ES"],
  fallbackLocales: { "en-US": "en-GB" },
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}",
      include: ["<rootDir>/src"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/test-setup.ts", "**/dev/**"],
    },
  ],
  // No line numbers: an unrelated edit above a string would otherwise
  // rewrite every catalogue, and the diff is what the check reads.
  format: formatter({ lineNumbers: false }),
  orderBy: "message",
  // Components render without a provider in the unit tests; these wrappers
  // fall back to the global i18n when there is none (src/i18n/runtime.ts).
  runtimeConfigModule: {
    i18n: ["@/i18n/runtime", "i18n"],
    Trans: ["@/i18n/Trans", "Trans"],
    useLingui: ["@/i18n/runtime", "useLingui"],
  },
});
