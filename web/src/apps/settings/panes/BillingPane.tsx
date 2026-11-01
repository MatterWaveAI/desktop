import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { msg, plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Alert } from "../../../components/ui/alert";
import { StatusDot } from "../../../components/ui/badge";
import { Button, buttonVariants } from "../../../components/ui/button";
import { formatDateTime } from "../../../i18n/format";
import { apiFetch } from "../../../lib/api";
import { ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { failureMessage } from "../../../shell/authForms";
import { managesOrg } from "../../../lib/auth";
import { goToStripe, useRefreshOnReturn } from "../../../lib/desktopBilling";
import {
  ANNUAL_OVERAGE_NOTE_MSG,
  SEATS_FOLLOW_MEMBERS_NOTE_MSG,
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
      return t`Free trial`;
    case "past_due":
    case "unpaid":
      return t`Past due`;
    case "canceled":
      return t`Cancelled`;
    case "incomplete":
    case "incomplete_expired":
      return t`Payment incomplete`;
    case "paused":
      return t`Paused`;
  }
  if (status.cancel_at_period_end) return end ? t`Cancels on ${end}` : t`Cancels at the end of the period`;
  if (status.status === "active") return end ? t`Active, renews ${end}` : t`Active`;
  const words = status.status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function BillingPane() {
  const { t, i18n } = useLingui();
  const { principal } = useShell();
  const isAdmin = managesOrg(principal);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portal, setPortal] = useState<"idle" | "opening" | string>("idle");
  // The desktop app opened the portal in the system browser.
  const [portalOutside, setPortalOutside] = useState(false);
  const [version, setVersion] = useState(0);
  // The error is cleared by the retry, not by the effect: a setState at the
  // top of an effect is the lint's "set-state-in-effect" and an extra render
  // for nothing on the first mount, when there is no error to clear.
  const reload = useCallback(() => {
    setError(null);
    setVersion((v) => v + 1);
  }, []);

  // The desktop app's return from the portal in the browser: the window
  // coming back to the front reads the status again.
  useRefreshOnReturn(reload);

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
      if (goToStripe(await openPortal())) {
        setPortal("idle");
        setPortalOutside(true);
      }
    } catch (err) {
      setPortal(failureMessage(err));
    }
  }

  if (error) {
    return <ErrorState title={t`Could not load billing`} message={error} onRetry={reload} />;
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
  const planName = status.plan_name;
  const includedTokens = formatTokens(included);
  const billedSeats = formatSeats(status.billed_seats);
  const perSeatAllowance = formatTokenAllowance(perSeatTokens);
  const defaultCap = formatMicros(status.default_overage_cap_micros);
  const unitPrice = formatPrice(seatPrice);
  const seatsTotal = formatPrice(status.billed_seats * seatPrice);
  const seatCount = status.seats;

  // The portal is the pane's one primary action, so it sits beside the
  // title; only an admin of an org Stripe knows can open it.
  const canManage = isAdmin && status.billing_enabled;

  return (
    <div className="flex flex-col gap-7">
      {canManage && (
        <PaneActions>
          <Button size="lg" onClick={() => void manage()} disabled={portal === "opening"}>
            {portal === "opening" ? t`Opening…` : t`Manage billing`}
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
                <Trans>Pay the invoice</Trans>
              </a>
            ) : undefined
          }
        >
          <p>{notice.text}</p>
        </Alert>
      )}

      <PaneSection title={t`Plan`} description={t`What this organisation is subscribed to.`}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className={DT_CLASS}>
              <Trans>Plan</Trans>
            </dt>
            <dd className="font-medium">{planName}</dd>
          </div>
          <div>
            <dt className={DT_CLASS}>
              <Trans>Status</Trans>
            </dt>
            <dd className="font-medium" data-billing-state>
              {subscriptionState(status)}
            </dd>
          </div>
          <div>
            <dt className={DT_CLASS}>
              <Trans>Included tokens</Trans>
            </dt>
            <dd className="font-medium">
              <Trans>{includedTokens} / month</Trans>
            </dd>
            {status.per_seat && (
              <dd className={NOTE_CLASS}>
                <Trans>{billedSeats} × {perSeatAllowance}, one pool for everyone</Trans>
              </dd>
            )}
          </div>
          <div>
            <dt className={DT_CLASS}>
              <Trans>Past the allowance</Trans>
            </dt>
            <dd className="font-medium">
              {overage ? t`List price, up to ${defaultCap} by default` : t`Requests stop`}
            </dd>
            {annual && <dd className={NOTE_CLASS}>{i18n._(ANNUAL_OVERAGE_NOTE_MSG)}</dd>}
          </div>
          <div>
            <dt className={DT_CLASS}>
              <Trans>Payment</Trans>
            </dt>
            <dd className="font-medium" data-billing-payment-method>
              {status.implicit ? "—" : paymentMethodLabel(status)}
            </dd>
          </div>
          {trialEnds(status) && (
            <div data-billing-trial className="sm:col-span-2">
              <dt className={DT_CLASS}>
                <Trans>Free trial</Trans>
              </dt>
              <dd className="font-medium">{trialEnds(status)}</dd>
              <dd className={NOTE_CLASS}>
                <Trans>The card on file is charged when the trial ends, unless the plan is cancelled first.</Trans>
              </dd>
            </div>
          )}
          {status.per_seat ? (
            <div data-billing-seats className="sm:col-span-2">
              <dt className={DT_CLASS}>
                <Trans>Seats</Trans>
              </dt>
              <dd className="font-medium">
                {annual ? (
                  <Trans>
                    {billedSeats} × {unitPrice} = {seatsTotal} / year
                  </Trans>
                ) : (
                  <Trans>
                    {billedSeats} × {unitPrice} = {seatsTotal} / month
                  </Trans>
                )}
              </dd>
              <dd className={NOTE_CLASS}>{i18n._(SEATS_FOLLOW_MEMBERS_NOTE_MSG)}</dd>
            </div>
          ) : (
            status.seats > 1 && (
              <div>
                <dt className={DT_CLASS}>
                  <Trans>Seats</Trans>
                </dt>
                <dd className="font-medium">{seatCount}</dd>
              </div>
            )
          )}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <Link to="/pricing" className={LINK_CLASS}>
            <Trans>Change plan</Trans>
          </Link>
          <UsageLink />
        </div>
        {!isAdmin && (
          <p className="mt-2 text-xs text-mw-text-subtle">
            <Trans>Only an organisation admin can change the card or the plan.</Trans>
          </p>
        )}
        {portalOutside && (
          <p role="status" className="mt-2 text-sm text-mw-text-muted" data-portal-outside="">
            Billing is open in your browser. Changes made there show here when you come back.
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
      <Trans>See usage</Trans>
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
  const { t } = useLingui();
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
    typeof maxSeats === "number" ? formatSeats(maxSeats) : maxSeats === null ? t`Unlimited seats` : null;
  const plan = catalog?.plans.find((p) => p.code === status.plan);
  const labels = plan && catalog ? planModelLabels(plan, catalog.models) : [];
  // The allow-list is the models beyond the one every plan has.
  const extra = Array.isArray(status.limits.allowed_models) ? status.limits.allowed_models.length : 0;
  const modelCount = extra + 1;
  const modelsLine =
    labels.length > 0 ? listOf(labels) : plural(modelCount, { one: "# model", other: "# models" });
  const planName = status.plan_name;
  const includedTokens = formatTokens(included);
  return (
    <PaneSection title={t`Plan`} description={t`What this organisation is on, and what it includes.`}>
      {/* Choosing a plan is the pane's one primary action on Free. */}
      <PaneActions>
        <Link to="/pricing" className={buttonVariants({ size: "lg" })}>
          <Trans>Upgrade</Trans>
        </Link>
      </PaneActions>
      <p className="text-lg font-semibold" data-billing-state>
        <Trans>You're on {planName}</Trans>
      </p>
      <ul
        className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-mw-text-subtle"
        aria-label={t`What Free includes`}
      >
        <li>
          <Trans>{includedTokens} a month, counted by each model's weight</Trans>
        </li>
        {seats && <li>{seats}</li>}
        <li data-billing-models>{modelsLine}</li>
        <li>
          <Trans>Requests stop when the included tokens run out; nothing is billed</Trans>
        </li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
        <UsageLink />
      </div>
      {!props.isAdmin && (
        <p className="mt-2 text-xs text-mw-text-subtle">
          <Trans>Only an organisation admin can choose a plan. Ask an admin to subscribe.</Trans>
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

const EVENT_KIND: Record<string, MessageDescriptor> = {
  upgrade: msg`Upgrade`,
  downgrade: msg`Downgrade`,
  cancel: msg`Cancelled`,
  lateral: msg`Plan change`,
  status_change: msg`Status change`,
};

/** "Free → Pro", or the status that changed when the plan did not. */
export function planEventLabel(event: PlanEvent): string {
  const name = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);
  if (event.from_plan !== event.to_plan) return `${name(event.from_plan)} → ${name(event.to_plan)}`;
  const status = event.to_status.replace(/_/g, " ");
  const plan = name(event.to_plan);
  return t`${plan}, now ${status}`;
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
  return { text: text || t`Stripe reference`, title: reason };
}

/** Who made the change, as a person reads it: Stripe, an operator, or a member. */
export function planEventActor(actor: string): string {
  if (actor.startsWith("stripe:")) return "Stripe";
  if (actor.startsWith("operator:")) return t`An operator`;
  if (actor.startsWith("system:") || actor === "system") return t`Automatic`;
  return actor;
}

function formatEventTime(iso: string): string {
  return formatDateTime(iso, { dateStyle: "medium", timeStyle: "short" }) || iso;
}

/**
 * Every plan and status change the org has been through, newest first:
 * the billing trail the API keeps for owners and admins. A failure to load
 * is said in place, like the invoices: the plan above is still true.
 */
function PlanHistory() {
  const { t, i18n } = useLingui();
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
      title={t`Plan history`}
      description={t`Every change of plan or subscription status, newest first.`}
      flush={events !== null && events.length > 0 && !error}
    >
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : events === null ? (
        <LoadingSkeleton rows={2} />
      ) : events.length === 0 ? (
        <p className="text-sm text-mw-text-subtle">
          <Trans>No changes yet.</Trans>
        </p>
      ) : (
        <RowList aria-label={t`Plan history`}>
          {events.map((event, index) => (
            <Row
              key={`${event.created_at}-${index}`}
              title={planEventLabel(event)}
              meta={
                <>
                  {EVENT_KIND[event.kind] ? i18n._(EVENT_KIND[event.kind]) : event.kind} · {planEventActor(event.actor)}
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

const INVOICE_STATUS: Record<BillingInvoice["status"], MessageDescriptor> = {
  draft: msg`Draft`,
  open: msg`Unpaid`,
  paid: msg`Paid`,
  uncollectible: msg`Unpaid`,
  void: msg`Void`,
};

/** Paid in emerald, owed in amber, anything else neutral: the dot carries the tone, the word the meaning. */
function InvoiceStatus(props: { status: BillingInvoice["status"] }) {
  const { i18n } = useLingui();
  const tone =
    props.status === "paid" ? "positive" : props.status === "open" || props.status === "uncollectible" ? "warning" : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={tone} />
      {i18n._(INVOICE_STATUS[props.status])}
    </span>
  );
}

/**
 * The org's invoices from Stripe, newest first: what each was for, whether
 * it is paid, when it is due, and the PDF and hosted page. A failure to load
 * is said in place, not as a page error: the plan above is still true.
 */
function InvoiceHistory() {
  const { t } = useLingui();
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
    <PaneSection title={t`Invoices`} description={t`Every invoice Stripe has issued this organisation.`}>
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : invoices === null ? (
        <LoadingSkeleton rows={2} />
      ) : invoices.length === 0 ? (
        <p className="text-sm text-mw-text-subtle">
          <Trans>No invoices yet.</Trans>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" aria-label={t`Invoices`}>
            <thead>
              <tr className="text-left text-mw-text-subtle">
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <Trans>Issued</Trans>
                </th>
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <Trans>Amount</Trans>
                </th>
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <Trans>Due</Trans>
                </th>
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  <span className="sr-only">
                    <Trans>Links</Trans>
                  </span>
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
                          {invoice.status === "open" || invoice.status === "uncollectible" ? t`Pay` : t`View`}
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
