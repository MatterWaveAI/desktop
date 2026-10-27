import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../lib/api";
import { completeLogin } from "../lib/auth";
import { Alert, AuthPage, ErrorSummary, Field, SubmitButton } from "./AuthForm";
import { LOGIN_PATH } from "./frontDoor";
import { LINK_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, failureMessage } from "./authForms";
import {
  RECOVERY_FILENAME,
  normalizeTotpCode,
  validateRecoveryCode,
  validateTotpCode,
  type MfaMode,
  type TotpEnrolment,
} from "./mfaForms";

/**
 * The second step of a sign-in, and the authenticator wizard it shares
 * with the Account pane.
 *
 * `POST /api/auth/password` answers a sealed `challenge` instead of the
 * redirect when the account has an authenticator (`mfa_required`) or the
 * org insists on one the account lacks (`mfa_enrolment_required`). The
 * LoginPage renders this in place of its form -- the `?authRequest=` in
 * the URL still names the sign-in being finished -- and the browser leaves
 * through the same `completeLogin` the password step would have used.
 *
 * The enrolment path is the org-policy interstitial: it tells the person
 * why they cannot go further, lets them set the authenticator up right
 * here with the challenge as the credential, hands them the recovery
 * codes once, and then asks for one more code to finish the sign-in. The
 * API refuses to finalize with the code that confirmed the registration
 * (Zitadel treats a code reused inside its time step as spent), so the
 * extra step is the honest end of the wizard rather than a formality.
 */

interface MfaLoginResponse {
  redirect: string;
  recovery_codes_left?: number;
}

interface EnrolConfirmResponse {
  recovery_codes: string[];
  challenge: string;
}

/**
 * The one showing of the recovery codes. Only hashes exist after the
 * response that carried these, so the panel says so and offers the two
 * ways people actually keep them: the clipboard and a text file.
 */
export function RecoveryCodes(props: { codes: string[]; email?: string }) {
  const [copied, setCopied] = useState(false);
  const text = props.codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (an insecure origin, a permission refused): the codes
      // are on screen and the download still works, so nothing is lost.
      setCopied(false);
    }
  }

  function download() {
    const header = props.email
      ? `MatterWave recovery codes for ${props.email}\nEach code works once.\n\n`
      : "MatterWave recovery codes\nEach code works once.\n\n";
    const blob = new Blob([header + text + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = RECOVERY_FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="recovery-codes">
      <p className="text-sm">
        <span className="font-medium">Save these recovery codes.</span> Each one signs you in
        once if you lose your authenticator. They are shown only now.
      </p>
      <ol
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-mw-border bg-mw-surface-raised p-3 font-mono text-sm"
      >
        {props.codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} className={SECONDARY_BUTTON_CLASS}>
          {copied ? "Copied" : "Copy codes"}
        </button>
        <button type="button" onClick={download} className={SECONDARY_BUTTON_CLASS}>
          Download codes
        </button>
      </div>
    </div>
  );
}

type WizardState =
  | { phase: "starting" }
  | { phase: "scan"; enrolment: TotpEnrolment; submitting: boolean; error?: string }
  | { phase: "codes"; codes: string[] }
  | { phase: "failed"; message: string };

/**
 * The authenticator wizard: scan (or type) the secret, confirm with the
 * first code, keep the recovery codes. The two callers differ only in
 * which routes `start` and `confirm` hit -- the signed-in ones from the
 * Account pane, the challenge-bearing ones from the login interstitial --
 * so the routes are injected and the screens are shared.
 */
export function EnrolWizard(props: {
  start: () => Promise<TotpEnrolment>;
  confirm: (code: string) => Promise<string[]>;
  email?: string;
  /** The action after the codes have been kept. */
  doneLabel: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { start } = props;
  const [state, setState] = useState<WizardState>({ phase: "starting" });
  const [fieldError, setFieldError] = useState<string | undefined>();
  const codeId = useId();
  const secretId = useId();

  useEffect(() => {
    let alive = true;
    start()
      .then((enrolment) => {
        if (alive) setState({ phase: "scan", enrolment, submitting: false });
      })
      .catch((err: unknown) => {
        if (alive) setState({ phase: "failed", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [start]);

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.phase !== "scan") return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    const error = validateTotpCode(code);
    setFieldError(error);
    if (error) return;
    setState({ ...state, submitting: true, error: undefined });
    try {
      const codes = await props.confirm(normalizeTotpCode(code));
      setState({ phase: "codes", codes });
    } catch (err) {
      setState({ ...state, submitting: false, error: failureMessage(err) });
    }
  }

  if (state.phase === "starting") {
    return (
      <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
        Preparing your authenticator…
      </p>
    );
  }
  if (state.phase === "failed") {
    return (
      <Alert>
        <p>{state.message}</p>
        {props.onCancel && (
          <div>
            <button type="button" onClick={props.onCancel} className={SECONDARY_BUTTON_CLASS}>
              Back
            </button>
          </div>
        )}
      </Alert>
    );
  }
  if (state.phase === "codes") {
    return (
      <div className="flex flex-col gap-4" aria-live="polite">
        <p className="text-sm">Your authenticator is set up.</p>
        <RecoveryCodes codes={state.codes} email={props.email} />
        <div>
          <button type="button" onClick={props.onDone} className={PRIMARY_BUTTON_CLASS}>
            {props.doneLabel}
          </button>
        </div>
      </div>
    );
  }

  const { enrolment, submitting, error } = state;
  return (
    <form
      noValidate
      aria-busy={submitting}
      onSubmit={(event) => void handleConfirm(event)}
      className="flex flex-col gap-4"
    >
      <ErrorSummary errors={[fieldError]} />
      {error && (
        <Alert>
          <p>{error}</p>
        </Alert>
      )}
      <ol className="flex flex-col gap-3 text-sm">
        <li className="flex flex-col gap-2">
          <span>
            <span className="font-medium">1.</span> Scan this with your authenticator app (Google
            Authenticator, 1Password, Authy or any app that takes a QR code).
          </span>
          <img
            src={enrolment.qr_svg}
            alt="QR code for your authenticator app"
            width={176}
            height={176}
            className="rounded-lg border border-mw-border bg-white p-1"
          />
          <details className="text-xs text-mw-text-muted">
            <summary className="cursor-pointer">Can&apos;t scan it? Enter the key by hand</summary>
            <p className="mt-1">
              Add an account with this key, time-based, six digits:
            </p>
            <code id={secretId} className="mt-1 block break-all font-mono text-sm text-mw-text">
              {enrolment.secret}
            </code>
          </details>
        </li>
        <li className="flex flex-col gap-2">
          <span>
            <span className="font-medium">2.</span> Enter the six-digit code the app shows.
          </span>
          <Field
            id={codeId}
            name="code"
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            error={fieldError}
          />
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton busy={submitting} busyLabel="Checking…">
          Turn on
        </SubmitButton>
        {props.onCancel && (
          <button type="button" onClick={props.onCancel} className={LINK_CLASS}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

type ChallengeState = { phase: "form" } | { phase: "submitting" } | { phase: "error"; message: string; expired: boolean };

/**
 * The code step: a code from the app, or one of the recovery codes.
 * A 400 is the challenge itself having expired -- the sign-in has to
 * start over from the password, which is what Start again does.
 */
function MfaChallengeStep(props: { challenge: string; email: string; onRestart: () => void }) {
  const [state, setState] = useState<ChallengeState>({ phase: "form" });
  const [useRecovery, setUseRecovery] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const codeId = useId();
  const submitting = state.phase === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("code") ?? "");
    const error = useRecovery ? validateRecoveryCode(typed) : validateTotpCode(typed);
    setFieldError(error);
    if (error) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      const body = useRecovery
        ? { challenge: props.challenge, recovery_code: typed.trim() }
        : { challenge: props.challenge, code: normalizeTotpCode(typed) };
      const result = await apiFetch<MfaLoginResponse>("/api/auth/mfa", {
        method: "POST",
        json: body,
      });
      completeLogin(result.redirect);
    } catch (err) {
      setState({
        phase: "error",
        message: failureMessage(err),
        expired: err instanceof ApiError && err.status === 400,
      });
    }
  }

  return (
    <AuthPage
      title="Enter your code"
      intro={
        useRecovery
          ? `Signing in as ${props.email} with a recovery code. Each code works once.`
          : `Signing in as ${props.email}. Open your authenticator app and enter the code it shows.`
      }
    >
      <form
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => void handleSubmit(event)}
        className="flex flex-col gap-4"
      >
        <ErrorSummary errors={[fieldError]} />
        {state.phase === "error" && (
          <Alert>
            <p>{state.message}</p>
            {state.expired && (
              <div>
                <button type="button" onClick={props.onRestart} className={SECONDARY_BUTTON_CLASS}>
                  Start again
                </button>
              </div>
            )}
          </Alert>
        )}
        <Field
          id={codeId}
          name="code"
          label={useRecovery ? "Recovery code" : "Authenticator code"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          required
          error={fieldError}
        />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton busy={submitting} busyLabel="Signing in…">
            Sign in
          </SubmitButton>
          <button
            type="button"
            className={LINK_CLASS}
            onClick={() => {
              setUseRecovery((value) => !value);
              setFieldError(undefined);
            }}
          >
            {useRecovery ? "Use the authenticator app instead" : "Use a recovery code instead"}
          </button>
        </div>
      </form>
    </AuthPage>
  );
}

/**
 * The org-policy interstitial: why the sign-in stopped, the wizard, and
 * then the code step against the fresh challenge the confirm answered.
 */
function MfaEnrolStep(props: { challenge: string; email: string; onRestart: () => void }) {
  const [proven, setProven] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const { challenge } = props;
  // Stable per challenge: the wizard starts the registration from an
  // effect keyed on `start`, so a fresh function each render would start
  // it again on every render and throw the scan step back up over the
  // codes the person is trying to keep.
  const start = useCallback(
    () =>
      apiFetch<TotpEnrolment>("/api/auth/mfa/enrol/start", {
        method: "POST",
        json: { challenge },
      }),
    [challenge],
  );
  const confirm = useCallback(
    async (code: string) => {
      const result = await apiFetch<EnrolConfirmResponse>("/api/auth/mfa/enrol/confirm", {
        method: "POST",
        json: { challenge, code },
      });
      setProven(result.challenge);
      return result.recovery_codes;
    },
    [challenge],
  );

  if (next !== null) {
    return <MfaChallengeStep challenge={next} email={props.email} onRestart={props.onRestart} />;
  }
  return (
    <AuthPage
      title="Set up two-factor authentication"
      intro="Your organisation requires an authenticator app on every account. Set yours up to finish signing in; it takes about a minute."
    >
      <EnrolWizard
        start={start}
        confirm={confirm}
        email={props.email}
        doneLabel="Continue to sign in"
        onDone={() => setNext(proven)}
        // Not ready to set it up now, or the wrong account: back to the
        // password step on the same auth request.
        onCancel={props.onRestart}
      />
      <p className="text-sm text-mw-text-muted">
        Not {props.email}?{" "}
        <a href={LOGIN_PATH} className={LINK_CLASS}>
          Sign in as someone else
        </a>
      </p>
    </AuthPage>
  );
}

export function MfaPage(props: {
  mode: MfaMode;
  challenge: string;
  email: string;
  onRestart: () => void;
}) {
  return props.mode === "enrol" ? (
    <MfaEnrolStep challenge={props.challenge} email={props.email} onRestart={props.onRestart} />
  ) : (
    <MfaChallengeStep challenge={props.challenge} email={props.email} onRestart={props.onRestart} />
  );
}
