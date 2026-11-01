import { useId, useState } from "react";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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

/** A subscription status as Stripe names it, in the reader's language where it is one we know. */
function subscriptionStatus(status: string): string {
  switch (status) {
    case "active":
      return t`active`;
    case "trialing":
      return t`trialing`;
    case "past_due":
      return t`past due`;
    case "canceled":
      return t`cancelled`;
    case "unpaid":
      return t`unpaid`;
    case "incomplete":
      return t`incomplete`;
    case "incomplete_expired":
      return t`incomplete, expired`;
    case "paused":
      return t`paused`;
    default:
      return status.replaceAll("_", " ");
  }
}

function statusText(plan: OrgPlan): string {
  if (plan.implicit) return t`no subscription (the default)`;
  const parts = [subscriptionStatus(String(plan.status ?? ""))];
  if (plan.trial_end) {
    const trialEnd = formatDate(plan.trial_end);
    parts.push(t`trial ends ${trialEnd}`);
  }
  if (plan.current_period_end) {
    const periodEnd = formatDate(plan.current_period_end);
    parts.push(plan.cancel_at_period_end ? t`cancels ${periodEnd}` : t`renews ${periodEnd}`);
  }
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
  const { t } = useLingui();
  const orgName = org.name;

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
      const planName = next.plan_name;
      setSaved(t`${orgName} is on ${planName}.`);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  return (
    <section aria-label={t`${orgName} plan`} className="border-b border-mw-border pb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <h4 className="font-medium text-mw-text">
          <Trans>Plan</Trans>
        </h4>
        {plan ? (
          <>
            <Badge variant="secondary">{plan.plan_name}</Badge>
            <span className="text-mw-text-muted">{statusText(plan)}</span>
          </>
        ) : state.phase === "loading" ? (
          <span className="text-mw-text-muted">
            <Trans>Loading…</Trans>
          </span>
        ) : (
          <span className="text-mw-danger">
            <Trans>Could not load the plan.</Trans>{" "}
            <button type="button" className="underline" onClick={reload}>
              <Trans>Retry</Trans>
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
            <Trans>Plan for {orgName}</Trans>
          </label>
          <PlanSelect
            id={`${id}-plan`}
            aria-label={t`Plan for ${orgName}`}
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
            aria-label={t`Reason for the plan change`}
            placeholder={t`Reason (kept in the plan history)`}
            value={reason}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !chosen || chosen === plan.plan}>
            <Trans>Set {orgName}'s plan</Trans>
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
        title={t`Put ${orgName} on ${chosenName}?`}
        description={
          reason.trim()
            ? t`Its limits change on its next request. Nothing is created or changed in Stripe: this is for an invoiced deal or a comp. Recorded in the plan history and audit trail under your name, with the reason.`
            : t`Its limits change on its next request. Nothing is created or changed in Stripe: this is for an invoiced deal or a comp. Recorded in the plan history and audit trail under your name.`
        }
        confirmLabel={t`Set plan`}
        inFlight={busy}
        onConfirm={() => void apply()}
      />
    </section>
  );
}
