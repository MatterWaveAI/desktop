import { useId, useState, type FormEvent } from "react";
import { useLocation } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { ApiError, apiFetch } from "../lib/api";
import { startLogin } from "../lib/auth";
import { Alert, AuthPage, DonePanel, ErrorSummary, Field, SubmitButton } from "./AuthForm";
import {
  LINK_CLASS,
  SECONDARY_BUTTON_CLASS,
  ensureAuthConfig,
  failureMessage,
  hasErrors,
  queryParam,
  validateCode,
  validateConfirm,
  validateEmail,
  passwordRule,
  validateNewPassword,
} from "./authForms";
import { FORGOT_PATH } from "./frontDoor";

/**
 * Choose a new password with the emailed code. The address
 * is prefilled from `?email=` (the forgot page links here with it) and stays
 * editable for the same reason as on /verify. A wrong or expired code is a
 * 400 whose detail is the message; it goes on the code field, and the way
 * out of expired is the forgot page again.
 */

type ResetState =
  | { phase: "form" }
  | { phase: "submitting" }
  | { phase: "done" }
  | { phase: "error"; message: string };

interface FieldErrors {
  email?: string;
  code?: string;
  password?: string;
  password_confirm?: string;
}

export function ResetPage() {
  const { t } = useLingui();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const [state, setState] = useState<ResetState>({ phase: "form" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const id = useId();
  const submitting = state.phase === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read before the first await: the form may be gone by the time it resolves.
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const code = String(data.get("code") ?? "").trim();
    // Not trimmed: a password is whatever was typed.
    const password = String(data.get("password") ?? "");
    const passwordConfirm = String(data.get("password_confirm") ?? "");
    const errors: FieldErrors = {
      email: validateEmail(email),
      code: validateCode(code),
      password: validateNewPassword(password),
      password_confirm: validateConfirm(password, passwordConfirm),
    };
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      await ensureAuthConfig();
      await apiFetch("/api/auth/reset", {
        method: "POST",
        json: { email, code, password, password_confirm: passwordConfirm },
      });
      setState({ phase: "done" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setFieldErrors({ code: err.message });
        setState({ phase: "form" });
        return;
      }
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
      title={t`Choose a new password`}
      intro={t`Enter the code from the email and the password you want to use.`}
    >
      {/* Always mounted, so what lands in it is announced rather than merely appearing. */}
      <div aria-live="polite">
        {state.phase === "done" && (
          <DonePanel id={id} title={t`Your password is changed`}>
            <p className="text-sm text-mw-text-muted">
              <Trans>Sign in with your new password.</Trans>
            </p>
            <div>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void signIn()}>
                <Trans>Sign in</Trans>
              </button>
            </div>
          </DonePanel>
        )}
      </div>

      {state.phase !== "done" && (
        <form
          noValidate
          aria-busy={submitting}
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4"
        >
          <ErrorSummary
            errors={[
              fieldErrors.email,
              fieldErrors.code,
              fieldErrors.password,
              fieldErrors.password_confirm,
            ]}
          />

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
            defaultValue={queryParam(searchStr, "email") ?? ""}
            error={fieldErrors.email}
          />
          <Field
            id={`${id}-code`}
            name="code"
            label={t`Reset code`}
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            maxLength={6}
            required
            error={fieldErrors.code}
          />
          <Field
            id={`${id}-password`}
            name="password"
            label={t`New password`}
            type="password"
            autoComplete="new-password"
            required
            hint={passwordRule()}
            error={fieldErrors.password}
          />
          <Field
            id={`${id}-password_confirm`}
            name="password_confirm"
            label={t`Confirm new password`}
            type="password"
            autoComplete="new-password"
            required
            error={fieldErrors.password_confirm}
          />

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton busy={submitting} busyLabel={t`Saving…`}>
              <Trans>Set password</Trans>
            </SubmitButton>
            <a href={FORGOT_PATH} className={LINK_CLASS}>
              <Trans>Send a new code</Trans>

            </a>
          </div>
        </form>
      )}
    </AuthPage>
  );
}
