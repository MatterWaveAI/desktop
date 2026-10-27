import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "../../types";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { ChatPage } from "./ChatPage";

/**
 * Branch from here: the path down to a message becomes a conversation of
 * its own, the page moves onto it, and the new one says where it came
 * from. Same harness as ChatPage.reattach.test.tsx, with a shell whose
 * open conversation can change the way the real one's does.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const PARENT: Conversation = {
  id: "c-1",
  title: "Infra",
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-01T00:00:00+00:00",
  pinned_at: null,
  archived_at: null,
};

function message(over: Partial<Message> & { id: string; role: Message["role"] }): Message {
  return {
    conversation_id: "c-1",
    content: "",
    model: null,
    parent_id: null,
    created_at: "2026-10-01T00:00:00+00:00",
    ...over,
  } as Message;
}

const QUESTION = message({ id: "u1", role: "user", content: "Explain the outage" });
const ANSWER = message({ id: "a1", role: "assistant", content: "It began at noon.", parent_id: "u1" });

const created = vi.fn();

/** The shell in miniature: the open conversation is state, as in the real one. */
function Harness() {
  const [active, setActive] = useState<string | null>("c-1");
  const [conversations, setConversations] = useState<Conversation[]>([PARENT]);
  const value = {
    authConfig: { mode: "none", csrf_cookie: "mw_csrf" },
    principal: { subject: "u", kind: "user", roles: [], org_id: "o", org_name: null, org_role: null },
    conversations,
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: active,
    selectConversation: setActive,
    deleteConversation: async () => undefined,
    setPinned: async () => undefined,
    setArchived: async () => undefined,
    listFilter: "default",
    setListFilter: () => undefined,
    onConversationCreated: (conversation: Conversation) => {
      created(conversation);
      setActive(conversation.id);
      setConversations((list) => [conversation, ...list]);
    },
    onConversationRenamed: () => undefined,
    reloadConversations: async () => undefined,
    signOut: async () => undefined,
  } as unknown as ShellContextValue;
  return (
    <ShellContext.Provider value={value}>
      <ChatPage />
    </ShellContext.Provider>
  );
}

function stub(forkStatus = 201): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url} ${init?.body ?? ""}`.trim());
      let body: unknown = {};
      let status = 200;
      if (url.includes("/api/conversations/c-1?full=1")) {
        body = { ...PARENT, messages: [QUESTION, ANSWER], tree: [QUESTION, ANSWER], current_leaf_message_id: "a1", instructions: null };
      } else if (url.includes("/api/conversations/c-1/fork")) {
        status = forkStatus;
        body =
          forkStatus === 201
            ? { ...PARENT, id: "c-2", title: "Branch of Infra", messages: [QUESTION, ANSWER] }
            : { detail: "A temporary conversation cannot be forked" };
      } else if (url.includes("/api/conversations/c-2?full=1")) {
        const copies = [
          { ...QUESTION, id: "u2", conversation_id: "c-2" },
          { ...ANSWER, id: "a2", conversation_id: "c-2", parent_id: "u2" },
        ];
        body = { ...PARENT, id: "c-2", title: "Branch of Infra", messages: copies, tree: copies, current_leaf_message_id: "a2", instructions: null };
      } else if (url.includes("/api/models")) {
        body = { data: [], default: null };
      } else if (url.includes("/feedback")) {
        body = { data: [] };
      }
      return Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
  return { calls };
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  vi.useFakeTimers();
  history.replaceState(null, "", "/apps/chat?c=c-1");
  created.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
}

/** The reply's Branch from here: every stored message has one, the last is the reply's. */
function branchButton(): HTMLButtonElement {
  const buttons = [...container!.querySelectorAll("button")].filter(
    (b) => b.textContent === "Branch from here",
  );
  expect(buttons).toHaveLength(2);
  return buttons[1];
}

describe("Branch from here", () => {
  it("forks at the message, opens the copy, and says where it came from", async () => {
    const { calls } = stub();
    render();
    await flush();
    expect(container!.textContent).toContain("It began at noon.");

    await act(async () => {
      branchButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(calls).toContain(
      'POST /api/conversations/c-1/fork {"message_id":"a1","title":"Branch of Infra"}',
    );
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: "c-2", title: "Branch of Infra" }));
    // Back returns to the original: the copy was pushed, not swapped in.
    expect(location.search).toBe("?c=c-2");

    await flush();
    const note = container!.querySelector("[data-mw-branched-from]")!;
    expect(note.textContent).toBe("Branched from Infra");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/apps/chat?c=c-1");
  });

  it("says so in the thread when the fork is refused, and stays put", async () => {
    stub(409);
    render();
    await flush();
    await act(async () => {
      branchButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(created).not.toHaveBeenCalled();
    expect(location.search).toBe("?c=c-1");
    expect(container!.querySelector("[data-mw-thread-notice]")?.textContent).toContain(
      "Could not branch the conversation",
    );
  });
});
