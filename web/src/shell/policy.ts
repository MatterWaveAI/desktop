import type { MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import { apiFetch } from "../lib/api";

/**
 * The acceptable-use policy's data: the numbers the page publishes and the
 * state the shell's banner shows. Types and fetchers only, outside the
 * components so the mapping is testable without a DOM.
 */

export type EnforcementState = "none" | "warned" | "rate_limited" | "suspended";

/** `GET /api/me/enforcement`: what applies to the signed-in person. */
export interface MyEnforcement {
  state: EnforcementState;
  /** The reason the operator wrote for the person. Absent for `none`. */
  reason?: string;
  since?: string;
  expires_at?: string | null;
  /** Whether the action is on the account or on its organisation. */
  scope?: "user" | "org";
  appeal_path?: string;
  limit?: { messages: number; window_s: number };
}

export function fetchMyEnforcement(): Promise<MyEnforcement> {
  return apiFetch<MyEnforcement>("/api/me/enforcement");
}

/** `GET /api/policy/stats`: counts only, zero until there is data. */
export interface PolicyStats {
  reports: {
    by_kind: { unsafe: number; unhelpful: number };
    unsafe_by_status: { open: number; reviewed: number; actioned: number; dismissed: number };
  };
  enforcement: {
    by_state: { warned: number; rate_limited: number; suspended: number };
    active: { warned: number; rate_limited: number; suspended: number };
    appeals: { received: number; upheld: number; overturned: number };
  };
}

export function fetchPolicyStats(): Promise<PolicyStats> {
  return apiFetch<PolicyStats>("/api/policy/stats");
}

/** The ladder, as the page and the banner name each rung. */
export const STATE_LABEL: Record<Exclude<EnforcementState, "none">, MessageDescriptor> = {
  warned: msg`Warning`,
  rate_limited: msg`Rate limited`,
  suspended: msg`Suspended`,
};

/**
 * The banner's first line for a state. Says what is in force and, for a rate
 * limit, the number, because a limit a person cannot see is one they hit by
 * surprise.
 */
export function enforcementHeadline(me: MyEnforcement): string {
  // Whole sentences per scope, not a subject spliced into one: a translator
  // needs to agree the verb with "organisation" and "account" separately.
  const org = me.scope === "org";
  if (me.state === "warned") {
    return org
      ? t`Your organisation has received a warning under the Acceptable Use Policy.`
      : t`Your account has received a warning under the Acceptable Use Policy.`;
  }
  if (me.state === "rate_limited") {
    if (me.limit) {
      const messages = me.limit.messages;
      const period = describeWindow(me.limit.window_s);
      return org
        ? t`Your organisation is rate limited to ${messages} messages per ${period} under the Acceptable Use Policy.`
        : t`Your account is rate limited to ${messages} messages per ${period} under the Acceptable Use Policy.`;
    }
    return org
      ? t`Your organisation is rate limited under the Acceptable Use Policy.`
      : t`Your account is rate limited under the Acceptable Use Policy.`;
  }
  return org
    ? t`Your organisation is suspended under the Acceptable Use Policy.`
    : t`Your account is suspended under the Acceptable Use Policy.`;
}

/** "hour", "2 hours", "10 minutes": the span after "per". */
export function describeWindow(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return plural(hours, { one: "hour", other: "# hours" });
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return plural(minutes, { one: "minute", other: "# minutes" });
}
