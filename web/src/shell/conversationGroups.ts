import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Conversation } from "../types";

export type ConversationGroupLabel =
  | "Pinned"
  | "Today"
  | "Yesterday"
  | "Previous 7 days"
  | "Previous 30 days"
  | "Older";

export interface ConversationGroup {
  readonly label: ConversationGroupLabel;
  readonly rows: readonly Conversation[];
}

/**
 * The heading each label is shown as. The label itself stays English: it is
 * the group's key, and tests and the list compare against it.
 */
const HEADINGS: Record<ConversationGroupLabel, MessageDescriptor> = {
  Pinned: msg`Pinned`,
  Today: msg`Today`,
  Yesterday: msg`Yesterday`,
  "Previous 7 days": msg`Previous 7 days`,
  "Previous 30 days": msg`Previous 30 days`,
  Older: msg`Older`,
};

/** The heading for a group, rendered with `i18n._(groupHeading(label))`. */
export function groupHeading(label: ConversationGroupLabel): MessageDescriptor {
  return HEADINGS[label];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

function labelOf(conversation: Conversation, today: number): ConversationGroupLabel {
  if (conversation.pinned_at) return "Pinned";
  const at = Date.parse(conversation.updated_at);
  if (Number.isNaN(at) || at >= today) return "Today";
  if (at >= today - DAY_MS) return "Yesterday";
  if (at >= today - 7 * DAY_MS) return "Previous 7 days";
  if (at >= today - 30 * DAY_MS) return "Previous 30 days";
  return "Older";
}

/**
 * The list cut into headed runs by when each conversation last moved, in
 * the person's own day boundaries.
 *
 * The server's order is kept, never re-sorted: it is pinned first, then most
 * recently updated, so each label's rows are already contiguous and the
 * runs come out in the order the headings should. A run is only started when
 * the label changes, so a row out of place (a page boundary, a clock skew)
 * gets its own short run rather than being moved.
 */
export function groupConversations(
  rows: readonly Conversation[],
  now: Date = new Date(),
): ConversationGroup[] {
  const today = startOfDay(now);
  const groups: { label: ConversationGroupLabel; rows: Conversation[] }[] = [];
  for (const row of rows) {
    const label = labelOf(row, today);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}
