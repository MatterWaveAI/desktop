import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import {
  applyTheme,
  getThemePreference,
  resolveTheme,
  setThemePreference,
} from "./theme";

/**
 * The three-state toggle (system / light / dark) replaces the
 * two-state one. The module is the contract: the preference persists under
 * the same `mw-theme` key the two-state toggle used, `system` resolves
 * against the OS and updates live, and the resolved theme is the `.dark`
 * class on <html> — what the pre-paint script in index.html also sets.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A controllable matchMedia stand-in (jsdom has none beyond the setup stub). */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

let root: Root | null = null;
let container: HTMLElement | null = null;

describe("getThemePreference", () => {
  it("defaults to dark, the brand's theme, when nothing (or garbage) is stored", () => {
    expect(getThemePreference()).toBe("dark");
    localStorage.setItem("mw-theme", "nonsense");
    expect(getThemePreference()).toBe("dark");
  });

  it("reads back the three stored preferences", () => {
    for (const preference of ["system", "light", "dark"] as const) {
      localStorage.setItem("mw-theme", preference);
      expect(getThemePreference()).toBe(preference);
    }
  });
});

describe("resolveTheme", () => {
  it("follows the OS while the preference is system", () => {
    stubMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
    stubMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("ignores the OS for an explicit preference", () => {
    stubMatchMedia(true);
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("applyTheme / setThemePreference", () => {
  it("applies the resolved theme as the .dark class on <html>", () => {
    stubMatchMedia(true);
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists the preference and applies it", () => {
    stubMatchMedia(false);
    setThemePreference("dark");
    expect(localStorage.getItem("mw-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setThemePreference("system");
    expect(localStorage.getItem("mw-theme")).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("ThemeToggle", () => {
  it("starts dark and cycles dark → system → light → dark, labelling each state", () => {
    stubMatchMedia(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(<ThemeToggle />);
    });
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Theme: dark. Switch to system.");
    expect(localStorage.getItem("mw-theme")).toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("system");
    // The stubbed OS is light.
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Theme: system. Switch to light.");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Theme: light. Switch to dark.");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Theme: dark. Switch to system.");
  });
});
