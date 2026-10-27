import { EyeOffIcon } from "lucide-react";

/**
 * Temporary chat: a conversation that is not kept.
 *
 * The API owns the promise -- such a conversation is in no list, search or
 * library, cannot be shared, pinned, filed or forked, and is hard-deleted a
 * day after its last message. These two pieces are what the person sees of
 * it: the switch on a new chat, before anything is sent, and the notice in
 * the thread from then on.
 */

/** How long the API keeps a temporary conversation past its last message. */
export const TEMPORARY_CHAT_HOURS = 24;

export const TEMPORARY_NOTICE_TEXT =
  `Temporary chat. It won't appear in your history or search, can't be shared, ` +
  `and is deleted ${TEMPORARY_CHAT_HOURS} hours after the last message.`;

/**
 * The "Temporary" switch on the new-chat screen. Only offered before the
 * first send: the flag is fixed when the conversation is created, so a
 * switch on an existing thread would promise something the API refuses.
 */
export function TemporaryToggle(props: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      data-mw-temporary-toggle=""
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
      title={
        props.on
          ? "This chat will not be saved. Click to keep it instead."
          : "Start a chat that is not saved to your history"
      }
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-60 ${
        props.on
          ? "border-mw-accent bg-mw-surface-raised text-mw-link"
          : "border-mw-border text-mw-text-muted hover:bg-mw-surface-hover"
      }`}
    >
      <EyeOffIcon className="size-3.5" aria-hidden />
      Temporary
    </button>
  );
}

/** The line at the top of a temporary thread saying it will not be saved. */
export function TemporaryNotice() {
  return (
    <div
      role="note"
      data-mw-temporary-notice=""
      className="mx-auto mt-3 flex w-full max-w-3xl items-start gap-2 px-4 text-xs text-mw-text-muted"
    >
      <EyeOffIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p>{TEMPORARY_NOTICE_TEXT}</p>
    </div>
  );
}
