import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Conversation, Principal } from "../types";
import { ConversationSidebar } from "./conversationSidebar";
import { useShellState } from "./useShellState";
import { ShellContext } from "./shellContext";
import { splitSnippet, SNIPPET_CLOSE, SNIPPET_OPEN } from "./searchSnippet";
import { SEARCH_DEBOUNCE_MS } from "./useConversationSearch";

/**
 * The sidebar's search box, the highlight, and the pin and
 * archive actions. Same harness as ChatStates.test.tsx - react-dom/client
 * plus act, no testing-library.
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
  vi.useRealTimers();
});

function text(): string {
  return container?.textContent ?? "";
}

/**
 * The element named `label`, anywhere in the document: the row menu is
 * portalled out of the sidebar. A row action ("Pin Infra", "Add tag x on
 * Infra") lives in that row's menu, so when it is not on screen the row's
 * "Actions for …" button is pressed first, the way a person would.
 */
function byLabel(label: string): HTMLElement | null {
  const find = () => document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`);
  const found = find();
  if (found) return found;
  const title =
    /^(?:Pin|Unpin|Rename|Archive|Unarchive|Delete) (.+)$/.exec(label)?.[1] ??
    /^(?:Add|Remove) tag .+ on (.+)$/.exec(label)?.[1] ??
    /^New (?:folder|tag) for (.+)$/.exec(label)?.[1];
  const trigger = title
    ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(`Actions for ${title}`)}"]`)
    : null;
  if (!trigger) return null;
  // flushSync, not act: this is called from inside a test's own act, where
  // a nested act would hold the open back until the outer one ends.
  flushSync(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return find();
}

/** The row's open menu, for a test that picks an item by its text. */
function openActions(title: string): HTMLElement {
  const trigger = byLabel(`Actions for ${title}`)!;
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return document.querySelector<HTMLElement>(`[role="dialog"][aria-label="Actions for ${title}"]`)!;
}

/** The delete confirm's own Delete button, in the dialog's portal. */
async function confirmDelete(): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (b) => b.textContent === "Delete",
  )!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function conversation(over: Partial<Conversation> & { id: string; title: string }): Conversation {
  return {
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
    pinned_at: null,
    archived_at: null,
    ...over,
  };
}

describe("splitSnippet", () => {
  it("splits the marked run out so it can be rendered as a mark element, not as HTML", () => {
    const parts = splitSnippet(`the ${SNIPPET_OPEN}velocity${SNIPPET_CLOSE} report`);
    expect(parts).toEqual([
      { text: "the ", match: false },
      { text: "velocity", match: true },
      { text: " report", match: false },
    ]);
  });

  it("handles several marked runs, which ts_headline emits for a multi-word query", () => {
    const parts = splitSnippet(
      `${SNIPPET_OPEN}velocity${SNIPPET_CLOSE} and ${SNIPPET_OPEN}report${SNIPPET_CLOSE}`,
    );
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["velocity", "report"]);
  });

  it("treats a stray delimiter as ordinary text rather than losing the snippet", () => {
    expect(splitSnippet(`unterminated ${SNIPPET_OPEN}match`)).toEqual([
      { text: `unterminated ${SNIPPET_OPEN}match`, match: false },
    ]);
    expect(splitSnippet("no markers at all")).toEqual([
      { text: "no markers at all", match: false },
    ]);
  });

  it("does not produce HTML: markup in a message body stays text", () => {
    const parts = splitSnippet(`${SNIPPET_OPEN}<img onerror=x>${SNIPPET_CLOSE}`);
    expect(parts).toEqual([{ text: "<img onerror=x>", match: true }]);
  });
});

// --- the sidebar, through the real Shell ------------------------------------

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

interface Route {
  body: unknown;
  status?: number;
  /** Response headers, so the X-Request-Id path can be driven. */
  headers?: Record<string, string>;
}

/** Stub `fetch`, keyed by the first route pattern the URL contains. */
function stubFetch(routes: Record<string, Route>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      const key = Object.keys(routes).find((pattern) => url.includes(pattern));
      const route = key ? routes[key] : undefined;
      return Promise.resolve({
        ok: (route?.status ?? 200) < 400,
        status: route?.status ?? 200,
        statusText: "",
        headers: new Headers(route?.headers ?? {}),
        json: () => Promise.resolve(route?.body ?? { data: [] }),
      } as Response);
    }),
  );
  return { calls };
}

/**
 * The sidebar over the REAL shell state -- the loader, the filter, pin and
 * archive are the shipped ones. Only `<Outlet>` is left out, because it needs
 * a router and the sidebar has nothing to do with routing.
 */
function SidebarHarness() {
  const context = useShellState({ authConfig: AUTH_CONFIG, principal: PRINCIPAL });
  return (
    <ShellContext.Provider value={context}>
      <ConversationSidebar />
    </ShellContext.Provider>
  );
}

function renderShell() {
  render(<SidebarHarness />);
}

/** Let the pending fetch promises settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeInSearch(value: string): void {
  const input = byLabel("Search conversations") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("the conversation sidebar", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  it("shows the search field above the list", async () => {
    stubFetch({
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();

    expect(byLabel("Search conversations")).not.toBeNull();
    expect(text()).toContain("Infra");
  });

  it("asks the default filter for the list, so an archived row is never in it", async () => {
    const { calls } = stubFetch({ "/api/conversations": { body: { data: [] } } });
    renderShell();
    await settle();

    expect(calls.some((c) => c.includes("/api/conversations?filter=default"))).toBe(true);
  });

  it("marks a pinned conversation with an icon", async () => {
    stubFetch({
      "/api/conversations": {
        body: {
          data: [
            conversation({ id: "p", title: "Pinned one", pinned_at: "2026-09-02T00:00:00+00:00" }),
          ],
        },
      },
    });
    renderShell();
    await settle();

    // The pin toggle reads "Unpin" for a row that is already pinned.
    expect(byLabel("Unpin Pinned one")).not.toBeNull();
    expect(byLabel("Pin Pinned one")).toBeNull();
  });

  it("pins through PUT and unpins through DELETE, so a retry is idempotent", async () => {
    const row = conversation({ id: "a", title: "Infra" });
    const { calls } = stubFetch({
      "/api/conversations/a/pin": { body: { ...row, pinned_at: "2026-09-03T00:00:00+00:00" } },
      "/api/conversations": { body: { data: [row] } },
    });
    renderShell();
    await settle();

    await act(async () => {
      click(byLabel("Pin Infra")!);
    });
    await settle();

    expect(calls).toContain("PUT /api/conversations/a/pin");
    // The server's answer replaced the row, so the icon flipped.
    expect(byLabel("Unpin Infra")).not.toBeNull();

    await act(async () => {
      click(byLabel("Unpin Infra")!);
    });
    await settle();
    expect(calls).toContain("DELETE /api/conversations/a/pin");
  });

  it("archives through PUT and drops the row out of the default list", async () => {
    const row = conversation({ id: "a", title: "Infra" });
    const { calls } = stubFetch({
      "/api/conversations/a/archive": {
        body: { ...row, archived_at: "2026-09-03T00:00:00+00:00" },
      },
      "/api/conversations": { body: { data: [row] } },
    });
    renderShell();
    await settle();
    expect(text()).toContain("Infra");

    await act(async () => {
      click(byLabel("Archive Infra")!);
    });
    await settle();

    expect(calls).toContain("PUT /api/conversations/a/archive");
    // Archive is not delete: nothing was DELETEd on the conversation itself.
    expect(calls.some((c) => c === "DELETE /api/conversations/a")).toBe(false);
  });

  // --- rename, in the row ---------------------------------------------------

  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** The bodies of every PATCH the stubbed fetch saw, parsed. */
  function patched(): Array<Record<string, unknown>> {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  }

  async function openRename(title: string): Promise<HTMLInputElement> {
    await act(async () => {
      click(byLabel(`Rename ${title}`)!);
    });
    const input = byLabel(`New name for ${title}`) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(title);
    return input;
  }

  it("renames in the row: Enter saves through PATCH and the row shows the new name", async () => {
    const row = conversation({ id: "a", title: "Infra" });
    const { calls } = stubFetch({
      "/api/conversations/a": { body: { ...row, title: "Infra notes" } },
      "/api/conversations": { body: { data: [row] } },
    });
    renderShell();
    await settle();

    const input = await openRename("Infra");
    typeInto(input, "  Infra notes ");
    await act(async () => {
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(calls).toContain("PATCH /api/conversations/a");
    expect(patched()).toEqual([{ title: "Infra notes" }]);
    expect(byLabel("New name for Infra")).toBeNull();
    expect(text()).toContain("Infra notes");
    expect(byLabel("Rename Infra notes")).not.toBeNull();
  });

  it("Escape cancels without a request, and an unchanged name sends nothing", async () => {
    const row = conversation({ id: "a", title: "Infra" });
    const { calls } = stubFetch({ "/api/conversations": { body: { data: [row] } } });
    renderShell();
    await settle();

    const input = await openRename("Infra");
    typeInto(input, "Something else");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(byLabel("New name for Infra")).toBeNull();
    expect(text()).toContain("Infra");
    expect(text()).not.toContain("Something else");

    const again = await openRename("Infra");
    await act(async () => {
      again.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(byLabel("New name for Infra")).toBeNull();
    expect(calls.some((c) => c.startsWith("PATCH"))).toBe(false);
  });

  it("blur saves, and a refusal puts the old name back and says so", async () => {
    const row = conversation({ id: "a", title: "Infra" });
    stubFetch({
      "/api/conversations/a": {
        status: 422,
        body: { detail: "title must not be empty", request_id: "req-1" },
      },
      "/api/conversations": { body: { data: [row] } },
    });
    renderShell();
    await settle();

    const input = await openRename("Infra");
    typeInto(input, "Renamed by blur");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    // Optimistic: the row carries the new name while the request is out.
    expect(patched()).toEqual([{ title: "Renamed by blur" }]);
    await settle();

    // Reverted, with the server's reason beside the row.
    expect(text()).toContain("Infra");
    expect(text()).not.toContain("Renamed by blur");
    expect(container!.querySelector("[role='alert']")?.textContent).toContain(
      "title must not be empty",
    );
  });

  it("keeps archived conversations behind a section that only fetches when opened", async () => {
    const { calls } = stubFetch({
      "filter=archived": {
        body: {
          data: [
            conversation({
              id: "z",
              title: "Filed away",
              archived_at: "2026-09-02T00:00:00+00:00",
            }),
          ],
        },
      },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();

    // Closed: one line, and no request for the archive.
    expect(text()).toContain("Archived");
    expect(text()).not.toContain("Filed away");
    expect(calls.some((c) => c.includes("filter=archived"))).toBe(false);

    const toggle = [...container!.querySelectorAll<HTMLElement>("button[aria-expanded]")].find(
      (b) => b.textContent === "Archived",
    )!;
    await act(async () => {
      click(toggle);
    });
    await settle();

    expect(calls.some((c) => c.includes("filter=archived"))).toBe(true);
    expect(text()).toContain("Filed away");
  });
});

/**
 * The empty conversation list is the first thing a new
 * account sees, and an empty box that might equally be a failed request is the
 * ticket's central complaint: every state must say which it is.
 */
describe("the conversation list's own states", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  it("tells a brand-new account what will appear here, rather than showing a blank box", async () => {
    stubFetch({ "/api/conversations": { body: { data: [] } } });
    renderShell();
    await settle();

    expect(text()).toContain("No conversations yet");
    // Says what to do to fill it, so the emptiness is explained rather than
    // merely displayed.
    expect(text()).toContain("once you send a first message");
  });

  it("distinguishes a failed list from an empty one, and quotes the request id", async () => {
    stubFetch({
      "/api/conversations": {
        status: 503,
        body: { detail: "gateway down", request_id: "req-list-fail" },
        headers: { "X-Request-Id": "req-list-fail" },
      },
    });
    renderShell();
    await settle();

    // Not "No conversations yet": a list that failed to load must never read
    // as a list that is empty.
    expect(text()).not.toContain("No conversations yet");
    expect(text()).toContain("Could not load conversations");
    // The id is on screen, so a screenshot leads to the trace...
    expect(text()).toContain("req-list-fail");
    // ...and the server's own prose is not (never a raw error body).
    expect(text()).not.toContain("gateway down");
    expect(container!.querySelector("[role='alert']")).not.toBeNull();
  });

  it("offers a retry that re-requests the list", async () => {
    const { calls } = stubFetch({
      "/api/conversations": { status: 503, body: { detail: "down" } },
    });
    renderShell();
    await settle();

    const before = calls.filter((c) => c.includes("/api/conversations")).length;
    const retry = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retry"),
    )!;
    expect(retry).toBeDefined();
    await act(async () => {
      click(retry);
    });
    await settle();
    expect(calls.filter((c) => c.includes("/api/conversations")).length).toBeGreaterThan(before);
  });

  it("names the emptiness when a search finds nothing, distinctly from an empty list", async () => {
    stubFetch({
      "/api/search": { body: { data: [] } },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();

    typeInSearch("nothing matches this");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();

    expect(text()).toContain("No matches");
    // The query is quoted back, so the user knows what was searched for.
    expect(text()).toContain("nothing matches this");
    expect(text()).not.toContain("No conversations yet");
  });

  it("shows a failed search as a failure, with its id, not as 'no matches'", async () => {
    stubFetch({
      "/api/search": {
        status: 500,
        body: { detail: "tsquery exploded" },
        headers: { "X-Request-Id": "req-search-fail" },
      },
      "/api/conversations": { body: { data: [] } },
    });
    renderShell();
    await settle();

    typeInSearch("boom");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();

    expect(text()).toContain("Search failed");
    expect(text()).toContain("req-search-fail");
    // The raw message the API sent is never rendered.
    expect(text()).not.toContain("tsquery exploded");
    expect(text()).not.toContain("No matches");
  });
});

describe("searching from the sidebar", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  it("debounces: typing a word costs one query, not one per letter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubFetch({
      "/api/search": { body: { data: [] } },
      "/api/conversations": { body: { data: [] } },
    });
    renderShell();
    await settle();

    typeInSearch("v");
    typeInSearch("ve");
    typeInSearch("vel");
    expect(calls.filter((c) => c.includes("/search")).length).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();

    const searches = calls.filter((c) => c.includes("/search"));
    expect(searches.length).toBe(1);
    expect(searches[0]).toContain("q=vel");
  });

  it("replaces the list with results, and the match is highlighted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      "/api/search": {
        body: {
          data: [
            {
              ...conversation({ id: "hit", title: "Planning" }),
              snippet: `the quarterly ${SNIPPET_OPEN}velocity${SNIPPET_CLOSE} report`,
              message_id: "m1",
            },
          ],
        },
      },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();
    expect(text()).toContain("Infra");

    typeInSearch("velocity");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();

    // The results replaced the list rather than sitting beside it.
    expect(text()).toContain("Planning");
    expect(text()).not.toContain("Infra");

    const mark = container!.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("velocity");
    // Rendered as text, never as HTML.
    expect(text()).not.toContain(SNIPPET_OPEN);
    // How many, above the list.
    expect(container!.querySelector("[data-mw-search-count]")?.textContent).toBe("1 result");
  });

  it("says so when nothing matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      "/api/search": { body: { data: [] } },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();

    typeInSearch("nothingmatchesthis");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();

    expect(text()).toContain("No matches");
    expect(text()).toContain("nothingmatchesthis");
  });

  it("marks an archived hit as archived, because search still finds one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      "/api/search": {
        body: {
          data: [
            {
              ...conversation({
                id: "z",
                title: "Filed away",
                archived_at: "2026-09-02T00:00:00+00:00",
              }),
              snippet: `the ${SNIPPET_OPEN}velocity${SNIPPET_CLOSE} numbers`,
              message_id: "m9",
            },
          ],
        },
      },
      "/api/conversations": { body: { data: [] } },
    });
    renderShell();
    await settle();

    typeInSearch("velocity");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();

    expect(text()).toContain("Filed away");
    expect(text()).toContain("Archived");
  });

  it("Escape clears the box and hands the sidebar back to the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      "/api/search": {
        body: {
          data: [
            {
              ...conversation({ id: "hit", title: "Planning" }),
              snippet: `a ${SNIPPET_OPEN}velocity${SNIPPET_CLOSE} note`,
              message_id: "m1",
            },
          ],
        },
      },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Infra" })] } },
    });
    renderShell();
    await settle();

    typeInSearch("velocity");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();
    expect(text()).toContain("Planning");

    const input = byLabel("Search conversations") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();

    expect(input.value).toBe("");
    expect(text()).toContain("Infra");
    expect(text()).not.toContain("Planning");
  });
});

// --- folders, tags and the jump to a message --------------------------------

const LIBRARY = {
  folders: [
    {
      id: "f1",
      name: "Work",
      position: 0,
      created_at: "2026-09-01T00:00:00+00:00",
      updated_at: "2026-09-01T00:00:00+00:00",
    },
  ],
  tags: [
    { id: "t1", name: "billing", created_at: "2026-09-01T00:00:00+00:00" },
    { id: "t2", name: "urgent", created_at: "2026-09-01T00:00:00+00:00" },
  ],
  assignments: { a: ["t1"] },
};

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("folders and tags in the sidebar", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  it("files a conversation under its folder and keeps the rest in the main list", async () => {
    stubFetch({
      "/api/library": { body: LIBRARY },
      "/api/conversations": {
        body: {
          data: [
            conversation({ id: "a", title: "Invoices", folder_id: "f1" }),
            conversation({ id: "b", title: "Loose" }),
          ],
        },
      },
    });
    renderShell();
    await settle();

    const folder = container!.querySelector('[aria-label="Conversations in Work"]')!;
    expect(folder.textContent).toContain("Invoices");
    expect(folder.textContent).not.toContain("Loose");
    const main = container!.querySelector('[aria-label="Conversations"]')!;
    expect(main.textContent).toContain("Loose");
    expect(main.textContent).not.toContain("Invoices");
    // The tag chip rides on its row.
    expect(folder.querySelector('[aria-label="Tags"]')?.textContent).toBe("billing");
  });

  it("filters by tag, and says so when nothing carries it", async () => {
    stubFetch({
      "/api/library": { body: LIBRARY },
      "/api/conversations": {
        body: {
          data: [
            conversation({ id: "a", title: "Invoices" }),
            conversation({ id: "b", title: "Loose" }),
          ],
        },
      },
    });
    renderShell();
    await settle();

    const chip = (label: string) =>
      [...container!.querySelectorAll('[aria-label="Filter by tag"] button')].find(
        (b) => b.textContent === label,
      ) as HTMLElement;

    await act(async () => click(chip("billing")));
    expect(chip("billing").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Invoices");
    expect(text()).not.toContain("Loose");

    await act(async () => click(chip("urgent")));
    expect(text()).toContain("Nothing tagged urgent");

    await act(async () => click(chip("All")));
    expect(text()).toContain("Loose");
  });

  it("moves a conversation through the row menu with a PUT, no dragging", async () => {
    const { calls } = stubFetch({
      "/api/library/conversations/b/folder": {
        body: conversation({ id: "b", title: "Loose", folder_id: "f1" }),
      },
      "/api/library": { body: LIBRARY },
      "/api/conversations": { body: { data: [conversation({ id: "b", title: "Loose" })] } },
    });
    renderShell();
    await settle();

    const menu = openActions("Loose");
    const target = [...menu.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Work"),
    )!;
    await act(async () => click(target));
    await settle();

    expect(calls).toContain("PUT /api/library/conversations/b/folder");
    // The list is re-read so the row's folder_id is the server's.
    expect(calls.filter((c) => c.startsWith("GET /api/conversations?")).length).toBe(2);
  });

  it("tags a conversation by ticking the tag, sending the whole set", async () => {
    stubFetch({
      "/api/library/conversations/a/tags": { body: { tag_ids: ["t1", "t2"] } },
      "/api/library": { body: LIBRARY },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Invoices" })] } },
    });
    const stubbed = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    renderShell();
    await settle();

    await act(async () => click(byLabel("Add tag urgent on Invoices")!));
    await settle();

    const put = stubbed.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ tag_ids: ["t1", "t2"] });
    expect(byLabel("Remove tag urgent on Invoices")).not.toBeNull();
  });

  it("creates a folder from the foot of the list", async () => {
    const { calls } = stubFetch({
      "/api/library/folders": {
        body: {
          id: "f2",
          name: "Play",
          position: 1,
          created_at: "2026-09-01T00:00:00+00:00",
          updated_at: "2026-09-01T00:00:00+00:00",
        },
      },
      "/api/library": { body: LIBRARY },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Invoices" })] } },
    });
    renderShell();
    await settle();

    const add = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("New folder"),
    )!;
    await act(async () => click(add));
    const input = byLabel("New folder name") as HTMLInputElement;
    // A labelled box with a hint in it, and buttons for the keys it takes.
    expect(input.placeholder).toBe("Folder name");
    expect(input.labels?.[0]?.textContent).toBe("New folder name");
    const buttons = [...input.form!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
    const save = buttons[1];
    expect(save.disabled).toBe(true);
    setInput(input, "Play");
    expect(save.disabled).toBe(false);
    await act(async () => {
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(calls).toContain("POST /api/library/folders");
    expect(container!.querySelector('[aria-label="Folder Play"]')).not.toBeNull();
  });

  it("Cancel and Escape both put the New folder button back", async () => {
    stubFetch({
      "/api/library": { body: LIBRARY },
      "/api/conversations": { body: { data: [conversation({ id: "a", title: "Invoices" })] } },
    });
    renderShell();
    await settle();
    const add = () =>
      [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("New folder"));

    await act(async () => click(add()!));
    const cancel = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => click(cancel));
    expect(byLabel("New folder name")).toBeNull();
    expect(add()).not.toBeUndefined();

    await act(async () => click(add()!));
    const input = byLabel("New folder name") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(byLabel("New folder name")).toBeNull();
    expect(add()).not.toBeUndefined();
  });
});

describe("jumping to the message a search found", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  async function searchFor(hits: unknown[], nextCursor: string | null = null) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = stubFetch({
      "cursor=": {
        body: {
          data: [
            { ...conversation({ id: "more", title: "Second page" }), snippet: "x", message_id: null },
          ],
          next_cursor: null,
        },
      },
      "/api/search": { body: { data: hits, next_cursor: nextCursor } },
      "/api/conversations": { body: { data: [] } },
    });
    renderShell();
    await settle();
    typeInSearch("velocity");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    await settle();
    return stub;
  }

  it("puts ?m= on the result and announces the message to jump to", async () => {
    await searchFor([
      {
        ...conversation({ id: "c1", title: "Planning" }),
        snippet: `${SNIPPET_OPEN}velocity${SNIPPET_CLOSE}`,
        message_id: "m7",
      },
    ]);
    const link = container!.querySelector('a[href*="c=c1"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/apps/chat?c=c1&m=m7");

    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("mw:jump-to-message", listener);
    await act(async () => click(link));
    window.removeEventListener("mw:jump-to-message", listener);

    expect(location.search).toBe("?c=c1&m=m7");
    expect(seen).toEqual([{ conversationId: "c1", messageId: "m7" }]);
  });

  it("a title match has nothing to jump to and carries no ?m=", async () => {
    await searchFor([
      {
        ...conversation({ id: "c2", title: "Velocity" }),
        snippet: `${SNIPPET_OPEN}Velocity${SNIPPET_CLOSE}`,
        message_id: null,
      },
    ]);
    const link = container!.querySelector('a[href*="c=c2"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/apps/chat?c=c2");
  });

  it("fetches the next page with the cursor and appends it", async () => {
    const { calls } = await searchFor(
      [{ ...conversation({ id: "c1", title: "First page" }), snippet: "x", message_id: null }],
      "abc",
    );
    const more = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "More results",
    )!;
    // The count says it is partial while a page is still on the server.
    expect(container!.querySelector("[data-mw-search-count]")?.textContent).toBe("1 result so far");
    await act(async () => click(more));
    await settle();
    expect(calls.some((c) => c.includes("cursor=abc"))).toBe(true);
    expect(text()).toContain("First page");
    expect(text()).toContain("Second page");
    expect(text()).not.toContain("More results");
    expect(container!.querySelector("[data-mw-search-count]")?.textContent).toBe("2 results");
  });
});

/**
 * Row actions over the real shell state, with a fetch that
 * answers as the server would after each change: a row lands where the
 * server's ORDER BY would put it, and the address stops naming a deleted row.
 */
describe("row actions keep the list and the address true to the server", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
  });

  function stubServer(handler: (method: string, url: string) => Route | undefined): {
    calls: string[];
  } {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(`${method} ${url}`);
        const route = handler(method, url);
        const status = route?.status ?? 200;
        return Promise.resolve({
          ok: status < 400,
          status,
          statusText: "",
          headers: new Headers(route?.headers ?? {}),
          json: () => Promise.resolve(route?.body ?? { data: [] }),
        } as Response);
      }),
    );
    return { calls };
  }

  function mainTitles(): string[] {
    const list = container?.querySelector('ul[aria-label="Conversations"]');
    return Array.from(list?.querySelectorAll("li > a[title]") ?? []).map(
      (a) => a.getAttribute("title") ?? "",
    );
  }

  async function press(label: string): Promise<void> {
    await act(async () => {
      click(byLabel(label)!);
    });
    await settle();
    await settle();
  }

  it("unarchiving from the Archived section puts the row back in the main list, in server order", async () => {
    const alpha = conversation({ id: "a", title: "Alpha", updated_at: "2026-09-02T00:00:00+00:00" });
    const beta = conversation({ id: "b", title: "Beta", updated_at: "2026-09-01T00:00:00+00:00" });
    const zed = conversation({
      id: "z",
      title: "Zed",
      updated_at: "2026-09-05T00:00:00+00:00",
      archived_at: "2026-09-04T00:00:00+00:00",
    });
    let archived = true;
    stubServer((method, url) => {
      if (url.includes("/api/conversations/z/archive")) {
        archived = method === "PUT";
        return { body: { ...zed, archived_at: archived ? zed.archived_at : null } };
      }
      if (url.includes("filter=archived")) return { body: { data: archived ? [zed] : [] } };
      if (url.includes("/api/conversations?")) {
        return { body: { data: archived ? [alpha, beta] : [{ ...zed, archived_at: null }, alpha, beta] } };
      }
      return undefined;
    });
    renderShell();
    await settle();
    expect(mainTitles()).toEqual(["Alpha", "Beta"]);

    const toggle = [...container!.querySelectorAll<HTMLElement>("button[aria-expanded]")].find(
      (b) => b.textContent === "Archived",
    )!;
    await act(async () => {
      click(toggle);
    });
    await settle();
    expect(text()).toContain("Zed");

    await press("Unarchive Zed");

    expect(mainTitles()).toEqual(["Zed", "Alpha", "Beta"]);
  });

  it("pinning moves the row to the top, where the server sorts pinned rows", async () => {
    const rows = ["One", "Two", "Three", "Four", "Five"].map((title, i) =>
      conversation({ id: `r${i}`, title, updated_at: `2026-09-0${5 - i}T00:00:00+00:00` }),
    );
    stubServer((method, url) => {
      if (url.includes("/api/conversations/r4/pin")) {
        return { body: { ...rows[4], pinned_at: method === "PUT" ? "2026-09-10T00:00:00+00:00" : null } };
      }
      if (url.includes("/api/conversations?")) return { body: { data: rows } };
      return undefined;
    });
    renderShell();
    await settle();
    expect(mainTitles()).toEqual(["One", "Two", "Three", "Four", "Five"]);

    await press("Pin Five");
    expect(mainTitles()).toEqual(["Five", "One", "Two", "Three", "Four"]);

    await press("Unpin Five");
    expect(mainTitles()).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("deleting the open conversation from the sidebar takes ?c= off the address", async () => {
    history.replaceState(null, "", "/apps/chat?c=a");
    const alpha = conversation({ id: "a", title: "Alpha" });
    const { calls } = stubServer((method, url) => {
      if (method === "DELETE" && url.endsWith("/api/conversations/a")) return { body: null, status: 204 };
      if (url.includes("/api/conversations?")) return { body: { data: [alpha] } };
      return undefined;
    });
    renderShell();
    await settle();

    await press("Delete Alpha");
    // Asked first: nothing is deleted until the confirm says so.
    expect(calls).not.toContain("DELETE /api/conversations/a");
    expect(document.body.textContent).toContain("Delete this conversation?");
    await confirmDelete();
    await settle();

    expect(calls).toContain("DELETE /api/conversations/a");
    expect(mainTitles()).toEqual([]);
    expect(location.search).toBe("");
  });

  it("says so when the delete is refused, and keeps the row", async () => {
    const alpha = conversation({ id: "a", title: "Alpha" });
    stubServer((method, url) => {
      if (method === "DELETE") {
        return { body: { detail: "boom" }, status: 500, headers: { "X-Request-Id": "req-del" } };
      }
      if (url.includes("/api/conversations?")) return { body: { data: [alpha] } };
      return undefined;
    });
    renderShell();
    await settle();

    await press("Delete Alpha");
    await confirmDelete();
    await settle();

    expect(mainTitles()).toEqual(["Alpha"]);
    const alert = container!.querySelector('ul[aria-label="Conversations"] [role="alert"]');
    expect(alert?.textContent).toContain("could not be deleted");
  });
});
