import { useId, useRef, useState, type FormEvent } from "react";
import { useLocation } from "@tanstack/react-router";
import { ApiError, apiFetch } from "../lib/api";
import { startLogin } from "../lib/auth";
import { Alert, AuthPage, DonePanel, ErrorSummary, Field, SubmitButton } from "./AuthForm";
import {
  SECONDARY_BUTTON_CLASS,
  ensureAuthConfig,
  failureMessage,
  hasErrors,
  queryParam,
  validateCode,
  validateEmail,
} from "./authForms";

/**
 * Email verification: the six-character code from the signup
 * email goes in here and the account becomes `active`. The address is
 * prefilled from `?email=` (signup navigates here with it) but stays
 * editable, since the code may be entered on another device from the link
 * in the email, or after a typo at signup.
 *
 * A wrong or expired code is a 400 whose detail is the message; it is shown
 * on the code field, and "Resend code" is the way out of expired.
 */

type VerifyState =
  | { phase: "form" }
  | { phase: "submitting" }
  | { phase: "verified" }
  | { phase: "error"; message: string };

type ResendState = { phase: "idle" } | { phase: "sending" } | { phase: "sent" };

interface FieldErrors {
  email?: string;
  code?: string;
}

export function VerifyPage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  /** `mail=0` from signup: the account exists, the mail did not go out. */
  const mailFailed = queryParam(searchStr, "mail") === "0";
  const [state, setState] = useState<VerifyState>({ phase: "form" });
  const [resend, setResend] = useState<ResendState>({ phase: "idle" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const busy = state.phase === "submitting" || resend.phase === "sending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read before the first await: the form may be gone by the time it resolves.
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const code = String(data.get("code") ?? "").trim();
    const errors: FieldErrors = { email: validateEmail(email), code: validateCode(code) };
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      await ensureAuthConfig();
      await apiFetch<{ status: "active" }>("/api/signup/verify", {
        method: "POST",
        json: { email, code },
      });
      setState({ phase: "verified" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        // The code is what was wrong; say so on the field and in the summary.
        setFieldErrors({ code: err.message });
        setState({ phase: "form" });
        return;
      }
      setState({ phase: "error", message: failureMessage(err) });
    }
  }

  async function resendCode() {
    const data = new FormData(formRef.current ?? undefined);
    const email = String(data.get("email") ?? "").trim();
    const emailError = validateEmail(email);
    if (emailError) {
      setFieldErrors({ email: emailError });
      return;
    }
    setResend({ phase: "sending" });
    try {
      await ensureAuthConfig();
      const result = await apiFetch<{ status: "sent" | "already_verified" }>(
        "/api/signup/resend",
        { method: "POST", json: { email } },
      );
      if (result.status === "already_verified") {
        // There was nothing to send: the address was already confirmed, and
        // the API has just reconciled its own record. Showing "check your
        // email" here would promise a mail that is never coming and leave
        // the person waiting on this page forever.
        setResend({ phase: "idle" });
        setState({ phase: "verified" });
        return;
      }
      setResend({ phase: "sent" });
    } catch (err) {
      setResend({ phase: "idle" });
      setState({ phase: "error", message: failureMessage(err) });
    }
  }

  async function signIn() {
    try {
      startLogin(await ensureAuthConfig());
    } catch (err) {
      setState({ phase: "error", message: failureMessage(err) });
    }
  }

  return (
    <AuthPage
      title="Verify your email"
      intro="Enter the six-character code from the email we sent you."
    >
      {/* Always mounted, so what lands in it is announced rather than merely appearing. */}
      <div aria-live="polite">
        {state.phase === "verified" && (
          <DonePanel id={id} title="Your email is verified">
            <p className="text-sm text-mw-text-muted">Your account is ready. Sign in to start.</p>
            <div>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void signIn()}>
                Sign in
              </button>
            </div>
          </DonePanel>
        )}
        {state.phase !== "verified" && resend.phase === "sent" && (
          <p className="text-sm text-mw-text-muted">Sent. Check your email for a new code.</p>
        )}
        {/*
          Signup succeeded but the API could not queue the mail (`mail=0`,
          set by SignupPage from the response's `mail_sent`). Saying nothing
          here is the worst option: the account exists, the page asks for a
          code, and the person watches an inbox that will never fill. Cleared
          as soon as a resend is pressed, which is the way out.
        */}
        {state.phase !== "verified" && resend.phase === "idle" && mailFailed && (
          <Alert>
            <p>
              Your account was created, but we could not send the code just now. Use
              <strong> Resend code</strong> below to try again.
            </p>
          </Alert>
        )}
      </div>

      {state.phase !== "verified" && (
        <form
          ref={formRef}
          noValidate
          aria-busy={busy}
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4"
        >
          <ErrorSummary errors={[fieldErrors.email, fieldErrors.code]} />

          {state.phase === "error" && (
            <Alert>
              <p>{state.message}</p>
            </Alert>
          )}

          <Field
            id={`${id}-email`}
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            defaultValue={queryParam(searchStr, "email") ?? ""}
            error={fieldErrors.email}
          />
          <Field
            id={`${id}-code`}
            name="code"
            label="Verification code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            maxLength={6}
            required
            error={fieldErrors.code}
          />

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton busy={state.phase === "submitting"} busyLabel="Verifying…">
              Verify
            </SubmitButton>
            <button
              type="button"
              disabled={busy}
              className="text-sm text-mw-text-muted hover:text-mw-text disabled:opacity-40"
              onClick={() => void resendCode()}
            >
              {resend.phase === "sending" ? "Sending…" : "Resend code"}
            </button>
          </div>
        </form>
      )}
    </AuthPage>
  );
}
