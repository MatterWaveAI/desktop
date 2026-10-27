import { useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { PageHeader, ErrorState, LoadingSkeleton } from "../../patterns";
import { ShellContext } from "../../shell/shellContext";
import { SessionContext } from "../../shell/sessionContext";
import { PRIMARY_BUTTON_CLASS, PROSE_LINK_CLASS, failureMessage, queryParam } from "../../shell/authForms";
import { SIGNUP_PATH, VERIFY_PATH } from "../../shell/frontDoor";
import { FrontDoorFooter, FrontDoorHeader } from "../../shell/FrontDoorChrome";
import { getAuthConfig, managesOrg } from "../../lib/auth";
import type { AuthConfig } from "../../types";
import {
  fetchBillingStatus,
  fetchPlans,
  formatPrice,
  formatTokenAllowance,
  ANNUAL_OVERAGE_NOTE,
  overageSummary,
  PARTNER_MODELS_HEADING,
  PARTNER_MODELS_NOTE,
  planAllowance,
  planModelLabels,
  splitPartners,
  startCheckout,
  trialOffer,
  type BillingStatus,
  type PlanCatalog,
  type PlanSummary,
} from "../../lib/billing";
import { EnterpriseContact } from "./EnterpriseContact";
import { ModelPriceTable } from "./PriceTables";
import { ScrollFade } from "../../components/ui/scroll-fade";
import { annualSaving, comparisonRows, RECOMMENDED_REASON, recommendedPlan } from "./planComparison";

/**
 * The plan ladder. One page for four readers:
 *
 * - a stranger (no session): sees the prices under the front door's header
 *   and a Create-account button, because a paywall that hides its prices
 *   behind a login gets screenshotted;
 * - a person signed in but held at a gate (terms to accept, email to
 *   verify): is sent back to finish, never told to create an account;
 * - a member who is not an admin: sees the prices and is told who can
 *   subscribe, rather than a button that 403s;
 * - an admin: Subscribe starts Checkout. The API, not this page, decides the
 *   org (from the session) and refuses a plan with no price configured.
 *
 * The data is `/api/plans`, straight from the `plans` rows -- a plan repriced
 * in SQL shows up here with no deploy -- and the price list beside it, so
 * the model names, multipliers and per-token prices are the API's too.
 * Nothing about a price is hardcoded, and the comparison grid is the same
 * payload read sideways (`planComparison.ts`).
 *
 * A plan sold per seat (Team) says so on its card: the price is per seat,
 * each seat's tokens go into one pool, and the seats are the members, so
 * Subscribe asks for no count -- Checkout opens at the org's members.
 */

/**
 * The card's bullet list. The allowance, the overage line and the model
 * names come from `lib/billing.ts` in its own words; the rest is this
 * page's and in the catalogue.
 */
function limitLine(plan: PlanSummary, catalog: PlanCatalog, annual: boolean): string[] {
  const l = plan.limits;
  const tokens = formatTokenAllowance(plan.included_tokens);
  const allowance = plan.per_seat ? planAllowance(plan) : t`${tokens} / month`;
  const lines = [allowance, overageSummary(plan, annual)];
  const seats = l.max_seats;
  const conversations = l.max_conversations;
  if (plan.per_seat) lines.push(t`One seat per member, added and removed as they join and leave`);
  else if (seats == null) lines.push(t`Unlimited seats`);
  else lines.push(plural(seats, { one: "# seat", other: "# seats" }));
  if (conversations == null) lines.push(t`Unlimited conversations`);
  else lines.push(plural(conversations, { one: "# conversation", other: "# conversations" }));
  // The API resolves which priced models the plan includes (its allow-list
  // plus the house model every plan has), so the card only names them.
  const models = planModelLabels(plan, catalog.models);
  if (models.length > 0) lines.push(models.join(", "));
  if (l.features.api_keys) lines.push(t`API keys`);
  if (l.features.custom_instructions) lines.push(t`Custom instructions`);
  if (l.features.org_sso) lines.push(t`Single sign-on`);
  return lines;
}

export function PricingPage() {
  const { t } = useLingui();
  // Null outside the shell: no session, or a session held at a gate.
  const shell = useContext(ShellContext);
  // Non-null wherever there is a principal, gated or not.
  const session = useContext(SessionContext);
  const signedIn = shell !== null || session !== null;
  // Owner or admin by membership: who the API lets start a checkout.
  const isAdmin = managesOrg(shell?.principal);
  // Stripe's cancel URL brings the buyer back here; `?checkout=cancelled`
  // says that is why they are here.
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const cancelled = queryParam(searchStr, "checkout") === "cancelled";
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [annual, setAnnual] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<{ plan: string } | { error: string } | null>(null);
  // The front door's header needs to know how to sign in; Boot fetched the
  // config before this rendered, so this is a read, not a request.
  const config: AuthConfig | null = session?.config ?? shell?.authConfig ?? getAuthConfig();

  useEffect(() => {
    let alive = true;
    fetchPlans()
      .then((c) => alive && setCatalog(c))
      .catch((err) => alive && setLoadError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!shell) return;
    let alive = true;
    // The page is still a price list if this fails, but Subscribe cannot be
    // offered without it -- so the failure is said, with a retry, rather
    // than leaving every button waiting for an answer that is not coming.
    fetchBillingStatus()
      .then((s) => alive && setStatus(s))
      .catch((err) => alive && setStatusError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, [shell, statusVersion]);

  function retryStatus() {
    setStatusError(null);
    setStatusVersion((v) => v + 1);
  }

  const maxSaving = catalog
    ? catalog.plans
        .map((plan) => annualSaving(plan))
        .filter((s): s is string => s !== null)
        .sort((a, b) => parseInt(b) - parseInt(a))[0]
    : undefined;
  // The org's plan, for the recommendation: null with no org to speak of
  // (a stranger, a gated session, Free by default); undefined while the
  // status is still loading, when no card is badged rather than the wrong
  // one for a frame.
  const currentCode: string | null | undefined = !shell
    ? null
    : status
      ? status.implicit
        ? null
        : status.plan
      : statusError
        ? null
        : undefined;
  const recommended =
    catalog && currentCode !== undefined ? recommendedPlan(catalog.plans, currentCode)?.code : undefined;
  const anyTrial = catalog?.plans.some((plan) => (plan.trial_days ?? 0) > 0) ?? false;

  /** What sits under a paid plan's card for a signed-in admin: Subscribe, or why not. */
  function adminAction(plan: PlanSummary, busy: boolean) {
    if (statusError) {
      return (
        <p className="text-sm text-mw-text-muted">
          <Trans>Subscribing is unavailable until billing loads.</Trans>
        </p>
      );
    }
    if (!status) {
      return (
        <p className="text-sm text-mw-text-muted">
          <Trans>Checking billing…</Trans>
        </p>
      );
    }
    if (!status.billing_enabled) {
      return (
        <p className="text-sm text-mw-text-muted">
          <Trans>
            Self-serve subscriptions are not open on this deployment yet.{" "}
            <a href="#enterprise-contact" className={PROSE_LINK_CLASS}>
              Contact sales
            </a>
          </Trans>
        </p>
      );
    }
    return (
      <Button size="sm" onClick={() => void subscribe(plan.code)} disabled={busy}>
        {busy ? <Trans>Opening checkout…</Trans> : <Trans>Subscribe</Trans>}
      </Button>
    );
  }

  /**
   * The call to action under a card, by who is reading. A person signed in
   * but held at a gate is never offered an account they already have: the
   * way to subscribe is to finish what the gate asks, so that is the link.
   */
  function action(plan: PlanSummary, free: boolean, current: boolean, busy: boolean): ReactNode {
    if (current) {
      return (
        <p className="text-sm font-medium">
          <Trans>Your current plan</Trans>
        </p>
      );
    }
    if (!signedIn) {
      return (
        <a href={SIGNUP_PATH} className={`${PRIMARY_BUTTON_CLASS} inline-flex min-h-6 items-center pointer-coarse:min-h-11`}>
          {free ? <Trans>Create account</Trans> : <Trans>Sign up to subscribe</Trans>}
        </a>
      );
    }
    if (free) {
      return (
        <p className="text-sm text-mw-text-muted">
          <Trans>Included with every account</Trans>
        </p>
      );
    }
    if (!shell && session) return <GateAction gate={session.gate} email={session.principal.email} />;
    if (isAdmin) return adminAction(plan, busy);
    return (
      <p className="text-sm text-mw-text-muted">
        <Trans>Ask an organisation admin to subscribe</Trans>
      </p>
    );
  }

  async function subscribe(code: string) {
    setCheckout({ plan: code });
    try {
      window.location.assign(await startCheckout(code, annual));
    } catch (err) {
      setCheckout({ error: failureMessage(err) });
    }
  }

  // Inside the shell its <main> already holds the page; on its own the page is the main landmark.
  const Body = shell ? "div" : "main";
  return (
    <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      {!signedIn && <FrontDoorHeader config={config} />}
      <Body className={`mx-auto w-full max-w-6xl pb-12 ${signedIn ? "" : "sm:px-3 sm:pt-6"}`}>
        {shell && (
          <p className="px-4 pt-4 text-sm">
            <Link
              to="/settings/$paneId"
              params={{ paneId: "billing" }}
              className="inline-flex min-h-6 items-center text-mw-text-muted underline-offset-2 hover:text-mw-text hover:underline pointer-coarse:min-h-11"
            >
              <Trans>← Back to Settings › Billing</Trans>
            </Link>
          </p>
        )}
        <PageHeader
          title={t`Plans`}
          description={t`Every plan includes a monthly allowance of tokens. Pick monthly or annual billing, compare the plans below, and read how the allowance works under the cards.`}
        />
        <div className="px-4">
          <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <div
            className="inline-flex items-center gap-1 rounded-xl border border-mw-border bg-mw-surface-raised p-1"
            role="group"
            aria-label={t`Billing period`}
          >
            <button
              type="button"
              aria-pressed={!annual}
              onClick={() => setAnnual(false)}
              className={`inline-flex min-h-6 items-center rounded-lg px-3.5 py-1.5 pointer-coarse:min-h-11 ${!annual ? "bg-mw-surface-active font-medium text-mw-text" : "text-mw-text-muted hover:text-mw-text"}`}
            >
              <Trans>Monthly</Trans>
            </button>
            <button
              type="button"
              aria-pressed={annual}
              onClick={() => setAnnual(true)}
              className={`inline-flex min-h-6 items-center rounded-lg px-3.5 py-1.5 pointer-coarse:min-h-11 ${annual ? "bg-mw-surface-active font-medium text-mw-text" : "text-mw-text-muted hover:text-mw-text"}`}
            >
              <Trans>Annual</Trans>
            </button>
          </div>
            {maxSaving && (
              <span
                data-annual-saving
                className="rounded-full border border-mw-positive-border bg-mw-positive-subtle px-2.5 py-0.5 text-xs font-medium text-mw-positive"
              >
                <Trans>Up to {maxSaving} on annual billing</Trans>
              </span>
            )}
          </div>

          {cancelled && (
            <Alert data-checkout-cancelled role="status" variant="info" className="mb-4">
              <Trans>Checkout was cancelled, so nothing was charged. Pick a plan whenever you are ready.</Trans>
            </Alert>
          )}

          {statusError && (
            <Alert
              role="alert"
              variant="danger"
              className="mb-4"
              action={
                <button
                  type="button"
                  onClick={retryStatus}
                  className="inline-flex min-h-6 items-center font-medium text-mw-danger underline underline-offset-2 pointer-coarse:min-h-11"
                >
                  <Trans>Try again</Trans>
                </button>
              }
            >
              <p>
                <Trans>Could not check your subscription: {statusError}</Trans>
              </p>
            </Alert>
          )}

          {checkout && "error" in checkout && (
            <Alert role="alert" variant="danger" className="mb-4">
              {checkout.error}
            </Alert>
          )}

          {loadError ? (
            <ErrorState title={t`Could not load plans`} message={loadError} />
          ) : !catalog ? (
            <LoadingSkeleton />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t`Plans`}>
              {catalog.plans.map((plan) => {
                const price = annual ? plan.price_cents_annual : plan.price_cents_monthly;
                const free = plan.price_cents_monthly === 0;
                // An org with no subscription row is on Free by default: that
                // is still its current plan, whatever the row says.
                const current = status ? (status.implicit ? free : status.plan === plan.code) : false;
                const saving = annual && !free ? annualSaving(plan) : null;
                const busy = checkout !== null && "plan" in checkout && checkout.plan === plan.code;
                const isRecommended = !current && plan.code === recommended;
                return (
                  <li
                    key={plan.code}
                    data-plan={plan.code}
                    data-plan-recommended={isRecommended || undefined}
                    aria-current={current ? "true" : undefined}
                    className={`relative flex flex-col rounded-xl border bg-mw-surface-raised p-5 ${
                      current || isRecommended ? "border-mw-focus" : "border-mw-border"
                    } ${isRecommended ? "shadow-lg" : ""}`}
                  >
                    {current && (
                      <span
                        data-plan-badge="current"
                        className="absolute -top-2.5 left-5 rounded-full bg-mw-accent px-2.5 py-0.5 text-xs font-semibold text-mw-accent-foreground"
                      >
                        <Trans>Your plan</Trans>
                      </span>
                    )}
                    {isRecommended && (
                      <span
                        data-plan-badge="recommended"
                        className="absolute -top-2.5 left-5 rounded-full bg-mw-accent px-2.5 py-0.5 text-xs font-semibold text-mw-accent-foreground"
                      >
                        <Trans>Recommended</Trans>
                      </span>
                    )}
                    <h2 className="font-display text-display-sm">{plan.name}</h2>
                    {isRecommended && (
                      <p data-plan-reason className="mt-0.5 text-xs text-mw-text-muted">
                        {RECOMMENDED_REASON}
                      </p>
                    )}
                    <p className="mt-2 text-3xl font-semibold tabular-nums">
                      {formatPrice(free ? 0 : price)}
                      {!free && (
                        <span className="text-sm font-normal text-mw-text-muted">
                          {plan.per_seat ? <Trans> per seat</Trans> : ""}
                          {annual ? <Trans> / year</Trans> : <Trans> / month</Trans>}
                        </span>
                      )}
                    </p>
                    {/* The saving is a badge, the trial plain text: two accent
                        lines in the same voice read as one offer. */}
                    {saving && (
                      <p className="mt-1.5">
                        <span
                          data-plan-saving
                          className="rounded-full border border-mw-positive-border bg-mw-positive-subtle px-2 py-0.5 text-xs font-medium text-mw-positive"
                        >
                          {saving}
                        </span>
                      </p>
                    )}
                    {!free && trialOffer(plan) && (
                      <p data-plan-trial className="mt-1 text-sm text-mw-text-muted">
                        {trialOffer(plan)}
                      </p>
                    )}
                    <ul className="mt-4 flex flex-1 flex-col gap-1.5 border-t border-mw-border pt-4 text-sm text-mw-text-subtle">
                      {limitLine(plan, catalog, annual).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <div className="mt-5">{action(plan, free, current, busy)}</div>
                  </li>
                );
              })}
            </ul>
          )}

          {catalog && (
            <section aria-labelledby="allowance-how" className="mt-12 flex flex-col gap-3">
              <h2 id="allowance-how" className="font-display text-display-sm">
                <Trans>How the allowance works</Trans>
              </h2>
              <p className="text-sm text-mw-text-muted">
                <Trans>
                  An allowance counts weighted tokens: every prompt and completion token times the
                  model's multiplier, so an allowance buys the same dollars of list price whichever
                  model spends it. Paid monthly plans keep going past the allowance at each model's
                  list price, up to an overage cap that starts at the plan's monthly price and that
                  an administrator can raise or lower.
                </Trans>{" "}
                {ANNUAL_OVERAGE_NOTE}
              </p>
            </section>
          )}

          {catalog && (
            <section aria-labelledby="plan-comparison" className="mt-12 flex flex-col gap-3">
              <h2 id="plan-comparison" className="font-display text-display-sm">
                <Trans>Compare the plans</Trans>
              </h2>
              <div className="rounded-xl border border-mw-border bg-mw-surface-raised px-5 py-3">
                <ScrollFade label={t`Plan comparison`}>
                  <table className="w-full text-sm" aria-label={t`Plan comparison`}>
                    <thead>
                      <tr>
                        <th scope="col" className="py-2 pr-4 text-left font-normal text-mw-text-muted">
                          <span className="sr-only">
                            <Trans>What</Trans>
                          </span>
                        </th>
                        {catalog.plans.map((plan) => (
                          <th key={plan.code} scope="col" className="py-2 pr-4 text-left font-display text-xl font-normal">
                            {plan.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRows(catalog.plans, catalog.models, annual).map((row) => (
                        <tr key={row.key} data-compare={row.key} className="border-t border-mw-border">
                          <th scope="row" className="py-2 pr-4 text-left font-normal text-mw-text-muted">
                            {row.label}
                          </th>
                          {row.cells.map((cell, index) => (
                            <td key={catalog.plans[index].code} className="py-2 pr-4 align-top">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollFade>
              </div>
            </section>
          )}

          {catalog && splitPartners(catalog.models).own.length > 0 && (
            <section aria-labelledby="model-prices" className="mt-12 flex flex-col gap-3">
              <h2 id="model-prices" className="font-display text-display-sm">
                <Trans>Model prices</Trans>
              </h2>
              <p className="text-sm text-mw-text-muted">
                <Trans>Past the allowance, a paid monthly plan is billed at these list prices.</Trans>
              </p>
              <ModelPriceTable
                name={t`Model prices`}
                models={splitPartners(catalog.models).own}
                plans={catalog.plans}
              />
            </section>
          )}

          {catalog && splitPartners(catalog.models).partners.length > 0 && (
            <section aria-labelledby="partner-prices" className="mt-12 flex flex-col gap-3">
              <h2 id="partner-prices" className="font-display text-display-sm">
                {PARTNER_MODELS_HEADING}
              </h2>
              <p className="text-sm text-mw-text-muted">{PARTNER_MODELS_NOTE}</p>
              <ModelPriceTable
                name={t`Partner model prices`}
                models={splitPartners(catalog.models).partners}
                plans={catalog.plans}
              />
            </section>
          )}

          {catalog && <Faq trial={anyTrial} />}

          {/* Held back until the plans are in (or have failed): mounted under
              the skeleton, the form and the link were pushed down a screen
              when the cards arrived -- a 0.43 layout shift on a phone. */}
          {(catalog || loadError) && <EnterpriseContact />}
        </div>
      </Body>
      {!signedIn && <FrontDoorFooter config={config} />}
    </div>
  );
}

/**
 * Under a paid card for a person held at a gate: the way to subscribe is
 * through the gate, so that is where the link goes. Verification links the
 * code page with the address filled in; the other gates stand at "/".
 */
function GateAction(props: { gate: "pending" | "terms" | "onboarding" | null; email: string | null }) {
  const link = "inline-flex min-h-6 items-center text-sm underline underline-offset-2 hover:text-mw-text pointer-coarse:min-h-11";
  if (props.gate === "pending") {
    const href = props.email ? `${VERIFY_PATH}?email=${encodeURIComponent(props.email)}` : VERIFY_PATH;
    return (
      <p data-gate-action="pending" className="text-sm text-mw-text-muted">
        <Trans>
          <a href={href} className={link}>
            Verify your email
          </a>{" "}
          to subscribe.
        </Trans>
      </p>
    );
  }
  if (props.gate === "terms") {
    return (
      <p data-gate-action="terms" className="text-sm text-mw-text-muted">
        <Trans>
          <a href="/" className={link}>
            Accept the updated terms
          </a>{" "}
          to subscribe.
        </Trans>
      </p>
    );
  }
  return (
    <p data-gate-action="onboarding" className="text-sm text-mw-text-muted">
      <Trans>
        <a href="/" className={link}>
          Finish setting up
        </a>{" "}
        to subscribe.
      </Trans>
    </p>
  );
}

/**
 * The questions a buyer asks before the button, answered from what the
 * terms (section 5) and the product pages already say. Nothing here states
 * a price or a limit: those are on the cards, read from the catalog. The
 * trial question is shown only when some plan has one.
 */
function Faq(props: { trial: boolean }) {
  const { t } = useLingui();
  const items: { q: string; a: string }[] = [
    {
      q: t`How am I billed?`,
      a: t`Monthly or annually, in advance, at the price shown on the card, by card when you subscribe. A plan sold per seat is charged for each member of the organisation. Organisations that need invoices on net terms with a PO number can ask sales below.`,
    },
    {
      q: t`What happens when I reach my allowance?`,
      a: t`On the Free plan and on any annual plan, requests stop until the month resets. On a paid monthly plan, requests keep going at each model's list price, billed as overage on the next invoice, up to the overage cap.`,
    },
    {
      q: t`What is the overage cap?`,
      a: t`The most overage a month can add. It starts at the plan's monthly price (per seat on a plan sold per seat), so a runaway key can bill at most what you already agreed to pay once; an administrator can raise or lower it in Settings. When the cap is reached, requests are refused until the month resets. A spending budget can stop requests sooner.`,
    },
    {
      q: t`How do seats work?`,
      a: t`Pro and Pro Plus are one seat. The Team plan is sold per seat: the seats are the members, added and removed as they join and leave, and every seat's tokens go into one pool the whole organisation draws on. Pending invites are not billed.`,
    },
    {
      q: t`Can I cancel or change plans?`,
      a: t`Yes. An organisation owner or admin can cancel or change the plan from Settings, Billing; a member cannot. A cancelled subscription runs to the end of the period already paid for. An upgrade takes effect on the next request. A downgrade never deletes anything: if the organisation holds more conversations than the new plan allows, the existing ones stay readable and exportable and creating new ones waits until you upgrade or remove some.`,
    },
  ];
  if (props.trial) {
    items.push({
      q: t`Does a free trial need a card?`,
      a: t`Yes. Where a plan offers a free trial, the payment method collected when subscribing is charged when the trial ends unless the subscription is cancelled first.`,
    });
  }
  return (
    <section aria-labelledby="pricing-faq" className="mt-12 flex flex-col gap-3">
      <h2 id="pricing-faq" className="font-display text-display-sm">
        <Trans>Questions</Trans>
      </h2>
      <dl className="flex flex-col divide-y divide-mw-border rounded-xl border border-mw-border bg-mw-surface-raised">
        {items.map((item) => (
          <div key={item.q} className="flex flex-col gap-1 px-5 py-4">
            <dt className="text-sm font-semibold">{item.q}</dt>
            <dd className="text-sm text-mw-text-subtle">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
