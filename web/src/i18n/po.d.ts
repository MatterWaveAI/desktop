/**
 * A `.po` catalogue imported from TypeScript is the compiled messages object:
 * @lingui/vite-plugin compiles it on import, so no generated file is
 * committed (lingui.config.ts, docs/i18n.md).
 */
declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}
