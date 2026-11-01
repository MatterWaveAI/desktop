import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message, Preset } from "../../types";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { ChatPage } from "./ChatPage";

/**
 * A preset in the composer: a stored conversation on one opens with its
 * name in the preset box and its model fixed in the model box; a new
 * chat shows the picked preset's welcome message in the empty state and
 * creates the conversation on it. Same harness as ChatPage.branch.test.tsx.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const SUPPORT: Preset = {
  id: "p-support",
  name: "Support desk",
  description: "Answers customer questions.",
  model: "grt-nano-pro",
  instructions: "Be brief.",
  tools: ["web_search"],
  welcome_message: "Hello! Ask me about your account.",
  created_by: "u",
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-01T00:00:00+00:00",
  deleted_at: null,
};

const ON_PRESET: Conversation = {
  id: "c-1",
  title: "Billing",
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-01T00:00:00+00:00",
  pinned_at: null,
  archived_at: null,
  preset_id: SUPPORT.id,
  preset: { id: SUPPORT.id, name: SUPPORT.name },
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

const QUESTION = message({ id: "u1", role: "user", content: "Why was I charged twice?" });
const ANSWER = message({ id: "a1", role: "assistant", content: "Two invoices overlapped.", parent_id: "u1" });

const MODELS = {
  object: "list",
  default_model: "grt-nano",
  data: [
    { id: "grt-nano", label: "GRT Nano", context_window: 8192, research_preview: false, multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, included: true, upgrade_to: null, partner: false },
    { id: "grt-nano-pro", label: "GRT Nano Pro", context_window: 8192, research_preview: false, multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2, included: true, upgrade_to: null, partner: false },
  ],
};

function Harness(props: { active: string | null }) {
  const value = {
    authConfig: { mode: "none", csrf_cookie: "mw_csrf" },
    principal: { subject: "u", kind: "user", roles: [], org_id: "o", org_name: null, org_role: "member" },
    conversations: [ON_PRESET],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: props.active,
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
  return (
    <ShellContext.Provider value={value}>
      <ChatPage />
    </ShellContext.Provider>
  );
}

function stub(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url} ${init?.body ?? ""}`.trim());
      let body: unknown = {};
      if (url.includes("/api/conversations/c-1?full=1")) {
        body = { ...ON_PRESET, messages: [QUESTION, ANSWER], tree: [QUESTION, ANSWER], current_leaf_message_id: "a1", instructions: null };
      } else if (url === "/api/org/presets") {
        body = { data: [SUPPORT], tools: [], limits: {}, can_manage: false };
      } else if (url.includes("/api/models")) {
        body = MODELS;
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
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(active: string | null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness active={active} />);
  });
}

function presetBox(): HTMLSelectElement | null {
  return container!.querySelector<HTMLSelectElement>("[data-mw-preset-picker]");
}

function modelBox(): HTMLSelectElement {
  return container!.querySelector<HTMLSelectElement>("select[aria-label='Model']")!;
}

function shown(select: HTMLSelectElement): string | undefined {
  return select.selectedOptions[0]?.textContent ?? undefined;
}

describe("a preset in the composer", () => {
  it("opens a stored conversation with its preset named and its model fixed", async () => {
    stub();
    history.replaceState(null, "", "/apps/chat?c=c-1");
    render("c-1");
    await flush();
    await flush();
    expect(container!.textContent).toContain("Two invoices overlapped.");
    expect(shown(presetBox()!)).toBe("Support desk");
    expect(shown(modelBox())).toBe("GRT Nano Pro");
    expect(modelBox().hasAttribute("data-mw-model-fixed")).toBe(true);
  });

  it("shows the picked preset's welcome message on a new chat and fixes its model", async () => {
    stub();
    history.replaceState(null, "", "/apps/chat");
    render(null);
    await flush();
    await flush();
    expect(container!.textContent).toContain("MatterWave is a chat workspace");
    expect(modelBox().hasAttribute("data-mw-model-fixed")).toBe(false);

    const select = presetBox()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(select, "p-support");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(shown(presetBox()!)).toBe("Support desk");
    expect(container!.querySelector("[data-mw-preset-welcome]")!.textContent).toBe("Hello! Ask me about your account.");
    expect(container!.textContent).not.toContain("MatterWave is a chat workspace");
    expect(shown(modelBox())).toBe("GRT Nano Pro");
    expect(modelBox().hasAttribute("data-mw-model-fixed")).toBe(true);
  });
});
