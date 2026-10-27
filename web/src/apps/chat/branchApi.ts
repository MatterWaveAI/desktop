import type { ConversationWithMessages, Message } from "../../types";
import { apiFetch, apiStream, type ApiStream } from "../../lib/api";

/**
 * The branching half of the chat API.
 *
 * Kept beside `chatAdapter`, not inside it: the adapter drives one exchange
 * and knows nothing about the tree, while these calls are about which branch
 * exists and which one is current.
 */

/** Every message in the conversation, for the switcher. */
export async function fetchTree(conversationId: string): Promise<Message[]> {
  const body = await apiFetch<ConversationWithMessages>(
    `/api/conversations/${conversationId}/tree`,
  );
  return body.messages;
}

/**
 * Record which branch the thread shows.
 *
 * Deliberately not awaited by the switcher: the SPA holds the whole tree, so
 * it has already re-rendered the new path. This only persists the choice for
 * the next load. A failure leaves the cursor where it was, which is why it is
 * allowed to fail quietly rather than throw into a click handler.
 */
export async function setActiveLeaf(
  conversationId: string,
  messageId: string,
): Promise<void> {
  try {
    await apiFetch(`/api/conversations/${conversationId}/active-leaf`, {
      method: "PUT",
      json: { message_id: messageId },
    });
  } catch {
    // The rendered path is the source of truth for this session.
  }
}

/** Copy the path down to a message into a new conversation. */
export function forkConversation(
  conversationId: string,
  messageId: string,
  title?: string,
): Promise<ConversationWithMessages> {
  return apiFetch<ConversationWithMessages>(`/api/conversations/${conversationId}/fork`, {
    method: "POST",
    json: title === undefined ? { message_id: messageId } : { message_id: messageId, title },
  });
}

/**
 * Edit a user message: stream the new answer under a new sibling.
 *
 * Same SSE shape as sending, so the caller parses it with the same reader --
 * a `message` frame for the sibling, deltas, then `done`.
 */
export function streamEdit(
  conversationId: string,
  messageId: string,
  content: string,
  model: string | null,
  signal?: AbortSignal,
): Promise<ApiStream> {
  return apiStream(
    `/api/conversations/${conversationId}/messages/${messageId}/edit`,
    model === null ? { content } : { content, model },
    signal,
  );
}

/** Regenerate an assistant message: a sibling under the same user turn. */
export function streamRegenerate(
  conversationId: string,
  messageId: string,
  model: string | null,
  signal?: AbortSignal,
): Promise<ApiStream> {
  return apiStream(
    `/api/conversations/${conversationId}/messages/${messageId}/regenerate`,
    model === null ? {} : { model },
    signal,
  );
}

/**
 * Send a user turn and stream its answer, for a caller that holds the tree.
 * The same route and body the chat adapter posts.
 */
export function streamSend(
  conversationId: string,
  content: string,
  model: string | null,
  signal?: AbortSignal,
): Promise<ApiStream> {
  return apiStream(
    `/api/conversations/${conversationId}/messages`,
    model === null ? { content } : { content, model },
    signal,
  );
}
