import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { COPIED_FOR_MS } from "./useCopy";
import { MessageControls } from "./MessageControls";

/**
 * The action row ChatPage puts under every stored message: which actions a
 * user turn gets, which a reply gets, and what Copy does.
 *
 * Same harness as BranchControls.test.tsx -- react-dom/client plus act, no
 * testing-library.
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

/** jsdom ships no `navigator.clipboard`; each test states whether it has one. */
function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  stubClipboard(null);
  vi.useRealTimers();
});

function message(role: "user" | "assistant", id = `${role}-1`): Message {
  return {
    id,
    conversation_id: "c1",
    role,
    content: `the ${role}'s text`,
    created_at: "2026-01-01T00:00:00Z",
    parent_id: null,
    model: null,
  };
}

function buttons(): string[] {
  return [...container!.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent ?? "",
  );
}

function buttonNamed(text: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === text,
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const handlers = {
  busy: false,
  onSwitchBranch: () => {},
  onEdit: () => {},
  onRegenerate: () => {},
  onReport: () => {},
};

describe("which actions a row gets", () => {
  it("a reply has Copy, beside Regenerate and Report", () => {
    stubClipboard(async () => {});
    render(
      <MessageControls {...handlers} message={message("assistant")} branch={null} canRegenerate />,
    );
    expect(buttons()).toEqual(["Copy", "Regenerate", "Report"]);
  });

  it("a user turn has Edit and no Copy", () => {
    stubClipboard(async () => {});
    render(
      <MessageControls {...handlers} message={message("user")} branch={null} canRegenerate={false} />,
    );
    expect(buttons()).toEqual(["Edit"]);
  });

  it("a reply still streaming has nothing to copy or report yet", () => {
    stubClipboard(async () => {});
    render(
      <MessageControls
        {...handlers}
        message={message("assistant", "pending-1")}
        branch={null}
        canRegenerate={false}
      />,
    );
    expect(buttons()).toEqual([]);
  });

  it("Regenerate is a plain button in the row, so Tab reaches it on every reply", () => {
    stubClipboard(async () => {});
    const onRegenerate = vi.fn();
    render(
      <MessageControls
        {...handlers}
        onRegenerate={onRegenerate}
        message={message("assistant", "a-middle")}
        branch={null}
        canRegenerate
      />,
    );
    const regenerate = buttonNamed("Regenerate");
    expect(regenerate.tabIndex).toBe(0);
    expect(regenerate.disabled).toBe(false);
    regenerate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRegenerate).toHaveBeenCalledExactlyOnceWith("a-middle");
  });

  it("offers Branch from here on any stored message once the page can fork", () => {
    stubClipboard(async () => {});
    const onBranch = vi.fn();
    render(
      <MessageControls
        {...handlers}
        onBranch={onBranch}
        message={message("user", "u-7")}
        branch={null}
        canRegenerate={false}
      />,
    );
    expect(buttons()).toEqual(["Edit", "Branch from here"]);
    buttonNamed("Branch from here").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onBranch).toHaveBeenCalledExactlyOnceWith("u-7");

    act(() => root?.unmount());
    container?.remove();
    render(
      <MessageControls
        {...handlers}
        onBranch={onBranch}
        message={message("assistant")}
        branch={null}
        canRegenerate
      />,
    );
    expect(buttons()).toEqual(["Copy", "Regenerate", "Report", "Branch from here"]);
  });

  it("has no Branch from here on a reply still streaming, which has no id to cut at", () => {
    stubClipboard(async () => {});
    render(
      <MessageControls
        {...handlers}
        onBranch={() => {}}
        message={message("assistant", "pending-1")}
        branch={null}
        canRegenerate={false}
      />,
    );
    expect(buttons()).toEqual([]);
  });

  it("hides Copy, and throws nothing, in a browser with no clipboard API", () => {
    stubClipboard(null);
    render(
      <MessageControls {...handlers} message={message("assistant")} branch={null} canRegenerate />,
    );
    expect(buttons()).toEqual(["Regenerate", "Report"]);
  });
});

describe("Copy on a reply", () => {
  it("writes the reply's flattened text and reads Copied for two seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(
      <MessageControls {...handlers} message={message("assistant")} branch={null} canRegenerate />,
    );

    await click(buttonNamed("Copy"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("the assistant's text");
    const copied = buttonNamed("Copied");
    // Announced, not just repainted: the label lives in a polite live region.
    expect(copied.closest("[aria-live='polite']")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(COPIED_FOR_MS - 1);
    });
    expect(buttons()).toContain("Copied");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(buttons()).toContain("Copy");
    expect(buttons()).not.toContain("Copied");
  });

  it("stays on Copy when the clipboard refuses, rather than claiming a copy", async () => {
    stubClipboard(async () => {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    });
    render(
      <MessageControls {...handlers} message={message("assistant")} branch={null} canRegenerate />,
    );
    await click(buttonNamed("Copy"));
    expect(buttons()).toContain("Copy");
    expect(buttons()).not.toContain("Copied");
  });

  it("is disabled, like its neighbours, while a turn is in flight", () => {
    stubClipboard(async () => {});
    render(
      <MessageControls
        {...handlers}
        busy
        message={message("assistant")}
        branch={null}
        canRegenerate
      />,
    );
    expect(buttonNamed("Copy").disabled).toBe(true);
    expect(buttonNamed("Regenerate").disabled).toBe(true);
  });
});
