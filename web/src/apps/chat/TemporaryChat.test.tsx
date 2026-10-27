import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatModelAdapter } from "./chatAdapter";
import { createChatAdapter } from "./chatAdapter";
import { ConversationActions } from "./ConversationActions";
import {
  TEMPORARY_NOTICE_TEXT,
  TemporaryNotice,
  TemporaryToggle,
} from "./TemporaryChat";

/**
 * Temporary chat in the web client: the switch on a new chat, the notice in
 * the thread, the share item that a temporary thread does not offer, and
 * the create request the switch turns into. Same harness as
 * ChatStates.test.tsx: react-dom/client plus act.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("TemporaryToggle", () => {
  it("is a pressed-state button that reports the opposite of its state", () => {
    const onChange = vi.fn();
    render(<TemporaryToggle on={false} onChange={onChange} />);
    const button = container!.querySelector("[data-mw-temporary-toggle]")!;
    expect(button.textContent).toContain("Temporary");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    click(button);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows on and turns off", () => {
    const onChange = vi.fn();
    render(<TemporaryToggle on onChange={onChange} />);
    const button = container!.querySelector("[data-mw-temporary-toggle]")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    click(button);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does nothing while disabled", () => {
    const onChange = vi.fn();
    render(<TemporaryToggle on={false} disabled onChange={onChange} />);
    click(container!.querySelector("[data-mw-temporary-toggle]")!);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TemporaryNotice", () => {
  it("says the chat will not be saved and when it goes", () => {
    render(<TemporaryNotice />);
    const notice = container!.querySelector("[data-mw-temporary-notice]")!;
    expect(notice.getAttribute("role")).toBe("note");
    expect(notice.textContent).toBe(TEMPORARY_NOTICE_TEXT);
    expect(notice.textContent).toMatch(/won't appear in your history/);
    expect(notice.textContent).toMatch(/24 hours/);
  });
});

describe("ConversationActions on a temporary thread", () => {
  function items(): string[] {
    return Array.from(document.querySelectorAll("[role=menuitem]")).map(
      (item) => item.textContent ?? "",
    );
  }

  it("offers Share only when the page passes it", () => {
    render(
      <ConversationActions
        busy={false}
        onExport={vi.fn()}
        onReport={vi.fn()}
      />,
    );
    click(container!.querySelector("button")!);
    expect(items().some((text) => text.startsWith("Share"))).toBe(false);
    expect(items().some((text) => text.startsWith("Export"))).toBe(true);
  });

  it("still offers Share on a kept thread", () => {
    render(
      <ConversationActions
        busy={false}
        onShare={vi.fn()}
        onExport={vi.fn()}
        onReport={vi.fn()}
      />,
    );
    click(container!.querySelector("button")!);
    expect(items().some((text) => text.startsWith("Share"))).toBe(true);
  });
});

describe("the create request", () => {
  async function createBody(getTemporary?: () => boolean): Promise<unknown> {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/conversations") {
          bodies.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            status: 201,
            statusText: "Created",
            json: async () => ({
              id: "c1",
              title: "New chat",
              created_at: "",
              updated_at: "",
            }),
          };
        }
        // The send itself fails at once; only the create is under test.
        return {
          ok: false,
          status: 500,
          statusText: "",
          json: async () => ({ detail: "x" }),
        };
      }),
    );
    const adapter = createChatAdapter({
      getConversationId: () => null,
      getModel: () => null,
      getTemporary,
      onConversationCreated: vi.fn(),
      onRenamed: vi.fn(),
      onSettled: vi.fn(),
      onError: vi.fn(),
    });
    const run = adapter.run({
      messages: [
        { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      abortSignal: new AbortController().signal,
    } as unknown as Parameters<ChatModelAdapter["run"]>[0]) as AsyncGenerator<
      unknown,
      void
    >;
    try {
      for await (const _ of run) void _;
    } catch {
      // The failed send is reported through onError; nothing to assert here.
    }
    return bodies[0];
  }

  it("asks for a temporary conversation when the switch is on", async () => {
    expect(await createBody(() => true)).toEqual({
      title: "New chat",
      temporary: true,
    });
  });

  it("sends the unchanged body for a kept chat", async () => {
    expect(await createBody(() => false)).toEqual({ title: "New chat" });
    expect(await createBody()).toEqual({ title: "New chat" });
  });
});
