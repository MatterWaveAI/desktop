import { describe, expect, it } from "vitest";
import type { ModelPrice, PlanSummary } from "../../lib/billing";
import { annualSaving, comparisonRows, recommendedPlan } from "./planComparison";

/**
 * The comparison grid and the Recommended badge are read from the catalog:
 * every row is a limit or a feature the payload carries, and a feature the
 * catalog grows later gets a row without a deploy.
 */

const MODELS: ModelPrice[] = [
  { id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false },
  { id: "grt-nano-pro", label: "GRT Nano Pro", multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2, partner: false },
];

function plan(overrides: Partial<PlanSummary> & Pick<PlanSummary, "code" | "name">): PlanSummary {
  return {
    price_cents_monthly: 0,
    price_cents_annual: 0,
    included_tokens: 1_000_000,
    included_tokens_per_seat: null,
    per_seat: false,
    overage_enabled: false,
    default_overage_cap_micros: 0,
    models: ["grt-nano"],
    limits: { max_seats: 1, max_conversations: 25, allowed_models: [], features: { api_keys: true } },
    ...overrides,
  };
}

const FREE = plan({ code: "free", name: "Free", limits: { max_seats: 1, max_conversations: 25, allowed_models: [], features: { api_keys: true, custom_instructions: false }, tpm_limit: 10000, rpm_limit: 20 } });
const PRO = plan({
  code: "pro",
  name: "Pro",
  price_cents_monthly: 2000,
  price_cents_annual: 20000,
  included_tokens: 20_000_000,
  overage_enabled: true,
  default_overage_cap_micros: 20_000_000,
  models: ["grt-nano", "grt-nano-pro"],
  limits: { max_seats: 1, max_conversations: null, allowed_models: ["grt-nano-pro"], features: { api_keys: true, custom_instructions: true, beta_tools: true }, tpm_limit: 100000, rpm_limit: 120 },
});
const TEAM = plan({
  code: "team",
  name: "Team",
  price_cents_monthly: 3000,
  price_cents_annual: 30000,
  included_tokens: 0,
  included_tokens_per_seat: 30_000_000,
  per_seat: true,
  overage_enabled: true,
  default_overage_cap_micros: 30_000_000,
  models: ["grt-nano", "grt-nano-pro"],
  limits: { max_seats: null, max_conversations: null, allowed_models: ["grt-nano-pro"], features: { api_keys: true, custom_instructions: true, org_sso: true } },
});

describe("comparisonRows", () => {
  const rows = comparisonRows([FREE, PRO, TEAM], MODELS, false);
  const row = (key: string) => rows.find((r) => r.key === key)!;

  it("prices each plan for the chosen period, per seat where sold per seat", () => {
    expect(row("price").cells).toEqual(["Free", "$20 / month", "$30 per seat / month"]);
    expect(comparisonRows([FREE, PRO, TEAM], MODELS, true).find((r) => r.key === "price")!.cells).toEqual([
      "Free",
      "$200 / year",
      "$300 per seat / year",
    ]);
  });

  it("reads the allowance, the overage rule, seats, conversations and models from the payload", () => {
    expect(row("allowance").cells).toEqual(["1M tokens", "20M tokens", "30M tokens per seat, pooled"]);
    expect(row("overage").cells[0]).toBe("Stops at the allowance");
    expect(row("overage").cells[1]).toContain("up to $20.00 of overage");
    expect(row("seats").cells).toEqual(["1", "1", "One per member"]);
    expect(row("conversations").cells).toEqual(["25", "Unlimited", "Unlimited"]);
    expect(row("models").cells[1]).toBe("GRT Nano, GRT Nano Pro");
  });

  it("adds a rate-limit row only when some plan states one, and dashes the rest", () => {
    expect(row("tpm_limit").cells).toEqual(["10,000", "100,000", "—"]);
    expect(row("rpm_limit").cells).toEqual(["20", "120", "—"]);
    expect(rows.find((r) => r.key === "max_parallel_requests")).toBeUndefined();
  });

  it("lists the known features by their names, then any the catalog grew, humanised", () => {
    const features = rows.filter((r) => r.key.startsWith("feature:"));
    expect(features.map((r) => r.label)).toEqual(["API keys", "Custom instructions", "Single sign-on", "Beta tools"]);
    expect(row("feature:custom_instructions").cells).toEqual(["—", "Included", "Included"]);
    expect(row("feature:org_sso").cells).toEqual(["—", "—", "Included"]);
    expect(row("feature:beta_tools").cells).toEqual(["—", "Included", "—"]);
  });
});

describe("recommendedPlan", () => {
  it("is the cheapest paid plan sold flat", () => {
    expect(recommendedPlan([FREE, PRO, TEAM])?.code).toBe("pro");
    expect(recommendedPlan([TEAM, PRO, plan({ code: "plus", name: "Plus", price_cents_monthly: 5000 })])?.code).toBe("pro");
  });

  it("is nothing when every plan is free or per seat", () => {
    expect(recommendedPlan([FREE, TEAM])).toBeUndefined();
  });

  it("is the same for an organisation on Free, and nothing for one already paying", () => {
    const plus = plan({ code: "plus", name: "Plus", price_cents_monthly: 5000 });
    expect(recommendedPlan([FREE, PRO, plus, TEAM], "free")?.code).toBe("pro");
    // Never a plan below (or beside) the one the org has.
    expect(recommendedPlan([FREE, PRO, plus, TEAM], "plus")).toBeUndefined();
    expect(recommendedPlan([FREE, PRO, plus, TEAM], "pro")).toBeUndefined();
    expect(recommendedPlan([FREE, PRO, plus, TEAM], "team")).toBeUndefined();
    // A code the catalog does not know is treated as no plan.
    expect(recommendedPlan([FREE, PRO], "legacy")?.code).toBe("pro");
  });
});

describe("annualSaving", () => {
  it("counts whole months, and says nothing for free or an annual price that saves less than one", () => {
    expect(annualSaving(PRO)).toBe("2 months free");
    expect(annualSaving({ price_cents_monthly: 2000, price_cents_annual: 22000 })).toBe("1 month free");
    expect(annualSaving({ price_cents_monthly: 2000, price_cents_annual: 23000 })).toBeNull();
    expect(annualSaving(FREE)).toBeNull();
  });
});
