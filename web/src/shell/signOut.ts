import type { AuthConfig } from "../types";
import { signOut } from "../lib/auth";
import { desktopReload, desktopSignOut, isDesktop } from "../lib/desktopAuth";

/**
 * Sign out from wherever the shell offers it (the user menu, the account
 * pane, the suspended and verification notices).
 *
 * In a browser that is the BFF's `/api/logout` and then Zitadel's
 * end_session, which sends the browser back to `/`. In the desktop shell the
 * session is not a cookie but the tokens in the OS keychain, and the webview
 * must never be sent to Zitadel's end_session: it would land the webview on
 * the IdP with nothing to return to. The native side revokes and clears
 * instead, and the page reloads into Boot, which finds no token and shows
 * the front door.
 */
export async function shellSignOut(config: AuthConfig): Promise<void> {
  if (isDesktop()) {
    await desktopSignOut();
    desktopReload();
    return;
  }
  await signOut(config);
}
