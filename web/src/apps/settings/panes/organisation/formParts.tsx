/**
 * The small pieces every form on the Organisation pane shares, so a field
 * error, a form-level summary and a "Saved." line look and announce the
 * same way in every card.
 */

/** A field's own message, linked to it by id through aria-describedby. */
export function FieldError(props: { id: string; message: string | undefined }) {
  if (!props.message) return null;
  return (
    <p id={props.id} role="alert" className="text-sm text-mw-danger">
      {props.message}
    </p>
  );
}

/** What a failed submit said that belongs to no one field. */
export function FormSummary(props: { name: string; messages: readonly string[] }) {
  if (props.messages.length === 0) return null;
  return (
    <div role="alert" data-form-summary={props.name} className="text-sm text-mw-danger">
      {props.messages.length === 1 ? (
        <p>{props.messages[0]}</p>
      ) : (
        <ul className="list-disc pl-5">
          {props.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The polite line that says a change stuck. Always in the document, so a
 * screen reader is already listening when the text arrives.
 */
export function SavedStatus(props: { shown: boolean; text?: string; className?: string; marker?: string }) {
  return (
    <p role="status" aria-live="polite" data-saved={props.marker} className={`text-sm text-mw-text-muted ${props.className ?? ""}`}>
      {props.shown ? (props.text ?? "Saved.") : ""}
    </p>
  );
}

/** A switch: a button, so it is announced as on or off rather than checked. */
export function Switch(props: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-busy={props.busy || undefined}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-mw-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-mw-focus focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
        props.checked ? "border-mw-accent bg-mw-accent" : "bg-mw-surface-hover"
      }`}
    >
      <span
        aria-hidden="true"
        className={`block size-4 rounded-full bg-mw-surface-raised shadow-sm transition-transform ${
          props.checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
