import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLogin } from "../lib/auth";
import { VerifyPage } from "./VerifyPage";
import { VERIFY_PATH } from "./frontDoor";
import {
  alertText,
  authConfig,
  buttonNamed,
  callTo,
  cleanup,
  click,
  fill,
  jsonResponse,
  mount,
  stubApi,
  submit,
  view,
} from "./frontDoorHarness";

/**
 * The verification code: prefilled address, a six-character
 * code, a verified state whose way onward is sign-in, a wrong code shown on
 * the field, and a resend that says it was sent.
 */

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, startLogin: vi.fn() };
});

function mountVerify(path = `${VERIFY_PATH}?email=ada%40example.com`): Promise<void> {
  return mount(path, { [VERIFY_PATH]: VerifyPage });
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
});

afterEach(cleanup);

describe("the verify form", () => {
  it("prefills the email from the query, editable, and takes a one-time code", async () => {
    stubApi({});
    await mountVerify();
    const email = view().querySelector<HTMLInputElement>("input[name='email']")!;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(false);
    const code = view().querySelector<HTMLInputElement>("input[name='code']")!;
    // text, not numeric: Zitadel's codes carry letters (8UK58K), and a
    // numeric keyboard hides them on a phone.
    expect(code.getAttribute("inputmode")).toBe("text");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(view().querySelector(`label[for='${code.id}']`)?.textContent).toBeTruthy();
  });

  it("starts empty without a query", async () => {
    stubApi({});
    await mountVerify(VERIFY_PATH);
    expect(view().querySelector<HTMLInputElement>("input[name='email']")?.value).toBe("");
  });

  it("wants a six-character code before it posts anything", async () => {
    const fetchMock = stubApi({});
    await mountVerify();
    fill({ code: "12345" });
    await submit();
    expect(alertText()).toContain("The code is the six characters from the email.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts {email, code} and shows the verified state with a Sign in button on a 200", async () => {
    const fetchMock = stubApi({ "/api/signup/verify": jsonResponse({ status: "active" }) });
    await mountVerify();
    fill({ code: " 123456 " });
    await submit();

    await vi.waitFor(() => {
      expect(view().textContent).toContain("Your email is verified");
    });
    expect(callTo(fetchMock, "/api/signup/verify").body).toEqual({
      email: "ada@example.com",
      code: "123456",
    });
    expect(view().querySelector("form")).toBeNull();
    const signIn = buttonNamed("Sign in");
    expect(signIn).toBeDefined();
    await click(signIn!);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig);
    });
  });

  it("shows a wrong code's 400 on the code field", async () => {
    stubApi({ "/api/signup/verify": jsonResponse({ detail: "That code is wrong or expired." }, 400) });
    await mountVerify();
    fill({ code: "000000" });
    await submit();

    await vi.waitFor(() => {
      expect(alertText()).toContain("That code is wrong or expired.");
    });
    const code = view().querySelector<HTMLInputElement>("input[name='code']")!;
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(code.getAttribute("aria-describedby")!)?.textContent).toBe(
      "That code is wrong or expired.",
    );
    // Still on the form, code kept for a correction.
    expect(view().querySelector("form")).not.toBeNull();
    expect(buttonNamed("Sign in")).toBeUndefined();
  });

  it("resends the code to the address in the form and says so", async () => {
    const fetchMock = stubApi({ "/api/signup/resend": jsonResponse({}, 202) });
    await mountVerify();
    fill({ email: "grace@example.com" });
    await click(buttonNamed("Resend code")!);

    await vi.waitFor(() => {
      expect(view().querySelector("[aria-live='polite']")?.textContent).toContain("Sent");
    });
    expect(callTo(fetchMock, "/api/signup/resend").body).toEqual({ email: "grace@example.com" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("/api/signup/verify");
  });

  it("will not resend to a malformed address", async () => {
    const fetchMock = stubApi({});
    await mountVerify(VERIFY_PATH);
    fill({ email: "nope" });
    await click(buttonNamed("Resend code")!);
    expect(alertText()).toContain("name@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
