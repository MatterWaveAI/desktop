import { useCallback, useRef, useState } from "react";
import type { ChatMessage, ChatModelAdapter, MessagePart } from "./chatAdapter";
import { isTextPart } from "./chatAdapter";

/**
 * Where an exchange is, from the reader's point of view.
 *
 * `running` alone cannot answer "is anything actually happening?". A cold
 * model can take several seconds to produce its first token, and during that
 * window a "responding…" label over an empty bubble is indistinguishable from
 * a hang. Splitting the two lets the UI say "waiting for the model" until the
 * first delta lands, and "responding" only once text is arriving.
 */
export type ThreadPhase = "idle" | "awaiting-first-token" | "streaming";

/**
 * Drives a chat thread from a ChatModelAdapter.
 *
 * This replaces assistant-ui's useLocalRuntime, whose runtime threw
 * "Cannot set properties of undefined (setting '_getInitializePromise')" on
 * mount in a real browser. jsdom cannot mount that runtime either, so no test
 * could have caught it - the failure only appears when a person opens the page.
 * The streaming itself was always ours, in createChatAdapter; this is the
 * hundred lines of state that sat on top of it.
 */
export function useChatThread(
  adapter: ChatModelAdapter,
  initialMessages: readonly ChatMessage[] = [],
) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(initialMessages);
  const [phase, setPhase] = useState<ThreadPhase>("idle");
  // The last prompt sent, so the inline transcript error can offer a
  // retry that resends it instead of asking the user to retype it.
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  // The attachments that rode with it, so a retry resends the same message
  // rather than a text-only version of it. Ids, which the server
  // still owns and still re-checks; a retry after a failed stream is the same
  // turn taken again, so it carries the same files.
  const [lastAttachments, setLastAttachments] = useState<readonly string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // One exchange, appended to `base`. Both `send` and `retry` go through this
  // so the two paths cannot drift; they differ only in what `base` is.
  const runExchange = useCallback(
    async (
      base: readonly ChatMessage[],
      prompt: string,
      /** The uploaded ids this turn carries, already `ready`. */
      attachmentIds: readonly string[] = [],
      /**
       * The parts to draw for the user turn while the answer streams. The
       * optimistic echo of the attachments: the server will store `image` and
       * `document` parts for them and a reload shows those, but the sending
       * user should see their own screenshot in the transcript immediately
       * rather than a bare line of text. Only used for rendering; the prompt
       * is what goes upstream.
       */
      attachmentParts: readonly MessagePart[] = [],
    ) => {
      const user: ChatMessage = {
        role: "user",
        content: [{ type: "text", text: prompt }, ...attachmentParts],
      };
      // The assistant turn is appended empty and rewritten in place as deltas
      // arrive, so the caller sees one growing message rather than a flicker.
      const pending: ChatMessage = { role: "assistant", content: [{ type: "text", text: "" }] };
      const history = [...base, user];
      setMessages([...history, pending]);
      setLastPrompt(prompt);
      setLastAttachments(attachmentIds);
      setPhase("awaiting-first-token");

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const chunk of adapter.run({
          messages: history,
          attachmentIds,
          abortSignal: controller.signal,
        })) {
          if (chunk.status?.type === "incomplete") break;
          if (!chunk.content) continue;
          // The chunk carries the whole ordered part list, so the
          // assistant turn is replaced wholesale rather than rebuilt from a
          // concatenated string. A tool call in flight is a part like any
          // other, which is what lets the UI draw it while it runs.
          setMessages([
            ...history,
            { role: "assistant", content: chunk.content, metadata: chunk.metadata },
          ]);
          // Anything with substance leaves the waiting phase: real text, or a
          // tool call, which is the model doing visible work before it speaks.
          // A chunk carrying only an empty text part is the adapter settling.
          const speaking = chunk.content.some((part) =>
            isTextPart(part) ? part.text !== "" : true,
          );
          if (speaking) setPhase("streaming");
        }
      } finally {
        abortRef.current = null;
        setPhase("idle");
      }
    },
    [adapter],
  );

  const send = useCallback(
    async (
      text: string,
      attachmentIds: readonly string[] = [],
      attachmentParts: readonly MessagePart[] = [],
    ) => {
      const prompt = text.trim();
      if (!prompt || abortRef.current) return;
      await runExchange(messages, prompt, attachmentIds, attachmentParts);
    },
    [messages, runExchange],
  );

  /** Resend the last prompt after a failure, without the user retyping it. */
  const retry = useCallback(async () => {
    if (lastPrompt === null || abortRef.current) return;
    // Drop the failed exchange - the user turn and the empty or partial answer
    // beneath it - so the resend does not duplicate the question.
    const base = messages.slice(0, Math.max(0, messages.length - 2));
    // The failed user turn's non-text parts are its attachment echoes; reusing
    // them keeps the retried turn looking like the one that failed instead of
    // silently dropping the files from the transcript.
    const failedUser = messages[messages.length - 2];
    const parts =
      failedUser?.role === "user"
        ? failedUser.content.filter((part) => part.type !== "text")
        : [];
    await runExchange(base, lastPrompt, lastAttachments, parts);
  }, [lastAttachments, lastPrompt, messages, runExchange]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    phase,
    /** For callers that only need "is an exchange in flight". */
    running: phase !== "idle",
    canRetry: lastPrompt !== null,
    send,
    retry,
    cancel,
  };
}
