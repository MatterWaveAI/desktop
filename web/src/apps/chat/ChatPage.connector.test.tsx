import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationSource, Message } from "../../types";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { ChatPage } from "./ChatPage";

/**
 * A connector's conversation -- one a Slack routing rule opened, answered
 * in its thread -- in the chat page: the notice stands where the composer
 * would, links to the thread, and offers the fork; a send the API refuses
 * as a connector's turns into the same notice. Same harness as
 * ChatPage.branch.test.tsx.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const SLACK: ConversationSource = {
  connector: "slack",
  connection_id: "conn-1",
  channel_label: "#support",
  url: "https://acme.slack.com/archives/C01/p1700000000000100",
};

const PARENT: Conversation = {
  id: "c-1",
  title: "Deploy question",
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

const QUESTION = message({ id: "u1", role: "user", content: "Is the deploy done?" });
const ANSWER = message({ id: "a1", role: "assistant", content: "It finished at noon.", parent_id: "u1" });

const created = vi.fn();

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

/** The API with `c-1` as a connector's conversation, or as a person's whose send the API refuses as one. */
function stub(mode: "sourced" | "stale"): { calls: string[] } {
  const calls: string[] = [];
  const source = mode === "sourced" ? SLACK : null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url} ${init?.body ?? ""}`.trim());
      let body: unknown = {};
      let status = 200;
      if (url.includes("/api/conversations/c-1?full=1")) {
        body = { ...PARENT, source, messages: [QUESTION, ANSWER], tree: [QUESTION, ANSWER], current_leaf_message_id: "a1", instructions: null };
      } else if (url.includes("/api/conversations/c-1/messages")) {
        status = 409;
        body = {
          detail: "This conversation is answered from slack in #support; reply there.",
          code: "connector_conversation",
          source: SLACK,
          request_id: "req-409",
        };
      } else if (url.includes("/api/conversations/c-1/tree")) {
        body = { ...PARENT, source, messages: [QUESTION, ANSWER] };
      } else if (url.includes("/api/conversations/c-1/fork")) {
        status = 201;
        body = { ...PARENT, id: "c-2", title: "Branch of Deploy question", source: null, messages: [QUESTION, ANSWER] };
      } else if (url.includes("/api/conversations/c-2?full=1")) {
        const copies = [
          { ...QUESTION, id: "u2", conversation_id: "c-2" },
          { ...ANSWER, id: "a2", conversation_id: "c-2", parent_id: "u2" },
        ];
        body = { ...PARENT, id: "c-2", title: "Branch of Deploy question", source: null, messages: copies, tree: copies, current_leaf_message_id: "a2", instructions: null };
      } else if (url.includes("/api/models")) {
        body = { data: [], default: null };
      } else if (url.includes("/api/org/presets")) {
        body = { data: [], tools: [], limits: {}, can_manage: false };
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

function notice(): HTMLElement | null {
  return container!.querySelector("[data-mw-connector-notice]");
}

function composer(): HTMLTextAreaElement | null {
  return container!.querySelector("[data-mw-composer]");
}

describe("a connector's conversation", () => {
  it("shows the notice in the composer's place, with the thread's link and the fork", async () => {
    stub("sourced");
    render();
    await flush();
    expect(container!.textContent).toContain("It finished at noon.");

    const note = notice()!;
    expect(note.textContent).toContain("Answered in Slack #support — reply in the thread");
    const link = note.querySelector<HTMLAnchorElement>("[data-mw-connector-open]")!;
    expect(link.textContent).toBe("Open in Slack");
    expect(link.getAttribute("href")).toBe(SLACK.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(note.querySelector("[data-mw-connector-fork]")?.textContent).toContain("Fork to continue here");
    // No message box: there is nowhere here for a reply to go.
    expect(composer()).toBeNull();
    // Nor an edit or regenerate on the stored messages, which the API would refuse the same way.
    const labels = [...container!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels.filter((label) => /^(Edit|Regenerate)/.test(label ?? ""))).toEqual([]);
  });

  it("has no link when the connector gave none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        const body = url.includes("/api/conversations/c-1?full=1")
          ? { ...PARENT, source: { ...SLACK, url: null }, messages: [QUESTION, ANSWER], tree: [QUESTION, ANSWER], current_leaf_message_id: "a1", instructions: null }
          : { data: [] };
        return Promise.resolve({ ok: true, status: 200, statusText: "", headers: new Headers(), json: () => Promise.resolve(body) } as Response);
      }),
    );
    render();
    await flush();
    expect(notice()!.textContent).toContain("Answered in Slack #support");
    expect(notice()!.querySelector("[data-mw-connector-open]")).toBeNull();
    expect(notice()!.querySelector("[data-mw-connector-fork]")).not.toBeNull();
  });

  it("forks from the notice at the leaf, and the copy takes messages", async () => {
    const { calls } = stub("sourced");
    render();
    await flush();

    await act(async () => {
      notice()!.querySelector<HTMLButtonElement>("[data-mw-connector-fork]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(calls).toContain('POST /api/conversations/c-1/fork {"message_id":"a1","title":"Branch of Deploy question"}');
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: "c-2" }));
    expect(location.search).toBe("?c=c-2");

    await flush();
    // The fork is a person's conversation: the composer is back, the notice gone.
    expect(notice()).toBeNull();
    expect(composer()).not.toBeNull();
    expect(container!.querySelector("[data-mw-branched-from]")?.textContent).toBe("Branched from Deploy question");
  });

  it("turns the API's 409 on a send into the same notice when the list was stale", async () => {
    const { calls } = stub("stale");
    render();
    await flush();
    expect(notice()).toBeNull();
    const box = composer()!;

    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(box, "Any news?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(calls.some((call) => call.startsWith("POST /api/conversations/c-1/messages"))).toBe(true);
    expect(notice()!.textContent).toContain("Answered in Slack #support — reply in the thread");
    expect(notice()!.querySelector("[data-mw-connector-open]")?.getAttribute("href")).toBe(SLACK.url);
    expect(composer()).toBeNull();
    // A refusal that names the thread is not a failed turn: no error, no Retry.
    expect(container!.querySelector("[data-mw-transcript-error]")).toBeNull();
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
  });
});
