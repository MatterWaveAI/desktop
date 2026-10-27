import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLogin } from "../lib/auth";
import { SignupPage } from "./SignupPage";
import { VerifyPage } from "./VerifyPage";
import { SIGNUP_PATH, VERIFY_PATH } from "./frontDoor";
import {
  alertText,
  authConfig,
  buttonNamed,
  callTo,
  cleanup,
  click,
  currentLocation,
  fill,
  jsonResponse,
  linkTo,
  mount,
  stubApi,
  submit,
  view,
} from "./frontDoorHarness";

/**
 * The browser half of registration: the form validates every
 * rule before it talks to the API, posts the contract's body to /api/signup,
 * moves on to /verify with the address on a 202, and renders each answer
 * the API can give as a state the user can act on.
 */

// Sign-in is a navigation jsdom cannot perform; only that it was asked for matters.
vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, startLogin: vi.fn() };
});

const VALID = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  password: "correct horse battery",
  password_confirm: "correct horse battery",
  accept_terms: true,
};

function mountSignup(): Promise<void> {
  return mount(SIGNUP_PATH, { [SIGNUP_PATH]: SignupPage, [VERIFY_PATH]: VerifyPage });
}

/**
 * Type into a field the way a person does: the value changes and React
 * hears about it. Through the prototype's setter, not the element's: React
 * instruments the element's so it can tell its own writes from the
 * browser's, and a value set through it reads as already known.
 */
async function type(name: string, value: string): Promise<void> {
  const input = view().querySelector<HTMLInputElement>(`input[name='${name}']`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
});

afterEach(cleanup);

describe("the signup form", () => {
  it("labels every field, marks the phone optional, and links the terms", async () => {
    stubApi({});
    await mountSignup();
    for (const name of Object.keys(VALID)) {
      const input = view().querySelector<HTMLInputElement>(`input[name='${name}']`)!;
      const label =
        view().querySelector(`label[for='${input.id}']`) ?? input.closest("label");
      expect(label?.textContent, name).toBeTruthy();
    }
    const phone = view().querySelector<HTMLInputElement>("input[name='phone']")!;
    expect(phone.type).toBe("tel");
    expect(phone.required).toBe(false);
    expect(view().querySelector("label[for='" + phone.id + "']")?.textContent).toContain("optional");
    const terms = view().querySelector<HTMLInputElement>("input[name='accept_terms']")!;
    expect(terms.type).toBe("checkbox");
    expect(terms.closest("label")?.textContent).toBe(
      "I accept the Terms of Service and Privacy Policy",
    );
    expect(linkTo("/terms")?.textContent).toBe("Terms of Service");
    expect(linkTo("/privacy")?.textContent).toBe("Privacy Policy");
    // The rule is stated before it is broken, and described-by the field.
    const password = view().querySelector<HTMLInputElement>("input[name='password']")!;
    const hint = document.getElementById(password.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe("At least 12 characters.");
  });

  it("asks for the email first, then the name, then the password", async () => {
    stubApi({});
    await mountSignup();
    const names = [...view().querySelectorAll("input")].map((input) => input.name);
    expect(names).toEqual([
      "email",
      "first_name",
      "last_name",
      "password",
      "password_confirm",
      "phone",
      "accept_terms",
    ]);
    expect(view().textContent).toContain("Start with your email");
  });

  it("reads the password's strength as it is typed, and offers to show it", async () => {
    stubApi({});
    await mountSignup();
    expect(view().querySelector("[data-password-strength]")).toBeNull();
    await type("password", "short");
    expect(view().querySelector("[data-password-strength]")?.getAttribute("data-password-strength")).toBe("1");
    expect(view().textContent).toContain("Weak");
    // The rule is under the field once; the meter does not say it again.
    expect(view().textContent?.match(/12 characters/g)).toHaveLength(1);
    expect(view().textContent).not.toContain("Use 12 characters or more.");
    await type("password", "Correct horse battery 9!");
    expect(view().querySelector("[data-password-strength]")?.getAttribute("data-password-strength")).toBe("4");
    expect(view().textContent).toContain("Strong");
    // Two fields, two switches, each its own.
    const toggles = [...view().querySelectorAll("button")].filter((b) => b.textContent === "Show");
    expect(toggles).toHaveLength(2);
    await click(toggles[0]);
    expect(view().querySelector<HTMLInputElement>("input[name='password']")!.type).toBe("text");
    expect(view().querySelector<HTMLInputElement>("input[name='password_confirm']")!.type).toBe("password");
  });

  it("says the passwords do not match as soon as both are typed, and stops saying so when they do", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    await type("password", "correct horse battery");
    await type("password_confirm", "correct horse batter");
    const confirm = view().querySelector<HTMLInputElement>("input[name='password_confirm']")!;
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    const described = confirm.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain("The passwords do not match.");
    // Before any submit: no summary alert, nothing sent.
    expect(view().querySelector("[role='alert']")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await type("password_confirm", "correct horse battery");
    expect(confirm.getAttribute("aria-invalid")).toBeNull();
    expect(view().textContent).not.toContain("The passwords do not match.");
  });

  it("gives the terms box and the links room to tap", async () => {
    stubApi({});
    await mountSignup();
    const terms = view().querySelector<HTMLInputElement>("input[name='accept_terms']")!;
    expect(terms.className).toContain("size-5");
    expect(terms.closest("label")?.className).toContain("min-h-6");
    expect(linkTo("/terms")?.className).toContain("min-h-6");
    expect(buttonNamed("Already have an account? Sign in")?.className).toContain("min-h-6");
  });

  it("requires every field but the phone, and sends nothing", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    await submit();

    const text = alertText();
    expect(text).toContain("Enter your first name.");
    expect(text).toContain("Enter your last name.");
    expect(text).toContain("Enter your email address.");
    expect(text).toContain("Enter a password.");
    expect(text).toContain("Enter your password again.");
    expect(text).toContain("Accept the terms to continue.");
    expect(text).not.toContain("phone");
    expect(document.activeElement).toBe(view().querySelector("[role='alert']"));
    for (const name of ["first_name", "last_name", "email", "password", "accept_terms"]) {
      expect(
        view().querySelector(`input[name='${name}']`)?.getAttribute("aria-invalid"),
        name,
      ).toBe("true");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what the phone is for, and checks it has a country code before sending", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    const phone = view().querySelector<HTMLInputElement>("input[name='phone']")!;
    const hint = document.getElementById(phone.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toContain("Optional.");
    fill({ ...VALID, phone: "555-0100" });
    await submit();
    expect(alertText()).toContain("country code");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("/api/signup");
  });

  it("opens the terms in a new tab, so following them keeps what was typed", async () => {
    stubApi({});
    await mountSignup();
    for (const path of ["/terms", "/privacy"]) {
      expect(linkTo(path)?.getAttribute("target"), path).toBe("_blank");
      expect(linkTo(path)?.getAttribute("rel"), path).toContain("noopener");
    }
  });

  it("checks the email's shape", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    fill({ ...VALID, email: "not-an-email" });
    await submit();
    expect(alertText()).toContain("name@example.com");
    expect(alertText()).not.toContain("first name");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires twelve characters of password, and says so", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    fill({ ...VALID, password: "short one", password_confirm: "short one" });
    await submit();
    expect(alertText()).toContain("Use 12 characters or more for your password.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the confirmation to match", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    fill({ ...VALID, password_confirm: "correct horse batteries" });
    await submit();
    expect(alertText()).toContain("The passwords do not match.");
    expect(alertText()).not.toContain("Use 12 characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the terms to be accepted", async () => {
    const fetchMock = stubApi({});
    await mountSignup();
    fill({ ...VALID, accept_terms: false });
    await submit();
    expect(alertText()).toContain("Accept the terms to continue.");
    expect(view().querySelector("input[name='accept_terms']")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the contract's body to /api/signup and moves on to /verify with the email", async () => {
    const fetchMock = stubApi({
      "/api/signup": jsonResponse({ status: "pending_verification", email: "ada@example.com" }, 202),
    });
    await mountSignup();
    fill({ ...VALID, email: "  ada@example.com ", phone: " +1 555 0100 " });
    await submit();

    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(VERIFY_PATH);
    });
    expect(currentLocation().search).toEqual({ email: "ada@example.com" });
    // The verify page took the address from the query.
    await vi.waitFor(() => {
      expect(view().querySelector<HTMLInputElement>("input[name='email']")?.value).toBe(
        "ada@example.com",
      );
    });
    expect(view().querySelector("input[name='code']")).not.toBeNull();

    const call = callTo(fetchMock, "/api/signup");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      password: "correct horse battery",
      password_confirm: "correct horse battery",
      phone: "+1 555 0100",
      accept_terms: true,
    });
    expect(call.headers["Content-Type"]).toBe("application/json");
    // The CSRF cookie is issued by /api/auth-config; it was fetched before the post.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.indexOf("/api/auth-config")).toBeLessThan(urls.indexOf("/api/signup"));
  });

  it("leaves the phone out of the body when it is blank", async () => {
    const fetchMock = stubApi({
      "/api/signup": jsonResponse({ status: "pending_verification", email: "ada@example.com" }, 202),
    });
    await mountSignup();
    fill(VALID);
    await submit();
    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(VERIFY_PATH);
    });
    expect(callTo(fetchMock, "/api/signup").body).not.toHaveProperty("phone");
  });

  it("shows the API's message and a sign-in action on a 409", async () => {
    stubApi({
      "/api/signup": jsonResponse({ detail: "An account already exists for this address." }, 409),
    });
    await mountSignup();
    fill(VALID);
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("An account already exists for this address.");
    });
    expect(document.activeElement).toBe(view().querySelector("[role='alert']"));
    expect(buttonNamed("Retry")).toBeUndefined();
    const signIn = buttonNamed("Sign in instead");
    expect(signIn).toBeDefined();
    await click(signIn!);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig);
    });
    expect(currentLocation().pathname).toBe(SIGNUP_PATH);
  });

  it("puts a 422's items on the fields they name", async () => {
    stubApi({
      "/api/signup": jsonResponse(
        {
          detail: [
            { loc: ["body", "phone"], msg: "Enter a phone number with a country code." },
            { loc: ["body", "password"], msg: "This password is too common." },
          ],
        },
        422,
      ),
    });
    await mountSignup();
    // Passes the page's own shape check; the API is still the last word.
    fill({ ...VALID, phone: "+1 406 555 0100" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("Enter a phone number with a country code.");
    });
    expect(alertText()).toContain("This password is too common.");
    const phone = view().querySelector<HTMLInputElement>("input[name='phone']")!;
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    // Described by the format hint AND the error, in that order.
    const described = phone
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      "Optional. With the country code, like +1 406 555 0100.",
      "Enter a phone number with a country code.",
    ]);
    expect(view().querySelector("input[name='email']")?.getAttribute("aria-invalid")).toBeNull();
  });

  it("summarises a 422 that names no field", async () => {
    stubApi({
      "/api/signup": jsonResponse({ detail: [{ loc: ["body"], msg: "Something is off." }] }, 422),
    });
    await mountSignup();
    fill(VALID);
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("Something is off.");
    });
    expect(buttonNamed("Retry")).toBeDefined();
  });

  it("shows the detail with a Retry on a 503", async () => {
    stubApi({ "/api/signup": jsonResponse({ detail: "Signup is temporarily unavailable." }, 503) });
    await mountSignup();
    fill(VALID);
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("Signup is temporarily unavailable.");
    });
    expect(buttonNamed("Retry")).toBeDefined();
    expect(buttonNamed("Sign in instead")).toBeUndefined();
    // The form is still there with its values, for the retry to resubmit.
    expect(view().querySelector<HTMLInputElement>("input[name='email']")?.value).toBe(
      "ada@example.com",
    );
  });

  it("says something generic when the request never reaches the API", async () => {
    stubApi({ "/api/signup": new TypeError("Failed to fetch") });
    await mountSignup();
    fill(VALID);
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("Could not reach MatterWave");
    });
    expect(buttonNamed("Retry")).toBeDefined();
  });

  it("disables the submit button while the request is in flight", async () => {
    let settle: (value: Record<string, unknown>) => void = () => undefined;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    stubApi({ "/api/signup": pending });
    await mountSignup();
    fill(VALID);
    await submit();

    await vi.waitFor(() => {
      expect(buttonNamed("Creating account…")?.disabled).toBe(true);
    });
    expect(view().querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    settle(jsonResponse({ status: "pending_verification", email: "ada@example.com" }, 202));
    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(VERIFY_PATH);
    });
  });
});
