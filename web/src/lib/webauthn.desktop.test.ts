import { describe, expect, it } from "vitest";
import { passkeysSupported } from "./webauthn";

describe("passkeysSupported", () => {
  it("says no inside the desktop shell: the rpId can never match the webview origin", () => {
    // The Tauri globals the desktopAuth module detects the shell by.
    (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    try {
      expect(passkeysSupported()).toBe(false);
    } finally {
      delete (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    }
  });
});
