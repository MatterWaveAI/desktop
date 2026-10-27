import { ApiError, apiFetch } from "./api";

/**
 * The billing and usage API, typed once.
 *
 * Every page that touches money reads through here, so the shapes the API
 * promises are written down in one place and a renamed field breaks the
 * build rather than a pane. Nothing in this file renders: it is data,
 * fetchers, and the small formatting rules that every billing surface
 * shares -- how a token count reads, how a micro-dollar amount reads, how a
 * reset date reads -- so the pane, the banner and the pricing page cannot
 * drift into three dialects.
 *
 * Two units, never mixed up:
 *
 * - **Weighted tokens** are what a plan's allowance counts: a turn's prompt
 *   plus completion tokens times its model's multiplier.
 * - **Micro-dollars** (`*_micros`, 1 USD = 1,000,000) are money: what a turn
 *   costs at list price and what overage has been billed. Plan prices stay
 *   in cents (`price_cents_*`) because Stripe bills them in cents.
 */

/** `GET /api/me/usage` (routes_usage.py). */
export interface UsageSummary {
  unit: "tokens";
  /** Weighted tokens used this period. */
  used: number;
  /** The plan's monthly allowance, in weighted tokens. */
  included: number;
  remaining: number;
  percent: number;
  /** 80% of the allowance to just under it. Never true alongside the other two. */
  warn: boolean;
  /** Past the allowance on a plan with overage, billed at list price, under the cap. */
  in_overage: boolean;
  /** A turn would be refused: the allowance on free, the overage cap on a paid plan. */
  exhausted: boolean;
  period_start: string;
  resets_at: string;
  plan: { code: string; name: string };
  /**
   * How a plan sold per seat makes up `included`: the seats billed, and what
   * each adds to the one pool they share. Null on a plan sold flat.
   */
  seats: { billed: number; included_tokens_per_seat: number } | null;
  overage: {
    enabled: boolean;
    spent_micros: number;
    cap_micros: number;
  };
  models: UsageByModel[];
  /** The period's summaries summed over `models`: a part of `used`. Absent before compaction. */
  compaction?: { weighted_tokens: number; requests: number };
  history: UsageDay[];
}

/** One model's share of the period, as `/api/me/usage` breaks it down. */
export interface UsageByModel {
  model: string;
  label: string;
  multiplier: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Raw tokens: prompt plus completion. */
  tokens: number;
  weighted_tokens: number;
  /** List-price cost of every turn, inside the allowance or not. */
  cost_micros: number;
  /** The part of that cost billed as overage. */
  overage_micros: number;
  requests: number;
  /**
   * The part of `weighted_tokens` and `requests` that bought summaries --
   * the folds that kept a conversation inside its model's window -- rather
   * than answers. Already counted above, never in addition. Absent from an
   * API that predates compaction.
   */
  compaction_weighted_tokens?: number;
  compaction_requests?: number;
}

export interface UsageDay {
  day: string;
  weighted_tokens: number;
  tokens: number;
  cost_micros: number;
  overage_micros: number;
  requests: number;
  /** That day's share spent on summaries, as on a model row. */
  compaction_weighted_tokens?: number;
  compaction_requests?: number;
}

/** `GET /api/billing/status` (routes_billing.py). */
export interface BillingStatus {
  org_id: string;
  plan: string;
  plan_name: string;
  status: string;
  seats: number;
  /**
   * Sold per seat (Team): the price is per seat and `billed_seats` is how
   * many the org pays for -- its members, updated as they join or leave.
   */
  per_seat: boolean;
  /** The seats the price is multiplied by: the member count per seat, otherwise 1. */
  billed_seats: number;
  /** The plan's price; per seat on a plan sold per seat. */
  price_cents_monthly: number;
  price_cents_annual: number;
  /** True when the org has no subscription row: free, by default rather than by choice. */
  implicit: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** When the free trial ends, while the org is `trialing`; null otherwise. */
  trial_end?: string | null;
  /**
   * How the subscription bills. A yearly one has no overage whatever the
   * plan says: Stripe cannot put the monthly overage line on it, so it stops
   * at the allowance (`limits.overage_enabled` is already false for it).
   */
  billing_interval: "month" | "year";
  /** The overage cap an org gets when it has not set its own: the plan's monthly price, times the seats per seat. */
  default_overage_cap_micros: number;
  limits: Record<string, unknown>;
  over_capacity: number;
  writes_blocked: boolean;
  read_only_reason: string | null;
  /** Both halves configured: a key AND a webhook secret. Checkout is refused without. */
  billing_enabled: boolean;
  /** How Stripe collects: a card on file, or invoices on net terms (`days_until_due`). */
  collection_method?: "charge_automatically" | "send_invoice";
  days_until_due?: number | null;
  /** The late-payment schedule when the org is late (dunning.py); null in good standing. */
  dunning?: DunningState | null;
}

/** The stages of the late-payment schedule, in order. */
export type DunningStage = "pending" | "warn" | "warn_final" | "limited" | "suspended";

/**
 * An open late payment as `GET /api/billing/status` reports it: the stage,
 * the dates each next stage begins on, what is owed, and where to pay. The
 * dates are the ones the schedule will act on, so the banner can name them.
 */
export interface DunningState {
  stage: DunningStage;
  /** card: day 0 is the failed payment; invoice: the due date. */
  source: "card" | "invoice";
  first_overdue_at: string;
  days_overdue: number;
  /** Unpaid invoices plus this period's unbilled overage, in micro-dollars. */
  outstanding_micros: number;
  schedule: {
    warn_at: string;
    warn_final_at: string;
    limited_at: string;
    /** Null when the org's policy never moves it to Free. */
    suspended_at: string | null;
    days_limit_at: string;
  };
  next_step: { stage: DunningStage; at: string } | null;
  /** The outstanding-amount limit has stopped overage, whatever the stage. */
  overage_stopped: boolean;
  /** What "limited" switches off for this org. */
  limited: { stops_overage: boolean; blocks_new_keys: boolean; blocks_upgrades: boolean };
  auto_suspend: boolean;
  /** Stripe's hosted page for the invoice, or null to pay through the portal. */
  pay_url: string | null;
}

/** One row of `GET /api/billing/invoices`. Amounts are micro-dollars. */
export interface BillingInvoice {
  id: string;
  number: string | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  collection_method: "charge_automatically" | "send_invoice";
  currency: string;
  amount_due_micros: number;
  amount_remaining_micros: number;
  due_at: string | null;
  paid_at: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  issued_at: string;
}

/** One row of `GET /api/plans`: the public catalog, cheapest first. */
export interface PlanSummary {
  code: string;
  name: string;
  price_cents_monthly: number;
  price_cents_annual: number;
  /** The monthly allowance, in weighted tokens; the flat part, on a plan sold per seat. */
  included_tokens: number;
  /** What each seat adds to one pool the org shares, on a plan sold per seat; null on a flat plan. */
  included_tokens_per_seat: number | null;
  /** Sold per seat: the price, the per-seat allowance and the default overage cap are each per seat. */
  per_seat: boolean;
  /** Past the allowance: billed at list price (true) or refused (false). */
  overage_enabled: boolean;
  /** The plan's monthly price as an overage cap; per seat on a plan sold per seat. */
  default_overage_cap_micros: number;
  /** A new subscriber's free trial, in days; 0 is none. */
  trial_days?: number;
  /** The ids of the priced models this plan includes, in the price list's order. */
  models: string[];
  limits: {
    max_seats: number | null;
    max_conversations: number | null;
    allowed_models: string[] | null;
    features: Record<string, boolean>;
    [key: string]: unknown;
  };
}

/** One row of the price list: what a model costs and how fast it spends an allowance. */
export interface ModelPrice {
  id: string;
  label: string;
  multiplier: number;
  input_usd_per_m: number;
  output_usd_per_m: number;
  /**
   * Another provider's model, sold beside GRT for testing: no plan includes
   * it unless the plan names it. The price list puts GRT first, partners after.
   */
  partner: boolean;
}

/** `GET /api/plans` whole: the plans and the price list they are read against. */
export interface PlanCatalog {
  plans: PlanSummary[];
  models: ModelPrice[];
  default_model: string;
}

export function fetchUsage(): Promise<UsageSummary> {
  return apiFetch<UsageSummary>("/api/me/usage");
}

export function fetchBillingStatus(): Promise<BillingStatus> {
  return apiFetch<BillingStatus>("/api/billing/status");
}

/** The org's invoices, newest first. Owners and admins only. */
export function fetchInvoices(): Promise<BillingInvoice[]> {
  return apiFetch<{ data: BillingInvoice[] }>("/api/billing/invoices").then((body) => body.data);
}

export async function fetchPlans(): Promise<PlanCatalog> {
  const res = await apiFetch<{ data: PlanSummary[]; models: ModelPrice[]; default_model: string }>(
    "/api/plans",
  );
  return { plans: res.data, models: res.models, default_model: res.default_model };
}

/** Begin a subscription; resolves to the Stripe Checkout URL to send the browser to. */
export async function startCheckout(plan: string, annual: boolean): Promise<string> {
  const res = await apiFetch<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    json: { plan, annual },
  });
  return res.url;
}

/** Open the customer portal; resolves to its URL. */
export async function openPortal(): Promise<string> {
  const res = await apiFetch<{ url: string }>("/api/billing/portal", { method: "POST" });
  return res.url;
}

/**
 * What a 402 is asking for (entitlement_gate.UpgradeRequired). The API puts
 * the machine-readable half in headers precisely so no page has to parse
 * the prose, and `apiFetch` keeps the `X-MatterWave-*` headers on the error
 * for this reason. Null for anything that is not an upgrade refusal, so a
 * caller can `upgradeRequired(err) ?? fallback` in one line.
 */
export interface UpgradeInfo {
  message: string;
  feature: string;
  currentPlan: string;
  upgradeTo: string | null;
}

export function upgradeRequired(err: unknown): UpgradeInfo | null {
  if (!(err instanceof ApiError) || err.status !== 402) return null;
  const h = err.headers;
  return {
    message: err.message,
    feature: h["x-matterwave-upgrade-feature"] ?? "this feature",
    currentPlan: h["x-matterwave-plan"] ?? "free",
    upgradeTo: h["x-matterwave-upgrade-to"] ?? null,
  };
}

/** "1,250 tokens" -- grouped, with the unit, so a count is never read as money. */
export function formatTokens(n: number): string {
  return `${n.toLocaleString()} token${n === 1 ? "" : "s"}`;
}

/**
 * "1M", "20M", "200K", "1.5M": a round count with its own suffix. Not
 * Intl's compact notation, which in en-GB writes "1m" -- a lower-case m
 * that reads as a minute or a metre, and on the pricing page did so a
 * dozen times. The suffix is the same in every locale.
 */
export function formatCompactCount(n: number): string {
  const units: readonly [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(n) < size) continue;
    const scaled = Math.round((n / size) * 10) / 10;
    return `${scaled}${suffix}`;
  }
  return `${n}`;
}

/** "20M tokens" -- an allowance, where the round number is the point and six zeros are noise. */
export function formatTokenAllowance(n: number): string {
  return `${formatCompactCount(n)} tokens`;
}

/** "5×" -- how many allowance tokens one token of a model counts as. */
export function formatMultiplier(n: number): string {
  return `${n}×`;
}

/**
 * Every amount in the product is US dollars: the API stores plan prices in
 * USD cents (`price_cents_*`), usage and overage in USD micro-dollars
 * (`*_micros`), and Stripe is configured for USD. The symbol lives here so a
 * second currency is one change, not a grep; `budgetMoney.ts` makes the
 * same assumption with Intl.
 */
export const CURRENCY_SYMBOL = "$";

export const MICROS_PER_USD = 1_000_000;

const wholeDollars = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A dollar amount that never rounds a real cost to nothing.
 *
 * From a dollar up it is ordinary money, two places and grouped: "$20.00",
 * "$1,234.56". Below a dollar it keeps three significant digits, with at
 * least two places: "$0.50", "$0.0125", "$0.000125". A single short turn
 * costs a fraction of a cent, and "$0.00" beside a turn that was billed
 * reads as a bug, or worse as free. Zero is "$0.00".
 */
export function formatUsd(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  const amount = Math.abs(dollars);
  if (amount === 0) return `${CURRENCY_SYMBOL}0.00`;
  const rounded = Number(amount.toPrecision(3));
  if (rounded >= 1) return `${sign}${CURRENCY_SYMBOL}${wholeDollars.format(amount)}`;
  // Places enough to show three significant digits, then the trailing zeros
  // past the second place dropped: 0.500 reads as 0.50, 0.000125 stays.
  const places = Math.max(2, 2 - Math.floor(Math.log10(rounded)));
  const text = rounded.toFixed(places).replace(/(\.\d\d\d*?)0+$/, "$1");
  return `${sign}${CURRENCY_SYMBOL}${text}`;
}

/** Micro-dollars from the API, as `formatUsd` shows dollars. */
export function formatMicros(micros: number): string {
  return formatUsd(micros / MICROS_PER_USD);
}

/** Whole dollars when there are no cents, otherwise two places: "$20", "$0.50". For plan prices, which are cents. */
export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  // Grouped digits: a five-seat annual Team is $1,500, not $1500. Whole
  // dollars stay whole; anything else shows its cents.
  const whole = Number.isInteger(dollars);
  return `${CURRENCY_SYMBOL}${dollars.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** The price list split the way every page shows it: GRT models, then partner models apart. */
export function splitPartners<T extends { partner: boolean }>(models: readonly T[]): { own: T[]; partners: T[] } {
  return { own: models.filter((m) => !m.partner), partners: models.filter((m) => m.partner) };
}

/** The heading partner models go under wherever models are listed: the picker, the price lists, the organisation's switches. */
export const PARTNER_MODELS_HEADING = "Partner models";

/** What every page says about partner models, so the pricing page and the portal agree. */
export const PARTNER_MODELS_NOTE =
  "Other providers' models, offered for testing. Optional: they are available only on a plan that names them, and no plan includes them by default.";

/** A plan's models as their labels, falling back to the id for one the price list does not name. */
export function planModelLabels(plan: PlanSummary, models: readonly ModelPrice[]): string[] {
  return plan.models.map((id) => models.find((m) => m.id === id)?.label ?? id);
}

/** "GRT Nano, GRT Nano Pro and GRT Nano Max": names in a sentence. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The family the models belong to, read off their labels: the words every
 * label starts with ("GRT Nano" from GRT Nano, GRT Nano Pro and GRT Nano
 * Max). Null when the labels share no opening word, or there are none.
 */
export function modelFamily(models: readonly Pick<ModelPrice, "label">[]): string | null {
  if (models.length === 0) return null;
  const words = models.map((m) => m.label.trim().split(/\s+/));
  const prefix: string[] = [];
  for (let i = 0; i < words[0].length; i += 1) {
    const word = words[0][i];
    if (!words.every((w) => w[i] === word)) break;
    prefix.push(word);
  }
  return prefix.length > 0 ? prefix.join(" ") : null;
}

/**
 * A plan's allowance, in one phrase: "20M tokens", or on a plan sold per
 * seat "30M tokens per seat, pooled" -- every seat adds to one allowance
 * the whole organisation draws on.
 */
export function planAllowance(plan: PlanSummary): string {
  if (!plan.per_seat || plan.included_tokens_per_seat === null) return formatTokenAllowance(plan.included_tokens);
  const perSeat = `${formatTokenAllowance(plan.included_tokens_per_seat)} per seat, pooled`;
  return plan.included_tokens > 0 ? `${formatTokenAllowance(plan.included_tokens)} plus ${perSeat}` : perSeat;
}

/**
 * What happens past a plan's allowance, in one phrase. `annual` because a
 * yearly subscription has no overage even on a plan that has it monthly:
 * the overage line is monthly, and a subscription bills on one cadence.
 */
export function overageSummary(plan: PlanSummary, annual = false): string {
  if (!plan.overage_enabled) return "Stops at the allowance";
  if (annual) return "Stops at the allowance (pay-as-you-go beyond it is monthly only)";
  const cap = formatMicros(plan.default_overage_cap_micros);
  return `Then list price, up to ${cap}${plan.per_seat ? " per seat" : ""} of overage a month by default`;
}

/** "3 seats" -- a count of seats, one noun rule for every pane. */
export function formatSeats(n: number): string {
  return `${n} seat${n === 1 ? "" : "s"}`;
}

/** What every page says about how seats are counted on a plan sold per seat. */
export const SEATS_FOLLOW_MEMBERS_NOTE =
  "Seats update automatically as members join or leave; pending invites are not billed.";

/** The pricing page's and billing pane's one sentence on annual plans. */
export const ANNUAL_OVERAGE_NOTE =
  "Annual plans include the same monthly allowance with no overage: requests stop at it until the month resets. Choose monthly billing to keep going past it at list price.";

/**
 * "1 Nov 2026" -- the day the balance resets, in the reader's locale, no time.
 * Read in UTC: periods and resets fall on UTC midnight, which in any zone
 * west of it is still the evening before, so local time would name the day
 * early.
 */
export function formatResetDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** How far ahead of a trial's end the banner starts saying so. */
const TRIAL_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

/** "14-day free trial", or null for a plan without one. */
export function trialOffer(plan: Pick<PlanSummary, "trial_days">): string | null {
  const days = plan.trial_days ?? 0;
  return days > 0 ? `${days}-day free trial` : null;
}

/** "Trial ends 3 Nov 2026" while the org is trialing, else null. */
export function trialEnds(status: Pick<BillingStatus, "status" | "trial_end">): string | null {
  if (status.status !== "trialing" || !status.trial_end) return null;
  return `Trial ends ${formatResetDate(status.trial_end)}`;
}

/** "Billed by invoice, net 30" or "Card" -- how the org pays, in one phrase. */
export function paymentMethodLabel(status: BillingStatus): string {
  if (status.collection_method === "send_invoice") {
    return status.days_until_due ? `Billed by invoice, net ${status.days_until_due}` : "Billed by invoice";
  }
  return "Card";
}

/** What "limited" switches off for this org, as a phrase a sentence can carry. */
function limitedMeans(d: DunningState): string {
  const parts = [
    d.limited.stops_overage && "overage is off",
    d.limited.blocks_new_keys && "new API keys are paused",
    d.limited.blocks_upgrades && "plan changes wait for payment",
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : "the organisation is flagged as limited";
}

/**
 * The banner for one stage of the late-payment schedule, with the dates it
 * acts on. Null before the warn day: late, but nothing to say yet. The first
 * warning is a warning; from the final one on, a danger -- the next step is
 * a change to what works.
 */
export function dunningNotice(d: DunningState): { tone: "warning" | "danger"; text: string } | null {
  const amount = formatMicros(d.outstanding_micros);
  const limitedOn = formatResetDate(d.schedule.limited_at);
  const suspendedOn = d.schedule.suspended_at ? formatResetDate(d.schedule.suspended_at) : null;
  const what = d.source === "card" ? "Your last payment failed" : "Your invoice is overdue";
  const paused = d.overage_stopped ? " Overage is paused until it is paid." : "";
  switch (d.stage) {
    case "warn":
      return {
        tone: "warning",
        text: `${what}: ${amount} outstanding. Pay by ${limitedOn} to keep full access.${paused}`,
      };
    case "warn_final":
      return {
        tone: "danger",
        text: `Final notice: ${amount} overdue. Limited from ${limitedOn}${
          suspendedOn ? `, on the Free plan from ${suspendedOn}` : ""
        }.${paused}`,
      };
    case "limited":
      return {
        tone: "danger",
        text: `Limited until paid: ${limitedMeans(d)}. Pay ${amount} to restore full access${
          suspendedOn ? ` before ${suspendedOn}, when the organisation moves to the Free plan` : ""
        }.`,
      };
    case "suspended":
      return {
        tone: "danger",
        text: `On the Free plan until ${amount} is paid. Nothing has been deleted; paying restores your plan at once.`,
      };
    default:
      return null;
  }
}

/**
 * The subscription states worth a banner, and what each means to the reader.
 * A late payment the schedule is tracking comes first and carries its dates;
 * a bare `past_due` with no schedule behind it keeps the plain sentence.
 */
export function subscriptionNotice(
  status: BillingStatus,
  now: Date = new Date(),
): { tone: "warning" | "danger"; text: string } | null {
  if (status.dunning) {
    const late = dunningNotice(status.dunning);
    if (late) return late;
  }
  if (status.status === "past_due") {
    return {
      tone: "danger",
      text: "Your last payment failed. Update your card to keep your plan.",
    };
  }
  return planNotice(status, now);
}

/**
 * The same notices for a member who cannot pay: the facts and dates, and who
 * can act on them, never an instruction to update a card they cannot reach.
 */
export function memberSubscriptionNotice(
  status: BillingStatus,
  now: Date = new Date(),
): { tone: "warning" | "danger"; text: string } | null {
  const late = status.dunning ? dunningNotice(status.dunning) : null;
  if (late && status.dunning) {
    const d = status.dunning;
    const limitedOn = formatResetDate(d.schedule.limited_at);
    const what = d.source === "card" ? "last payment failed" : "invoice is overdue";
    const texts: Partial<Record<DunningStage, string>> = {
      warn: `This organisation's ${what}. Ask an org admin to pay before ${limitedOn} to keep full access.`,
      warn_final: `Final notice: this organisation's ${what}. It is limited from ${limitedOn} unless an org admin pays.`,
      limited: `This organisation is limited until a late payment is made: ${limitedMeans(d)}. Ask an org admin to pay.`,
      suspended: "This organisation is on the Free plan until a late payment is made. Nothing has been deleted. Ask an org admin to pay.",
    };
    return { tone: late.tone, text: texts[d.stage] ?? late.text };
  }
  if (status.status === "past_due") {
    return {
      tone: "danger",
      text: "This organisation's last payment failed. Ask an org admin to update the card.",
    };
  }
  const plan = planNotice(status, now);
  if (!plan || status.writes_blocked) return plan;
  // The plan winding down or the trial ending: the date, and who decides.
  if (status.cancel_at_period_end && status.current_period_end) {
    return { tone: "warning", text: `This organisation's plan ends on ${formatResetDate(status.current_period_end)}. Ask an org admin to keep it.` };
  }
  return { tone: "warning", text: `This organisation's free trial ends on ${formatResetDate(status.trial_end!)}.` };
}

/** The notices about the plan itself rather than a payment: read-only, ending, a trial ending. */
function planNotice(status: BillingStatus, now: Date): { tone: "warning" | "danger"; text: string } | null {
  if (status.writes_blocked && status.read_only_reason) {
    return { tone: "warning", text: status.read_only_reason };
  }
  if (status.cancel_at_period_end && status.current_period_end) {
    return {
      tone: "warning",
      text: `Your plan ends on ${formatResetDate(status.current_period_end)}.`,
    };
  }
  // A trial about to turn into a bill. Checkout always collects a card for
  // one, so the card on file is what is charged -- unless the org is on
  // invoice terms, when an invoice follows instead.
  if (status.status === "trialing" && status.trial_end) {
    const left = new Date(status.trial_end).getTime() - now.getTime();
    if (left > 0 && left <= TRIAL_WARNING_MS) {
      const on = formatResetDate(status.trial_end);
      return {
        tone: "warning",
        text:
          status.collection_method === "send_invoice"
            ? `Your free trial ends on ${on}. The first invoice for ${status.plan_name} is sent then.`
            : `Your free trial ends on ${on}. The card on file is charged on ${on} for ${status.plan_name}.`,
      };
    }
  }
  return null;
}
