import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DestructiveConfirm } from "./DestructiveConfirm";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { PageHeader } from "./PageHeader";

/**
 * The pattern components exist so the chat and admin
 * surfaces compose rather than invent. These tests pin the contract —
 * roles, labels, and the two callbacks a composer relies on — in jsdom,
 * same harness style as registry.test.tsx.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("EmptyState", () => {
  it("renders title, description and action", () => {
    render(
      <EmptyState
        title="No conversations yet"
        description="Send a message to start."
        action={<button type="button">New chat</button>}
      />,
    );
    expect(container!.textContent).toContain("No conversations yet");
    expect(container!.textContent).toContain("Send a message to start.");
    expect(container!.querySelector("button")?.textContent).toBe("New chat");
  });
});

describe("ErrorState", () => {
  it("announces as an alert and fires the retry callback", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Could not load." retryLabel="Try again" onRetry={onRetry} />);
    const alert = container!.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Something went wrong");
    expect(alert!.textContent).toContain("Could not load.");
    const retry = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again",
    )!;
    expect(retry).toBeDefined();
    act(() => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders without a retry action when none is given", () => {
    render(<ErrorState message="Gone." />);
    expect(container!.querySelector("button")).toBeNull();
  });
});

describe("LoadingSkeleton", () => {
  it("renders the requested number of bars and a screen-reader announcement", () => {
    render(<LoadingSkeleton rows={4} />);
    expect(container!.querySelector("[role='status']")).not.toBeNull();
    expect(container!.textContent).toContain("Loading…");
    expect(container!.querySelectorAll("[data-slot='skeleton']").length).toBe(4);
  });
});

describe("PageHeader", () => {
  it("renders title, description and actions", () => {
    render(
      <PageHeader
        title="Keys"
        description="API keys for this org."
        actions={<button type="button">Create key</button>}
      />,
    );
    expect(container!.querySelector("h1")?.textContent).toBe("Keys");
    expect(container!.textContent).toContain("API keys for this org.");
    expect(container!.querySelector("button")?.textContent).toBe("Create key");
  });
});

describe("DestructiveConfirm", () => {
  it("renders the confirm dialog with both choices and fires onConfirm", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DestructiveConfirm
        open
        onOpenChange={onOpenChange}
        title="Delete conversation?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    // Base UI portals the dialog to document.body, not the container.
    const dialog = document.querySelector("[data-slot='dialog-content']");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Delete conversation?");
    expect(dialog!.textContent).toContain("This cannot be undone.");
    const buttons = [...dialog!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Delete"]);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
