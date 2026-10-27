import { ApiError, apiFetch } from "../../lib/api";

/**
 * Reporting a conversation: the choices the API accepts and the request.
 *
 * Data and the fetch, outside the dialog component so the component file
 * exports only a component (fast refresh) and the mapping is testable
 * without a DOM. The two kinds are the API's (`ReportBody.kind`), not a
 * taxonomy of our own: `unsafe` goes to a person, `unhelpful` to the backlog.
 */
export type ReportKind = "unsafe" | "unhelpful";

export interface ReportReason {
  readonly kind: ReportKind;
  readonly label: string;
  readonly description: string;
}

export const REPORT_REASONS: readonly ReportReason[] = [
  {
    kind: "unsafe",
    label: "Unsafe or harmful",
    description:
      "Content that could hurt someone, is illegal, or should never have been generated. A person reads these.",
  },
  {
    kind: "unhelpful",
    label: "Unhelpful or wrong",
    description:
      "A wrong, evasive or useless answer — including a refusal you think was unwarranted. These go to the product backlog.",
  },
];

/** The API's cap on the note (`ReportBody.note`), mirrored for the counter. */
export const REPORT_NOTE_MAX_LEN = 2000;

/** What a filed report comes back as: the id to quote to support. */
export interface ReportReceipt {
  readonly id: string;
  readonly kind: ReportKind;
}

export interface ReportRequest {
  readonly kind: ReportKind;
  /** The reply being reported, or null for the conversation as a whole. */
  readonly messageId: string | null;
  readonly note: string;
}

/** File the report. CSRF rides on the POST through `apiFetch`. */
export function sendReport(conversationId: string, request: ReportRequest): Promise<ReportReceipt> {
  const note = request.note.trim();
  return apiFetch<ReportReceipt>(`/api/conversations/${conversationId}/report`, {
    method: "POST",
    json: {
      kind: request.kind,
      message_id: request.messageId,
      note: note === "" ? null : note,
    },
  });
}

/**
 * The line to show when filing failed. Every branch says whether anything
 * was stored, because a report is the one request where "it probably went
 * through" is the wrong thing to leave a person believing.
 */
export function reportFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // The rate limit's detail is written for the person reading it and
    // carries the minutes to wait, which nothing here could reconstruct.
    if (err.status === 429) return err.message;
    if (err.status === 503) {
      return "Reports cannot be stored on this deployment, so nothing was filed. Tell an administrator what you saw.";
    }
    if (err.status === 404) {
      return "This conversation could not be found, so nothing was filed.";
    }
  }
  return "The report could not be sent and nothing was filed. Try again in a moment.";
}
