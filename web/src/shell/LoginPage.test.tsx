import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadAsSwitchedAccount } from "../lib/accounts";
import { clearLoginStarting, completeLogin, startLogin } from "../lib/auth";
import { rememberLoginMethod } from "../lib/loginMemory";
import { getPasskey, passkeysSupported } from "../lib/webauthn";
import { LoginPage } from "./LoginPage";
import { LOGIN_PATH, VERIFY_PATH } from "./frontDoor";
import {
  alertText,
  authConfig,
  buttonNamed,
  callTo,
  cleanup,
  click,
  fill,
  jsonResponse,
  linkTo,
  mount,
  stubApi,
  submit,
  view,
  type Answer,
} from "./frontDoorHarness";

/**
 * Our own sign-in form: it posts the credentials with the
 * auth request Zitadel handed us, sends the browser to the URL the API
 * answers with, and renders each refusal as a state the user can act on. A
 * bare /login starts the request instead of showing a form it cannot finish.
 */

// Both are navigations jsdom cannot perform; only that they were asked for matters.
vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    // Faithful to the real one in the single respect this file tests: it
    // marks the guard before navigating. A bare vi.fn() would make the
    // loop test pass for the wrong reason.
    startLogin: vi.fn(() => actual.markLoginStarting()),
    completeLogin: vi.fn(),
  };
});

// The WebAuthn ceremony itself is the browser's; jsdom has none. The codec
// is tested in lib/webauthn.test.ts; here the prompt is scripted so what
// the page does around it can be seen.
vi.mock("../lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/webauthn")>();
  return {
    ...actual,
    passkeysSupported: vi.fn(() => true),
    getPasskey: vi.fn(async () => ({ id: "cred-1", rawId: "cred-1", type: "public-key" })),
  };
});

// A switch ends in a full navigation jsdom cannot perform.
vi.mock("../lib/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/accounts")>();
  return { ...actual, reloadAsSwitchedAccount: vi.fn() };
});

const WITH_REQUEST = `${LOGIN_PATH}?authRequest=V2_abc123`;
const DEVICE_RETURN = "/device?user_code=ABCD-2345";

function mountLogin(path: string): Promise<void> {
  return mount(path, { [LOGIN_PATH]: LoginPage });
}

/** The URLs fetched about the sign-in itself: the page's read of who else is signed in is not one. */
function signInCalls(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url !== "/api/accounts" && url !== "/api/auth-config");
}

/** What the real startLogin leaves behind when it was given a return. */
function rememberDeviceReturn(): void {
  sessionStorage.setItem("mw:login-return", `${Date.now()} ${DEVICE_RETURN}`);
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
  vi.mocked(completeLogin).mockClear();
  // The in-flight guard lives in sessionStorage so it survives the redirect
  // it exists to outlive (lib/auth.ts). jsdom keeps one store for the whole
  // file, so without this a test that starts a sign-in silently suppresses
  // the next test's.
  clearLoginStarting();
  sessionStorage.removeItem("mw:login-return");
  // The page remembers how this browser signed in last (lib/loginMemory.ts)
  // and opens on that method; one test's sign-in must not steer the next.
  localStorage.clear();
  sessionStorage.removeItem("mw:sso-error");
});

afterEach(cleanup);

describe("the login form", () => {
  it("labels both fields and links to forgot-password and signup", async () => {
    stubApi({});
    await mountLogin(WITH_REQUEST);
    for (const name of ["email", "password"]) {
      const input = view().querySelector<HTMLInputElement>(`input[name='${name}']`)!;
      expect(view().querySelector(`label[for='${input.id}']`)?.textContent, name).toBeTruthy();
    }
    expect(linkTo("/forgot")?.textContent).toBe("Forgot password?");
    expect(linkTo("/signup")?.textContent).toBe("Create account");
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("posts {email, password, auth_request} and sends the browser to the redirect", async () => {
    const fetchMock = stubApi({
      "/api/auth/password": jsonResponse({ redirect: "/api/auth/callback?code=xyz" }),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: " ada@example.com ", password: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledWith("/api/auth/callback?code=xyz");
    });
    const call = callTo(fetchMock, "/api/auth/password");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      email: "ada@example.com",
      password: "correct horse battery",
      auth_request: "V2_abc123",
    });
    expect(call.headers["Content-Type"]).toBe("application/json");
  });

  it("validates locally and sends nothing for an empty form", async () => {
    const fetchMock = stubApi({});
    await mountLogin(WITH_REQUEST);
    await submit();

    expect(alertText()).toContain("Enter your email address.");
    expect(alertText()).toContain("Enter your password.");
    expect(document.activeElement).toBe(view().querySelector("[role='alert']"));
    // Only the anonymous "who else is signed in here" read (lib/accounts.ts);
    // nothing about the form was sent.
    expect(signInCalls(fetchMock)).toEqual([]);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("shows the API's message on a 401 and stays on the form", async () => {
    stubApi({ "/api/auth/password": jsonResponse({ detail: "Wrong email or password." }, 401) });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "not the password" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("Wrong email or password.");
    });
    expect(view().querySelector("form")).not.toBeNull();
    expect(completeLogin).not.toHaveBeenCalled();
    expect(linkTo(`${VERIFY_PATH}?email=ada%40example.com`)).toBeNull();
  });

  it("offers the verify page, with the email, on a 403 for an unverified account", async () => {
    stubApi({
      "/api/auth/password": jsonResponse(
        { detail: "Verify your email address first.", status: "pending_verification" },
        403,
      ),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("Verify your email address first.");
    });
    const verify = linkTo(`${VERIFY_PATH}?email=ada%40example.com`);
    expect(verify?.textContent).toBe("Verify your email");
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("shows a suspended account's message without a verify link", async () => {
    stubApi({
      "/api/auth/password": jsonResponse({ detail: "This account is suspended." }, 403),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("This account is suspended.");
    });
    expect(view().querySelector(`a[href^='${VERIFY_PATH}']`)).toBeNull();
  });

  it("disables the submit button while the request is in flight", async () => {
    let settle: (value: Record<string, unknown>) => void = () => undefined;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    stubApi({ "/api/auth/password": pending });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(buttonNamed("Signing in…")?.disabled).toBe(true);
    });
    expect(view().querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    settle(jsonResponse({ redirect: "/api/auth/callback?code=xyz" }));
    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the password field and the way back", () => {
  it("shows and hides the password on request, without touching what was typed", async () => {
    stubApi({});
    await mountLogin(WITH_REQUEST);
    const password = view().querySelector<HTMLInputElement>("input[name='password']")!;
    expect(password.type).toBe("password");
    const toggle = buttonNamed("Show")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(password.id);
    fill({ password: "correct horse battery" });
    await click(toggle);
    expect(password.type).toBe("text");
    expect(password.value).toBe("correct horse battery");
    expect(buttonNamed("Hide")?.getAttribute("aria-pressed")).toBe("true");
    await click(buttonNamed("Hide")!);
    expect(password.type).toBe("password");
  });

  it("says 'Sign in to continue' when the front door remembered where the person was going", async () => {
    sessionStorage.setItem("mw:continue-to", `${Date.now()} /settings/billing`);
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(view().querySelector("h1")?.textContent).toBe("Sign in to continue");
    expect(view().textContent).toContain("taken on to the page you opened");
    sessionStorage.removeItem("mw:continue-to");
  });

  it("is plain 'Sign in' otherwise, and points at organisation SSO", async () => {
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(view().querySelector("h1")?.textContent).toBe("Sign in");
    expect(view().querySelector("[data-sso-hint]")?.textContent).toContain("Sign in with your organisation");
  });

  it("gives its links room to tap", async () => {
    stubApi({});
    await mountLogin(WITH_REQUEST);
    for (const href of ["/forgot", "/signup"]) {
      expect(linkTo(href)?.className, href).toContain("min-h-6");
    }
  });
});

describe("org SSO on the login form", () => {
  async function blurEmail(value: string): Promise<void> {
    const input = view().querySelector<HTMLInputElement>("input[name='email']")!;
    input.value = value;
    await act(async () => {
      // React 17+ subscribes to focusout for onBlur; a bare "blur" never reaches it.
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  }

  /** The provider buttons the lookup offers; the entry to the organisation form is not one. */
  function ssoButtons(): HTMLButtonElement[] {
    return [...view().querySelectorAll("button")].filter(
      (b) => b.textContent?.startsWith("Sign in with") && !b.hasAttribute("data-mw-org-entry"),
    );
  }

  it("asks the API after the email is typed and offers the org's provider", async () => {
    const fetchMock = stubApi({
      "/api/auth/idp?email=grace%40acme.com": jsonResponse({ provider: "okta", name: "Okta" }),
    });
    await mountLogin(WITH_REQUEST);
    await blurEmail(" grace@acme.com ");

    await vi.waitFor(() => {
      expect(buttonNamed("Sign in with Okta")).toBeDefined();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/idp?email=grace%40acme.com",
      expect.objectContaining({ credentials: "include" }),
    );
    // The password path is still there: SSO is an offer, not a gate.
    expect(view().querySelector("input[name='password']")).not.toBeNull();
    // The hint about SSO gives way to the button it was describing.
    expect(view().querySelector("[data-sso-hint]")).toBeNull();

    await click(buttonNamed("Sign in with Okta")!);
    await vi.waitFor(() => {
      // The typed address rides as the provider's login hint.
      expect(startLogin).toHaveBeenCalledWith(authConfig, "okta", undefined, "grace@acme.com");
    });
    expect(completeLogin).not.toHaveBeenCalled();
  });

  /**
   * Zitadel brought the browser back with only `?authRequest=`; the way
   * back to the device page is what the start remembered. Without it the
   * SSO restart would tell the API this is a fresh attempt, and the
   * person would land on "/" without their code.
   */
  it("carries the device page's way back through the SSO restart", async () => {
    stubApi({
      "/api/auth/idp?email=grace%40acme.com": jsonResponse({ provider: "okta", name: "Okta" }),
    });
    rememberDeviceReturn();
    await mountLogin(WITH_REQUEST);
    await blurEmail("grace@acme.com");
    await vi.waitFor(() => {
      expect(buttonNamed("Sign in with Okta")).toBeDefined();
    });
    await click(buttonNamed("Sign in with Okta")!);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, "okta", DEVICE_RETURN, "grace@acme.com");
    });
  });

  it("shows nothing for an address with no SSO, and asks nothing for a malformed one", async () => {
    const fetchMock = stubApi({
      "/api/auth/idp?email=ada%40example.com": jsonResponse({ detail: "No single sign-on." }, 404),
    });
    await mountLogin(WITH_REQUEST);
    await blurEmail("not-an-email");
    expect(signInCalls(fetchMock)).toEqual([]);

    await blurEmail("ada@example.com");
    await vi.waitFor(() => {
      expect(signInCalls(fetchMock)).toEqual(["/api/auth/idp?email=ada%40example.com"]);
    });
    expect(ssoButtons()).toEqual([]);
    expect(view().querySelector("[role='alert']")).toBeNull();
  });
});

describe("the way back to the device page", () => {
  it("rides the one retry on an expired auth request", async () => {
    stubApi({ "/api/auth/password": jsonResponse({ detail: "expired" }, 400) });
    rememberDeviceReturn();
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, undefined, DEVICE_RETURN);
    });
  });

  it("does not steer a fresh bare /login", async () => {
    stubApi({});
    rememberDeviceReturn();
    await mountLogin(LOGIN_PATH);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, undefined, undefined);
    });
  });
});

describe("/login without an auth request", () => {
  it("starts the OIDC request through startLogin and shows that it is starting", async () => {
    stubApi({});
    await mountLogin(LOGIN_PATH);

    expect(view().textContent).toContain("Starting sign-in…");
    expect(view().querySelector("form")).toBeNull();
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, undefined, undefined);
    });
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it("forwards the device page's way back to the login start", async () => {
    stubApi({});
    await mountLogin(`${LOGIN_PATH}?return=${encodeURIComponent("/device?user_code=ABCD-2345")}`);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, undefined, "/device?user_code=ABCD-2345");
    });
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  /**
   * The sign-in loop (the one that reads as "right password, back at the
   * front door").
   *
   * `/api/auth/login` mints a PKCE verifier, a state and a nonce into ONE
   * login-state cookie, and `/api/auth/callback` validates the redirect
   * against it. A second start overwrites that cookie, so the attempt
   * already in flight fails its state check, lands with no session, and
   * the front door renders /login again -- which starts another one.
   *
   * jsdom cannot navigate, so a real browser's "mount, redirect away,
   * come back" is reproduced by mounting the bare path twice. Before the
   * fix the second mount started a second dance; it must not.
   */
  it("does not start a second OIDC request while one is already in flight", async () => {
    stubApi({});
    await mountLogin(LOGIN_PATH);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledTimes(1);
    });

    // The browser is still on its way to the API. Anything that mounts
    // /login again in that window -- a re-render, the front door, a second
    // component asking -- must not mint a competing login state.
    cleanup();
    stubApi({});
    await mountLogin(LOGIN_PATH);

    expect(
      vi.mocked(startLogin).mock.calls.length,
      "a second start replaces the login-state cookie the first attempt needs",
    ).toBe(1);
  });

  /**
   * ...but the guard must not wedge the tab either. Arriving WITH an id
   * means the dance finished, so a later deliberate sign-in has to work.
   */
  it("releases the guard once the auth request has come back", async () => {
    stubApi({});
    await mountLogin(LOGIN_PATH);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledTimes(1);
    });

    // Zitadel bounced the browser back with an id: the dance completed.
    cleanup();
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(view().querySelector("form")).not.toBeNull();

    // A fresh bare /login after that is a new, deliberate attempt.
    cleanup();
    stubApi({});
    await mountLogin(LOGIN_PATH);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledTimes(2);
    });
  });
});

describe("the second step: an authenticator code", () => {
  const CHALLENGE = "sealed-challenge-1";

  async function reachCodeStep(answers: Record<string, Answer> = {}) {
    const fetchMock = stubApi({
      "/api/auth/password": jsonResponse({ status: "mfa_required", challenge: CHALLENGE }),
      ...answers,
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();
    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Enter your code");
    });
    return fetchMock;
  }

  it("replaces the form with the code step and names who is signing in", async () => {
    await reachCodeStep();
    expect(view().textContent).toContain("Signing in as ada@example.com");
    expect(view().querySelector("input[name='password']")).toBeNull();
    const code = view().querySelector<HTMLInputElement>("input[name='code']")!;
    expect(view().querySelector(`label[for='${code.id}']`)?.textContent).toBe(
      "Authenticator code",
    );
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("posts {challenge, code} and sends the browser to the redirect", async () => {
    const fetchMock = await reachCodeStep({
      "/api/auth/mfa": jsonResponse({ redirect: "/api/auth/callback?code=mfa" }),
    });
    fill({ code: "123 456" });
    await submit();
    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledWith("/api/auth/callback?code=mfa");
    });
    const call = callTo(fetchMock, "/api/auth/mfa");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ challenge: CHALLENGE, code: "123456" });
  });

  it("validates the code locally and posts nothing for a bad one", async () => {
    const fetchMock = await reachCodeStep();
    fill({ code: "12ab" });
    await submit();
    expect(alertText()).toContain("six digits");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/mfa")).toBe(false);
  });

  it("shows a wrong code's 401 and keeps the step for another try", async () => {
    await reachCodeStep({
      "/api/auth/mfa": jsonResponse({ detail: "That code is not right." }, 401),
    });
    fill({ code: "000000" });
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("That code is not right.");
    });
    expect(view().querySelector("input[name='code']")).not.toBeNull();
    expect(buttonNamed("Start again")).toBeUndefined();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("offers Start again on an expired challenge, which returns to the password form", async () => {
    await reachCodeStep({
      "/api/auth/mfa": jsonResponse({ detail: "This sign-in has expired; start again." }, 400),
    });
    fill({ code: "123456" });
    await submit();
    await vi.waitFor(() => {
      expect(buttonNamed("Start again")).toBeDefined();
    });
    await click(buttonNamed("Start again")!);
    expect(view().querySelector("input[name='password']")).not.toBeNull();
    expect(view().querySelector("h1")?.textContent).toBe("Sign in");
  });

  it("switches to a recovery code and posts {challenge, recovery_code}", async () => {
    const fetchMock = await reachCodeStep({
      "/api/auth/mfa": jsonResponse({ redirect: "/api/auth/callback?code=rec" }),
    });
    await click(buttonNamed("Use a recovery code instead")!);
    const code = view().querySelector<HTMLInputElement>("input[name='code']")!;
    expect(view().querySelector(`label[for='${code.id}']`)?.textContent).toBe("Recovery code");
    expect(view().textContent).toContain("Each code works once");
    fill({ code: " abcd-efgh-jkmn " });
    await submit();
    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledWith("/api/auth/callback?code=rec");
    });
    expect(callTo(fetchMock, "/api/auth/mfa").body).toEqual({
      challenge: CHALLENGE,
      recovery_code: "abcd-efgh-jkmn",
    });
  });
});

describe("the org-required interstitial: enrol, then the code step", () => {
  const CHALLENGE = "sealed-enrol-challenge";
  const PROVEN = "sealed-proven-challenge";
  const SECRET = "JBSWY3DPEHPK3PXP";
  const ENROLMENT = {
    secret: SECRET,
    uri: `otpauth://totp/MatterWave:ada%40example.com?secret=${SECRET}&issuer=MatterWave`,
    qr_svg: "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
  };
  const CODES = Array.from({ length: 10 }, (_, i) => `wxyz-wxyz-${String(i).padStart(4, "k")}`);

  it("explains the policy, runs the wizard against the challenge, then asks for a code", async () => {
    const fetchMock = stubApi({
      "/api/auth/password": jsonResponse({
        status: "mfa_enrolment_required",
        challenge: CHALLENGE,
      }),
      "/api/auth/mfa/enrol/start": jsonResponse(ENROLMENT),
      "/api/auth/mfa/enrol/confirm": jsonResponse({ recovery_codes: CODES, challenge: PROVEN }),
      "/api/auth/mfa": jsonResponse({ redirect: "/api/auth/callback?code=enrolled" }),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Set up two-factor authentication");
    });
    expect(view().textContent).toContain("Your organisation requires an authenticator app");
    await vi.waitFor(() => {
      expect(view().querySelector("img")?.getAttribute("src")).toBe(ENROLMENT.qr_svg);
    });
    expect(callTo(fetchMock, "/api/auth/mfa/enrol/start").body).toEqual({ challenge: CHALLENGE });
    expect(view().textContent).toContain(SECRET);

    fill({ code: "123456" });
    await submit();
    await vi.waitFor(() => {
      expect(view().querySelector("ol[aria-label='Recovery codes']")).not.toBeNull();
    });
    expect(callTo(fetchMock, "/api/auth/mfa/enrol/confirm").body).toEqual({
      challenge: CHALLENGE,
      code: "123456",
    });
    expect(
      [...view().querySelectorAll("ol[aria-label='Recovery codes'] li")].map((li) => li.textContent),
    ).toEqual(CODES);
    expect(completeLogin).not.toHaveBeenCalled();

    await click(buttonNamed("Continue to sign in")!);
    expect(view().querySelector("h1")?.textContent).toBe("Enter your code");
    fill({ code: "654321" });
    await submit();
    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledWith("/api/auth/callback?code=enrolled");
    });
    // The sign-in finishes with the challenge the confirm handed back,
    // not the enrolment one.
    expect(callTo(fetchMock, "/api/auth/mfa").body).toEqual({ challenge: PROVEN, code: "654321" });
  });

  it("shows the API's refusal when the registration cannot start", async () => {
    stubApi({
      "/api/auth/password": jsonResponse({
        status: "mfa_enrolment_required",
        challenge: CHALLENGE,
      }),
      "/api/auth/mfa/enrol/start": jsonResponse(
        { detail: "The identity provider is unavailable right now. Try again." },
        503,
      ),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("identity provider is unavailable");
    });
    expect(view().querySelector("input[name='code']")).toBeNull();
  });

  it("has a way out: back to the password, or sign in as someone else", async () => {
    stubApi({
      "/api/auth/password": jsonResponse({ status: "mfa_enrolment_required", challenge: CHALLENGE }),
      "/api/auth/mfa/enrol/start": jsonResponse(ENROLMENT),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com", password: "correct horse battery" });
    await submit();
    await vi.waitFor(() => {
      expect(view().querySelector("img")?.getAttribute("src")).toBe(ENROLMENT.qr_svg);
    });
    const other = [...view().querySelectorAll("a")].find((a) => a.textContent === "Sign in as someone else");
    expect(other?.getAttribute("href")).toBe("/login");
    await click(buttonNamed("Cancel")!);
    expect(view().querySelector("h1")?.textContent).toBe("Sign in");
    expect(view().querySelector("input[name='password']")).not.toBeNull();
  });
});


describe("sign in with your organisation: the explicit entry", () => {
  function orgEntry(): HTMLButtonElement {
    const button = view().querySelector<HTMLButtonElement>("[data-mw-org-entry]");
    expect(button, "the organisation entry").not.toBeNull();
    return button!;
  }

  it("opens a work-email form from the password form, and offers the way back", async () => {
    stubApi({});
    await mountLogin(WITH_REQUEST);
    await click(orgEntry());

    expect(view().querySelector("h1")?.textContent).toBe("Sign in with your organisation");
    expect(view().querySelector("input[name='work_email']")).not.toBeNull();
    expect(view().querySelector("input[name='password']")).toBeNull();
    await click(buttonNamed("Sign in with a password instead")!);
    expect(view().querySelector("input[name='password']")).not.toBeNull();
  });

  it("looks the domain up, leaves for the provider with the email as its hint, and remembers the method", async () => {
    stubApi({
      "/api/auth/idp?email=grace%40acme.com": jsonResponse({ provider: "okta", name: "Okta" }),
    });
    await mountLogin(WITH_REQUEST);
    await click(orgEntry());
    fill({ work_email: " grace@acme.com " });
    await submit();

    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig, "okta", undefined, "grace@acme.com");
    });
    expect(JSON.parse(localStorage.getItem("mw:login-method") ?? "{}")).toEqual({
      kind: "sso",
      email: "grace@acme.com",
      provider: "okta",
      providerName: "Okta",
    });
  });

  it("says when no single sign-on is set up for the domain, and offers the password", async () => {
    stubApi({
      "/api/auth/idp?email=grace%40nowhere.test": jsonResponse({ detail: "No SSO." }, 404),
    });
    await mountLogin(WITH_REQUEST);
    await click(orgEntry());
    fill({ work_email: "grace@nowhere.test" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("No single sign-on is set up for nowhere.test");
    });
    expect(startLogin).not.toHaveBeenCalled();
    expect(buttonNamed("Sign in with a password instead")).toBeDefined();
  });

  it("says the lookup could not be reached, as a different thing from not configured", async () => {
    stubApi({ "/api/auth/idp?email=grace%40acme.com": new TypeError("Failed to fetch") });
    await mountLogin(WITH_REQUEST);
    await click(orgEntry());
    fill({ work_email: "grace@acme.com" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("could not be reached");
    });
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("validates the work email before asking anyone", async () => {
    const fetchMock = stubApi({});
    await mountLogin(WITH_REQUEST);
    await click(orgEntry());
    fill({ work_email: "not an email" });
    await submit();
    expect(alertText()).toContain("Enter an email address like");
    expect(signInCalls(fetchMock)).toEqual([]);
  });

  it("opens on the organisation form when that is how this browser signed in last", async () => {
    rememberLoginMethod({ kind: "sso", email: "grace@acme.com", provider: "okta", providerName: "Okta" });
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(view().querySelector("h1")?.textContent).toBe("Sign in with your organisation");
    expect(view().querySelector<HTMLInputElement>("input[name='work_email']")?.value).toBe(
      "grace@acme.com",
    );
    expect(view().querySelector("[data-mw-last-method]")?.textContent).toContain("Okta");
    expect(buttonNamed("Continue with Okta")).toBeDefined();
  });

  it("shows the callback's refusal once: the provider failing, or vouching for another domain", async () => {
    sessionStorage.setItem(
      "mw:sso-error",
      JSON.stringify({ reason: "mismatch", detail: "bob@other.com" }),
    );
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(alertText()).toContain("signed in bob@other.com");
    expect(sessionStorage.getItem("mw:sso-error")).toBeNull();
  });

  it("keeps the callback's reason across the restart a bare /login makes", async () => {
    stubApi({});
    await mountLogin(`${LOGIN_PATH}?sso_error=idp&sso_detail=access_denied`);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalled();
    });
    expect(JSON.parse(sessionStorage.getItem("mw:sso-error") ?? "{}")).toEqual({
      reason: "idp",
      detail: "access_denied",
    });
  });
});

describe("use a passkey", () => {
  beforeEach(() => {
    vi.mocked(passkeysSupported).mockReturnValue(true);
    vi.mocked(getPasskey).mockClear();
    vi.mocked(reloadAsSwitchedAccount).mockClear();
  });

  it("asks the API for this address, runs the prompt, posts the assertion with the sealed challenge, and leaves", async () => {
    const fetchMock = stubApi({
      "/api/auth/passkey/start": jsonResponse({
        challenge: "sealed-pk",
        options: { publicKey: { challenge: "AQ", rpId: "localhost" } },
      }),
      "/api/auth/passkey/finish": jsonResponse({ redirect: "/api/auth/callback?code=pk" }),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com" });
    await click(buttonNamed("Use a passkey")!);

    await vi.waitFor(() => {
      expect(completeLogin).toHaveBeenCalledWith("/api/auth/callback?code=pk");
    });
    expect(callTo(fetchMock, "/api/auth/passkey/start").body).toEqual({
      email: "ada@example.com",
      auth_request: "V2_abc123",
    });
    expect(getPasskey).toHaveBeenCalledWith({ publicKey: { challenge: "AQ", rpId: "localhost" } });
    expect(callTo(fetchMock, "/api/auth/passkey/finish").body).toEqual({
      challenge: "sealed-pk",
      credential: { id: "cred-1", rawId: "cred-1", type: "public-key" },
    });
    expect(JSON.parse(localStorage.getItem("mw:login-method") ?? "{}")).toEqual({
      kind: "passkey",
      email: "ada@example.com",
    });
  });

  it("needs the email first, and says so on the field rather than prompting for nothing", async () => {
    const fetchMock = stubApi({});
    await mountLogin(WITH_REQUEST);
    await click(buttonNamed("Use a passkey")!);
    expect(alertText()).toContain("Enter your email, then use your passkey.");
    expect(signInCalls(fetchMock)).toEqual([]);
    expect(getPasskey).not.toHaveBeenCalled();
  });

  it("shows the API's no-passkey answer and keeps the password form", async () => {
    stubApi({
      "/api/auth/passkey/start": jsonResponse(
        { detail: "No passkey is registered for this address.", status: "no_passkey" },
        404,
      ),
    });
    await mountLogin(WITH_REQUEST);
    fill({ email: "ada@example.com" });
    await click(buttonNamed("Use a passkey")!);
    await vi.waitFor(() => {
      expect(alertText()).toContain("No passkey is registered");
    });
    expect(view().querySelector("input[name='password']")).not.toBeNull();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("is not offered on a browser without WebAuthn", async () => {
    vi.mocked(passkeysSupported).mockReturnValue(false);
    stubApi({});
    await mountLogin(WITH_REQUEST);
    expect(buttonNamed("Use a passkey")).toBeUndefined();
  });
});

describe("continue as an account already signed in on this browser", () => {
  const PARKED = {
    accounts: [
      {
        slot: 1,
        current: false,
        subject: "ada",
        email: "ada@acme.com",
        name: "Ada",
        org_name: "Acme",
      },
    ],
    max: 4,
    room: true,
  };

  it("offers each parked account as one click, which switches and reloads", async () => {
    const fetchMock = stubApi({
      "/api/accounts": jsonResponse(PARKED),
      "/api/accounts/switch": jsonResponse({ status: "ok", subject: "ada", email: "ada@acme.com" }),
    });
    await mountLogin(WITH_REQUEST);
    await vi.waitFor(() => {
      expect(buttonNamed("Continue as ada@acme.com")).toBeDefined();
    });
    expect(view().querySelector("[data-mw-parked-accounts]")?.textContent).toContain("Acme");
    await click(buttonNamed("Continue as ada@acme.com")!);
    await vi.waitFor(() => {
      expect(reloadAsSwitchedAccount).toHaveBeenCalled();
    });
    expect(callTo(fetchMock, "/api/accounts/switch").body).toEqual({ slot: 1 });
    // The password form is still there: a parked account is an offer.
    expect(view().querySelector("input[name='password']")).not.toBeNull();
  });

  it("says when the parked account is gone, and drops it", async () => {
    stubApi({
      "/api/accounts": jsonResponse(PARKED),
      "/api/accounts/switch": jsonResponse({ detail: "That account is no longer signed in." }, 404),
    });
    await mountLogin(WITH_REQUEST);
    await vi.waitFor(() => {
      expect(buttonNamed("Continue as ada@acme.com")).toBeDefined();
    });
    await click(buttonNamed("Continue as ada@acme.com")!);
    await vi.waitFor(() => {
      expect(alertText()).toContain("no longer signed in");
    });
    expect(buttonNamed("Continue as ada@acme.com")).toBeUndefined();
    expect(reloadAsSwitchedAccount).not.toHaveBeenCalled();
  });
});
