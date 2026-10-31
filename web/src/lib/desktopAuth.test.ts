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

/**
 * The bridge the events go through: the same internals plus the
 * `transformCallback` the event plugin registers handlers with. `fire`
 * delivers to every listener registered for an event, the way the native
 * side delivers one payload to many subscribers.
 */
function fakeTauriWithEvents(handler: Handler) {
  const callbacks = new Map<number, (event: unknown) => void>();
  let nextCallbackId = 0;
  const registrations = new Map<number, { event: string; cb: (event: unknown) => void }>();
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "plugin:event|listen") {
      const id = 100 + registrations.size;
      const cb = callbacks.get(args?.handler as number);
      if (cb) registrations.set(id, { event: args?.event as string, cb });
      return id;
    }
    if (cmd === "plugin:event|unlisten") {
      registrations.delete(args?.id as number);
      return null;
    }
    return handler(cmd, args);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (event: unknown) => void) => {
      const id = ++nextCallbackId;
      callbacks.set(id, cb);
      return id;
    },
  };
  return {
    invoke,
    fire(event: string, payload: unknown) {
      for (const { event: name, cb } of [...registrations.values()]) {
        if (name === event) cb({ event: name, id: 1, payload });
      }
    },
    listenerCount(event: string) {
      return [...registrations.values()].filter((r) => r.event === event).length;
    },
  };
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

describe("the API key path", () => {
  it("stores what was pasted and pulls the token again", async () => {
    const invoke = fakeTauri((cmd, args) => {
      if (cmd === "app_info") return { version: "1", api_base_url: null };
      if (cmd === "api_key_state") return { configured: false, hint: null };
      if (cmd === "set_api_key") {
        return { configured: true, hint: "mw_ab12cd34\u2026" };
      }
      if (cmd === "get_access_token") {
        return args?.key
          ? { access_token: args.key, expires_at: Number.MAX_SAFE_INTEGER }
          : null;
      }
      throw new Error(cmd);
    });
    const { desktop } = await load();

    const state = await desktop.desktopSetApiKey("  mw_ab12cd34_secret  ");
    expect(state).toEqual({ configured: true, hint: "mw_ab12cd34\u2026" });
    expect(invoke).toHaveBeenCalledWith("set_api_key", { key: "mw_ab12cd34_secret" });
  });

  it("removes the key and asks whether one is stored", async () => {
    let hasKey = true;
    const invoke = fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1", api_base_url: null };
      if (cmd === "api_key_state")
        return hasKey ? { configured: true, hint: "mw_ab12cd34\u2026" } : { configured: false, hint: null };
      if (cmd === "clear_api_key") {
        hasKey = false;
        return null;
      }
      if (cmd === "get_access_token") return null;
      throw new Error(cmd);
    });
    const { desktop } = await load();
    await desktop.installDesktopAuth();

    await expect(desktop.desktopApiKeyState()).resolves.toEqual({
      configured: true,
      hint: "mw_ab12cd34\u2026",
    });
    await desktop.desktopClearApiKey();
    expect(invoke).toHaveBeenCalledWith("clear_api_key", undefined);
    await expect(desktop.desktopApiKeyState()).resolves.toEqual({
      configured: false,
      hint: null,
    });
  });
});

describe("watchUpdates", () => {
  it("delivers the updater's events to the handlers", async () => {
    const bridge = fakeTauriWithEvents(() => null);
    const { desktop } = await load();
    const seen: string[] = [];
    const progress: unknown[] = [];
    let finished = 0;

    const unlisten = desktop.watchUpdates({
      onAvailable: (version) => seen.push(version),
      onProgress: (p) => progress.push(p),
      onDownloadFinished: () => {
        finished += 1;
      },
    });
    await vi.waitFor(() => {
      expect(bridge.listenerCount("update-available")).toBe(1);
    });

    bridge.fire("update-available", "1.3.0");
    bridge.fire("update-download-progress", { downloaded: 1024, total: 4096 });
    bridge.fire("update-download-finished", null);
    expect(seen).toEqual(["1.3.0"]);
    expect(progress).toEqual([{ downloaded: 1024, total: 4096 }]);
    expect(finished).toBe(1);

    unlisten();
    await vi.waitFor(() => {
      expect(bridge.listenerCount("update-available")).toBe(0);
    });
    bridge.fire("update-available", "1.4.0");
    expect(seen).toEqual(["1.3.0"]);
  });

  it("delivers the stage announcements to their handler", async () => {
    const bridge = fakeTauriWithEvents(() => null);
    const { desktop } = await load();
    const stages: string[] = [];

    const unlisten = desktop.watchUpdates({ onStage: (stage) => stages.push(stage) });
    await vi.waitFor(() => {
      expect(bridge.listenerCount("update-stage")).toBe(1);
    });

    bridge.fire("update-stage", "checking");
    bridge.fire("update-stage", "downloading");
    bridge.fire("update-stage", "verified");
    bridge.fire("update-stage", "installing");
    expect(stages).toEqual(["checking", "downloading", "verified", "installing"]);

    unlisten();
    await vi.waitFor(() => {
      expect(bridge.listenerCount("update-stage")).toBe(0);
    });
  });

  it("unlistens cleanly even when cancelled before registration lands", async () => {
    const bridge = fakeTauriWithEvents(() => null);
    const { desktop } = await load();

    const unlisten = desktop.watchUpdates({ onAvailable: () => {} });
    unlisten();
    await flushBridge();
    expect(bridge.listenerCount("update-available")).toBe(0);

    async function flushBridge() {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
  });

  it("is a no-op in a browser, where no events can arrive", async () => {
    const { desktop } = await load();
    let called = false;
    const unlisten = desktop.watchUpdates({ onAvailable: () => (called = true) });
    expect(unlisten()).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("the update install", () => {
  it("asks the version of the last check and runs the install command", async () => {
    const invoke = fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1", api_base_url: null };
      if (cmd === "pending_update") return "1.3.0";
      if (cmd === "install_update") return undefined;
      throw new Error(cmd);
    });
    const { desktop } = await load();

    await expect(desktop.desktopPendingUpdate()).resolves.toBe("1.3.0");
    await desktop.desktopInstallUpdate();
    expect(invoke).toHaveBeenCalledWith("install_update", undefined);
  });
});

describe("the device pairing", () => {
  const PAIRED = {
    paired: true,
    name: "David's laptop",
    hint: "mw_ab12cd34\u2026",
    device_id: "0192b1c4-7a3e-7d10-9a51-3f6c2e8b4d99",
    paired_at: 1769000000,
  };

  it("reads the state, redeems a code and unpairs through the bridge", async () => {
    let paired = false;
    const invoke = fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1", api_base_url: "https://api.example.test" };
      if (cmd === "device_pairing_state") {
        return paired ? PAIRED : { paired: false, name: null, hint: null, device_id: null, paired_at: null };
      }
      if (cmd === "pair_device") {
        paired = true;
        return PAIRED;
      }
      if (cmd === "unpair_device") {
        paired = false;
        return { paired: false, name: null, hint: null, device_id: null, paired_at: null };
      }
      throw new Error(cmd);
    });
    const { desktop } = await load();

    await expect(desktop.desktopDevicePairing()).resolves.toMatchObject({ paired: false });
    await expect(desktop.desktopPairDevice(" abcd-efgh-jkmn ")).resolves.toEqual(PAIRED);
    // What the person typed goes up as `code`; trimming is deliberate, so a
    // trailing newline in a paste never reaches the redeem route.
    expect(invoke).toHaveBeenCalledWith("pair_device", { code: "abcd-efgh-jkmn" });
    await expect(desktop.desktopUnpairDevice()).resolves.toMatchObject({ paired: false });
    expect(invoke).toHaveBeenCalledWith("unpair_device", undefined);
  });

  it("surfaces the bridge's refusal", async () => {
    fakeTauri((cmd) => {
      if (cmd === "app_info") return { version: "1", api_base_url: null };
      if (cmd === "pair_device") {
        throw "That pairing code is not valid, or it has expired. Make a new one.";
      }
      throw new Error(cmd);
    });
    const { desktop } = await load();
    await expect(desktop.desktopPairDevice("ZZZZ-ZZZZ-ZZZZ")).rejects.toContain("expired");
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
