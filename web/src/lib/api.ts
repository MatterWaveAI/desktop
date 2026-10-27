export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The parsed error body, when there was one. `message` is the string
     * `detail` for the usual case; the signup and login answers carry
     * more - a pydantic list of `{loc, msg}` on a 422, a `status` beside the
     * detail on a 403 - and the page rendering them needs the whole thing.
     */
    readonly body?: unknown,
    /**
     * The correlation id for the request that failed.
     *
     * Read from the `X-Request-Id` response header, falling back to the
     * `request_id` the API puts in every error body. Held on the error
     * because the component that eventually renders it is several layers
     * from the fetch, and re-deriving it there is not possible: the response
     * is gone.
     *
     * Null when neither was present - an error raised before the API
     * answered, a response from something that is not our API. Nothing may
     * invent one; "no id" is a fact worth showing honestly, because an id
     * that does not appear in the logs wastes the support conversation it
     * was supposed to start.
     */
    readonly requestId: string | null = null,
    /**
     * The `X-MatterWave-*` response headers, lower-cased, when there were
     * any. A 402 (entitlement_gate.UpgradeRequired) puts its machine-readable
     * half here -- which feature, which plan, which plan has it -- precisely
     * so no page has to parse the prose `detail`; dropping the headers at the
     * fetch would force exactly that. Only our own headers: a Response's
     * header bag is otherwise noise to hold on an error object.
     */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** The header `RequestContextMiddleware` stamps on every response. */
const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * The correlation id for a response, header first.
 *
 * The header is preferred because it is present on every response including
 * the ones with no parseable body, which is exactly the case where a user has
 * least to go on. The body's `request_id` is the fallback for a proxy that
 * strips unknown headers.
 */
export function requestIdOf(res: Response, body?: unknown): string | null {
  // Defensive about `headers` itself, not just about the value. This runs on
  // the failure path of every request, including ones that failed because
  // something upstream returned a response that is barely a response; a
  // correlation id is a diagnostic aid, and an aid that can throw while
  // reporting a failure turns one error into two and loses the first.
  const header = res.headers?.get?.(REQUEST_ID_HEADER);
  if (header) return header;
  const fromBody = (body as { request_id?: unknown } | undefined)?.request_id;
  return typeof fromBody === "string" && fromBody !== "" ? fromBody : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let csrfCookieName = "mw_csrf";

export function configureCsrf(cookieName: string): void {
  csrfCookieName = cookieName;
}

type TokenGetter = () => string | null;

let tokenGetter: TokenGetter | null = null;

export function setTokenGetter(get: TokenGetter | null): void {
  tokenGetter = get;
}

/**
 * The bearer token this build would send, if any.
 *
 * Exported for the one request the SPA cannot make through `apiFetch`: the
 * attachment upload, which uses `XMLHttpRequest` because `fetch` cannot
 * report upload progress (see `apps/chat/attachments.ts`). Reading the same
 * getter rather than keeping a second copy is what stops that request from
 * becoming a second auth story. Normally null — the session is an httponly
 * cookie — and non-null only for the dev-token path.
 */
export function currentToken(): string | null {
  return tokenGetter?.() ?? null;
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

/**
 * The subject this page is acting for, once Boot has it. Sent as
 * `X-MW-Account` with every call so the API can refuse a request whose
 * cookie now proves someone else -- another tab switched accounts
 * (api/matterwave/accounts.py). Null before sign-in and on the front door.
 */
let actingSubject: string | null = null;

export function setActingSubject(subject: string | null): void {
  actingSubject = subject;
}

/** The header the API binds a request to one account with. */
export const ACCOUNT_HEADER = "X-MW-Account";

function authHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = tokenGetter?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (actingSubject) headers[ACCOUNT_HEADER] = actingSubject;
  const method = (init?.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(csrfCookieName);
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  return headers;
}

interface ApiInit extends Omit<RequestInit, "body"> {
  json?: unknown;
  /**
   * A multipart body (a file upload). No Content-Type is set for it: the
   * browser must, because only it knows the boundary it generated.
   */
  form?: FormData;
}

export async function apiFetch<T>(path: string, init?: ApiInit): Promise<T> {
  const { json, form, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...authHeaders(init),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    credentials: "include",
    body: json !== undefined ? JSON.stringify(json) : form,
  });
  if (!res.ok) throw await apiError(res);
  // A 204 has no body to parse: res.json() would throw, and the caller
  // would report a delete that succeeded as "Could not reach MatterWave".
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * A stream and the correlation id of the response carrying it.
 *
 * The id has to come out with the stream, not just on the error path: a
 * stream that dies mid-answer began as a 200, so there is no ApiError to hang
 * it on, and by the time the body ends the Response is long out of scope. The
 * caller holds it for the whole turn and uses it if the turn fails.
 */
export interface ApiStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly requestId: string | null;
}

export async function apiStream(
  path: string,
  json: unknown,
  signal?: AbortSignal,
): Promise<ApiStream> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      ...authHeaders({ method: "POST" }),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    credentials: "include",
    body: JSON.stringify(json),
    signal,
  });
  if (!res.ok || !res.body) {
    throw await apiError(res);
  }
  return { body: res.body, requestId: requestIdOf(res) };
}

/**
 * The `X-MatterWave-*` response headers, lower-cased. Defensive about the
 * shape of `headers` on purpose: the unit suites stub `fetch` with plain
 * objects, many of which carry no `headers` at all, and a TypeError thrown
 * from inside the error path turned every API refusal into "could not reach
 * MatterWave" in 30 tests at once. An error builder must not be able to
 * throw; a missing header bag reads as no headers.
 */
function ourHeaders(res: Response): Record<string, string> {
  const ours: Record<string, string> = {};
  const bag = (res as { headers?: unknown }).headers;
  if (!bag || typeof (bag as Headers).forEach !== "function") return ours;
  (bag as Headers).forEach((value, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("x-matterwave-")) ours[key] = value;
  });
  return ours;
}

async function apiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // not JSON; fall through to status text
  }
  const detail = (body as { detail?: unknown } | undefined)?.detail;
  const message =
    typeof detail === "string" ? detail : res.statusText || `Request failed (${res.status})`;
  const error = new ApiError(res.status, message, body, requestIdOf(res, body), ourHeaders(res));
  // Announced from here rather than handled per call site: the account can
  // be suspended while the shell is open, and whichever request notices
  // first is the one that should take the whole page to the notice.
  if (isSuspended(error)) window.dispatchEvent(new Event(SUSPENDED_EVENT));
  // The browser's acting account changed under this tab (accounts.py):
  // nothing this page shows belongs to the account the cookie now proves,
  // so the whole page reloads into that account rather than mixing them.
  if (isAccountSwitched(error)) {
    window.dispatchEvent(new Event(ACCOUNT_SWITCHED_EVENT));
    reloadForSwitchedAccount();
  }
  return error;
}

/** A 409 whose body says `account_switched`: another tab switched accounts. */
export function isAccountSwitched(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.body as { status?: unknown } | undefined)?.status === "account_switched"
  );
}

/** Fired on `window` when any API call answers 409 account_switched. */
export const ACCOUNT_SWITCHED_EVENT = "mw:account-switched";

let reloading = false;

/** One reload, however many requests noticed; a test can stub `location.reload`. */
function reloadForSwitchedAccount(): void {
  if (reloading) return;
  reloading = true;
  try {
    location.reload();
  } catch {
    reloading = false;
  }
}

/**
 * The API refuses a suspended account on every authenticated route, at
 * login and at verification, always as a 403 whose body carries
 * `status: "suspended"` beside the detail.
 */
export function isSuspended(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    (err.body as { status?: unknown } | undefined)?.status === "suspended"
  );
}

/** Fired on `window` when any API call answers 403 suspended; Boot listens. */
export const SUSPENDED_EVENT = "mw:suspended";
