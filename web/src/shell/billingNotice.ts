import {
  formatMicros,
  formatResetDate,
  formatTokens,
  memberSubscriptionNotice,
  subscriptionNotice,
  type BillingStatus,
  type UsageSummary,
} from "../lib/billing";

/**
 * Which one line the shell shows about money or tokens, if any. Its own
 * module rather than a second export of BillingBanner.tsx
 * so that file exports only a component and keeps fast refresh.
 *
 * Priority, highest first, one at a time: a payment problem -- a stage of
 * the late-payment schedule with its dates, or a bare past-due -- then the
 * hard stop, then overage, then the 80% warning. The API decides the usage state
 * (routes_usage.py keeps warn / in_overage / exhausted disjoint); this only
 * orders them, so the Usage pane and the banner can never disagree.
 *
 * A member who does not manage the org gets the payment notices worded for
 * them: what is happening and that an org admin can fix it, since the card
 * and the invoices are out of their reach.
 */
export type Notice = {
  /** A subscription notice is the one the Billing pane also shows; usage is the Usage pane's. */
  kind: "subscription" | "usage";
  tone: "warning" | "danger";
  text: string;
  link: { to: "/settings/$paneId"; paneId: "billing" | "usage" | "budget"; label: string };
};

export function noticeFor(
  status: BillingStatus | null,
  usage: UsageSummary | null,
  options: { managesOrg?: boolean } = {},
): Notice | null {
  const manages = options.managesOrg ?? true;
  const sub = status ? (manages ? subscriptionNotice(status) : memberSubscriptionNotice(status)) : null;
  if (sub) return { ...sub, kind: "subscription", link: { to: "/settings/$paneId", paneId: "billing", label: "Billing" } };
  if (!usage) return null;
  const toUsage = { to: "/settings/$paneId", paneId: "usage", label: "Usage" } as const;
  if (usage.exhausted) {
    return {
      kind: "usage",
      tone: "danger",
      // Free stops at its allowance; a paid plan at its overage cap. The
      // wording matches the in-app notification for the same state.
      text: usage.overage.enabled
        ? `Overage cap reached: requests are refused until ${formatResetDate(usage.resets_at)}.`
        : `Out of tokens: requests are refused until ${formatResetDate(usage.resets_at)}.`,
      link: toUsage,
    };
  }
  if (usage.in_overage) {
    return {
      kind: "usage",
      tone: "warning",
      text: `Past your included tokens: ${formatMicros(usage.overage.spent_micros)} of overage billed at list price, of a ${formatMicros(usage.overage.cap_micros)} cap.`,
      link: toUsage,
    };
  }
  if (usage.warn) {
    return {
      kind: "usage",
      tone: "warning",
      text: `${Math.round(usage.percent)}% of this period's included tokens used. ${formatTokens(usage.remaining)} left until ${formatResetDate(usage.resets_at)}.`,
      link: toUsage,
    };
  }
  return null;
}
