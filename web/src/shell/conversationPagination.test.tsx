import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Conversation, Principal } from "../types";
import { ConversationSidebar } from "./conversationSidebar";
import { useShellState } from "./useShellState";
import { ShellContext } from "./shellContext";

/**
 * The list is one page at a time: the shell keeps the server's cursor,
 * the sidebar ends in "Load more" while there is one, and a later page is
 * appended under the rows already shown. Same harness as
 * conversationSidebar.test.tsx - react-dom/client plus act.
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

function conversation(over: Partial<Conversation> & { id: string; title: string }): Conversation {
  return {
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
    pinned_at: null,
    archived_at: null,
    ...over,
  };
}

const PRINCIPAL: Principal = {
  subject: "dev-user",
  kind: "user",
  name: "Dev",
  email: "dev@example.test",
  roles: [],
  org_id: "dev-org",
  org_name: null,
  org_role: null,
};

const AUTH_CONFIG = { mode: "none" } as unknown as AuthConfig;

interface Page {
  data: Conversation[];
  next_cursor: string | null;
}

/**
 * Stub `fetch` with one page per cursor: the first request (no cursor) gets
 * `pages[""]`, a request carrying `cursor=X` gets `pages[X]`. Everything
 * else (the library read) answers an empty list.
 */
function stubPages(
  pages: Record<string, Page | { status: number }>,
): { calls: string[]; listCalls: () => string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      let body: unknown = { data: [], folders: [], tags: [], assignments: {} };
      let status = 200;
      if (url.includes("/api/conversations?")) {
        const cursor = new URL(url, "http://sidebar.test").searchParams.get("cursor") ?? "";
        const page = pages[cursor];
        if (page && "status" in page) status = page.status;
        else body = page ?? { data: [], next_cursor: null };
      }
      return Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers({ "X-Request-Id": "req-page" }),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
  return {
    calls,
    listCalls: () => calls.filter((c) => c.includes("/api/conversations?")),
  };
}

function Harness() {
  const context = useShellState({ authConfig: AUTH_CONFIG, principal: PRINCIPAL });
  return (
    <ShellContext.Provider value={context}>
      <ConversationSidebar />
    </ShellContext.Provider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The row titles, in list order: each row's link carries its title. */
function titles(): string[] {
  const list = container?.querySelector('[aria-label="Conversations"]');
  return Array.from(list?.querySelectorAll("li > a[title]") ?? []).map(
    (a) => a.getAttribute("title") ?? "",
  );
}

function loadMoreButton(): HTMLButtonElement | null {
  return (
    Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      /^Load(ing)? more/.test(b.textContent ?? ""),
    ) ?? null
  );
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("paging the conversation list", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  it("loads the first page, keeps its cursor, and appends the next page in order", async () => {
    const { listCalls } = stubPages({
      "": {
        data: [conversation({ id: "a", title: "Alpha" }), conversation({ id: "b", title: "Beta" })],
        next_cursor: "cur-1",
      },
      "cur-1": {
        data: [conversation({ id: "c", title: "Gamma" }), conversation({ id: "d", title: "Delta" })],
        next_cursor: "cur-2",
      },
      "cur-2": { data: [conversation({ id: "e", title: "Epsilon" })], next_cursor: null },
    });
    render(<Harness />);
    await settle();
    expect(titles()).toEqual(["Alpha", "Beta"]);
    expect(loadMoreButton()).not.toBeNull();

    click(loadMoreButton()!);
    await settle();
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(listCalls()[1]).toContain("cursor=cur-1");
    expect(listCalls()[1]).toContain("filter=default");

    click(loadMoreButton()!);
    await settle();
    expect(titles()).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
    // The last page is in: nothing left to ask for, and no control to ask with.
    expect(loadMoreButton()).toBeNull();
    expect(listCalls()).toHaveLength(3);
  });

  it("shows no control when the first page is the whole list", async () => {
    stubPages({ "": { data: [conversation({ id: "a", title: "Alpha" })], next_cursor: null } });
    render(<Harness />);
    await settle();
    expect(titles()).toHaveLength(1);
    expect(loadMoreButton()).toBeNull();
  });

  it("shows a row once when the next page repeats one that moved up the list", async () => {
    stubPages({
      "": { data: [conversation({ id: "a", title: "Alpha" })], next_cursor: "cur-1" },
      "cur-1": {
        data: [conversation({ id: "a", title: "Alpha" }), conversation({ id: "b", title: "Beta" })],
        next_cursor: null,
      },
    });
    render(<Harness />);
    await settle();
    click(loadMoreButton()!);
    await settle();
    expect(titles()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps the control for a retry when the next page fails", async () => {
    stubPages({
      "": { data: [conversation({ id: "a", title: "Alpha" })], next_cursor: "cur-1" },
      "cur-1": { status: 503 },
    });
    render(<Harness />);
    await settle();
    click(loadMoreButton()!);
    await settle();
    expect(titles()).toHaveLength(1);
    expect(container?.textContent).toContain("More could not be loaded.");
    expect(loadMoreButton()).not.toBeNull();
    expect(loadMoreButton()!.disabled).toBe(false);
  });
});
