import { apiFetch } from "./api";

/**
 * The organisation's second-factor policy, typed once (routes_org.py,
 * `/api/org/mfa`). Read by any org admin; the switch is the owner's in
 * both directions, and the API answers 403 to anyone else.
 *
 * What "required" does is decided at the login gate (routes_mfa.py), not
 * here: a member without an authenticator is not refused, their next
 * password sign-in parks on the enrolment page until they set one up, and
 * then finishes. The sentences below say exactly that so the pane and its
 * test share one description of the policy rather than each paraphrasing
 * the route.
 */

export interface MfaSettings {
  mfa_required: boolean;
}

/** The policy as it stands, one sentence. */
export function mfaStatusLine(required: boolean): string {
  return required
    ? "Two-factor authentication is required. Every member must sign in with an authenticator app as well as their password."
    : "Two-factor authentication is optional. Members may set up an authenticator app, but none has to.";
}

/**
 * What turning it on does, as the route enforces it: enrolment at the next
 * password sign-in, no grace period, no refusal, existing sessions and SSO
 * sign-ins untouched.
 */
export const MFA_REQUIRED_EXPLANATION = [
  "A member who already has an authenticator carries on entering its code at sign-in.",
  "A member who has none is not locked out: their next password sign-in pauses on a page that asks them to set one up, and finishes once they have. They are also given recovery codes for the day their phone is lost.",
  "It takes effect at the next sign-in, with no grace period; sessions that are already open stay open. It applies to password sign-in only: a member who arrives through your identity provider has that provider's factors.",
] as const;

export function fetchMfaSettings(): Promise<MfaSettings> {
  return apiFetch<MfaSettings>("/api/org/mfa");
}

/** `PUT /api/org/mfa`. Owner only, either way; the API's 403 names that. */
export function setMfaRequired(required: boolean): Promise<MfaSettings> {
  return apiFetch<MfaSettings>("/api/org/mfa", {
    method: "PUT",
    json: { mfa_required: required },
  });
}
