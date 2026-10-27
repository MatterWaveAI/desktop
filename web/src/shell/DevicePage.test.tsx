import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../types";
import { DevicePage } from "./DevicePage";
import { DEVICE_PATH, LOGIN_PATH, isAnonymousPath } from "./frontDoor";
import { ShellContext, type ShellContextValue } from "./shellContext";
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
  mount,
  stubApi,
  submit,
  view,
  type Answer,
} from "./frontDoorHarness";

/**
 * Device login's approval page: a signed-out visitor is sent to sign in
 * with the way back; a signed-in person sees which client asked, then
 * approves or denies; a code the API does not know goes back on the field.
 */

const LOOKUP = { user_code: "ABCD-2345", client_name: "matterwave-tui", expires_in: 540 };

function shellValue(): ShellContextValue {
  const principal: Principal = {
    subject: "eve",
    kind: "user",
    email: "eve@acme.com",
    name: null,
    roles: [],
    org_id: "org-a",
    org_name: null,
    org_role: "member",
  };
  return {
    authConfig,
    principal,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: vi.fn(async () => {}),
  };
}

function mountSignedIn(path: string): Promise<void> {
  const shell = shellValue();
  const Page = () => (
    <ShellContext.Provider value={shell}>
      <DevicePage />
    </ShellContext.Provider>
  );
  return mount(path, { [DEVICE_PATH]: Page });
}

function stubDevice(lookup: Answer, extra: Record<string, Answer> = {}) {
  return stubApi({ "/api/auth/device/lookup": lookup, ...extra });
}

afterEach(cleanup);

describe("a signed-out visitor", () => {
  it("opens on the front door and is sent to sign in with the way back", async () => {
    expect(isAnonymousPath(DEVICE_PATH)).toBe(true);
    const fetchMock = stubDevice(jsonResponse(LOOKUP));
    const Login = () => <h1>Login</h1>;
    await mount(`${DEVICE_PATH}?user_code=ABCD-2345`, {
      [DEVICE_PATH]: DevicePage,
      [LOGIN_PATH]: Login,
    });
    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(LOGIN_PATH);
    });
    expect(currentLocation().search).toEqual({ return: "/device?user_code=ABCD-2345" });
    // Nothing is looked up or decided without a session.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/auth/device/lookup",
    );
  });
});

describe("a signed-in person", () => {
  it("sees which client asked and approves it", async () => {
    const fetchMock = stubDevice(jsonResponse(LOOKUP), {
      "/api/auth/device/approve": jsonResponse({ status: "approved", client_name: "matterwave-tui" }),
    });
    await mountSignedIn(`${DEVICE_PATH}?user_code=ABCD-2345`);
    await vi.waitFor(() => {
      expect(buttonNamed("Approve")).toBeDefined();
    });
    expect(callTo(fetchMock, "/api/auth/device/lookup").body).toEqual({ user_code: "ABCD-2345" });
    expect(view().textContent).toContain("matterwave-tui wants to sign in to MatterWave as eve@acme.com");
    expect(view().textContent).toContain("ABCD-2345");
    // The key's name, prefilled from the client's own and editable.
    const name = view().querySelector<HTMLInputElement>("input[name='name']")!;
    expect(name.value).toBe("matterwave-tui");
    expect(view().querySelector(`label[for='${name.id}']`)?.textContent).toBe("Key name (optional)");
    // Inside the shell, which already carries the brand: no second one here.
    expect(view().querySelector("[data-slot=wordmark]")).toBeNull();
    // The shell's own buttons, not the front door's.
    expect(buttonNamed("Approve")?.dataset.slot).toBe("button");
    expect(buttonNamed("Deny")?.dataset.slot).toBe("button");

    await submit();
    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Device approved");
    });
    const approve = callTo(fetchMock, "/api/auth/device/approve");
    expect(approve.method).toBe("POST");
    expect(approve.body).toEqual({ user_code: "ABCD-2345", name: "matterwave-tui" });
    expect(view().textContent).toContain("revoke in Settings");
  });

  it("sends the name the person typed, and none when the field is cleared", async () => {
    const fetchMock = stubDevice(jsonResponse(LOOKUP), {
      "/api/auth/device/approve": jsonResponse({ status: "approved", client_name: "matterwave-tui" }),
    });
    await mountSignedIn(`${DEVICE_PATH}?user_code=ABCD-2345`);
    await vi.waitFor(() => {
      expect(buttonNamed("Approve")).toBeDefined();
    });
    fill({ name: "  work laptop  " });
    await submit();
    await vi.waitFor(() => {
      expect(callTo(fetchMock, "/api/auth/device/approve").body).toEqual({
        user_code: "ABCD-2345",
        name: "work laptop",
      });
    });

    cleanup();
    const bare = stubDevice(jsonResponse({ ...LOOKUP, client_name: null }), {
      "/api/auth/device/approve": jsonResponse({ status: "approved", client_name: null }),
    });
    await mountSignedIn(`${DEVICE_PATH}?user_code=ABCD-2345`);
    await vi.waitFor(() => {
      expect(buttonNamed("Approve")).toBeDefined();
    });
    expect(view().querySelector<HTMLInputElement>("input[name='name']")!.value).toBe("");
    await submit();
    await vi.waitFor(() => {
      // The API names the key after the code when nobody names it.
      expect(callTo(bare, "/api/auth/device/approve").body).toEqual({ user_code: "ABCD-2345" });
    });
  });

  it("denies it", async () => {
    const fetchMock = stubDevice(jsonResponse(LOOKUP), {
      "/api/auth/device/deny": jsonResponse({ status: "denied", client_name: "matterwave-tui" }),
    });
    await mountSignedIn(`${DEVICE_PATH}?user_code=ABCD-2345`);
    await vi.waitFor(() => {
      expect(buttonNamed("Deny")).toBeDefined();
    });
    await click(buttonNamed("Deny")!);
    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Device denied");
    });
    expect(callTo(fetchMock, "/api/auth/device/deny").body).toEqual({ user_code: "ABCD-2345" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/auth/device/approve",
    );
  });

  it("types the code when the link carried none", async () => {
    const fetchMock = stubDevice(jsonResponse({ ...LOOKUP, client_name: null }));
    await mountSignedIn(DEVICE_PATH);
    expect(view().querySelector("form")).not.toBeNull();
    fill({ user_code: "abcd2345" });
    await submit();
    await vi.waitFor(() => {
      expect(buttonNamed("Approve")).toBeDefined();
    });
    expect(callTo(fetchMock, "/api/auth/device/lookup").body).toEqual({ user_code: "abcd2345" });
    expect(view().textContent).toContain("A device wants to sign in");
  });

  it("checks the shape before asking the API", async () => {
    const fetchMock = stubDevice(jsonResponse(LOOKUP));
    await mountSignedIn(DEVICE_PATH);
    fill({ user_code: "123" });
    await submit();
    expect(view().textContent).toContain("eight characters");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/auth/device/lookup",
    );
  });

  it("puts an unknown or expired code back on the field", async () => {
    const detail = "That code is not valid, or it has expired. Start again on the device.";
    stubDevice(jsonResponse({ detail }, 404));
    await mountSignedIn(`${DEVICE_PATH}?user_code=ZZZZ-ZZZZ`);
    await vi.waitFor(() => {
      expect(view().textContent).toContain(detail);
    });
    const input = view().querySelector<HTMLInputElement>("input[name='user_code']")!;
    expect(input.value).toBe("ZZZZ-ZZZZ");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(buttonNamed("Approve")).toBeUndefined();
  });

  it("shows a refused approval and keeps the choice", async () => {
    const detail = "API keys are not included in your plan.";
    stubDevice(jsonResponse(LOOKUP), {
      "/api/auth/device/approve": jsonResponse({ detail }, 403),
    });
    await mountSignedIn(`${DEVICE_PATH}?user_code=ABCD-2345`);
    await vi.waitFor(() => {
      expect(buttonNamed("Approve")).toBeDefined();
    });
    await submit();
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain(detail);
    expect(buttonNamed("Deny")).toBeDefined();
  });
});
