import * as React from "react"
import { cn } from "cn"

/**
 * A labelled form control: label, optional hint, optional error, with the
 * ids wired so a screen reader announces all three on focus.
 *
 *   <Field label="Webhook URL" hint="Must be https." error={urlError}>
 *     <Input value={url} onChange={...} />
 *   </Field>
 *
 * The single child (Input, Textarea, SelectTrigger, or any element that
 * takes `id` and aria props) receives `id`, `aria-describedby` (hint, then
 * error), `aria-invalid` when there is an error, and `aria-required` when
 * `required`. The ui/input and ui/textarea already style `aria-invalid`.
 *
 * For a control that is not a single element, pass a function instead and
 * spread what it is given:
 *
 *   <Field label="Plan">{(control) => <Select ...><SelectTrigger {...control} /></Select>}</Field>
 *
 * The error is a polite live region, so an error that appears after a
 * submit is announced without moving focus.
 */

export interface FieldControlProps {
  id: string
  "aria-describedby"?: string
  "aria-invalid"?: true
  "aria-required"?: true
}

function Field({
  label,
  hint,
  error,
  required,
  id: idProp,
  className,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  /** Falsy hides it; a string or node shows it and marks the control invalid. */
  error?: React.ReactNode
  required?: boolean
  /** The control's id; generated when omitted. */
  id?: string
  className?: string
  children:
    | React.ReactElement<Partial<FieldControlProps>>
    | ((control: FieldControlProps) => React.ReactNode)
}) {
  const generated = React.useId()
  // An element child keeps the id and description it already carries.
  const own = typeof children === "function" ? {} : children.props
  const id = idProp ?? own.id ?? `field-${generated}`
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy =
    [own["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined

  const control: FieldControlProps = {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(required ? { "aria-required": true as const } : {}),
  }

  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} data-slot="field-label" className="text-sm font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-mw-danger">
            *
          </span>
        )}
      </label>
      {typeof children === "function"
        ? children(control)
        : React.cloneElement(children, control)}
      {hint && (
        <p id={hintId} data-slot="field-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <p
        id={errorId}
        data-slot="field-error"
        aria-live="polite"
        className={cn("text-xs text-mw-danger", !error && "sr-only")}
      >
        {error || null}
      </p>
    </div>
  )
}

export { Field }
