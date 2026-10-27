import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, principalWith, stubApi, type Mounted } from "../settings/panes/paneHarness";
import { BillingTab } from "./BillingTab";
import type { BillingOverview } from "./adminApi";

/**
 * The Stripe price ids an operator pastes onto a plan: each field is
 * labelled by what it is, and the page says where the ids come from.
 */

const OVERVIEW: BillingOverview = {
  configured: true,
  has_api_key: true,
  has_webhook_secret: true,
  upstream_enforcement: true,
  plans_without_prices: [],
  plans: [
    {
      code: "free",
      name: "Free",
      price_cents_monthly: 0,
      price_cents_annual: 0,
      stripe_price_id_monthly: null,
      stripe_price_id_annual: null,
      sellable: false,
      limits: {},
    },
    {
      code: "pro",
      name: "Pro",
      price_cents_monthly: 2000,
      price_cents_annual: 20000,
      stripe_price_id_monthly: "price_m",
      stripe_price_id_annual: null,
      sellable: true,
      limits: {},
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

describe("the plans and their Stripe prices", () => {
  it("labels each price id field and says where the ids come from", async () => {
    stubApi((call) => {
      if (call.url === "/api/admin/billing") return { status: 200, body: OVERVIEW };
      if (call.url === "/api/admin/billing/events") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<BillingTab />, principalWith(["admin"]));
    const section = mounted.container.querySelector("section[aria-labelledby='billing-plans']")!;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain("Stripe Dashboard, under Products");
    expect(section.textContent).toContain("price_");

    const pro = [...section.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes("Pro"))!;
    const labels = [...pro.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Monthly price id", "Annual price id"]);
    for (const label of pro.querySelectorAll<HTMLLabelElement>("label")) {
      const input = pro.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`);
      expect(input, label.textContent ?? "").not.toBeNull();
      // The placeholder shows the id's shape and nothing it would have to say twice.
      expect(input!.placeholder).toBe("price_…");
    }
    expect(pro.querySelector<HTMLInputElement>("input[aria-label='Pro monthly Stripe price id']")?.value).toBe(
      "price_m",
    );

    // Free is not sold, so it has no fields to label.
    const free = [...section.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes("Free"))!;
    expect(free.querySelectorAll("label")).toHaveLength(0);
    expect(free.textContent).toContain("Not sold through Checkout");
  });
});
