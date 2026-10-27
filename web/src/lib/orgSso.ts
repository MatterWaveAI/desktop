import { ApiError, apiFetch } from "./api";

/**
 * Domain proof and single sign-on enforcement, typed once (routes_org.py).
 *
 * The verify route answers three ways and the pane has to tell them apart,
 * so the distinction is made here rather than in JSX: proven (200), the
 * claim accepted but the record not matched (202, with what DNS actually
 * held so a near-miss can be diagnosed from the pane), and the lookup
 * itself failing (503, thrown as an `ApiError` the caller shows with its
 * request id). Collapsing the three into one message is what the first
 * version of the pane did, and it left an admin unable to tell "wait for
 * propagation" from "you published the wrong value".
 */

/** `GET /api/org/domains/{domain}/challenge`: the record to publish. */
export interface DomainChallenge {
  type: "TXT";
  /** The label under the domain, e.g. `_matterwave-verify`. */
  host: string;
  /** The fully qualified record name: `{host}.{domain}`. */
  name: string;
  value: string;
}

/** The domain row as the verify route reports it after a check. */
export interface DomainVerification {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  method: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export type VerifyOutcome =
  | { kind: "verified"; state: DomainVerification }
  /** DNS answered with nothing at the record name. Publish it, or wait. */
  | { kind: "missing"; state: DomainVerification; detail: string; record: DomainChallenge }
  /** DNS answered with values, none of them the token. The stale record is listed. */
  | {
      kind: "mismatch";
      state: DomainVerification;
      detail: string;
      record: DomainChallenge;
      found: string[];
    };

export function fetchDomainChallenge(domain: string): Promise<DomainChallenge> {
  return apiFetch<{ record: DomainChallenge }>(
    `/api/org/domains/${encodeURIComponent(domain)}/challenge`,
  ).then((body) => body.record);
}

/**
 * Run the DNS check. A 503 (the resolver could not be asked) propagates as
 * an `ApiError`: it is a failure of the check, not an answer about the
 * domain, and the caller renders it as one.
 */
export async function verifyDomain(domain: string): Promise<VerifyOutcome> {
  const body = await apiFetch<
    DomainVerification & { detail?: string; record: DomainChallenge; found?: string[] }
  >(`/api/org/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" });
  const { detail, record, found, ...state } = body;
  // The 202 carries `found` beside the state; the 200 does not. A proven
  // domain whose record later disappears also comes back 202 with
  // `verified` still true, which the row reads as verified -- the stamp is
  // never revoked by a bad afternoon at the nameserver.
  if (found === undefined || state.verified) return { kind: "verified", state };
  if (found.length === 0) return { kind: "missing", state, detail: detail ?? "", record };
  return { kind: "mismatch", state, detail: detail ?? "", record, found };
}

/** `GET /api/org/sso`: the policy and, when off, what stops it being turned on. */
export interface SsoSettings {
  sso_required: boolean;
  /** The API's reasons, each a full sentence; empty when enforcement is allowed. */
  blockers: string[];
}

/** A minted break-glass code. `code` is present only in the response that minted it. */
export interface RecoveryCode {
  id: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  used_at: string | null;
  code?: string;
  shown_once?: boolean;
}

export function fetchSsoSettings(): Promise<SsoSettings> {
  return apiFetch<SsoSettings>("/api/org/sso");
}

/**
 * `PUT /api/org/sso`. Turning enforcement on is owner-only (403 otherwise),
 * refused with the blockers while any stand (409), and answers with the
 * recovery code minted in the same breath -- there is no enforced state
 * that was not handed its way back out.
 */
export function setSsoRequired(
  required: boolean,
): Promise<{ sso_required: boolean; recovery?: RecoveryCode }> {
  return apiFetch("/api/org/sso", { method: "PUT", json: { sso_required: required } });
}

/** `POST /api/org/sso/recovery-code`: a fresh code; the previous unused one stops working. */
export function mintRecoveryCode(): Promise<RecoveryCode> {
  return apiFetch<{ recovery: RecoveryCode }>("/api/org/sso/recovery-code", {
    method: "POST",
  }).then((body) => body.recovery);
}

/**
 * The refusal a 409 from `PUT /api/org/sso` carries -- its sentence and the
 * blockers it found -- or null for any other error. The detail is an
 * object, so `failureMessage` alone would show the status text.
 */
export function ssoRefusalOf(err: unknown): { message: string; blockers: string[] } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const detail = (err.body as { detail?: { msg?: unknown; blockers?: unknown } } | undefined)
    ?.detail;
  const blockers = Array.isArray(detail?.blockers)
    ? detail.blockers.filter((b): b is string => typeof b === "string")
    : [];
  const message = typeof detail?.msg === "string" ? detail.msg : err.message;
  return { message, blockers };
}

/**
 * A short heading for one of the API's blocker sentences, so the list reads
 * as reasons at a glance with the API's own explanation underneath. The
 * sentence is matched on the words the API has used since the preflight was
 * written; an unrecognised one is headed by itself rather than hidden.
 */
export function blockerHeadline(blocker: string): string {
  const text = blocker.toLowerCase();
  if (text.includes("identity provider")) return "No identity provider attached";
  if (text.includes("no verified domain")) return "No verified domain yet";
  if (text.includes("locked out")) return "Some members are not on a verified domain";
  return blocker;
}
