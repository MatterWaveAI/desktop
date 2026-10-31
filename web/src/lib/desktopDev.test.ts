import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop dev pane's gate: a dev build inside the desktop shell, and
 * nothing else. The pane id must never reach a release build's nav, and a
 * browser must never see it either.
 */

const desktop = vi.hoisted(() => ({ isDesktop: vi.fn(() => false) }));

vi.mock("./desktopAuth", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ...desktop,
}));

async function paneIds(): Promise<string[]> {
  vi.resetModules();
  const panes = await import("../apps/settings/panes");
  return panes.settingsPanes.map((pane: { id: string }) => pane.id);
}

describe("desktopDevEnabled", () => {
  afterEach(() => {
    desktop.isDesktop.mockReturnValue(false);
    vi.resetModules();
  });

  it("keeps the diagnostics pane out of a browser", async () => {
    expect(await paneIds()).not.toContain("desktop");
  });

  it("keeps it out of the vitest environment, release-shaped like it is", async () => {
    // No Tauri globals here: the gate is false even though DEV is true, so
    // the platform pane list tests assert the shipped list.
    expect(await paneIds()).not.toContain("desktop");
  });

  it("lists the diagnostics pane last in a dev build inside the desktop shell", async () => {
    desktop.isDesktop.mockReturnValue(true);
    const ids = await paneIds();
    expect(ids.at(-1)).toBe("desktop");
    // And only once.
    expect(ids.filter((id: string) => id === "desktop")).toHaveLength(1);
  });
});
