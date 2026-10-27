import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetPane, type BudgetView, type MemberBudgets } from "./BudgetPane";
import { capFieldText, formatMonth, parseCapMicros, parseDollars } from "./budgetMoney";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * The budget pane as the user sees it: every member reads the allowance and
 * the overage against its cap, only an owner or admin by membership
 * (org_role, never the platform claim) is offered the cap, the PUT carries
 * micro-dollars, and a plan without overage has nothing to edit.
 */

// The free plan's "See plans" is a router <Link>, which throws outside a
// RouterProvider; a plain anchor carries the same href for the assertion.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; className?: string; children?: React.ReactNode }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

const PRO: BudgetView = {
  period_start: "2026-09-01",
  included_tokens: 20_000_000,
  tokens_used: 5_000_000,
  remaining_tokens: 15_000_000,
  overage_enabled: true,
  overage_cap_micros: 20_000_000,
  overage_micros: 0,
};

const FREE: BudgetView = {
  period_start: "2026-09-01",
  included_tokens: 1_000_000,
  tokens_used: 250_000,
  remaining_tokens: 750_000,
  overage_enabled: false,
  overage_cap_micros: 0,
  overage_micros: 0,
};

const ENTITLEMENTS = { plan: "pro", default_overage_cap_micros: 20_000_000 };

/** The owner's table: a $10 default, Alice on her own $25, Bob on the default and at it. */
const MEMBERS: MemberBudgets = {
  period_start: "2026-09-01",
  member_default_cap_micros: 10_000_000,
  data: [
    {
      subject: "dev-user",
      email: "dev@localhost",
      name: null,
      role: "owner",
      state: "active",
      cap_micros: 10_000_000,
      own: false,
      spent_micros: 0,
      exhausted: false,
    },
    {
      subject: "alice",
      email: "alice@example.com",
      name: "Alice",
      role: "member",
      state: "active",
      cap_micros: 25_000_000,
      own: true,
      spent_micros: 2_500_000,
      exhausted: false,
    },
    {
      subject: "bob",
      email: "bob@example.com",
      name: "Bob",
      role: "member",
      state: "active",
      cap_micros: 10_000_000,
      own: false,
      spent_micros: 10_000_000,
      exhausted: true,
    },
  ],
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("money helpers", () => {
  it("parses dollars to whole cents", () => {
    expect(parseDollars("25")).toBe(2500);
    expect(parseDollars("$12.5")).toBe(1250);
    expect(parseDollars("0.07")).toBe(7);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("-1")).toBeNull();
    expect(parseDollars("lots")).toBeNull();
  });

  it("reads the cap field as micro-dollars, empty as the plan default", () => {
    expect(parseCapMicros("25")).toBe(25_000_000);
    expect(parseCapMicros("0.07")).toBe(70_000);
    expect(parseCapMicros("")).toBe(0);
    expect(parseCapMicros("  ")).toBe(0);
    expect(parseCapMicros("0")).toBe(0);
    expect(parseCapMicros("abc")).toBeNull();
    expect(capFieldText(20_000_000)).toBe("20.00");
    expect(capFieldText(70_000)).toBe("0.07");
  });

  it("reads a raw month or period start as the month a person would say", () => {
    const expected = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(iso),
      );
    expect(formatMonth("2026-10")).toBe(expected("2026-10-01T00:00:00Z"));
    expect(formatMonth("2026-09-01")).toBe(expected("2026-09-01T00:00:00Z"));
    expect(formatMonth("2026-10")).toMatch(/October/);
    expect(formatMonth("not a month")).toBe("not a month");
  });
});

describe("the Budget pane", () => {
  it("offers no editor to a platform operator who is not an org admin", async () => {
    // The Zitadel admin claim opens /admin, not the org's budget: the API
    // refuses the PUT, so the control is not drawn.
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/budget" ? { status: 200, body: PRO } : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["admin"], null));
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(mounted.container.textContent).toContain("Only an organisation administrator");
  });

  it("shows overage against the cap and the period to any member, and leaves the allowance to Usage", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/budget"
        ? { status: 200, body: { ...PRO, overage_micros: 125 } }
        : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    const text = mounted.container.textContent!;
    // The allowance meter lives on Usage; Budget does not say it twice.
    expect(text).not.toContain("20,000,000 tokens");
    expect(text).not.toContain("Included tokens");
    const seeUsage = [...mounted.container.querySelectorAll("a")].find((a) => a.textContent === "See usage");
    expect(seeUsage).toBeDefined();
    // A sub-cent overage is shown as what it is, not rounded to nothing.
    expect(text).toContain("$0.000125");
    expect(text).toContain("$20.00");
    expect(text).toContain("September 2026");
    // Read-only: no editor for a non-admin, and it says who can change it.
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(text).toContain("Only an organisation administrator");
  });

  it("says a free plan has no overage and offers nothing to edit, even to an admin", async () => {
    stubApi(({ url }) => (url === "/api/budget" ? { status: 200, body: FREE } : undefined));
    mounted = await mount(<BudgetPane />, principalWith(["user"], "owner"));
    const text = mounted.container.textContent!;
    // Said once, in the Overage section; the month summary does not repeat it.
    expect(text.split("This plan has no overage")).toHaveLength(2);
    expect(text).toContain("Within the included tokens");
    expect(text).not.toContain("Overage cap");
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(mounted.container.querySelector("a[href='/pricing']")).not.toBeNull();
  });

  it("names the stop when the overage cap is reached", async () => {
    stubApi(({ url }) =>
      url === "/api/budget"
        ? {
            status: 200,
            body: { ...PRO, tokens_used: 30_000_000, remaining_tokens: 0, overage_micros: 20_000_000 },
          }
        : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["user"], "viewer"));
    expect(mounted.container.textContent).toContain("The overage cap is reached");
  });

  it("lets an admin set the overage cap in dollars, sending micro-dollars", async () => {
    let current = PRO;
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: current };
      if (method === "GET" && url === "/api/entitlements") return { status: 200, body: ENTITLEMENTS };
      if (method === "PUT" && url === "/api/budget") {
        const cap = (body as { overage_cap_micros: number }).overage_cap_micros;
        // 0 is "the plan's default", which the API reports back as the cap in force.
        current = { ...current, overage_cap_micros: cap === 0 ? 20_000_000 : cap };
        return { status: 200, body: current };
      }
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "admin"));
    const { container } = mounted;

    expect(container.textContent).toContain("enter 0 to use the plan's default, $20.00");
    const input = container.querySelector(
      "input[aria-label='Overage cap in US dollars']",
    ) as HTMLInputElement;
    expect(input.value).toBe("20.00");
    const save = buttonNamed(container, "Save cap");
    expect(save.disabled).toBe(true); // unchanged

    setInputValue(input, "abc");
    expect(save.disabled).toBe(true);
    expect(container.querySelector("[role='alert']")!.textContent).toContain("dollar amount");

    setInputValue(input, "40.50");
    expect(save.disabled).toBe(false);
    submit(container.querySelector("form")!);
    await flush();
    expect(container.textContent).toContain("$40.50");
    expect(container.querySelector("[role='status']")!.textContent).toBe("Overage cap saved.");

    // Emptying the field restores the plan's default.
    setInputValue(input, "");
    submit(container.querySelector("form")!);
    await flush();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { overage_cap_micros: 40_500_000 },
      { overage_cap_micros: 0 },
    ]);
    expect(input.value).toBe("20.00");
  });

  it("on a plan sold per seat, says an owner's cap is fixed and what the seats' default would be", async () => {
    // Team, five seats at $30: the default is $150, and an owner set $100.
    const team: BudgetView = { ...PRO, included_tokens: 150_000_000, remaining_tokens: 145_000_000, overage_cap_micros: 100_000_000 };
    const teamTerms = { plan: "team", per_seat: true, billed_seats: 5, default_overage_cap_micros: 150_000_000 };
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: team };
      if (method === "GET" && url === "/api/entitlements") return { status: 200, body: teamTerms };
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    await flush();
    expect(mounted.container.textContent).toContain(
      "Your limit is fixed at $100.00. The default for 5 seats would be $150.00.",
    );
  });

  it("says nothing about a fixed cap on the default, or on a plan not sold per seat", async () => {
    const teamTerms = { plan: "team", per_seat: true, billed_seats: 5, default_overage_cap_micros: 150_000_000 };
    const onDefault: BudgetView = { ...PRO, overage_cap_micros: 150_000_000 };
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: onDefault };
      if (method === "GET" && url === "/api/entitlements") return { status: 200, body: teamTerms };
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    await flush();
    expect(mounted.container.textContent).not.toContain("Your limit is fixed");
    mounted.unmount();
    vi.unstubAllGlobals();

    // Pro with its own $40 cap: the default does not move with seats, so there is nothing to say.
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: { ...PRO, overage_cap_micros: 40_000_000 } };
      if (method === "GET" && url === "/api/entitlements") return { status: 200, body: { ...ENTITLEMENTS, per_seat: false, billed_seats: 1 } };
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    await flush();
    expect(mounted.container.textContent).not.toContain("Your limit is fixed");
  });

  it("shows the API's refusal instead of pretending the save worked", async () => {
    stubApi(({ method, url }) =>
      method === "GET"
        ? url === "/api/budget"
          ? { status: 200, body: PRO }
          : undefined
        : { status: 502, body: { detail: "The limit is saved here but the model gateway did not accept it; retry to push it upstream." } },
    );
    mounted = await mount(<BudgetPane />, principalWith([], "owner"));
    const { container } = mounted;
    // Without the entitlements answer the default is still explained.
    expect(container.textContent).toContain("the plan's default, its monthly price");
    setInputValue(
      container.querySelector("input[aria-label='Overage cap in US dollars']") as HTMLInputElement,
      "1",
    );
    submit(container.querySelector("form")!);
    await flush();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("model gateway did not accept");
  });
});

describe("the member spend cap", () => {
  it("shows a member their own cap and what they have spent against it", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/budget"
        ? { status: 200, body: { ...PRO, member_cap: 25_000_000, member_spent: 2_500_000, member_exhausted: false } }
        : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    const text = mounted.container.textContent!;
    expect(text).toContain("Your spend cap");
    expect(text).toContain("$2.50");
    expect(text).toContain("$25.00");
    expect(text).toContain("an organisation administrator sets it");
    // No table for a member: what a colleague spent is not theirs to see.
    expect(mounted.container.querySelector("table")).toBeNull();
  });

  it("says when no cap applies, and when the member's own is reached", async () => {
    stubApi(({ url }) =>
      url === "/api/budget" ? { status: 200, body: { ...PRO, member_cap: null, member_spent: 0 } } : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["user"], "member"));
    expect(mounted.container.textContent).toContain("No cap applies to your own usage");
    mounted.unmount();
    vi.unstubAllGlobals();

    stubApi(({ url }) =>
      url === "/api/budget"
        ? { status: 200, body: { ...PRO, member_cap: 5_000_000, member_spent: 5_000_000, member_exhausted: true } }
        : undefined,
    );
    mounted = await mount(<BudgetPane />, principalWith(["user"], "viewer"));
    expect(mounted.container.textContent).toContain("Your monthly spend cap is reached");
  });

  it("gives an admin the default field and a table of members with the month's spend", async () => {
    let report = MEMBERS;
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: PRO };
      if (method === "GET" && url === "/api/entitlements") return { status: 200, body: ENTITLEMENTS };
      if (method === "GET" && url === "/api/budget/members") return { status: 200, body: report };
      if (method === "PUT" && url === "/api/budget/members") {
        const cap = (body as { member_default_cap_micros: number | null }).member_default_cap_micros;
        report = { ...report, member_default_cap_micros: cap };
        return { status: 200, body: report };
      }
      if (method === "PUT" && url === "/api/budget/members/alice") {
        const cap = (body as { cap_micros: number | null }).cap_micros;
        report = {
          ...report,
          data: report.data.map((row) =>
            row.subject === "alice"
              ? { ...row, own: cap !== null, cap_micros: cap ?? report.member_default_cap_micros }
              : row,
          ),
        };
        return { status: 200, body: report.data.find((row) => row.subject === "alice") };
      }
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "owner"));
    await flush();
    const { container } = mounted;

    const table = container.querySelector("table[aria-label='Spend caps by member']")!;
    expect(table).not.toBeNull();
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-subject"))).toEqual(["dev-user", "alice", "bob"]);
    const alice = rows[1]!;
    expect(alice.textContent).toContain("Alice (alice@example.com)");
    expect(alice.textContent).toContain("$2.50");
    // Bob is on the default and at it; the row says so.
    expect(rows[2]!.textContent).toContain("$10.00");
    expect(rows[2]!.textContent).toContain("at cap");

    // The default field reads the default; a member's own cap fills their
    // field, a member on the default has an empty one with the default as
    // its placeholder.
    const defaultInput = container.querySelector(
      "input[aria-label='Default spend cap per member in US dollars']",
    ) as HTMLInputElement;
    expect(defaultInput.value).toBe("10.00");
    const aliceInput = alice.querySelector("input") as HTMLInputElement;
    expect(aliceInput.value).toBe("25.00");
    const bobInput = rows[2]!.querySelector("input") as HTMLInputElement;
    expect(bobInput.value).toBe("");
    expect(bobInput.placeholder).toBe("10.00 (default)");

    // Raising the default sends micro-dollars; emptying it sends null.
    const saveDefault = buttonNamed(container, "Save default");
    expect(saveDefault.disabled).toBe(true);
    setInputValue(defaultInput, "40");
    expect(saveDefault.disabled).toBe(false);
    submit(saveDefault.closest("form")!);
    await flush();
    expect(container.querySelector("[role='status']")!.textContent).toBe("Saved.");
    setInputValue(defaultInput, "");
    submit(saveDefault.closest("form")!);
    await flush();

    // Alice's own cap: a new amount, then emptied to put her on the default.
    const saveAlice = buttonNamed(alice, "Save");
    expect(saveAlice.disabled).toBe(true);
    setInputValue(aliceInput, "abc");
    expect(saveAlice.disabled).toBe(true);
    setInputValue(aliceInput, "12.50");
    click(saveAlice);
    await flush();
    await flush();
    setInputValue(
      container.querySelector("tr[data-subject='alice'] input") as HTMLInputElement,
      "",
    );
    click(buttonNamed(container.querySelector("tr[data-subject='alice']")!, "Save"));
    await flush();

    expect(calls.filter((c) => c.method === "PUT").map((c) => [c.url, c.body])).toEqual([
      ["/api/budget/members", { member_default_cap_micros: 40_000_000 }],
      ["/api/budget/members", { member_default_cap_micros: null }],
      ["/api/budget/members/alice", { cap_micros: 12_500_000 }],
      ["/api/budget/members/alice", { cap_micros: null }],
    ]);
    // The table was re-read after each member save: the GETs outnumber the mount's one.
    expect(calls.filter((c) => c.method === "GET" && c.url === "/api/budget/members").length).toBe(3);
  });

  it("says so when there are no members to cap, rather than an empty table", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: PRO };
      if (method === "GET" && url === "/api/budget/members") return { status: 200, body: { ...MEMBERS, data: [] } };
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "admin"));
    await flush();
    const table = mounted.container.querySelector("table[aria-label='Spend caps by member']")!;
    expect(table.querySelector("tbody")!.textContent).toContain("No members to show yet.");
  });

  it("shows the API's refusal on a member's row", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/budget") return { status: 200, body: PRO };
      if (method === "GET" && url === "/api/budget/members") return { status: 200, body: MEMBERS };
      if (method === "PUT") return { status: 404, body: { detail: "No such member" } };
      return undefined;
    });
    mounted = await mount(<BudgetPane />, principalWith(["user"], "admin"));
    await flush();
    const bob = mounted.container.querySelector("tr[data-subject='bob']")!;
    setInputValue(bob.querySelector("input") as HTMLInputElement, "1");
    click(buttonNamed(bob, "Save"));
    await flush();
    expect(bob.querySelector("[role='alert']")!.textContent).toContain("No such member");
  });
});
