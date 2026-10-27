import { useCallback, useState } from "react";
import { useKeyboardShortcuts } from "../../shell/useKeyboardShortcuts";
import type { Message } from "../../types";
import { textOfParts, type ChatMessage } from "./chatAdapter";
import { clipboardAvailable } from "./clipboard";
import { useCopy } from "./useCopy";
import type { BranchedMessage } from "./useBranchedThread";

/**
 * The chat page's share of the keyboard shortcuts: copy the last reply,
 * copy the last code block, and the empty-composer ArrowUp that edits the
 * reader's last message. The pure halves are exported for the tests.
 */

/** The `pending-*` id the branch hook gives a turn the server has no row for yet. */
function isStored(message: Message): boolean {
  return !message.id.startsWith("pending-");
}

/**
 * The replies on screen, oldest first, as text. The stored transcript when
 * it is the one showing; the in-flight send's otherwise, minus the answer
 * still being written -- half an answer is not what "copy the last reply"
 * means, and the Copy button under it is withheld for the same reason.
 */
export function replyTexts(
  branched: readonly BranchedMessage[],
  messages: readonly ChatMessage[],
  busy: boolean,
): string[] {
  if (branched.length > 0) {
    return branched
      .map((entry) => entry.message)
      .filter((message) => message.role === "assistant" && isStored(message))
      .map((message) => message.content);
  }
  const replies = messages.filter((message) => message.role === "assistant");
  const settled = busy ? replies.slice(0, -1) : replies;
  return settled.map((message) => textOfParts(message.content));
}

/**
 * The body of the last fenced code block in a Markdown text, or null. A
 * fence left open runs to the end, as CommonMark reads it.
 */
export function lastCodeBlock(markdown: string): string | null {
  let last: string | null = null;
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = open[1];
        body = [];
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      last = body.join("\n");
      fence = null;
      continue;
    }
    body.push(line);
  }
  if (fence !== null) last = body.join("\n");
  return last;
}

/** The newest code block across the replies, searching back from the last one. */
export function lastCodeIn(replies: readonly string[]): string | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const code = lastCodeBlock(replies[i]);
    if (code !== null) return code;
  }
  return null;
}

/** The reader's last stored turn on the active path, which ArrowUp edits. */
export function lastEditableId(branched: readonly BranchedMessage[]): string | null {
  for (let i = branched.length - 1; i >= 0; i--) {
    const { message } = branched[i];
    if (message.role === "user" && isStored(message)) return message.id;
  }
  return null;
}

/**
 * Does this key press in the composer mean "edit my last message"? ArrowUp
 * with nothing else held, in an empty box, outside an IME composition --
 * anywhere else ArrowUp moves the caret, and taking it would strand a
 * person mid-draft.
 */
export function isEditLastKey(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing?: boolean;
  },
  draft: string,
): boolean {
  return (
    event.key === "ArrowUp" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.isComposing !== true &&
    draft === ""
  );
}

export type CopiedWhat = "reply" | "code";

/**
 * Install the two copy shortcuts for the transcript on screen. A shortcut
 * with nothing to copy has no handler, so the browser keeps the chord; the
 * answer says what was copied last, for the status line that confirms it.
 */
export function useCopyShortcuts(args: {
  branched: readonly BranchedMessage[];
  messages: readonly ChatMessage[];
  busy: boolean;
}): CopiedWhat | null {
  const { copied, copy } = useCopy();
  const [what, setWhat] = useState<CopiedWhat | null>(null);
  const replies = replyTexts(args.branched, args.messages, args.busy);
  const reply = replies.length > 0 ? replies[replies.length - 1] : null;
  const code = lastCodeIn(replies);
  const can = clipboardAvailable();

  const run = useCallback(
    (kind: CopiedWhat, text: string) => {
      setWhat(kind);
      void copy(text);
    },
    [copy],
  );

  useKeyboardShortcuts({
    "copy-last-reply": can && reply !== null ? () => run("reply", reply) : undefined,
    "copy-last-code": can && code !== null ? () => run("code", code) : undefined,
  });

  return copied ? what : null;
}
