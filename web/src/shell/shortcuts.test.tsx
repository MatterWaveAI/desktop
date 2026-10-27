import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chordLabel,
  isMacPlatform,
  isTypingTarget,
  matchShortcut,
  SHORTCUTS,
  type KeyPress,
} from "./shortcuts";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useStopShortcut } from "../apps/chat/useStopShortcut";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { HelpPage } from "./HelpPage";
import { HELP_PATH } from "./help";

/**
 * The shortcuts as data, the matcher, the hook that dispatches them, and
 * the two surfaces that list them. Same harness as ChatStates.test.tsx.
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
  vi.unstubAllGlobals();
});

function press(over: Partial<KeyPress> & { key: string }): KeyPress {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...over,
  };
}

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("the shortcut table", () => {
  it("covers the thirteen actions, and only Enter and ArrowUp are left to the composer", () => {
    expect(SHORTCUTS.map((s) => s.id)).toEqual([
      "send",
      "stop",
      "new-chat",
      "focus-composer",
      "toggle-sidebar",
      "help",
      "command-palette",
      "copy-last-reply",
      "copy-last-code",
      "edit-last",
      "delete-chat",
      "search-chats",
      "dictate",
    ]);
    expect(SHORTCUTS.filter((s) => s.local).map((s) => s.id)).toEqual(["send", "edit-last"]);
  });

  it("spells the new chords for each platform", () => {
    const chord = (id: string) => SHORTCUTS.find((s) => s.id === id)!.chords[0];
    expect(chordLabel(chord("copy-last-reply"), false)).toBe("Ctrl+Shift+C");
    expect(chordLabel(chord("copy-last-reply"), true)).toBe("⌘⇧C");
    expect(chordLabel(chord("copy-last-code"), false)).toBe("Ctrl+Shift+;");
    expect(chordLabel(chord("copy-last-code"), true)).toBe("⌘⇧;");
    expect(chordLabel(chord("delete-chat"), false)).toBe("Ctrl+Shift+Backspace");
    expect(chordLabel(chord("delete-chat"), true)).toBe("⌘⇧⌫");
    expect(chordLabel(chord("search-chats"), false)).toBe("Ctrl+Shift+F");
    expect(chordLabel(chord("edit-last"), false)).toBe("↑");
  });

  it("spells the modifier for the platform", () => {
    const newChat = SHORTCUTS.find((s) => s.id === "new-chat")!.chords[0];
    expect(chordLabel(newChat, true)).toBe("⌘⇧O");
    expect(chordLabel(newChat, false)).toBe("Ctrl+Shift+O");
    const focus = SHORTCUTS.find((s) => s.id === "focus-composer")!.chords[0];
    expect(chordLabel(focus, false)).toBe("Shift+Esc");
    const [slash, question] = SHORTCUTS.find((s) => s.id === "help")!.chords;
    expect(chordLabel(slash, true)).toBe("⌘/");
    expect(chordLabel(question, false)).toBe("?");
  });

  it("detects a Mac from the platform string, and nothing else", () => {
    expect(isMacPlatform({ platform: "MacIntel" } as Navigator)).toBe(true);
    expect(isMacPlatform({ platform: "iPad" } as Navigator)).toBe(true);
    expect(isMacPlatform({ platform: "Win32" } as Navigator)).toBe(false);
    expect(
      isMacPlatform({ platform: "Win32", userAgentData: { platform: "macOS" } } as unknown as Navigator),
    ).toBe(true);
  });
});

describe("matchShortcut", () => {
  it("uses Command on a Mac and Control elsewhere, never the other", () => {
    const mac = press({ key: "O", metaKey: true, shiftKey: true });
    expect(matchShortcut(mac, true)?.id).toBe("new-chat");
    expect(matchShortcut(mac, false)).toBeNull();
    const pc = press({ key: "O", ctrlKey: true, shiftKey: true });
    expect(matchShortcut(pc, false)?.id).toBe("new-chat");
    expect(matchShortcut(pc, true)).toBeNull();
  });

  it("matches the rest of the table", () => {
    expect(matchShortcut(press({ key: "Escape", shiftKey: true }), false)?.id).toBe(
      "focus-composer",
    );
    // Bare Esc is the stop; with Shift it is the jump to the composer, never both.
    expect(matchShortcut(press({ key: "Escape" }), false)?.id).toBe("stop");
    expect(matchShortcut(press({ key: "S", ctrlKey: true, shiftKey: true }), false)?.id).toBe(
      "toggle-sidebar",
    );
    expect(matchShortcut(press({ key: "/", ctrlKey: true }), false)?.id).toBe("help");
    // `?` arrives with Shift held; the chord does not have to say so.
    expect(matchShortcut(press({ key: "?", shiftKey: true }), false)?.id).toBe("help");
    // Enter is the composer's, never dispatched globally.
    expect(matchShortcut(press({ key: "Enter" }), false)).toBeNull();
    // Alt turns any of these into something else.
    expect(matchShortcut(press({ key: "/", ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("keeps a bare key out of text fields but lets modifier chords and Shift+Esc through", () => {
    const textarea = document.createElement("textarea");
    expect(isTypingTarget(textarea)).toBe(true);
    expect(matchShortcut(press({ key: "?", shiftKey: true, target: textarea }), false)).toBeNull();
    expect(matchShortcut(press({ key: "/", ctrlKey: true, target: textarea }), false)?.id).toBe(
      "help",
    );
    expect(
      matchShortcut(press({ key: "O", ctrlKey: true, shiftKey: true, target: textarea }), false)?.id,
    ).toBe("new-chat");
    expect(matchShortcut(press({ key: "Escape", shiftKey: true, target: textarea }), false)?.id).toBe(
      "focus-composer",
    );
  });

  it("matches the new chords, from a text field too", () => {
    const textarea = document.createElement("textarea");
    const search = document.createElement("input");
    search.type = "search";
    for (const target of [null, textarea, search]) {
      expect(
        matchShortcut(press({ key: "C", ctrlKey: true, shiftKey: true, target }), false)?.id,
      ).toBe("copy-last-reply");
      // Shift+; arrives as `:` on a US layout; the physical key still matches.
      expect(
        matchShortcut(
          press({ key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true, target }),
          false,
        )?.id,
      ).toBe("copy-last-code");
      expect(
        matchShortcut(press({ key: ";", metaKey: true, shiftKey: true, target }), true)?.id,
      ).toBe("copy-last-code");
      expect(
        matchShortcut(press({ key: "Backspace", ctrlKey: true, shiftKey: true, target }), false)
          ?.id,
      ).toBe("delete-chat");
      expect(
        matchShortcut(press({ key: "F", metaKey: true, shiftKey: true, target }), true)?.id,
      ).toBe("search-chats");
    }
    // Without Shift they are the browser's: Ctrl+C copies, Ctrl+F finds,
    // Ctrl+Backspace deletes a word.
    expect(matchShortcut(press({ key: "c", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press({ key: ";", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press({ key: "f", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press({ key: "Backspace", ctrlKey: true }), false)).toBeNull();
    // ArrowUp is the composer's, never global.
    expect(matchShortcut(press({ key: "ArrowUp" }), false)).toBeNull();
  });

  it("knows what counts as typing", () => {
    const text = document.createElement("input");
    expect(isTypingTarget(text)).toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("useKeyboardShortcuts", () => {
  function Host(props: { handlers: Parameters<typeof useKeyboardShortcuts>[0] }) {
    useKeyboardShortcuts(props.handlers);
    return <textarea data-testid="box" />;
  }

  it("dispatches to the handler and claims the key, on this platform's modifier", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    const onNewChat = vi.fn();
    const onHelp = vi.fn();
    render(<Host handlers={{ "new-chat": onNewChat, help: onHelp }} />);

    const claimed = keydown(window, { key: "O", ctrlKey: true, shiftKey: true });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(claimed.defaultPrevented).toBe(true);

    // The Mac chord does nothing here, and the browser keeps it.
    const ignored = keydown(window, { key: "O", metaKey: true, shiftKey: true });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(ignored.defaultPrevented).toBe(false);

    // A bare `?` typed into the box is text, not a shortcut.
    const box = container!.querySelector("[data-testid='box']")!;
    keydown(box, { key: "?", shiftKey: true });
    expect(onHelp).not.toHaveBeenCalled();
    keydown(window, { key: "?", shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it("fires the mod chords from inside a text field, and none while an IME composes", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    const handlers = {
      "copy-last-reply": vi.fn(),
      "copy-last-code": vi.fn(),
      "delete-chat": vi.fn(),
      "search-chats": vi.fn(),
    };
    render(<Host handlers={handlers} />);
    const box = container!.querySelector("[data-testid='box']")!;
    const chords: [keyof typeof handlers, KeyboardEventInit][] = [
      ["copy-last-reply", { key: "C" }],
      ["copy-last-code", { key: ":", code: "Semicolon" }],
      ["delete-chat", { key: "Backspace" }],
      ["search-chats", { key: "F" }],
    ];
    for (const [id, init] of chords) {
      const composing = keydown(box, { ...init, ctrlKey: true, shiftKey: true, isComposing: true });
      expect(handlers[id]).not.toHaveBeenCalled();
      expect(composing.defaultPrevented).toBe(false);
      const typed = keydown(box, { ...init, ctrlKey: true, shiftKey: true });
      expect(handlers[id]).toHaveBeenCalledTimes(1);
      expect(typed.defaultPrevented).toBe(true);
    }
  });

  it("leaves a shortcut with no handler to the browser, and stops listening on unmount", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    const onHelp = vi.fn();
    render(<Host handlers={{ help: onHelp }} />);
    const unhandled = keydown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(unhandled.defaultPrevented).toBe(false);

    act(() => {
      root!.unmount();
    });
    keydown(window, { key: "/", ctrlKey: true });
    expect(onHelp).not.toHaveBeenCalled();
  });
});

describe("Esc stops the answer", () => {
  function Host(props: { running: boolean; onStop: () => void }) {
    useStopShortcut(props.running, props.onStop);
    return <textarea data-testid="box" />;
  }

  it("stops from the composer and from anywhere else while an answer runs, and Shift+Esc never does", () => {
    const onStop = vi.fn();
    render(<Host running onStop={onStop} />);
    // From inside the box: the person is looking at the composer when they
    // decide the answer is going the wrong way.
    const box = container!.querySelector("[data-testid='box']")!;
    const inBox = keydown(box, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(inBox.defaultPrevented).toBe(true);
    keydown(window, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(2);
    keydown(window, { key: "Escape", shiftKey: true });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("leaves Esc to the browser while nothing is running", () => {
    const onStop = vi.fn();
    render(<Host running={false} onStop={onStop} />);
    const idle = keydown(window, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
    expect(idle.defaultPrevented).toBe(false);
  });

  it("does not stop while a dialog is open: the dialog owns Esc", () => {
    const onStop = vi.fn();
    render(
      <>
        <Host running onStop={onStop} />
        <ShortcutsHelp open onOpenChange={() => undefined} mac={false} />
      </>,
    );
    // Dispatched inside the dialog, so the key travels the way it does in a
    // browser: up through the document, where the dialog listens and claims
    // it, before it would reach the window where the stop listens.
    const overlay = document.querySelector("[data-mw-shortcuts-help]")!;
    const claimed = keydown(overlay, { key: "Escape" });
    expect(claimed.defaultPrevented).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("the shortcuts overlay", () => {
  it("lists every shortcut with platform keycaps and links the help page", () => {
    render(<ShortcutsHelp open onOpenChange={() => undefined} mac={false} />);
    const overlay = document.querySelector("[data-mw-shortcuts-help]")!;
    expect(overlay).not.toBeNull();
    for (const shortcut of SHORTCUTS) {
      expect(overlay.textContent).toContain(shortcut.label);
    }
    const caps = [...overlay.querySelectorAll("kbd")].map((kbd) => kbd.textContent);
    expect(caps).toContain("Ctrl+Shift+O");
    expect(caps).toContain("Shift+Esc");
    expect(caps).toContain("Esc");
    expect(caps).toContain("?");
    expect(caps).toContain("Ctrl+Shift+C");
    expect(caps).toContain("Ctrl+Shift+;");
    expect(caps).toContain("Ctrl+Shift+Backspace");
    expect(caps).toContain("Ctrl+Shift+F");
    expect(caps).toContain("↑");
    expect(overlay.querySelector("a")?.getAttribute("href")).toBe(HELP_PATH);
  });

  it("spells the same table for a Mac", () => {
    render(<ShortcutsHelp open onOpenChange={() => undefined} mac />);
    const caps = [...document.querySelectorAll("[data-mw-shortcuts-help] kbd")].map(
      (kbd) => kbd.textContent,
    );
    expect(caps).toContain("⌘⇧O");
    expect(caps).toContain("⌘/");
    expect(caps).not.toContain("Ctrl+Shift+O");
  });
});

describe("the help page", () => {
  it("covers the shortcuts, the AI disclosure, reporting, exporting and where the money is", () => {
    render(<HelpPage mac={false} />);
    const text = container!.textContent ?? "";
    expect(container!.querySelector("h1")?.textContent).toBe("Help");
    for (const shortcut of SHORTCUTS) expect(text).toContain(shortcut.label);
    expect(text).toContain("Ctrl+Shift+O");
    // The disclosure, word for word, and what it means in practice.
    expect(text).toContain("You are talking with an AI assistant, not a human.");
    expect(text).toMatch(/wrong, invented or out of date/i);
    // Reporting: the two reasons and the promise about what a report does not do.
    expect(text).toContain("Unsafe or harmful");
    expect(text).toContain("Unhelpful or wrong");
    expect(text).toMatch(/does not change the conversation/i);
    // Exporting: both formats, and that it is local.
    expect(text).toContain("Export as Markdown");
    expect(text).toContain("Export as JSON");
    expect(text).toMatch(/nothing is sent anywhere/i);
    // Usage and billing: the three places, as real links.
    const hrefs = [...container!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining(["/settings/usage", "/settings/billing", "/pricing", "/settings/data"]),
    );
  });
});
