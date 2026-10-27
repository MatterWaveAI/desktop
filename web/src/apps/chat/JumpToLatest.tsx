import { ArrowDownIcon } from "lucide-react";

/**
 * The way back to the bottom for a reader who scrolled up during a long
 * answer. Floats over the transcript's lower edge, from a zero-height
 * sibling placed between the scroller and the composer so the scroller
 * itself -- whose geometry the mobile suite measures -- is left alone.
 *
 * Nothing at all while the reader is within a viewport of the bottom: a
 * button that is always there is furniture, and one that appears is a
 * signal. The dot is the second signal, for content that streamed in below
 * the fold while they were reading; its meaning is spelt out for a screen
 * reader rather than left as a coloured circle.
 */
export function JumpToLatest(props: {
  /** The reader is more than a viewport above the bottom. */
  visible: boolean;
  /** New content arrived below the fold while they were away. */
  unseen: boolean;
  onJump: () => void;
}) {
  if (!props.visible) return null;
  return (
    <div className="relative h-0">
      <button
        type="button"
        onClick={props.onJump}
        data-mw-jump-to-latest={props.unseen ? "unseen" : "seen"}
        className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-xs font-medium shadow-md hover:bg-mw-surface-hover"
      >
        <ArrowDownIcon className="size-3.5" aria-hidden />
        Jump to latest
        {props.unseen && (
          <>
            <span className="size-2 rounded-full bg-mw-accent" aria-hidden />
            <span className="sr-only">, new content below</span>
          </>
        )}
      </button>
    </div>
  );
}
