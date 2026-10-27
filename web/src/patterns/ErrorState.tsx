import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";

/**
 * Something failed. Announced to assistive tech via role="alert"; one retry
 * action, never more. The chat surface composes this for its error states.
 */
export function ErrorState(props: {
  title?: string;
  message?: ReactNode;
  /** Label for the retry button; omit `onRetry` for non-retryable errors. */
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-mw-danger-subtle text-mw-danger">
        <CircleAlertIcon className="size-5" />
      </span>
      <p className="text-lg font-medium">{props.title ?? "Something went wrong"}</p>
      {props.message && <p className="max-w-md text-sm text-mw-text-muted">{props.message}</p>}
      {props.onRetry && (
        <Button variant="outline" className="mt-2" onClick={props.onRetry}>
          {props.retryLabel ?? "Retry"}
        </Button>
      )}
    </div>
  );
}
