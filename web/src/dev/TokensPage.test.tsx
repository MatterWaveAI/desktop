import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokensPage } from "./TokensPage";
import { SEMANTIC_TOKENS } from "./semanticTokens";

/**
 * Smoke: the /dev/tokens page mounts with every section — both
 * theme panels (the mw-theme-light/dark wrappers), all semantic swatches,
 * and the component gallery. Contrast is enforced separately and
 * programmatically in src/styles/tokens.test.ts; this proves the page
 * itself renders in both themes without crashing.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("the /dev/tokens page", () => {
  it("renders both theme panels with every semantic token swatch", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<TokensPage />);
    });

    await vi.waitFor(() => {
      expect(container!.querySelector('[aria-label="Light theme"]')).not.toBeNull();
      expect(container!.querySelector('[aria-label="Dark theme"]')).not.toBeNull();
    });

    for (const label of ["Light theme", "Dark theme"]) {
      const panel = container!.querySelector(`[aria-label="${label}"]`)!;
      // One swatch per semantic token, resolved via var(--mw-color-*).
      const swatches = panel.querySelectorAll('[style*="--mw-color-"]');
      expect(swatches.length, `${label}: semantic swatches`).toBe(SEMANTIC_TOKENS.length);
      // The component gallery rendered.
      expect(panel.querySelectorAll("button").length, `${label}: buttons`).toBeGreaterThan(
        10,
      );
    }

    // The primitives section is theme-independent but present.
    expect(container!.textContent).toContain("Primitives");
    expect(container!.textContent).toContain("Design tokens");
  });
});
