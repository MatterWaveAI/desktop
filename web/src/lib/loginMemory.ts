import { t } from "@lingui/core/macro";
/**
 * What this browser remembers about how its person last signed in, and
 * what an organisation sign-in that failed on the way back has to say.
 *
 * The method is kept in localStorage: it is a convenience for the next
 * visit, carries no credential, and a browser that refuses storage simply
 * forgets. The password is never remembered; the email is, so the
 * organisation form and the passkey button can be offered for it without
 * asking again -- which is what every account chooser does.
 *
 * The failure reason rides in sessionStorage for one page load: the
 * callback sends the browser back to /login with the reason in the query,
 * but a bare /login immediately starts a fresh request at the provider and
 * comes back with only `?authRequest=`, so the reason must survive that
 * round trip or it is never shown.
 */

export type LoginMethod =
  | { kind: "password"; email?: string }
  | { kind: "passkey"; email?: string }
  | { kind: "sso"; email: string; provider: string; providerName: string };

const METHOD_KEY = "mw:login-method";
const SSO_ERROR_KEY = "mw:sso-error";

export function rememberLoginMethod(method: LoginMethod): void {
  try {
    localStorage.setItem(METHOD_KEY, JSON.stringify(method));
  } catch {
    // Storage refused: the next visit starts from the plain form.
  }
}

export function lastLoginMethod(): LoginMethod | null {
  try {
    const raw = localStorage.getItem(METHOD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoginMethod> & { kind?: string };
    if (parsed.kind === "password" || parsed.kind === "passkey") {
      return { kind: parsed.kind, email: stringOr(parsed.email) };
    }
    if (parsed.kind === "sso") {
      const sso = parsed as Partial<Extract<LoginMethod, { kind: "sso" }>>;
      if (sso.email && sso.provider) {
        return {
          kind: "sso",
          email: sso.email,
          provider: sso.provider,
          providerName: sso.providerName ?? "your organisation",
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function forgetLoginMethod(): void {
  try {
    localStorage.removeItem(METHOD_KEY);
  } catch {
    // Nothing to forget if it could not be kept.
  }
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export type SsoFailure =
  /** The organisation's provider refused or could not complete the sign-in. */
  | { reason: "idp"; detail: string }
  /** The provider signed in an address on another domain than the one typed. */
  | { reason: "mismatch"; detail: string }
  /** No single sign-on is set up for the typed address's domain. */
  | { reason: "not_configured"; detail: string }
  /** The lookup or the provider could not be reached. */
  | { reason: "unavailable"; detail: string };

export function rememberSsoFailure(failure: SsoFailure): void {
  try {
    sessionStorage.setItem(SSO_ERROR_KEY, JSON.stringify(failure));
  } catch {
    // Without storage the reason is lost on the restart; the form still works.
  }
}

/** The remembered failure, cleared on read: it is shown once. */
export function takeSsoFailure(): SsoFailure | null {
  try {
    const raw = sessionStorage.getItem(SSO_ERROR_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SSO_ERROR_KEY);
    const parsed = JSON.parse(raw) as Partial<SsoFailure>;
    if (
      parsed.reason === "idp" ||
      parsed.reason === "mismatch" ||
      parsed.reason === "not_configured" ||
      parsed.reason === "unavailable"
    ) {
      return { reason: parsed.reason, detail: String(parsed.detail ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

/** The failure the callback put in the URL (`?sso_error=`), if any. */
export function ssoFailureFromQuery(search: string): SsoFailure | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const reason = params.get("sso_error");
  if (reason !== "idp" && reason !== "mismatch") return null;
  return { reason, detail: params.get("sso_detail") ?? "" };
}

/** What the person reads for a failure. */
export function ssoFailureMessage(failure: SsoFailure): string {
  const detail = failure.detail;
  switch (failure.reason) {
    case "not_configured":
      return t`No single sign-on is set up for ${detail}. Sign in with your password, or ask an administrator of your organisation to set it up.`;
    case "unavailable":
      return t`Your organisation's sign-in could not be reached. Try again in a moment, or sign in with your password.`;
    case "idp":
      return detail
        ? t`Your organisation's identity provider did not complete the sign-in (${detail}). Try again, or sign in with your password.`
        : t`Your organisation's identity provider did not complete the sign-in. Try again, or sign in with your password.`;
    case "mismatch":
      return t`Your organisation's identity provider signed in ${detail}, which is not on the domain you entered. Use the work email that provider knows you by, or sign in with your password.`;
  }
}
