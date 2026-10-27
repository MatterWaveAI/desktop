import { formatMessageTime, formatMessageTimeFull } from "./formatMessageTime";

/**
 * When a stored message was sent, under its bubble.
 *
 * Always in the accessibility tree, rarely on screen: a time on every row
 * is noise a sighted reader scans past, so it is drawn only while the row is
 * hovered or holds focus (its Edit, Regenerate or thumbs), and not at all
 * at phone widths, where there is no hover and no room. Both hidings keep
 * the element readable -- opacity on a desktop, `sr-only` on a phone --
 * because a screen reader is the one reader for whom "when" is always
 * worth a word. The row is found by the `data-message-id` every stored row
 * carries, so this needs nothing from the row but a place.
 */
export function MessageTime(props: {
  /** The message's `created_at`, as the API sent it. */
  at: string;
  /** Overrides the clock; tests pass it, the page does not. */
  now?: Date;
}) {
  const label = formatMessageTime(props.at, props.now);
  if (label === "") return null;
  return (
    <p className="mt-1 text-xs text-mw-text-muted sr-only md:not-sr-only md:opacity-0 md:transition-opacity [[data-message-id]:focus-within_&]:opacity-100 [[data-message-id]:hover_&]:opacity-100">
      <time dateTime={props.at} title={formatMessageTimeFull(props.at)}>
        {label}
      </time>
    </p>
  );
}
