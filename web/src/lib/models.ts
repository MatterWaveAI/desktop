import type { ModelInfo, ModelsResponse } from "../types";
import { apiFetch } from "./api";
import { formatMultiplier, formatUsd } from "./billing";

/** The picker's list, straight from the upstream via the API. */
export function loadModels(): Promise<ModelsResponse> {
  return apiFetch<ModelsResponse>("/api/models");
}

/**
 * Split the picker's list into its three groups, each in the order the API
 * gave it: the deployment's own models first, then partner models (another
 * provider's, offered for testing), then research previews. Both flags are
 * the API's; nothing here reads a model id.
 *
 * A research preview goes in the preview group whatever else it is: the
 * preview group carries the "not for real use" warning, and a model that
 * needs that warning must not lose it for also being a partner's. The split
 * is pure so it is testable without a DOM.
 */
export function groupModels(models: readonly ModelInfo[]): {
  models: ModelInfo[];
  partners: ModelInfo[];
  researchPreviews: ModelInfo[];
} {
  const ordinary: ModelInfo[] = [];
  const partners: ModelInfo[] = [];
  const researchPreviews: ModelInfo[] = [];
  for (const model of models) {
    if (model.research_preview) researchPreviews.push(model);
    else if (model.partner) partners.push(model);
    else ordinary.push(model);
  }
  return { models: ordinary, partners, researchPreviews };
}

/**
 * `32768` -> `32k`, `2000000` -> `2M`; unknown stays unknown.
 *
 * Accepts `undefined` as well as `null`. The type says `number | null`, and
 * our API does always send the key — but a `/api/models` answer that predates
 * the annotation, or any other shape reaching this at runtime, omits it
 * entirely, and `=== null` does not catch that. It rendered as "undefined
 * context" in the picker.
 */
export function formatContextWindow(window: number | null | undefined): string | null {
  if (window === null || window === undefined) return null;
  if (window >= 1_000_000 && window % 1_000_000 === 0) return `${window / 1_000_000}M`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}k`;
  return `${window}`;
}

/**
 * The one-line description beside a model in the picker.
 *
 * Built from what the API actually knows — the research-preview flag, the
 * list price and multiplier, the context window — and nothing else. The ticket asks for
 * "honest" descriptions, and the gateway serves no prose: a hand-written
 * sentence per model would be a guess maintained in the SPA about models the
 * deployment can change under it, which is the opposite of honest. So this
 * states facts, and where the gateway said nothing it says nothing.
 *
 * The research-preview sentence is the one piece of real copy here, and it is
 * the point of the step: a 10-16M parameter research model that a curious new
 * user picks first will produce word salad and bill the account for it. It
 * says "grammatical, not factual" in those terms, because a user who reads
 * that does not file a bug about quality — and does not conclude the product
 * is broken.
 *
 * Deliberately does not mention vision. `supports_vision` is tri-state and
 * `null` is not `false` (see `ModelInfo`), so a one-line description cannot
 * state it honestly; the composer's paperclip asks `vision.ts` at the moment
 * of choosing instead, which is where the answer matters.
 */
export function describeModel(model: ModelInfo): string {
  if (model.research_preview) {
    return "Research demo — grammatical, not factual. Expect fluent nonsense; not for real use.";
  }
  const window = formatContextWindow(model.context_window);
  return [priceOf(model), window === null ? null : `${window} context`].filter((part) => part !== null).join(" · ");
}

/** "$0.50 / $2.00 per 1M · counts 5×": the list price in and out, and how fast it spends an allowance. */
export function priceOf(model: ModelInfo): string {
  return `${formatUsd(model.input_usd_per_m)} / ${formatUsd(model.output_usd_per_m)} per 1M · counts ${formatMultiplier(model.multiplier)}`;
}

/**
 * What unlocks the models the caller's plan does not include, grouped by
 * the plan that has them, in the order the list gave them: the picker's
 * "Pro includes GRT Nano Pro." line. `plan` is null for models no plan
 * the caller can buy includes -- a partner model no plan names is the usual
 * case -- and they are still named, so nothing listed is left unexplained.
 */
export function upgradeGroups(models: readonly ModelInfo[]): { plan: string | null; labels: string[] }[] {
  const groups: { plan: string | null; labels: string[] }[] = [];
  for (const model of models) {
    if (model.included) continue;
    const group = groups.find((g) => g.plan === model.upgrade_to);
    if (group) group.labels.push(model.label);
    else groups.push({ plan: model.upgrade_to, labels: [model.label] });
  }
  return groups;
}

/** A not-included model's option text: its name and the plan that has it. */
export function lockedOptionText(model: ModelInfo): string {
  return model.upgrade_to === null
    ? `${model.label} — not on your plan`
    : `${model.label} — needs ${model.upgrade_to}`;
}
