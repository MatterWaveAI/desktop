import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MessageTime } from "./MessageTime";

/**
 * The element under a stored row: a real `<time>` with the machine-readable
 * moment, the short local form as its text, and the hidings that keep it in
 * the accessibility tree. Same harness as ChatStates.test.tsx.
 */

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

const NOW = new Date(2026, 9, 18, 15, 0);

describe("MessageTime", () => {
  it("is a <time> carrying the ISO moment, drawn in the short local form", () => {
    render(
      <div data-message-id="m-1">
        <MessageTime at="2026-10-18T14:05:00" now={NOW} />
      </div>,
    );
    const time = container!.querySelector("time")!;
    expect(time).not.toBeNull();
    expect(time.getAttribute("dateTime")).toBe("2026-10-18T14:05:00");
    expect(time.textContent).toBe(
      new Date("2026-10-18T14:05:00").toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(time.getAttribute("title")).toContain("2026");
  });

  it("hides from sight, never from the accessibility tree: no aria-hidden, no display none", () => {
    render(<MessageTime at="2026-10-18T14:05:00" now={NOW} />);
    const p = container!.querySelector("p")!;
    // Clipped on a phone, faded on a desktop; both leave the node readable.
    expect(p.className).toContain("sr-only");
    expect(p.className).toContain("md:opacity-0");
    expect(p.className).not.toContain("hidden");
    expect(p.getAttribute("aria-hidden")).toBeNull();
    // Shown when the row the stored id marks is hovered or holds focus.
    expect(p.className).toContain("[[data-message-id]:hover_&]:opacity-100");
    expect(p.className).toContain("[[data-message-id]:focus-within_&]:opacity-100");
  });

  it("renders nothing for a time it cannot read, rather than an empty <time>", () => {
    render(<MessageTime at="" now={NOW} />);
    expect(container!.querySelector("time")).toBeNull();
  });
});
