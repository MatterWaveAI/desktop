/**
 * The SPA inside the desktop shell (clients/desktop): a bearer instead of the
 * cookie.
 *
 * In a browser the session is the BFF's httponly cookie. The desktop app
 * bundles this build, so its origin is the webview's (`tauri://localhost`,
 * `http://tauri.localhost` on Windows) and the API's cookie never applies;
 * the native side signs in through the system browser instead and keeps the
 * tokens in the OS keychain. This module asks it for the current access token
 * and feeds `setTokenGetter`, the one place every request type
 * (`apiFetch`, `apiStream`, the XHR upload through `currentToken`) reads.
 *
 * Nothing here runs in a browser: `installDesktopAuth` returns false unless
 * the Tauri globals are present, and the Tauri package is never a dependency
 * of this app (see `loadInvoke`).
 */
import { setTokenGetter } from "./api";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface AccessToken {
  access_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export interface DesktopAppInfo {
  /** The release string, the same one the API reports as MW_RELEASE. */
  version: string;
  api_base_url: string | null;
}

interface TauriWindow {
  __TAURI_INTERNALS__?: { invoke?: Invoke };
  __TAURI__?: unknown;
}

/** Refresh this long before expiry; the native side uses the same margin. */
const REFRESH_AHEAD_MS = 60_000;
/** Floor on the refresh timer, so a clock skew cannot spin it. */
const MIN_REFRESH_DELAY_MS = 5_000;
/** The largest delay `setTimeout` honours; anything above wraps to about 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as TauriWindow;
  return w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined;
}

let invokeFn: Invoke | null = null;
let cached: AccessToken | null = null;
let info: DesktopAppInfo | null = null;
let ready: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * `@tauri-apps/api/core` when it resolves, the injected internals otherwise.
 * The import is left to runtime (`@vite-ignore`) so neither the web build nor
 * vitest needs the package; in the bundled app the bare specifier usually does
 * not resolve either, and the package's `invoke` is a thin wrapper over
 * `__TAURI_INTERNALS__.invoke`, which Tauri injects into every page.
 */
async function loadInvoke(): Promise<Invoke> {
  if (invokeFn) return invokeFn;
  const specifier = "@tauri-apps/api/core";
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as { invoke: Invoke };
    invokeFn = mod.invoke;
  } catch {
    const internals = (window as unknown as TauriWindow).__TAURI_INTERNALS__;
    if (!internals?.invoke) throw new Error("desktop shell without an IPC bridge");
    invokeFn = internals.invoke.bind(internals) as Invoke;
  }
  return invokeFn;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await loadInvoke())<T>(cmd, args);
}

/** Ask the native side for the token, refreshing there when `force`. */
async function pullToken(force = false): Promise<AccessToken | null> {
  try {
    cached = await call<AccessToken | null>("get_access_token", { force });
  } catch {
    // Offline with an expired token, or the IdP down: send nothing and let
    // the API's 401 put the app on the front door, rather than retry here.
    cached = null;
  }
  scheduleRefresh();
  return cached;
}

/**
 * The getter `api.ts` calls is synchronous, so the token is held here and
 * renewed ahead of expiry; the native side does the actual refresh.
 */
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  if (!cached) return;
  const delay = cached.expires_at * 1000 - REFRESH_AHEAD_MS - Date.now();
  // Clamped above as well as below: a timer past 2^31-1 ms overflows to
  // ~1 ms in every engine, which would turn a long-lived token into a
  // refresh loop. The timer is re-armed on each pull, so capping it only
  // costs one early look.
  const bounded = Math.min(Math.max(delay, MIN_REFRESH_DELAY_MS), MAX_TIMER_MS);
  refreshTimer = setTimeout(() => void pullToken(), bounded);
}

/**
 * Whether this page is the bundled build, as opposed to `pnpm tauri dev`
 * pointing the window at the Vite server (whose proxy already makes `/api`
 * same-origin).
 */
function isBundledOrigin(): boolean {
  return location.protocol === "tauri:" || location.hostname === "tauri.localhost";
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/") || path === "/healthz" || path === "/readyz";
}

/** The API URL for a same-origin path, when the bundled app needs one. */
function toApi(path: string): string {
  const base = info?.api_base_url;
  if (!base || !isBundledOrigin() || !isApiPath(path)) return path;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Wrap `fetch` so every API call (a) waits for the first token, (b) reaches
 * the API's origin from the bundled app, and (c) gets one retry after a 401
 * with a forced refresh: a token revoked or rotated early is the one case the
 * expiry clock cannot foresee. One retry only; a second 401 is a real answer.
 */
function wrapFetch(): void {
  const baseFetch = window.fetch.bind(window);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input !== "string" || !isApiPath(input)) return baseFetch(input, init);
    await ready;
    const send = (token: string | null) => {
      const headers = new Headers(init?.headers);
      // apiFetch computed its headers before the first token arrived; fill
      // the gap rather than send the very first request unauthenticated.
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const url = toApi(input);
      // Cross-origin, the bearer is the whole story; asking for credentials
      // would only make the API's CORS answer stricter for no benefit.
      const credentials = url === input ? init?.credentials : "omit";
      return baseFetch(url, { ...init, headers, credentials });
    };
    const res = await send(cached?.access_token ?? null);
    const replayable = !(init?.body instanceof ReadableStream);
    if (res.status !== 401 || !cached || !replayable) return res;
    const fresh = await pullToken(true);
    return fresh ? send(fresh.access_token) : res;
  };
  window.fetch = wrapped as typeof window.fetch;
}

/** The attachment upload uses XHR; it needs the same base as `fetch`. */
function wrapXhrOpen(): void {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const target = typeof url === "string" ? toApi(url) : url;
    return (open as (...a: unknown[]) => void).call(this, method, target, ...rest);
  } as typeof open;
}

/**
 * Install the bearer path when running inside the desktop shell. Returns
 * whether it did; in a browser it does nothing and the cookie path stands.
 */
export function installDesktopAuth(): boolean {
  if (!isDesktop()) return false;
  if (ready) return true;
  setTokenGetter(() => cached?.access_token ?? null);
  ready = (async () => {
    try {
      info = await call<DesktopAppInfo>("app_info");
    } catch {
      info = null;
    }
    await pullToken();
  })();
  wrapFetch();
  wrapXhrOpen();
  return true;
}

/** Resolves once the first token request has answered, whatever it said. */
export function desktopReady(): Promise<void> {
  return ready ?? Promise.resolve();
}

/** Sign in through the system browser; resolves once the token is held. */
export async function desktopSignIn(): Promise<void> {
  await call<void>("sign_in");
  await pullToken();
}

/** Revoke and forget the tokens on this machine. */
export async function desktopSignOut(): Promise<void> {
  clearTimeout(refreshTimer);
  cached = null;
  await call<void>("sign_out");
}

/**
 * Tell the native side that a generation finished, so it can raise the OS
 * notification -- which it does only when its window is unfocused, the one
 * state in which a reply can land unseen (`lib.rs`). Fire-and-forget: a
 * notification is never worth an error path, and in a browser there is no
 * native side, so this is nothing at all. The copy is fixed here; reply
 * content never goes into a notification.
 */
export function notifyGenerationComplete(): void {
  if (!isDesktop()) return;
  call<void>("notify_generation_complete", {
    title: "MatterWave",
    body: "Your reply is ready.",
  }).catch(() => {});
}

/**
 * Back to Boot after the keychain changed hands (a sign-in or a sign-out):
 * a whole-page load, so nothing cached from the previous identity -- the
 * conversation list, the principal, this module's token -- survives. The
 * browser's equivalent is the redirect the API's callback or Zitadel's
 * end_session sends; the desktop has neither, so the page sends itself.
 */
export function desktopReload(): void {
  location.replace("/");
}

/** Version and API base, for "report a problem" beside the request id. */
export async function desktopAppInfo(): Promise<DesktopAppInfo | null> {
  await desktopReady();
  return info;
}
