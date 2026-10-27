import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "@tanstack/react-router";
import type { AuthConfig, Principal } from "../../../types";
import { router } from "../../../routes";
import { ShellContext, type ShellContextValue } from "../../../shell/shellContext";
import { UsagePane } from "./UsagePane";

/**
 * The Usage pane's per-member table. billingPanes.test.tsx proves the
 * balance and its three states; this proves the section under it shows
 * what `/api/org/usage` scoped the caller to -- every member for an admin,
 * their own row for a member -- asks for the month the pane is on, moves
 * month with the picker, and downloads the same query as a file.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const authConfig: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "m" };

function principalWith(orgRole: string | null): Principal {
  return {
    subject: "u1",
    kind: "dev",
    email: "dev@localhost",
    name: null,
    roles: [],
    org_id: "org-1",
    org_name: "Org One",
    org_role: orgRole,
  };
}

function shellValue(principal: Principal): ShellContextValue {
  return {
    authConfig,
    principal,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: async () => {},
  };
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: "",
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** Stub fetch by full URL (query included), falling back to the path. */
function stub(routes: Record<string, unknown>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      seen.push({ url, init });
      if (url in routes) return json(routes[url]);
      const path = url.split("?")[0];
      if (path in routes) return json(routes[path]);
      return json({ detail: `no mock for ${url}` }, 404);
    }),
  );
  return seen;
}

async function render(orgRole: string | null = "member") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RouterContextProvider router={router}>
        <ShellContext.Provider value={shellValue(principalWith(orgRole))}>
          <UsagePane />
        </ShellContext.Provider>
      </RouterContextProvider>,
    );
  });
  await act(async () => {});
}

const text = () => container?.textContent ?? "";

const usage = {
  unit: "tokens",
  used: 160_000,
  included: 20_000_000,
  remaining: 19_840_000,
  percent: 0.8,
  warn: false,
  in_overage: false,
  exhausted: false,
  period_start: "2026-10-01",
  resets_at: "2026-11-01T00:00:00+00:00",
  plan: { code: "pro", name: "Pro" },
  overage: { enabled: true, spent_micros: 0, cap_micros: 20_000_000 },
  models: [],
  history: [{ day: "2026-10-01", weighted_tokens: 160_000, tokens: 160_000, cost_micros: 40_000, overage_micros: 0, requests: 9 }],
};

const member = (subject: string, email: string | null, weighted: number, turns: number) => ({
  subject,
  email,
  name: null,
  weighted_tokens: weighted,
  tokens: weighted,
  cost_micros: weighted / 4,
  turns,
  last_active: "2026-10-02T09:30:00+00:00",
});

const orgReport = {
  period: "2026-10",
  period_start: "2026-10-01",
  period_end: "2026-11-01",
  unit: "tokens",
  scope: "org",
  data: [
    member("ada", "ada@acme.com", 120_000, 6),
    member("bob", "bob@acme.com", 40_000, 3),
    member("unattributed", null, 0, 1),
  ],
  totals: { weighted_tokens: 160_000, tokens: 160_000, cost_micros: 40_000, turns: 10 },
};

const selfReport = {
  ...orgReport,
  scope: "self",
  data: [member("u1", "dev@localhost", 40_000, 3)],
  totals: { weighted_tokens: 40_000, tokens: 40_000, cost_micros: 10_000, turns: 3 },
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rows(): Element[] {
  return [...(container?.querySelectorAll("tr[data-member]") ?? [])];
}

describe("UsagePane, by member", () => {
  it("asks for the pane's month and shows every member to an admin, biggest spender first", async () => {
    const seen = stub({ "/api/me/usage": usage, "/api/org/usage?period=2026-10": orgReport });
    await render("admin");
    await vi.waitFor(() => expect(rows().length).toBe(3));
    expect(seen.some((s) => s.url === "/api/org/usage?period=2026-10")).toBe(true);
    expect(text()).toContain("By member");
    expect(rows().map((r) => r.getAttribute("data-member"))).toEqual(["ada", "bob", "unattributed"]);
    expect(rows()[0].textContent).toContain("ada@acme.com");
    expect(rows()[0].textContent).toContain("120,000");
    // A list-price cost below a cent still reads as money, not "$0.00".
    expect(rows()[0].textContent).toContain("$0.03");
    expect(rows()[0].textContent).toContain("6");
    // A row with no users row shows the subject the API gave it.
    expect(rows()[2].textContent).toContain("unattributed");
    // The totals row is the API's, not a re-sum.
    const foot = container!.querySelector("tfoot")!;
    expect(foot.textContent).toContain("160,000");
    expect(foot.textContent).toContain("$0.04");
    expect(foot.textContent).toContain("10");
  });

  it("shows a member their own row under their own heading", async () => {
    stub({ "/api/me/usage": usage, "/api/org/usage?period=2026-10": selfReport });
    await render("member");
    await vi.waitFor(() => expect(rows().length).toBe(1));
    expect(text()).toContain("Your usage");
    expect(text()).not.toContain("By member");
    expect(rows()[0].textContent).toContain("dev@localhost");
  });

  it("moves month with the picker and asks again", async () => {
    const seen = stub({
      "/api/me/usage": usage,
      "/api/org/usage?period=2026-10": orgReport,
      "/api/org/usage?period=2026-09": { ...orgReport, period: "2026-09", data: [], totals: { weighted_tokens: 0, tokens: 0, cost_micros: 0, turns: 0 } },
    });
    await render("owner");
    await vi.waitFor(() => expect(rows().length).toBe(3));
    const month = container!.querySelector<HTMLInputElement>("input[type='month']")!;
    expect(month.value).toBe("2026-10");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(month, "2026-09");
      month.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => expect(text()).toContain("Nothing used in September 2026."));
    expect(seen.some((s) => s.url === "/api/org/usage?period=2026-09")).toBe(true);
  });

  it("downloads the month's CSV through the session", async () => {
    const seen = stub({
      "/api/me/usage": usage,
      "/api/org/usage?period=2026-10": orgReport,
      "/api/org/usage.csv?period=2026-10": "subject,email,name,weighted_tokens,tokens,cost_usd,turns,last_active\r\n",
    });
    await render("admin");
    await vi.waitFor(() => expect(rows().length).toBe(3));
    const anchors: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:usage"), revokeObjectURL: vi.fn() }));
    const download = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Download CSV")!;
    await act(async () => {
      download.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(anchors.length).toBe(1));
    expect(anchors[0].download).toBe("usage-2026-10.csv");
    const request = seen.find((s) => s.url === "/api/org/usage.csv?period=2026-10");
    expect(request?.init?.credentials).toBe("include");
    clickSpy.mockRestore();
  });

  it("fails this section alone when the report cannot be read", async () => {
    stub({ "/api/me/usage": usage });
    await render("admin");
    await vi.waitFor(() => expect(text()).toContain("Could not load usage by member"));
    // The balance above it is still there.
    expect(text()).toMatch(/19,840,000 tokens left/);
  });
});
