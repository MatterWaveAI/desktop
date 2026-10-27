import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  formatMicros,
  formatMultiplier,
  formatPrice,
  formatResetDate,
  formatCompactCount,
  formatTokenAllowance,
  formatTokens,
  listOf,
  modelFamily,
  formatUsd,
  overageSummary,
  planAllowance,
  subscriptionNotice,
  upgradeRequired,
  type BillingStatus,
} from "./billing";

/**
 * The shared billing vocabulary. These are the rules every
 * money surface agrees on; a drift here is a pane and a banner saying two
 * different things about one number.
 */

const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
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
  limits: {},
  over_capacity: 0,
  writes_blocked: false,
  read_only_reason: null,
  billing_enabled: true,
  default_overage_cap_micros: 20_000_000,
  ...over,
});

describe("upgradeRequired", () => {
  it("reads the 402's headers rather than parsing its prose", () => {
    const err = new ApiError(402, "API keys need the Pro plan.", { detail: "x" }, "req-1", {
      "x-matterwave-upgrade-feature": "api_keys",
      "x-matterwave-plan": "free",
      "x-matterwave-upgrade-to": "pro",
    });
    expect(upgradeRequired(err)).toEqual({
      message: "API keys need the Pro plan.",
      feature: "api_keys",
      currentPlan: "free",
      upgradeTo: "pro",
    });
  });

  it("is null for anything that is not an upgrade refusal", () => {
    expect(upgradeRequired(new ApiError(403, "no"))).toBeNull();
    expect(upgradeRequired(new ApiError(402, "paywall", undefined, null, {}))).toMatchObject({
      // A 402 with no headers still renders, with the fallbacks, rather
      // than disappearing: the person was refused and must be told.
      feature: "this feature",
      currentPlan: "free",
      upgradeTo: null,
    });
    expect(upgradeRequired(new TypeError("network"))).toBeNull();
    expect(upgradeRequired(undefined)).toBeNull();
  });
});

describe("formatting", () => {
  it("names the unit, so a token count is never read as money", () => {
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(1250)).toBe("1,250 tokens");
    expect(formatTokens(0)).toBe("0 tokens");
  });

  it("reads an allowance as its round number", () => {
    expect(formatTokenAllowance(1_000_000)).toBe("1M tokens");
    expect(formatTokenAllowance(20_000_000)).toBe("20M tokens");
    expect(formatTokenAllowance(120_000_000)).toBe("120M tokens");
    expect(formatTokenAllowance(1_500_000)).toBe("1.5M tokens");
    expect(formatTokenAllowance(200_000)).toBe("200K tokens");
  });

  it("writes the suffix itself, the same in every locale, never Intl's lower-case m", () => {
    expect(formatCompactCount(1_000_000)).toBe("1M");
    expect(formatCompactCount(20_000_000)).toBe("20M");
    expect(formatCompactCount(200_000)).toBe("200K");
    expect(formatCompactCount(2_500_000_000)).toBe("2.5B");
    expect(formatCompactCount(999)).toBe("999");
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(1_250)).toBe("1.3K");
  });

  it("reads the family off the labels, and names models in a sentence", () => {
    const labels = (...l: string[]) => l.map((label) => ({ label }));
    expect(modelFamily(labels("GRT Nano", "GRT Nano Pro", "GRT Nano Max"))).toBe("GRT Nano");
    expect(modelFamily(labels("GRT Nano Pro", "GRT Nano Max"))).toBe("GRT Nano");
    expect(modelFamily(labels("Alpha One", "Beta One"))).toBeNull();
    expect(modelFamily(labels("Solo"))).toBe("Solo");
    expect(modelFamily([])).toBeNull();
    expect(listOf(["GRT Nano", "GRT Nano Pro", "GRT Nano Max"])).toBe("GRT Nano, GRT Nano Pro and GRT Nano Max");
    expect(listOf(["A", "B"])).toBe("A and B");
    expect(listOf(["A"])).toBe("A");
    expect(listOf([])).toBe("");
  });

  it("writes a multiplier as a factor", () => {
    expect(formatMultiplier(1)).toBe("1×");
    expect(formatMultiplier(20)).toBe("20×");
  });

  it("shows micro-dollars as ordinary money from a dollar up", () => {
    expect(formatMicros(20_000_000)).toBe("$20.00");
    expect(formatMicros(1_234_560_000)).toBe("$1,234.56");
    expect(formatMicros(1_000_000)).toBe("$1.00");
    expect(formatMicros(0)).toBe("$0.00");
  });

  it("never rounds a real sub-cent cost to nothing", () => {
    // A 500-token turn on the cheapest model: the API's own worked example.
    expect(formatMicros(125)).toBe("$0.000125");
    expect(formatMicros(1)).toBe("$0.000001");
    expect(formatMicros(5_000)).toBe("$0.005");
    expect(formatMicros(12_500)).toBe("$0.0125");
    expect(formatMicros(500_000)).toBe("$0.50");
    expect(formatMicros(123_456)).toBe("$0.123");
    // Three significant digits that round up to a dollar read as a dollar.
    expect(formatMicros(999_999)).toBe("$1.00");
  });

  it("reads list prices per million with the same rule", () => {
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(0.4)).toBe("$0.40");
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatUsd(0.075)).toBe("$0.075");
  });

  it("drops the cents when there are none", () => {
    expect(formatPrice(2000)).toBe("$20");
    expect(formatPrice(50)).toBe("$0.50");
    expect(formatPrice(0)).toBe("$0");
  });

  it("renders a reset as a day, never a time", () => {
    const text = formatResetDate("2026-11-01T00:00:00+00:00");
    expect(text).toMatch(/2026/);
    expect(text).not.toMatch(/:\d\d/);
  });

  describe("in a zone west of UTC", () => {
    // Node re-reads TZ on assignment; the web tsconfig carries no node types.
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const saved = env.TZ;
    afterEach(() => {
      if (saved === undefined) delete env.TZ;
      else env.TZ = saved;
    });

    it("keeps a UTC-midnight reset on its own day rather than the evening before", () => {
      env.TZ = "America/Los_Angeles";
      const text = formatResetDate("2026-11-01T00:00:00+00:00");
      expect(text).toMatch(/(^|\D)1(\D|$)/);
      expect(text).toMatch(/Nov/);
      expect(text).not.toMatch(/31|Oct/);
    });
  });
});

describe("subscriptionNotice", () => {
  it("is nothing for a healthy subscription, so the banner stays absent", () => {
    expect(subscriptionNotice(status())).toBeNull();
    expect(subscriptionNotice(status({ implicit: true, plan: "free" }))).toBeNull();
  });

  it("puts a failed payment first and says what to do", () => {
    const n = subscriptionNotice(status({ status: "past_due" }));
    expect(n?.tone).toBe("danger");
    expect(n?.text).toMatch(/payment failed/i);
    expect(n?.text).toMatch(/card/i);
  });

  it("repeats the API's own read-only reason rather than inventing one", () => {
    const n = subscriptionNotice(
      status({ writes_blocked: true, read_only_reason: "Over the free plan's 25 conversations." }),
    );
    expect(n).toEqual({ tone: "warning", text: "Over the free plan's 25 conversations." });
  });

  describe("a trial", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const trial = (trial_end: string, over: Partial<BillingStatus> = {}) =>
      status({ status: "trialing", trial_end, ...over });

    it("says nothing while the end is more than three days off", () => {
      expect(subscriptionNotice(trial("2026-11-05T12:00:00Z"), now)).toBeNull();
    });

    it("warns from three days out, with the day the card is charged", () => {
      const n = subscriptionNotice(trial("2026-11-04T12:00:00Z"), now);
      expect(n?.tone).toBe("warning");
      expect(n?.text).toMatch(/trial ends/i);
      expect(n?.text).toMatch(/card on file is charged on 4 Nov 2026|card on file is charged on Nov 4, 2026/);
    });

    it("on invoice terms says an invoice follows rather than a card", () => {
      const n = subscriptionNotice(trial("2026-11-02T12:00:00Z", { collection_method: "send_invoice" }), now);
      expect(n?.text).toMatch(/invoice/i);
      expect(n?.text).not.toMatch(/card/i);
    });

    it("on a trial that has been cancelled says the plan ends, not that a card is charged", () => {
      const n = subscriptionNotice(
        trial("2026-11-02T12:00:00Z", { cancel_at_period_end: true, current_period_end: "2026-11-02T12:00:00Z" }),
        now,
      );
      expect(n?.text).toMatch(/ends on/);
      expect(n?.text).not.toMatch(/charged/);
    });
  });

  it("names the end date of a plan that is winding down", () => {
    const n = subscriptionNotice(status({ cancel_at_period_end: true }));
    expect(n?.tone).toBe("warning");
    expect(n?.text).toMatch(/ends on .*2026/);
  });
});

describe("overageSummary", () => {
  const plan = {
    code: "pro",
    name: "Pro",
    price_cents_monthly: 2000,
    price_cents_annual: 20000,
    included_tokens: 20_000_000,
    overage_enabled: true,
    default_overage_cap_micros: 20_000_000,
    models: ["grt-nano", "grt-nano-pro"],
    limits: {},
  } as unknown as Parameters<typeof overageSummary>[0];

  it("names list price and the default cap for a monthly plan with overage", () => {
    expect(overageSummary(plan)).toBe("Then list price, up to $20.00 of overage a month by default");
  });

  it("stops an annual plan at the allowance even when the plan has overage monthly", () => {
    expect(overageSummary(plan, true)).toMatch(/^Stops at the allowance/);
    expect(overageSummary(plan, true)).toMatch(/monthly only/);
  });

  it("stops a plan without overage either way", () => {
    const free = { ...plan, overage_enabled: false };
    expect(overageSummary(free)).toBe("Stops at the allowance");
    expect(overageSummary(free, true)).toBe("Stops at the allowance");
  });
});

describe("a plan sold per seat", () => {
  const team = {
    code: "team",
    name: "Team",
    price_cents_monthly: 3000,
    price_cents_annual: 30000,
    included_tokens: 0,
    included_tokens_per_seat: 30_000_000,
    per_seat: true,
    overage_enabled: true,
    default_overage_cap_micros: 30_000_000,
    models: ["grt-nano"],
    limits: {},
  } as unknown as Parameters<typeof planAllowance>[0];
  const pro = { ...team, code: "pro", included_tokens: 20_000_000, included_tokens_per_seat: null, per_seat: false };

  it("states its allowance per seat, pooled, and a flat plan's as one number", () => {
    expect(planAllowance(team)).toBe("30M tokens per seat, pooled");
    expect(planAllowance({ ...team, included_tokens: 5_000_000 })).toBe("5M tokens plus 30M tokens per seat, pooled");
    expect(planAllowance(pro)).toBe("20M tokens");
  });

  it("states its default overage cap per seat", () => {
    expect(overageSummary(team)).toBe("Then list price, up to $30.00 per seat of overage a month by default");
    expect(overageSummary(pro)).not.toContain("per seat");
  });
});
