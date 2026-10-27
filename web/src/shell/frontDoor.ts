/**
 * The front door: what a stranger sees before there is a session.
 *
 * Kept as data in its own module so Boot's anonymous gate, the router and
 * the pages all name the same paths and the same line, and so the component
 * files export only components (a file mixing the two breaks fast refresh
 * for it).
 */

/** Registration (slice 1). */
export const SIGNUP_PATH = "/signup";
/**
 * Our own sign-in form (slice 2). Zitadel's authorize endpoint sends the
 * browser here with `?authRequest=<id>`; the API finishes the request. The
 * user never sees the IdP's UI.
 */
export const LOGIN_PATH = "/login";
/** Enter the emailed code; `?email=` prefills the address. */
export const VERIFY_PATH = "/verify";
export const FORGOT_PATH = "/forgot";
/** Enter the reset code and a new password; `?email=` prefills the address. */
export const RESET_PATH = "/reset";
/**
 * The legal pages. Linked from the signup form's acceptance line,
 * so a stranger must be able to read them before there is a session.
 */
export const TERMS_PATH = "/terms";
export const PRIVACY_PATH = "/privacy";
/**
 * The acceptable-use policy: what is not allowed, what happens when it is,
 * how to appeal and how to report, with the numbers behind it. Anonymous
 * because a suspended person, whose every other request is refused, must
 * be able to read how to appeal -- the 403 points here.
 */
export const POLICY_PATH = "/policy";
/**
 * The invite landing: `?token=` from the mail. Anonymous because the
 * invited person usually has no account yet; signed in, it is a one-click
 * accept instead.
 */
export const JOIN_PATH = "/join";
/**
 * The plan ladder. Anonymous on purpose: a stranger deciding whether
 * to sign up needs to see the prices before there is an account, and a
 * paywall that hides its prices behind a login is the kind of thing people
 * screenshot. Subscribe itself is admin-only and signed in; the page says so.
 */
export const PRICING_PATH = "/pricing";
/**
 * Where Checkout sends the browser back (MW_STRIPE_CHECKOUT_SUCCESS_URL).
 * NOT anonymous: it polls /api/billing/status, which needs the session the
 * person had when they clicked Subscribe. Checkout returns to the same
 * browser, so the cookie is still there.
 */
export const BILLING_SUCCESS_PATH = "/billing/success";
/**
 * The developer portal: quickstart, the API reference, pricing and the API
 * changelog. Anonymous for the same reason /pricing is: a developer
 * deciding whether to build on this needs the reference before there is an
 * account, and a key is only one of the ways in -- any OpenAI client works.
 */
/**
 * The developer docs live on their own host (docs.matterwave.ai), outside
 * the app entirely: the app links there externally and carries no routes
 * for them. The paths must match the docs site's own structure.
 */
export const DEVELOPERS_PATH = "https://docs.matterwave.ai";
export const DEVELOPERS_REFERENCE_PATH = "https://docs.matterwave.ai/reference";
export const DEVELOPERS_PRICING_PATH = "https://docs.matterwave.ai/pricing";
export const DEVELOPERS_CHANGELOG_PATH = "https://docs.matterwave.ai/changelog";

/**
 * Device login: `?user_code=` from the terminal or editor that printed it.
 * Anonymous so the link opens before there is a session; the page itself
 * sends a signed-out visitor to sign in, and approves only for a person.
 */
export const DEVICE_PATH = "/device";

/**
 * One-click unsubscribe: `?t=` from a usage alert's footer link. Anonymous
 * because the signed token is the credential; the recipient need not have
 * a session, or even remember their password, to stop the mail.
 */
export const UNSUBSCRIBE_PATH = "/unsubscribe";

/** Every route that renders without a session besides the landing page. */
const ANONYMOUS_PATHS: ReadonlySet<string> = new Set([
  SIGNUP_PATH,
  LOGIN_PATH,
  VERIFY_PATH,
  FORGOT_PATH,
  RESET_PATH,
  TERMS_PATH,
  PRIVACY_PATH,
  POLICY_PATH,
  JOIN_PATH,
  DEVICE_PATH,
  UNSUBSCRIBE_PATH,
  PRICING_PATH,
]);

/**
 * A shared conversation: `/share/<token>`. Anonymous because the whole
 * point is a reader with no account; the token is the credential, and the
 * API answers the page's one request without a session. A prefix rather
 * than an entry in the set above because the path carries the token.
 */
export const SHARE_PATH_PREFIX = "/share/";

/** Does this path belong to the front door, or does it need a principal? */
export function isAnonymousPath(pathname: string): boolean {
  return ANONYMOUS_PATHS.has(pathname) || pathname.startsWith(SHARE_PATH_PREFIX);
}

/**
 * Pages a new account came to for one task -- approving a device code,
 * accepting an invite -- where the first-run walkthrough waits rather than
 * standing in front of them. It is still unfinished, so the next visit to
 * anywhere else shows it.
 */
const ONBOARDING_WAITS_ON: ReadonlySet<string> = new Set([DEVICE_PATH, JOIN_PATH]);

export function onboardingWaits(pathname: string): boolean {
  return ONBOARDING_WAITS_ON.has(pathname.replace(/\/$/, ""));
}
