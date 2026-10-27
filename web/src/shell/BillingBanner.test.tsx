import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingStatus, DunningState, UsageSummary } from "../lib/billing";
import { BillingBanner } from "./BillingBanner";
import { noticeFor } from "./billingNotice";
import { cleanup, jsonResponse, mount, stubApi, view } from "./frontDoorHarness";

/**
 * The banner's one job is choosing WHICH message, never two. The API
 * already makes the usage states disjoint; this proves the
 * banner's ordering on top of them: money before tokens, the hard stop
 * before overage, overage before the warning, and silence when nothing
 * needs saying.
 */

const usage = (over: Partial<UsageSummary> = {}): UsageSummary => ({
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
  models: [],
  history: [],
  ...over,
});

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
  current_period_end: null,
  cancel_at_period_end: false,
  billing_interval: "month",
  default_overage_cap_micros: 20_000_000,
  limits: {},
  over_capacity: 0,
  writes_blocked: false,
  read_only_reason: null,
  billing_enabled: true,
  ...over,
});

describe("noticeFor", () => {
  it("is silent when nothing needs attention -- which is nearly always", () => {
    expect(noticeFor(status(), usage())).toBeNull();
    expect(noticeFor(null, null)).toBeNull();
    expect(noticeFor(status(), null)).toBeNull();
  });

  it("warns at 80% with the remainder and the reset date, and links to Usage", () => {
    const n = noticeFor(status(), usage({ used: 16_000_000, remaining: 4_000_000, percent: 80, warn: true }));
    expect(n?.tone).toBe("warning");
    expect(n?.text).toMatch(/80% of this period's included tokens used/);
    expect(n?.text).toMatch(/4,000,000 tokens left/);
    expect(n?.link.paneId).toBe("usage");
  });

  it("reports overage as billing, not as running out", () => {
    const n = noticeFor(
      status(),
      usage({
        used: 21_000_000,
        remaining: 0,
        percent: 105,
        in_overage: true,
        overage: { enabled: true, spent_micros: 1_250, cap_micros: 20_000_000 },
      }),
    );
    expect(n?.tone).toBe("warning");
    // A sub-cent overage is still shown as the money it is.
    expect(n?.text).toMatch(/\$0\.00125 of overage/);
    expect(n?.text).toMatch(/\$20\.00 cap/);
    expect(n?.text).not.toMatch(/left/);
  });

  it("makes the hard stop a danger that names the reset", () => {
    const free = noticeFor(
      status({ plan: "free" }),
      usage({ used: 1_000_000, included: 1_000_000, percent: 100, exhausted: true, overage: { enabled: false, spent_micros: 0, cap_micros: 0 } }),
    );
    expect(free?.tone).toBe("danger");
    expect(free?.text).toMatch(/Out of tokens: requests are refused until/);

    const paid = noticeFor(
      status(),
      usage({ used: 30_000_000, percent: 150, exhausted: true, overage: { enabled: true, spent_micros: 20_000_000, cap_micros: 20_000_000 } }),
    );
    expect(paid?.tone).toBe("danger");
    expect(paid?.text).toMatch(/Overage cap reached: requests are refused until/);
  });

  it("puts a payment problem above any usage state", () => {
    const n = noticeFor(
      status({ status: "past_due" }),
      usage({ used: 30_000_000, percent: 150, exhausted: true }),
    );
    expect(n?.tone).toBe("danger");
    expect(n?.text).toMatch(/payment failed/i);
    expect(n?.link.paneId).toBe("billing");
  });

  it("names the late-payment stage with its dates, above any usage state", () => {
    const late = (over: Partial<DunningState> = {}): DunningState => ({
      stage: "warn",
      source: "card",
      first_overdue_at: "2026-10-01T09:00:00+00:00",
      days_overdue: 0,
      outstanding_micros: 20_000_000,
      schedule: {
        warn_at: "2026-10-01T09:00:00+00:00",
        warn_final_at: "2026-10-08T09:00:00+00:00",
        limited_at: "2026-10-15T09:00:00+00:00",
        suspended_at: "2026-10-22T09:00:00+00:00",
        days_limit_at: "2026-12-30T09:00:00+00:00",
      },
      next_step: { stage: "warn_final", at: "2026-10-08T09:00:00+00:00" },
      overage_stopped: false,
      limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
      auto_suspend: true,
      pay_url: "https://invoice.stripe.test/i/in_1",
      ...over,
    });
    const limitedOn = new Date("2026-10-15T09:00:00+00:00").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const exhausted = usage({ used: 30_000_000, percent: 150, exhausted: true });

    const warn = noticeFor(status({ status: "past_due", dunning: late() }), exhausted);
    expect(warn?.tone).toBe("warning");
    expect(warn?.text).toContain("Your last payment failed: $20.00 outstanding");
    expect(warn?.text).toContain(limitedOn);
    expect(warn?.link.paneId).toBe("billing");

    const final = noticeFor(status({ dunning: late({ stage: "warn_final", source: "invoice" }) }), null);
    expect(final?.tone).toBe("danger");
    expect(final?.text).toMatch(/^Final notice: \$20\.00 overdue\. Limited from .+, on the Free plan from /);

    const limited = noticeFor(
      status({ dunning: late({ stage: "limited", limited: { stops_overage: true, blocks_new_keys: false, blocks_upgrades: true } }) }),
      null,
    );
    expect(limited?.text).toContain("Limited until paid: overage is off, plan changes wait for payment.");
    expect(limited?.text).not.toContain("API keys");

    // A partner never moved to Free is not told it will be.
    const partner = noticeFor(
      status({ dunning: late({ stage: "limited", auto_suspend: false, schedule: { ...late().schedule, suspended_at: null } }) }),
      null,
    );
    expect(partner?.text).not.toMatch(/Free plan/);

    const suspended = noticeFor(status({ plan: "free", dunning: late({ stage: "suspended" }) }), null);
    expect(suspended?.text).toMatch(/^On the Free plan until \$20\.00 is paid\. Nothing has been deleted/);

    // Late but before the warn day: nothing to say yet, and nothing else outranks usage.
    const pending = noticeFor(status({ dunning: late({ stage: "pending" }) }), exhausted);
    expect(pending?.link.paneId).toBe("usage");
  });

  it("says when the amount limit has paused overage before the org is limited", () => {
    const n = noticeFor(
      status({
        dunning: {
          stage: "warn",
          source: "invoice",
          first_overdue_at: "2026-10-01T00:00:00+00:00",
          days_overdue: 2,
          outstanding_micros: 600_000_000,
          schedule: {
            warn_at: "2026-10-01T00:00:00+00:00",
            warn_final_at: "2026-10-08T00:00:00+00:00",
            limited_at: "2026-10-15T00:00:00+00:00",
            suspended_at: null,
            days_limit_at: "2026-12-30T00:00:00+00:00",
          },
          next_step: null,
          overage_stopped: true,
          limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
          auto_suspend: false,
          pay_url: null,
        },
      }),
      null,
    );
    expect(n?.text).toContain("Your invoice is overdue: $600.00 outstanding");
    expect(n?.text).toContain("Overage is paused until it is paid.");
  });

  it("tells a member who can fix a payment problem instead of telling them to pay", () => {
    const failed = noticeFor(status({ status: "past_due" }), null, { managesOrg: false });
    expect(failed?.text).toMatch(/Ask an org admin/);
    expect(failed?.text).not.toMatch(/Update your card/);

    const late = noticeFor(
      status({
        dunning: {
          stage: "warn",
          source: "card",
          first_overdue_at: "2026-10-01T00:00:00+00:00",
          days_overdue: 2,
          outstanding_micros: 20_000_000,
          schedule: {
            warn_at: "2026-10-01T00:00:00+00:00",
            warn_final_at: "2026-10-08T00:00:00+00:00",
            limited_at: "2026-10-15T00:00:00+00:00",
            suspended_at: null,
            days_limit_at: "2026-12-30T00:00:00+00:00",
          },
          next_step: null,
          overage_stopped: false,
          limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
          auto_suspend: false,
          pay_url: null,
        },
      }),
      null,
      { managesOrg: false },
    );
    expect(late?.text).toMatch(/Ask an org admin/);
    expect(late?.text).not.toMatch(/Pay by|Pay \$/);
    expect(late?.kind).toBe("subscription");

    // Usage is the reader's own business either way.
    const warn = noticeFor(status(), usage({ percent: 85, warn: true }), { managesOrg: false });
    expect(warn?.kind).toBe("usage");
  });
});

describe("BillingBanner", () => {
  function Page() {
    return (
      <>
        <h1>Page</h1>
        <BillingBanner />
      </>
    );
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("stays off the Billing pane, which shows the same payment notice itself", async () => {
    stubApi({ "/api/billing/status": jsonResponse(status({ status: "past_due" })) });
    await mount("/settings/billing", { "/settings/$paneId": Page });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view().querySelector("[data-billing-banner]")).toBeNull();
  });

  it("shows it everywhere else", async () => {
    stubApi({ "/api/billing/status": jsonResponse(status({ status: "past_due" })) });
    await mount("/settings/usage", { "/settings/$paneId": Page });
    await vi.waitFor(() => {
      expect(view().querySelector("[data-billing-banner]")).not.toBeNull();
    });
  });
});
