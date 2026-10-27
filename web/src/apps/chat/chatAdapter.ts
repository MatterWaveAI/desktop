/**
 * The shape the chat UI consumes. Defined here rather than imported: this used
 * to be an assistant-ui ChatModelAdapter, but its runtime threw
 * "Cannot set properties of undefined (setting '_getInitializePromise')" on
 * mount in a real browser, which jsdom could never catch. The streaming logic
 * below was always ours; only the types came from the library.
 */
/**
 * One part of a message. A message is an ordered list of these, not a
 * string.
 *
 * `UnknownPart` is the point of the union: a part kind this build has never
 * heard of must render as a placeholder rather than crash the transcript, so
 * an older client keeps working against a newer API. Every consumer switches
 * on `type` with a default branch.
 */
export type TextPart = { readonly type: "text"; readonly text: string };
export type ReasoningPart = { readonly type: "reasoning"; readonly text: string };
export type ToolCallPart = {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  /** The raw JSON string the model emitted; may not be valid JSON mid-stream. */
  readonly arguments: string;
};
export type ToolResultPart = {
  readonly type: "tool_result";
  readonly id: string;
  readonly output: string;
  readonly is_error: boolean;
};
/**
 * An attached image.
 *
 * An `attachment_id`, never bytes and never a URL. The bytes live in the blob
 * store and the URL is minted per request, short-lived and scoped to the
 * viewer, so a URL baked into stored content would be a bearer token that
 * outlives the session it was issued for. The renderer asks for a fresh one.
 */
export type ImagePart = {
  readonly type: "image";
  readonly attachment_id: string;
  readonly filename: string;
  readonly content_type: string;
};

/**
 * An attached document and the text extracted from it.
 *
 * `text` is null when nothing was extracted -- a PDF, whose text the API
 * deliberately does not parse. `truncated` is what lets the UI say the model
 * saw only part of the file, which is the whole reason the flag exists.
 */
export type DocumentPart = {
  readonly type: "document";
  readonly attachment_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly text: string | null;
  readonly truncated: boolean;
};

/**
 * A note the import left on the first turn of a conversation brought in
 * from another assistant: where it came from and what was left behind.
 * Shown in the thread, never part of the message's text, so it is not
 * sent upstream or searched.
 */
export type ImportNotePart = {
  readonly type: "import_note";
  readonly text: string;
};

export type UnknownPart = { readonly type: string };

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ImagePart
  | DocumentPart
  | ImportNotePart
  | UnknownPart;

export type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly content: readonly MessagePart[];
  readonly metadata?: { readonly custom?: { readonly model?: string } };
};

export type ChatModelRunResult = {
  readonly content?: readonly MessagePart[];
  readonly metadata?: { readonly custom?: { readonly model?: string } };
  readonly status?: { readonly type: "incomplete"; readonly reason: "cancelled" };
};

/** Narrowing helpers, so a renderer never reads a field off the wrong kind. */
export function isTextPart(part: MessagePart): part is TextPart {
  return part.type === "text" && typeof (part as TextPart).text === "string";
}

export function isImportNotePart(part: MessagePart): part is ImportNotePart {
  return part.type === "import_note" && typeof (part as ImportNotePart).text === "string";
}

export function isReasoningPart(part: MessagePart): part is ReasoningPart {
  return part.type === "reasoning" && typeof (part as ReasoningPart).text === "string";
}

export function isToolCallPart(part: MessagePart): part is ToolCallPart {
  return part.type === "tool_call" && typeof (part as ToolCallPart).name === "string";
}

export function isToolResultPart(part: MessagePart): part is ToolResultPart {
  return part.type === "tool_result" && typeof (part as ToolResultPart).id === "string";
}

export function isImagePart(part: MessagePart): part is ImagePart {
  return part.type === "image" && typeof (part as ImagePart).attachment_id === "string";
}

export function isDocumentPart(part: MessagePart): part is DocumentPart {
  return part.type === "document" && typeof (part as DocumentPart).attachment_id === "string";
}

/** The text of a message: its text parts, in order. Mirrors `parts.text_of`. */
export function textOfParts(content: readonly MessagePart[]): string {
  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}

export type ChatModelAdapter = {
  run(args: {
    messages: readonly ChatMessage[];
    /**
     * The attachments this turn carries. Ids of rows already uploaded
     * and already sniffed, never bytes and never a declared content type:
     * there is nothing here for a client to lie about, which is why the send
     * body takes ids rather than files.
     */
    attachmentIds?: readonly string[];
    abortSignal: AbortSignal;
  }): AsyncGenerator<ChatModelRunResult, void, unknown>;
};
import type { Conversation } from "../../types";
import { ApiError, apiFetch, apiStream } from "../../lib/api";
import { notifyGenerationComplete } from "../../lib/desktopAuth";
import { parseSSEStream } from "../../lib/sse";
import { REFUSAL_CODE, TRUNCATED_CODE } from "./streamErrors";
import { noticeText, type CompactionFrame, type ContextFrame } from "./compaction";

export interface ChatAdapterHooks {
  getConversationId: () => string | null;
  /** The picker's selection for this conversation; null means the server default. */
  getModel: () => string | null;
  onConversationCreated: (conversation: Conversation) => void;
  /**
   * Whether the conversation this send creates is temporary. Read once, at
   * creation; absent means a kept conversation.
   */
  getTemporary?: () => boolean;
  onRenamed: (conversationId: string, title: string) => void;
  onSettled: () => void;
  /**
   * A failure, as the detail string plus whatever the transport knows about
   * it.
   *
   * `requestId` is the id of the response the failure came from, so the
   * notice the user sees can quote something that appears in the API's logs;
   * `code` is a refusal frame's machine-readable kind, which classifies more
   * reliably than the prose beside it. Both are optional because an error
   * raised before the API answered has neither.
   */
  onError: (message: string, meta?: { requestId?: string | null; code?: string }) => void;
  /** The server folded older turns into a summary before this one. */
  onCompaction?: (frame: CompactionFrame) => void;
  /** The real token count for the turn just finished, beside `done`. */
  onContext?: (frame: ContextFrame) => void;
  /**
   * Something the user should know that is not a failure: a fold that could
   * not run, after which the turn went ahead uncompacted.
   */
  onNotice?: (message: string) => void;
  /** The answer, by its stored id, ran out of tokens before it finished. */
  onLengthTruncated?: (messageId: string) => void;
}

/** The prompt we send: the user's text, which is all a user turn carries. */
function promptOf(content: readonly MessagePart[]): string {
  return textOfParts(content);
}

/** One SSE `part_start` frame: everything but the streamed text. */
type PartStart = {
  index: number;
  type: string;
  id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  is_error?: boolean;
};

/**
 * Bridges the chat UI to the MatterWave API: one
 * conversation per thread, one POST per exchange, deltas streamed from the
 * server's SSE response. `abortSignal` is the Stop button; passing it to
 * `fetch` closes the request, which cancels the upstream stream.
 */
export function createChatAdapter(hooks: ChatAdapterHooks): ChatModelAdapter {
  return {
    async *run({ messages, attachmentIds, abortSignal }) {
      const last = messages[messages.length - 1];
      const prompt = promptOf(last?.content ?? []);
      if (!prompt) return;
      const attachments = attachmentIds ?? [];

      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          hooks.onSettled();
        }
      };

      /**
       * Did the stream end the way a stream is supposed to end?
       *
       * A phone drops its connection constantly — screen lock, app
       * switch, wifi-to-cellular handover, a lift — and when it does, the
       * response body simply ENDS. No `done`, no `error`, no exception: the
       * reader reports `done: true` and the loop below falls out of the
       * bottom as if everything were fine.
       *
       * Measured before this flag: a stream cut after one delta left the
       * partial sentence on screen with no error, no retry and no indication
       * it was incomplete. The user is shown a truncated answer formatted
       * exactly like a finished one, which is the worst of the available
       * outcomes — it is wrong and it does not say so.
       *
       * Resuming such a stream is a separate piece of work. Saying so is
       * this one's.
       */
      let sawTerminal = false;

      /**
       * The correlation id of the response this turn is streaming from, once
       * it has arrived. Held across the whole generator so every exit — a
       * refusal frame, a truncated body, a thrown read — can quote it.
       */
      let requestId: string | null = null;

      let conversationId = hooks.getConversationId();
      // The turn is built as an ordered list of parts, indexed by the
      // server's `index`, rather than one accumulating string. A tool call
      // appears the moment it starts and its result lands beside it, so the
      // UI can render a call while it runs.
      const parts: MessagePart[] = [];
      // The model that answered, from the API's final `done` event;
      // undefined until then, so earlier yields carry no claim.
      let model: string | undefined;
      const emit = (): ChatModelRunResult => ({
        // A fresh array each yield: React compares by identity, and mutating
        // the one already handed out would not re-render.
        content: parts.map((part) => ({ ...part })),
        metadata: model === undefined ? undefined : { custom: { model } },
      });

      /** Grow the list so `index` exists, then return it. */
      const at = (index: number): number => {
        while (parts.length <= index) parts.push({ type: "text", text: "" });
        return index;
      };
      try {
        if (!conversationId) {
          const conversation = await apiFetch<Conversation>("/api/conversations", {
            method: "POST",
            // `temporary` only when on, so a kept chat's request is unchanged.
            json: { title: "New chat", ...(hooks.getTemporary?.() ? { temporary: true } : {}) },
          });
          conversationId = conversation.id;
          hooks.onConversationCreated(conversation);
        }

        // Per-request model selection: the picker's choice rides on
        // each send, so switching mid-conversation is just a different body.
        const selectedModel = hooks.getModel();
        // `attachment_ids` is omitted entirely when there are none,
        // rather than sent as `[]`. The field is optional on the API's
        // `SendMessage` and an empty list is the default, so sending one would
        // only mean this client looks different to an API that predates the
        // field for no gain.
        const stream = await apiStream(
          `/api/conversations/${conversationId}/messages`,
          {
            content: prompt,
            ...(selectedModel === null ? {} : { model: selectedModel }),
            ...(attachments.length > 0 ? { attachment_ids: [...attachments] } : {}),
          },
          abortSignal,
        );
        // Captured before the first frame is read: a stream that dies
        // mid-answer has no Response left to ask, and this turn's failure
        // notice has to be able to quote an id.
        requestId = stream.requestId;

        for await (const event of parseSSEStream(stream.body)) {
          if (event.event === "part_start") {
            const start = JSON.parse(event.data) as PartStart;
            const i = at(start.index);
            // The whole part, minus any text that streams in after it. A tool
            // call and its result arrive complete, because the server ran the
            // tool before it said anything about it.
            parts[i] =
              start.type === "tool_call"
                ? {
                    type: "tool_call",
                    id: start.id ?? "",
                    name: start.name ?? "",
                    arguments: start.arguments ?? "",
                  }
                : start.type === "tool_result"
                  ? {
                      type: "tool_result",
                      id: start.id ?? "",
                      output: start.output ?? "",
                      is_error: start.is_error === true,
                    }
                  : start.type === "reasoning"
                    ? { type: "reasoning", text: "" }
                    : start.type === "text"
                      ? { type: "text", text: "" }
                      : // An unknown kind is kept, not dropped: the renderer
                        // shows a placeholder and the transcript survives.
                        { type: start.type };
            yield emit();
          } else if (event.event === "part_end") {
            // Nothing to do: the part is already whole. The frame exists so a
            // renderer can stop showing a part as in-flight.
          } else if (event.event === "delta") {
            const delta = JSON.parse(event.data) as {
              content?: string;
              reasoning?: string;
              index?: number;
            };
            // `index` is absent on a stream from an API that predates typed parts;
            // such a stream only ever has one text part, which is index 0.
            const i = at(delta.index ?? 0);
            const existing = parts[i];
            if (delta.reasoning !== undefined) {
              const text = isReasoningPart(existing) ? existing.text : "";
              parts[i] = { type: "reasoning", text: text + delta.reasoning };
            } else if (delta.content !== undefined) {
              const text = isTextPart(existing) ? existing.text : "";
              parts[i] = { type: "text", text: text + delta.content };
            }
            yield emit();
          } else if (event.event === "title") {
            const { title } = JSON.parse(event.data) as { title: string };
            hooks.onRenamed(conversationId, title);
          } else if (event.event === "error") {
            const { detail, code, request_id } = JSON.parse(event.data) as {
              detail: string;
              code?: string;
              request_id?: string;
            };
            sawTerminal = true;
            hooks.onError(detail, { requestId: request_id ?? requestId, code });
            settle();
            return;
          } else if (event.event === "moderation_block") {
            // The API streams a block as a 200 with its own frame, deliberately
            // distinct from `error` and from a model refusal. Before this
            // branch existed the frame fell through the chain unhandled, the
            // body then ended with no `done`, and the truncation guard below
            // reported it as "the connection dropped" — telling the user a
            // network lie about a refusal, and inviting the one action
            // guaranteed not to work. The frame carries the request id for
            // exactly this notice.
            const { detail, code, request_id } = JSON.parse(event.data) as {
              detail: string;
              code?: string;
              request_id?: string;
            };
            sawTerminal = true;
            hooks.onError(detail, {
              requestId: request_id ?? requestId,
              code: code ?? "moderation",
            });
            settle();
            return;
          } else if (event.event === "refusal") {
            // The model declined, and the API has already retracted whatever
            // it streamed first and stored its own notice as the turn. The
            // partial text in the local parts goes the same way: a half-answer
            // above a refusal reads as the answer. Terminal, like a block, and
            // its own code so the notice is the designed one and not an error.
            const { detail, code, request_id } = JSON.parse(event.data) as {
              detail: string;
              code?: string;
              request_id?: string;
            };
            parts.length = 0;
            sawTerminal = true;
            hooks.onError(detail, {
              requestId: request_id ?? requestId,
              code: code ?? REFUSAL_CODE,
            });
            settle();
            return;
          } else if (event.event === "compaction") {
            // Before the user turn's `message` frame. Not terminal: the
            // answer has not started, so a body that ends here is still cut.
            hooks.onCompaction?.(JSON.parse(event.data) as CompactionFrame);
          } else if (event.event === "context") {
            hooks.onContext?.(JSON.parse(event.data) as ContextFrame);
          } else if (event.event === "notice") {
            hooks.onNotice?.(noticeText(event.data));
          } else if (event.event === "done") {
            sawTerminal = true;
            const done = JSON.parse(event.data) as {
              id?: string;
              model: string | null;
              truncated?: boolean;
              finish_reason?: string | null;
            };
            model = done.model ?? undefined;
            // A complete stream of an incomplete answer: the model hit its
            // token limit. Not an error -- the stream did end properly -- so
            // it is reported apart and the UI offers Continue, not Retry.
            // `truncated` with a null reason is an answer whose stream
            // stopped (a resumed turn whose first reader went away), not
            // the limit; only an API with no reason field leaves the flag
            // to mean the limit alone.
            const onLength =
              done.finish_reason === "length" ||
              (done.truncated === true && done.finish_reason === undefined);
            if (onLength && done.id) {
              hooks.onLengthTruncated?.(done.id);
            }
            yield emit();
            settle();
            // The answer is complete; whether anyone saw it land is the
            // native side's call -- it notifies only an unfocused window.
            notifyGenerationComplete();
          }
        }

        // The body ended with no `done` and no `error`. On a phone this is the
        // ordinary case, not an exotic one, and it must not pass for success.
        // `truncated` is the designed copy for it: the stream ended before
        // the model finished and whatever arrived is kept above — which is
        // exactly true, and the partial text does stay on screen above the
        // notice. The code, not the sentence, is what classifies it.
        //
        // The abort check keeps the Stop button silent: a user who cancelled
        // knows why the answer stopped and does not need to be told it failed.
        if (!sawTerminal && !abortSignal.aborted) {
          hooks.onError("The connection dropped before the answer finished.", {
            requestId,
            code: TRUNCATED_CODE,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          yield { status: { type: "incomplete", reason: "cancelled" } };
        } else {
          hooks.onError(err instanceof Error ? err.message : "Streaming failed.", {
            // An ApiError knows its own id; a thrown read falls back to the
            // one captured when the stream opened, which may be null.
            requestId: err instanceof ApiError ? err.requestId : requestId,
            // A throw after the stream opened is a stream that died
            // mid-answer, whatever the browser called the exception; one
            // before it is the open failing, which the status classifies.
            code: requestId === null ? undefined : TRUNCATED_CODE,
          });
        }
      } finally {
        settle();
      }
    },
  };
}
