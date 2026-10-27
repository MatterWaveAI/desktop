import type { AuthConfig, Principal } from "../types";
import { apiFetch, configureCsrf } from "./api";

/**
 * Sign-in is the API's job, not the browser's (the BFF shape).
 *
 * `GET /api/auth/login` generates the PKCE verifier, state and nonce, keeps
 * them in a short-lived signed httponly cookie and redirects to Zitadel;
 * `GET /api/auth/callback` checks the state, exchanges the code, verifies the
 * id_token against the nonce and sets the httponly session cookie. The SPA
 * never sees a token: nothing to store, nothing to refresh, nothing an
 * injected script could read, and the streaming transport - which cannot set
 * an Authorization header - rides on the same cookie.
 *
 * This replaced cf-control's browser-side PKCE (authorize URL built here,
 * tokens in sessionStorage, a hand-rolled silent refresh). Both flows existed
 * at once and could not work together: the browser sent Zitadel to the API's
 * callback with no login cookie behind it, and every sign-in ended in "Login
 * attempt expired or missing".
 */

let authConfig: AuthConfig | null = null;

export function getAuthConfig(): AuthConfig | null {
  return authConfig;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const config = await apiFetch<AuthConfig>("/api/auth-config");
  authConfig = config;
  configureCsrf(config.csrf_cookie);
  return config;
}

export function fetchMe(): Promise<Principal> {
  return apiFetch<Principal>("/api/me");
}

/**
 * Whether this person may manage their organisation: an owner or admin by
 * `organization_members` row (`org_role`). Never the platform `roles` claim,
 * which is operator authority for /admin and says nothing about the org --
 * a self-signed-up owner holds no claim at all, and an operator who is not
 * a member is refused by the API.
 */
export function managesOrg(principal: Pick<Principal, "org_role"> | null | undefined): boolean {
  const role = principal?.org_role;
  return role === "owner" || role === "admin";
}

/** The API route that starts the OIDC dance; the config names it. */
export function loginUrl(config: AuthConfig): string {
  return config.login_url ?? "/api/auth/login";
}

/**
 * The SPA page a sign-in may come back to instead of "/": device login's
 * approval page, with the code the terminal printed. The same allowlist the
 * API's callback applies (device_login.allowed_return_path): a path only, no
 * scheme or host, nothing a browser would read as one (`//`, a backslash),
 * and under `/device`. Anything else is undefined -- the default landing,
 * never an error.
 */
export const DEVICE_RETURN_PREFIX = "/device";

export function returnPathForLogin(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 512 || raw.startsWith("//") || raw.includes("\\")) return undefined;
  if (!raw.startsWith("/")) return undefined;
  // Nothing a header or a URL parser could be confused by: no whitespace or
  // control characters, which an encoded query never contains anyway.
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return undefined;
  }
  const path = raw.split(/[?#]/, 1)[0];
  if (path !== DEVICE_RETURN_PREFIX && !path.startsWith(`${DEVICE_RETURN_PREFIX}/`)) {
    return undefined;
  }
  return raw;
}

/**
 * Hand the browser to the API's login route. Never builds an IdP URL itself.
 *
 * Always a user's choice: Boot no longer calls this on a 401 (the front door
 * renders instead), so nothing sends a stranger to Zitadel unasked.
 *
 * `idp` is the org provider handle `/api/auth/idp` answered for the email;
 * the API turns it into the IdP's own selection scope. `returnTo` is where
 * the callback should land afterwards; only what `returnPathForLogin`
 * accepts is sent. `loginHint` is the work email that found the provider.
 */
export function startLogin(
  config: AuthConfig,
  idp?: string,
  returnTo?: string,
  loginHint?: string,
): void {
  markLoginStarting();
  const params = new URLSearchParams();
  if (idp) params.set("idp", idp);
  // The work email an organisation sign-in was typed with: the provider
  // preselects the account, and the callback refuses an identity on
  // another domain (app.auth_callback). Only meaningful with a provider.
  if (idp && loginHint) params.set("login_hint", loginHint);
  const back = returnPathForLogin(returnTo);
  if (back) params.set("return", back);
  rememberLoginReturn(back);
  const query = params.toString();
  location.assign(query ? `${loginUrl(config)}?${query}` : loginUrl(config));
}

/**
 * Where the sign-in in flight is going back to, kept beside the in-flight
 * mark for the same reason it is: Zitadel sends the browser back to /login
 * with only `?authRequest=`, and the way back is no longer in the URL. The
 * restarts LoginPage can make from there -- the org's SSO button, the one
 * retry on an expired request -- must send it to the API again, because a
 * start without a return is a fresh attempt that forgets it.
 *
 * Only a start WITH a return writes it; a start without one clears it, and
 * finishing the sign-in clears it. Per tab, and no older than the API's
 * own login state, which is what the callback honours.
 */
const LOGIN_RETURN_KEY = "mw:login-return";
const LOGIN_RETURN_TTL_MS = 10 * 60_000;

function rememberLoginReturn(back: string | undefined): void {
  try {
    if (back) sessionStorage.setItem(LOGIN_RETURN_KEY, `${Date.now()} ${back}`);
    else sessionStorage.removeItem(LOGIN_RETURN_KEY);
  } catch {
    // Without storage the restarts land on "/", as before.
  }
}

export function rememberedLoginReturn(): string | undefined {
  try {
    const raw = sessionStorage.getItem(LOGIN_RETURN_KEY);
    if (!raw) return undefined;
    const split = raw.indexOf(" ");
    const age = Date.now() - Number(raw.slice(0, split));
    if (split < 0 || !Number.isFinite(age) || age > LOGIN_RETURN_TTL_MS) {
      sessionStorage.removeItem(LOGIN_RETURN_KEY);
      return undefined;
    }
    return returnPathForLogin(raw.slice(split + 1));
  } catch {
    return undefined;
  }
}

/**
 * Whether a sign-in is already on its way to the API.
 *
 * **This is what stops the sign-in loop.** `/api/auth/login` mints a PKCE
 * verifier, a state and a nonce and puts them in one login-state cookie,
 * which `/api/auth/callback` reads back to validate the redirect. There is
 * only ever ONE such cookie, so a second `startLogin` overwrites the first
 * -- and the attempt already in flight then fails its state check at the
 * callback, lands with no session, and the front door renders again.
 *
 * Three callers can race to do that: the verify page's "Sign in" button,
 * LoginPage's effect when it mounts without an `?authRequest=`, and
 * LoginPage's retry on a 400. The flag is set before the navigation and
 * lives in sessionStorage, because the whole point is that it has to
 * survive the page load the navigation causes -- a module variable or a
 * ref is wiped by exactly the redirect it needs to outlive.
 *
 * Per tab (sessionStorage, not localStorage): two tabs signing in are two
 * independent attempts and must not block each other.
 */
const LOGIN_STARTING_KEY = "mw:login-starting";

export function markLoginStarting(): void {
  try {
    sessionStorage.setItem(LOGIN_STARTING_KEY, String(Date.now()));
  } catch {
    // Private mode or blocked storage: fall back to the old behaviour
    // rather than refusing to sign in at all.
  }
}

export function clearLoginStarting(): void {
  try {
    sessionStorage.removeItem(LOGIN_STARTING_KEY);
  } catch {
    // Nothing to clear if it could not be set.
  }
}

/**
 * True while a start is outstanding. Stale marks expire: a navigation that
 * never completed (the API was down, the user hit stop) must not wedge the
 * tab so no further sign-in can begin.
 */
export function loginStartInFlight(): boolean {
  try {
    const raw = sessionStorage.getItem(LOGIN_STARTING_KEY);
    if (!raw) return false;
    const age = Date.now() - Number(raw);
    if (!Number.isFinite(age) || age > LOGIN_START_TTL_MS) {
      clearLoginStarting();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Long enough for a redirect chain, short enough not to wedge a tab. */
const LOGIN_START_TTL_MS = 30_000;

/**
 * Finish a password sign-in. `POST /api/auth/password`
 * answers with the URL that completes the auth request Zitadel handed to our
 * `/login`; it lands on `/api/auth/callback`, which sets the session cookie
 * as it always has. A function rather than an inline `location.assign` so a
 * test can see that the browser was sent there - jsdom cannot navigate.
 */
export function completeLogin(redirect: string): void {
  rememberLoginReturn(undefined);
  location.assign(redirect);
}

export async function signOut(config: AuthConfig): Promise<void> {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } catch {
    // the session may already be gone; continue to the provider's logout
  }
  if (config.auth_mode === "oidc" && config.end_session_endpoint) {
    const url = new URL(config.end_session_endpoint);
    // No id_token_hint - the SPA holds no id_token. Zitadel accepts client_id
    // to identify the app and validate post_logout_redirect_uri instead.
    if (config.client_id) url.searchParams.set("client_id", config.client_id);
    url.searchParams.set("post_logout_redirect_uri", `${location.origin}/`);
    location.assign(url.toString());
  }
}
