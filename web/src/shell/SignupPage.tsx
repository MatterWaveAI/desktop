import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ApiError, apiFetch } from "../lib/api";
import { startLogin } from "../lib/auth";
import { Alert, AuthPage, ErrorSummary, Field, PasswordField, SubmitButton } from "./AuthForm";
import {
  passwordRule,
  SECONDARY_BUTTON_CLASS,
  ensureAuthConfig,
  failureMessage,
  hasErrors,
  splitValidationDetail,
  validateConfirm,
  validateEmail,
  validatePassword,
  withEmail,
} from "./authForms";
import { PRIVACY_PATH, TERMS_PATH, VERIFY_PATH } from "./frontDoor";
import { CHECKBOX_CLASS, CHECKBOX_LABEL_CLASS, TAP_LINK_CLASS } from "./frontDoorLinks";
import { passwordStrength, type PasswordStrength } from "./passwordStrength";

/**
 * Open registration. Slice 1 collected an email and a name and left
 * the password to Zitadel's emailed link; slice 2 owns the whole thing, since
 * the user never sees Zitadel: name, email, password and terms are taken
 * here, the API creates the account `pending_verification`, and the emailed
 * six-character code is entered on /verify.
 *
 * The API answers a duplicate address with a 409 whose detail is the message
 * to show (checked before anything is created), so the page shows that
 * detail and offers sign-in rather than inventing wording of its own. A 422
 * is pydantic's list, sorted onto the fields it names.
 *
 * The form asks for the email first -- it is the name of the account and
 * the address the code goes to -- then the name, then the password with a
 * strength reading as it is typed and a match check before submit. The
 * inputs stay uncontrolled and are read at submit; the live hints are a
 * second reading of the same fields, never the source of what is sent.
 */

/** `POST /api/signup` on success: the account exists, the code is on its way. */
interface SignupResponse {
  status: "pending_verification";
  email: string;
  /**
   * False when the API could not queue the mail (a Redis blip). The signup
   * still succeeded, so this is not an error -- but /verify must not then say
   * "check your email", because nothing is coming until Resend is pressed.
   * Absent on an older API, and absent reads as sent.
   */
  mail_sent?: boolean;
}

type SignupState =
  | { phase: "form" }
  | { phase: "submitting" }
  /** `exists` is the 409: the fix is to sign in. Anything else can be retried. */
  | { phase: "error"; kind: "exists" | "retryable"; message: string };

/** The field names as the API knows them; a 422's `loc` tail matches these. */
const FIELDS = [
  "first_name",
  "last_name",
  "email",
  "password",
  "password_confirm",
  "phone",
  "accept_terms",
] as const;
type FieldName = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<FieldName, string>>;

interface SignupForm {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
  password_confirm: string;
  phone: string;
  accept_terms: boolean;
}

function readForm(data: FormData): SignupForm {
  const text = (name: string) => String(data.get(name) ?? "");
  return {
    first_name: text("first_name").trim(),
    last_name: text("last_name").trim(),
    email: text("email").trim(),
    // Not trimmed: a password is whatever was typed.
    password: text("password"),
    password_confirm: text("password_confirm"),
    phone: text("phone").trim(),
    accept_terms: data.get("accept_terms") === "on",
  };
}

/**
 * The API's own rule (app.py, `_phone_in_e164`), checked here first so a
 * missing country code is a field error before the post rather than after:
 * separators dropped, a leading 00 read as +, then + and 8 to 15 digits.
 */
function validatePhone(phone: string): string | undefined {
  if (phone === "") return undefined;
  let digits = phone.replace(/[\s().-]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (!digits.startsWith("+")) digits = "+" + digits;
  return /^\+[1-9]\d{7,14}$/.test(digits)
    ? undefined
    : t`Enter the phone number with its country code, like +1 406 555 0100.`;
}

function validate(form: SignupForm): FieldErrors {
  return {
    phone: validatePhone(form.phone),
    first_name: form.first_name === "" ? t`Enter your first name.` : undefined,
    last_name: form.last_name === "" ? t`Enter your last name.` : undefined,
    email: validateEmail(form.email),
    password: validatePassword(form.password),
    password_confirm: validateConfirm(form.password, form.password_confirm),
    accept_terms: form.accept_terms ? undefined : t`Accept the terms to continue.`,
  };
}

/**
 * An org invite the /join page hands over: the token rides in the
 * signup body. A mailed invite fixes the address because it is to that
 * person, and the API refuses any other; a shareable invite link (`link`)
 * has no address -- it is to whoever holds it -- so the field stays open.
 */
export interface SignupInvite {
  token: string;
  email?: string;
  orgName: string;
  role: string;
  link?: boolean;
}

export function SignupPage(props: { invite?: SignupInvite } = {}) {
  const { t } = useLingui();
  const { invite } = props;
  const navigate = useNavigate();
  const [state, setState] = useState<SignupState>({ phase: "form" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  /** The address the last attempt used, so a 409 can link to /verify for it. */
  const [lastEmail, setLastEmail] = useState<string | undefined>(invite?.email);
  // What the two password fields hold right now, for the strength reading
  // and the match check; the submit reads the form itself.
  const [typed, setTyped] = useState({ password: "", confirm: "" });
  const id = useId();
  const fieldId = (name: FieldName) => `${id}-${name}`;
  const submitting = state.phase === "submitting";

  const strength = passwordStrength(typed.password);
  // Said as soon as both are typed and differ, cleared the moment they
  // agree; until the confirmation is typed, only a submit can complain.
  const liveMismatch = typed.confirm !== "" && typed.confirm !== typed.password;
  const confirmError =
    typed.confirm !== ""
      ? liveMismatch
        ? t`The passwords do not match.`
        : undefined
      : fieldErrors.password_confirm;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read before the first await: the form may be gone by the time it resolves.
    const form = readForm(new FormData(event.currentTarget));
    if (invite?.email) form.email = invite.email; // read-only in the form; the invite decides it
    setLastEmail(form.email);
    const errors = validate(form);
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      setState({ phase: "form" });
      return;
    }
    setState({ phase: "submitting" });
    try {
      await ensureAuthConfig();
      const result = await apiFetch<SignupResponse>("/api/signup", {
        method: "POST",
        json: {
          first_name: form.first_name,
          last_name: form.last_name,
          email: form.email,
          password: form.password,
          password_confirm: form.password_confirm,
          ...(form.phone ? { phone: form.phone } : {}),
          ...(invite ? { [invite.link ? "invite_link_token" : "invite_token"]: invite.token } : {}),
          accept_terms: true,
        },
      });
      // The code goes in on its own page, so a refresh there does not resubmit this one.
      const to = withEmail(VERIFY_PATH, result.email || form.email);
      // Carry the queue failure to the page that would otherwise promise mail.
      await navigate({ href: result.mail_sent === false ? `${to}&mail=0` : to });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const split = splitValidationDetail(err, FIELDS);
        setFieldErrors(split.fields);
        // Whatever named no field still has to be seen somewhere.
        const unplaced = split.other.join(" ");
        setState(
          unplaced || !hasErrors(split.fields)
            ? { phase: "error", kind: "retryable", message: unplaced || failureMessage(err) }
            : { phase: "form" },
        );
        return;
      }
      setState({
        phase: "error",
        kind: err instanceof ApiError && err.status === 409 ? "exists" : "retryable",
        message: failureMessage(err),
      });
    }
  }

  async function signIn() {
    try {
      startLogin(await ensureAuthConfig());
    } catch (err) {
      setState({ phase: "error", kind: "retryable", message: failureMessage(err) });
    }
  }

  const orgName = invite?.orgName;
  const role = invite?.role;
  return (
    <AuthPage
      title={invite ? t`Join ${orgName}` : t`Create your account`}
      intro={
        invite
          ? t`You have been invited to ${orgName} as ${role}. Create your account to join; we will email you a code to confirm your address.`
          : t`Start with your email: we will send a code there to confirm it.`
      }
    >
      <form
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => void handleSubmit(event)}
        className="flex flex-col gap-4"
      >
        <ErrorSummary errors={FIELDS.map((name) => fieldErrors[name])} />

        {state.phase === "error" && (
          <Alert>
            <p>{state.message}</p>
            <div className="flex flex-wrap items-center gap-2">
              {state.kind === "exists" ? (
                <>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON_CLASS}
                    onClick={() => void signIn()}
                  >
                    <Trans>Sign in instead</Trans>
                  </button>
                  {/*
                    An existing account is not always a usable one: a signup
                    that was never confirmed leaves an account that exists and
                    cannot sign in, and "Sign in instead" sends that person to
                    a form that will refuse them with no way back. /verify is
                    the way out, and it is also where they can ask for another
                    code, so it is offered beside the sign-in rather than
                    instead of it.
                  */}
                  <a className={SECONDARY_BUTTON_CLASS} href={withEmail(VERIFY_PATH, lastEmail)}>
                    <Trans>Confirm my email</Trans>
                  </a>
                </>
              ) : (
                <button type="submit" className={SECONDARY_BUTTON_CLASS}>
                  <Trans>Retry</Trans>
                </button>
              )}
            </div>
          </Alert>
        )}

        <Field
          id={fieldId("email")}
          name="email"
          label={t`Email`}
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          readOnly={invite?.email !== undefined}
          defaultValue={invite?.email}
          hint={invite?.email !== undefined ? t`The invitation is for this address.` : t`This is the name of your account.`}
          error={fieldErrors.email}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={fieldId("first_name")}
            name="first_name"
            label={t`First name`}
            type="text"
            autoComplete="given-name"
            required
            error={fieldErrors.first_name}
          />
          <Field
            id={fieldId("last_name")}
            name="last_name"
            label={t`Last name`}
            type="text"
            autoComplete="family-name"
            required
            error={fieldErrors.last_name}
          />
        </div>
        <PasswordField
          id={fieldId("password")}
          name="password"
          label={t`Password`}
          autoComplete="new-password"
          required
          hint={passwordRule()}
          error={fieldErrors.password}
          onChange={(event) => {
            const password = event.currentTarget.value;
            setTyped((t) => ({ ...t, password }));
          }}
          after={<StrengthMeter strength={strength} />}
        />
        <PasswordField
          id={fieldId("password_confirm")}
          name="password_confirm"
          label={t`Confirm password`}
          autoComplete="new-password"
          required
          error={confirmError}
          onChange={(event) => {
            const confirm = event.currentTarget.value;
            setTyped((t) => ({ ...t, confirm }));
          }}
        />
        <Field
          id={fieldId("phone")}
          name="phone"
          label={t`Phone (optional)`}
          type="tel"
          autoComplete="tel"
          hint={t`Optional. With the country code, like +1 406 555 0100.`}
          error={fieldErrors.phone}
        />

        <div className="flex flex-col gap-1.5">
          <label className={CHECKBOX_LABEL_CLASS}>
            <input
              id={fieldId("accept_terms")}
              name="accept_terms"
              type="checkbox"
              required
              aria-invalid={fieldErrors.accept_terms !== undefined || undefined}
              aria-describedby={fieldErrors.accept_terms ? `${fieldId("accept_terms")}-error` : undefined}
              className={CHECKBOX_CLASS}
            />
            <span>
              {/* A new tab: following the link in place would lose the form. */}
              <Trans>
                I accept the{" "}
                <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-2">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-2">
                  Privacy Policy
                </a>
              </Trans>
            </span>
          </label>
          {fieldErrors.accept_terms && (
            <p id={`${fieldId("accept_terms")}-error`} className="text-xs text-mw-danger">
              {fieldErrors.accept_terms}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton busy={submitting} busyLabel={t`Creating account…`}>
            <Trans>Create account</Trans>
          </SubmitButton>
          <button
            type="button"
            className={`${TAP_LINK_CLASS} text-left`}
            onClick={() => void signIn()}
          >
            <Trans>Already have an account? Sign in</Trans>
          </button>
        </div>
      </form>
    </AuthPage>
  );
}

/**
 * Four segments and a word, under the password as it is typed. A reading,
 * not a gate: the rule is the twelve characters the API enforces, and a
 * password that meets it is accepted whatever this says. Announced politely
 * so a screen reader hears the word change without losing the field.
 */
const STRENGTH_TONES = {
  1: { bar: "bg-mw-danger-strong", text: "text-mw-danger" },
  2: { bar: "bg-mw-warning-strong", text: "text-mw-warning" },
  3: { bar: "bg-mw-brand-strong", text: "text-mw-link" },
  4: { bar: "bg-mw-positive-strong", text: "text-mw-positive" },
} as const;

function StrengthMeter(props: { strength: PasswordStrength }) {
  const { score, label, hints } = props.strength;
  if (score === 0) return null;
  // The brand's ramp from weak to strong: red, amber, the logo's blue, its emerald.
  const tone = STRENGTH_TONES[score];
  return (
    <div data-password-strength={score} className="flex flex-col gap-1 pt-1">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((segment) => (
            <span
              key={segment}
              className={`h-1.5 flex-1 rounded-full ${segment <= score ? tone.bar : "bg-mw-surface-active"}`}
            />
          ))}
        </div>
        <span aria-live="polite" className={`text-xs font-medium ${tone.text}`}>
          {label}
        </span>
      </div>
      {hints.length > 0 && <p className="text-xs text-mw-text-muted">{hints.join(" ")}</p>}
    </div>
  );
}
