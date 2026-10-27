import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import type { ChatMessage } from "./chatAdapter";
import {
  isEditLastKey,
  lastCodeBlock,
  lastCodeIn,
  lastEditableId,
  replyTexts,
  useCopyShortcuts,
} from "./chatShortcuts";
import { DeleteConversationShortcut } from "./DeleteConversationShortcut";
import type { BranchedMessage } from "./useBranchedThread";

/**
 * The chat page's shortcuts: what each copies, which message ArrowUp opens,
 * and the delete chord behind its confirm. Same harness as
 * MessageControls.test.tsx.
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

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("navigator", Object.create(navigator, { platform: { value: "Win32" } }));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  stubClipboard(null);
  vi.unstubAllGlobals();
});

function stored(role: "user" | "assistant", id: string, content: string): BranchedMessage {
  const message: Message = {
    id,
    conversation_id: "c1",
    role,
    content,
    created_at: "2026-01-01T00:00:00Z",
    parent_id: null,
    model: null,
  };
  return { message, branch: null };
}

function live(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] };
}

const REPLY_WITH_CODE = [
  "Two ways:",
  "```python",
  "print('first')",
  "```",
  "or",
  "~~~",
  "echo second",
  "  indented",
  "~~~",
  "done.",
].join("\n");

describe("what the copy shortcuts copy", () => {
  it("finds the last fenced block, either fence, and an unclosed one to the end", () => {
    expect(lastCodeBlock(REPLY_WITH_CODE)).toBe("echo second\n  indented");
    expect(lastCodeBlock("no code here")).toBeNull();
    expect(lastCodeBlock("```js\nconst a = 1;\n``` \n")).toBe("const a = 1;");
    // A ``` line inside a ~~~ block is code, not a close.
    expect(lastCodeBlock("~~~\n```\nx\n~~~")).toBe("```\nx");
    expect(lastCodeBlock("```\nstill streaming")).toBe("still streaming");
  });

  it("searches back through the replies for the newest block", () => {
    expect(lastCodeIn(["```\nold\n```", "prose only"])).toBe("old");
    expect(lastCodeIn(["prose"])).toBeNull();
  });

  it("takes stored replies, and skips the one still streaming", () => {
    const branched = [
      stored("user", "u1", "hi"),
      stored("assistant", "a1", "first"),
      stored("assistant", "pending-2", "half"),
    ];
    expect(replyTexts(branched, [], false)).toEqual(["first"]);
    const messages = [live("user", "q"), live("assistant", "done"), live("assistant", "writing")];
    expect(replyTexts([], messages, false)).toEqual(["done", "writing"]);
    expect(replyTexts([], messages, true)).toEqual(["done"]);
  });
});

describe("ArrowUp in an empty composer", () => {
  const key = (over: Partial<Parameters<typeof isEditLastKey>[0]> = {}) => ({
    key: "ArrowUp",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...over,
  });

  it("means edit only in an empty box, unmodified, outside an IME composition", () => {
    expect(isEditLastKey(key(), "")).toBe(true);
    expect(isEditLastKey(key(), "draft")).toBe(false);
    expect(isEditLastKey(key({ shiftKey: true }), "")).toBe(false);
    expect(isEditLastKey(key({ isComposing: true }), "")).toBe(false);
    expect(isEditLastKey(key({ key: "ArrowDown" }), "")).toBe(false);
  });

  it("opens the reader's last stored turn", () => {
    expect(
      lastEditableId([
        stored("user", "u1", "one"),
        stored("assistant", "a1", "r"),
        stored("user", "u2", "two"),
        stored("assistant", "a2", "r"),
      ]),
    ).toBe("u2");
    expect(lastEditableId([stored("assistant", "a1", "r")])).toBeNull();
    expect(lastEditableId([])).toBeNull();
  });
});

describe("useCopyShortcuts", () => {
  function Host(props: { branched: BranchedMessage[] }) {
    const copied = useCopyShortcuts({ branched: props.branched, messages: [], busy: false });
    return (
      <>
        <textarea data-testid="box" />
        <p data-testid="status">{copied ?? ""}</p>
      </>
    );
  }

  const thread = [stored("user", "u1", "q"), stored("assistant", "a1", REPLY_WITH_CODE)];

  it("copies the last reply and the last code block, from the composer", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<Host branched={thread} />);
    const box = container!.querySelector("[data-testid='box']")!;
    const status = container!.querySelector("[data-testid='status']")!;

    const reply = await keydown(box, { key: "C", ctrlKey: true, shiftKey: true });
    expect(reply.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith(REPLY_WITH_CODE);
    expect(status.textContent).toBe("reply");

    const code = await keydown(box, { key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true });
    expect(code.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("echo second\n  indented");
    expect(status.textContent).toBe("code");
  });

  it("leaves the chords to the browser when there is nothing to copy", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<Host branched={[stored("user", "u1", "q"), stored("assistant", "a1", "prose")]} />);
    const code = await keydown(window, { key: ";", ctrlKey: true, shiftKey: true });
    expect(code.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does nothing while an IME composes", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<Host branched={thread} />);
    await keydown(window, { key: "C", ctrlKey: true, shiftKey: true, isComposing: true });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("the delete-conversation chord", () => {
  function shellWith(deleteConversation: ShellContextValue["deleteConversation"]) {
    return {
      activeConversationId: "c-1",
      conversations: [
        { id: "c-1", title: "Infra", created_at: "2026-09-01", updated_at: "2026-09-01" },
      ],
      deleteConversation,
    } as unknown as ShellContextValue;
  }

  function confirmButton(): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Delete",
    );
  }

  it("asks first, and deletes through the shell only on confirm", async () => {
    const deleteConversation = vi.fn(async () => {});
    render(
      <ShellContext.Provider value={shellWith(deleteConversation)}>
        <textarea data-testid="box" />
        <DeleteConversationShortcut conversationId="c-1" />
      </ShellContext.Provider>,
    );
    expect(confirmButton()).toBeUndefined();
    const box = container!.querySelector("[data-testid='box']")!;
    const chord = await keydown(box, { key: "Backspace", ctrlKey: true, shiftKey: true });
    expect(chord.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Delete this conversation?");
    expect(document.body.textContent).toContain("Infra");
    expect(deleteConversation).not.toHaveBeenCalled();

    await act(async () => {
      confirmButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(deleteConversation).toHaveBeenCalledExactlyOnceWith("c-1");
  });

  it("leaves the chord alone on a new chat, which has nothing to delete", async () => {
    const deleteConversation = vi.fn(async () => {});
    render(
      <ShellContext.Provider value={shellWith(deleteConversation)}>
        <DeleteConversationShortcut conversationId={null} />
      </ShellContext.Provider>,
    );
    const chord = await keydown(window, { key: "Backspace", ctrlKey: true, shiftKey: true });
    expect(chord.defaultPrevented).toBe(false);
    expect(confirmButton()).toBeUndefined();
  });
});
