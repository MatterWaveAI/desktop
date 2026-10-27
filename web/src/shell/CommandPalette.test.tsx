import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../types";
import { CommandPalette } from "./CommandPalette";
import { fuzzyScore, groupRuns, paletteCommands, type PaletteAction } from "./palette";
import { matchShortcut, PALETTE_CHORD, chordLabel } from "./shortcuts";

/**
 * The command palette: the ranking as a pure function, the chord, and the
 * component driven by the keyboard alone -- arrows, Home/End, Enter, Tab
 * kept in, and the ARIA listbox wiring a screen reader follows. Same
 * harness as the other shell tests: react-dom plus act.
 */

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
  vi.useRealTimers();
});

function conv(id: string, title: string): Conversation {
  return { id, title, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
}

const CONVERSATIONS = [
  conv("c1", "Quarterly velocity planning"),
  conv("c2", "Kubernetes node pressure"),
  conv("c3", "Travel budget"),
];

describe("fuzzyScore", () => {
  it("ranks exact over prefix over word substring over inner substring over subsequence", () => {
    const exact = fuzzyScore("help", "Help");
    const prefix = fuzzyScore("kub", "Kubernetes node pressure");
    const word = fuzzyScore("vel", "Quarterly velocity planning");
    const inner = fuzzyScore("vel", "Travel budget");
    const subsequence = fuzzyScore("qvp", "Quarterly velocity planning");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it("drops anything whose letters are not there in order", () => {
    expect(fuzzyScore("zzz", "Quarterly velocity planning")).toBe(0);
    expect(fuzzyScore("pvq", "Quarterly velocity planning")).toBe(0);
  });
});

describe("paletteCommands", () => {
  it("leads with New chat and the recent conversations before anything is typed", () => {
    const ids = paletteCommands("", CONVERSATIONS).map((c) => c.id);
    expect(ids.slice(0, 4)).toEqual(["new-chat", "conversation:c1", "conversation:c2", "conversation:c3"]);
    expect(ids).toContain("help");
  });

  it("switches conversation by fuzzy title, and always ends with a search", () => {
    const commands = paletteCommands("qvp", CONVERSATIONS);
    expect(commands[0].action).toEqual({ kind: "conversation", id: "c1" });
    expect(commands.at(-1)!.action).toEqual({ kind: "search", query: "qvp" });
  });

  it("finds a settings pane by name", () => {
    const commands = paletteCommands("usage", CONVERSATIONS);
    expect(commands[0].action).toEqual({ kind: "settings", paneId: "usage" });
  });

  it("cuts the list into one run per group, keeping the flat indexes", () => {
    const commands = paletteCommands("", CONVERSATIONS);
    const runs = groupRuns(commands);
    expect(runs.map((run) => run.group)).toEqual(["Actions", "Conversations", "Help", "Settings"]);
    expect(runs[1].start).toBe(1);
    expect(runs[1].commands.map((c) => c.id)).toEqual([
      "conversation:c1",
      "conversation:c2",
      "conversation:c3",
    ]);
    expect(runs[2].start).toBe(4);
    expect(runs.flatMap((run) => run.commands)).toEqual(commands);
  });
});

describe("the chord", () => {
  it("is Mod+K, and it works from inside a text field", () => {
    expect(chordLabel(PALETTE_CHORD, false)).toBe("Ctrl+K");
    expect(chordLabel(PALETTE_CHORD, true)).toBe("⌘K");
    const field = document.createElement("textarea");
    const press = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(matchShortcut({ ...press, target: field }, false)?.id).toBe("command-palette");
    expect(matchShortcut({ ...press, ctrlKey: false, metaKey: true, target: null }, true)?.id).toBe(
      "command-palette",
    );
  });
});

describe("the palette, keyboard only", () => {
  function mount(onAction = vi.fn(), onOpenChange = vi.fn()) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          conversations={CONVERSATIONS}
          onAction={onAction}
        />,
      );
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    return { onAction, onOpenChange };
  }

  function input(): HTMLInputElement {
    return document.querySelector('[role="combobox"]') as HTMLInputElement;
  }

  function options(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  }

  function selected(): HTMLElement {
    return options().find((o) => o.getAttribute("aria-selected") === "true")!;
  }

  function key(name: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    act(() => {
      input().dispatchEvent(event);
    });
    return event;
  }

  function type(value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("focuses the field and wires it to a listbox through aria-activedescendant", () => {
    mount();
    expect(document.activeElement).toBe(input());
    const list = document.querySelector('[role="listbox"]')!;
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    expect(input().getAttribute("aria-activedescendant")).toBe(selected().id);
    expect(selected().textContent).toContain("New chat");
  });

  it("moves with the arrows, wraps at both ends, and jumps with Home and End", () => {
    mount();
    key("ArrowDown");
    expect(selected().textContent).toContain("Quarterly velocity planning");
    expect(input().getAttribute("aria-activedescendant")).toBe(selected().id);
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toBe(options().at(-1));
    key("ArrowDown");
    expect(selected()).toBe(options()[0]);
    key("End");
    expect(selected()).toBe(options().at(-1));
    key("Home");
    expect(selected()).toBe(options()[0]);
    // Focus never left the field.
    expect(document.activeElement).toBe(input());
  });

  it("Enter runs the active command and closes", () => {
    const { onAction, onOpenChange } = mount();
    type("kub");
    expect(selected().textContent).toContain("Kubernetes");
    key("Enter");
    expect(onAction).toHaveBeenCalledWith({ kind: "conversation", id: "c2" } satisfies PaletteAction);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("typing resets the cursor to the best match", () => {
    mount();
    key("ArrowDown");
    key("ArrowDown");
    type("help");
    expect(selected().textContent).toContain("Help");
  });

  it("an unknown word still leads somewhere: a search", () => {
    const { onAction } = mount();
    type("nothing like this");
    expect(options()).toHaveLength(1);
    key("Enter");
    expect(onAction).toHaveBeenCalledWith({ kind: "search", query: "nothing like this" });
  });

  it("keeps Tab inside the dialog", () => {
    mount();
    const event = key("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("heads each group once instead of tagging every row with its name", () => {
    mount();
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    const headings = groups.map((group) =>
      document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent,
    );
    expect(headings).toEqual(["Actions", "Conversations", "Help", "Settings"]);
    // Three conversations under one heading, none of them saying "Conversations".
    const rows = options().filter((o) => o.id.includes("conversation:"));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.textContent).not.toContain("Conversations");
    // Arrowing still walks the flat list across the headings.
    key("ArrowDown");
    expect(selected().textContent).toContain("Quarterly velocity planning");
    key("End");
    expect(selected().closest('[role="group"]')).toBe(groups[groups.length - 1]);
  });
});
