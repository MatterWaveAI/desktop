import { useId, useState, type FormEvent } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { ApiError } from "../../lib/api";
import { formatMicros, type ModelPrice } from "../../lib/billing";
import { DestructiveConfirm, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  fetchPlans,
  formatCents,
  overLimitOrgs,
  savePlan,
  savePlanFeatures,
  type AdminPlan,
  type FeatureInfo,
  type OverLimitOrg,
  type PlanEdit,
  type PlanLimits,
  MAX_TRIAL_DAYS,
} from "./adminApi";
import { COUNT_FIELDS, diffPlan } from "./planDiff";
import { useLoad } from "./useLoad";

/**
 * The plan catalog editor: one form per plan, every limit in FREE_LIMITS'
 * shape, the display name and whether the plan is listed. Prices are shown
 * and not editable -- Stripe owns them, and the billing tab is where their
 * ids are copied in.
 *
 * Nothing is sent until the operator has seen the diff: the "Changes"
 * list under each form is computed from the form against the loaded row
 * and is what Save submits. A save the API refuses because existing orgs
 * would end up over a cap comes back with those orgs named; the operator
 * then saves again with force, which the API audits as forced.
 *
 * Features are switches rather than form fields, in their own section under
 * the form: each one saves on its own
 * through the features route (audited as `plan.features`), and turning one
 * off on a plan that has organisations on it asks first, naming how many.
 */
export function PlansTab() {
  const [state, reload] = useLoad(fetchPlans, "plans");
  if (state.phase === "loading") return <LoadingSkeleton rows={6} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load plans" message={state.message} onRetry={reload} />;
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-mw-text-muted">
        Every save takes effect in every API process within the catalog's refresh window and is recorded in
        the audit trail with what changed. A blank count is unlimited.
      </p>
      {state.data.plans.map((plan) => (
        <PlanForm
          key={plan.code}
          plan={plan}
          models={state.data.models}
          houseModel={state.data.houseModel}
          features={state.data.features}
          onSaved={reload}
        />
      ))}
    </div>
  );
}

const BUDGET_DURATIONS = ["1d", "7d", "1mo"];

/** What the form holds: strings for the inputs, with the shape made on submit. */
interface Draft {
  display_name: string;
  is_public: boolean;
  /** Days; blank or 0 is no trial. */
  trial_days: string;
  included_tokens: string;
  included_tokens_per_seat: string;
  overage_enabled: boolean;
  budget_duration: string;
  counts: Record<string, string>;
  every_model: boolean;
  /** The ids named, in the row's own order, so an untouched list is no change. */
  allowed_models: string[];
}

function draftOf(plan: AdminPlan): Draft {
  const counts: Record<string, string> = {};
  for (const field of COUNT_FIELDS) {
    const value = plan.limits[field.key];
    counts[field.key] = value === null ? "" : String(value);
  }
  return {
    display_name: plan.display_name,
    is_public: plan.is_public,
    trial_days: String(plan.trial_days ?? 0),
    included_tokens: String(plan.limits.included_tokens),
    included_tokens_per_seat:
      plan.limits.included_tokens_per_seat === null ? "" : String(plan.limits.included_tokens_per_seat),
    overage_enabled: plan.limits.overage_enabled,
    budget_duration: plan.limits.budget_duration,
    counts,
    every_model: plan.limits.allowed_models === null,
    allowed_models: [...(plan.limits.allowed_models ?? [])],
  };
}

function countOf(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  return Number(text);
}

/**
 * The edit the draft describes, or null while a field is not a number. The
 * features are the plan's as loaded: the switches save them on their own,
 * so the form never sends a stale copy back.
 */
function editOf(draft: Draft, plan: AdminPlan): PlanEdit | null {
  // The allowance is a count but never "unlimited": blank is not a value.
  const included = countOf(draft.included_tokens);
  if (included === undefined || included === null) return null;
  // Blank is a plan sold flat; a number sells it per seat.
  const perSeat = countOf(draft.included_tokens_per_seat);
  if (perSeat === undefined) return null;
  // Blank is no trial, the same as 0; past Stripe's ceiling is not a value.
  const trial = countOf(draft.trial_days);
  if (trial === undefined || (trial !== null && trial > MAX_TRIAL_DAYS)) return null;
  const limits: PlanLimits = {
    included_tokens: included,
    included_tokens_per_seat: perSeat,
    overage_enabled: draft.overage_enabled,
    budget_duration: draft.budget_duration,
    tpm_limit: null,
    rpm_limit: null,
    max_parallel_requests: null,
    max_conversations: null,
    max_seats: null,
    allowed_models: draft.every_model ? null : [...draft.allowed_models],
    features: { ...plan.limits.features },
  };
  for (const field of COUNT_FIELDS) {
    const value = countOf(draft.counts[field.key]);
    if (value === undefined) return null;
    (limits as unknown as Record<string, unknown>)[field.key] = value;
  }
  return {
    display_name: draft.display_name.trim(),
    is_public: draft.is_public,
    limits,
    trial_days: trial ?? 0,
  };
}

function PlanForm({
  plan,
  models,
  houseModel,
  features,
  onSaved,
}: {
  plan: AdminPlan;
  models: readonly ModelPrice[];
  houseModel: string | null;
  features: readonly FeatureInfo[];
  onSaved: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(plan));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The orgs the last save would have stranded; set by a 409, cleared by a
  // change or a successful save. While set, Save becomes "Save anyway".
  const [stranded, setStranded] = useState<OverLimitOrg[] | null>(null);

  const edit = editOf(draft, plan);
  const changes = edit ? diffPlan(plan, edit) : [];
  const dirty = changes.length > 0 && edit !== null && edit.display_name !== "";

  function update(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setStranded(null);
    setSaved(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      await savePlan(plan.code, edit, stranded !== null);
      setSaved(`${edit.display_name} saved: ${changes.length} change${changes.length === 1 ? "" : "s"}.`);
      setStranded(null);
      onSaved();
    } catch (err: unknown) {
      const orgs = err instanceof ApiError && err.status === 409 ? overLimitOrgs(err.body) : null;
      if (orgs) setStranded(orgs);
      else setError(failureMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const field = (name: string) => `${id}-${name}`;
  const perSeat = plan.limits.included_tokens_per_seat !== null;
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <form onSubmit={save} aria-label={`${plan.display_name} plan`} className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-mw-text">
            {plan.display_name} <code className="ml-1 font-mono text-xs text-mw-text-muted">{plan.code}</code>
          </h3>
          {!plan.is_public && <Badge variant="outline">unlisted</Badge>}
          <span className="ml-auto text-xs text-mw-text-muted">
            {formatCents(plan.price_cents_monthly)}/month, {formatCents(plan.price_cents_annual)}/year
            {perSeat && " per seat"}
            {plan.limits.overage_enabled &&
              `, default overage cap ${formatMicros(plan.default_overage_cap_micros)}${perSeat ? " per seat" : ""}`}{" "}
            (prices are Stripe's)
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={field("name")} className="flex flex-col gap-1 text-sm">
            Display name
            <Input
              id={field("name")}
              value={draft.display_name}
              maxLength={80}
              disabled={saving}
              onChange={(e) => update({ display_name: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={draft.is_public}
              disabled={saving}
              onChange={(e) => update({ is_public: e.target.checked })}
            />
            Listed on /pricing
          </label>
          <label htmlFor={field("trial")} className="flex flex-col gap-1 text-sm">
            Free trial (days; 0: none)
            <Input
              id={field("trial")}
              inputMode="numeric"
              value={draft.trial_days}
              disabled={saving}
              onChange={(e) => update({ trial_days: e.target.value })}
            />
            <span className="text-xs text-mw-text-muted">
              Offered at checkout to an organisation that has never had a trial or a subscription, up to{" "}
              {MAX_TRIAL_DAYS} days. The card is still taken; the first charge is when the trial ends.
            </span>
          </label>
          <label htmlFor={field("included")} className="flex flex-col gap-1 text-sm">
            Included tokens (weighted, per window)
            <Input
              id={field("included")}
              inputMode="numeric"
              value={draft.included_tokens}
              disabled={saving}
              onChange={(e) => update({ included_tokens: e.target.value })}
            />
          </label>
          <label htmlFor={field("per-seat")} className="flex flex-col gap-1 text-sm">
            Tokens per seat (weighted, pooled; blank: not sold per seat)
            <Input
              id={field("per-seat")}
              inputMode="numeric"
              placeholder="not sold per seat"
              value={draft.included_tokens_per_seat}
              disabled={saving}
              onChange={(e) => update({ included_tokens_per_seat: e.target.value })}
            />
            <span className="text-xs text-mw-text-muted">
              A number sells the plan per seat: the price and the default overage cap are per seat, each seat adds
              this many tokens to the included ones, and the Stripe quantity follows the members.
            </span>
          </label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={draft.overage_enabled}
              disabled={saving}
              onChange={(e) => update({ overage_enabled: e.target.checked })}
            />
            Overage past the allowance, at list price
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={field("duration")}>Budget window</label>
            <SimpleSelect
              id={field("duration")}
              value={draft.budget_duration}
              disabled={saving}
              onValueChange={(budget_duration) => update({ budget_duration })}
              options={BUDGET_DURATIONS.map((d) => ({ value: d, label: d }))}
              className="w-full"
            />
          </div>
          {COUNT_FIELDS.map((count) => (
            <label key={count.key} htmlFor={field(count.key)} className="flex flex-col gap-1 text-sm">
              {count.label}
              <Input
                id={field(count.key)}
                inputMode="numeric"
                placeholder="unlimited"
                value={draft.counts[count.key]}
                disabled={saving}
                onChange={(e) => update({ counts: { ...draft.counts, [count.key]: e.target.value } })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.every_model}
              disabled={saving}
              onChange={(e) => update({ every_model: e.target.checked })}
            />
            Every GRT model the gateway serves (partner models only when listed)
          </label>
          {!draft.every_model && (
            <ModelChecklist
              models={models}
              houseModel={houseModel}
              chosen={draft.allowed_models}
              disabled={saving}
              onChange={(allowed_models) => update({ allowed_models })}
            />
          )}
        </div>

        <section aria-label={`Changes to ${plan.display_name}`} className="text-sm">
          <h4 className="text-xs font-medium uppercase tracking-wide text-mw-text-muted">Changes</h4>
          {edit === null ? (
            <p role="alert" className="mt-1 text-mw-danger">
              Included tokens is a whole number; tokens per seat is a whole number, or blank for a plan not sold per
              seat; the free trial is a whole number of days up to {MAX_TRIAL_DAYS}; every other count is a whole
              number, or blank for unlimited.
            </p>
          ) : changes.length === 0 ? (
            <p className="mt-1 text-mw-text-muted">Nothing changed.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {changes.map((change) => (
                <li key={change.field}>
                  <span className="font-medium">{change.field}:</span> {change.from} → {change.to}
                </li>
              ))}
            </ul>
          )}
        </section>

        {stranded && (
          <Alert
            role="alert"
            variant="danger"
            title={`This change would put ${stranded.length} organisation${stranded.length === 1 ? "" : "s"} over a limit. They go read-only over it on their next request; nothing is deleted.`}
          >
            <ul className="list-disc pl-5">
              {stranded.map((org) => (
                <li key={org.org_id}>
                  {org.org_name}: {org.conversations} conversations, {org.seats} seats (over {org.over.join(", ")})
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {error && (
          <Alert role="alert" variant="danger">
            {error}
          </Alert>
        )}
        {saved && (
          <p role="status" className="text-sm text-mw-text-muted">
            {saved}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            variant={stranded ? "destructive" : "outline"}
            disabled={saving || !dirty}
          >
            {stranded ? `Save ${plan.display_name} anyway` : `Save ${plan.display_name}`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving || changes.length === 0}
            onClick={() => {
              setDraft(draftOf(plan));
              setStranded(null);
              setError(null);
            }}
          >
            Discard
          </Button>
        </div>
      </form>
      {/* Outside the form on purpose: the switches save as they move, and the
          form's Changes and Save are for the form's own fields alone. */}
      <PlanFeatures plan={plan} catalog={features} disabled={saving} onSaved={onSaved} />
    </div>
  );
}

/**
 * The models a plan names beyond the house model, as a checklist of the
 * price list: the API refuses any id it does not price, so a typed id could
 * only ever be a typo or a model that would bill at the dear default. An id
 * the row already holds that the price list no longer has stays listed,
 * checked and marked, so the operator sees why a save is refused and can
 * clear it.
 */
function ModelChecklist(props: {
  models: readonly ModelPrice[];
  /** Allowed on every plan by the API whatever the list says: shown on and locked. */
  houseModel: string | null;
  chosen: readonly string[];
  disabled: boolean;
  onChange: (chosen: string[]) => void;
}) {
  const priced = new Set(props.models.map((m) => m.id));
  const unpriced = props.chosen.filter((id) => !priced.has(id));
  // Unticking keeps the rest in their order; ticking adds at the end, so a
  // list nobody touched compares equal to the row and shows no change.
  const toggle = (id: string, on: boolean) =>
    props.onChange(on ? [...props.chosen, id] : props.chosen.filter((m) => m !== id));
  return (
    <fieldset className="flex flex-col gap-1 text-sm sm:col-span-2">
      <legend className="mb-1">Models beyond the house model; a partner model only if ticked here</legend>
      {props.models.map((model) => {
        const house = model.id === props.houseModel;
        return (
          <label key={model.id} className="flex items-center gap-2" data-plan-model={model.id}>
            <input
              type="checkbox"
              checked={house || props.chosen.includes(model.id)}
              disabled={house || props.disabled}
              onChange={(e) => {
                if (!house) toggle(model.id, e.target.checked);
              }}
            />
            {model.label}
            <code className="font-mono text-xs text-mw-text-muted">{model.id}</code>
            {house && <Badge variant="secondary">house model, on every plan</Badge>}
            {model.partner && <Badge variant="outline">partner</Badge>}
          </label>
        );
      })}
      {unpriced.map((id) => (
        <label key={id} className="flex items-center gap-2 text-mw-danger" data-plan-model={id}>
          <input type="checkbox" checked disabled={props.disabled} onChange={() => toggle(id, false)} />
          <code className="font-mono text-xs">{id}</code>
          not on the price list: untick it to save
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The plan's feature switches. Each saves at once, on its own, and the list
 * reloads from the API, so what a switch shows is the row. Turning one off
 * on a plan with organisations on it goes through the confirmation dialog
 * with their count: every one of them loses it on its next request, except
 * an org whose own override keeps it (Organisations, Manage).
 */
function PlanFeatures(props: {
  plan: AdminPlan;
  catalog: readonly FeatureInfo[];
  disabled: boolean;
  onSaved: () => void;
}) {
  const { plan } = props;
  const id = useId();
  const [pending, setPending] = useState<FeatureInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The API's list, then any feature the row holds that the list does not describe, by name.
  const known: FeatureInfo[] = [
    ...props.catalog,
    ...Object.keys(plan.limits.features)
      .filter((name) => !props.catalog.some((f) => f.name === name))
      .map((name) => ({ name, label: name, description: "" })),
  ];
  const orgs = plan.org_count ?? 0;
  const orgsText = `${orgs} organisation${orgs === 1 ? "" : "s"}`;

  async function apply(feature: FeatureInfo, on: boolean) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await savePlanFeatures(plan.code, { [feature.name]: on });
      setSaved(`${feature.label} is ${on ? "on" : "off"} for ${plan.display_name}.`);
      props.onSaved();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  function toggle(feature: FeatureInfo, on: boolean) {
    if (!on && orgs > 0) {
      setError(null);
      setSaved(null);
      setPending(feature);
      return;
    }
    void apply(feature, on);
  }

  return (
    <section aria-label={`${plan.display_name} features`} className="border-t border-mw-border pt-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-mw-text-muted">Features</h4>
        <Badge variant="outline">Saved as you switch</Badge>
      </div>
      <p className="mt-1 text-xs text-mw-text-muted">
        Not part of Save above: each switch saves on its own and reaches the {orgsText} on this plan on their next
        request. An organisation's own override wins over the plan.
      </p>
      <ul className="mt-2 space-y-2">
        {known.map((feature) => {
          const on = Boolean(plan.limits.features[feature.name]);
          const switchId = `${id}-${feature.name}`;
          return (
            <li key={feature.name} data-plan-feature={feature.name}>
              <div className="flex items-center gap-2">
                <input
                  id={switchId}
                  type="checkbox"
                  role="switch"
                  aria-checked={on}
                  aria-busy={busy || undefined}
                  checked={on}
                  disabled={props.disabled || busy}
                  onChange={(event) => toggle(feature, event.target.checked)}
                  className="size-4"
                />
                <label htmlFor={switchId} className="font-medium text-mw-text">
                  {feature.label}
                </label>
                <code className="font-mono text-xs text-mw-text-muted">{feature.name}</code>
              </div>
              {feature.description && <p className="ml-6 text-xs text-mw-text-muted">{feature.description}</p>}
            </li>
          );
        })}
      </ul>
      {saved && (
        <p role="status" className="mt-1 text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-mw-danger">
          {error}
        </p>
      )}
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={pending ? `Turn off ${pending.label} for ${plan.display_name}?` : "Turn this feature off?"}
        description={`The ${orgsText} on ${plan.display_name} lose it on their next request, except any whose own override keeps it. The change is recorded in the audit trail under your name.`}
        confirmLabel="Turn off"
        inFlight={busy}
        onConfirm={() => {
          if (pending) void apply(pending, false);
        }}
      />
    </section>
  );
}
