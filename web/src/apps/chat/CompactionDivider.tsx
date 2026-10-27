import { useId, useState } from "react";
import { meterReading, type ContextReading, type SummaryPart } from "./compaction";

/**
 * Where the folded turns were: right after the last one the summary covers,
 * before the recent tail the server kept verbatim. One click brings the
 * originals back above it; they are ancestors already in the tree, so
 * expanding fetches nothing.
 */
export function CompactionDivider(props: {
  /** How many messages on the path the fold stands for. */
  covered: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-mw-compaction="" className="my-6 text-xs text-mw-text-muted">
      <div className="flex items-center gap-3">
        <div aria-hidden className="h-px flex-1 bg-mw-border" />
        <p className="font-medium">Earlier messages were summarised</p>
        <div aria-hidden className="h-px flex-1 bg-mw-border" />
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          aria-pressed={props.expanded}
          onClick={props.onToggle}
          className="underline underline-offset-2 hover:text-mw-text"
        >
          {props.expanded ? "Hide original messages" : "Show original messages"}
        </button>
      </div>
    </div>
  );
}

/**
 * The summary message where it sits in the tree, after the tail it kept.
 * Its text is collapsed by default: it was written for the model's later
 * use, not as prose for the reader, and an unasked-for block of it in the
 * middle of the conversation reads as a message nobody sent.
 */
export function SummaryMarker(props: { summary: SummaryPart }) {
  const [showText, setShowText] = useState(false);
  const textId = useId();
  return (
    <div data-mw-summary="" className="my-4 text-center text-xs text-mw-text-muted">
      <span>Summary of the earlier messages · </span>
      <button
        type="button"
        aria-expanded={showText}
        aria-controls={textId}
        onClick={() => setShowText((shown) => !shown)}
        className="underline underline-offset-2 hover:text-mw-text"
      >
        {showText ? "Hide summary" : "Show summary"}
      </button>
      {showText && (
        <p
          id={textId}
          className="mx-auto mt-2 max-w-[80%] whitespace-pre-wrap rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-2 text-left text-sm text-mw-text"
        >
          {props.summary.text}
        </p>
      )}
    </div>
  );
}

const LEVEL_CLASS = {
  ok: "text-mw-text-muted",
  warn: "text-mw-warning-foreground",
  full: "text-mw-danger",
} as const;

/** What the button beside a full meter does, in one sentence. */
export const COMPACT_HINT =
  "Compacting summarises the earlier messages so there is room for the next answer.";

/**
 * How much of the model's window the next prompt fills: the last counted
 * turn plus the draft's estimate. Nothing at all for a model with no known
 * window. Amber from three quarters, red from nine tenths -- about where the
 * server starts folding, since it reserves a quarter for the answer.
 *
 * Once it is red, and the page can fold (`onCompact`), the way out sits
 * beside the number with a sentence on what it does: "1,024 / 1,024" on
 * its own is a problem stated with no action offered, and the menu item
 * that solves it is two clicks away under an icon.
 */
export function ContextMeter(props: {
  context: ContextReading;
  draft: string;
  onCompact?: () => void;
  /** A fold is running, or a turn is: the button waits. */
  compactDisabled?: boolean;
}) {
  const reading = meterReading(props.context, props.draft);
  if (reading === null) return null;
  const offerCompact = reading.level === "full" && props.onCompact !== undefined;
  const meter = (
    <span
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={reading.window}
      aria-valuenow={Math.min(reading.used, reading.window)}
      aria-valuetext={`${reading.estimated ? "about " : ""}${reading.used.toLocaleString()} of ${reading.window.toLocaleString()} tokens`}
      data-mw-context-meter={reading.level}
      data-mw-context-estimated={reading.estimated ? "" : undefined}
      title={
        reading.estimated
          ? "Tokens the next message will send, of the model's context window. Estimated from the last summary until the next answer is counted."
          : "Tokens the next message will send, of the model's context window. The draft is estimated."
      }
      className={`text-xs tabular-nums ${LEVEL_CLASS[reading.level]}`}
    >
      {reading.estimated ? "~" : ""}
      {reading.used.toLocaleString()} / {reading.window.toLocaleString()}
    </span>
  );
  if (!offerCompact) return meter;
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <span className="text-xs text-mw-text-muted" data-mw-compact-hint="">
        {COMPACT_HINT}
      </span>
      <button
        type="button"
        onClick={props.onCompact}
        disabled={props.compactDisabled}
        title={props.compactDisabled ? "Wait for the answer to finish" : COMPACT_HINT}
        className="h-7 rounded-md border border-mw-border px-2 text-xs font-medium hover:bg-mw-surface-hover disabled:opacity-40 pointer-coarse:h-11"
      >
        Compact
      </button>
      {meter}
    </span>
  );
}
