import { RefreshCwIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { STREAM_ERROR_COPY, type StreamErrorKind } from "./streamErrors";
import { AiDisclosure } from "./AiDisclosure";
import { EXAMPLE_PROMPTS } from "./examplePrompts";
import { HELP_PATH } from "../../shell/help";

/**
 * The chat surface's empty, loading and error states.
 *
 * They live together because they are one design problem — what the transcript
 * shows when it is not showing a conversation — and because /dev/states must
 * mount every one of them without reproducing the failure that causes it.
 */

/**
 * The new-conversation surface. Not a fallback: it is the first thing
 * a new user sees, so it carries the product line, the AI disclosure
 * required before a first message, and example prompts that fill the composer
 * when clicked. The model picker is rendered by the caller just above this,
 * where it stays visible for the rest of the conversation.
 */
export function NewConversationState(props: {
  onPickPrompt: (prompt: string) => void;
  /**
   * Send the prompt immediately. Optional: /dev/states mounts
   * this component with no thread behind it, and the picker still has to be
   * reviewable there.
   */
  onSendPrompt?: (prompt: string) => void;
  /** Sending is disabled while offline, so the cards must be too. */
  disabled?: boolean;
}) {
  return (
    /* min-h-full and safe centring rather than h-full and justify-center:
       a centred column taller than a phone screen overflows both ways and
       its top -- the heading -- was cut off where it could not be scrolled
       to. It grows with its content and centres only when there is room. */
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center-safe gap-6 px-4 py-6 md:py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">
          What can I help you with?
        </h2>
        {/* One sentence on what this is, for a stranger arriving from a shared
            link — they may never have seen the landing page. */}
        <p className="max-w-md text-sm text-mw-text-muted">
          MatterWave is a chat workspace: ask anything and an AI model answers. Type below,
          pick a model above, or start from one of these.
        </p>
        <AiDisclosure />
      </div>
      <ul className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((example) => (
          <li key={example.title}>
            {/*
              One click sends: the card is the send button, and
              a new user who clicks one gets an answer rather than a filled
              box and a second thing to find.

              The ticket and the first cut of this component disagreed here —
              it filled the composer so the prompt could be read and edited
              before it cost a request. That concern is real but it is the
              wrong default: the person it protects is a cost-conscious
              returning user, and the person this screen exists for has never
              seen an answer from this product and may not realise the box is
              the point. So sending is the click, and "Edit first" keeps the
              old behaviour one keystroke away for anyone who wants it.
            */}
            <div
              className={`flex h-full flex-col rounded-xl border border-mw-border bg-mw-surface-raised transition-colors ${
                props.disabled ? "opacity-60" : "hover:bg-mw-surface-hover"
              }`}
            >
              <button
                type="button"
                disabled={props.disabled}
                onClick={() =>
                  props.onSendPrompt
                    ? props.onSendPrompt(example.prompt)
                    : props.onPickPrompt(example.prompt)
                }
                className="flex-1 p-3 text-left disabled:cursor-not-allowed"
              >
                <span className="block text-sm font-medium">{example.title}</span>
                <span className="mt-1 block text-xs text-mw-text-muted">{example.prompt}</span>
              </button>
              {props.onSendPrompt && (
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={() => props.onPickPrompt(example.prompt)}
                  className="self-start px-3 pb-2 text-xs text-mw-text-muted underline hover:text-mw-text disabled:cursor-not-allowed pointer-coarse:min-h-11 pointer-coarse:pb-0"
                >
                  Edit first
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {/* The one way into the help page that is not a keystroke, placed
          where a new user is when they wonder what the keys do. A plain
          anchor, like the budget link below: this renders without a router. */}
      <a
        href={HELP_PATH}
        className="inline-flex items-center text-xs text-mw-text-muted underline hover:text-mw-text pointer-coarse:min-h-11"
      >
        Help and keyboard shortcuts
      </a>
    </div>
  );
}

/**
 * The transcript while stored messages load. Shaped like the
 * transcript — alternating right-aligned user bubbles and full-width assistant
 * blocks — so nothing jumps when the real messages arrive. No spinner: a
 * spinner says "busy", a skeleton says "here is what is coming".
 */
export function TranscriptSkeleton() {
  return (
    <div role="status" className="mx-auto w-full max-w-3xl px-4 py-6">
      <span className="sr-only">Loading conversation…</span>
      <div aria-hidden className="flex flex-col gap-6">
        {[0, 1].map((turn) => (
          <div key={turn} className="flex flex-col gap-6">
            <div className="flex justify-end">
              <Skeleton className="h-9 w-1/2 rounded-2xl" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The sidebar while the conversation list loads. One bar per row at
 * the row's real height, so the list does not reflow when it lands.
 */
export function ConversationListSkeleton(props: { rows?: number }) {
  const rows = Math.max(1, props.rows ?? 6);
  return (
    <div role="status" className="flex flex-col gap-1 px-2 pb-3">
      <span className="sr-only">Loading conversations…</span>
      <div aria-hidden className="flex flex-col gap-1">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton
            key={index}
            // Varied widths: a column of identical bars reads as a loading
            // graphic, varied ones read as a list of titles.
            className={`h-7 ${index % 3 === 0 ? "w-4/5" : index % 3 === 1 ? "w-full" : "w-3/5"}`}
          />
        ))}
      </div>
    </div>
  );
}

/** When the wait stops being "a cold model" and starts being worth saying so. */
const STALL_ESCALATE_MS = 15_000;
/** When the wait is given up on: the turn is stopped and Retry offered. */
const STALL_GIVE_UP_MS = 60_000;

/**
 * Sent, nothing back yet. A cold model is several seconds of silence,
 * and unlabelled silence is indistinguishable from a hang — so this says what
 * is being waited on. Stop stays available through the composer as usual.
 *
 * The copy does not stay reassuring forever: past 15 seconds it says the
 * wait is unusual, and at a minute `onGiveUp` runs, which the page answers by
 * stopping the turn and offering Retry -- a spinner that never ends is the
 * hang this exists to rule out.
 */
export function AwaitingFirstToken(props: { onGiveUp?: () => void }) {
  const [slow, setSlow] = useState(false);
  const giveUp = useRef(props.onGiveUp);
  useEffect(() => {
    giveUp.current = props.onGiveUp;
  }, [props.onGiveUp]);
  useEffect(() => {
    const escalate = setTimeout(() => setSlow(true), STALL_ESCALATE_MS);
    const stop = setTimeout(() => giveUp.current?.(), STALL_GIVE_UP_MS);
    return () => {
      clearTimeout(escalate);
      clearTimeout(stop);
    };
  }, []);
  return (
    <p
      aria-live="polite"
      data-mw-phase="awaiting-first-token"
      data-mw-stalled={slow ? "" : undefined}
      className="flex items-center gap-2 py-2 text-sm text-mw-text-muted"
    >
      <span aria-hidden className="flex gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-mw-text-muted" />
        <span className="size-1.5 animate-pulse rounded-full bg-mw-text-muted" />
        <span className="size-1.5 animate-pulse rounded-full bg-mw-text-muted" />
      </span>
      {slow
        ? "Still waiting — the model is taking longer than usual. Keep waiting, or Stop and try another model."
        : "Waiting for the model… a cold model can take a few seconds."}
    </p>
  );
}

/**
 * The end of an answer the person stopped, or whose stream stopped under it
 * (a reload, a closed tab). Not the red "cut off" alert: nothing failed,
 * and the person who pressed Stop knows why it stopped. What arrived is kept
 * above; Continue asks for the rest.
 */
export function StoppedNote(props: { onContinue?: () => void }) {
  return (
    <p data-mw-stopped="" className="my-2 flex items-center gap-3 text-xs text-mw-text-muted">
      <span>Stopped</span>
      {props.onContinue && (
        <button
          type="button"
          onClick={props.onContinue}
          className="rounded px-1 py-0.5 underline hover:text-mw-text pointer-coarse:px-3 pointer-coarse:py-3"
        >
          Continue
        </button>
      )}
    </p>
  );
}

/**
 * The transcript's one live region, mounted for the life of the page.
 *
 * A live region that mounts with its text is often not read at all, and
 * one that unmounts takes its last word with it -- which is how the end of
 * an answer went unannounced. This stays in the tree and changes its text
 * on each phase change, so a screen reader hears "Waiting", "Responding" and
 * "Answer finished". A failure is left to the alert that reports it.
 */
export function PhaseAnnouncer(props: { phase: string; failed: boolean }) {
  const [seen, setSeen] = useState(props.phase);
  const [text, setText] = useState("");
  if (seen !== props.phase) {
    setSeen(props.phase);
    setText(
      props.phase === "awaiting-first-token"
        ? "Waiting for the model"
        : props.phase === "streaming"
          ? "Responding"
          : props.failed
            ? ""
            : "Answer finished",
    );
  }
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-mw-announcer="" className="sr-only">
      {text}
    </div>
  );
}

/**
 * Tokens are arriving: the transcript is already growing, so this stays
 * quiet. The attribute is what tells this state from the one above in a
 * test: the words alone could both be read as "busy".
 */
export function StreamingIndicator() {
  return (
    <p aria-live="polite" data-mw-phase="streaming" className="py-2 text-sm text-mw-text-muted">
      Responding…
    </p>
  );
}

/**
 * The correlation id under an error.
 *
 * The whole point of this line is that a screenshot of it leads to the trace:
 * the API stamps `X-Request-Id` on every response, puts `request_id` in every
 * error body, and writes it on every log line for the request. Without it a
 * support conversation starts from "it broke" and a guess at the timestamp.
 *
 * Selectable, monospaced and labelled, because it exists to be copied. When
 * there is no id the line says so rather than disappearing: "no reference"
 * tells a reader their screenshot is not going to be enough, which is worth
 * knowing, and an empty slot would read as an id that failed to render.
 */
export function RequestReference(props: { requestId: string | null }) {
  if (props.requestId === null) {
    return (
      <span className="text-mw-text-muted">
        No reference for this failure — it happened before the server answered.
      </span>
    );
  }
  return (
    <span>
      Reference{" "}
      <code data-testid="request-id" className="select-all font-mono">
        {props.requestId}
      </code>
    </span>
  );
}

/**
 * Every stream failure mode's inline error.
 *
 * In the transcript, not a toast: the rule is that an error belonging
 * to the transcript renders in it, because a toast vanishes before it is read
 * and takes the "what do I do now?" with it.
 */
export function TranscriptError(props: {
  kind: StreamErrorKind;
  /**
   * Small print under the guidance; never a stack trace or a raw response
   * body. Pass a `RequestReference` here — the correlation id is what this
   * slot was reserved for.
   */
  reference?: ReactNode;
  onRetry?: () => void;
  /**
   * The answer stopped at the model's token limit rather than on a dropped
   * stream: the same notice, but the way on is to ask for the rest, not to
   * ask again.
   */
  onContinue?: () => void;
  onDismiss?: () => void;
}) {
  const copy = STREAM_ERROR_COPY[props.kind];
  const guidance = props.onContinue
    ? "The model reached the most it can write in one answer before it finished. Whatever arrived is kept above; continue to have it pick up where it stopped."
    : copy.guidance;
  // A refusal is a deliberate outcome, not a failure: it is drawn as a
  // notice, not in the danger colour the faults use, because a red card
  // reads as "something broke" and as an accusation, and it is neither.
  const notice = props.kind === "refusal";
  return (
    <div
      role={notice ? "status" : "alert"}
      data-error-kind={props.kind}
      className={
        notice
          ? "my-4 rounded-xl border border-mw-border bg-mw-surface-raised p-4 text-sm text-mw-text"
          : "my-4 rounded-xl border border-mw-danger bg-mw-danger-subtle p-4 text-sm text-mw-text"
      }
    >
      <p className={notice ? "font-medium text-mw-text" : "font-medium text-mw-danger"}>{copy.title}</p>
      <p className="mt-1 text-mw-text-muted">{guidance}</p>
      {props.reference && (
        <p className="mt-2 font-mono text-xs text-mw-text-muted">{props.reference}</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        {copy.retryable && props.onRetry && (
          <button
            type="button"
            onClick={props.onRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            Retry
          </button>
        )}
        {props.onContinue && (
          <button
            type="button"
            onClick={props.onContinue}
            className="inline-flex items-center gap-1.5 rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
          >
            Continue
          </button>
        )}
        {props.kind === "budget" && (
          // The way out of the one refusal a retry can never fix: the balance,
          // the reset date, and the upgrade are all on the Usage pane, so that
          // is the link -- not "contact an admin".
          // A plain anchor, not the router's <Link>: this is a leaf rendered
          // by ChatStates.test.tsx and StatesPage.test.tsx without a
          // RouterProvider, and <Link> throws outside one. UserMenu.tsx
          // links /settings/account the same way.
          <a
            href="/settings/usage"
            className="inline-flex items-center rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
          >
            See usage and plans
          </a>
        )}
        {props.kind === "context" && (
          // The guidance names two ways out; this is the one that needs no
          // decision about models. Same plain anchor as the budget link.
          <a
            href="/apps/chat"
            className="inline-flex items-center rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
          >
            Start a new chat
          </a>
        )}
        {props.onDismiss && (
          <button
            type="button"
            onClick={props.onDismiss}
            className="rounded-lg px-2 py-1.5 text-sm text-mw-text-muted underline hover:text-mw-text"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A conversation the address names but the server does not have: deleted,
 * or never this person's. Not a failed stream -- there is nothing to retry,
 * so there is no Retry; the way on is a new chat.
 */
export function ConversationMissing() {
  return (
    <div
      role="alert"
      data-error-kind="missing"
      className="my-4 rounded-xl border border-mw-border bg-mw-surface-raised p-4 text-sm text-mw-text"
    >
      <p className="font-medium">This conversation is not available</p>
      <p className="mt-1 text-mw-text-muted">
        It was deleted, or the link is not one of your conversations.
      </p>
      <div className="mt-3">
        <a
          href="/apps/chat"
          className="inline-flex items-center rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
        >
          Start a new chat
        </a>
      </div>
    </div>
  );
}

/**
 * The offline banner. navigator.onLine's `false` is the reliable
 * half, so this only appears when sending is certain to fail; the composer
 * disables send in the same breath. There is no reconnect button because there
 * is nothing to press — the browser fires `online` and the banner goes away by
 * itself, which is what automatic reconnect means here.
 */
export function OfflineBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-2 border-b border-mw-warning bg-mw-warning-subtle px-4 py-2 text-sm text-mw-warning-foreground"
    >
      <WifiOffIcon className="size-4 shrink-0" aria-hidden />
      <span>
        You are offline. Sending is paused and your draft is kept — this clears itself the moment
        the connection is back.
      </span>
    </div>
  );
}
