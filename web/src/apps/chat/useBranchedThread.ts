import { useCallback, useMemo, useRef, useState } from "react";
import type { Message } from "../../types";
import { ApiError, type ApiStream } from "../../lib/api";
import { parseSSEStream } from "../../lib/sse";
import {
  branchPosition,
  defaultLeaf,
  indexChildren,
  pathToLeaf,
  siblingLeaf,
  type BranchPosition,
} from "./branches";
import { setActiveLeaf, streamEdit, streamRegenerate, streamSend } from "./branchApi";
import { REFUSAL_CODE, TRUNCATED_CODE } from "./streamErrors";
import { noticeText, type CompactionFrame, type ContextFrame } from "./compaction";

/**
 * The branching thread: holds the whole tree, renders one path.
 *
 * Separate from `useChatThread`, which drives an ordinary exchange over
 * content-only `ChatMessage`s. Branching needs server ids on every message --
 * to name a sibling, to move the cursor, to fork -- so this hook works in
 * `Message`, the shape the API returns.
 *
 * Switching is local: the tree is already here, so a click re-renders from it
 * and the PUT that records the choice is fire-and-forget. That is the point
 * of holding the tree at all (the rule: "without a network round trip where
 * possible").
 */

export interface BranchedMessage {
  readonly message: Message;
  /** Non-null only where this message has siblings -- the "2 / 3" switcher. */
  readonly branch: BranchPosition | null;
}

export type BranchPhase = "idle" | "awaiting-first-token" | "streaming";

export function useBranchedThread(args: {
  conversationId: string | null;
  initialTree: readonly Message[];
  initialLeaf?: string | null;
  getModel: () => string | null;
  /** Same shape as the adapter's, so one classifier serves both. */
  onError: (detail: string, meta?: { requestId?: string | null; code?: string }) => void;
  onSettled?: () => void;
  /** The real count beside every `done`, for the context meter. */
  onContext?: (frame: ContextFrame) => void;
  /** A fold that could not run; the turn went ahead without it. */
  onNotice?: (message: string) => void;
}) {
  const { conversationId, getModel, onError, onSettled, onContext, onNotice } = args;
  const [tree, setTree] = useState<readonly Message[]>(args.initialTree);
  const [leafId, setLeafId] = useState<string | null>(
    () => defaultLeaf(args.initialTree, args.initialLeaf),
  );
  const [phase, setPhase] = useState<BranchPhase>("idle");
  const abortRef = useRef<AbortController | null>(null);

  const children = useMemo(() => indexChildren(tree), [tree]);

  /** The rendered transcript: one path, each message with its sibling count. */
  const path = useMemo<BranchedMessage[]>(
    () =>
      pathToLeaf(tree, leafId).map((message) => ({
        message,
        branch: branchPosition(children, message),
      })),
    [tree, leafId, children],
  );

  /** Step to a sibling. Local re-render; the server is told afterwards. */
  const switchBranch = useCallback(
    (message: Message, delta: number) => {
      const next = siblingLeaf(children, message, delta);
      if (next === null) return;
      setLeafId(next);
      if (conversationId) void setActiveLeaf(conversationId, next);
    },
    [children, conversationId],
  );

  /**
   * Drive one branching turn from its SSE stream.
   *
   * The `message` frame carries the sibling the server wrote; deltas grow a
   * pending assistant message beneath it; `done` replaces that pending
   * message with the persisted one. Both edit and regenerate stream this
   * exact shape, which is why they share this function.
   */
  const runBranch = useCallback(
    async (open: (signal: AbortSignal) => Promise<ApiStream>) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase("awaiting-first-token");
      // A synthetic id for the message being streamed: it has no server id
      // until `done`, but the transcript needs a stable key before then.
      const pendingId = `pending-${Date.now()}`;
      let parentId: string | null = null;
      let acc = "";
      /**
       * Did this branch stream end the way one is supposed to?
       *
       * The same guard `chatAdapter` carries for sending, which this
       * hook was missing: an edit or a regenerate whose body simply ends —
       * the ordinary case on a phone — left the `pending-*` bubble on screen
       * with no error, formatted exactly like a finished answer. A truncated
       * regeneration that silently passes for a complete one is the same lie
       * as a truncated send, and it was reachable by every path except the
       * one that had been fixed.
       */
      let sawTerminal = false;
      let requestId: string | null = null;
      try {
        const stream = await open(controller.signal);
        requestId = stream.requestId;
        for await (const event of parseSSEStream(stream.body)) {
          if (event.event === "compaction") {
            // The summary arrives before the turn it precedes, so it is in
            // the tree when the `message` frame names it as a parent.
            const { message: summary } = JSON.parse(event.data) as CompactionFrame;
            setTree((current) =>
              current.some((m) => m.id === summary.id) ? current : [...current, summary],
            );
            setLeafId(summary.id);
          } else if (event.event === "context") {
            onContext?.(JSON.parse(event.data) as ContextFrame);
          } else if (event.event === "notice") {
            onNotice?.(noticeText(event.data));
          } else if (event.event === "message") {
            const sibling = JSON.parse(event.data) as Message;
            parentId = sibling.id;
            // The sibling joins the tree and the thread moves onto it, so the
            // reader watches the answer arrive on the new branch.
            setTree((current) =>
              current.some((m) => m.id === sibling.id) ? current : [...current, sibling],
            );
            setLeafId(sibling.id);
          } else if (event.event === "delta") {
            acc += (JSON.parse(event.data) as { content: string }).content;
            if (acc !== "") setPhase("streaming");
            const at = parentId;
            setTree((current) => {
              const pending: Message = {
                id: pendingId,
                conversation_id: conversationId ?? "",
                role: "assistant",
                content: acc,
                created_at: new Date().toISOString(),
                parent_id: at,
                model: null,
              };
              const without = current.filter((m) => m.id !== pendingId);
              return [...without, pending];
            });
            setLeafId(pendingId);
          } else if (
            event.event === "error" ||
            event.event === "moderation_block" ||
            event.event === "refusal"
          ) {
            const { detail, code, request_id } = JSON.parse(event.data) as {
              detail: string;
              code?: string;
              request_id?: string;
            };
            // Drop the half-written bubble: the error component says what
            // happened, and a stranded fragment under it reads as an answer.
            setTree((current) => current.filter((m) => m.id !== pendingId));
            if (parentId) setLeafId(parentId);
            sawTerminal = true;
            onError(detail, {
              requestId: request_id ?? requestId,
              code:
                code ??
                (event.event === "moderation_block"
                  ? "moderation"
                  : event.event === "refusal"
                    ? REFUSAL_CODE
                    : undefined),
            });
            return;
          } else if (event.event === "done") {
            const saved = JSON.parse(event.data) as Message;
            sawTerminal = true;
            setTree((current) => [...current.filter((m) => m.id !== pendingId), saved]);
            setLeafId(saved.id);
          }
        }

        // The body ended with no `done` and no refusal. The partial is dropped
        // rather than left looking authoritative, the cursor goes back to the
        // branch that does exist, and the designed `truncated` copy says the
        // stream ended early — which is true, and is what the user needs to
        // know before they read the answer that is no longer there.
        if (!sawTerminal && !controller.signal.aborted) {
          setTree((current) => current.filter((m) => m.id !== pendingId));
          if (parentId) setLeafId(parentId);
          onError("The connection dropped before the answer finished.", {
            requestId,
            code: TRUNCATED_CODE,
          });
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setTree((current) => current.filter((m) => m.id !== pendingId));
          if (parentId) setLeafId(parentId);
          onError(err instanceof Error ? err.message : "Streaming failed.", {
            requestId: err instanceof ApiError ? err.requestId : requestId,
            // Opened and then died is a cut answer; failed to open is
            // whatever the status says.
            code: requestId === null ? undefined : TRUNCATED_CODE,
          });
        }
      } finally {
        abortRef.current = null;
        setPhase("idle");
        onSettled?.();
      }
    },
    [conversationId, onError, onSettled, onContext, onNotice],
  );

  const edit = useCallback(
    async (messageId: string, content: string) => {
      if (!conversationId) return;
      await runBranch((signal) =>
        streamEdit(conversationId, messageId, content, getModel(), signal),
      );
    },
    [conversationId, getModel, runBranch],
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      await runBranch((signal) =>
        streamRegenerate(conversationId, messageId, getModel(), signal),
      );
    },
    [conversationId, getModel, runBranch],
  );

  /**
   * Ask the model to carry on after an answer that hit its token limit.
   *
   * An ordinary user turn whose text is "continue", streamed through the
   * same path as an edit or a regenerate so the answer lands in the tree
   * on screen -- summary divider and all -- rather than in the send
   * transcript, which holds no server ids.
   */
  const continueAnswer = useCallback(async () => {
    if (!conversationId) return;
    await runBranch((signal) => streamSend(conversationId, "continue", getModel(), signal));
  }, [conversationId, getModel, runBranch]);

  /**
   * Put a summary from `POST .../compact` into the tree. It becomes the leaf
   * when it hangs off the path on screen, which is where the server writes it.
   */
  const addSummary = useCallback(
    (summary: Message) => {
      setTree((current) =>
        current.some((m) => m.id === summary.id) ? current : [...current, summary],
      );
      if (summary.parent_id !== null && summary.parent_id === leafId) setLeafId(summary.id);
    },
    [leafId],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return {
    /** The transcript: one path through the tree, with sibling counts. */
    path,
    tree,
    leafId,
    phase,
    running: phase !== "idle",
    switchBranch,
    edit,
    regenerate,
    continueAnswer,
    addSummary,
    cancel,
    /** Replace the tree wholesale, after a send or a reload. */
    setTree,
    setLeafId,
  };
}
