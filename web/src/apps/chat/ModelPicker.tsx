import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ModelInfo } from "../../types";
import { apiFetch } from "../../lib/api";
import { PARTNER_MODELS_HEADING } from "../../lib/billing";
import {
  describeModel,
  groupModels,
  loadModels,
  lockedOptionText,
  upgradeGroups,
} from "../../lib/models";

/** The composer's model picker.

 * The list is what the deployment actually serves (`GET /api/models`, proxied
 * from the gateway — never a hard-coded set). The deployment's own models
 * come first, each with its list price; partner models (another provider's,
 * offered for testing) sit in their own group after them; and anything the
 * deployment marks as a research preview is apart again, under its warning,
 * so it is never a plain choice. Both flags are the API's. Selecting a
 * model persists it as the conversation's default once a conversation exists;
 * "Default" sends no model and lets the server decide.
 *
 * Models are named by their label from the price list, never by a name
 * written here. A model the plan does not include is listed but disabled,
 * with the plan that has it, and the line under the control names that plan
 * and links to /pricing the way UpgradePrompt does for any other gated
 * feature: hiding it would leave a person not knowing it exists, and
 * offering it would only earn a 402.
 */
export function ModelPicker({
  conversationId,
  value,
  onChange,
  onModelsLoaded,
}: {
  conversationId: string | null;
  value: string | null;
  onChange: (model: string | null) => void;
  /**
   * The whole list, once. The composer's attachment control has
   * to know whether the selected model accepts images BEFORE a file is
   * chosen, and `supports_vision` is already on these entries. Reported up
   * rather than fetched again so the two never disagree about what the
   * gateway said, and so `/api/models` is hit once per thread.
   */
  /** The list, and the id the server falls back to when nothing is picked. */
  onModelsLoaded?: (models: readonly ModelInfo[], defaultModel: string | null) => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [partners, setPartners] = useState<ModelInfo[]>([]);
  const [previews, setPreviews] = useState<ModelInfo[]>([]);
  const [locked, setLocked] = useState<{ plan: string | null; labels: string[] }[]>([]);
  // What the server will use when nothing is selected. The
  // response has always carried it; the picker used to show a bare "Default"
  // and leave the user guessing which model that was.
  const [serverDefault, setServerDefault] = useState<string | null>(null);

  // Held in a ref so adding the callback to the deps below cannot re-run the
  // fetch when a parent passes a fresh closure on every render.
  const notifyRef = useRef(onModelsLoaded);
  useEffect(() => {
    notifyRef.current = onModelsLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    loadModels()
      .then((response) => {
        if (cancelled) return;
        const groups = groupModels(response.data);
        setModels(groups.models);
        setPartners(groups.partners);
        setPreviews(groups.researchPreviews);
        setLocked(upgradeGroups(response.data));
        // Both groups: a research preview is still a model someone can pick,
        // and whether it reads images is the same question.
        notifyRef.current?.(response.data, response.default_model ?? null);
        setServerDefault(response.default_model ?? null);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The description for whatever is selected. A research preview's warning is
  // the case this exists for: it must be readable while the model is in force,
  // not only in the instant the option was open.
  const all = [...(models ?? []), ...partners, ...previews];
  const selected = value === null ? null : all.find((m) => m.id === value);
  // The default by its label when the list names it; the id otherwise.
  const defaultName =
    serverDefault === null ? null : (all.find((m) => m.id === serverDefault)?.label ?? serverDefault);
  const selectedDescription =
    selected === undefined || selected === null
      ? defaultName === null
        ? "Using the default model."
        : `Using ${defaultName}, the default model.`
      : describeModel(selected);

  async function select(model: string | null) {
    onChange(model);
    if (conversationId === null) return;
    try {
      await apiFetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        json: { default_model: model },
      });
    } catch {
      // The selection still applies to the next send; persisting it is a
      // convenience, not a precondition.
    }
  }

  return (
    /* The header row's own width and padding belong to the row (the
       instructions affordance sits beside this one), not to each control in it. */
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-none">
      <label className="flex min-w-0 items-center gap-2 text-xs text-mw-text-muted">
        <span className="sr-only sm:not-sr-only">Model</span>
        {/* On a phone the box takes the row's spare width rather than a
            fixed one: capped at 9rem it clipped the default's own name to
            "Default (GRT Nan…", which is the one word it exists to show. */}
        <select
          className="h-8 w-full min-w-0 rounded border border-mw-border bg-transparent px-2 text-xs sm:w-auto pointer-coarse:h-11"
          value={value ?? ""}
          onChange={(event) => void select(event.target.value === "" ? null : event.target.value)}
          disabled={models === null}
          aria-label="Model"
          // Points at the line below, so the description is announced with
          // the control rather than being visual-only.
          aria-describedby="mw-model-description"
        >
          {/* Names the model rather than saying only "Default": a user cannot
              judge an answer, or a cost, against a model they cannot name. */}
          <option value="">
            {defaultName === null ? "Default" : `Default (${defaultName})`}
          </option>
          {models?.map(optionFor)}
          {partners.length > 0 && (
            // Another provider's models: offered for testing and usable only
            // on a plan that names them, so never mixed into the list above.
            <optgroup label={PARTNER_MODELS_HEADING}>{partners.map(optionFor)}</optgroup>
          )}
          {previews.length > 0 && (
            // Research previews stay in their own group, never in the main
            // list and never the default — the default option above is the
            // server's, and a research preview is never the default.
            <optgroup label="Research preview — not for real use">
              {previews.map((model) =>
                model.included ? (
                  <option key={model.id} value={model.id}>
                    {model.label} — research demo, grammatical not factual
                  </option>
                ) : (
                  <option key={model.id} value={model.id} disabled>
                    {lockedOptionText(model)}
                  </option>
                ),
              )}
            </optgroup>
          )}
        </select>
      </label>
      {/* The selected model's line, in full. A <select> option is one line of
          plain text and truncates in most browsers, so the honest description
          needs somewhere it can actually be read. */}
      {/* Always drawn, beside the upgrade note and wrapping under it when
          the two do not fit on one line: cut to one line each they read
          "this deployme…" and "Pro Plus include…", which is no hint at all.
          The row keeps its first line's height from before the list loads,
          so the transcript does not jump when the list lands. On a phone the
          text stays for the screen reader (the box points at it) and is not
          drawn, leaving the header one row. */}
      <div className="hidden min-h-4 min-w-0 flex-wrap items-baseline gap-x-2 sm:flex">
        <p id="mw-model-description" className="min-w-0 text-xs text-mw-text-muted">
          {selectedDescription}
        </p>
        {locked.length > 0 && (
          <p data-model-upgrade className="min-w-0 text-xs text-mw-text-muted">
            {locked
              .map((group) =>
                group.plan === null
                  ? `${group.labels.join(", ")}: not on your plan.`
                  : `${group.plan} includes ${group.labels.join(", ")}.`,
              )
              .join(" ")}{" "}
            <Link to="/pricing" className="underline underline-offset-2">
              See plans
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** One ordinary entry: its label and price, or disabled with the plan that has it. */
function optionFor(model: ModelInfo) {
  if (!model.included) {
    return (
      <option key={model.id} value={model.id} disabled>
        {lockedOptionText(model)}
      </option>
    );
  }
  // The label alone. The price and window are the description line's, in
  // full: a <select> option is one line of plain text that most browsers
  // truncate, and "$0.10 / $0.40 per 1M · counts 1×" there read as jargon.
  return (
    <option key={model.id} value={model.id}>
      {model.label}
    </option>
  );
}
