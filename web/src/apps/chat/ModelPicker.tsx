import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ChevronDownIcon } from "lucide-react";
import { StatusDot } from "../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from "../../components/ui/select";
import type { ModelInfo } from "../../types";
import { apiFetch } from "../../lib/api";
import { PARTNER_MODELS_HEADING } from "../../lib/billing";
import { describeModel, groupModels, loadModels, upgradeGroups } from "../../lib/models";

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
 * with the plan that has it, and a note under the list names that plan
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
  const defaultEntry = serverDefault === null ? undefined : all.find((m) => m.id === serverDefault);
  const defaultName = serverDefault === null ? null : (defaultEntry?.label ?? serverDefault);
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

  // What the pill reads: the model in force, by its label. "Default" is a
  // word in the list, not on the pill -- the pill answers "which model".
  const pillLabel =
    selected !== undefined && selected !== null
      ? selected.label
      : (defaultName ?? (models === null ? "Model" : "Default"));
  // A research preview in force is the one choice the pill must not call
  // healthy: amber, and the warning is its description.
  const dotTone = models === null ? "neutral" : selected?.research_preview ? "warning" : "positive";

  const upgradeNote =
    locked.length > 0 ? (
      <p
        data-model-upgrade=""
        className="mx-1 mt-1 border-t border-mw-border px-1.5 pt-2 pb-1 text-xs text-mw-text-muted"
      >
        {locked
          .map((group) =>
            group.plan === null
              ? `${group.labels.join(", ")}: not on your plan.`
              : `${group.plan} includes ${group.labels.join(", ")}.`,
          )
          .join(" ")}{" "}
        <Link to="/pricing" className="text-mw-link underline underline-offset-2 hover:text-mw-link-hover">
          See plans
        </Link>
      </p>
    ) : null;

  return (
    <Select
      value={value ?? DEFAULT_VALUE}
      onValueChange={(next) => {
        if (next === null) return;
        void select(next === DEFAULT_VALUE ? null : String(next));
      }}
      disabled={models === null}
    >
      {/* One pill: the status dot, the model's name, the chevron. The
          price, the window and a research preview's warning are each
          option's second line in the list, where they can be read in full,
          and the selected one's is the control's description, so a screen
          reader hears which model "Default" really is. */}
      <SelectPrimitive.Trigger
        aria-label="Model"
        aria-describedby="mw-model-description"
        data-mw-model-picker=""
        className="inline-flex h-10 max-w-44 min-w-0 shrink items-center gap-2 rounded-full border border-mw-border-emphasis bg-mw-surface-raised pr-3 pl-3.5 text-sm text-mw-text transition-colors outline-none select-none hover:bg-mw-surface-hover focus-visible:ring-2 focus-visible:ring-mw-focus focus-visible:ring-offset-2 focus-visible:ring-offset-mw-surface disabled:cursor-progress data-popup-open:bg-mw-surface-hover sm:max-w-64 pointer-coarse:h-11"
      >
        <StatusDot tone={dotTone} />
        <span className="min-w-0 truncate" data-mw-model-label="">
          {pillLabel}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-mw-text-muted" />
      </SelectPrimitive.Trigger>
      <span id="mw-model-description" className="sr-only">
        {selectedDescription}
      </span>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        sideOffset={6}
        aria-label="Models"
        className="w-[min(22rem,calc(100vw-2rem))] max-w-none p-1"
        footer={upgradeNote}
      >
        <SelectItem
          value={DEFAULT_VALUE}
          data-mw-model=""
          description={defaultEntry === undefined ? "This deployment's choice." : describeModel(defaultEntry)}
        >
          {defaultName === null ? "Default" : `Default (${defaultName})`}
        </SelectItem>
        {models?.map(itemFor)}
        {partners.length > 0 && (
          // Another provider's models: offered for testing and usable only
          // on a plan that names them, so never mixed into the list above.
          <SelectGroup className="p-0">
            <SelectSeparator />
            <SelectLabel>{PARTNER_MODELS_HEADING}</SelectLabel>
            {partners.map(itemFor)}
          </SelectGroup>
        )}
        {previews.length > 0 && (
          // Research previews stay in their own group, never in the main
          // list and never the default -- the default above is the
          // server's, and a research preview is never the default.
          <SelectGroup className="p-0">
            <SelectSeparator />
            <SelectLabel className="text-mw-warning-foreground">
              Research preview — not for real use
            </SelectLabel>
            {previews.map(itemFor)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

/** The "nothing picked" entry's value; the API's own is the absence of a model. */
const DEFAULT_VALUE = "__default__";

/**
 * One entry: its label, with the price and window (or a research
 * preview's warning) as its second line. A model the plan does not include
 * is listed but disabled, naming the plan that has it.
 */
function itemFor(model: ModelInfo) {
  if (!model.included) {
    return (
      <SelectItem
        key={model.id}
        value={model.id}
        disabled
        data-mw-model={model.id}
        description={model.upgrade_to === null ? "Not on your plan" : `Needs ${model.upgrade_to}`}
      >
        {model.label}
      </SelectItem>
    );
  }
  return (
    <SelectItem
      key={model.id}
      value={model.id}
      data-mw-model={model.id}
      description={describeModel(model)}
    >
      {model.label}
    </SelectItem>
  );
}
