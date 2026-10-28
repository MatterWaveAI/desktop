import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { PRICING_PATH } from "../../shell/frontDoor";
import {
  authConfig,
  callTo,
  cleanup,
  fill,
  jsonResponse,
  mount,
  stubApi,
  submit,
  view,
  type Answer,
} from "../../shell/frontDoorHarness";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { SessionContext } from "../../shell/sessionContext";
import type { Principal } from "../../types";
import { PricingPage } from "./PricingPage";

/**
 * /pricing as a stranger sees it: each plan's token allowance, what happens
 * past it, and the models it includes by label, then the per-model price
 * table -- every number from `GET /api/plans`, none written in the page.
 */

const PLANS = {
  data: [
    {
      code: "free",
      name: "Free",
      price_cents_monthly: 0,
      price_cents_annual: 0,
      included_tokens: 1_000_000,
      overage_enabled: false,
      default_overage_cap_micros: 0,
      models: ["grt-nano"],
      limits: { max_seats: 1, max_conversations: 25, allowed_models: [], features: { api_keys: true } },
    },
    {
      code: "pro",
      name: "Pro",
      price_cents_monthly: 2000,
      price_cents_annual: 20000,
      included_tokens: 20_000_000,
      overage_enabled: true,
      default_overage_cap_micros: 20_000_000,
      models: ["grt-nano", "grt-nano-pro"],
      limits: { max_seats: 5, max_conversations: null, allowed_models: ["grt-nano-pro"], features: { api_keys: true } },
    },
    {
      code: "pro_plus",
      name: "Pro Plus",
      price_cents_monthly: 6000,
      price_cents_annual: 60000,
      included_tokens: 60_000_000,
      overage_enabled: true,
      default_overage_cap_micros: 60_000_000,
      models: ["grt-nano", "grt-nano-pro", "grt-nano-max"],
      limits: { max_seats: 10, max_conversations: null, allowed_models: ["grt-nano-pro", "grt-nano-max"], features: { api_keys: true } },
    },
  ],
  models: [
    { id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false },
    { id: "grt-nano-pro", label: "GRT Nano Pro", multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2, partner: false },
    { id: "grt-nano-max", label: "GRT Nano Max", multiplier: 20, input_usd_per_m: 2, output_usd_per_m: 8, partner: false },
    { id: "glm-4.6", label: "glm-4.6", multiplier: 1, input_usd_per_m: 0.6, output_usd_per_m: 2.2, partner: true },
  ],
  default_model: "grt-nano",
};

const TEAM = {
  code: "team",
  name: "Team",
  price_cents_monthly: 3000,
  price_cents_annual: 30000,
  included_tokens: 0,
  included_tokens_per_seat: 30_000_000,
  per_seat: true,
  overage_enabled: true,
  default_overage_cap_micros: 30_000_000,
  models: ["grt-nano", "grt-nano-pro", "grt-nano-max"],
  limits: { max_seats: null, max_conversations: null, allowed_models: ["grt-nano-pro", "grt-nano-max"], features: { org_sso: true } },
};

afterEach(cleanup);

async function open(plans: unknown = PLANS): Promise<void> {
  stubApi({ "/api/plans": jsonResponse(plans) });
  await mount(PRICING_PATH, { [PRICING_PATH]: PricingPage });
  await vi.waitFor(() => expect(view().querySelector("ul[aria-label='Plans']")).not.toBeNull());
}

describe("/pricing", () => {
  it("puts nothing under the loading plans for their arrival to push down", async () => {
    stubApi({});
    const answer = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/plans" ? new Promise<Response>(() => undefined) : answer(input, init),
      ),
    );
    await mount(PRICING_PATH, { [PRICING_PATH]: PricingPage });
    await vi.waitFor(() => expect(view().querySelector("[role=status]")?.textContent).toContain("Loading"));
    expect(view().querySelector("section[aria-labelledby='enterprise-contact']")).toBeNull();
  });

  it("offers a plan's free trial on its card, and says nothing on a plan without one", async () => {
    const [free, pro, plus] = PLANS.data;
    await open({ ...PLANS, data: [{ ...free, trial_days: 0 }, { ...pro, trial_days: 14 }, plus] });
    const card = view().querySelector("li[data-plan='pro']")!;
    expect(card.querySelector("[data-plan-trial]")?.textContent).toBe("14-day free trial");
    expect(view().querySelector("li[data-plan='pro_plus'] [data-plan-trial]")).toBeNull();
    expect(view().querySelector("li[data-plan='free'] [data-plan-trial]")).toBeNull();
  });

  it("states each plan's allowance in tokens, what happens past it, and its models by label", async () => {
    await open();
    const free = view().querySelector("li[data-plan='free']")!;
    expect(free.textContent).toContain("1M tokens / month");
    expect(free.textContent).toContain("Stops at the allowance");
    expect(free.textContent).toContain("GRT Nano");
    expect(free.textContent).not.toContain("GRT Nano Pro");
    // API keys are on every plan, free included; the card says so.
    expect(free.textContent).toContain("API keys");

    const pro = view().querySelector("li[data-plan='pro']")!;
    expect(pro.textContent).toContain("20M tokens / month");
    // The default overage cap is the plan's own monthly price.
    expect(pro.textContent).toContain("$20");
    expect(pro.textContent).toContain("up to $20.00 of overage a month by default");
    expect(pro.textContent).toContain("GRT Nano, GRT Nano Pro");

    const plus = view().querySelector("li[data-plan='pro_plus']")!;
    expect(plus.textContent).toContain("GRT Nano, GRT Nano Pro, GRT Nano Max");
    expect(view().textContent?.toLowerCase()).not.toContain("credit");
  });

  it("prices Team per seat, with each seat's tokens in one pool and no seat count to choose", async () => {
    await open({ ...PLANS, data: [...PLANS.data, TEAM] });
    const team = view().querySelector("li[data-plan='team']")!;
    expect(team.textContent).toContain("$30 per seat / month");
    expect(team.textContent).toContain("30M tokens per seat, pooled");
    expect(team.textContent).toContain("up to $30.00 per seat of overage a month by default");
    expect(team.textContent).not.toContain("Unlimited seats");
    expect(team.querySelector("input")).toBeNull();
    const annual = [...view().querySelectorAll("button")].find((b) => b.textContent === "Annual")!;
    await act(async () => annual.click());
    expect(view().querySelector("li[data-plan='team']")!.textContent).toContain("$300 per seat / year");
    // A flat plan beside it still reads flat.
    expect(view().querySelector("li[data-plan='pro']")!.textContent).not.toContain("per seat");
  });

  it("says annual plans have no overage, and the annual cards stop at the allowance", async () => {
    await open();
    expect(view().textContent).toContain("Annual plans include the same monthly allowance with no overage");
    expect(view().textContent).toContain("Choose monthly billing");
    const annual = [...view().querySelectorAll("button")].find((b) => b.textContent === "Annual")!;
    await act(async () => annual.click());
    const pro = view().querySelector("li[data-plan='pro']")!;
    expect(pro.textContent).toContain("Stops at the allowance (pay-as-you-go beyond it is monthly only)");
    expect(pro.textContent).not.toContain("of overage a month");
  });

  it("lists each GRT model's multiplier and list price per million, and which plans include it", async () => {
    await open();
    const table = view().querySelector("table[aria-label='Model prices']")!;
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ["1×", "$0.10", "$0.40", "Every plan"],
      ["5×", "$0.50", "$2.00", "Pro, Pro Plus"],
      ["20×", "$2.00", "$8.00", "Pro Plus"],
    ]);
    const names = [...table.querySelectorAll("tbody th")].map((th) => th.firstChild?.textContent);
    expect(names).toEqual(["GRT Nano", "GRT Nano Pro", "GRT Nano Max"]);
  });

  it("lists partner models apart, as optional and only on plans that name them", async () => {
    await open();
    expect(view().querySelector("table[aria-label='Model prices'] tr[data-model='glm-4.6']")).toBeNull();
    const partners = view().querySelector("table[aria-label='Partner model prices']")!;
    const row = partners.querySelector("tr[data-model='glm-4.6']")!;
    expect([...row.querySelectorAll("td")].map((td) => td.textContent)).toEqual([
      "1×",
      "$0.60",
      "$2.20",
      "Only plans that name it",
    ]);
    const section = partners.closest("section")!;
    expect(section.querySelector("h2")?.textContent).toBe("Partner models");
    expect(section.textContent).toContain("offered for testing");
    expect(section.textContent).toContain("available only on a plan that names them");
    // No plan card claims every model.
    expect(view().textContent).not.toMatch(/every model|all models/i);
  });

  it("sends the enterprise contact form as a lead and thanks the sender", async () => {
    const fetchMock = stubApi({
      "/api/plans": jsonResponse(PLANS),
      "/api/enterprise/contact": jsonResponse({ status: "received" }, 202),
    });
    await mount(PRICING_PATH, { [PRICING_PATH]: PricingPage });
    await vi.waitFor(() => expect(view().querySelector("section[aria-labelledby='enterprise-contact']")).not.toBeNull());
    fill({ name: "Dana Buyer", email: "dana@bigco.test", company: "BigCo", seats: "200" });
    await submit();
    await vi.waitFor(() => expect(view().querySelector("[role='status']")?.textContent).toContain("Thanks"));
    const call = callTo(fetchMock, "/api/enterprise/contact");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      name: "Dana Buyer",
      email: "dana@bigco.test",
      company: "BigCo",
      seats: 200,
      page: expect.any(String),
    });
  });

  it("says where to write when the deployment has no CRM", async () => {
    stubApi({
      "/api/plans": jsonResponse(PLANS),
      "/api/enterprise/contact": jsonResponse(
        { detail: "The contact form is not switched on here. Email sales@matterwave.dev." },
        503,
      ),
    });
    await mount(PRICING_PATH, { [PRICING_PATH]: PricingPage });
    await vi.waitFor(() => expect(view().querySelector("section[aria-labelledby='enterprise-contact']")).not.toBeNull());
    fill({ name: "A", email: "a@b.test", company: "B" });
    await submit();
    await vi.waitFor(() => expect(view().querySelector("[role='alert']")?.textContent).toContain("sales@matterwave.dev"));
    expect(view().querySelector("a[href='mailto:sales@matterwave.dev']")).not.toBeNull();
  });

  it("shows what annual billing saves", async () => {
    await open();
    expect(view().querySelector("[data-annual-saving]")?.textContent).toContain("2 months free");
    const annual = [...view().querySelectorAll("button")].find((b) => b.textContent === "Annual")!;
    await act(async () => annual.click());
    expect(view().querySelector("li[data-plan='pro'] [data-plan-saving]")?.textContent).toBe("2 months free");
    expect(view().querySelector("li[data-plan='free'] [data-plan-saving]")).toBeNull();
  });

  it("says so when the buyer came back from a cancelled checkout", async () => {
    stubApi({ "/api/plans": jsonResponse(PLANS) });
    await mount(`${PRICING_PATH}?checkout=cancelled`, { [PRICING_PATH]: PricingPage });
    await vi.waitFor(() => expect(view().querySelector("ul[aria-label='Plans']")).not.toBeNull());
    expect(view().querySelector("[data-checkout-cancelled]")?.textContent).toMatch(/Checkout was cancelled.*nothing was charged/i);
  });
});

describe("/pricing as a stranger: the chrome, the badge, the grid and the questions", () => {
  it("wears the front door's header and footer, with every way in", async () => {
    await open();
    const header = view().querySelector("nav[aria-label='MatterWave']")!;
    // The front-door header carries the brand and the ways into the app;
    // there is no nav row and no aria-current link on it.
    const hrefs = [...header.querySelectorAll("a")].map((a) => `${a.textContent}|${a.getAttribute("href")}`);
    expect(hrefs).toEqual(["MatterWave ai|/", "Sign in|/login", "Create account|/signup"]);
    const footer = view().querySelector("nav[aria-label='About MatterWave']")!;
    expect([...footer.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Terms", "Privacy", "Acceptable use", "Contact"]);
  });

  it("recommends the cheapest paid plan sold flat, and only that one, with a one-line reason", async () => {
    await open({ ...PLANS, data: [...PLANS.data, TEAM] });
    const badged = [...view().querySelectorAll("li[data-plan-recommended]")].map((li) => li.getAttribute("data-plan"));
    expect(badged).toEqual(["pro"]);
    expect(view().querySelector("li[data-plan='pro'] [data-plan-badge]")?.textContent).toBe("Recommended");
    expect(view().querySelector("li[data-plan='pro'] [data-plan-reason]")?.textContent).toBe("Most teams start here");
    expect(view().querySelector("li[data-plan='free']")?.textContent).not.toContain("Recommended");
  });

  it("sets the annual saving as a badge and the trial as plain text, so they do not read as one offer", async () => {
    const [free, pro, plus] = PLANS.data;
    await open({ ...PLANS, data: [free, { ...pro, trial_days: 14 }, plus] });
    const annual = [...view().querySelectorAll("button")].find((b) => b.textContent === "Annual")!;
    await act(async () => annual.click());
    const saving = view().querySelector("li[data-plan='pro'] [data-plan-saving]")!;
    const trial = view().querySelector("li[data-plan='pro'] [data-plan-trial]")!;
    expect(saving.textContent).toBe("2 months free");
    expect(saving.className).toContain("rounded-full");
    expect(trial.textContent).toBe("14-day free trial");
    expect(trial.className).not.toContain("rounded-full");
    expect(trial.className).not.toContain("text-mw-link");
  });

  it("says who can cancel: an owner or admin from Settings, Billing, not a member", async () => {
    await open();
    const answer = [...view().querySelectorAll("#pricing-faq ~ dl dd")].map((dd) => dd.textContent).find((t) => t?.includes("cancel"));
    expect(answer).toContain("owner or admin can cancel or change the plan from Settings, Billing; a member cannot");
  });

  it("compares the plans in a grid read from the catalog, and follows the billing period", async () => {
    await open({ ...PLANS, data: [...PLANS.data, TEAM] });
    const table = view().querySelector("table[aria-label='Plan comparison']")!;
    const heads = [...table.querySelectorAll("thead th")].slice(1).map((th) => th.textContent);
    expect(heads).toEqual(["Free", "Pro", "Pro Plus", "Team"]);
    const cells = (key: string) => [...table.querySelectorAll(`tr[data-compare='${key}'] td`)].map((td) => td.textContent);
    expect(cells("price")).toEqual(["Free", "$20 / month", "$60 / month", "$30 per seat / month"]);
    expect(cells("seats")).toEqual(["1", "5", "10", "One per member"]);
    expect(cells("conversations")).toEqual(["25", "Unlimited", "Unlimited", "Unlimited"]);
    expect(cells("feature:api_keys")).toEqual(["Included", "Included", "Included", "—"]);
    expect(cells("feature:org_sso")).toEqual(["—", "—", "—", "Included"]);
    const annual = [...view().querySelectorAll("button")].find((b) => b.textContent === "Annual")!;
    await act(async () => annual.click());
    expect(cells("price")).toEqual(["Free", "$200 / year", "$600 / year", "$300 per seat / year"]);
    expect(cells("overage")[1]).toContain("Stops at the allowance");
  });

  it("puts the overage explanation under the cards, not in the header", async () => {
    await open();
    const header = view().querySelector("header")!;
    expect(header.textContent).not.toContain("overage cap");
    const cards = view().querySelector("ul[aria-label='Plans']")!;
    const how = view().querySelector("#allowance-how")!;
    expect(how.textContent).toBe("How the allowance works");
    // DOCUMENT_POSITION_FOLLOWING: the explanation comes after the cards.
    expect(cards.compareDocumentPosition(how) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(how.parentElement?.textContent).toContain("Annual plans include the same monthly allowance with no overage");
  });

  it("labels the annual saving as a saving, beside the toggle", async () => {
    await open();
    expect(view().querySelector("[data-annual-saving]")?.textContent).toBe("Up to 2 months free on annual billing");
    expect(view().textContent).not.toContain("Annual: up to");
  });

  it("answers the buyer's questions from the terms, and asks about a trial only when a plan has one", async () => {
    await open();
    const questions = () => [...view().querySelectorAll("#pricing-faq ~ dl dt")].map((dt) => dt.textContent);
    expect(questions()).toEqual([
      "How am I billed?",
      "What happens when I reach my allowance?",
      "What is the overage cap?",
      "How do seats work?",
      "Can I cancel or change plans?",
    ]);
    const answers = view().querySelector("#pricing-faq ~ dl")!.textContent ?? "";
    expect(answers).toContain("runs to the end of the period already paid for");
    expect(answers).toContain("never deletes anything");
    expect(answers).toContain("requests stop until the month resets");
    cleanup();

    const [free, pro, plus] = PLANS.data;
    await open({ ...PLANS, data: [free, { ...pro, trial_days: 14 }, plus] });
    expect(questions()).toContain("Does a free trial need a card?");
  });
});

describe("/pricing signed in but held at a gate", () => {
  const principal: Principal = {
    subject: "eve",
    kind: "user",
    email: "eve@acme.com",
    name: null,
    roles: [],
    org_id: "org-a",
    org_name: null,
    org_role: "owner",
  };

  async function openGated(gate: "terms" | "pending"): Promise<void> {
    stubApi({ "/api/plans": jsonResponse(PLANS) });
    const Page = () => (
      <SessionContext.Provider value={{ config: authConfig, principal, gate }}>
        <PricingPage />
      </SessionContext.Provider>
    );
    await mount(PRICING_PATH, { [PRICING_PATH]: Page });
    await vi.waitFor(() => expect(view().querySelector("ul[aria-label='Plans']")).not.toBeNull());
  }

  it("never offers an account to a person who has one: the terms gate sends them back to accept", async () => {
    await openGated("terms");
    expect(view().textContent).not.toContain("Create account");
    expect(view().textContent).not.toContain("Sign up to subscribe");
    expect(view().querySelector("nav[aria-label='MatterWave']")).toBeNull();
    const pro = view().querySelector("li[data-plan='pro'] [data-gate-action='terms']")!;
    expect(pro.textContent).toContain("Accept the updated terms");
    expect(pro.querySelector("a")?.getAttribute("href")).toBe("/");
    expect(view().querySelector("li[data-plan='free']")?.textContent).toContain("Included with every account");
  });

  it("sends an unverified account to the code page with its address", async () => {
    await openGated("pending");
    const link = view().querySelector("li[data-plan='pro'] [data-gate-action='pending'] a")!;
    expect(link.textContent).toBe("Verify your email");
    expect(link.getAttribute("href")).toBe("/verify?email=eve%40acme.com");
  });
});

describe("/pricing signed in as an admin", () => {
  const STATUS = {
    org_id: "org-a",
    plan: "free",
    plan_name: "Free",
    status: "active",
    implicit: true,
    billing_enabled: true,
  };

  function shell(): ShellContextValue {
    return {
      principal: { subject: "eve", kind: "user", email: "eve@acme.com", name: null, roles: [], org_id: "org-a", org_name: null, org_role: "owner" },
    } as unknown as ShellContextValue;
  }

  async function openSignedIn(status: Answer): Promise<void> {
    stubApi({ "/api/plans": jsonResponse(PLANS), "/api/billing/status": status });
    const value = shell();
    const Page = () => (
      <ShellContext.Provider value={value}>
        <PricingPage />
      </ShellContext.Provider>
    );
    await mount(PRICING_PATH, { [PRICING_PATH]: Page });
    await vi.waitFor(() => expect(view().querySelector("ul[aria-label='Plans']")).not.toBeNull());
  }

  it("marks the implicit Free plan as the current one, badged 'Your plan', and still recommends Pro", async () => {
    await openSignedIn(jsonResponse(STATUS));
    await vi.waitFor(() =>
      expect(view().querySelector("li[data-plan='free']")?.textContent).toContain("Your current plan"),
    );
    expect(view().querySelector("li[data-plan='free'] [data-plan-badge]")?.textContent).toBe("Your plan");
    expect(view().querySelector("li[data-plan='free'] [data-plan-recommended]")).toBeNull();
    const badged = [...view().querySelectorAll("li[data-plan-recommended]")].map((li) => li.getAttribute("data-plan"));
    expect(badged).toEqual(["pro"]);
  });

  it("never recommends a plan below the one the organisation pays for: on Pro Plus, no Recommended badge at all", async () => {
    await openSignedIn(jsonResponse({ ...STATUS, plan: "pro_plus", plan_name: "Pro Plus", implicit: false }));
    await vi.waitFor(() =>
      expect(view().querySelector("li[data-plan='pro_plus'] [data-plan-badge]")?.textContent).toBe("Your plan"),
    );
    expect(view().querySelectorAll("li[data-plan-recommended]")).toHaveLength(0);
    expect(view().textContent).not.toContain("Recommended");
  });

  it("badges nothing while the subscription is still being checked", async () => {
    stubApi({ "/api/plans": jsonResponse(PLANS), "/api/billing/status": new Promise<Record<string, unknown>>(() => {}) });
    const value = shell();
    const Page = () => (
      <ShellContext.Provider value={value}>
        <PricingPage />
      </ShellContext.Provider>
    );
    await mount(PRICING_PATH, { [PRICING_PATH]: Page });
    await vi.waitFor(() => expect(view().querySelector("ul[aria-label='Plans']")).not.toBeNull());
    expect(view().textContent).toContain("Checking billing…");
    expect(view().querySelectorAll("[data-plan-badge]")).toHaveLength(0);
  });

  it("inside the shell, shows the way back to billing at the top and no front-door header", async () => {
    await openSignedIn(jsonResponse(STATUS));
    expect(view().querySelector("nav[aria-label='MatterWave']")).toBeNull();
    const back = [...view().querySelectorAll("a")].find((a) => a.textContent?.includes("Back to Settings"))!;
    expect(back.getAttribute("href")).toBe("/settings/billing");
    expect(view().textContent).not.toContain("Create account");
  });

  it("with billing off, says why on each card and offers sales instead of a dead button", async () => {
    await openSignedIn(jsonResponse({ ...STATUS, billing_enabled: false }));
    await vi.waitFor(() =>
      expect(view().querySelector("li[data-plan='pro']")?.textContent).toContain("not open on this deployment yet"),
    );
    const pro = view().querySelector("li[data-plan='pro']")!;
    expect(pro.querySelector("button")).toBeNull();
    expect(pro.querySelector("a[href='#enterprise-contact']")?.textContent).toBe("Contact sales");
  });

  it("shows a failed billing check with a retry, instead of buttons disabled for ever", async () => {
    await openSignedIn(jsonResponse({ detail: "Billing is down." }, 503));
    await vi.waitFor(() => expect(view().querySelector("[role='alert']")?.textContent).toContain("Billing is down."));
    const pro = view().querySelector("li[data-plan='pro']")!;
    expect(pro.querySelector("button[disabled]")).toBeNull();
    stubApi({ "/api/plans": jsonResponse(PLANS), "/api/billing/status": jsonResponse(STATUS) });
    const retry = [...view().querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await vi.waitFor(() =>
      expect([...view().querySelectorAll("li[data-plan='pro'] button")].map((b) => b.textContent)).toEqual(["Subscribe"]),
    );
    expect(view().querySelector("[role='alert']")).toBeNull();
  });
});
