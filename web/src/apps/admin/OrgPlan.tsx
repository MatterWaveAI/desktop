import { useId, useState } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { DestructiveConfirm } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import { fetchOrgPlan, formatDate, setOrgPlan, type AdminOrg, type AdminPlan, type OrgPlan } from "./adminApi";
import { useLoad, usePlanCatalog } from "./useLoad";

/**
 * A select over the plan catalog, by display name. `blank` adds a first
 * option with that label; choosing it reports "" (no plan chosen).
 */
const NO_PLAN = "__no_plan__";

export function PlanSelect(props: {
  /** The catalog (usePlanCatalog). */
  plans: readonly AdminPlan[];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  blank?: string;
  /** Kept as an option even when the catalog does not list it, so the current value always shows. */
  current?: { code: string; name: string };
  "aria-label"?: string;
  id?: string;
}) {
  const options = props.plans.map((p) => ({ code: p.code, name: p.display_name }));
  if (props.current && !options.some((o) => o.code === props.current!.code)) options.unshift(props.current);
  // The styled select takes no "" value, so the blank option is a sentinel
  // no plan code can collide with, mapped back to "" on the way out.
  const choices = options.map((o) => ({ value: o.code, label: o.name }));
  if (props.blank !== undefined) choices.unshift({ value: NO_PLAN, label: props.blank });
  return (
    <SimpleSelect
      id={props.id}
      aria-label={props["aria-label"]}
      value={props.value === "" ? (props.blank !== undefined ? NO_PLAN : null) : props.value}
      disabled={props.disabled}
      onValueChange={(code) => props.onChange(code === NO_PLAN ? "" : code)}
      options={choices}
    />
  );
}

function statusText(plan: OrgPlan): string {
  if (plan.implicit) return "no subscription (the default)";
  const parts = [String(plan.status ?? "").replaceAll("_", " ")];
  if (plan.trial_end) parts.push(`trial ends ${formatDate(plan.trial_end)}`);
  if (plan.cancel_at_period_end && plan.current_period_end) parts.push(`cancels ${formatDate(plan.current_period_end)}`);
  else if (plan.current_period_end) parts.push(`renews ${formatDate(plan.current_period_end)}`);
  return parts.filter(Boolean).join(", ");
}

/**
 * The expanded org's first line: which plan it is on and how its
 * subscription stands, with the operator's way to move it to another
 * catalog plan (PUT /api/admin/orgs/{id}/plan: no Stripe subscription
 * behind it, written to the plan history and audit with the reason).
 */
export function OrgPlanHeader({ org }: { org: AdminOrg }) {
  const id = useId();
  const [state, reload] = useLoad(() => fetchOrgPlan(org.id), org.id);
  const [latest, setLatest] = useState<OrgPlan | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const catalog = usePlanCatalog();

  const loaded = state.phase === "ready" && typeof state.data?.plan === "string" ? state.data : null;
  const plan = latest ?? loaded;
  const chosen = choice ?? plan?.plan ?? "";
  const chosenName = catalog.find((p) => p.code === chosen)?.display_name ?? chosen;

  async function apply() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await setOrgPlan(org.id, chosen, reason);
      setLatest(next);
      setChoice(null);
      setReason("");
      setSaved(`${org.name} is on ${next.plan_name}.`);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  return (
    <section aria-label={`${org.name} plan`} className="border-b border-mw-border pb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <h4 className="font-medium text-mw-text">Plan</h4>
        {plan ? (
          <>
            <Badge variant="secondary">{plan.plan_name}</Badge>
            <span className="text-mw-text-muted">{statusText(plan)}</span>
          </>
        ) : state.phase === "loading" ? (
          <span className="text-mw-text-muted">Loading…</span>
        ) : (
          <span className="text-mw-danger">
            Could not load the plan.{" "}
            <button type="button" className="underline" onClick={reload}>
              Retry
            </button>
          </span>
        )}
      </div>
      {plan && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen && chosen !== plan.plan) setConfirming(true);
          }}
        >
          <label htmlFor={`${id}-plan`} className="sr-only">
            Plan for {org.name}
          </label>
          <PlanSelect
            id={`${id}-plan`}
            aria-label={`Plan for ${org.name}`}
            plans={catalog}
            value={chosen}
            current={{ code: plan.plan, name: plan.plan_name }}
            disabled={busy}
            onChange={(code) => {
              setChoice(code);
              setSaved(null);
            }}
          />
          <Input
            aria-label="Reason for the plan change"
            placeholder="Reason (kept in the plan history)"
            value={reason}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !chosen || chosen === plan.plan}>
            Set {org.name}'s plan
          </Button>
        </form>
      )}
      {saved && (
        <p role="status" className="mt-1 text-sm text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
      <DestructiveConfirm
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(false);
        }}
        title={`Put ${org.name} on ${chosenName}?`}
        description={`Its limits change on its next request. Nothing is created or changed in Stripe: this is for an invoiced deal or a comp. Recorded in the plan history and audit trail under your name${reason.trim() ? ", with the reason" : ""}.`}
        confirmLabel="Set plan"
        inFlight={busy}
        onConfirm={() => void apply()}
      />
    </section>
  );
}
