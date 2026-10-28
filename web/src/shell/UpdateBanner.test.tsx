import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The update banner against a fake bridge: the offer the launch check left
 * behind shows the button, the progress events become the line's text, a
 * failed install comes back as an error beside the still-standing offer,
 * and a browser mounts nothing at all.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (cmd: string, args?: Record<string, unknown>) => unknown;

interface Registration {
  event: string;
  cb: (event: unknown) => void;
}

/** The bridge, plus the callback registry the event plugin needs. */
function fakeBridge(handler: Handler) {
  const callbacks = new Map<number, (event: unknown) => void>();
  let nextCallbackId = 0;
  const registrations = new Map<number, Registration>();
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "plugin:event|listen") {
      const cb = callbacks.get(args?.handler as number);
      if (cb) registrations.set(args?.handler as number, { event: args?.event as string, cb });
      return 1;
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
      for (const { event: name, cb } of registrations.values()) {
        if (name === event) cb({ event: name, id: 1, payload });
      }
    },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

// The desktopAuth module's first bridge route tries to import the Tauri API
// package, which is deliberately absent, and the failed resolution costs a
// real tick -- more than `settle`'s microtask flush. Paying it once here,
// before any test mounts anything, keeps every later attempt inside that
// flush. The variable specifier plus @vite-ignore is what keeps vite's
// import analysis from failing the file on the missing package (the same
// trick desktopAuth.ts uses).
const tauriCore = "@tauri-apps/api/core";
await import(/* @vite-ignore */ tauriCore).catch(() => {});

async function mountBanner(): Promise<HTMLElement> {
  // The module holds state (the invoke cache); a fresh copy per test.
  vi.resetModules();
  const { UpdateBanner } = await import("./UpdateBanner");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<UpdateBanner />);
  });
  await settle();
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/**
 * Wait until the banner shows a state the microtask flush alone may not have
 * reached, then assert the condition held.
 */
async function untilBanner(meets: (scope: HTMLElement) => boolean): Promise<void> {
  for (let i = 0; i < 200 && !meets(container!); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(meets(container!)).toBe(true);
}

function installButton(scope: HTMLElement): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>("[data-mw-update-install]");
  if (!button) throw new Error("no install button");
  return button;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("UpdateBanner", () => {
  it("mounts nothing in a browser, where no updater exists", async () => {
    await mountBanner();
    expect(container!.querySelector("[data-mw-update-banner]")).toBeNull();
  });

  it("offers the update the launch check found and installs it with progress", async () => {
    // A successful install_update never resolves: the process is gone. The
    // progress and finished events arrive around it, from the native side.
    const bridge = fakeBridge((cmd) => {
      if (cmd === "pending_update") return "0.3.0";
      if (cmd === "install_update") return new Promise(() => {});
      return undefined;
    });
    await mountBanner();
    await untilBanner(
      (scope) => scope.querySelector("[data-mw-update-banner]") !== null,
    );

    const banner = container!.querySelector("[data-mw-update-banner]");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("0.3.0");
    expect(banner!.textContent).toContain("is available");

    await act(async () => {
      installButton(container!).click();
    });
    await settle();
    expect(bridge.invoke).toHaveBeenCalledWith("install_update", undefined);
    expect(container!.textContent).toContain("Downloading 0.3.0");

    await act(async () => {
      bridge.fire("update-download-progress", { downloaded: 2048, total: 4096 });
    });
    expect(container!.textContent).toContain("50%");
    await act(async () => {
      bridge.fire("update-download-progress", { downloaded: 3072, total: 4096 });
    });
    expect(container!.textContent).toContain("75%");
    await act(async () => {
      bridge.fire("update-download-finished", null);
    });
    expect(container!.textContent).toContain("restarts when it is done");
  });

  it("shows an update announced only by event, after the banner mounted", async () => {
    const bridge = fakeBridge(() => undefined);
    await mountBanner();
    expect(container!.querySelector("[data-mw-update-banner]")).toBeNull();

    await act(async () => {
      bridge.fire("update-available", "0.4.0");
    });
    expect(container!.querySelector("[data-mw-update-banner]")?.textContent).toContain("0.4.0");
    expect(installButton(container!)).toBeDefined();
  });

  it("shows why an install failed and keeps the offer standing", async () => {
    fakeBridge((cmd) => {
      if (cmd === "pending_update") return "0.3.0";
      if (cmd === "install_update") throw new Error("install failed: no space left");
      return undefined;
    });
    await mountBanner();
    await untilBanner((scope) => scope.querySelector("[data-mw-update-install]") !== null);

    await act(async () => {
      installButton(container!).click();
    });
    await settle();

    const alert = container!.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("install failed");
    expect(installButton(container!)).toBeDefined();
  });

  it("shows a refused install as the native side worded it", async () => {
    fakeBridge((cmd) => {
      if (cmd === "pending_update") return "0.3.0";
      if (cmd === "install_update") throw new Error("updates are disabled in this build");
      return undefined;
    });
    await mountBanner();
    await untilBanner((scope) => scope.querySelector("[data-mw-update-install]") !== null);
    await act(async () => {
      installButton(container!).click();
    });
    await settle();
    expect(container!.querySelector("[role='alert']")?.textContent).toContain(
      "updates are disabled",
    );
  });
});
