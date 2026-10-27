import { chordLabel, isMacPlatform, SHORTCUTS } from "../../shell/shortcuts";
import type { UseDictation } from "./useDictation";

/** The toggle's chord, spelt for this platform, for the tooltip. */
function dictateChord(): string {
  const shortcut = SHORTCUTS.find((s) => s.id === "dictate");
  return shortcut ? chordLabel(shortcut.chords[0], isMacPlatform()) : "";
}

/**
 * The microphone button beside the attachment picker, and the notices that
 * go with it. Rendered only when the browser has an engine (speech.ts):
 * Firefox with no server transcriber gets no button rather than a disabled
 * one, because a greyed-out control for something this browser cannot do
 * is a question the page cannot answer.
 *
 * `aria-pressed` carries the on/off state; the status line beside it, read
 * by a screen reader as it changes, says what the microphone is doing. The
 * pulsing dot is the sighted version of the same sentence. Both exist
 * because a live microphone a person has forgotten about is the failure a
 * recording indicator exists to prevent.
 */
export function DictationButton(props: {
  dictation: UseDictation;
  /** The control is kept but cannot start: offline, read only, context full. */
  disabled: boolean;
  /** Why, for the tooltip while disabled. */
  disabledHint?: string;
}) {
  const { dictation } = props;
  if (dictation.engine === null) return null;
  const listening = dictation.state === "listening";
  const transcribing = dictation.state === "transcribing";
  const active = listening || transcribing;
  // Stopping is always allowed: a disabled state must never trap an open
  // microphone.
  const disabled = props.disabled && !active;
  const label = listening
    ? "Stop dictating"
    : transcribing
      ? "Transcribing, press to cancel"
      : "Dictate a message";
  const title = disabled
    ? props.disabledHint ?? "Dictation is not available right now"
    : listening
      ? "Stop dictating (Esc)"
      : `Dictate a message (${dictateChord()})`;
  return (
    <>
      <button
        type="button"
        onClick={dictation.toggle}
        disabled={disabled}
        aria-pressed={active}
        aria-label={label}
        title={title}
        data-mw-dictate-button=""
        data-mw-dictation-state={dictation.state}
        className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
          active
            ? "bg-mw-danger-subtle text-mw-danger-strong"
            : disabled
              ? "cursor-not-allowed text-mw-text-muted opacity-40"
              : "text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
        }`}
      >
        <MicrophoneIcon />
        {active && (
          <span
            aria-hidden="true"
            data-mw-dictation-indicator=""
            className={`absolute right-1.5 top-1.5 size-2 rounded-full bg-mw-danger ${
              listening ? "animate-pulse motion-reduce:animate-none" : ""
            }`}
          />
        )}
      </button>
      {/* The spoken state. `role="status"` is polite: it waits for the
          reader to finish, which is right for "Listening" and wrong for
          nothing here. Rendered always so the live region exists before the
          first change in it, which is what makes screen readers announce it. */}
      <span role="status" className="sr-only" data-mw-dictation-status="">
        {listening ? "Listening…" : transcribing ? "Transcribing…" : ""}
      </span>
    </>
  );
}

/**
 * The messages above the composer box: a failure with its own remedy, and
 * the one-time note on where the audio goes. Each is dismissible and
 * neither touches the draft.
 */
export function DictationNotices(props: { dictation: UseDictation }) {
  const { dictation } = props;
  return (
    <>
      {dictation.privacy !== null && (
        <div
          role="status"
          data-mw-dictation-privacy=""
          className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-2 text-xs text-mw-text-muted"
        >
          <p className="flex-1">{dictation.privacy}</p>
          <button
            type="button"
            onClick={dictation.dismissPrivacy}
            aria-label="Dismiss the dictation privacy note"
            className="shrink-0 font-medium underline"
          >
            Got it
          </button>
        </div>
      )}
      {dictation.failure !== null && (
        <div
          role="alert"
          data-mw-dictation-failure=""
          className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-mw-danger bg-mw-danger-subtle px-3 py-2 text-xs text-mw-danger-strong"
        >
          <p className="flex-1">{dictation.failure}</p>
          <button
            type="button"
            onClick={dictation.dismissFailure}
            aria-label="Dismiss"
            className="shrink-0 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

/** Inline, like the paperclip: one path, no icon module in the chat bundle. */
function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
