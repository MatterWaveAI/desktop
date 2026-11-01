import { afterEach, describe, expect, it } from "vitest";
import { failureMessage } from "./speech";

/**
 * The desktop shell's wording for a refused microphone: the webview has no
 * address bar, so the remedy is the system's privacy settings.
 */

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("the failures in the desktop shell", () => {
  it("a refused microphone points at the system's settings, not an address bar", () => {
    const desktop = failureMessage("not-allowed", "server", true);
    expect(desktop).toMatch(/system|settings/i);
    expect(desktop).not.toMatch(/address bar/);
  });

  it("is the wording by default inside the shell, and the browser's outside it", () => {
    expect(failureMessage("not-allowed", "server")).toMatch(/address bar/);
    // The Tauri globals the desktopAuth module detects the shell by.
    (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    expect(failureMessage("not-allowed", "server")).not.toMatch(/address bar/);
  });
});
