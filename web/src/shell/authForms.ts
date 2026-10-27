import { plural, t } from "@lingui/core/macro";
import { ApiError } from "../lib/api";
import { fetchAuthConfig, getAuthConfig } from "../lib/auth";

/**
 * What the five front-door forms share: the validation
 * rules, the API's error shapes, and the classes. Data and functions only -
 * the components live in AuthForm.tsx, so that file keeps fast refresh.
 */

// Shape, not deliverability: the verification email is the real check.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Zitadel's default policy is the floor; the API enforces it, this only says so first. */
export const PASSWORD_MIN_LENGTH = 12;
/** The rule as the field's hint; a function because the language is only known at render. */
export function passwordRule(): string {
  const min = PASSWORD_MIN_LENGTH;
  return t`At least ${min} characters.`;
}
/** The same rule for the pages not yet in the catalogue. */
export const PASSWORD_RULE = `At least ${PASSWORD_MIN_LENGTH} characters.`;

/** The emailed codes are six characters. */
// Zitadel mints six characters, letters and digits (e.g. 8UK58K) - not
// six digits, which is what this used to demand: the real code from the real
// real gateway would have been refused by our own form.
const CODE_SHAPE = /^[A-Za-z0-9]{6}$/;

export function validateEmail(email: string): string | undefined {
  if (email === "") return t`Enter your email address.`;
  if (!EMAIL_SHAPE.test(email)) return t`Enter an email address like name@example.com.`;
  return undefined;
}

/**
 * `what` names the field for a page that asks for something other than "a
 * password" ("a new password" on the reset and account pages); those pages
 * are not in the catalogue yet, so the phrase they pass is used as given.
 */
export function validatePassword(password: string, what?: string): string | undefined {
  if (password === "") return what ? `Enter ${what}.` : t`Enter a password.`;
  if (password.length < PASSWORD_MIN_LENGTH) {
    const min = PASSWORD_MIN_LENGTH;
    return t`Use ${min} characters or more for your password.`;
  }
  return undefined;
}

export function validateConfirm(password: string, confirm: string): string | undefined {
  if (confirm === "") return t`Enter your password again.`;
  if (confirm !== password) return t`The passwords do not match.`;
  return undefined;
}

export function validateCode(code: string): string | undefined {
  if (code === "") return t`Enter the code from the email.`;
  if (!CODE_SHAPE.test(code)) return t`The code is the six characters from the email.`;
  return undefined;
}

/** True when any field carries a message. */
export function hasErrors<E extends object>(errors: E): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/**
 * The CSRF cookie rides on `/api/auth-config`, which Boot fetches
 * before any route renders - but these pages do not rely on being mounted
 * through Boot, so they fetch the config themselves when nothing has.
 */
export async function ensureAuthConfig() {
  return getAuthConfig() ?? (await fetchAuthConfig());
}

/** Focus what just appeared, so a screen reader lands on it and a keyboard user is not left in the field. */
export function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

/** One value from the page's query string, or undefined when it is not there. */
export function queryParam(searchStr: string, key: string): string | undefined {
  return new URLSearchParams(searchStr).get(key) ?? undefined;
}

/** A front-door path with `?email=` filled in, for the links between the pages. */
export function withEmail(path: string, email: string | undefined): string {
  return email ? `${path}?email=${encodeURIComponent(email)}` : path;
}

/**
 * The line for a request that never got an answer. The string constant is
 * for the pages not yet in the catalogue; `failureMessage` says the same
 * thing in the reader's language.
 */
export const NETWORK_MESSAGE = "Could not reach MatterWave. Check your connection and try again.";
function networkMessage(): string {
  return t`Could not reach MatterWave. Check your connection and try again.`;
}

interface ValidationItem {
  loc?: unknown;
  msg?: unknown;
}

/** The `detail` of a 422, when it is pydantic's list; otherwise nothing. */
function validationItems(err: ApiError): ValidationItem[] | undefined {
  const detail = (err.body as { detail?: unknown } | undefined)?.detail;
  return Array.isArray(detail) ? (detail as ValidationItem[]) : undefined;
}

/** Said for an item about the request as a whole: nothing a person typed caused it. */
function unreadableForm(): string {
  return t`The form could not be read. Reload the page and try again.`;
}

/**
 * pydantic's wording, in the form's voice: its "Value error, " prefix
 * dropped and its stock phrases ("String should have at least 1 character")
 * turned into an instruction. Lower-case first, so it reads after a field
 * name; `sentence` capitalises it when it stands alone.
 */
function humanizeMessage(msg: string): string {
  const text = msg.replace(/^(Value error|Assertion failed), /, "").trim();
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [
      /^String should have at least (\d+) characters?$/,
      (m) => {
        const count = Number(m[1]);
        return plural(count, { one: "enter at least # character", other: "enter at least # characters" });
      },
    ],
    [
      /^String should have at most (\d+) characters?$/,
      (m) => {
        const count = Number(m[1]);
        return t`use at most ${count} characters`;
      },
    ],
    [/^Field required$/, () => t`this is required`],
    [
      /^Input should be a valid (.+)$/,
      (m) => {
        const kind = m[1];
        return t`enter a valid ${kind}`;
      },
    ],
    [/^String should match pattern .*$/, () => t`this is not in the expected format`],
    [
      /^Input should be (less|greater) than( or equal to)? (.+)$/,
      (m) => {
        const bound = m[3];
        const orEqual = m[2] !== undefined;
        if (m[1] === "less") {
          return orEqual ? t`use a number less than or equal to ${bound}` : t`use a number less than ${bound}`;
        }
        return orEqual ? t`use a number greater than or equal to ${bound}` : t`use a number greater than ${bound}`;
      },
    ],
  ];
  for (const [pattern, phrase] of rules) {
    const match = text.match(pattern);
    if (match) return phrase(match);
  }
  // Keep an acronym's case ("SSO is..."), lower an ordinary first word.
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** `["body", "client_id"]` -> "Client id"; undefined for the body itself. */
function fieldLabel(loc: unknown): string | undefined {
  const parts = Array.isArray(loc) ? loc : [];
  const tail = parts[parts.length - 1];
  if (typeof tail !== "string" || tail === "body" || tail === "query") return undefined;
  const words = tail.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

/** One 422 item as a sentence, prefixed with the field it is about. */
function describeItem(item: ValidationItem): string | undefined {
  if (typeof item.msg !== "string") return undefined;
  const label = fieldLabel(item.loc);
  if (!label) {
    // A body-level message the API wrote itself (a cross-field rule) is
    // already a sentence; pydantic's own ("Input should be a valid
    // dictionary", "JSON decode error") means the client sent nonsense.
    const own = item.msg.replace(/^(Value error|Assertion failed), /, "");
    return /^(Input should|JSON decode error|Field required)/.test(own) ? unreadableForm() : sentence(own);
  }
  return sentence(`${label}: ${humanizeMessage(item.msg)}`);
}

/**
 * The line to show for a failed request. The API's `detail` when it is a
 * string, pydantic's list as readable sentences (each naming its field),
 * and a generic line when the request never got an answer.
 */
export function failureMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return networkMessage();
  const items = validationItems(err);
  if (items) {
    const messages = [...new Set(items.map(describeItem).filter((m) => m !== undefined))];
    if (messages.length > 0) return messages.join(" ");
  }
  return err.message;
}

/**
 * Sort a 422's items onto the form: an item whose last `loc` segment names a
 * field we render goes under that field, the rest are returned for a summary.
 * pydantic's `loc` is `["body", "email"]`-shaped; only the tail matters here.
 */
export function splitValidationDetail<F extends string>(
  err: unknown,
  fields: readonly F[],
): { fields: Partial<Record<F, string>>; other: string[] } {
  const byField: Partial<Record<F, string>> = {};
  const other: string[] = [];
  const items = err instanceof ApiError ? validationItems(err) : undefined;
  for (const item of items ?? []) {
    if (typeof item.msg !== "string") continue;
    const loc = Array.isArray(item.loc) ? item.loc : [];
    const tail = loc[loc.length - 1];
    const field = fields.find((name) => name === tail);
    if (field && byField[field] === undefined) byField[field] = sentence(humanizeMessage(item.msg));
    else other.push(describeItem(item) ?? item.msg);
  }
  return { fields: byField, other };
}

export const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-mw-border-strong bg-mw-surface px-3 text-base text-mw-text outline-none placeholder:text-mw-text-muted hover:border-mw-text-muted focus-visible:border-mw-focus focus-visible:ring-2 focus-visible:ring-mw-focus aria-invalid:border-mw-danger md:text-sm";
export const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-mw-accent px-4 py-2 text-sm font-semibold text-mw-accent-foreground outline-none hover:bg-mw-accent-hover focus-visible:ring-2 focus-visible:ring-mw-focus focus-visible:ring-offset-2 focus-visible:ring-offset-mw-surface disabled:bg-mw-surface-active disabled:text-mw-text-muted";
export const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-mw-border-emphasis bg-transparent px-3 py-1.5 text-sm font-medium text-mw-text outline-none hover:bg-mw-surface-hover focus-visible:ring-2 focus-visible:ring-mw-focus";
export const LINK_CLASS = "text-sm text-mw-text-muted underline-offset-2 hover:text-mw-text hover:underline";

/**
 * A link inside running text. Underlined, and at least 24px tall (44 on a
 * finger) like every other link on the front door: an inline anchor is only
 * as tall as its line, and the audit measured these at 18px on a phone.
 */
export const PROSE_LINK_CLASS =
  "inline-flex min-h-6 items-center underline underline-offset-2 hover:text-mw-text pointer-coarse:min-h-11";
