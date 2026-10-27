import { isAnonymousPath } from "./frontDoor";

/**
 * Where a signed-out visitor was going. A deep link into the app -- a
 * settings pane, the help page, a conversation -- arrives at the front door
 * with no session; Boot remembers it here, the login page says "Sign in to
 * continue", and the first navigation after the session exists takes the
 * person there instead of to the first app.
 *
 * sessionStorage, not the URL: the sign-in leaves this origin for the IdP
 * and comes back through the API's callback to "/", so nothing in the URL
 * survives the trip. A tab's storage does. The entry expires, so a link
 * remembered on Monday does not steer Thursday's sign-in.
 */
const KEY = "mw:continue-to";
const TTL_MS = 15 * 60_000;

/**
 * A path this origin serves and that needs a session: starts with one
 * slash, carries nothing a browser could read as a host, and is not the
 * front door or the root (those have nowhere better to go than the app).
 */
export function continuePath(raw: string | undefined | null): string | undefined {
  if (!raw || raw.length > 1024 || !raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (raw.includes("\\")) return undefined;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return undefined;
  }
  const pathname = raw.split(/[?#]/, 1)[0];
  if (pathname === "/" || isAnonymousPath(pathname)) return undefined;
  return raw;
}

export function rememberDeepLink(raw: string): void {
  const path = continuePath(raw);
  if (!path) return;
  try {
    sessionStorage.setItem(KEY, `${Date.now()} ${path}`);
  } catch {
    // Without storage the sign-in lands on the first app, as before.
  }
}

/** The remembered path, still valid; nothing otherwise. */
export function peekDeepLink(): string | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const split = raw.indexOf(" ");
    const age = Date.now() - Number(raw.slice(0, split));
    if (split < 0 || !Number.isFinite(age) || age > TTL_MS) {
      sessionStorage.removeItem(KEY);
      return undefined;
    }
    return continuePath(raw.slice(split + 1));
  } catch {
    return undefined;
  }
}

/** The remembered path, taken: the next sign-in starts clean. */
export function consumeDeepLink(): string | undefined {
  const path = peekDeepLink();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
  return path;
}

/**
 * Where the first navigation after sign-in goes: the remembered deep link,
 * taken, or the app's default. One place decides, so the index route and a
 * test agree on it.
 */
export function landingAfterSignIn(defaultPath: string): { href: string } | { to: string } {
  const back = consumeDeepLink();
  return back ? { href: back } : { to: defaultPath };
}
