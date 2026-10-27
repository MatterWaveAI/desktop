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
export const STATE_LABEL: Record<Exclude<EnforcementState, "none">, string> = {
  warned: "Warning",
  rate_limited: "Rate limited",
  suspended: "Suspended",
};

/**
 * The banner's first line for a state. Says what is in force and, for a rate
 * limit, the number, because a limit a person cannot see is one they hit by
 * surprise.
 */
export function enforcementHeadline(me: MyEnforcement): string {
  const who = me.scope === "org" ? "Your organisation" : "Your account";
  if (me.state === "warned") return `${who} has received a warning under the Acceptable Use Policy.`;
  if (me.state === "rate_limited") {
    const limit = me.limit ? ` to ${me.limit.messages} messages per ${describeWindow(me.limit.window_s)}` : "";
    return `${who} is rate limited${limit} under the Acceptable Use Policy.`;
  }
  return `${who} is suspended under the Acceptable Use Policy.`;
}

export function describeWindow(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}
