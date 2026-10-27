import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Conversation, Principal } from "../types";
import { ConversationSidebar } from "./conversationSidebar";
import { useShellState } from "./useShellState";
import { ShellContext, type ShellContextValue } from "./shellContext";
import { groupConversations } from "./conversationGroups";

/**
 * The address and the open conversation agree: a new chat's id lands in
 * `?c=` so a reload reopens it, a switch is a history entry so Back returns
 * to the conversation before, and the drawer gets out of the way. Same
 * harness as conversationSidebar.test.tsx.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let shellRef: ShellContextValue | null = null;

const PRINCIPAL: Principal = {
  subject: "dev-user",
  kind: "user",
  email: "dev@example.com",
  name: "Dev",
  roles: [],
  org_id: "dev-org",
  org_name: null,
  org_role: null,
};
const AUTH_CONFIG = { mode: "none" } as unknown as AuthConfig;

function conversation(over: Partial<Conversation> & { id: string; title: string }): Conversation {
  return {
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
    pinned_at: null,
    archived_at: null,
    ...over,
  };
}

function Harness(props: { onNavigate?: () => void }) {
  const context = useShellState({ authConfig: AUTH_CONFIG, principal: PRINCIPAL });
  // eslint-disable-next-line react-hooks/globals -- the test reads the live context back
  shellRef = context;
  return (
    <ShellContext.Provider value={context}>
      <ConversationSidebar onNavigate={props.onNavigate} />
    </ShellContext.Provider>
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

function stubList(rows: Conversation[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      const body = url.includes("/api/conversations") ? { data: rows } : {};
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function rowLink(title: string): HTMLAnchorElement {
  return container!.querySelector<HTMLAnchorElement>(`a[title="${title}"]`)!;
}

beforeEach(() => {
  history.replaceState(null, "", "/apps/chat");
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  shellRef = null;
  vi.unstubAllGlobals();
});

const ROWS = [conversation({ id: "a", title: "Alpha" }), conversation({ id: "b", title: "Beta" })];

describe("the address follows the open conversation", () => {
  it("a new conversation puts ?c= on the address without adding a history entry", async () => {
    stubList([]);
    render(<Harness />);
    await settle();
    const depth = history.length;

    act(() => {
      shellRef!.onConversationCreated(conversation({ id: "new-1", title: "New chat" }));
    });

    expect(location.search).toBe("?c=new-1");
    expect(history.length).toBe(depth);
  });

  it("a row click pushes, marks the row current and closes the drawer; Back reselects", async () => {
    stubList(ROWS);
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    await settle();
    const depth = history.length;

    act(() => click(rowLink("Alpha")));
    expect(location.search).toBe("?c=a");
    expect(history.length).toBe(depth + 1);
    expect(rowLink("Alpha").getAttribute("aria-current")).toBe("page");
    expect(rowLink("Beta").hasAttribute("aria-current")).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    act(() => click(rowLink("Beta")));
    expect(location.search).toBe("?c=b");

    // What Back does to the address, then the event it fires.
    history.replaceState(null, "", "/apps/chat?c=a");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(shellRef!.activeConversationId).toBe("a");
    expect(rowLink("Alpha").getAttribute("aria-current")).toBe("page");
  });

  it("Cancel on the delete confirm keeps the row and sends nothing", async () => {
    const { calls } = stubList(ROWS);
    render(<Harness />);
    await settle();

    const trigger = document.querySelector<HTMLElement>('[aria-label="Actions for Alpha"]')!;
    act(() => click(trigger));
    act(() => click(document.querySelector<HTMLElement>('[aria-label="Delete Alpha"]')!));
    expect(document.body.textContent).toContain("Delete this conversation?");
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === "Cancel",
    )!;
    await act(async () => click(cancel));
    await settle();

    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(rowLink("Alpha")).not.toBeNull();
  });
});

describe("the sidebar search box", () => {
  it("draws the same 2px focus ring as the other inputs, not a border tint alone", async () => {
    stubList([]);
    render(<Harness />);
    await settle();
    const search = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.className).toContain("focus-visible:ring-2");
  });
});

describe("the list's day headings", () => {
  const now = new Date(2026, 9, 22, 15, 0);
  const at = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it("cuts the server's order into Pinned, Today, Yesterday and older runs", () => {
    const groups = groupConversations(
      [
        conversation({ id: "p", title: "P", pinned_at: at(40), updated_at: at(40) }),
        conversation({ id: "t", title: "T", updated_at: at(0) }),
        conversation({ id: "y", title: "Y", updated_at: at(1) }),
        conversation({ id: "w", title: "W", updated_at: at(4) }),
        conversation({ id: "m", title: "M", updated_at: at(20) }),
        conversation({ id: "o", title: "O", updated_at: at(90) }),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Pinned", ["p"]],
      ["Today", ["t"]],
      ["Yesterday", ["y"]],
      ["Previous 7 days", ["w"]],
      ["Previous 30 days", ["m"]],
      ["Older", ["o"]],
    ]);
  });

  it("draws the headings over the rows", async () => {
    stubList([
      conversation({ id: "t", title: "Fresh", updated_at: new Date().toISOString() }),
      conversation({ id: "o", title: "Stale", updated_at: "2020-01-01T00:00:00+00:00" }),
    ]);
    render(<Harness />);
    await settle();
    const headings = [...container!.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Today", "Older"]);
  });
});
