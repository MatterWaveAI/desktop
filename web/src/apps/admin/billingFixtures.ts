import type { BillingInvoice, DunningState } from "../../lib/billing";
import type { DunningPolicy, OrgBilling, OverdueRow } from "./adminApi";

/**
 * The late-payment shapes the admin tests answer with, in the API's own
 * shape (routes_admin.py), so a renamed field breaks the build here rather
 * than a test passing against a shape nobody serves. Test helpers only, like
 * paneHarness.tsx: nothing in the app imports this.
 */

export const PLATFORM_POLICY: DunningPolicy = {
  warn_day: 0,
  warn_final_day: 7,
  limited_day: 14,
  suspended_day: 21,
  auto_suspend: true,
  limited_stops_overage: true,
  limited_blocks_new_keys: true,
  limited_blocks_upgrades: true,
  max_days_overdue: 90,
  max_outstanding_micros: 500_000_000,
  overridden: false,
  note: null,
};

export const LATE: DunningState = {
  stage: "limited",
  source: "invoice",
  first_overdue_at: "2026-09-15T00:00:00+00:00",
  days_overdue: 16,
  outstanding_micros: 120_000_000,
  schedule: {
    warn_at: "2026-09-15T00:00:00+00:00",
    warn_final_at: "2026-09-22T00:00:00+00:00",
    limited_at: "2026-09-29T00:00:00+00:00",
    suspended_at: "2026-10-06T00:00:00+00:00",
    days_limit_at: "2026-12-14T00:00:00+00:00",
  },
  next_step: { stage: "suspended", at: "2026-10-06T00:00:00+00:00" },
  overage_stopped: false,
  limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
  auto_suspend: true,
  pay_url: "https://invoice.stripe.test/i/in_1",
};

export const OPEN_INVOICE: BillingInvoice = {
  id: "in_1",
  number: "ACME-0007",
  status: "open",
  collection_method: "send_invoice",
  currency: "usd",
  amount_due_micros: 120_000_000,
  amount_remaining_micros: 120_000_000,
  due_at: "2026-09-15T00:00:00+00:00",
  paid_at: null,
  hosted_invoice_url: "https://invoice.stripe.test/i/in_1",
  invoice_pdf: "https://invoice.stripe.test/i/in_1/pdf",
  issued_at: "2026-08-16T00:00:00+00:00",
};

export function orgBilling(orgId: string, over: Partial<OrgBilling> = {}): OrgBilling {
  return {
    org_id: orgId,
    policy: PLATFORM_POLICY,
    platform_policy: PLATFORM_POLICY,
    override: {},
    limits: { max_days_overdue_ceiling: 180, max_outstanding_ceiling_micros: 5_000_000_000 },
    dunning: null,
    grace_days: 0,
    collection_method: "charge_automatically",
    days_until_due: null,
    invoicing: null,
    invoices: [],
    ...over,
  };
}

export function overdueRow(orgId: string, orgName: string, over: Partial<OverdueRow> = {}): OverdueRow {
  return {
    org_id: orgId,
    org_name: orgName,
    plan: "pro",
    stage: "limited",
    source: "invoice",
    collection_method: "send_invoice",
    days_until_due: 30,
    first_overdue_at: LATE.first_overdue_at,
    days_overdue: 16,
    outstanding_micros: 120_000_000,
    grace_days: 0,
    next_step: LATE.next_step,
    policy: { ...PLATFORM_POLICY, auto_suspend: false, overridden: true, note: "Reseller" },
    overridden: true,
    note: "Reseller",
    overage_stopped: false,
    days_limit_hit_at: null,
    amount_limit_hit_at: "2026-09-30T00:00:00+00:00",
    invoice_id: "in_1",
    ...over,
  };
}
