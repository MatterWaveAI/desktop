import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopPane } from "./DesktopPane";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  type Mounted,
} from "./paneHarness";

/**
 * The desktop diagnostics pane: the prove-it surface for the seams that
 * cannot be checked from code alone. Registered only behind
 * `desktopDevEnabled` (desktopDev.test.ts), so these tests mock the bridge
 * the way the webview would answer.
 */

const desktop = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  desktopAppInfo: vi.fn<() => Promise<{ version: string; api_base_url: string | null } | null>>(
    async () => ({ version: "0.2.2", api_base_url: "https://app.example.test" }),
  ),
  desktopSendTestNotification: vi.fn<() => Promise<boolean>>(async () => true),
  desktopCheckForUpdates: vi.fn<() => Promise<string | null>>(async () => null),
  watchUpdates: vi.fn<
    (handlers?: { onStage?: (stage: string) => void }) => () => void
  >(() => () => {}),
}));

vi.mock("../../../lib/desktopAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/desktopAuth")>();
  return { ...actual, ...desktop };
});

vi.mock("../../../lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/webauthn")>();
  return { ...actual, passkeysSupported: vi.fn(() => false) };
});

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  desktop.desktopSendTestNotification.mockResolvedValue(true);
  desktop.desktopCheckForUpdates.mockResolvedValue(null);
});

async function openPane(): Promise<HTMLElement> {
  mounted = await mount(<DesktopPane />, principalWith(["user"]));
  await flush();
  return mounted.container;
}

describe("the desktop diagnostics pane", () => {
  it("reads the capability flags and the app info", async () => {
    const container = await openPane();
    const dl = container.querySelector("dl[aria-label='Capability flags']")!;
    expect(dl.textContent).toContain("Desktop shellyes");
    expect(dl.textContent).toContain("Passkeys offeredno");
    // The gating's own why, so the pane is a readout and not a verdict.
    expect(dl.textContent).toContain("not the rpId passkeys are made for");
    expect(dl.textContent).toContain("Dictation enginenone");
    await flush();
    expect(dl.textContent).toContain("0.2.2");
    expect(dl.textContent).toContain("https://app.example.test");
    expect(desktop.desktopAppInfo).toHaveBeenCalled();
  });

  it("sends a test notification and reports what the OS did", async () => {
    const container = await openPane();
    click(buttonNamed(container, "Send a test notification"));
    await flush();
    expect(desktop.desktopSendTestNotification).toHaveBeenCalled();
    expect(container.textContent).toContain("Shown. Look for it in the OS notification area.");
  });

  it("shows an OS refusal as the failure it is", async () => {
    desktop.desktopSendTestNotification.mockRejectedValue("notifications are disabled for this app");
    const container = await openPane();
    click(buttonNamed(container, "Send a test notification"));
    await flush();
    expect(container.textContent).toContain("notifications are disabled for this app");
  });

  it("logs the updater's stages as they arrive", async () => {
    let stage: ((s: string) => void) | null = null;
    desktop.watchUpdates.mockImplementation((handlers) => {
      stage = handlers?.onStage ?? null;
      return () => {};
    });
    const container = await openPane();
    click(buttonNamed(container, "Check for updates now"));
    await flush();
    expect(desktop.desktopCheckForUpdates).toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Nothing newer (or the updater is off in this build).",
    );
    // The stages the native side announced, in order, with none dropped.
    act(() => {
      stage?.("checking");
      stage?.("downloading");
      stage?.("verified");
    });
    const log = container.querySelector("ol[aria-label='Updater stage log']")!;
    expect([...log.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      expect.stringContaining("checking"),
      expect.stringContaining("downloading"),
      expect.stringContaining("verified"),
    ]);
  });

  it("reports an offered version from a check", async () => {
    desktop.desktopCheckForUpdates.mockResolvedValue("0.3.0");
    const container = await openPane();
    click(buttonNamed(container, "Check for updates now"));
    await flush();
    expect(container.textContent).toContain("Update offered: 0.3.0.");
  });
});
