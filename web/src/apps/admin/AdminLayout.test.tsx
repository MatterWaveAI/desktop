import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  type Mounted,
} from "../settings/panes/paneHarness";
import { AdminPage } from "./AdminPage";
import type { AdminOrg, AdminUser } from "./adminApi";

/**
 * The admin page's frame: tables that scroll inside themselves instead of
 * widening a phone's page, a tab strip that scrolls rather than wrapping,
 * the open tab kept in the URL, one tab's crash contained to that tab, and
 * a support session that needs a reason before it opens.
 */

const ORG: AdminOrg = {
  id: "0000000a-0000-0000-0000-00000000000a",
  name: "Acme",
  zitadel_org_id: "z-acme",
  members: 3,
  overage_cap_micros: 0,
  tokens_used: 0,
  overage_micros: 0,
  created_at: "2026-09-01T00:00:00+00:00",
};

const ADA: AdminUser = {
  subject: "ada",
  email: "ada@acme.com",
  name: "Ada",
  state: "active",
  email_verified: true,
  suspended_at: null,
  suspension_reason: null,
  org_id: ORG.id,
  org_name: "Acme",
  role: "owner",
  created_at: "2026-09-01T00:00:00+00:00",
  last_seen_at: null,
};

const SESSION = {
  active: true,
  id: "sess-1",
  org_id: ORG.id,
  org_name: "Acme",
  started_at: "2026-10-03T10:00:00+00:00",
  expires_at: "2026-10-03T10:30:00+00:00",
};

let mounted: Mounted | null = null;
const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  history.replaceState(null, "", "/admin");
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  assign.mockReset();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub(extra: Parameters<typeof stubApi>[0] = () => undefined) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url === "/api/admin/orgs") {
      return { status: 200, body: { data: [ORG], q: "", next_cursor: null } };
    }
    if (call.method === "GET" && call.url.startsWith("/api/admin/users")) return { status: 200, body: { data: [ADA] } };
    return undefined;
  });
}

// The phone layout: the one-row strip. The side column is the same list
// under headings, tested on its own below.
const STRIP = "nav[aria-label='Admin sections'][data-slot='tab-strip']";
const SIDE = "nav[aria-label='Admin sections'][data-layout='side']";

function selectedTab(): string | null | undefined {
  return mounted!.container.querySelector(`${STRIP} a[aria-current='page']`)?.textContent;
}

/** An admin tab: a link in the strip, to its own ?tab= URL. */
function tab(name: string): HTMLAnchorElement {
  const found = [...mounted!.container.querySelectorAll<HTMLAnchorElement>(`${STRIP} a`)].find(
    (a) => a.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  return found;
}

describe("the admin tables on a phone", () => {
  it.each([
    ["Organisations", "Organisations"],
    ["Users", "Users"],
  ])("the %s table scrolls inside a positioned box, so its sr-only header cannot widen the page", async (tabName, label) => {
    stub();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab(tabName));
    await flush();
    const table = mounted.container.querySelector(`table[aria-label='${label}']`)!;
    expect(table).not.toBeNull();
    const scroller = table.parentElement!;
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("relative");
    expect(table.querySelector("th .sr-only")?.textContent).toBe("Actions");
  });
});

describe("the tab strip", () => {
  it("scrolls sideways in one row instead of wrapping", async () => {
    stub();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    const scroller = mounted.container.querySelector(`${STRIP} [data-fade-start], ${STRIP} > div`)!;
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("flex-nowrap");
    const links = [...mounted.container.querySelectorAll<HTMLAnchorElement>(`${STRIP} a`)];
    expect(links.length).toBe(14);
    for (const link of links) {
      expect(link.className).toContain("shrink-0");
      expect(link.className).toContain("whitespace-nowrap");
    }
    // Each is a real link to its own URL, so it opens in a new browser tab too.
    expect(tab("Plans").getAttribute("href")).toBe("/admin?tab=plans");
    expect(tab("Organisations").getAttribute("href")).toBe("/admin");
  });

  it("keeps the open tab in the URL, and opens on the tab the URL names", async () => {
    stub();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    expect(selectedTab()).toBe("Organisations");
    click(tab("Users"));
    await flush();
    expect(window.location.pathname).toBe("/admin");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("users");

    // A reload: the page mounts again from the same URL.
    mounted.unmount();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    expect(selectedTab()).toBe("Users");

    // Back to the first tab drops the parameter: /admin is the orgs tab.
    click(tab("Organisations"));
    expect(window.location.search).toBe("");
  });

  it("follows the URL when history moves, and ignores a tab it does not have", async () => {
    stub();
    history.replaceState(null, "", "/admin?tab=nonsense");
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    expect(selectedTab()).toBe("Organisations");
    history.replaceState(null, "", "/admin?tab=users");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();
    expect(selectedTab()).toBe("Users");
  });
});

describe("the side column", () => {
  it("groups the same fourteen sections under four headings, each a link to its tab", async () => {
    stub();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    const side = mounted.container.querySelector(SIDE)!;
    expect(side).not.toBeNull();
    expect(side.className).toContain("hidden");
    expect(side.className).toContain("md:block");
    const groups = [...side.querySelectorAll("[role='group']")].map((group) => ({
      name: group.getAttribute("aria-label"),
      tabs: [...group.querySelectorAll("a")].map((a) => a.textContent),
    }));
    expect(groups).toEqual([
      { name: "People", tabs: ["Organisations", "Users"] },
      { name: "Billing", tabs: ["Spend", "Billing", "Overdue", "Plans"] },
      { name: "Platform", tabs: ["Flags", "Announcements", "Integrations", "Health"] },
      { name: "Operations", tabs: ["Retention", "Moderation", "Enforcement", "Deletions"] },
    ]);
    // The same list as the strip, in the same order.
    const stripTabs = [...mounted.container.querySelectorAll(`${STRIP} a`)].map((a) => a.textContent);
    expect(groups.flatMap((g) => g.tabs)).toEqual(stripTabs);

    const users = [...side.querySelectorAll("a")].find((a) => a.textContent === "Users")!;
    expect(users.getAttribute("href")).toBe("/admin?tab=users");
    click(users);
    await flush();
    expect(side.querySelector("a[aria-current='page']")?.textContent).toBe("Users");
    expect(selectedTab()).toBe("Users");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("users");
  });
});

describe("a tab that crashes", () => {
  it("shows app copy, not the raw exception, when the outbox answer is malformed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stub(({ method, url }) => {
      if (method === "GET" && url === "/api/admin/integrations/salesforce") {
        return { status: 200, body: { provider: "salesforce", configured: true } };
      }
      // `data` is not a list: rendering the rows throws.
      if (method === "GET" && url.startsWith("/api/admin/integrations/salesforce/")) {
        return { status: 200, body: { data: { map: 1 } } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Integrations"));
    await flush();
    await flush();
    const panel = mounted.container.querySelector("[data-admin-panel]")!;
    expect(panel.textContent).toContain("The Salesforce status could not be read. Retry.");
    expect(panel.textContent).not.toMatch(/is not a function|TypeError/);
    expect(logged).toHaveBeenCalled();
  });

  it("is contained to its panel: the tab strip stays and another tab still opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stub(({ method, url }) => {
      // A malformed answer: no connection block at all.
      if (method === "GET" && url === "/api/admin/integrations/salesforce") {
        return { status: 200, body: { provider: "salesforce", configured: true } };
      }
      if (method === "GET" && url.startsWith("/api/admin/integrations/salesforce/")) {
        return { status: 200, body: { data: [] } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Integrations"));
    await flush();
    await flush();
    const panel = mounted.container.querySelector("[data-admin-panel]")!;
    expect(panel.querySelector("dl[aria-label='Salesforce connection']")?.textContent).toContain("Not reached yet");
    expect(mounted.container.querySelector("nav[aria-label='Admin sections']")).not.toBeNull();
  });

  it("shows the tab's own error with a retry, and the other tabs keep working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stub(({ method, url }) => {
      // Not even an object: every field read throws somewhere.
      if (method === "GET" && url === "/api/admin/retention/preview") return { status: 200, body: { orgs: 7 } };
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Retention"));
    await flush();
    const panel = mounted.container.querySelector("[data-admin-panel]")!;
    expect(panel.textContent).toContain("Retention stopped working");
    expect(panel.textContent).toContain("The retention data could not be read. Retry.");
    click(tab("Users"));
    await flush();
    expect(mounted.container.querySelector("table[aria-label='Users']")).not.toBeNull();
  });
});

describe("the organisations table", () => {
  it("keeps Open and Manage in view: the actions column is pinned to the right edge of the scroll", async () => {
    stub(() => undefined);
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    const cell = buttonNamed(mounted.container, "Open Acme as support").closest("td")!;
    expect(cell.hasAttribute("data-org-actions")).toBe(true);
    expect(cell.className).toContain("md:sticky");
    expect(cell.className).toContain("md:right-0");
    const head = mounted.container.querySelector("table[aria-label='Organisations'] thead th:last-child")!;
    expect(head.className).toContain("md:sticky");
  });
});

describe("opening an organisation as support", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, pathname: "/admin", search: "", hash: "", assign },
    });
  });

  it("asks for a reason first, and sends it", async () => {
    const calls = stub(({ method, url }) =>
      method === "POST" && url === `/api/admin/support/${ORG.id}` ? { status: 201, body: SESSION } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Open Acme as support"));
    await flush();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Open Acme as support?");
    const confirm = buttonNamed(dialog, "Open as support");
    expect(confirm.disabled).toBe(true);
    const reason = dialog.querySelector<HTMLInputElement>("input[aria-label='Reason']")!;
    setInputValue(reason, "   ");
    expect(confirm.disabled).toBe(true);
    setInputValue(reason, "ticket 42: export fails");
    expect(confirm.disabled).toBe(false);
    click(confirm);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`/api/admin/support/${ORG.id}`);
    expect(post?.body).toEqual({ reason: "ticket 42: export fails" });
    expect(assign).toHaveBeenCalledWith("/apps/chat");
  });

  it("cancelling sends nothing", async () => {
    const calls = stub();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Open Acme as support"));
    await flush();
    click(buttonNamed(document.querySelector("[data-slot='dialog-content']")!, "Cancel"));
    await flush();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
