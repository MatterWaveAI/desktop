import { useCallback, useEffect, useId, useState } from "react";
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

  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load billing" message={state.message} onRetry={reload} />;
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
  const checks = [
    {
      ok: data.has_api_key,
      label: "Stripe API key",
      fix: "Set MW_STRIPE_API_KEY to a restricted key (rk_...).",
    },
    {
      ok: data.has_webhook_secret,
      label: "Webhook signing secret",
      fix: "Set MW_STRIPE_WEBHOOK_SECRET. Without it every webhook is refused, by design.",
    },
    {
      ok: data.plans_without_prices.length === 0,
      label: "Every paid plan has a Stripe price",
      fix: `No price id on: ${data.plans_without_prices.join(", ")}. Run scripts/stripe_setup.py, or paste the ids below.`,
    },
    {
      ok: data.upstream_enforcement,
      label: "Upstream limit enforcement",
      fix: "MW_LITELLM_VIRTUAL_KEYS is off, so the app gate is the only thing enforcing plan limits. Turn it on before taking payments.",
    },
  ];
  return (
    <section aria-labelledby="billing-readiness">
      <h3 id="billing-readiness" className="text-sm font-medium text-mw-text">
        Readiness
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        {data.configured
          ? "Stripe is configured. Checkout and the webhook are live."
          : "Billing is off. Checkout and the portal answer 503 until both the key and the webhook secret are set."}
      </p>
      <ul className="mt-3 space-y-2">
        {checks.map((check) => (
          <li key={check.label} className="flex items-start gap-2 text-sm">
            <Badge variant={check.ok ? "positive" : "destructive"} className="mt-0.5 shrink-0">
              <StatusDot tone={check.ok ? "positive" : "danger"} />
              {check.ok ? "ok" : "missing"}
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
  return (
    <section aria-labelledby="billing-plans">
      <h3 id="billing-plans" className="text-sm font-medium text-mw-text">
        Plans and Stripe prices
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        The catalog is the source of truth for names and amounts. These are the Stripe price ids
        Checkout sells. Prices are immutable once someone is subscribed, so changing an amount means
        a new price in Stripe, not an edit here.
      </p>
      <p className="mt-1 mb-3 text-sm text-mw-text-muted">
        The ids come from the Stripe Dashboard, under Products: open the product and copy the id of
        each price (it starts with <code className="font-mono text-xs">price_</code>).
      </p>
      <Table className="bg-card" aria-label="Plans">
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead>Monthly</TableHead>
            <TableHead>Annual</TableHead>
            <TableHead>Stripe price ids</TableHead>
            <TableHead>Status</TableHead>
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
          <span className="text-xs text-mw-text-muted">Not sold through Checkout.</span>
        ) : (
          <div className="space-y-1">
            <label htmlFor={monthlyId} className="block text-xs text-mw-text-muted">
              Monthly price id
            </label>
            <Input
              id={monthlyId}
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="price_…"
              aria-label={`${plan.name} monthly Stripe price id`}
              className="font-mono text-xs"
            />
            <label htmlFor={annualId} className="block text-xs text-mw-text-muted">
              Annual price id
            </label>
            <Input
              id={annualId}
              value={annual}
              onChange={(e) => setAnnual(e.target.value)}
              placeholder="price_…"
              aria-label={`${plan.name} annual Stripe price id`}
              className="font-mono text-xs"
            />
            {dirty && (
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
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
          <Badge variant="outline">default</Badge>
        ) : plan.sellable ? (
          <Badge variant="positive">sellable</Badge>
        ) : (
          <Badge variant="destructive">no price</Badge>
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
        Entitlement reconciliation
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        Checks every subscribed organisation against the model gateway and repairs any mismatch. Runs
        hourly on its own; this runs it now.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          {running ? "Reconciling…" : "Reconcile now"}
        </Button>
        {report && (
          <span className="text-sm text-mw-text-muted">
            Checked {report.checked}, repaired {report.repaired}
            {report.over_entitled > 0 && (
              <span className="ml-2 font-medium text-mw-danger">
                {report.over_entitled} over-entitled (spending)
              </span>
            )}
            {report.under_entitled > 0 && (
              <span className="ml-2 font-medium text-mw-text">
                {report.under_entitled} under-entitled (churn risk)
              </span>
            )}
          </span>
        )}
      </div>
      {error && (
        <Alert role="alert" variant="danger" className="mt-2">
          {error}
        </Alert>
      )}
    </section>
  );
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

  return (
    <section aria-labelledby="billing-events">
      <h3 id="billing-events" className="text-sm font-medium text-mw-text">
        Recent Stripe events
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        What the webhook received and what it did. The first thing to check when someone says they
        paid and nothing happened.
      </p>
      <div className="mt-3">
        {state.phase === "loading" && <LoadingSkeleton rows={3} />}
        {state.phase === "error" && (
          <ErrorState
            title="Could not load events"
            message={state.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {state.phase === "ready" &&
          (state.data.length === 0 ? (
            <EmptyState
              title="No Stripe events yet"
              description="Nothing has been delivered to the webhook on this deployment."
            />
          ) : (
            <Table className="bg-card" aria-label="Stripe events">
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Organisation</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.map((row) => (
                  <TableRow key={row.event_id} className="border-b border-mw-border">
                    <TableCell className="whitespace-nowrap text-mw-text-muted">
                      {new Date(row.received_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.event_type}</TableCell>
                    <TableCell>
                      {row.org_name ?? <span className="text-mw-text-muted">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={outcomeVariant(row.outcome)}>{row.outcome}</Badge>
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
