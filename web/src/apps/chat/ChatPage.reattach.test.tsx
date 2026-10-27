import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "../../types";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { ChatPage } from "./ChatPage";

/**
 * A reload under a streaming answer. The server keeps what arrived when the
 * stream closes, a moment after the reloaded page reads the conversation;
 * the page looks again and shows the stored partial as stopped, with
 * Continue, rather than leaving the question unanswered.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const CONVERSATION: Conversation = {
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
const PARTIAL = {
  ...message({ id: "a1", role: "assistant", content: "The outage began when", parent_id: "u1" }),
  truncated: true,
  finish_reason: null,
} as Message;

function shell(): ShellContextValue {
  return {
    authConfig: { mode: "none", csrf_cookie: "mw_csrf" },
    principal: { subject: "u", kind: "user", roles: [], org_id: "o", org_name: null, org_role: null },
    conversations: [CONVERSATION],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: "c-1",
    selectConversation: () => undefined,
    deleteConversation: async () => undefined,
    setPinned: async () => undefined,
    setArchived: async () => undefined,
    listFilter: "default",
    setListFilter: () => undefined,
    onConversationCreated: () => undefined,
    onConversationRenamed: () => undefined,
    reloadConversations: async () => undefined,
    signOut: async () => undefined,
  } as unknown as ShellContextValue;
}

function stub(transcripts: Message[][]): { reads: () => number } {
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      let body: unknown = {};
      if (url.includes("/api/conversations/c-1?full=1")) {
        const messages = transcripts[Math.min(reads, transcripts.length - 1)];
        reads += 1;
        body = {
          ...CONVERSATION,
          messages,
          tree: messages,
          current_leaf_message_id: messages.at(-1)?.id ?? null,
          instructions: null,
        };
      } else if (url.includes("/api/models")) {
        body = { data: [], default: null };
      } else if (url.includes("/feedback")) {
        body = { data: [] };
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
  return { reads: () => reads };
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  // jsdom lays nothing out and has no scrolling.
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  vi.useFakeTimers();
  history.replaceState(null, "", "/apps/chat?c=c-1");
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
    root!.render(
      <ShellContext.Provider value={shell()}>
        <ChatPage />
      </ShellContext.Provider>,
    );
  });
}

describe("reloading under a streaming answer", () => {
  it("looks again and shows the stored partial reply as stopped, with Continue", async () => {
    const { reads } = stub([[QUESTION], [QUESTION, PARTIAL]]);
    render();
    await flush();
    expect(container!.textContent).toContain("Explain the outage");
    expect(container!.querySelector("[data-mw-reattaching]")).not.toBeNull();

    await flush(1_000);
    expect(reads()).toBe(2);
    expect(container!.textContent).toContain("The outage began when");
    expect(container!.querySelector("[data-mw-reattaching]")).toBeNull();
    const stopped = container!.querySelector("[data-mw-stopped]");
    expect(stopped?.textContent).toContain("Continue");
    // Quiet, not the red cut-off alert.
    expect(container!.querySelector("[data-error-kind='truncated']")).toBeNull();
  });

  it("gives up after a few looks and leaves the turn as it is", async () => {
    const { reads } = stub([[QUESTION]]);
    render();
    await flush();
    await flush(30_000);
    expect(reads()).toBe(5);
    expect(container!.querySelector("[data-mw-reattaching]")).toBeNull();
  });
});
