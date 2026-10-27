import { useEffect, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FlagIcon,
  GitBranchIcon,
  PencilIcon,
  RefreshCwIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * The per-message branch controls: the "2 / 3" switcher, the
 * Edit action on the user's own messages, and Regenerate on the last answer.
 *
 * Presentational on purpose -- every one of these takes what to show and a
 * callback. The tree arithmetic lives in `branches.ts`, where it is pure and
 * testable; a component that computed its own siblings would be neither.
 */

/** The icon-button size every message action shares: 28px, 44px under a finger. */
const MESSAGE_ACTION_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text disabled:opacity-40 pointer-coarse:size-11";

export function BranchSwitcher(props: {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const atStart = props.index === 0;
  const atEnd = props.index === props.total - 1;
  return (
    <div
      className="flex items-center text-xs text-mw-text-muted"
      // The count changes without focus moving, so a screen reader is told
      // rather than left on a stale "2 of 3".
      aria-live="polite"
    >
      <button
        type="button"
        onClick={props.onPrevious}
        disabled={atStart}
        aria-label="Previous version"
        className={MESSAGE_ACTION_CLASS}
      >
        <ChevronLeftIcon className="size-4" aria-hidden />
      </button>
      <span className="tabular-nums" aria-label={`Version ${props.index + 1} of ${props.total}`}>
        {props.index + 1} / {props.total}
      </span>
      <button
        type="button"
        onClick={props.onNext}
        disabled={atEnd}
        aria-label="Next version"
        className={MESSAGE_ACTION_CLASS}
      >
        <ChevronRightIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}

const ACTION_ICONS: Partial<Record<string, LucideIcon>> = {
  Edit: PencilIcon,
  Regenerate: RefreshCwIcon,
  Report: FlagIcon,
  "Branch from here": GitBranchIcon,
};

/**
 * One action under a message, as an icon. The word is kept as the button's
 * text for a screen reader (and as its tooltip), so the name is the same
 * one the row has always had.
 */
export function MessageAction(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = ACTION_ICONS[props.label];
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.label}
      className={Icon ? MESSAGE_ACTION_CLASS : `${MESSAGE_ACTION_CLASS} w-auto px-1.5 text-xs`}
    >
      {Icon ? (
        <>
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{props.label}</span>
        </>
      ) : (
        props.label
      )}
    </button>
  );
}

/**
 * The inline editor for a user message.
 *
 * Send sends the edited turn -- it becomes a new message, so the word is the
 * composer's, not "Save". Cancel restores the message untouched. Escape cancels and
 * Cmd/Ctrl+Enter saves, because this is a textarea inside a transcript and a
 * bare Enter has to stay a newline -- the composer's Enter-sends rule would
 * truncate a multi-line question on the first line break.
 */
export function MessageEditor(props: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret at the end, not over the text: the common edit is an addition or
    // a correction at the tail, and a select-all invites losing the lot to
    // the next keystroke.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = () => {
    const text = draft.trim();
    if (text) props.onSave(text);
  };

  return (
    <div className="w-full">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
        aria-label="Edit your message"
        rows={3}
        className="w-full resize-none rounded-xl border border-mw-border bg-mw-surface-raised p-2 text-base outline-none focus-visible:border-mw-focus focus-visible:ring-2 focus-visible:ring-mw-focus md:text-sm"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="h-8 rounded-lg px-3 text-sm hover:bg-mw-surface-hover pointer-coarse:h-11"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={draft.trim() === ""}
          className="h-8 rounded-lg bg-mw-accent px-3 text-sm font-medium text-mw-accent-foreground hover:bg-mw-accent/85 disabled:opacity-40 pointer-coarse:h-11"
        >
          Send
        </button>
      </div>
    </div>
  );
}
