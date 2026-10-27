import { ApiError } from "../../lib/api";

/**
 * The failure modes a chat stream can end in, and the copy each one shows.
 *
 * Data and a classifier, deliberately outside the .tsx: the component that
 * renders them stays a component (fast refresh), and the mapping is testable
 * without a DOM.
 *
 * Three rules are encoded here. Every state answers "what do I
 * do now?" in its `guidance`. No state quotes a raw error body — the detail
 * string is matched against, never rendered. And `retryable` is false wherever
 * retrying cannot succeed until something changes elsewhere, so the UI does
 * not offer a button that is guaranteed to fail.
 */
export type StreamErrorKind =
  | "gateway"
  | "timeout"
  | "truncated"
  | "budget"
  | "context"
  | "session"
  | "network"
  | "moderation"
  | "refusal"
  | "unknown";

/**
 * A classified failure with the correlation id of the request that produced
 * it.
 *
 * The id travels with the kind rather than beside it because every surface
 * that renders one renders the other, and the two were separated exactly long
 * enough for the id to be dropped on the way.
 *
 * `requestId` is null where the API never answered - an aborted fetch, a dead
 * uplink - and the UI says so rather than showing a blank reference.
 */
export interface StreamFailure {
  readonly kind: StreamErrorKind;
  readonly requestId: string | null;
}

export interface StreamErrorCopy {
  readonly title: string;
  readonly guidance: string;
  readonly retryable: boolean;
}

export const STREAM_ERROR_COPY: Record<StreamErrorKind, StreamErrorCopy> = {
  // The upstream answered with a refusal or could not be reached at all:
  // nothing of the answer exists. Distinct from `truncated`, where part of
  // it does, and from `timeout`, where the upstream was reached and then
  // went quiet.
  gateway: {
    title: "The model gateway did not answer",
    guidance:
      "The upstream that serves the models is unreachable or returned an error, so no answer was started. Your message is still here — try again, or pick a different model above.",
    retryable: true,
  },
  // The request reached the gateway and then nothing came back inside the
  // time the API allows. Usually a model that is loading or a queue that is
  // full, which a second attempt a moment later often clears.
  timeout: {
    title: "The model took too long to answer",
    guidance:
      "The request reached the gateway but no answer arrived in time — the model may still be loading or busy with other requests. Wait a moment and retry, or pick a different model above.",
    retryable: true,
  },
  // The answer was under way and the stream ended without the API's closing
  // frame. Whatever arrived is real and stays on screen; the copy must say it
  // is incomplete, because a cut answer formatted like a finished one is the
  // worst outcome available.
  truncated: {
    title: "The answer was cut off",
    guidance:
      "The stream ended before the model finished — a dropped connection, a phone switching networks, or the gateway closing the stream early. Whatever arrived is kept above but is not the whole answer; retry to ask again from where the conversation now stands.",
    retryable: true,
  },
  budget: {
    title: "This workspace is out of tokens",
    guidance:
      "This workspace has used its monthly token budget: the plan's included tokens and any overage its cap allows. Nothing is broken — see Usage for when it resets; an admin can raise the overage cap or upgrade the plan.",
    retryable: false,
  },
  context: {
    title: "This conversation is too long for the model",
    guidance:
      "The conversation plus your message exceeds the model's context window. Start a new chat, or pick a model with a larger context window above.",
    retryable: false,
  },
  session: {
    title: "Your session expired mid-response",
    guidance:
      "You were signed out while the model was answering. Anything it had already sent is kept above. Sign in again, then retry.",
    retryable: true,
  },
  // The request never reached the API: the browser's own fetch failed. No
  // reference will exist for it, and the composer's offline banner is the
  // usual companion.
  network: {
    title: "MatterWave could not be reached",
    guidance:
      "The request did not get through — check your connection. Your message is still here, and nothing was sent, so retrying sends it for the first time.",
    retryable: true,
  },
  // Not a technical failure and not the model declining: MatterWave refused
  // to send this. Kept distinct from `unknown` because the research is
  // explicit that a refusal mistaken for a fault is retried forever, and
  // distinct from a model refusal because they are different facts.
  moderation: {
    title: "MatterWave would not send this message",
    guidance:
      "This message was blocked by MatterWave's content rules before it reached a model, so retrying it unchanged will be blocked again. Rephrase it, or quote the reference below to an administrator if you think this is wrong.",
    retryable: false,
  },
  // The model declined. Not a fault and not MatterWave's doing: a 200 that
  // ended in its own frame. The copy is MatterWave's, never the model's; it
  // names benign work because the provider's own documentation does, and it
  // never implies the person did something wrong. Retryable, because the
  // documented way through is a sentence of context and a second attempt.
  refusal: {
    title: "The model declined to answer this one",
    guidance:
      "That happens on ordinary work — security questions, medical or legal detail, fiction — not only on misuse, and it is the model's call rather than MatterWave's. Add a sentence about what you are working on and why, then retry; a different model may answer as asked. If the refusal seems wrong, report the reply as unhelpful so it reaches the product backlog.",
    retryable: true,
  },
  unknown: {
    title: "The response failed",
    guidance:
      "Something went wrong while the model was answering. Your message is still here — retry, and if it keeps happening tell an administrator what you were doing.",
    retryable: true,
  },
};

/** Every kind, in the order /dev/states reviews them. */
export const STREAM_ERROR_KINDS: readonly StreamErrorKind[] = [
  "gateway",
  "timeout",
  "truncated",
  "budget",
  "context",
  "session",
  "network",
  "moderation",
  "refusal",
  "unknown",
];

/**
 * The `code` the stream layer attaches when a body ends without a terminal
 * frame. A code rather than a sentence to match, for the same reason the
 * refusal frame carries one: the text of a detail string is not a contract.
 */
export const TRUNCATED_CODE = "truncated";

/**
 * The `code` on the API's `refusal` frame: the model declined, after possibly
 * streaming part of an answer the API has already retracted. A code, like the
 * two above, because a user can type any sentence and have the model echo it.
 */
export const REFUSAL_CODE = "refusal";

/**
 * Whether loading a conversation failed because it is not there (deleted,
 * or never the caller's): a state, not a failed stream, and retrying it
 * cannot succeed.
 */
export function isMissingConversation(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Place a failure in one of the designed states.
 *
 * Conservative by design: anything it cannot place becomes `unknown`, whose
 * copy is honest about not knowing rather than guessing wrong. Status code
 * first where there is one, because it is the stronger signal; the detail
 * string is a fallback for errors that arrive over SSE without one.
 */
export function classifyStreamError(
  detail: string,
  status?: number,
  /**
   * The machine-readable `code` an SSE refusal frame carries, where there is
   * one. Checked before any text matching because it is the only signal that
   * cannot be spoofed by the contents of a user's own message: the detail
   * string for a moderation block is server copy, but a user is free to type
   * "budget exceeded" and have the model echo it back.
   */
  code?: string,
): StreamErrorKind {
  if (code === "moderation") return "moderation";
  if (code === REFUSAL_CODE) return "refusal";
  if (code === TRUNCATED_CODE) return "truncated";
  const text = detail.toLowerCase();
  if (status === 401 || status === 403 || text.includes("expired") || text.includes("unauthor")) {
    return "session";
  }
  if (
    status === 402 ||
    text.includes("budget") ||
    text.includes("quota")
  ) {
    return "budget";
  }
  if (
    text.includes("context") &&
    (text.includes("length") || text.includes("window") || text.includes("token"))
  ) {
    return "context";
  }
  // Before `gateway`: the API reports an upstream read timeout as "Lost the
  // connection to the model gateway: ... timed out", and the gateway words
  // in that sentence must not outrank the timeout it describes.
  if (
    status === 504 ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("deadline")
  ) {
    return "timeout";
  }
  // The API's own words for a generation that ended with nothing to show:
  // the stream opened and closed with no answer in it.
  if (text.includes("before the answer finished") || text.includes("ended before")) {
    return "truncated";
  }
  if (
    status === 502 ||
    status === 503 ||
    text.includes("gateway") ||
    text.includes("upstream")
  ) {
    return "gateway";
  }
  if (text.includes("network") || text.includes("fetch") || text.includes("connection")) {
    return "network";
  }
  return "unknown";
}
