import type { Message, ModelInfo } from "../../types";
import { apiFetch } from "../../lib/api";
import type { BranchedMessage } from "./useBranchedThread";

/**
 * Compaction, client-side: the meter's arithmetic, the fold of a path at a
 * summary, and the two routes behind them.
 *
 * The server folds old turns into a summary message when the next prompt
 * would not fit the model's window. The summary is a `system` message in the
 * tree hung under the leaf it was computed from: `covers_from`..`covers_to`
 * are the turns it folded, and the turns between `covers_to` and the summary
 * are the recent tail it kept verbatim. Every original is still an ancestor
 * and already in the tree this SPA holds, so expanding the fold is a render
 * decision, never a fetch. Its text is the summary part's; `content` is empty.
 */

/** The one part a summary message carries. */
export type SummaryPart = {
  readonly type: "summary";
  readonly text: string;
  readonly covers_from: string;
  readonly covers_to: string;
  readonly tokens_before: number;
  readonly tokens_after: number;
};

/**
 * The `context` frame just before `done`, sent only when something is known:
 * the window, the upstream's real counts, or both. A count the upstream did
 * not report is null.
 */
export type ContextFrame = {
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly context_window: number | null;
};

/** The `compaction` frame, sent before the user turn's `message` frame when a fold ran. */
export type CompactionFrame = {
  readonly message: Message;
  readonly covers_from: string;
  readonly covers_to: string;
  readonly tokens_before: number;
  readonly tokens_after: number;
};

/** `GET /api/conversations/{id}/context`. */
export type ConversationContext = {
  readonly model: string | null;
  readonly context_window: number | null;
  readonly used_tokens: number | null;
  /** `used_tokens` is the latest summary's estimate, not a counted turn. */
  readonly estimated: boolean;
  readonly compactable: boolean;
  /** Recent user/assistant pairs a fold keeps verbatim; absent from an older API. */
  readonly keep_pairs?: number;
};

/**
 * What the meter knows before the draft is added: tokens the next prompt
 * already carries, and the window they count against. `used` is null when no
 * turn has been counted yet, which reads as zero.
 */
export type ContextReading = {
  readonly used: number | null;
  readonly window: number | null;
  /** `used` came from a summary's estimate rather than a counted turn. */
  readonly estimated?: boolean;
};

/** What a `context` frame says the next prompt already carries: the last prompt plus its answer. */
export function readingOfFrame(frame: ContextFrame): ContextReading {
  const used =
    frame.prompt_tokens === null ? null : frame.prompt_tokens + (frame.completion_tokens ?? 0);
  return { used, window: frame.context_window, estimated: false };
}

/** What `GET .../context` says, as the meter reads it. */
export function readingOfContext(answer: ConversationContext): ContextReading {
  return {
    used: answer.used_tokens,
    window: answer.context_window,
    estimated: answer.estimated === true,
  };
}

/** A stored message that may carry the finish reason of its last round. */
export type FinishedMessage = Message & {
  readonly truncated?: boolean;
  readonly finish_reason?: string | null;
};

export function summaryOf(message: Message): SummaryPart | null {
  if (message.role !== "system") return null;
  const part = message.parts?.find((p) => p.type === "summary") as SummaryPart | undefined;
  return part && typeof part.text === "string" ? part : null;
}

/**
 * The server's estimate for text it has not counted: a quarter of its length.
 * The same arithmetic on both sides keeps the meter and the fold decision
 * within the estimate of each other; a tokenizer here would only disagree
 * with the server more precisely.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type MeterLevel = "ok" | "warn" | "full";

export type MeterReading = {
  readonly used: number;
  readonly window: number;
  readonly ratio: number;
  readonly level: MeterLevel;
  readonly estimated: boolean;
};

/** Null when the model has no window: a meter against an unknown limit says nothing true. */
export function meterReading(context: ContextReading, draft: string): MeterReading | null {
  const { window } = context;
  if (window === null || !(window > 0)) return null;
  const used = (context.used ?? 0) + estimateTokens(draft);
  const ratio = used / window;
  return {
    used,
    window,
    ratio,
    level: ratio >= 0.9 ? "full" : ratio >= 0.75 ? "warn" : "ok",
    estimated: context.estimated === true,
  };
}

/**
 * The window the next turn counts against.
 *
 * A model picked in the picker wins, because that is the model the next send
 * names. With none picked, the conversation's own model as the server
 * reported it, then the deployment default from the list. `undefined` from
 * the context means "not asked yet", whereas `null` means "this model has no
 * window", which hides the meter rather than falling through.
 */
export function resolveWindow(args: {
  selectedModel: string | null;
  defaultModel: string | null;
  models: readonly ModelInfo[] | null;
  contextWindow: number | null | undefined;
}): number | null {
  const find = (id: string | null) =>
    id === null ? undefined : args.models?.find((model) => model.id === id);
  const selected = find(args.selectedModel);
  if (selected) return selected.context_window ?? null;
  if (args.contextWindow !== undefined) return args.contextWindow;
  return find(args.defaultModel)?.context_window ?? null;
}

/** One row of the rendered transcript once summaries are folded. */
export type FoldedRow =
  | { readonly kind: "message"; readonly entry: BranchedMessage; readonly index: number }
  | {
      /**
       * Where the folded originals were: right after `covers_to`, before the
       * kept tail. Expanded, the originals render above it.
       */
      readonly kind: "fold";
      /** The summary that folded them; expansion is keyed by its id. */
      readonly entry: BranchedMessage;
      readonly summary: SummaryPart;
      /** How many messages on the path the fold stands for. */
      readonly covered: number;
      readonly expanded: boolean;
    }
  | {
      /** The summary message itself, where it sits in the tree: after the tail it kept. */
      readonly kind: "summary";
      readonly entry: BranchedMessage;
      readonly summary: SummaryPart;
    };

/** The index of the latest summary on the path, or -1. Only it counts: a later fold summarised the earlier ones too. */
function latestSummaryIndex(path: readonly Message[]): number {
  for (let i = path.length - 1; i >= 0; i -= 1) if (summaryOf(path[i])) return i;
  return -1;
}

/**
 * The covered range of the summary at `s`, as path indices, read the way the
 * server's prompt builder reads it: `covers_to` found above the summary, or
 * everything above it when it is not (a pruned or malformed part); then back
 * to `covers_from`, or the path's start when that is not found.
 */
function coveredRange(path: readonly Message[], s: number, summary: SummaryPart): [number, number] {
  const to = path.findIndex((m) => m.id === summary.covers_to);
  const end = to >= 0 && to < s ? to : s - 1;
  const from = path.findIndex((m) => m.id === summary.covers_from);
  const start = from >= 0 && from <= end ? from : 0;
  return [start, end];
}

/**
 * The path with the latest summary's folded turns collapsed into one divider.
 *
 * The divider sits after `covers_to`, where the originals were; the kept tail
 * follows it verbatim, and the summary message renders where it sits, after
 * that tail. Only the latest summary folds: its `covers_from` is carried
 * forward from the one before, so its range already holds every earlier fold.
 * An earlier summary inside that range is hidden with it; one in the tail
 * renders in place. Other system messages are dropped. `index` is the path
 * position, which is what "the last answer" is measured against.
 */
export function foldPath(
  path: readonly BranchedMessage[],
  expanded: ReadonlySet<string>,
): FoldedRow[] {
  const messages = path.map((entry) => entry.message);
  const s = latestSummaryIndex(messages);
  const latest = s >= 0 ? summaryOf(messages[s]) : null;
  let range: [number, number] | null = null;
  let covered = 0;
  if (latest && s > 0) {
    range = coveredRange(messages, s, latest);
    for (let i = range[0]; i <= range[1]; i += 1) if (!summaryOf(messages[i])) covered += 1;
  }
  const open = s >= 0 && expanded.has(messages[s].id);

  const rows: FoldedRow[] = [];
  path.forEach((entry, index) => {
    const inRange = range !== null && index >= range[0] && index <= range[1];
    if (!inRange || open) {
      const summary = summaryOf(entry.message);
      if (summary) rows.push({ kind: "summary", entry, summary });
      else if (entry.message.role !== "system") rows.push({ kind: "message", entry, index });
    }
    if (range !== null && latest !== null && index === range[1] && covered > 0) {
      rows.push({ kind: "fold", entry: path[s], summary: latest, covered, expanded: open });
    }
  });
  return rows;
}

/**
 * Whether Compact now has anything to fold is the server's answer (a 409
 * from `POST .../compact`), never computed here: the kept pairs are a
 * deployment setting (`MW_COMPACTION_KEEP_PAIRS`) this client only reads
 * back (`keep_pairs` on `GET .../context`), and a copy of the rule would
 * disagree with it the day it changes.
 */

/**
 * The sentence of a `notice` frame. The API sends `{detail, code}` (a fold
 * that failed on send, or an edit/regenerate that ran uncompacted); `message`
 * is read too so a frame of another shape still says something.
 */
export function noticeText(data: string): string {
  const frame = JSON.parse(data) as { detail?: unknown; message?: unknown };
  if (typeof frame.detail === "string" && frame.detail) return frame.detail;
  if (typeof frame.message === "string" && frame.message) return frame.message;
  return "The conversation could not be summarised; this turn ran without it.";
}

/**
 * What to tell the reader when `POST .../compact` failed, by its status.
 * The ordinary 409 (nothing to fold yet) is worded by `commands.ts` with
 * the server's kept count; the other 409s are named here.
 */
export function compactFailureNotice(status: number | null, detail: string): string {
  if (status === 409) {
    if (/context window/i.test(detail)) {
      return "This model states no context window, so there is nothing to compact against.";
    }
    if (/switched off/i.test(detail)) return "Compaction is switched off on this deployment.";
    return "Nothing to summarise yet.";
  }
  if (status === 402) {
    return "Your organisation's monthly token budget is used up, so the summary could not be written. Nothing was changed; see Usage for when it resets.";
  }
  if (status === 502) {
    return "The model could not summarise this conversation. Nothing was changed; try again in a moment.";
  }
  return "The conversation could not be summarised. Nothing was lost; try again in a moment.";
}

/** A stored answer whose last round ran out of tokens rather than finishing. */
export function endedOnLength(message: Message, known: ReadonlySet<string>): boolean {
  if (message.role !== "assistant") return false;
  const finished = message as FinishedMessage;
  if (finished.finish_reason === "length" || known.has(message.id)) return true;
  // `truncated` alone is also the flag for an answer that stopped because the
  // stream did -- Stop, a reload, a dropped phone. The server says which by
  // the finish reason: null there is "stopped", see `endedStopped`. Only an
  // API that predates the field (no key at all) leaves `truncated` to mean
  // the length limit by itself.
  return finished.truncated === true && finished.finish_reason === undefined;
}

/**
 * A stored answer that ended because its stream did -- the person pressed
 * Stop, reloaded or closed the tab, or the connection dropped -- rather than
 * because the model finished or ran out of room. The server keeps what
 * arrived, flagged `truncated` with no finish reason.
 */
export function endedStopped(message: Message): boolean {
  if (message.role !== "assistant") return false;
  const finished = message as FinishedMessage;
  return finished.truncated === true && finished.finish_reason === null;
}

export function fetchContext(conversationId: string): Promise<ConversationContext> {
  return apiFetch<ConversationContext>(`/api/conversations/${conversationId}/context`);
}

/**
 * Run the fold without a user turn. Resolves to the summary message, the new
 * leaf. 409 nothing to fold or no window, 402 budget, 502 the summariser failed.
 */
export function compactConversation(conversationId: string): Promise<Message> {
  return apiFetch<Message>(`/api/conversations/${conversationId}/compact`, { method: "POST" });
}
