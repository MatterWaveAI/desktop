/**
 * Stripe from the desktop app. Checkout and the customer portal are pages on
 * Stripe's origin: inside the webview they would replace the app, and
 * Stripe sends the person back to the web origin, where the webview has no
 * session. So the desktop opens them in the system browser, and reads the
 * billing status again whenever its window comes back to the front -- the
 * person finishing in the browser and switching back is the return.
 */
import { useEffect } from "react";
import { isDesktop } from "./desktopAuth";
import { openOutside } from "./desktopLinks";

/**
 * Go to a Stripe page: the system browser in the desktop app, this tab
 * anywhere else. True when it went to the browser and the app stays put.
 */
export function goToStripe(url: string): boolean {
  if (openOutside(url)) return true;
  window.location.assign(url);
  return false;
}

/**
 * Call `refresh` each time the desktop window is focused again. Nothing in
 * a browser, where Stripe's return URL brings the tab itself back.
 */
export function useRefreshOnReturn(refresh: () => void): void {
  useEffect(() => {
    if (!isDesktop()) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
}
