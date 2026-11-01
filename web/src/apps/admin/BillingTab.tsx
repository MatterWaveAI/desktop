import { useCallback, useEffect, useId, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { formatDateTime } from "../../i18n/format";
import { Alert } from "../../components/ui/alert";
import { Badge, StatusDot } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  fetchBilling,
  fetchStripeEvents,
  formatCents,
  runReconcile,
  setStripePrices,
  type AdminPlanRow,
  type BillingOverview,
  type ReconcileReport,
  type StripeEventRow,
} from "./adminApi";

/**
 * The operator's billing surface.
 *
 * Three things an operator needs and currently has no way to see:
 *
 * 1. **Is billing actually wired up.** Both the Stripe key and the webhook
 *    secret are required, and a plan with no price id cannot be sold
 *    however correct everything else is. Learning that here beats learning
 *    it from a customer who clicked Subscribe.
 * 2. **Did Stripe's events arrive.** The first question when someone says
 *    they paid and nothing happened.
 * 3. **Do the proxy's limits match the plans.** Drift costs money in both
 *    directions, so the reconcile button reports them separately.
 *
 * Deliberately NOT here: creating products and prices. Those are immutable
 * once a subscriber is on them, so they belong in `scripts/stripe_setup.py`
 * where the command can be read before it runs. This page does the
 * reversible half -- pasting an id onto a plan -- which is the half worth
 * making easy.
 */


export function BillingTab() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: BillingOverview }
  >({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchBilling()
      .then((data) => alive && setState({ phase: "ready", data }))
      .catch((err: unknown) => alive && setState({ phase: "error", message: failureMessage(err) }));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const { t } = useLingui();

  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load billing`} message={state.message} onRetry={reload} />;
  }
  return (
    <div className="space-y-8">
      <Readiness data={state.data} />
      <PlansTable plans={state.data.plans} onSaved={reload} />
      <Reconcile />
      <EventsTable />
    </div>
  );
}

/**
 * What is missing, stated plainly.
 *
 * Each row is a precondition for taking money, and each says what to do
 * rather than only that it is unset -- an operator reading "not set"
 * still has to go and find out which variable.
 */
function Readiness({ data }: { data: BillingOverview }) {
  const { t } = useLingui();
  // Plan codes, as the catalog names them.
  const unpriced = data.plans_without_prices.join(", ");
  const checks = [
    {
      key: "api-key",
      ok: data.has_api_key,
      label: t`Stripe API key`,
      fix: t`Set MW_STRIPE_API_KEY to a restricted key (rk_...).`,
    },
    {
      key: "webhook-secret",
      ok: data.has_webhook_secret,
      label: t`Webhook signing secret`,
      fix: t`Set MW_STRIPE_WEBHOOK_SECRET. Without it every webhook is refused, by design.`,
    },
    {
      key: "prices",
      ok: data.plans_without_prices.length === 0,
      label: t`Every paid plan has a Stripe price`,
      fix: t`No price id on: ${unpriced}. Run scripts/stripe_setup.py, or paste the ids below.`,
    },
    {
      key: "upstream",
      ok: data.upstream_enforcement,
      label: t`Upstream limit enforcement`,
      fix: t`MW_LITELLM_VIRTUAL_KEYS is off, so the app gate is the only thing enforcing plan limits. Turn it on before taking payments.`,
    },
  ];
  return (
    <section aria-labelledby="billing-readiness">
      <h3 id="billing-readiness" className="text-sm font-medium text-mw-text">
        <Trans>Readiness</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        {data.configured ? (
          <Trans>Stripe is configured. Checkout and the webhook are live.</Trans>
        ) : (
          <Trans>
            Billing is off. Checkout and the portal answer 503 until both the key and the webhook secret are set.
          </Trans>
        )}
      </p>
      <ul className="mt-3 space-y-2">
        {checks.map((check) => (
          <li key={check.key} className="flex items-start gap-2 text-sm">
            <Badge variant={check.ok ? "positive" : "destructive"} className="mt-0.5 shrink-0">
              <StatusDot tone={check.ok ? "positive" : "danger"} />
              {check.ok ? <Trans>ok</Trans> : <Trans>missing</Trans>}
            </Badge>
            <span>
              <span className={check.ok ? "text-mw-text" : "font-medium text-mw-text"}>{check.label}</span>
              {!check.ok && <span className="block text-mw-text-muted">{check.fix}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlansTable({ plans, onSaved }: { plans: AdminPlanRow[]; onSaved: () => void }) {
  const { t } = useLingui();
  return (
    <section aria-labelledby="billing-plans">
      <h3 id="billing-plans" className="text-sm font-medium text-mw-text">
        <Trans>Plans and Stripe prices</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          The catalog is the source of truth for names and amounts. These are the Stripe price ids Checkout sells.
          Prices are immutable once someone is subscribed, so changing an amount means a new price in Stripe, not an
          edit here.
        </Trans>
      </p>
      <p className="mt-1 mb-3 text-sm text-mw-text-muted">
        <Trans>
          The ids come from the Stripe Dashboard, under Products: open the product and copy the id of each price (it
          starts with <code className="font-mono text-xs">price_</code>).
        </Trans>
      </p>
      <Table className="bg-card" aria-label={t`Plans`}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Plan</Trans>
            </TableHead>
            <TableHead>
              <Trans>Monthly</Trans>
            </TableHead>
            <TableHead>
              <Trans>Annual</Trans>
            </TableHead>
            <TableHead>
              <Trans>Stripe price ids</Trans>
            </TableHead>
            <TableHead>
              <Trans>Status</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((plan) => (
            <PlanRow key={plan.code} plan={plan} onSaved={onSaved} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function PlanRow({ plan, onSaved }: { plan: AdminPlanRow; onSaved: () => void }) {
  const monthlyId = useId();
  const annualId = useId();
  const [monthly, setMonthly] = useState(plan.stripe_price_id_monthly ?? "");
  const [annual, setAnnual] = useState(plan.stripe_price_id_annual ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useLingui();
  const planName = plan.name;

  // `free` is never sold: a null price id is how "cannot be bought through
  // Checkout" is expressed, so offering the inputs would invite a mistake.
  const isFree = plan.code === "free";
  const dirty =
    monthly !== (plan.stripe_price_id_monthly ?? "") || annual !== (plan.stripe_price_id_annual ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setStripePrices(plan.code, monthly.trim() || null, annual.trim() || null);
      onSaved();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{plan.name}</span>
        <span className="ml-2 font-mono text-xs text-mw-text-muted">{plan.code}</span>
      </TableCell>
      <TableCell>{formatCents(plan.price_cents_monthly)}</TableCell>
      <TableCell>{formatCents(plan.price_cents_annual)}</TableCell>
      <TableCell>
        {isFree ? (
          <span className="text-xs text-mw-text-muted">
            <Trans>Not sold through Checkout.</Trans>
          </span>
        ) : (
          <div className="space-y-1">
            <label htmlFor={monthlyId} className="block text-xs text-mw-text-muted">
              <Trans>Monthly price id</Trans>
            </label>
            <Input
              id={monthlyId}
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="price_…"
              aria-label={t`${planName} monthly Stripe price id`}
              className="font-mono text-xs"
            />
            <label htmlFor={annualId} className="block text-xs text-mw-text-muted">
              <Trans>Annual price id</Trans>
            </label>
            <Input
              id={annualId}
              value={annual}
              onChange={(e) => setAnnual(e.target.value)}
              placeholder="price_…"
              aria-label={t`${planName} annual Stripe price id`}
              className="font-mono text-xs"
            />
            {dirty && (
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
            )}
            {error && (
              <p role="alert" className="text-xs text-mw-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        {isFree ? (
          <Badge variant="outline">
            <Trans>default</Trans>
          </Badge>
        ) : plan.sellable ? (
          <Badge variant="positive">
            <Trans>sellable</Trans>
          </Badge>
        ) : (
          <Badge variant="destructive">
            <Trans>no price</Trans>
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Run the entitlement reconciliation now.
 *
 * The hourly job is the backstop; this is the button an operator presses
 * after fixing a proxy, to confirm the repair rather than wonder. The two
 * drift directions are reported separately because they cost differently:
 * an over-entitled org is spending money now, an under-entitled one is
 * about to churn.
 */
function Reconcile() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setReport(await runReconcile());
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="billing-reconcile">
      <h3 id="billing-reconcile" className="text-sm font-medium text-mw-text">
        <Trans>Entitlement reconciliation</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Checks every subscribed organisation against the model gateway and repairs any mismatch. Runs hourly on its
          own; this runs it now.
        </Trans>
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          {running ? <Trans>Reconciling…</Trans> : <Trans>Reconcile now</Trans>}
        </Button>
        {report && <ReconcileSummary report={report} />}
      </div>
      {error && (
        <Alert role="alert" variant="danger" className="mt-2">
          {error}
        </Alert>
      )}
    </section>
  );
}

function ReconcileSummary({ report }: { report: ReconcileReport }) {
  const checked = report.checked;
  const repaired = report.repaired;
  const over = report.over_entitled;
  const under = report.under_entitled;
  return (
    <span className="text-sm text-mw-text-muted">
      <Trans>
        Checked {checked}, repaired {repaired}
      </Trans>
      {over > 0 && (
        <span className="ml-2 font-medium text-mw-danger">
          <Trans>{over} over-entitled (spending)</Trans>
        </span>
      )}
      {under > 0 && (
        <span className="ml-2 font-medium text-mw-text">
          <Trans>{under} under-entitled (churn risk)</Trans>
        </span>
      )}
    </span>
  );
}

/** A webhook outcome as the API names it, in the reader's language where it is one we know. */
function OutcomeLabel({ outcome }: { outcome: string }) {
  if (outcome === "applied") return <Trans>applied</Trans>;
  if (outcome === "ignored") return <Trans>ignored</Trans>;
  if (outcome === "unresolved") return <Trans>unresolved</Trans>;
  return <>{outcome}</>;
}

function outcomeVariant(outcome: string): "secondary" | "destructive" {
  // `unresolved` is the one worth looking at: a burst of them means a
  // webhook pointed at the wrong deployment.
  return outcome === "unresolved" ? "destructive" : "secondary";
}

function EventsTable() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: StripeEventRow[] }
  >({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchStripeEvents()
      .then((data) => alive && setState({ phase: "ready", data }))
      .catch((err: unknown) => alive && setState({ phase: "error", message: failureMessage(err) }));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const { t } = useLingui();

  return (
    <section aria-labelledby="billing-events">
      <h3 id="billing-events" className="text-sm font-medium text-mw-text">
        <Trans>Recent Stripe events</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          What the webhook received and what it did. The first thing to check when someone says they paid and nothing
          happened.
        </Trans>
      </p>
      <div className="mt-3">
        {state.phase === "loading" && <LoadingSkeleton rows={3} />}
        {state.phase === "error" && (
          <ErrorState
            title={t`Could not load events`}
            message={state.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {state.phase === "ready" &&
          (state.data.length === 0 ? (
            <EmptyState
              title={t`No Stripe events yet`}
              description={t`Nothing has been delivered to the webhook on this deployment.`}
            />
          ) : (
            <Table className="bg-card" aria-label={t`Stripe events`}>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Trans>Received</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>Type</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>Organisation</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>Outcome</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.map((row) => (
                  <TableRow key={row.event_id} className="border-b border-mw-border">
                    <TableCell className="whitespace-nowrap text-mw-text-muted">
                      {formatDateTime(row.received_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.event_type}</TableCell>
                    <TableCell>
                      {row.org_name ?? <span className="text-mw-text-muted">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={outcomeVariant(row.outcome)}>
                        <OutcomeLabel outcome={row.outcome} />
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </div>
    </section>
  );
}
