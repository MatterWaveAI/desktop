import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLoginStarting, startLogin } from "../lib/auth";
import { desktopReload } from "../lib/desktopAuth";
import { LoginPage } from "./LoginPage";
import { LOGIN_PATH } from "./frontDoor";
import { alertText, buttonNamed, cleanup, click, mount, stubApi, view } from "./frontDoorHarness";

/**
 * /login inside the desktop shell. The browser flow (`startLogin`, which
 * navigates to the API's login route) must never start there: the webview
 * has no cookie jar for the callback to fill. The native side signs in
 * through the system browser instead, and the page reloads once it has.
 */

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, startLogin: vi.fn(), completeLogin: vi.fn() };
});

// jsdom cannot navigate; only that the reload was asked for matters.
vi.mock("../lib/desktopAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/desktopAuth")>();
  return { ...actual, desktopReload: vi.fn() };
});

type Handler = (cmd: string, args?: Record<string, unknown>) => unknown;

const FAR = Math.floor(Date.now() / 1000) + 3600;

/**
 * One bridge for the whole file, with the handler swapped per test:
 * desktopAuth resolves `invoke` once and keeps it, so a fresh mock per test
 * would leave the page talking to the previous test's.
 */
let handler: Handler = () => null;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => handler(cmd, args));

function fakeTauri(next: Handler) {
  handler = next;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

function calls(mock: typeof invoke): string[] {
  return mock.mock.calls.map(([cmd]) => String(cmd));
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
  vi.mocked(desktopReload).mockClear();
  invoke.mockClear();
  clearLoginStarting();
});

afterEach(() => {
  cleanup();
  handler = () => null;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("/login in the desktop shell", () => {
  it("offers the native sign-in and never starts the browser redirect", async () => {
    const invoke = fakeTauri(() => null);
    stubApi({});
    await mount(LOGIN_PATH, { [LOGIN_PATH]: LoginPage });

    expect(buttonNamed("Sign in with your browser")).toBeDefined();
    expect(view().querySelector("form")).toBeNull();
    expect(view().textContent).not.toContain("Starting sign-in…");
    expect(startLogin).not.toHaveBeenCalled();
    // Nothing opens a browser until the person asks.
    expect(calls(invoke)).not.toContain("sign_in");
  });

  it("asks the native side to sign in, then reloads into Boot", async () => {
    const invoke = fakeTauri((cmd) => {
      if (cmd === "sign_in") return undefined;
      if (cmd === "get_access_token") return { access_token: "tok-1", expires_at: FAR };
      throw new Error(cmd);
    });
    stubApi({});
    await mount(LOGIN_PATH, { [LOGIN_PATH]: LoginPage });

    await click(buttonNamed("Sign in with your browser")!);
    await vi.waitFor(() => {
      expect(desktopReload).toHaveBeenCalledTimes(1);
    });
    expect(calls(invoke)).toContain("sign_in");
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("shows why a sign-in failed and lets the person try again", async () => {
    let attempts = 0;
    fakeTauri((cmd) => {
      if (cmd === "sign_in") {
        attempts += 1;
        if (attempts === 1) throw new Error("sign-in timed out");
        return undefined;
      }
      return null;
    });
    stubApi({});
    await mount(LOGIN_PATH, { [LOGIN_PATH]: LoginPage });

    await click(buttonNamed("Sign in with your browser")!);
    await vi.waitFor(() => {
      expect(alertText()).toContain("sign-in timed out");
    });
    expect(desktopReload).not.toHaveBeenCalled();

    await click(buttonNamed("Sign in with your browser")!);
    await vi.waitFor(() => {
      expect(desktopReload).toHaveBeenCalledTimes(1);
    });
    expect(attempts).toBe(2);
  });
});

describe("/login with an auth request, in the desktop shell", () => {
  it("still offers the native sign-in: the headless form belongs to the browser flow", async () => {
    fakeTauri(() => null);
    stubApi({});
    await mount(`${LOGIN_PATH}?authRequest=V2_abc123`, { [LOGIN_PATH]: LoginPage });

    expect(view().querySelector("input[name='password']")).toBeNull();
    expect(buttonNamed("Sign in with your browser")).toBeDefined();
  });
});
