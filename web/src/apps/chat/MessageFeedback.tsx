import { useId, useState } from "react";
import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { ApiError } from "../../lib/api";
import {
  deleteFeedback,
  FEEDBACK_COMMENT_MAX_LEN,
  FEEDBACK_REASONS,
  putFeedback,
  type Feedback,
  type FeedbackReason,
  type Rating,
} from "./feedback";

/**
 * Thumbs under a stored reply, with an optional "why" for either thumb.
 *
 * A click is the whole rating: the PUT goes out at once so a person who
 * never opens the details still counts. The details (reason chips and a
 * comment) are on the shared popover, placed against the viewport like the
 * conversation menu, so they never open off a phone screen. Clicking the
 * lit thumb again withdraws the rating.
 *
 * The parent owns the map of ratings (it survives the tree refetch after
 * a turn); this component reports every change up and renders what it is
 * given, so a reload shows the same thumbs the person left.
 */
export function MessageFeedback(props: {
  messageId: string;
  current: Feedback | null;
  onChange: (next: Feedback | null) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<readonly FeedbackReason[]>(props.current?.reasons ?? []);
  const [comment, setComment] = useState(props.current?.comment ?? "");
  const baseId = useId();
  const rating = props.current?.rating ?? null;

  async function save(next: Rating, withDetails: boolean) {
    setBusy(true);
    setError(null);
    try {
      const saved = await putFeedback(props.messageId, {
        rating: next,
        reasons: withDetails ? reasons : [],
        comment: withDetails ? comment : null,
      });
      props.onChange(saved);
      if (!withDetails) {
        setReasons([]);
        setComment("");
      }
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await deleteFeedback(props.messageId);
      props.onChange(null);
      setReasons([]);
      setComment("");
      setDetailsOpen(false);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function thumb(next: Rating) {
    if (rating === next) {
      void withdraw();
      return;
    }
    // A thumbs-down opens the "why" straight away: that is the moment a
    // person has something to say. A thumbs-up is a click and done, with
    // the details a second click away.
    setDetailsOpen(next === -1);
    void save(next, false);
  }

  const toggleReason = (id: FeedbackReason) =>
    setReasons((current) =>
      current.includes(id) ? current.filter((r) => r !== id) : [...current, id],
    );

  const over = comment.length > FEEDBACK_COMMENT_MAX_LEN;
  const thumbClass = (lit: boolean) =>
    `inline-flex size-7 items-center justify-center rounded-md pointer-coarse:size-11 ${lit ? "bg-mw-surface-hover text-mw-text" : "text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"} disabled:opacity-40`;

  return (
    <div className="flex items-center gap-0.5" data-mw-feedback={rating ?? "none"}>
      <button
        type="button"
        aria-label="Good reply"
        aria-pressed={rating === 1}
        disabled={busy}
        onClick={() => thumb(1)}
        className={thumbClass(rating === 1)}
      >
        <ThumbsUpIcon className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Bad reply"
        aria-pressed={rating === -1}
        disabled={busy}
        onClick={() => thumb(-1)}
        className={thumbClass(rating === -1)}
      >
        <ThumbsDownIcon className="size-4" aria-hidden />
      </button>
      {rating !== null && (
        /* The "why" on the shared popover: placed against the viewport, so
           a reply at the foot of a phone screen opens it upward instead of
           under the composer. */
        <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
          <PopoverTrigger className="h-7 rounded-md px-1.5 text-xs text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text pointer-coarse:h-11">
            {props.current?.reasons.length || props.current?.comment ? "Edit why" : "Say why"}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 gap-0 rounded-lg border border-mw-border bg-mw-surface-raised p-3 text-mw-text shadow-lg ring-0"
          >
            <div id={`${baseId}-details`} role="group" aria-label="Why">
              <p className="mb-2 text-xs text-mw-text-muted">
                Optional. Feedback is stored with the reply and is not shown to the model.
              </p>
              <div className="flex flex-wrap gap-1">
                {FEEDBACK_REASONS.map((reason) => {
                  const on = reasons.includes(reason.id);
                  return (
                    <button
                      key={reason.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleReason(reason.id)}
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        on
                          ? "border-mw-accent bg-mw-accent text-mw-accent-foreground"
                          : "border-mw-border text-mw-text-muted hover:text-mw-text"
                      }`}
                    >
                      {reason.label}
                    </button>
                  );
                })}
              </div>
              <label htmlFor={`${baseId}-comment`} className="mt-2 block text-xs font-medium">
                Comment
              </label>
              <textarea
                id={`${baseId}-comment`}
                rows={2}
                value={comment}
                aria-invalid={over || undefined}
                onChange={(event) => setComment(event.target.value)}
                placeholder="What you expected instead."
                className="mt-1 w-full rounded-lg border border-mw-border bg-mw-surface p-2 text-sm outline-none focus-visible:border-mw-focus aria-invalid:border-mw-danger"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className={`text-xs ${over ? "text-mw-danger" : "text-mw-text-muted"}`}>
                  {comment.length} / {FEEDBACK_COMMENT_MAX_LEN}
                </span>
                <button
                  type="button"
                  disabled={busy || over}
                  onClick={() => {
                    void save(rating, true).then(() => setDetailsOpen(false));
                  }}
                  className="rounded-md bg-mw-accent px-2.5 py-1 text-xs font-medium text-mw-accent-foreground hover:bg-mw-accent/85 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}
      {error && (
        <span role="alert" className="text-xs text-mw-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function failureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return "This reply could not be found.";
  return "Could not save your feedback.";
}
