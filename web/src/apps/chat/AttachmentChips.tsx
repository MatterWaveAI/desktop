/**
 * The composer's attachment chips.
 *
 * One chip per pending attachment, with a thumbnail for an image, a progress
 * bar while it uploads, "scanning" while the server's malware scan decides,
 * the reason and a Retry when it fails, the reason alone when the scan
 * removed it, and a remove control in every state. The chips sit between the
 * transcript and the textarea so the user can see what is attached without
 * the list pushing the typing area off a phone screen.
 */

import type { PendingAttachment } from "./attachments";
import { humanSize, isImageType } from "./attachments";

export function AttachmentChips(props: {
  pending: readonly PendingAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (props.pending.length === 0) return null;
  return (
    /* `aria-live` so a screen reader hears an upload finish or fail without
       the user having to go looking for the chip. "polite", not "assertive":
       an attachment landing should not interrupt whatever is being read. */
    <ul
      data-mw-attachments=""
      aria-live="polite"
      aria-label="Attachments on this message"
      className="mx-auto flex w-full max-w-3xl list-none flex-wrap gap-2 px-1 pb-2"
    >
      {props.pending.map((entry) => (
        <li key={entry.key}>
          <Chip entry={entry} onRemove={props.onRemove} onRetry={props.onRetry} />
        </li>
      ))}
    </ul>
  );
}

function Chip(props: {
  entry: PendingAttachment;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const { entry } = props;
  const failed = entry.status === "failed";
  // The scanner removed it: the same red as a failure, without the Retry.
  const blocked = entry.status === "blocked";
  const uploaded = entry.status === "ready" || entry.status === "scanning";
  const name = uploaded ? entry.attachment.filename : entry.filename;
  const size = uploaded ? entry.attachment.size_bytes : entry.size_bytes;

  return (
    <div
      data-mw-attachment-chip={entry.status}
      data-mw-attachment-name={name}
      /* `max-w-64` is 16rem on the default scale: wide enough for a readable
         filename, narrow enough that two chips fit on one row at 375px. */
      className={`flex max-w-64 items-center gap-2 rounded-lg border px-2 py-1.5 text-left ${
        failed || blocked
          ? "border-mw-danger bg-mw-danger-subtle"
          : "border-mw-border bg-mw-surface-raised"
      }`}
    >
      <Thumbnail entry={entry} />
      <div className="min-w-0 flex-1">
        {/* `break-all` on the name: an attachment called
            `Screenshot 2026-09-30 at 14.03.11.png` has no break opportunity a
            normal wrap would take, and at 320px it would push the remove
            button off the chip. */}
        <p className="truncate text-xs font-medium text-mw-text" title={name}>
          {name}
        </p>
        {entry.status === "uploading" ? (
          <Progress percent={entry.progress} />
        ) : entry.status === "scanning" ? (
          /* Indeterminate on purpose: a scan has no percentage, and a bar that
             cannot move reads as stuck. The words are the status. */
          <p className="text-xs text-mw-text-muted" data-mw-scan-status="scanning">
            {humanSize(size)} · scanning for malware…
          </p>
        ) : failed || blocked ? (
          <p className="text-xs text-mw-danger-strong">{entry.reason}</p>
        ) : (
          <p className="text-xs text-mw-text-muted">
            {humanSize(size)}
            {entry.status === "ready" && entry.attachment.extract_truncated
              ? " · only part will be read"
              : ""}
          </p>
        )}
      </div>
      {failed && (
        <button
          type="button"
          onClick={() => props.onRetry(entry.key)}
          /* The accessible name names the file, like the remove control's
             does: "Retry" alone is ambiguous once two chips have failed, and
             a screen-reader user hearing "Retry, button" twice has no way to
             tell which upload they are retrying. */
          aria-label={`Retry ${name}`}
          /* 44px minimum on a touch target. A 16px × icon is
             the right size to look at and the wrong size to hit. */
          className="min-h-11 min-w-11 shrink-0 rounded px-1 text-xs font-medium text-mw-danger-strong underline hover:bg-mw-surface-hover"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={() => props.onRemove(entry.key)}
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
      >
        <span aria-hidden="true" className="text-base leading-none">
          ×
        </span>
      </button>
    </div>
  );
}

/**
 * The image preview, or a letter-coded square for a document.
 *
 * The preview comes from an object URL made from the local `File`, not from
 * the server: it is available the instant the file is picked, it costs no
 * round trip, and it is the only thing that can show a thumbnail *while* the
 * upload is still running — which is when the user most wants to confirm they
 * picked the right screenshot.
 */
function Thumbnail(props: { entry: PendingAttachment }) {
  const { entry } = props;
  const type =
    entry.status === "ready" || entry.status === "scanning"
      ? entry.attachment.content_type
      : entry.local_type;
  if (entry.preview !== undefined && isImageType(type)) {
    return (
      <img
        src={entry.preview}
        alt=""
        className="h-10 w-10 shrink-0 rounded border border-mw-border object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-mw-border text-xs font-semibold uppercase text-mw-text-muted"
    >
      {labelFor(type)}
    </span>
  );
}

function labelFor(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === "text/markdown") return "MD";
  if (contentType.startsWith("text/")) return "TXT";
  if (contentType.startsWith("image/")) return "IMG";
  return "FILE";
}

/**
 * The upload bar.
 *
 * A real determinate bar, not a spinner, because the requirement is that "a
 * 5 MB image over a slow link must not look frozen" — and a spinner at second
 * twenty says exactly as much as a spinner at second one. The percentage is
 * also in text: a 4px bar moving from 38% to 41% is not a visible change, and
 * the number is what a user watches to decide whether to wait.
 */
function Progress(props: { percent: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        role="progressbar"
        aria-valuenow={props.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Upload progress"
        data-mw-upload-progress={props.percent}
        className="h-1 flex-1 overflow-hidden rounded-full bg-mw-surface-hover"
      >
        <div
          className="h-full rounded-full bg-mw-accent transition-[width] duration-150"
          style={{ width: `${props.percent}%` }}
        />
      </div>
      {/* `tabular-nums` so the bar does not jitter sideways as the number
          goes from 9% to 10% to 100%. */}
      <span className="shrink-0 text-xs tabular-nums text-mw-text-muted">{props.percent}%</span>
    </div>
  );
}
