import { msg } from "@lingui/core/macro";

/**
 * What the landing page says MatterWave is. Message descriptors, rendered
 * through `i18n._`: a module-level constant is evaluated before any
 * catalogue is active, so it cannot be a translated string itself.
 *
 * Apart from frontDoor.ts, which the Playwright specs import under Node
 * with no macro transform, so nothing it imports may be a macro.
 */

/**
 * The product line on the landing page, after the plain description; the
 * name is the heading above both, so it is not repeated here.
 */
export const PRODUCT_LINE = msg`The platform your AI apps run on.`;

/** What MatterWave is, in one plain sentence: the landing page's lead. */
export const PRODUCT_DESCRIPTION = msg`Chat with hosted language models on the web, in the terminal, in VS Code or on the desktop, and build on the same OpenAI-compatible API with the Python and TypeScript SDKs.`;
