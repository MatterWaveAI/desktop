/**
 * Links out of the app open in the system browser. The webview would
 * otherwise load them in place of the app (or in a bare window for
 * `target="_blank"`), with no address bar, no way back and none of the
 * person's browser sessions -- a reply's links, the help page's, the
 * footer's, Stripe's.
 *
 * One listener for the whole document, after the page's own handlers (so a
 * link a component already handled is left alone): any `<a>` whose URL is
 * http(s) or mailto and not this app's own origin goes to `open_external`
 * instead of the webview. The app's own links stay with the router.
 */
import { desktopOpenExternal, isDesktop } from "./desktopAuth";

const OUTSIDE = new Set(["http:", "https:", "mailto:"]);

/** The URL to hand to the system browser, or null when the webview should follow the link. */
export function externalUrl(href: string | null, origin: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (!OUTSIDE.has(url.protocol)) return null;
  if (url.protocol !== "mailto:" && url.origin === origin) return null;
  return url.href;
}

/**
 * Open a URL outside the app; true when the desktop shell took it. A
 * browser has no shell, so it answers false and the caller navigates as
 * it always has.
 */
export function openOutside(url: string): boolean {
  if (!isDesktop()) return false;
  desktopOpenExternal(url).catch((err: unknown) => {
    console.warn("[desktop] could not open the link in the browser", err);
  });
  return true;
}

function onActivate(event: MouseEvent): void {
  // A left click or a middle click; the right button opens the menu.
  if (event.defaultPrevented || event.button > 1) return;
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
  const url = externalUrl(anchor.getAttribute("href"), location.origin);
  if (!url) return;
  event.preventDefault();
  openOutside(url);
}

/** Install the listener, in the desktop shell only; the answer removes it. */
export function installExternalLinks(): () => void {
  if (!isDesktop()) return () => {};
  document.addEventListener("click", onActivate);
  document.addEventListener("auxclick", onActivate);
  return () => {
    document.removeEventListener("click", onActivate);
    document.removeEventListener("auxclick", onActivate);
  };
}
