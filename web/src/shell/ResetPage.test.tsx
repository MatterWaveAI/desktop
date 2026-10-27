import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLogin } from "../lib/auth";
import { ResetPage } from "./ResetPage";
import { RESET_PATH } from "./frontDoor";
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
 * The reset form: prefilled address, code, a new password
 * held to the same rule as signup, a done state whose way onward is sign-in,
 * and a bad code shown on the field.
 */

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, startLogin: vi.fn() };
});

function mountReset(): Promise<void> {
  return mount(`${RESET_PATH}?email=ada%40example.com`, { [RESET_PATH]: ResetPage });
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
});

afterEach(cleanup);

describe("the reset form", () => {
  it("prefills the email and holds the new password to the signup rule", async () => {
    const fetchMock = stubApi({});
    await mountReset();
    expect(view().querySelector<HTMLInputElement>("input[name='email']")?.value).toBe(
      "ada@example.com",
    );
    fill({ code: "123456", password: "short", password_confirm: "other" });
    await submit();
    expect(alertText()).toContain("Use 12 characters or more for your password.");
    expect(alertText()).toContain("The passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the contract's body and shows the done state with Sign in on a 200", async () => {
    const fetchMock = stubApi({ "/api/auth/reset": jsonResponse({}) });
    await mountReset();
    fill({ code: "123456", password: "correct horse battery", password_confirm: "correct horse battery" });
    await submit();

    await vi.waitFor(() => {
      expect(view().textContent).toContain("Your password is changed");
    });
    expect(callTo(fetchMock, "/api/auth/reset").body).toEqual({
      email: "ada@example.com",
      code: "123456",
      password: "correct horse battery",
      password_confirm: "correct horse battery",
    });
    expect(view().querySelector("form")).toBeNull();
    await click(buttonNamed("Sign in")!);
    await vi.waitFor(() => {
      expect(startLogin).toHaveBeenCalledWith(authConfig);
    });
  });

  it("shows a bad code's 400 on the code field", async () => {
    stubApi({ "/api/auth/reset": jsonResponse({ detail: "That code is wrong or expired." }, 400) });
    await mountReset();
    fill({ code: "000000", password: "correct horse battery", password_confirm: "correct horse battery" });
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("That code is wrong or expired.");
    });
    expect(view().querySelector("input[name='code']")?.getAttribute("aria-invalid")).toBe("true");
    expect(view().querySelector("form")).not.toBeNull();
  });
});
