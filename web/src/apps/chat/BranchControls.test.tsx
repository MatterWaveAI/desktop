import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchSwitcher, MessageAction, MessageEditor } from "./BranchControls";

/**
 * The switcher, the Edit action and the inline editor.
 *
 * Same harness as ChatStates.test.tsx -- react-dom/client plus act, no
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function buttonByLabel(label: string): HTMLButtonElement {
  const el = container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("BranchSwitcher", () => {
  it("shows the human count, one-based", () => {
    render(
      <BranchSwitcher index={1} total={3} onPrevious={() => {}} onNext={() => {}} />,
    );
    expect(container!.textContent).toContain("2 / 3");
  });

  it("steps back and forward", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <BranchSwitcher index={1} total={3} onPrevious={onPrevious} onNext={onNext} />,
    );
    click(buttonByLabel("Previous version"));
    click(buttonByLabel("Next version"));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("disables the arrow at each end", () => {
    render(<BranchSwitcher index={0} total={2} onPrevious={() => {}} onNext={() => {}} />);
    expect(buttonByLabel("Previous version").disabled).toBe(true);
    expect(buttonByLabel("Next version").disabled).toBe(false);
  });

  it("disables the forward arrow on the last sibling", () => {
    render(<BranchSwitcher index={1} total={2} onPrevious={() => {}} onNext={() => {}} />);
    expect(buttonByLabel("Next version").disabled).toBe(true);
  });

  it("announces the position to a screen reader", () => {
    render(<BranchSwitcher index={2} total={4} onPrevious={() => {}} onNext={() => {}} />);
    expect(container!.querySelector('[aria-label="Version 3 of 4"]')).not.toBeNull();
  });
});

describe("MessageAction", () => {
  it("fires and can be disabled while a turn is in flight", () => {
    const onClick = vi.fn();
    render(<MessageAction label="Regenerate" onClick={onClick} />);
    const button = container!.querySelector("button")!;
    click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(<MessageAction label="Regenerate" onClick={onClick} disabled />);
    });
    expect(container!.querySelector("button")!.disabled).toBe(true);
  });
});

describe("MessageEditor", () => {
  function type(text: string): void {
    const textarea = container!.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function key(init: KeyboardEventInit): void {
    act(() => {
      container!
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    });
  }

  it("opens with the message's current text", () => {
    render(<MessageEditor initial="first ask" onSave={() => {}} onCancel={() => {}} />);
    expect(container!.querySelector("textarea")!.value).toBe("first ask");
  });

  it("shows where focus is: the box draws a ring rather than none at all", () => {
    render(<MessageEditor initial="first ask" onSave={() => {}} onCancel={() => {}} />);
    const box = container!.querySelector("textarea")!;
    expect(box.className).toMatch(/focus-visible:ring/);
  });

  it("names its primary action for what it does: it sends the edited turn", () => {
    render(<MessageEditor initial="first ask" onSave={() => {}} onCancel={() => {}} />);
    const labels = [...container!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Cancel", "Send"]);
  });

  it("saves the edited text", () => {
    const onSave = vi.fn();
    render(<MessageEditor initial="first ask" onSave={onSave} onCancel={() => {}} />);
    type("second ask");
    click([...container!.querySelectorAll("button")].find((b) => b.textContent === "Send")!);
    expect(onSave).toHaveBeenCalledWith("second ask");
  });

  it("cancels without saving", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<MessageEditor initial="first ask" onSave={onSave} onCancel={onCancel} />);
    type("changed my mind");
    click([...container!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("will not save an empty message", () => {
    const onSave = vi.fn();
    render(<MessageEditor initial="first ask" onSave={onSave} onCancel={() => {}} />);
    type("   ");
    const save = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Send",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("trims what it saves", () => {
    const onSave = vi.fn();
    render(<MessageEditor initial="x" onSave={onSave} onCancel={() => {}} />);
    type("  padded  ");
    click([...container!.querySelectorAll("button")].find((b) => b.textContent === "Send")!);
    expect(onSave).toHaveBeenCalledWith("padded");
  });

  it("Escape cancels", () => {
    const onCancel = vi.fn();
    render(<MessageEditor initial="x" onSave={() => {}} onCancel={onCancel} />);
    key({ key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Cmd/Ctrl+Enter saves, but a bare Enter stays a newline", () => {
    const onSave = vi.fn();
    render(<MessageEditor initial="x" onSave={onSave} onCancel={() => {}} />);
    key({ key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    key({ key: "Enter", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("x");
  });
});
