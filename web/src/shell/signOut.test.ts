import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../types";

/**
 * The shell's sign-out picks the path by where it runs: the BFF's logout and
 * Zitadel's end_session in a browser, the native `sign_out` and a reload in
 * the desktop shell -- never the IdP redirect there, which would strand the
 * webview on Zitadel.
 */

const CONFIG: AuthConfig = {
  auth_mode: "oidc",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
  client_id: "web-1",
  end_session_endpoint: "https://auth.example.test/oidc/v1/end_session",
};

async function load() {
  vi.resetModules();
  const desktop = await import("../lib/desktopAuth");
  const { shellSignOut } = await import("./signOut");
  return { desktop, shellSignOut };
}

function fakeTauri() {
  const invoke = vi.fn(async () => null);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

let realFetch: typeof window.fetch;

beforeEach(() => {
  realFetch = window.fetch;
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.fetch = realFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shellSignOut in the desktop shell", () => {
  it("revokes through the native side and reloads, without the browser's logout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { protocol: "http:", hostname: "tauri.localhost", replace: assign, assign });
    const invoke = fakeTauri();
    const { shellSignOut } = await load();

    await shellSignOut(CONFIG);

    expect(invoke).toHaveBeenCalledWith("sign_out", undefined);
    expect(assign).toHaveBeenCalledWith("/");
    // No /api/logout and no end_session: neither applies to a keychain session.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shellSignOut in a browser", () => {
  it("posts /api/logout and sends the browser to end_session", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "https://app.example.test", assign, replace: vi.fn() });
    const { desktop, shellSignOut } = await load();
    expect(desktop.isDesktop()).toBe(false);

    await shellSignOut(CONFIG);

    expect(fetchMock).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
    expect(assign).toHaveBeenCalledTimes(1);
    const sent = new URL(String(assign.mock.calls[0][0]));
    expect(sent.origin + sent.pathname).toBe(CONFIG.end_session_endpoint);
    expect(sent.searchParams.get("client_id")).toBe("web-1");
    expect(sent.searchParams.get("post_logout_redirect_uri")).toBe("https://app.example.test/");
  });
});
