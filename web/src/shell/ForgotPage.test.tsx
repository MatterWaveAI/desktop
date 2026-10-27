import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgotPage } from "./ForgotPage";
import { FORGOT_PATH, RESET_PATH } from "./frontDoor";
import {
  alertText,
  buttonNamed,
  callTo,
  cleanup,
  fill,
  jsonResponse,
  linkTo,
  mount,
  stubApi,
  submit,
  view,
} from "./frontDoorHarness";

/**
 * Forgot password: one field, one post, and a done state that
 * does not say whether the address is registered - the API's 202 never does.
 */

function mountForgot(): Promise<void> {
  return mount(FORGOT_PATH, { [FORGOT_PATH]: ForgotPage });
}

afterEach(cleanup);

describe("the forgot-password form", () => {
  it("checks the address before posting", async () => {
    const fetchMock = stubApi({});
    await mountForgot();
    fill({ email: "nope" });
    await submit();
    expect(alertText()).toContain("name@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts {email} and always shows the sent state, linking to /reset with the email", async () => {
    const fetchMock = stubApi({ "/api/auth/forgot": jsonResponse({}, 202) });
    await mountForgot();
    fill({ email: " nobody@example.com " });
    await submit();

    await vi.waitFor(() => {
      expect(view().textContent).toContain(
        "If an account exists for that address, a code is on its way",
      );
    });
    expect(callTo(fetchMock, "/api/auth/forgot").body).toEqual({ email: "nobody@example.com" });
    expect(view().querySelector("form")).toBeNull();
    expect(linkTo(`${RESET_PATH}?email=nobody%40example.com`)).not.toBeNull();
  });

  it("offers a retry when the request never reaches the API", async () => {
    stubApi({ "/api/auth/forgot": new TypeError("Failed to fetch") });
    await mountForgot();
    fill({ email: "ada@example.com" });
    await submit();
    await vi.waitFor(() => {
      expect(alertText()).toContain("Could not reach MatterWave");
    });
    expect(buttonNamed("Retry")).toBeDefined();
    expect(view().querySelector("form")).not.toBeNull();
  });
});
