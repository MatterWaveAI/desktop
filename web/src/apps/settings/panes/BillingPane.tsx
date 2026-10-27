import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Alert } from "../../../components/ui/alert";
import { StatusDot } from "../../../components/ui/badge";
import { Button, buttonVariants } from "../../../components/ui/button";
import { apiFetch } from "../../../lib/api";
import { ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { failureMessage } from "../../../shell/authForms";
import { managesOrg } from "../../../lib/auth";
import {
  ANNUAL_OVERAGE_NOTE,
  SEATS_FOLLOW_MEMBERS_NOTE,
  fetchBillingStatus,
  fetchInvoices,
  fetchPlans,
  formatMicros,
  formatPrice,
  formatResetDate,
  formatSeats,
  formatTokenAllowance,
  formatTokens,
  listOf,
  openPortal,
  paymentMethodLabel,
  planModelLabels,
  subscriptionNotice,
  trialEnds,
  type BillingInvoice,
  type BillingStatus,
  type PlanCatalog,
} from "../../../lib/billing";
import { PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { Row, RowList } from "../rows";

const LINK_CLASS = "text-sm text-mw-link underline underline-offset-2 hover:text-mw-link-hover";
const DT_CLASS = "text-mw-text-subtle";
const NOTE_CLASS = "mt-1 text-xs text-mw-text-subtle";

/**
 * Billing: the plan the org is on, and the two ways to change it.
 *
 * Deliberately thin. Card, invoices, cancellation and plan changes live in
 * Stripe's customer portal, not here: the portal carries SCA, receipts and
 * the self-serve cancellation that is the single biggest dispute preventer,
 * and rebuilding any of it would be a worse copy. This pane answers "what
 * am I on, when does it renew, is anything wrong" and hands off.
 *
 * Admin-only actions, visible-to-all state: a member must be able to see
 * that the plan is past due even though only an admin can fix it, otherwise
 * the first they hear of it is a refused request. "Admin" is the org's
 * membership role (`org_role`), the same row the API gates the portal on.
 *
 * On a plan sold per seat the seats are the bill, so the pane shows the sum
 * -- seats times the per-seat price -- and that the seats follow the
 * members. Nobody sets the count here: inviting and removing people does.
 *
 * When a payment is late the notice at the top carries the schedule's dates
 * and a way to pay: Stripe's hosted page for the invoice, which takes a card
 * or a bank transfer. Admins also see the invoice history, each with its PDF
 * and hosted page -- the receipts live in Stripe, this is the list of them.
 */

/**
 * The subscription's state in words, from the fields the API returns: when
 * it renews or ends, or what is wrong. A free org never gets here -- it has
 * no subscription to describe, and reads `FreePlan` instead.
 */
function subscriptionState(status: BillingStatus): string {
  const end = status.current_period_end ? formatResetDate(status.current_period_end) : null;
  switch (status.status) {
    // The trial row carries the date and what happens at the end of it.
    case "trialing":
      return "Free trial";
    case "past_due":
    case "unpaid":
      return "Past due";
    case "canceled":
      return "Cancelled";
    case "incomplete":
    case "incomplete_expired":
      return "Payment incomplete";
    case "paused":
      return "Paused";
  }
  if (status.cancel_at_period_end) return end ? `Cancels on ${end}` : "Cancels at the end of the period";
  if (status.status === "active") return end ? `Active, renews ${end}` : "Active";
  const words = status.status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function BillingPane() {
  const { principal } = useShell();
  const isAdmin = managesOrg(principal);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portal, setPortal] = useState<"idle" | "opening" | string>("idle");
  const [version, setVersion] = useState(0);
  // The error is cleared by the retry, not by the effect: a setState at the
  // top of an effect is the lint's "set-state-in-effect" and an extra render
  // for nothing on the first mount, when there is no error to clear.
  const reload = useCallback(() => {
    setError(null);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchBillingStatus()
      .then((s) => alive && setStatus(s))
      .catch((err) => alive && setError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, [version]);

  async function manage() {
    setPortal("opening");
    try {
      window.location.assign(await openPortal());
    } catch (err) {
      setPortal(failureMessage(err));
    }
  }

  if (error) {
    return <ErrorState title="Could not load billing" message={error} onRetry={reload} />;
  }
  if (!status) return <LoadingSkeleton />;

  const notice = subscriptionNotice(status);
  if (status.implicit) {
    return (
      <div className="flex flex-col gap-7">
        <FreePlan status={status} isAdmin={isAdmin} />
        {isAdmin && <PlanHistory />}
      </div>
    );
  }
  const included = Number(status.limits.included_tokens ?? 0);
  const overage = status.limits.overage_enabled === true;
  // A yearly subscription to a plan with overage still stops at the
  // allowance; say why, and what gets pay-as-you-go back.
  const annual = !status.implicit && status.billing_interval === "year";
  const seatPrice = annual ? status.price_cents_annual : status.price_cents_monthly;
  const perSeatTokens = Number(status.limits.included_tokens_per_seat ?? 0);

  // The portal is the pane's one primary action, so it sits beside the
  // title; only an admin of an org Stripe knows can open it.
  const canManage = isAdmin && status.billing_enabled;

  return (
    <div className="flex flex-col gap-7">
      {canManage && (
        <PaneActions>
          <Button size="lg" onClick={() => void manage()} disabled={portal === "opening"}>
            {portal === "opening" ? "Opening…" : "Manage billing"}
          </Button>
        </PaneActions>
      )}
      {/* A late payment is the danger notice; a plan ending or a trial
          running out is a warning. Either way it is restated here, where
          the fix is, with the one way to pay when there is an invoice. */}
      {notice && (
        <Alert
          variant={notice.tone === "danger" ? "danger" : "warning"}
          role="alert"
          data-billing-notice={notice.tone}
          action={
            status.dunning?.pay_url ? (
              <a
                href={status.dunning.pay_url}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: "lg" })}
              >
                Pay the invoice
              </a>
            ) : undefined
          }
        >
          <p>{notice.text}</p>
        </Alert>
      )}

      <PaneSection title="Plan" description="What this organisation is subscribed to.">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className={DT_CLASS}>Plan</dt>
            <dd className="font-medium">{status.plan_name}</dd>
          </div>
          <div>
            <dt className={DT_CLASS}>Status</dt>
            <dd className="font-medium" data-billing-state>
              {subscriptionState(status)}
            </dd>
          </div>
          <div>
            <dt className={DT_CLASS}>Included tokens</dt>
            <dd className="font-medium">{formatTokens(included)} / month</dd>
            {status.per_seat && (
              <dd className={NOTE_CLASS}>
                {formatSeats(status.billed_seats)} × {formatTokenAllowance(perSeatTokens)}, one pool for everyone
              </dd>
            )}
          </div>
          <div>
            <dt className={DT_CLASS}>Past the allowance</dt>
            <dd className="font-medium">
              {overage
                ? `List price, up to ${formatMicros(status.default_overage_cap_micros)} by default`
                : "Requests stop"}
            </dd>
            {annual && <dd className={NOTE_CLASS}>{ANNUAL_OVERAGE_NOTE}</dd>}
          </div>
          <div>
            <dt className={DT_CLASS}>Payment</dt>
            <dd className="font-medium" data-billing-payment-method>
              {status.implicit ? "—" : paymentMethodLabel(status)}
            </dd>
          </div>
          {trialEnds(status) && (
            <div data-billing-trial className="sm:col-span-2">
              <dt className={DT_CLASS}>Free trial</dt>
              <dd className="font-medium">{trialEnds(status)}</dd>
              <dd className={NOTE_CLASS}>
                The card on file is charged when the trial ends, unless the plan is cancelled first.
              </dd>
            </div>
          )}
          {status.per_seat ? (
            <div data-billing-seats className="sm:col-span-2">
              <dt className={DT_CLASS}>Seats</dt>
              <dd className="font-medium">
                {formatSeats(status.billed_seats)} × {formatPrice(seatPrice)} ={" "}
                {formatPrice(status.billed_seats * seatPrice)} / {annual ? "year" : "month"}
              </dd>
              <dd className={NOTE_CLASS}>{SEATS_FOLLOW_MEMBERS_NOTE}</dd>
            </div>
          ) : (
            status.seats > 1 && (
              <div>
                <dt className={DT_CLASS}>Seats</dt>
                <dd className="font-medium">{status.seats}</dd>
              </div>
            )
          )}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <Link to="/pricing" className={LINK_CLASS}>
            Change plan
          </Link>
          <UsageLink />
        </div>
        {!isAdmin && (
          <p className="mt-2 text-xs text-mw-text-subtle">
            Only an organisation admin can change the card or the plan.
          </p>
        )}
        {portal !== "idle" && portal !== "opening" && (
          <p role="alert" className="mt-2 text-sm text-mw-danger">
            {portal}
          </p>
        )}
      </PaneSection>

      {isAdmin && <InvoiceHistory />}
      {isAdmin && <PlanHistory />}
    </div>
  );
}

function UsageLink() {
  return (
    <Link
      to="/settings/$paneId"
      params={{ paneId: "usage" }}
      className={LINK_CLASS}
    >
      See usage
    </Link>
  );
}

/**
 * The plan row for an org with no subscription: it is on Free, so say so
 * and what Free includes, rather than a "No subscription" status and a
 * payment method of "--" that read as something missing. The numbers are
 * the entitlement's own limits, so this and the pricing page agree; the
 * models are named from the catalog (`GET /api/plans`), the way the
 * pricing page names them, with a count until it is in.
 */
function FreePlan(props: { status: BillingStatus; isAdmin: boolean }) {
  const { status } = props;
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    fetchPlans()
      .then((c) => alive && setCatalog(c))
      .catch(() => {
        // The count below still reads; the names are a nicety.
      });
    return () => {
      alive = false;
    };
  }, []);
  const included = Number(status.limits.included_tokens ?? 0);
  const maxSeats = status.limits.max_seats;
  const seats =
    typeof maxSeats === "number" ? formatSeats(maxSeats) : maxSeats === null ? "Unlimited seats" : null;
  const plan = catalog?.plans.find((p) => p.code === status.plan);
  const labels = plan && catalog ? planModelLabels(plan, catalog.models) : [];
  // The allow-list is the models beyond the one every plan has.
  const extra = Array.isArray(status.limits.allowed_models) ? status.limits.allowed_models.length : 0;
  const modelsLine = labels.length > 0 ? listOf(labels) : `${extra + 1} model${extra === 0 ? "" : "s"}`;
  return (
    <PaneSection title="Plan" description="What this organisation is on, and what it includes.">
      {/* Choosing a plan is the pane's one primary action on Free. */}
      <PaneActions>
        <Link to="/pricing" className={buttonVariants({ size: "lg" })}>
          Upgrade
        </Link>
      </PaneActions>
      <p className="text-lg font-semibold" data-billing-state>
        You're on {status.plan_name}
      </p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-mw-text-subtle" aria-label="What Free includes">
        <li>{formatTokens(included)} a month, counted by each model's weight</li>
        {seats && <li>{seats}</li>}
        <li data-billing-models>{modelsLine}</li>
        <li>Requests stop when the included tokens run out; nothing is billed</li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
        <UsageLink />
      </div>
      {!props.isAdmin && (
        <p className="mt-2 text-xs text-mw-text-subtle">
          Only an organisation admin can choose a plan. Ask an admin to subscribe.
        </p>
      )}
    </PaneSection>
  );
}

/** One row of `GET /api/plan/history`: the append-only trail of plan and status changes. */
export interface PlanEvent {
  from_plan: string;
  to_plan: string;
  from_status: string | null;
  to_status: string;
  kind: "upgrade" | "downgrade" | "cancel" | "lateral" | "status_change" | string;
  actor: string;
  reason: string | null;
  created_at: string;
}

const EVENT_KIND: Record<string, string> = {
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  cancel: "Cancelled",
  lateral: "Plan change",
  status_change: "Status change",
};

/** "Free → Pro", or the status that changed when the plan did not. */
export function planEventLabel(event: PlanEvent): string {
  const name = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);
  if (event.from_plan !== event.to_plan) return `${name(event.from_plan)} → ${name(event.to_plan)}`;
  const status = event.to_status.replace(/_/g, " ");
  return `${name(event.to_plan)}, now ${status}`;
}

/**
 * A reason as a person reads it. Stripe writes its object ids into some
 * ("Checkout cs_test_..."): the id is kept for the title attribute, where
 * someone matching the row against the Stripe dashboard can find it, and
 * the text is what is left -- "Checkout" beside the row's date.
 */
export function planEventReason(reason: string): { text: string; title?: string } {
  const stripeId = /\b(?:cs|sub|evt|in|pi|cus|price|prod|seti|si|il|ch|inv|req)_(?:test_|live_)?[A-Za-z0-9]+\b/g;
  if (!stripeId.test(reason)) return { text: reason };
  const text = reason.replace(stripeId, "").replace(/\s+/g, " ").trim();
  return { text: text || "Stripe reference", title: reason };
}

/** Who made the change, as a person reads it: Stripe, an operator, or a member. */
export function planEventActor(actor: string): string {
  if (actor.startsWith("stripe:")) return "Stripe";
  if (actor.startsWith("operator:")) return "An operator";
  if (actor.startsWith("system:") || actor === "system") return "Automatic";
  return actor;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Every plan and status change the org has been through, newest first:
 * the billing trail the API keeps for owners and admins. A failure to load
 * is said in place, like the invoices: the plan above is still true.
 */
function PlanHistory() {
  const [events, setEvents] = useState<PlanEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<{ data: PlanEvent[] }>("/api/plan/history")
      .then((body) => alive && setEvents(body.data))
      .catch((err) => alive && setError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PaneSection
      title="Plan history"
      description="Every change of plan or subscription status, newest first."
      flush={events !== null && events.length > 0 && !error}
    >
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : events === null ? (
        <LoadingSkeleton rows={2} />
      ) : events.length === 0 ? (
        <p className="text-sm text-mw-text-subtle">No changes yet.</p>
      ) : (
        <RowList aria-label="Plan history">
          {events.map((event, index) => (
            <Row
              key={`${event.created_at}-${index}`}
              title={planEventLabel(event)}
              meta={
                <>
                  {EVENT_KIND[event.kind] ?? event.kind} · {planEventActor(event.actor)}
                  {event.reason && (
                    <span className="block" title={planEventReason(event.reason).title}>
                      {planEventReason(event.reason).text}
                    </span>
                  )}
                </>
              }
              trailing={
                <time dateTime={event.created_at} className="text-sm whitespace-nowrap text-mw-text-subtle">
                  {formatEventTime(event.created_at)}
                </time>
              }
            />
          ))}
        </RowList>
      )}
    </PaneSection>
  );
}

const INVOICE_STATUS: Record<BillingInvoice["status"], string> = {
  draft: "Draft",
  open: "Unpaid",
  paid: "Paid",
  uncollectible: "Unpaid",
  void: "Void",
};

/** Paid in emerald, owed in amber, anything else neutral: the dot carries the tone, the word the meaning. */
function InvoiceStatus(props: { status: BillingInvoice["status"] }) {
  const tone =
    props.status === "paid" ? "positive" : props.status === "open" || props.status === "uncollectible" ? "warning" : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={tone} />
      {INVOICE_STATUS[props.status]}
    </span>
  );
}

/**
 * The org's invoices from Stripe, newest first: what each was for, whether
 * it is paid, when it is due, and the PDF and hosted page. A failure to load
 * is said in place, not as a page error: the plan above is still true.
 */
function InvoiceHistory() {
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchInvoices()
      .then((rows) => alive && setInvoices(rows))
      .catch((err) => alive && setError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PaneSection title="Invoices" description="Every invoice Stripe has issued this organisation.">
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : invoices === null ? (
        <LoadingSkeleton rows={2} />
      ) : invoices.length === 0 ? (
        <p className="text-sm text-mw-text-subtle">No invoices yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" aria-label="Invoices">
            <thead>
              <tr className="text-left text-mw-text-subtle">
                <th scope="col" className="py-1.5 pr-3 font-normal">Issued</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Amount</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Status</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Due</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <span className="sr-only">Links</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-t border-border" data-invoice-status={invoice.status}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatResetDate(invoice.issued_at)}
                    {invoice.number && <span className="ml-2 text-xs text-mw-text-subtle">{invoice.number}</span>}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{formatMicros(invoice.amount_due_micros)}</td>
                  <td className="py-2 pr-3">
                    <InvoiceStatus status={invoice.status} />
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{invoice.due_at ? formatResetDate(invoice.due_at) : "—"}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <span className="inline-flex gap-3">
                      {invoice.invoice_pdf && (
                        <a href={invoice.invoice_pdf} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                          PDF
                        </a>
                      )}
                      {invoice.hosted_invoice_url && (
                        <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                          {invoice.status === "open" || invoice.status === "uncollectible" ? "Pay" : "View"}
                        </a>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PaneSection>
  );
}
