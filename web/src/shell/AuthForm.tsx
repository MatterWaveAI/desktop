import { useContext, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { Field as UiField } from "../components/ui/field";
import { FIELD_CLASS, PRIMARY_BUTTON_CLASS, focusOnMount } from "./authForms";
import { CircleAlertIcon } from "lucide-react";
import { getAuthConfig } from "../lib/auth";
import { FrontDoorFrame } from "./FrontDoorChrome";
import { ShellContext } from "./shellContext";

/**
 * The front-door forms' building blocks. Five pages ask for
 * an email, a password or a code and show what the API said; these keep the
 * labels, the invalid marking, the focused summary and the busy state the
 * same on each, so a screen reader hears the same page five times over.
 */

/**
 * The page frame: the front door's header and footer, the heading and one
 * line of intro, then the form on a panel. `brand={false}` inside the shell,
 * whose header already carries the name: then only the heading and the form
 * render. The header leaves out Sign in and Create account, since the form
 * on the page is the way in.
 */
export function AuthPage(props: { title: string; intro?: ReactNode; brand?: boolean; children: ReactNode }) {
  const shell = useContext(ShellContext);
  const chrome = props.brand !== false && shell === null;
  return (
    <FrontDoorFrame config={getAuthConfig()} chrome={chrome} actions={false}>
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-10 sm:py-16">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-display-md sm:text-display-lg">{props.title}</h1>
          {props.intro && <p className="text-sm text-mw-text-subtle">{props.intro}</p>}
        </div>
        <div
          data-slot="auth-panel"
          className="flex flex-col gap-6 rounded-2xl border border-mw-border bg-mw-surface-raised p-5 sm:p-7"
        >
          {props.children}
        </div>
      </div>
    </FrontDoorFrame>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> {
  id: string;
  name: string;
  label: ReactNode;
  /** A rule shown under the field before anything goes wrong, e.g. the password length. */
  hint?: ReactNode;
  error?: string;
}

/**
 * A labelled input on the design system's Field: the hint and the error are
 * both described-by so the rule is read out with the field, not only after
 * it was broken. `required` stays a native attribute on the input rather
 * than the Field's asterisk: the front-door forms say what is optional
 * instead.
 */
export function Field({ id, label, hint, error, ...input }: FieldProps) {
  return (
    <UiField id={id} label={label} hint={hint} error={error}>
      <input className={FIELD_CLASS} {...input} />
    </UiField>
  );
}

/**
 * A password with a Show/Hide switch. The switch is a button, not a link,
 * announces its state, and never submits the form; it is 24px tall and as
 * tall as the field on a coarse pointer. What is typed is shown only on
 * this screen and only while the person asks: nothing about the field's
 * value changes, so autofill and the form's reading of it are untouched.
 * `after` renders under the input, inside the field's description -- the
 * signup page's strength meter.
 */
export function PasswordField({
  id,
  label,
  hint,
  error,
  after,
  ...input
}: Omit<FieldProps, "type"> & { after?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <UiField id={id} label={label} hint={hint} error={error}>
      {(control) => (
        <>
          <div className="relative">
            <input className={`${FIELD_CLASS} pr-16`} type={shown ? "text" : "password"} {...control} {...input} />
            <button
              type="button"
              aria-pressed={shown}
              aria-controls={control.id}
              onClick={() => setShown((value) => !value)}
              className="absolute inset-y-0 right-0 inline-flex min-h-6 items-center rounded-r-lg px-3 text-xs font-medium text-mw-text-secondary hover:text-mw-text"
            >
              {shown ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
            </button>
          </div>
          {after}
        </>
      )}
    </UiField>
  );
}

/**
 * Something that must be read now: announced as an alert and, unless told
 * otherwise, focused on mount so a keyboard user is not left in the field.
 * `focus={false}` for a page whose whole content is the alert -- an invite
 * that cannot be used -- where moving focus into it on load only draws a
 * focus ring round text the person is already reading.
 */
export function Alert(props: { children: ReactNode; focus?: boolean }) {
  const focus = props.focus !== false;
  return (
    <div
      role="alert"
      tabIndex={focus ? -1 : undefined}
      ref={focus ? focusOnMount : undefined}
      className="flex items-start gap-3 rounded-xl border border-mw-danger-border bg-mw-danger-subtle px-4 py-3 text-sm text-mw-text"
    >
      <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-mw-danger" />
      <div className="flex min-w-0 flex-col gap-2">{props.children}</div>
    </div>
  );
}

/** The validation summary above a form; renders nothing when there is nothing to say. */
export function ErrorSummary(props: { errors: (string | undefined)[] }) {
  const errors = props.errors.filter((message): message is string => message !== undefined);
  if (errors.length === 0) return null;
  return (
    <Alert>
      <div>
        <p className="font-semibold text-mw-danger">
          <Trans>Check the form</Trans>
        </p>
        <ul className="mt-1 list-disc pl-5">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    </Alert>
  );
}

/** The form's primary action; disabled and relabelled while the request is in flight. */
export function SubmitButton(props: { busy: boolean; busyLabel: string; children: ReactNode }) {
  return (
    <button type="submit" disabled={props.busy} className={PRIMARY_BUTTON_CLASS}>
      {props.busy ? props.busyLabel : props.children}
    </button>
  );
}

/**
 * A done state that replaces the form: focused so the announcement is not
 * missed, and the way onward inside it. Wrapped in a live region by the page
 * so what lands in it is read rather than merely appearing.
 */
export function DonePanel(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      tabIndex={-1}
      ref={focusOnMount}
      aria-labelledby={`${props.id}-title`}
      className="flex flex-col gap-3 rounded-xl border border-mw-positive-border bg-mw-positive-subtle p-5 outline-none"
    >
      <h2 id={`${props.id}-title`} className="font-display text-display-sm text-mw-positive">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}
