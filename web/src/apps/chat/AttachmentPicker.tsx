/**
 * The three ways a file gets into the composer.
 *
 * A button, a drop target and a paste handler. The paste handler is the one
 * that matters most in practice and it is the only one with nowhere else to
 * live: a screenshot taken with Win+Shift+S or Cmd+Ctrl+Shift+4 exists only
 * on the clipboard, so without paste the user has to save it to disk first,
 * find it in a picker, and attach it — three steps for the single most common
 * thing anyone attaches to a chat message.
 *
 * The button is a `<label>` wrapping a visually-hidden `<input type="file">`
 * rather than a `<button>` that calls `input.click()`. Both work on a
 * desktop; only the label works reliably on iOS Safari, where a programmatic
 * `.click()` on a file input from inside an async callback is swallowed as a
 * non-user-gesture. The label's native activation has no such rule, and it is
 * also what makes the control keyboard-reachable and screen-reader-labelled
 * with no ARIA at all.
 */

import { useId, useRef } from "react";
import { ACCEPT_ATTRIBUTE } from "./attachments";

export function AttachmentPicker(props: {
  onFiles: (files: readonly File[]) => void;
  disabled: boolean;
  /** What the control says it will refuse, for the tooltip. */
  hint: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        disabled={props.disabled}
        data-mw-attachment-input=""
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) props.onFiles(files);
          // Reset, so picking the SAME file twice in a row fires `change`
          // twice. Without this, a user who attaches a screenshot, removes it
          // and picks it again gets nothing: the input's value never changed,
          // so the browser emits no event and the app looks broken for the
          // one gesture most likely to be repeated.
          event.target.value = "";
        }}
        /* `sr-only` rather than `display: none` or `hidden`: a hidden input is
           not focusable, so the control would be unreachable by keyboard and
           invisible to a screen reader. This keeps it in the a11y tree and
           out of the layout. */
        className="sr-only"
      />
      <label
        htmlFor={inputId}
        title={props.hint}
        data-mw-attach-button=""
        /* 44x44 and `cursor-pointer`: a label is not a button
           to the browser, so neither the pointer nor the hit area comes for
           free. `aria-disabled` is on the label because a label has no
           disabled state of its own — the input's `disabled` is what actually
           blocks it, and this is what announces that. */
        aria-disabled={props.disabled}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-mw-text-muted ${
          props.disabled
            ? "cursor-not-allowed opacity-40"
            : "cursor-pointer hover:bg-mw-surface-hover hover:text-mw-text"
        }`}
      >
        <span className="sr-only">Attach a file</span>
        <PaperclipIcon />
      </label>
    </>
  );
}

/**
 * Inline, not from `lucide-react`.
 *
 * The package is a dependency and its `Paperclip` would do, but every icon
 * imported from it is a module in the chat bundle, and this is one 24x24 path
 * on the app's most-loaded route. `aria-hidden` because the label beside it
 * already carries the name.
 */
function PaperclipIcon() {
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
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/**
 * The drop overlay, shown only while a drag carrying files is over the
 * composer.
 *
 * `pointer-events-none` is load-bearing: an overlay that accepts pointer
 * events becomes the drag target itself, which fires `dragleave` on the
 * element underneath and makes the overlay flicker on and off continuously as
 * the cursor moves. It draws, it does not participate.
 */
export function DropOverlay(props: { active: boolean }) {
  if (!props.active) return null;
  return (
    <div
      data-mw-drop-overlay=""
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-mw-accent bg-mw-surface-raised/90 text-sm font-medium text-mw-text"
    >
      Drop files to attach
    </div>
  );
}
