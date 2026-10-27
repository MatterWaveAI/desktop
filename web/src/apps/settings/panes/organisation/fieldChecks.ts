import { failureMessage, splitValidationDetail } from "../../../../shell/authForms";

/**
 * The Organisation pane's own checks, run before a request is sent. They
 * catch what a person commonly types by mistake; the API still decides.
 */

// A bare hostname with at least one dot: what people paste instead is a
// URL ("https://acme.com/login") or an address ("ada@acme.com").
const DOMAIN_SHAPE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

export function validateDomain(domain: string): string | undefined {
  if (domain === "") return "Enter a domain.";
  if (!DOMAIN_SHAPE.test(domain)) {
    return "Enter just the domain, like example.com, without https://, a path or an @.";
  }
  return undefined;
}

export const IDP_FIELD_NAMES = ["name", "issuer", "client_id", "client_secret", "scopes"] as const;
export type IdpField = (typeof IDP_FIELD_NAMES)[number];

export function validateIdp(values: Record<IdpField, string>): Partial<Record<IdpField, string>> {
  const errors: Partial<Record<IdpField, string>> = {};
  if (values.name === "") errors.name = "Enter a name for the sign-in button.";
  if (values.issuer === "") errors.issuer = "Enter the issuer URL.";
  else if (!isHttpsUrl(values.issuer)) {
    errors.issuer = "The issuer is a full URL starting with https://.";
  }
  if (values.client_id === "") errors.client_id = "Enter the client ID.";
  if (values.client_secret === "") errors.client_secret = "Enter the client secret.";
  return errors;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** pydantic prefixes a validator's own sentence; the person needs only the sentence. */
function plain(message: string): string {
  return message.replace(/^Value error, /, "");
}

/**
 * A failed submit sorted onto the form: a 422's items under the fields
 * they name, everything else (a 409's sentence, an unmatched item, a lost
 * connection) as lines for the form's summary.
 */
export function sortFailure<F extends string>(
  err: unknown,
  fields: readonly F[],
): { fields: Partial<Record<F, string>>; other: string[] } {
  const split = splitValidationDetail(err, fields);
  const byField: Partial<Record<F, string>> = {};
  for (const name of fields) {
    const message = split.fields[name];
    if (message !== undefined) byField[name] = plain(message);
  }
  const other = split.other.map(plain);
  const matched = Object.keys(byField).length > 0;
  // Not a 422 list at all: the API's one sentence is the summary.
  if (!matched && other.length === 0) other.push(failureMessage(err));
  return { fields: byField, other };
}
