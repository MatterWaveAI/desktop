import { apiFetch } from "../../lib/api";

/**
 * The enforcement ladder and the review queue, as
 * api/matterwave/routes_moderation.py serves them. Types and fetchers only.
 *
 * Nothing here carries message text except `ReviewRow.message`: the one
 * reported message, shown to a reviewer because the reporter chose to
 * surface it. Every other shape is ids, states, reasons and dates.
 */

export type LadderState = "warned" | "rate_limited" | "suspended";
export type TargetKind = "user" | "org";

export const LADDER: readonly LadderState[] = ["warned", "rate_limited", "suspended"];

export const LADDER_LABEL: Record<LadderState, string> = {
  warned: "Warned",
  rate_limited: "Rate limited",
  suspended: "Suspended",
};

/** One enforcement_actions row. `evidence` is report and flag ids, never content. */
export interface EnforcementAction {
  id: string;
  target_kind: TargetKind;
  target: string;
  org_id: string | null;
  state: LadderState;
  /** Shown to the person it concerns. */
  reason: string;
  /** The operator's own; never shown to the person. */
  notes: string | null;
  evidence: string[];
  actor_subject: string;
  created_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
  lift_reason: string | null;
  appeal_state: "none" | "received" | "upheld" | "overturned";
}

export interface EnforcementRecord {
  target_kind: TargetKind;
  target: string;
  current: EnforcementAction | null;
  history: EnforcementAction[];
}

export interface ApplyDraft {
  state: LadderState;
  reason: string;
  notes: string | null;
  /** Hours from now; null means the API's default (a rate limit) or until lifted. */
  expires_in_hours: number | null;
}

export function fetchActiveEnforcement(): Promise<EnforcementAction[]> {
  return apiFetch<{ data: EnforcementAction[] }>("/api/admin/enforcement").then((b) => b.data);
}

export function fetchEnforcement(kind: TargetKind, target: string): Promise<EnforcementRecord> {
  return apiFetch<EnforcementRecord>(`/api/admin/enforcement/${kind}/${encodeURIComponent(target)}`);
}

export function applyEnforcement(kind: TargetKind, target: string, draft: ApplyDraft): Promise<EnforcementAction> {
  const { expires_in_hours, notes, ...rest } = draft;
  return apiFetch<EnforcementAction>(`/api/admin/enforcement/${kind}/${encodeURIComponent(target)}`, {
    method: "PUT",
    json: {
      ...rest,
      ...(notes ? { notes } : {}),
      ...(expires_in_hours !== null ? { expires_in_hours } : {}),
    },
  });
}

export function liftEnforcement(kind: TargetKind, target: string, reason: string): Promise<EnforcementAction> {
  return apiFetch<EnforcementAction>(`/api/admin/enforcement/${kind}/${encodeURIComponent(target)}/lift`, {
    method: "POST",
    json: { reason },
  });
}

// --- the review queue ------------------------------------------------------

export type ReportStatus = "open" | "reviewed" | "actioned" | "dismissed";
export type ReviewAction = "dismiss" | "note" | "warn" | "limit" | "suspend";

export const REVIEW_ACTIONS: readonly { action: ReviewAction; label: string; description: string }[] = [
  { action: "dismiss", label: "Dismiss", description: "Not a violation. Closes the report; touches no account." },
  { action: "note", label: "Note only", description: "Reviewed, nothing to do yet. Closes the report with the note." },
  { action: "warn", label: "Warn", description: "A notice to the account, in the words of the note." },
  { action: "limit", label: "Rate limit", description: "Hold the account to the tightened window for a time." },
  { action: "suspend", label: "Suspend", description: "Refuse sign-in and every request until a person lifts it." },
];

/** The one reported message, or the fact that it has since been purged. */
export interface ReportedMessage {
  available: boolean;
  role: string | null;
  text: string | null;
  model: string | null;
}

export interface ReviewRow {
  id: string;
  reporter_subject: string;
  /** Whose conversation it is: the account an action from this row is against. */
  owner_subject: string;
  org_id: string | null;
  message_id: string | null;
  conversation_id: string | null;
  kind: "unsafe";
  note: string | null;
  status: ReportStatus;
  action_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  resolution: string | null;
  /** Null for a report of the whole conversation. */
  message: ReportedMessage | null;
}

export function fetchReviewQueue(status: ReportStatus): Promise<ReviewRow[]> {
  return apiFetch<{ data: ReviewRow[] }>(`/api/admin/moderation/queue?status=${status}`).then((b) => b.data);
}

export function reviewReport(
  reportId: string,
  body: { action: ReviewAction; note: string; expires_in_hours?: number },
): Promise<{ id: string; status: ReportStatus; action_id: string | null }> {
  return apiFetch(`/api/admin/moderation/reports/${encodeURIComponent(reportId)}/review`, {
    method: "POST",
    json: body,
  });
}
