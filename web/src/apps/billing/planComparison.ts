import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import { formatNumber } from "../../i18n/format";
import {
  formatPrice,
  overageSummary,
  planAllowance,
  planModelLabels,
  type ModelPrice,
  type PlanSummary,
} from "../../lib/billing";

/**
 * The plan ladder read sideways: one row per thing the plans differ on,
 * one cell per plan, built from `GET /api/plans` and nothing else. The
 * limits a plan carries (`limits`) are the catalog's rows, so a limit added
 * in SQL -- a new feature switch, a new rate -- shows up here as a row with
 * no deploy: the known keys get a label, the rest are humanised.
 */

export interface ComparisonRow {
  key: string;
  label: string;
  /** One cell per plan, in the catalog's order. */
  cells: string[];
}

/** What the admin editors call each feature switch (plans.py FEATURES). */
const FEATURE_LABELS: Record<string, MessageDescriptor> = {
  api_keys: msg`API keys`,
  custom_instructions: msg`Custom instructions`,
  org_sso: msg`Single sign-on`,
};

/** The numeric limits worth a row, with how each reads. */
const LIMIT_ROWS: readonly { key: string; label: MessageDescriptor; format: (n: number) => string }[] = [
  { key: "tpm_limit", label: msg`Tokens per minute`, format: (n) => formatNumber(n) },
  { key: "rpm_limit", label: msg`Requests per minute`, format: (n) => formatNumber(n) },
  { key: "max_parallel_requests", label: msg`Parallel requests`, format: (n) => formatNumber(n) },
];

const FEATURE_ORDER = Object.keys(FEATURE_LABELS);

/** "org_sso" -> "Org sso": a switch the catalog grew after this page was written. */
function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function seats(plan: PlanSummary): string {
  if (plan.per_seat) return t`One per member`;
  const n = plan.limits.max_seats;
  return n == null ? t`Unlimited` : formatNumber(n);
}

function conversations(plan: PlanSummary): string {
  const n = plan.limits.max_conversations;
  return n == null ? t`Unlimited` : formatNumber(n);
}

function price(plan: PlanSummary, annual: boolean): string {
  if (plan.price_cents_monthly === 0) return t`Free`;
  const amount = formatPrice(annual ? plan.price_cents_annual : plan.price_cents_monthly);
  if (plan.per_seat) return annual ? t`${amount} per seat / year` : t`${amount} per seat / month`;
  return annual ? t`${amount} / year` : t`${amount} / month`;
}

export function comparisonRows(
  plans: readonly PlanSummary[],
  models: readonly ModelPrice[],
  annual: boolean,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [
    { key: "price", label: t`Price`, cells: plans.map((plan) => price(plan, annual)) },
    { key: "allowance", label: t`Monthly allowance`, cells: plans.map(planAllowance) },
    { key: "overage", label: t`Past the allowance`, cells: plans.map((plan) => overageSummary(plan, annual)) },
    { key: "seats", label: t`Seats`, cells: plans.map(seats) },
    { key: "conversations", label: t`Conversations`, cells: plans.map(conversations) },
    { key: "models", label: t`Models`, cells: plans.map((plan) => planModelLabels(plan, models).join(", ")) },
  ];
  for (const limit of LIMIT_ROWS) {
    const values = plans.map((plan) => plan.limits[limit.key]);
    if (!values.some((v) => typeof v === "number")) continue;
    rows.push({
      key: limit.key,
      label: i18n._(limit.label),
      cells: values.map((v) => (typeof v === "number" ? limit.format(v) : "—")),
    });
  }
  // Every switch any plan names, the known ones first in their usual order.
  const featureKeys = [
    ...FEATURE_ORDER,
    ...plans.flatMap((plan) => Object.keys(plan.limits.features ?? {})),
  ].filter((key, index, all) => all.indexOf(key) === index && plans.some((p) => key in (p.limits.features ?? {})));
  for (const key of featureKeys) {
    rows.push({
      key: `feature:${key}`,
      label: key in FEATURE_LABELS ? i18n._(FEATURE_LABELS[key]) : humanise(key),
      cells: plans.map((plan) => (plan.limits.features?.[key] ? t`Included` : "—")),
    });
  }
  return rows;
}

/** Why the recommended card is recommended: one line under its badge. */
export const RECOMMENDED_REASON = msg`Most teams start here`;

/**
 * Which card wears "Recommended": for a stranger, or an organisation on
 * Free, the cheapest paid plan sold flat -- the one most people subscribing
 * on their own start with (`RECOMMENDED_REASON`). An organisation already
 * paying gets no recommendation at all: a badge on a plan below or beside
 * the one it has would read as "you chose wrong", and its own card already
 * says "Your plan". A rule, not a flag, because the catalog carries none;
 * an owner who wants a different answer changes this function.
 *
 * `currentCode` is the org's plan, or null for no org (signed out) and for
 * an org on Free by default.
 */
export function recommendedPlan(
  plans: readonly PlanSummary[],
  currentCode: string | null = null,
): PlanSummary | undefined {
  const current = currentCode === null ? undefined : plans.find((plan) => plan.code === currentCode);
  if (current && current.price_cents_monthly > 0) return undefined;
  return plans
    .filter((plan) => plan.price_cents_monthly > 0 && !plan.per_seat)
    .sort((a, b) => a.price_cents_monthly - b.price_cents_monthly)[0];
}

/**
 * Whole months an annual price saves over twelve monthly ones: "2 months
 * free", or null when it saves less than a month (or the plan is free).
 */
export function annualSaving(plan: Pick<PlanSummary, "price_cents_monthly" | "price_cents_annual">): string | null {
  const monthly = plan.price_cents_monthly;
  if (monthly <= 0 || plan.price_cents_annual <= 0) return null;
  const months = Math.floor((12 * monthly - plan.price_cents_annual) / monthly + 1e-9);
  return months >= 1 ? plural(months, { one: "# month free", other: "# months free" }) : null;
}
