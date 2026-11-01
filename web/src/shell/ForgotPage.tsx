import { useId, useState, type FormEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { apiFetch } from "../lib/api";
import { Alert, AuthPage, DonePanel, ErrorSummary, Field, SubmitButton } from "./AuthForm";
import {
  LINK_CLASS,
  SECONDARY_BUTTON_CLASS,
  ensureAuthConfig,
  failureMessage,
  validateEmail,
  withEmail,
} from "./authForms";
import { LOGIN_PATH, RESET_PATH } from "./frontDoor";

/**
 * Forgot password. The API answers 202 whether or not the
 * address has an account - saying otherwise would tell a stranger who is
 * registered - so the done state is worded to match and the way onward is
 * the reset page with the address filled in.
 */

type ForgotState =
  | { phase: "form" }
  | { phase: "submitting" }
  | { phase: "sent"; email: string }
  | { phase: "error"; message: string };

export function ForgotPage() {
  const { t } = useLingui();
  const [state, setState] = useState<ForgotState>({ phase: "form" });
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const id = useId();
  const submitting = state.phase === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read before the first await: the form may be gone by the time it resolves.
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    const error = validateEmail(email);
    setEmailError(error);
    if (error) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      await ensureAuthConfig();
      await apiFetch("/api/auth/forgot", { method: "POST", json: { email } });
      setState({ phase: "sent", email });
    } catch (err) {
      setState({ phase: "error", message: failureMessage(err) });
    }
  }

  return (
    <AuthPage
      title={t`Reset your password`}
      intro={t`Enter your email and we will send you a code to choose a new password.`}
    >
      {/* Always mounted, so what lands in it is announced rather than merely appearing. */}
      <div aria-live="polite">
        {state.phase === "sent" && (
          <DonePanel id={id} title={t`Check your email`}>
            <p className="text-sm text-mw-text-muted">
              <Trans>If an account exists for that address, a code is on its way.</Trans>
            </p>
            <div>
              <a href={withEmail(RESET_PATH, state.email)} className={SECONDARY_BUTTON_CLASS}>
                <Trans>Enter the code</Trans>
              </a>
            </div>
          </DonePanel>
        )}
      </div>

      {state.phase !== "sent" && (
        <form
          noValidate
          aria-busy={submitting}
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4"
        >
          <ErrorSummary errors={[emailError]} />

          {state.phase === "error" && (
            <Alert>
              <p>{state.message}</p>
              <div>
                <button type="submit" className={SECONDARY_BUTTON_CLASS}>
                  <Trans>Retry</Trans>
                </button>
              </div>
            </Alert>
          )}

          <Field
            id={`${id}-email`}
            name="email"
            label={t`Email`}
            type="email"
            autoComplete="email"
            required
            error={emailError}
          />

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton busy={submitting} busyLabel={t`Sending…`}>
              <Trans>Send code</Trans>
            </SubmitButton>
            <a href={LOGIN_PATH} className={LINK_CLASS}>
              <Trans>Back to sign in</Trans>

            </a>
          </div>
        </form>
      )}
    </AuthPage>
  );
}
