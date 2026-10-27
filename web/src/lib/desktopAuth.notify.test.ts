import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The reply-ready notification: in the desktop shell the native command is
 * invoked with the fixed copy and nothing from the reply, and in a browser
 * there is no native side and nothing happens at all. The module holds no
 * state that matters here, but it is loaded fresh like its sibling tests.
 */

async function load() {
  vi.resetModules();
  return import("./desktopAuth");
}

function fakeTauri() {
  const invoke = vi.fn(async () => null);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("notifyGenerationComplete", () => {
  it("invokes the native command with fixed copy in the desktop shell", async () => {
    const invoke = fakeTauri();
    const { notifyGenerationComplete } = await load();

    notifyGenerationComplete();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("notify_generation_complete", {
      title: "MatterWave",
      body: "Your reply is ready.",
    });
  });

  it("does nothing in a browser", async () => {
    const invoke = vi.fn(async () => null);
    const { notifyGenerationComplete } = await load();

    notifyGenerationComplete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows a bridge failure: a notification is never an error path", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("no bridge");
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    const { notifyGenerationComplete } = await load();

    expect(() => notifyGenerationComplete()).not.toThrow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  });
});
