import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop bearer path under a fake Tauri bridge. The module holds state
 * (the cached token, the wrapped fetch), so each test loads fresh copies of it
 * and of api.ts, whose token getter it installs.
 */

type Handler = (cmd: string, args?: Record<string, unknown>) => unknown;

const FAR = Math.floor(Date.now() / 1000) + 3600;

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function load() {
  vi.resetModules();
  const api = await import("./api");
  const desktop = await import("./desktopAuth");
  return { api, desktop };
}

function fakeTauri(handler: Handler) {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => handler(cmd, args));
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

function authOf(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get("Authorization");
}

let realFetch: typeof window.fetch;

beforeEach(() => {
  realFetch = window.fetch;
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.fetch = realFetch;
  vi.unstubAllGlobals();
});

describe("in the desktop shell", () => {
  it("installs the getter and sends the bearer on apiFetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({ subject: "u1" }));
    vi.stubGlobal("fetch", fetchMock);
    fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1.2.3", api_base_url: "https://api.example.test" };
      if (cmd === "get_access_token") return { access_token: "tok-1", expires_at: FAR };
      throw new Error(cmd);
    });
    const { api, desktop } = await load();

    expect(desktop.installDesktopAuth()).toBe(true);
    await api.apiFetch("/api/me");
    expect(api.currentToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authOf(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
    // jsdom is not the bundled origin, so the path stays same-origin (the
    // `tauri dev` case, where Vite's proxy serves /api).
    expect(fetchMock.mock.calls[0][0]).toBe("/api/me");
  });

  it("retries a 401 once with a forced refresh", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const invoke = fakeTauri((cmd, args) => {
      if (cmd === "app_info") return { version: "1.2.3", api_base_url: null };
      if (cmd === "get_access_token") {
        return { access_token: args?.force ? "tok-2" : "tok-1", expires_at: FAR };
      }
      throw new Error(cmd);
    });
    const { api, desktop } = await load();
    desktop.installDesktopAuth();

    await api.apiFetch("/api/conversations");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
    expect(authOf(fetchMock.mock.calls[1])).toBe("Bearer tok-2");
    expect(invoke).toHaveBeenCalledWith("get_access_token", { force: true });
  });

  it("sends nothing when the native side is signed out", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    fakeTauri((cmd) => (cmd === "app_info" ? { version: "1", api_base_url: null } : null));
    const { api, desktop } = await load();
    desktop.installDesktopAuth();

    await expect(api.apiFetch("/api/me")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authOf(fetchMock.mock.calls[0])).toBeNull();
  });
});

describe("where the bearer goes", () => {
  function shell() {
    fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1", api_base_url: "https://api.example.test" };
      if (cmd === "get_access_token") return { access_token: "tok-1", expires_at: FAR };
      throw new Error(cmd);
    });
  }

  it("never adds it to a request for another origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    shell();
    const { desktop } = await load();
    desktop.installDesktopAuth();
    await desktop.desktopReady();

    await window.fetch("https://elsewhere.example/api/me");
    await window.fetch("//elsewhere.example/api/me");
    await window.fetch(new URL("https://elsewhere.example/api/me"));
    await window.fetch(new Request("https://elsewhere.example/api/me"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) expect(authOf(call)).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("https://elsewhere.example/api/me");
    expect(fetchMock.mock.calls[1][0]).toBe("//elsewhere.example/api/me");
  });

  it("rewrites only API paths to the API base from the bundled origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { protocol: "http:", hostname: "tauri.localhost" });
    shell();
    const { desktop } = await load();
    desktop.installDesktopAuth();
    await desktop.desktopReady();

    await window.fetch("/api/me", { credentials: "include" });
    await window.fetch("/assets/logo.svg");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/api/me");
    expect(authOf(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("omit");
    expect(fetchMock.mock.calls[1][0]).toBe("/assets/logo.svg");
    expect(authOf(fetchMock.mock.calls[1])).toBeNull();
  });
});

describe("in a browser", () => {
  it("installs nothing and leaves fetch alone", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { api, desktop } = await load();

    expect(desktop.isDesktop()).toBe(false);
    expect(desktop.installDesktopAuth()).toBe(false);
    expect(window.fetch).toBe(fetchMock);
    await api.apiFetch("/api/me");
    expect(api.currentToken()).toBeNull();
    expect(authOf(fetchMock.mock.calls[0])).toBeNull();
  });
});
