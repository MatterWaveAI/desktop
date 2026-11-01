import { afterEach, describe, expect, it, vi } from "vitest";
import { apps } from "../apps/registry";

/**
 * Links opened from outside the app, under a fake bridge: the native side
 * holds one request (`take_navigation`) and announces it as `navigate`.
 */

type Target = Record<string, unknown> | null;

function fakeBridge(initial: Target) {
  let pending: Target = initial;
  const callbacks = new Map<number, (event: unknown) => void>();
  const listeners: { event: string; cb: (event: unknown) => void }[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "take_navigation") {
      const taken = pending;
      pending = null;
      return taken;
    }
    if (cmd === "plugin:event|listen") {
      const cb = callbacks.get(args?.handler as number);
      if (cb) listeners.push({ event: args?.event as string, cb });
      return listeners.length;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (event: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
  };
  return {
    invoke,
    /** The native side's `navigation::request`: keep it, announce it. */
    request(target: Target) {
      pending = target;
      for (const l of listeners) if (l.event === "navigate") l.cb({ event: "navigate", id: 1, payload: null });
    },
    listening: () => listeners.some((l) => l.event === "navigate"),
  };
}

async function load() {
  vi.resetModules();
  return import("./desktopNavigation");
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("hrefFor", () => {
  it("opens a conversation in the chat app, at a message when one is named", async () => {
    const { hrefFor } = await load();
    expect(hrefFor({ kind: "conversation", id: "c_1-a" })).toBe("/apps/chat?c=c_1-a");
    expect(hrefFor({ kind: "conversation", id: "c1", message: "m7" })).toBe("/apps/chat?c=c1&m=m7");
  });

  it("opens a share at its page", async () => {
    const { hrefFor } = await load();
    expect(hrefFor({ kind: "share", token: "Zx9_-k" })).toBe("/share/Zx9_-k");
  });

  it("brings the return from Stripe to the billing settings", async () => {
    const { hrefFor } = await load();
    expect(hrefFor({ kind: "billing" })).toBe("/settings/billing");
  });

  it("routes the menu's New chat and Settings", async () => {
    const { hrefFor } = await load();
    expect(hrefFor({ kind: "new-chat" })).toBe("/apps/chat");
    expect(hrefFor({ kind: "settings" })).toBe("/settings");
  });

  it("refuses ids that would be read as more than an id", async () => {
    const { hrefFor } = await load();
    expect(hrefFor({ kind: "conversation", id: "c1&x=1" })).toBeNull();
    expect(hrefFor({ kind: "conversation", id: "" })).toBeNull();
    expect(hrefFor({ kind: "conversation", id: "c1", message: "../m" })).toBe("/apps/chat?c=c1");
    expect(hrefFor({ kind: "share", token: "../../settings" })).toBeNull();
    expect(hrefFor({ kind: "elsewhere" } as never)).toBeNull();
    expect(hrefFor(null)).toBeNull();
  });

  it("uses the chat app's own route", async () => {
    const { CHAT_PATH } = await load();
    expect(apps.find((app) => app.id === "chat")?.path).toBe(CHAT_PATH);
  });
});

describe("desktopRecentConversations", () => {
  it("hands the tray the first three live conversations, ids and titles only", async () => {
    const { desktopRecentConversations } = await load();
    const list = [
      { id: "a1", title: "One", updated_at: "x" },
      { id: "a2", title: "Archived", archived_at: "2026-10-01T00:00:00Z" },
      { id: "a3", title: "Two" },
      { id: "bad id", title: "skipped" },
      { id: "a4", title: "Three" },
      { id: "a5", title: "Four" },
    ];
    expect(JSON.parse(desktopRecentConversations(list))).toEqual([
      { id: "a1", title: "One" },
      { id: "a3", title: "Two" },
      { id: "a4", title: "Three" },
    ]);
    expect(desktopRecentConversations(list)).toBe(desktopRecentConversations([...list]));
  });
});

describe("installDesktopNavigation", () => {
  it("opens the link that launched the app once the page is up", async () => {
    fakeBridge({ kind: "conversation", id: "c1" });
    const { installDesktopNavigation } = await load();
    const navigate = vi.fn();
    installDesktopNavigation(navigate);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/apps/chat?c=c1"));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("opens each later link exactly once", async () => {
    const bridge = fakeBridge(null);
    const { installDesktopNavigation } = await load();
    const navigate = vi.fn();
    installDesktopNavigation(navigate);
    await vi.waitFor(() => expect(bridge.listening()).toBe(true));

    bridge.request({ kind: "share", token: "t1" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/share/t1"));
    bridge.request({ kind: "conversation", id: "c2", message: "m1" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/apps/chat?c=c2&m=m1"));
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("hands a conversation to the signed-in shell, and everything else to the router", async () => {
    const bridge = fakeBridge(null);
    const { installDesktopNavigation, registerDesktopShell } = await load();
    const navigate = vi.fn();
    const openConversation = vi.fn();
    const startNewChat = vi.fn();
    const unregister = registerDesktopShell({ openConversation, startNewChat });
    installDesktopNavigation(navigate);
    await vi.waitFor(() => expect(bridge.listening()).toBe(true));

    bridge.request({ kind: "conversation", id: "c3", message: "m2" });
    await vi.waitFor(() => expect(openConversation).toHaveBeenCalledWith("c3", "m2"));
    bridge.request({ kind: "share", token: "t2" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/share/t2"));
    bridge.request({ kind: "new-chat" });
    await vi.waitFor(() => expect(startNewChat).toHaveBeenCalledOnce());
    bridge.request({ kind: "settings" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings"));

    // Signed out again: the route is the way in, for the front door to keep.
    unregister();
    bridge.request({ kind: "conversation", id: "c4" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/apps/chat?c=c4"));
    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  it("ignores a target it cannot route", async () => {
    const bridge = fakeBridge({ kind: "conversation", id: "c1/../../x" });
    const { installDesktopNavigation } = await load();
    const navigate = vi.fn();
    installDesktopNavigation(navigate);
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("take_navigation", undefined));
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does nothing in a browser", async () => {
    const { installDesktopNavigation } = await load();
    const navigate = vi.fn();
    installDesktopNavigation(navigate);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });
});
