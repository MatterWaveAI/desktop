import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "@tanstack/react-router";
import type { AuthConfig, Principal } from "../../types";
import { router } from "../../routes";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { UsagePane } from "./panes/UsagePane";
import { BillingPane } from "./panes/BillingPane";
import { formatResetDate } from "../../lib/billing";
import { planEventReason } from "./panes/BillingPane";

/**
 * The Usage and Billing panes, mounted the way
 * settings.test.tsx mounts every pane, with `fetch` stubbed per route.
 *
 * What these prove is that each pane renders the STATE the API named --
 * warn, overage, exhausted; past due, free -- and not something it worked
 * out for itself from a percentage. The arithmetic is the API's and is
 * tested there (api/tests/test_usage.py); the pane's job is to not
 * contradict it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const authConfig: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "m" };

/** The org membership role is what the panes gate on; the platform claim is not. */
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
  return { ok: status < 400, status, statusText: "", headers: new Headers(), json: async () => body };
}

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = url.split("?")[0];
      if (path in routes) return json(routes[path]);
      return json({ detail: `no mock for ${path}` }, 404);
    }),
  );
}

async function render(node: React.ReactNode, orgRole: string | null = "member") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RouterContextProvider router={router}>
        <ShellContext.Provider value={shellValue(principalWith(orgRole))}>{node}</ShellContext.Provider>
      </RouterContextProvider>,
    );
  });
  // One more tick for the fetch-then-setState chain.
  await act(async () => {});
}

const text = () => container?.textContent ?? "";

/** The Billing pane's subscription state line. */
const state = () => container?.querySelector("[data-billing-state]")?.textContent ?? "";

const usage = (over: Record<string, unknown> = {}) => ({
  unit: "tokens",
  used: 0,
  included: 20_000_000,
  remaining: 20_000_000,
  percent: 0,
  warn: false,
  in_overage: false,
  exhausted: false,
  period_start: "2026-10-01",
  resets_at: "2026-11-01T00:00:00+00:00",
  plan: { code: "pro", name: "Pro" },
  seats: null,
  overage: { enabled: true, spent_micros: 0, cap_micros: 20_000_000 },
  models: [
    {
      model: "grt-nano",
      label: "GRT Nano",
      multiplier: 1,
      prompt_tokens: 100_000,
      completion_tokens: 20_000,
      tokens: 120_000,
      weighted_tokens: 120_000,
      cost_micros: 18_000,
      overage_micros: 0,
      requests: 6,
    },
    {
      model: "grt-nano-pro",
      label: "GRT Nano Pro",
      multiplier: 5,
      prompt_tokens: 7_000,
      completion_tokens: 1_000,
      tokens: 8_000,
      weighted_tokens: 40_000,
      cost_micros: 5_500,
      overage_micros: 0,
      requests: 2,
    },
  ],
  history: [
    { day: "2026-10-01", weighted_tokens: 120_000, tokens: 120_000, cost_micros: 18_000, overage_micros: 0, requests: 6 },
    { day: "2026-10-02", weighted_tokens: 40_000, tokens: 8_000, cost_micros: 5_500, overage_micros: 0, requests: 2 },
  ],
  ...over,
});

const billing = (over: Record<string, unknown> = {}) => ({
  org_id: "org-1",
  plan: "pro",
  plan_name: "Pro",
  status: "active",
  seats: 1,
  per_seat: false,
  billed_seats: 1,
  price_cents_monthly: 2000,
  price_cents_annual: 20000,
  implicit: false,
  current_period_end: "2026-11-01T00:00:00+00:00",
  cancel_at_period_end: false,
  billing_interval: "month",
  default_overage_cap_micros: 20_000_000,
  limits: { included_tokens: 20_000_000, overage_enabled: true },
  over_capacity: 0,
  writes_blocked: false,
  read_only_reason: null,
  billing_enabled: true,
  ...over,
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("UsagePane", () => {
  it("shows the balance in tokens with the reset date, and the history sums beside it", async () => {
    stub({ "/api/me/usage": usage({ used: 160_000, remaining: 19_840_000, percent: 0.8 }) });
    await render(<UsagePane />);
    expect(text()).toMatch(/19,840,000 tokens left/);
    expect(text()).toMatch(/Resets on/);
    // Each day is a short local date, the machine date on the <time> element.
    const day = container?.querySelector("table[aria-label='Usage by day'] time");
    expect(day?.getAttribute("datetime")).toBe("2026-10-01");
    expect(day?.textContent).toBe(new Date(2026, 9, 1).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    expect(text()).toMatch(/120,000/);
    // The bar is a share of its column, so it fits whatever width the card has.
    const bars = [...(container?.querySelectorAll("table[aria-label='Usage by day'] tbody [data-slot=meter] > div") ?? [])];
    expect(bars.map((b) => (b as HTMLElement).style.width)).toEqual(["100%", `${(40_000 / 120_000) * 100}%`]);
    expect(container?.querySelector("[role=meter]")?.getAttribute("aria-valuenow")).toBe("160000");
    expect(container?.querySelector("[data-usage-state]")?.getAttribute("data-usage-state")).toBe("ok");
  });

  it("says a per-seat allowance is the seats' tokens in one pool", async () => {
    stub({
      "/api/me/usage": usage({
        plan: { code: "team", name: "Team" },
        included: 150_000_000,
        remaining: 150_000_000,
        seats: { billed: 5, included_tokens_per_seat: 30_000_000 },
      }),
    });
    await render(<UsagePane />);
    expect(text()).toMatch(/150,000,000/);
    expect(container?.querySelector("[data-usage-seats]")?.textContent).toMatch(
      /Included: 5 seats × 30M tokens, one pool for the whole organisation/,
    );
  });

  it("says nothing about seats on a flat plan", async () => {
    stub({ "/api/me/usage": usage() });
    await render(<UsagePane />);
    expect(container?.querySelector("[data-usage-seats]")).toBeNull();
  });

  it("breaks the period down by model: label, raw tokens, multiplier, weighted tokens, dollars", async () => {
    stub({ "/api/me/usage": usage({ used: 160_000, remaining: 19_840_000, percent: 0.8 }) });
    await render(<UsagePane />);
    const pro = container?.querySelector("table[aria-label='Usage by model'] tr[data-model='grt-nano-pro']");
    const cells = [...(pro?.querySelectorAll("td") ?? [])].map((td) => td.textContent);
    // The label is the API's; the cost is sub-cent and still shown as money.
    expect(cells).toEqual(["GRT Nano Pro", "8,000", "5×", "40,000", "$0.0055", "$0.00"]);
  });

  it("shows compaction as the share of a model's row the API names, and the period's total", async () => {
    const base = usage();
    stub({
      "/api/me/usage": {
        ...base,
        // The API's fields: a part of the row's totals, and their sum.
        models: base.models.map((row, i) =>
          i === 0 ? { ...row, compaction_weighted_tokens: 900, compaction_requests: 2 } : row,
        ),
        compaction: { weighted_tokens: 900, requests: 2 },
      },
    });
    await render(<UsagePane />);
    const rows = [...(container?.querySelectorAll("tr[data-model='grt-nano']") ?? [])];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector("[data-usage-compaction-row]")?.textContent).toBe("900 weighted on summaries");
    expect(container?.querySelector("[data-usage-compaction]")?.textContent).toMatch(
      /Of these, 900 weighted tokens over 2 summaries went to compaction/,
    );
  });

  it("says nothing about compaction when the API sent none, or none happened", async () => {
    stub({ "/api/me/usage": usage() });
    await render(<UsagePane />);
    expect(container?.querySelector("[data-usage-compaction]")).toBeNull();
    expect(container?.querySelector("[data-usage-compaction-row]")).toBeNull();
  });

  it("renders the state the API named, never one it computed itself", async () => {
    stub({
      "/api/me/usage": usage({
        used: 5300,
        remaining: 0,
        percent: 106,
        in_overage: true,
        overage: { enabled: true, spent_micros: 6_250_000, cap_micros: 20_000_000 },
      }),
    });
    await render(<UsagePane />);
    expect(container?.querySelector("[data-usage-state]")?.getAttribute("data-usage-state")).toBe("overage");
    expect(text()).toMatch(/Past your included tokens/);
    expect(text()).toMatch(/\$6\.25 so far of a \$20\.00 overage cap/);
  });

  it("names the hard stop and the reset when a free allowance is used up", async () => {
    stub({
      "/api/me/usage": usage({
        used: 1_000_000,
        included: 1_000_000,
        remaining: 0,
        percent: 100,
        exhausted: true,
        plan: { code: "free", name: "Free" },
        overage: { enabled: false, spent_micros: 0, cap_micros: 0 },
        models: [],
        history: [],
      }),
    });
    await render(<UsagePane />);
    expect(container?.querySelector("[data-usage-state]")?.getAttribute("data-usage-state")).toBe("stop");
    expect(text()).toMatch(/Out of tokens for this period/);
    expect(text()).toMatch(/Nothing used yet/);
  });

  it("names the overage cap as the stop on a paid plan", async () => {
    stub({
      "/api/me/usage": usage({
        used: 25_000_000,
        remaining: 0,
        percent: 125,
        exhausted: true,
        overage: { enabled: true, spent_micros: 20_000_000, cap_micros: 20_000_000 },
      }),
    });
    await render(<UsagePane />);
    expect(text()).toMatch(/Overage cap reached/);
    expect(text()).toMatch(/raise the overage cap in Budget/);
  });

  it("offers the upgrade without overage, and the overage cap to an admin who has one", async () => {
    stub({ "/api/me/usage": usage({ overage: { enabled: false, spent_micros: 0, cap_micros: 0 } }) });
    await render(<UsagePane />, "admin");
    expect(text()).toMatch(/Upgrade for more tokens/);
    // A free org has no overage, so there is no cap to change.
    expect(text()).not.toMatch(/Change the overage cap/);
    act(() => root?.unmount());
    container?.remove();

    stub({ "/api/me/usage": usage() });
    await render(<UsagePane />, "admin");
    expect(text()).toMatch(/Change the overage cap/);
    expect(text()).not.toMatch(/Upgrade for more tokens/);
  });

  it("says why when the balance cannot be read", async () => {
    stub({});
    await render(<UsagePane />);
    expect(text()).toMatch(/Could not load usage/);
  });
});

describe("BillingPane", () => {
  it("says when the trial ends while the org is trialing", async () => {
    const ends = "2026-11-03T00:00:00+00:00";
    stub({ "/api/billing/status": billing({ status: "trialing", trial_end: ends }) });
    await render(<BillingPane />, "owner");
    const trial = container?.querySelector("[data-billing-trial]");
    expect(trial?.textContent).toContain(`Trial ends ${formatResetDate(ends)}`);
  });

  it("says nothing about a trial once the subscription is paying", async () => {
    stub({ "/api/billing/status": billing({ status: "active", trial_end: null }) });
    await render(<BillingPane />, "owner");
    expect(container?.querySelector("[data-billing-trial]")).toBeNull();
    expect(text()).not.toMatch(/Trial ends/);
  });

  it("shows the plan, the renewal, and Manage billing to an admin", async () => {
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, "owner");
    expect(text()).toMatch(/Pro/);
    expect(state()).toBe(`Active, renews ${formatResetDate("2026-11-01T00:00:00+00:00")}`);
    expect(text()).toMatch(/20,000,000 tokens \/ month/);
    expect(text()).toMatch(/List price, up to \$20\.00 by default/);
    expect(text()).toMatch(/Manage billing/);
    expect(container?.querySelector("[data-billing-notice]")).toBeNull();
  });

  it("says an annual subscription stops at the allowance and that monthly brings overage", async () => {
    stub({
      "/api/billing/status": billing({
        billing_interval: "year",
        default_overage_cap_micros: 0,
        limits: { included_tokens: 20_000_000, overage_enabled: false },
      }),
    });
    await render(<BillingPane />, "owner");
    expect(text()).toMatch(/Requests stop/);
    expect(text()).toMatch(/Annual plans include the same monthly allowance with no overage/);
    expect(text()).toMatch(/Choose monthly billing/);
  });

  it("bills a plan sold per seat as seats times the price, and says the seats follow the members", async () => {
    const team = {
      plan: "team",
      plan_name: "Team",
      per_seat: true,
      seats: 5,
      billed_seats: 5,
      price_cents_monthly: 3000,
      price_cents_annual: 30000,
      default_overage_cap_micros: 150_000_000,
      limits: { included_tokens: 150_000_000, included_tokens_per_seat: 30_000_000, overage_enabled: true },
    };
    stub({ "/api/billing/status": billing(team) });
    await render(<BillingPane />, "owner");
    const seats = container?.querySelector("[data-billing-seats]")?.textContent ?? "";
    expect(seats).toMatch(/5 seats × \$30 = \$150 \/ month/);
    expect(seats).toMatch(/Seats update automatically as members join or leave/);
    expect(text()).toMatch(/150,000,000 tokens \/ month/);
    expect(text()).toMatch(/5 seats × 30M tokens, one pool for everyone/);
    expect(text()).toMatch(/List price, up to \$150\.00 by default/);
    act(() => root?.unmount());
    container?.remove();

    stub({
      "/api/billing/status": billing({
        ...team,
        billing_interval: "year",
        seats: 1,
        billed_seats: 1,
        default_overage_cap_micros: 0,
        limits: { included_tokens: 30_000_000, included_tokens_per_seat: 30_000_000, overage_enabled: false },
      }),
    });
    await render(<BillingPane />, "owner");
    expect(container?.querySelector("[data-billing-seats]")?.textContent).toMatch(/1 seat × \$300 = \$300 \/ year/);
  });

  it("shows no seat bill on a flat plan", async () => {
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, "owner");
    expect(container?.querySelector("[data-billing-seats]")).toBeNull();
  });

  it("says nothing about annual billing to a monthly subscriber", async () => {
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, "owner");
    expect(text()).not.toMatch(/Annual plans/);
  });

  it("shows a member the state but not the controls", async () => {
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, "member");
    expect(text()).not.toMatch(/Manage billing/);
    expect(text()).toMatch(/Only an organisation admin/);
  });

  it("tells a member on the free default to ask an admin, before Choose a plan sends them to pricing", async () => {
    stub({ "/api/billing/status": billing({ plan: "free", plan_name: "Free", implicit: true, current_period_end: null }) });
    await render(<BillingPane />, "member");
    expect(text()).toMatch(/Ask an admin to subscribe/);
    expect(text()).toMatch(/You're on Free/);
  });

  it("treats a platform operator with no membership as a member here", async () => {
    // The API gates the portal on the membership row, so the claim alone
    // must not draw a button that would be refused.
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, null);
    expect(text()).not.toMatch(/Manage billing/);
  });

  it("tells a free org it is on Free, what that includes by name, and offers Upgrade", async () => {
    stub({
      "/api/billing/status": billing({
        plan: "free",
        plan_name: "Free",
        implicit: true,
        current_period_end: null,
        default_overage_cap_micros: 0,
        limits: { included_tokens: 1_000_000, overage_enabled: false, max_seats: 1, allowed_models: [] },
      }),
      "/api/plan/history": { data: [] },
      "/api/plans": {
        data: [{ code: "free", name: "Free", models: ["grt-nano"] }],
        models: [{ id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false }],
        default_model: "grt-nano",
      },
    });
    await render(<BillingPane />, "admin");
    expect(state()).toBe("You're on Free");
    const includes = container?.querySelector("ul[aria-label='What Free includes']")?.textContent ?? "";
    expect(includes).toMatch(/1,000,000 tokens a month/);
    expect(includes).toMatch(/1 seat/);
    // The model by its label, as the pricing page names it, not "the house model".
    expect(container?.querySelector("[data-billing-models]")?.textContent).toBe("GRT Nano");
    expect(includes).not.toMatch(/house model/);
    expect(includes).toMatch(/Requests stop/);
    const upgrade = [...(container?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Upgrade");
    expect(upgrade?.getAttribute("href")).toBe("/pricing");
    // Nothing that reads as missing: no subscription status, no "--" payment method.
    expect(text()).not.toMatch(/No subscription/);
    expect(container?.querySelector("[data-billing-payment-method]")).toBeNull();
    expect(text()).not.toMatch(/Manage billing/);
    expect(text()).not.toMatch(/Invoices/);
    expect(text()).toMatch(/Plan history/);
    expect(text()).toMatch(/No changes yet/);
  });

  it("counts the models while the catalog is out of reach", async () => {
    stub({
      "/api/billing/status": billing({
        plan: "free",
        plan_name: "Free",
        implicit: true,
        limits: { included_tokens: 1_000_000, overage_enabled: false, max_seats: 1, allowed_models: ["grt-nano-pro", "grt-nano-max"] },
      }),
      "/api/plan/history": { data: [] },
    });
    await render(<BillingPane />, "admin");
    expect(container?.querySelector("[data-billing-models]")?.textContent).toBe("3 models");
  });

  it("shows a reason without its Stripe id, keeping the id for the title", () => {
    expect(planEventReason("Checkout cs_test_1")).toEqual({ text: "Checkout", title: "Checkout cs_test_1" });
    expect(planEventReason("Checkout cs_live_a1B2c3D4e5")).toEqual({ text: "Checkout", title: "Checkout cs_live_a1B2c3D4e5" });
    expect(planEventReason("sub_1Nxyz")).toEqual({ text: "Stripe reference", title: "sub_1Nxyz" });
    // The API's own reasons carry underscores too, and are not ids.
    expect(planEventReason("subscription past_due")).toEqual({ text: "subscription past_due" });
    expect(planEventReason("invoice billing, net 30")).toEqual({ text: "invoice billing, net 30" });
  });

  it("lists the plan history to an admin, newest first, and not to a member", async () => {
    const history = [
      {
        from_plan: "pro",
        to_plan: "pro",
        from_status: "active",
        to_status: "past_due",
        kind: "status_change",
        actor: "stripe:evt_2",
        reason: null,
        created_at: "2026-10-03T09:00:00+00:00",
      },
      {
        from_plan: "free",
        to_plan: "pro",
        from_status: null,
        to_status: "active",
        kind: "upgrade",
        actor: "stripe:evt_1",
        reason: "Checkout cs_test_1",
        created_at: "2026-09-01T09:00:00+00:00",
      },
    ];
    stub({ "/api/billing/status": billing(), "/api/plan/history": { data: history } });
    await render(<BillingPane />, "owner");
    const rows = [...(container?.querySelectorAll("ul[aria-label='Plan history'] li") ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/Pro, now past due/);
    expect(rows[0].textContent).toMatch(/Status change · Stripe/);
    expect(rows[1].textContent).toMatch(/Free → Pro/);
    expect(rows[1].textContent).toMatch(/Upgrade · Stripe/);
    expect(rows[1].textContent).toMatch(/Checkout/);
    expect(rows[1].textContent).not.toMatch(/cs_test/);
    expect(rows[1].querySelector("[title]")?.getAttribute("title")).toBe("Checkout cs_test_1");
    expect(rows[1].querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-01T09:00:00+00:00");
    act(() => root?.unmount());
    container?.remove();

    // The trail is the org's commercial history: owner or admin only, like the API.
    stub({ "/api/billing/status": billing(), "/api/plan/history": { data: history } });
    await render(<BillingPane />, "member");
    expect(text()).not.toMatch(/Plan history/);
  });

  it("says in place when the plan history cannot be read, leaving the plan above intact", async () => {
    stub({ "/api/billing/status": billing() });
    await render(<BillingPane />, "owner");
    expect(text()).toMatch(/Active, renews/);
    const section = [...(container?.querySelectorAll("section") ?? [])].find((s) =>
      s.textContent?.includes("Plan history"),
    );
    expect(section?.querySelector("[role='alert']")).not.toBeNull();
  });

  it("says when a subscription cancels, and when it is past due, instead of the raw status", async () => {
    stub({ "/api/billing/status": billing({ cancel_at_period_end: true }) });
    await render(<BillingPane />, "owner");
    expect(state()).toBe(`Cancels on ${formatResetDate("2026-11-01T00:00:00+00:00")}`);
    act(() => root?.unmount());
    container?.remove();

    stub({ "/api/billing/status": billing({ status: "past_due" }) });
    await render(<BillingPane />, "owner");
    expect(state()).toBe("Past due");
    act(() => root?.unmount());
    container?.remove();

    const ends = "2026-11-03T00:00:00+00:00";
    stub({ "/api/billing/status": billing({ status: "trialing", trial_end: ends }) });
    await render(<BillingPane />, "owner");
    // The trial row below carries the date; the status does not repeat it.
    expect(state()).toBe("Free trial");
  });

  it("puts a failed payment at the top as a danger", async () => {
    stub({ "/api/billing/status": billing({ status: "past_due" }) });
    await render(<BillingPane />, "admin");
    const notice = container?.querySelector("[data-billing-notice]");
    expect(notice?.getAttribute("data-billing-notice")).toBe("danger");
    expect(notice?.textContent).toMatch(/payment failed/i);
  });
});
