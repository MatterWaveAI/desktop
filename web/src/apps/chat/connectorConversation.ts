import type { ConversationSource } from "../../types";
import { ApiError } from "../../lib/api";

/**
 * A conversation a connector opened -- one started from a Slack thread --
 * is answered in that thread alone. The API marks it with `source` and
 * refuses a send, edit or regenerate in it with a 409 carrying this code
 * and the same `source`, so a client that had a stale list still learns
 * where the answer is. A fork of it is an ordinary conversation.
 *
 * Data and helpers, outside the .tsx so the mapping is testable without a
 * DOM and the components stay components (fast refresh).
 */

/** The `code` the API puts beside `detail` on that 409. */
export const CONNECTOR_CONVERSATION_CODE = "connector_conversation";

/** `slack` as "Slack": the connector's id, which the API keeps lower-case, as a name. */
export function connectorName(source: ConversationSource): string {
  const id = source.connector.trim();
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "its connector";
}

/** "Slack #support"; the connector alone when the channel is unknown. The label carries its own `#`. */
export function sourceLabel(source: ConversationSource): string {
  const name = connectorName(source);
  return source.channel_label ? `${name} ${source.channel_label}` : name;
}

/** The line that stands in for the composer: where the answer is, and where to reply. */
export function connectorNoticeText(source: ConversationSource): string {
  return `Answered in ${sourceLabel(source)} — reply in the thread`;
}

/**
 * The thread a `connector_conversation` refusal names, or null for any
 * other failure. Read off the 409's body, which carries `source` beside the
 * detail in the shape the conversation itself does.
 */
export function connectorSourceOfError(error: unknown): ConversationSource | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { code?: unknown; source?: unknown } | null | undefined;
  if (body?.code !== CONNECTOR_CONVERSATION_CODE) return null;
  return sourceOf(body.source);
}

function sourceOf(value: unknown): ConversationSource {
  const object = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    connector: text(object.connector) ?? "",
    connection_id: text(object.connection_id),
    channel_label: text(object.channel_label),
    url: text(object.url),
  };
}
