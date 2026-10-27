import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_ERROR_KINDS } from "../apps/chat/streamErrors";
import { apps } from "../apps/registry";
import { StatesPage } from "./StatesPage";

/**
 * /dev/states renders every state, so they can be reviewed
 * without reproducing each failure. The test's job is to keep that true — a
 * new error kind that nobody added to the page fails here rather than being
 * discovered missing during a review.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<StatesPage />);
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("the /dev/states page", () => {
  it("is registered behind a flag, the same way /dev/tokens is", () => {
    const entry = apps.find((app) => app.path === "/dev/states");
    expect(entry).toBeDefined();
    // A lazy chunk: the router preloads it on the first visit.
    expect(entry!.component).toHaveProperty("preload");
    // Flagged, so it never appears in end-user nav.
    expect(entry!.flag).toBe("dev_states");
  });

  it("renders every transcript error kind", () => {
    render();
    for (const kind of STREAM_ERROR_KINDS) {
      expect(
        container!.querySelector(`[data-error-kind="${kind}"]`),
        `${kind} is missing from /dev/states`,
      ).not.toBeNull();
    }
  });

  it("renders the empty, loading, streaming and offline states together", () => {
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("What can I help you with?");
    expect(text).toContain("Loading conversations…");
    expect(text).toContain("Loading conversation…");
    expect(text).toContain("Waiting for the model");
    expect(text).toContain("Responding…");
    expect(text).toContain("You are offline");
    // Skeletons, not spinners, on the content areas.
    expect(container!.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(8);
  });

  it("clicking an example prompt reports what would land in the composer", () => {
    render();
    const card = container!.querySelector("ul button")!;
    act(() => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const picked = container!.querySelector("[data-testid='picked-prompt']")!;
    expect(picked.textContent).not.toBe("—");
    expect(picked.textContent!.length).toBeGreaterThan(10);
  });

  it("the crash demo is caught by the boundary, leaving the rest of the page up", () => {
    render();
    const trigger = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Throw inside the app"),
    )!;
    expect(trigger).toBeDefined();
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).toContain("Demo app stopped working");
    // The page around the boundary is untouched.
    expect(container!.textContent).toContain("What can I help you with?");
  });
});
