/**
 * What a support request needs to find a failure: who, which org, which
 * build, which request, and where in the app. Collected here so every error
 * state's "Get help" carries the same fields without each one threading
 * them through its props.
 *
 * Never conversation content, never the error's raw text, never a query
 * string (a search box puts what the person typed there): the route is the
 * path alone. Everything below is something support can look up, not
 * something the person said.
 */

export interface DiagnosticsIdentity {
  subject: string;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
}

/** The last request the API refused or failed, as `apiFetch` saw it. */
export interface RecordedFailure {
  requestId: string | null;
  traceId: string | null;
  /** The API path that failed, without its query. */
  path: string;
  status: number;
  at: string;
}

export interface Diagnostics {
  account: string | null;
  org: string | null;
  release: string | null;
  requestId: string | null;
  traceId: string | null;
  /** The app page the person was on, path only. */
  route: string;
  /** The API call that failed, when it is not the one named by `requestId`'s caller. */
  failedCall: string | null;
  at: string;
  userAgent: string;
}

let identity: DiagnosticsIdentity | null = null;
let failure: RecordedFailure | null = null;
let release: Promise<string | null> | null = null;

/** Boot sets this once it knows who is signed in; null on the front door. */
export function setDiagnosticsIdentity(next: DiagnosticsIdentity | null): void {
  identity = next;
}

export function recordFailure(next: RecordedFailure): void {
  failure = next;
}

export function lastFailure(): RecordedFailure | null {
  return failure;
}

/** Tests only: forget the identity, the failure and the cached release. */
export function resetDiagnosticsForTests(): void {
  identity = null;
  failure = null;
  release = null;
}

/**
 * The running build, from /healthz: the image's git sha (`revision`), else
 * the deployment's release label, else the package version. Asked once per
 * page and cached; a probe that cannot answer reads as unknown rather than
 * holding up the dialog.
 */
export function fetchRelease(): Promise<string | null> {
  release ??= (async () => {
    try {
      const res = await fetch("/healthz", { credentials: "omit" });
      if (!res.ok) return null;
      const body = (await res.json()) as { revision?: unknown; release?: unknown; version?: unknown };
      for (const value of [body.revision, body.release, body.version]) {
        if (typeof value === "string" && value !== "" && value !== "unknown") return value;
      }
      return null;
    } catch {
      return null;
    }
  })();
  return release;
}

/**
 * The fields for one help request. A request id the caller holds (the
 * stream that failed, the load that failed) wins; without one, the last
 * failed API call is the best lead there is.
 */
export function collectDiagnostics(input: {
  requestId?: string | null;
  traceId?: string | null;
  release?: string | null;
  now?: Date;
}): Diagnostics {
  const recorded = failure;
  const own = input.requestId ?? null;
  const requestId = own ?? recorded?.requestId ?? null;
  const fromRecorded = recorded !== null && (own === null || own === recorded.requestId);
  const account = identity ? (identity.email ?? identity.subject) : null;
  const org = identity?.orgId
    ? identity.orgName
      ? `${identity.orgName} (${identity.orgId})`
      : identity.orgId
    : null;
  return {
    account,
    org,
    release: input.release ?? null,
    requestId,
    traceId: input.traceId ?? (fromRecorded ? recorded.traceId : null),
    route: typeof location === "undefined" ? "" : location.pathname,
    failedCall: fromRecorded ? `${recorded.status} ${recorded.path}` : null,
    at: (input.now ?? new Date()).toISOString(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  };
}

/**
 * The block a person pastes or sends. Labels stay English on purpose: it is
 * read by support, and a field name that changes with the reader's language
 * cannot be searched for.
 */
export function formatDiagnostics(d: Diagnostics): string {
  const lines: Array<[string, string | null]> = [
    ["Account", d.account],
    ["Organisation", d.org],
    ["Release", d.release],
    ["Request id", d.requestId],
    ["Trace id", d.traceId],
    ["Failed call", d.failedCall],
    ["Page", d.route],
    ["Time", d.at],
    ["Browser", d.userAgent],
  ];
  return lines.map(([label, value]) => `${label}: ${value || "unknown"}`).join("\n");
}

/**
 * Where "Contact support" goes. A mailto address is pre-filled with a
 * subject and the diagnostics; a web form cannot be pre-filled from here, so
 * it opens as configured and the dialog offers the same text to copy. A
 * scheme that is neither is not a link this page should follow.
 */
export function supportRequestHref(
  supportUrl: string | null | undefined,
  diagnostics: Diagnostics,
  subject: string,
): { href: string; prefilled: boolean } | null {
  if (!supportUrl) return null;
  if (/^mailto:/i.test(supportUrl)) {
    const [address, query] = supportUrl.split("?", 2);
    const params = new URLSearchParams(query ?? "");
    params.set("subject", subject);
    params.set("body", `\n\n---\n${formatDiagnostics(diagnostics)}\n`);
    // URLSearchParams writes spaces as "+", which a mail client shows
    // literally; mailto wants %20.
    return { href: `${address}?${params.toString().replace(/\+/g, "%20")}`, prefilled: true };
  }
  if (/^https?:\/\//i.test(supportUrl)) return { href: supportUrl, prefilled: false };
  return null;
}
