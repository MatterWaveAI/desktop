import type { Message } from "../../types";
import { BranchSwitcher, MessageAction } from "./BranchControls";
import type { BranchPosition } from "./branches";
import { CopyAction } from "./CopyAction";
import { MessageFeedback } from "./MessageFeedback";
import type { Feedback } from "./feedback";

/**
 * The action row under one stored message: the "2 / 3" switcher where it has
 * siblings, Edit on the reader's own turns, Copy, Regenerate and Report on
 * a reply, and Branch from here on any stored message.
 *
 * Presentational, like `BranchControls`: ChatPage decides which rows may
 * regenerate (every stored reply, not only the last) and what each action
 * does; this only lays the buttons out. Every control is a plain `<button>`,
 * so each is reachable by Tab in transcript order.
 */
export function MessageControls(props: {
  message: Message;
  branch: BranchPosition | null;
  canRegenerate: boolean;
  /** True while any turn is in flight: a send, an edit or a regenerate. */
  busy: boolean;
  onSwitchBranch: (message: Message, delta: number) => void;
  onEdit: () => void;
  onRegenerate: (messageId: string) => void;
  onReport: (messageId: string) => void;
  /**
   * Copy the conversation down to this message into a new one. Absent
   * where branching is not offered (a page mounted without a conversation
   * to fork, a support session).
   */
  onBranch?: (messageId: string) => void;
  /** The thumbs, on a stored reply: the first thing in the same row. */
  feedback?: {
    current: Feedback | null;
    onChange: (next: Feedback | null) => void;
  };
}) {
  const { message, branch } = props;
  const isUser = message.role === "user";
  // Copy and Report belong on a stored reply. The `pending-*` id is the one
  // the branch hook gives a reply still streaming, which the API has no row
  // for and which is not finished enough to copy.
  const isStoredReply = !isUser && !message.id.startsWith("pending-");
  // Branching needs a server id to cut at; every stored message has one.
  const canBranch = props.onBranch !== undefined && !message.id.startsWith("pending-");

  if (!branch && !isUser && !isStoredReply && !props.canRegenerate && !canBranch) return null;

  // One toolbar of icons, thumbs included: the reply used to carry a row of
  // thumbs and a row of words under it, two things to scan for one job.
  return (
    <div
      role="toolbar"
      aria-label={isUser ? "Your message" : "Reply actions"}
      className={`mt-1 flex flex-wrap items-center gap-0.5 ${isUser ? "justify-end" : ""}`}
    >
      {props.feedback && isStoredReply && (
        <MessageFeedback
          messageId={message.id}
          current={props.feedback.current}
          onChange={props.feedback.onChange}
        />
      )}
      {branch && (
        <BranchSwitcher
          index={branch.index}
          total={branch.total}
          onPrevious={() => props.onSwitchBranch(message, -1)}
          onNext={() => props.onSwitchBranch(message, +1)}
        />
      )}
      {isUser && <MessageAction label="Edit" disabled={props.busy} onClick={props.onEdit} />}
      {isStoredReply && <CopyAction text={message.content} disabled={props.busy} />}
      {props.canRegenerate && (
        <MessageAction
          label="Regenerate"
          disabled={props.busy}
          onClick={() => props.onRegenerate(message.id)}
        />
      )}
      {isStoredReply && (
        <MessageAction
          label="Report"
          disabled={props.busy}
          onClick={() => props.onReport(message.id)}
        />
      )}
      {canBranch && (
        <MessageAction
          label="Branch from here"
          disabled={props.busy}
          onClick={() => props.onBranch?.(message.id)}
        />
      )}
    </div>
  );
}
