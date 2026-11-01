import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import type { AdminPlan, PlanEdit, PlanLimits } from "./adminApi";

/**
 * The plan editor's diff: field by field, what a save would change. Its own
 * module because the tab's file is a component file and this is a pure
 * function the tests call directly. It runs at render time, so its words
 * are the active catalogue's.
 */

/** The counts an operator edits, in the order the form shows them; render `label` with `i18n._`. */
export const COUNT_FIELDS: Array<{ key: keyof PlanLimits; label: MessageDescriptor }> = [
  { key: "tpm_limit", label: msg`Tokens per minute` },
  { key: "rpm_limit", label: msg`Requests per minute` },
  { key: "max_parallel_requests", label: msg`Parallel requests` },
  { key: "max_conversations", label: msg`Conversations` },
  { key: "max_seats", label: msg`Seats` },
];

export interface Change {
  field: string;
  from: string;
  to: string;
}

/**
 * What a null allow-list means since partner models (another provider's)
 * became opt-in: every model the gateway serves except those, which a plan
 * gets only by naming them.
 */
export const EVERY_GRT_MODEL = msg`every GRT model; partner models only when listed`;

/** What a null per-seat allowance means: the plan is not sold per seat. */
export const SOLD_FLAT = msg`not sold per seat`;

function show(value: unknown): string {
  if (value === null) return t`unlimited`;
  if (Array.isArray(value)) return value.length === 0 ? t`house model only` : value.join(", ");
  if (typeof value === "boolean") return value ? t`on` : t`off`;
  return String(value);
}

/** A trial length as the diff says it: "none" for 0, else the days. */
export function trialLabel(days: number): string {
  if (days === 0) return t`none`;
  return plural(days, { one: "# day", other: "# days" });
}

/** Field by field, what Save would change: the preview the operator reads first. */
export function diffPlan(plan: AdminPlan, edit: PlanEdit): Change[] {
  const changes: Change[] = [];
  if (edit.display_name !== plan.display_name) {
    changes.push({ field: t`Display name`, from: plan.display_name, to: edit.display_name });
  }
  if (edit.is_public !== plan.is_public) {
    changes.push({ field: t`Listed`, from: show(plan.is_public), to: show(edit.is_public) });
  }
  const trialBefore = plan.trial_days ?? 0;
  if (edit.trial_days !== undefined && edit.trial_days !== trialBefore) {
    changes.push({ field: t`Free trial`, from: trialLabel(trialBefore), to: trialLabel(edit.trial_days) });
  }
  // The form's order: the allowance, the counts, then the models.
  const labels: Record<string, string> = {
    included_tokens: t`Included tokens`,
    included_tokens_per_seat: t`Tokens per seat`,
    overage_enabled: t`Overage`,
    budget_duration: t`Budget window`,
    ...Object.fromEntries(COUNT_FIELDS.map((f) => [f.key, i18n._(f.label)])),
    allowed_models: t`Allowed models`,
  };
  for (const key of Object.keys(labels)) {
    const before = plan.limits[key as keyof PlanLimits];
    const after = edit.limits[key as keyof PlanLimits];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      // A null count is "unlimited"; a null model list is not, and nor is a
      // null per-seat allowance, which is a plan sold flat.
      const say = (value: unknown) => {
        if (value !== null) return show(value);
        if (key === "allowed_models") return i18n._(EVERY_GRT_MODEL);
        if (key === "included_tokens_per_seat") return i18n._(SOLD_FLAT);
        return show(value);
      };
      changes.push({ field: labels[key], from: say(before), to: say(after) });
    }
  }
  for (const name of Object.keys(edit.limits.features)) {
    if (edit.limits.features[name] !== plan.limits.features[name]) {
      changes.push({
        field: t`Feature ${name}`,
        from: show(plan.limits.features[name]),
        to: show(edit.limits.features[name]),
      });
    }
  }
  return changes;
}
