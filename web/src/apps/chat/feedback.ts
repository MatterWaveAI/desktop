import { apiFetch } from "../../lib/api";

/**
 * Thumbs on a reply: the vocabulary the API accepts and the requests.
 *
 * Outside the component for the usual reason (fast refresh, testable
 * without a DOM). The reasons mirror `feedback.FEEDBACK_REASONS` on the
 * API; an unknown chip is a 422 there, so the list here is the list.
 */

export type Rating = -1 | 1;

export type FeedbackReason =
  | "wrong"
  | "unhelpful"
  | "incomplete"
  | "too_long"
  | "off_topic"
  | "unsafe";

export const FEEDBACK_REASONS: readonly { readonly id: FeedbackReason; readonly label: string }[] =
  [
    { id: "wrong", label: "Wrong" },
    { id: "unhelpful", label: "Unhelpful" },
    { id: "incomplete", label: "Incomplete" },
    { id: "too_long", label: "Too long" },
    { id: "off_topic", label: "Off topic" },
    { id: "unsafe", label: "Unsafe" },
  ];

/** The API's cap on the comment (`feedback.COMMENT_MAX_LEN`), mirrored for the counter. */
export const FEEDBACK_COMMENT_MAX_LEN = 2000;

/** One rating as the API returns it. */
export interface Feedback {
  readonly message_id: string;
  readonly rating: Rating;
  readonly reasons: readonly FeedbackReason[];
  readonly comment: string | null;
}

export function putFeedback(
  messageId: string,
  body: { rating: Rating; reasons: readonly FeedbackReason[]; comment: string | null },
): Promise<Feedback> {
  const comment = body.comment?.trim() ?? "";
  return apiFetch<Feedback>(`/api/messages/${messageId}/feedback`, {
    method: "PUT",
    json: { rating: body.rating, reasons: body.reasons, comment: comment === "" ? null : comment },
  });
}

export function deleteFeedback(messageId: string): Promise<{ status: string }> {
  return apiFetch(`/api/messages/${messageId}/feedback`, { method: "DELETE" });
}

/** The caller's own ratings in a conversation, keyed by message id. */
export async function fetchFeedback(conversationId: string): Promise<Map<string, Feedback>> {
  const body = await apiFetch<{ data: Feedback[] }>(
    `/api/conversations/${conversationId}/feedback`,
  );
  return new Map(body.data.map((row) => [row.message_id, row]));
}
