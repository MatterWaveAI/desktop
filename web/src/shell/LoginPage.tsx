import { useEffect, useId, useState, type FocusEvent, type FormEvent, useRef } from "react";
import { useLocation } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  accountLabel,
  fetchAccounts,
  reloadAsSwitchedAccount,
  switchAccount,
  type AccountEntry,
} from "../lib/accounts";
import { ApiError, apiFetch } from "../lib/api";
import { desktopReload, desktopSignIn, isDesktop } from "../lib/desktopAuth";
import {
  lastLoginMethod,
  rememberLoginMethod,
  rememberSsoFailure,
  ssoFailureFromQuery,
  ssoFailureMessage,
  takeSsoFailure,
  type SsoFailure,
} from "../lib/loginMemory";
import { signInWithPasskey } from "../lib/passkeys";
import { PasskeyCancelled, passkeysSupported } from "../lib/webauthn";
import type { LoginIdp } from "../types";
import {
  clearLoginStarting,
  completeLogin,
  getAuthConfig,
  loginStartInFlight,
  markLoginStarting,
  rememberedLoginReturn,
  startLogin,
} from "../lib/auth";
import { Alert, AuthPage, ErrorSummary, Field, PasswordField, SubmitButton } from "./AuthForm";
import {
  SECONDARY_BUTTON_CLASS,
  ensureAuthConfig,
  failureMessage,
  hasErrors,
  queryParam,
  validateEmail,
  withEmail,
} from "./authForms";
import { peekDeepLink } from "./deepLink";
import { FORGOT_PATH, SIGNUP_PATH, VERIFY_PATH } from "./frontDoor";
import { TAP_LINK_CLASS } from "./frontDoorLinks";
import { MfaPage } from "./MfaPage";
import type { MfaMode } from "./mfaForms";

/**
 * Our sign-in form: the user never sees Zitadel. The OIDC
 * request still starts at the API's login route; Zitadel's authorize
 * endpoint then sends the browser here with `?authRequest=<id>` instead of
 * to its own UI. The form posts the credentials and the id to the API, which
 * checks them with Zitadel and answers with the URL that finishes the
 * request - it lands on `/api/auth/callback` exactly as before, so the
 * session cookie and everything behind it are unchanged.
 *
 * Without an id there is nothing to finish, so a bare `/login` (a bookmark,
 * a typed URL) starts the request itself and comes straight back with one.
 *
 * Org SSO: once the email is typed, the page asks the API
 * whether its domain belongs to an org with a provider attached, and if so
 * offers "Sign in with <name>". That button starts a fresh request with the
 * provider selected; the API answers only for verified domains, so a
 * stranger's address shows nothing and the form is unchanged. The line
 * under the form says this is how an organisation's sign-in is reached,
 * since there is no provider to pick before the address is known.
 *
 * "Sign in to continue": when the front door remembered where a signed-out
 * visitor was going (`deepLink.ts`), the heading says so; the sign-in itself
 * is unchanged, and the first navigation afterwards lands there.
 *
 * Three more ways in, each explicit:
 *
 * - "Sign in with your organisation" is the SSO entry for a person who
 *   knows that is how they sign in: a work email, the provider lookup, and
 *   the browser leaves for the provider with the email as its hint. Its
 *   refusals are worded apart (no sign-on for this domain, the lookup
 *   unreachable, the provider failing on the way back, the provider
 *   vouching for another domain) -- `lib/loginMemory.ts`.
 * - "Use a passkey" runs the WebAuthn ceremony for the typed address
 *   (`lib/passkeys.ts`) and leaves through the same redirect.
 * - "Continue as ..." for an account already signed in on this browser
 *   (`lib/accounts.ts`): one click, no credential typed again.
 *
 * The browser remembers which method was used last and opens on it with
 * the email filled in; never the password.
 */

/**
 * `POST /api/auth/password` on success: the redirect that finishes the
 * sign-in, or -- when the account has a second step -- a sealed challenge
 * and which step it is. The password was right either way; the
 * challenge is what MfaPage finishes with.
 */
type PasswordLoginResponse =
  | { redirect: string }
  | { status: "mfa_required" | "mfa_enrolment_required"; challenge: string };

type LoginState =
  | { phase: "form" }
  | { phase: "submitting" }
  /** `pendingEmail` is the 403 for an unverified account: the fix is the code, not the password. */
  | { phase: "error"; message: string; pendingEmail?: string }
  /** The second step, rendered in place of the form; `?authRequest=` stays in the URL. */
  | { phase: "mfa"; mode: MfaMode; challenge: string; email: string };

interface FieldErrors {
  email?: string;
  password?: string;
  /** The organisation entry's own field. */
  workEmail?: string;
}

function validate(email: string, password: string): FieldErrors {
  return {
    email: validateEmail(email),
    password: password === "" ? t`Enter your password.` : undefined,
  };
}

function failure(err: unknown, email: string): LoginState {
  const body = err instanceof ApiError ? (err.body as { status?: unknown } | undefined) : undefined;
  return {
    phase: "error",
    message: failureMessage(err),
    pendingEmail:
      err instanceof ApiError && err.status === 403 && body?.status === "pending_verification"
        ? email
        : undefined,
  };
}

/**
 * Decided once, at the top: the page is one or the other for its whole
 * life, so neither branch's hooks are ever conditional. The desktop shell
 * (clients/desktop) has no cookie and must never be sent on the browser
 * redirect (`startLogin` would navigate the webview to the API's login route
 * and Zitadel, with no session cookie to come back to).
 */
export function LoginPage() {
  return isDesktop() ? <DesktopLoginPage /> : <BrowserLoginPage />;
}

type DesktopLoginState = { phase: "idle" } | { phase: "waiting" } | { phase: "error"; message: string };

/**
 * A refused native command rejects with its message as a bare string
 * ("sign-in timed out", "could not open the browser: ..."); those are
 * written for the person and shown as they are. Anything else is an API
 * failure and gets the forms' usual wording.
 */
function desktopFailureMessage(err: unknown): string {
  if (typeof err === "string" && err) return err;
  if (err instanceof Error && !(err instanceof ApiError) && err.message) return err.message;
  return failureMessage(err);
}

/**
 * Sign-in for the desktop shell: the native side opens the system browser,
 * waits for the callback and puts the tokens in the keychain; this page only
 * asks for that and, once it has happened, reloads into Boot, which now
 * finds a token. A button rather than an effect, because a re-render must
 * not open a second browser tab.
 */
function DesktopLoginPage() {
  const { t } = useLingui();
  const [state, setState] = useState<DesktopLoginState>({ phase: "idle" });

  async function handleSignIn() {
    setState({ phase: "waiting" });
    try {
      await desktopSignIn();
      desktopReload();
    } catch (err) {
      setState({ phase: "error", message: desktopFailureMessage(err) });
    }
  }

  return (
    <AuthPage title={t`Sign in`} intro={t`MatterWave signs you in through your web browser.`}>
      <div className="flex flex-col gap-4">
        {state.phase === "error" && (
          <Alert>
            <p>{state.message}</p>
          </Alert>
        )}
        <div>
          <button
            type="button"
            disabled={state.phase === "waiting"}
            onClick={() => void handleSignIn()}
            className={SECONDARY_BUTTON_CLASS}
          >
            {state.phase === "waiting" ? (
              <Trans>Waiting for your browser…</Trans>
            ) : (
              <Trans>Sign in with your browser</Trans>
            )}
          </button>
        </div>
        {state.phase === "waiting" && (
          <p aria-live="polite" className="text-sm text-mw-text-muted">
            <Trans>Finish signing in in the browser window that opened, then come back here.</Trans>
          </p>
        )}
      </div>
    </AuthPage>
  );
}

function BrowserLoginPage() {
  const { t } = useLingui();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const authRequest = queryParam(searchStr, "authRequest");
  // `?return=` from the device page: where the API's callback should land
  // instead of "/", so the code it carries survives the sign-in. The login
  // start forwards it; the API keeps it beside the login state and
  // allowlists it again, so this page only passes it on. Zitadel brings the
  // browser back here with only `?authRequest=`, so the restarts made from
  // the form (SSO, the retry below) take the one the start remembered; a
  // bare /login is a fresh attempt and takes only what its URL says.
  const returnTo =
    queryParam(searchStr, "return") ?? (authRequest ? rememberedLoginReturn() : undefined);
  const [state, setState] = useState<LoginState>({ phase: "form" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sso, setSso] = useState<LoginIdp | null>(null);
  // Read once: the memory outlives this page, and the heading must not
  // change under the person while they type.
  const [continuing] = useState(() => peekDeepLink() !== undefined);
  // How this browser signed in last time (lib/loginMemory.ts): the form
  // opens on that method with the email filled in, so a person who always
  // uses their organisation's sign-in is not shown a password box first.
  const [remembered] = useState(() => lastLoginMethod());
  const [mode, setMode] = useState<"password" | "sso">(() =>
    remembered?.kind === "sso" || queryParam(searchStr, "org") !== undefined ? "sso" : "password",
  );
  // An organisation sign-in that failed on the way back (the callback's
  // `?sso_error=`, or the copy kept across the restart), shown once.
  const [ssoFailure, setSsoFailure] = useState<SsoFailure | null>(() =>
    authRequest ? takeSsoFailure() : null,
  );
  // The other accounts signed in on this browser, offered as one click.
  const [parked, setParked] = useState<AccountEntry[]>([]);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const workEmailId = useId();
  const submitting = state.phase === "submitting";
  const ssoName = sso?.name ?? "";
  // Whether the API offers passkeys (auth-config `passkey_login`). Boot has
  // usually fetched the config before this page renders; when it has not
  // (a direct mount), the answer arrives and the button appears with it.
  const [passkeyLogin, setPasskeyLogin] = useState(getAuthConfig()?.passkey_login === true);
  useEffect(() => {
    let alive = true;
    ensureAuthConfig()
      .then((config) => {
        if (alive) setPasskeyLogin(config.passkey_login === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const passkeysOffered = passkeyLogin && passkeysSupported();

  useEffect(() => {
    // Arriving WITH an id means the dance completed: Zitadel bounced the
    // browser back here and the login-state cookie now belongs to this
    // request. Release the guard so a later, deliberate restart can run.
    if (authRequest) {
      clearLoginStarting();
      return;
    }
    // The callback's reason for sending the person back here must outlive
    // the restart about to happen, which drops the query.
    const failed = ssoFailureFromQuery(searchStr);
    if (failed) rememberSsoFailure(failed);
    // No id and a start already out: the redirect is still on its way.
    // Starting a second one here is what replaced the login-state cookie
    // and looped the browser back to the front door.
    if (loginStartInFlight()) return;
    let alive = true;
    // No id: start the request; Zitadel sends the browser back here with one.
    markLoginStarting();
    ensureAuthConfig()
      .then((config) => {
        if (alive) startLogin(config, undefined, returnTo);
      })
      .catch((err: unknown) => {
        clearLoginStarting();
        if (alive) setState(failure(err, ""));
      });
    return () => {
      alive = false;
    };
  }, [authRequest, returnTo, searchStr]);

  useEffect(() => {
    // Who else is signed in here. Best effort and anonymous: the list is
    // what this browser's own cookies already say (lib/accounts.ts).
    if (!authRequest) return;
    let alive = true;
    fetchAccounts()
      .then((list) => {
        if (alive) setParked(list.accounts.filter((a) => !a.current));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [authRequest]);

  async function handleEmailBlur(event: FocusEvent<HTMLInputElement>) {
    const email = event.currentTarget.value.trim();
    if (validateEmail(email) !== undefined) {
      setSso(null);
      return;
    }
    try {
      setSso(await apiFetch<LoginIdp>(`/api/auth/idp?email=${encodeURIComponent(email)}`));
    } catch {
      // 404 is the ordinary answer (no SSO for this domain); any other
      // failure means the same for this form - the password path is intact.
      setSso(null);
    }
  }

  async function handleSso(provider: string, email?: string, providerName?: string) {
    setState({ phase: "submitting" });
    try {
      if (email) {
        rememberLoginMethod({
          kind: "sso",
          email,
          provider,
          providerName: providerName ?? provider,
        });
      }
      startLogin(await ensureAuthConfig(), provider, returnTo, email);
    } catch (err) {
      setState(failure(err, ""));
    }
  }

  /**
   * The organisation entry: the work email names the domain, the API says
   * which provider (if any) is attached to it, and the browser leaves for
   * that provider with the email as its hint. Each refusal is its own
   * message: no sign-on for this domain is a fact about the organisation,
   * an unreachable lookup is a fact about right now.
   */
  async function handleOrgSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("work_email") ?? "").trim();
    const problem = validateEmail(email);
    setFieldErrors({ workEmail: problem });
    if (problem) return;
    setSsoFailure(null);
    setState({ phase: "submitting" });
    let idp: LoginIdp;
    try {
      idp = await apiFetch<LoginIdp>(`/api/auth/idp?email=${encodeURIComponent(email)}`);
    } catch (err) {
      setState({ phase: "form" });
      setSsoFailure(
        err instanceof ApiError && err.status === 404
          ? { reason: "not_configured", detail: email.slice(email.indexOf("@") + 1) }
          : { reason: "unavailable", detail: "" },
      );
      return;
    }
    await handleSso(idp.provider, email, idp.name);
  }

  /**
   * "Use a passkey": the address names the account, the browser's prompt
   * proves it, and the sign-in leaves through the same redirect as the
   * password's (lib/passkeys.ts). A closed prompt is not an error worth an
   * alert; a refused one is.
   */
  async function handlePasskey(emailField: HTMLInputElement | null) {
    if (!authRequest) return;
    const email = emailField?.value.trim() ?? "";
    const problem = validateEmail(email);
    if (problem) {
      setFieldErrors({ email: t`Enter your email, then use your passkey.` });
      emailField?.focus();
      return;
    }
    setFieldErrors({});
    setPasskeyBusy(true);
    setState({ phase: "form" });
    try {
      await ensureAuthConfig();
      const redirect = await signInWithPasskey(email, authRequest);
      rememberLoginMethod({ kind: "passkey", email });
      completeLogin(redirect);
    } catch (err) {
      setPasskeyBusy(false);
      if (err instanceof PasskeyCancelled) return;
      setState(failure(err, email));
    }
  }

  async function continueAs(account: AccountEntry) {
    setState({ phase: "submitting" });
    try {
      await switchAccount(account.slot);
      reloadAsSwitchedAccount();
    } catch {
      setParked((list) => list.filter((a) => a.slot !== account.slot));
      setState({
        phase: "error",
        message: t`${accountLabel(account)} is no longer signed in on this browser. Sign in again.`,
      });
    }
  }

  // Whether the silent retry above has been spent. A ref, not state:
  // flipping it must not re-render, and the handler reads it synchronously.
  const retriedRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authRequest) return;
    // Read before the first await: the form may be gone by the time it resolves.
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    // Not trimmed: a password is whatever was typed.
    const password = String(data.get("password") ?? "");
    const errors = validate(email, password);
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      await ensureAuthConfig();
      const result = await apiFetch<PasswordLoginResponse>("/api/auth/password", {
        method: "POST",
        json: { email, password, auth_request: authRequest },
      });
      rememberLoginMethod({ kind: "password", email });
      if ("challenge" in result) {
        setState({
          phase: "mfa",
          mode: result.status === "mfa_enrolment_required" ? "enrol" : "challenge",
          challenge: result.challenge,
          email,
        });
        return;
      }
      // The browser is leaving; the submitting state stays until it has.
      completeLogin(result.redirect);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && !retriedRef.current) {
        // A 400 here is USUALLY the auth request behind ?authRequest=
        // expiring at Zitadel because the tab sat open. Nothing the person
        // typed was wrong, so a fresh request beats an error.
        //
        // ONCE only, though. The same 400 arrives when Zitadel refuses to
        // finalize the request for a reason that will not change -- a
        // missing permission on the service account, say -- and retrying
        // forever meant this page silently looped and showed nothing. One
        // retry separates them: a real expiry succeeds on the new request,
        // a permanent refusal falls through and is shown with its id.
        retriedRef.current = true;
        startLogin(await ensureAuthConfig(), undefined, returnTo);
        return;
      }
      setState(failure(err, email));
    }
  }

  if (state.phase === "mfa") {
    return (
      <MfaPage
        mode={state.mode}
        challenge={state.challenge}
        email={state.email}
        // An expired challenge: back to the password, same auth request.
        onRestart={() => setState({ phase: "form" })}
      />
    );
  }

  if (!authRequest) {
    return (
      <AuthPage title={t`Sign in`}>
        {state.phase === "error" ? (
          <Alert>
            <p>{state.message}</p>
          </Alert>
        ) : (
          <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
            <Trans>Starting sign-in…</Trans>
          </p>
        )}
      </AuthPage>
    );
  }

  const rememberedEmail = remembered?.email ?? "";
  const continueList = parked.length > 0 && (
    <div
      data-mw-parked-accounts=""
      className="flex flex-col gap-2 rounded-lg border border-mw-border bg-mw-surface-raised p-3"
    >
      <p className="text-sm text-mw-text-muted">
        <Trans>Signed in on this browser</Trans>
      </p>
      <ul className="flex flex-col gap-1">
        {parked.map((account) => (
          <li key={account.slot} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void continueAs(account)}
              className={SECONDARY_BUTTON_CLASS}
            >
              {t`Continue as ${accountLabel(account)}`}
            </button>
            {account.org_name && (
              <span className="text-xs text-mw-text-muted">{account.org_name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  if (mode === "sso") {
    const lastProvider = remembered?.kind === "sso" ? remembered : null;
    return (
      <AuthPage
        title={t`Sign in with your organisation`}
        intro={t`Enter your work email. If your organisation uses single sign-on, you will be taken to its identity provider.`}
      >
        <form
          noValidate
          aria-busy={submitting}
          onSubmit={(event) => void handleOrgSubmit(event)}
          className="flex flex-col gap-4"
          data-mw-org-signin=""
        >
          <ErrorSummary errors={[fieldErrors.workEmail]} />
          {ssoFailure && (
            <Alert>
              <p>{ssoFailureMessage(ssoFailure)}</p>
            </Alert>
          )}
          {state.phase === "error" && (
            <Alert>
              <p>{state.message}</p>
            </Alert>
          )}
          {continueList}
          {lastProvider && !ssoFailure && (
            <p className="text-sm text-mw-text-muted" data-mw-last-method="">
              {t`Last time you signed in with ${lastProvider.providerName}.`}
            </p>
          )}
          <Field
            id={workEmailId}
            name="work_email"
            label={t`Work email`}
            type="email"
            autoComplete="email"
            required
            defaultValue={lastProvider?.email ?? ""}
            error={fieldErrors.workEmail}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton busy={submitting} busyLabel={t`Looking up your organisation…`}>
              {lastProvider ? t`Continue with ${lastProvider.providerName}` : t`Continue`}
            </SubmitButton>
            <button
              type="button"
              className={TAP_LINK_CLASS}
              onClick={() => {
                setSsoFailure(null);
                setFieldErrors({});
                setState({ phase: "form" });
                setMode("password");
              }}
            >
              <Trans>Sign in with a password instead</Trans>
            </button>
          </div>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={continuing ? t`Sign in to continue` : t`Sign in`}
      intro={
        continuing
          ? t`Enter the email and password for your MatterWave account, and you will be taken on to the page you opened.`
          : t`Enter the email and password for your MatterWave account.`
      }
    >
      <form
        noValidate
        aria-busy={submitting || passkeyBusy}
        onSubmit={(event) => void handleSubmit(event)}
        className="flex flex-col gap-4"
      >
        <ErrorSummary errors={[fieldErrors.email, fieldErrors.password]} />

        {ssoFailure && (
          <Alert>
            <p>{ssoFailureMessage(ssoFailure)}</p>
          </Alert>
        )}
        {state.phase === "error" && (
          <Alert>
            <p>{state.message}</p>
            {state.pendingEmail !== undefined && (
              <div>
                <a
                  href={withEmail(VERIFY_PATH, state.pendingEmail)}
                  className={SECONDARY_BUTTON_CLASS}
                >
                  <Trans>Verify your email</Trans>
                </a>
              </div>
            )}
          </Alert>
        )}

        {continueList}

        <Field
          id={emailId}
          name="email"
          label={t`Email`}
          type="email"
          // `webauthn` lets a browser that supports conditional UI offer a
          // passkey beside its saved addresses; the sign-in still goes
          // through the button, which asks the API for this address.
          autoComplete="email webauthn"
          required
          defaultValue={rememberedEmail}
          error={fieldErrors.email}
          onBlur={(event) => void handleEmailBlur(event)}
        />
        {sso && (
          <div className="flex flex-col gap-2 rounded-lg border border-mw-border bg-mw-surface-raised p-3">
            <p className="text-sm text-mw-text-muted">
              <Trans>Your organisation signs in with {ssoName}.</Trans>
            </p>
            <div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  const email = document.querySelector<HTMLInputElement>(`#${CSS.escape(emailId)}`);
                  void handleSso(sso.provider, email?.value.trim() || undefined, sso.name);
                }}
                className={SECONDARY_BUTTON_CLASS}
              >
                <Trans>Sign in with {ssoName}</Trans>
              </button>
            </div>
          </div>
        )}
        <PasswordField
          id={passwordId}
          name="password"
          label={t`Password`}
          autoComplete="current-password"
          required
          error={fieldErrors.password}
        />

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton busy={submitting} busyLabel={t`Signing in…`}>
            <Trans>Sign in</Trans>
          </SubmitButton>
          {passkeysOffered && (
            <button
              type="button"
              disabled={submitting || passkeyBusy}
              className={SECONDARY_BUTTON_CLASS}
              data-mw-passkey=""
              onClick={() =>
                void handlePasskey(
                  document.querySelector<HTMLInputElement>(`#${CSS.escape(emailId)}`),
                )
              }
            >
              {passkeyBusy ? t`Waiting for your passkey…` : t`Use a passkey`}
            </button>
          )}
          <a href={FORGOT_PATH} className={TAP_LINK_CLASS}>
            <Trans>Forgot password?</Trans>
          </a>
        </div>
        <p className="text-sm text-mw-text-muted">
          <Trans>
            New to MatterWave?{" "}
            <a href={SIGNUP_PATH} className={TAP_LINK_CLASS}>
              Create account
            </a>
          </Trans>
        </p>
        {!sso && (
          <p data-sso-hint className="text-sm text-mw-text-muted">
            <Trans>Work account?</Trans>{" "}
            <button
              type="button"
              className={TAP_LINK_CLASS}
              data-mw-org-entry=""
              onClick={() => {
                setFieldErrors({});
                setState({ phase: "form" });
                setMode("sso");
              }}
            >
              <Trans>Sign in with your organisation</Trans>
            </button>
          </p>
        )}
      </form>
    </AuthPage>
  );
}
