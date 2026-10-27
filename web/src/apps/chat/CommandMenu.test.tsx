import { act, useId, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandMenu } from "./CommandMenu";
import { optionId, useCommandMenu } from "./useCommandMenu";

/**
 * The slash-command popover, mounted under a textarea the way the composer
 * mounts it: react-dom/client plus act, no testing-library. The harness is
 * the composer's wiring in miniature -- the draft drives the menu, the
 * arrow keys move the highlight, Escape closes, a pick completes the line.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness(props: { initial: string; onPick?: (name: string) => void }) {
  const [draft, setDraft] = useState(props.initial);
  const menu = useCommandMenu(draft);
  const id = useId();
  const pick = (name: string) => {
    setDraft(`/${name}`);
    props.onPick?.(name);
  };
  return (
    <div>
      {menu.open && (
        <CommandMenu
          id={id}
          options={menu.options}
          activeIndex={menu.activeIndex}
          onPick={(command) => pick(command.name)}
          onHover={(index) => menu.move(index - menu.activeIndex)}
        />
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-autocomplete="list"
        aria-controls={menu.open ? id : undefined}
        aria-activedescendant={menu.active ? optionId(id, menu.active) : undefined}
        onKeyDown={(e) => {
          if (!menu.open || menu.active === null) return;
          if (e.key === "ArrowDown") menu.move(1);
          else if (e.key === "ArrowUp") menu.move(-1);
          else if (e.key === "Escape") menu.dismiss();
          else if (e.key === "Tab") pick(menu.active.name);
        }}
      />
    </div>
  );
}

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const textarea = () => container!.querySelector("textarea")!;
const options = () => [...container!.querySelectorAll<HTMLElement>("[role='option']")];
const selected = () => container!.querySelector<HTMLElement>("[role='option'][aria-selected='true']");

function key(name: string) {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

function type(value: string) {
  act(() => {
    const field = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the command popover", () => {
  it("opens on a slash with every command, as a listbox the textarea controls", () => {
    render(<Harness initial="/" />);
    const list = container!.querySelector("[role='listbox']")!;
    expect(list).not.toBeNull();
    expect(options().map((o) => o.textContent)).toEqual([
      "/compactSummarise the earlier messages now",
      "/contextShow how much of the model's window is used",
      "/helpList these commands",
    ]);
    // No `aria-expanded`: a textarea is a textbox, which may not carry it
    // (an axe critical), so the open state is the list being in the tree.
    expect(textarea().hasAttribute("aria-expanded")).toBe(false);
    expect(textarea().getAttribute("aria-controls")).toBe(list.id);
    expect(textarea().getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(selected()?.textContent).toContain("/compact");
  });

  it("narrows as the name is typed and closes when the line is no longer a command", () => {
    render(<Harness initial="" />);
    expect(container!.querySelector("[role='listbox']")).toBeNull();
    type("/co");
    expect(options().map((o) => o.id.split("-").pop())).toEqual(["compact", "context"]);
    type("/compact now");
    expect(container!.querySelector("[role='listbox']")).toBeNull();
    expect(textarea().hasAttribute("aria-controls")).toBe(false);
    expect(textarea().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("moves the highlight with the arrow keys, wrapping, and Tab picks it", () => {
    const onPick = vi.fn();
    render(<Harness initial="/" onPick={onPick} />);
    key("ArrowDown");
    expect(selected()?.textContent).toContain("/context");
    expect(textarea().getAttribute("aria-activedescendant")).toBe(selected()!.id);
    key("ArrowDown");
    key("ArrowDown");
    expect(selected()?.textContent).toContain("/compact");
    key("ArrowUp");
    expect(selected()?.textContent).toContain("/help");
    key("Tab");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("help");
    expect(textarea().value).toBe("/help");
  });

  it("closes on Escape and reopens on the next keystroke", () => {
    render(<Harness initial="/" />);
    key("Escape");
    expect(container!.querySelector("[role='listbox']")).toBeNull();
    expect(textarea().hasAttribute("aria-controls")).toBe(false);
    type("/h");
    expect(options().map((o) => o.textContent)).toEqual(["/helpList these commands"]);
  });

  it("picks on a tap without taking focus from the box", () => {
    const onPick = vi.fn();
    render(<Harness initial="/c" onPick={onPick} />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      options()[1].dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("context");
    expect(textarea().value).toBe("/context");
  });
});
