import { useEffect, useRef, useState } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { Select, SelectContent, SelectItem } from "../../components/ui/select";
import type { Preset, PresetListing, PresetRef } from "../../types";
import { apiFetch } from "../../lib/api";

/**
 * The composer's preset picker, beside the model picker.
 *
 * The list is the org's live presets (`GET /api/org/presets`, which any
 * member reads). Picking one puts the conversation on it: its model,
 * instructions and tools answer every turn from then on, the model picker
 * shows that model as fixed, and a new chat's empty state carries its
 * welcome message. "No preset" is the conversation's own model and
 * instructions, as before. The choice persists on the conversation once
 * one exists; on a new chat it rides on the create.
 *
 * A conversation already on a preset the org has since deleted still
 * answers with it (the API keeps a deleted preset's settings for the
 * conversations on it), so its name and model are read one by one and it
 * stays on the pill without being offered again. Nothing renders while the
 * org has no presets and none is in force: a control with one entry, "No
 * preset", would only say what the composer already does.
 */
export function PresetPicker({
  conversationId,
  value,
  onChange,
  onPresetsLoaded,
}: {
  conversationId: string | null;
  /** The conversation's preset, as the API names it; null for none. */
  value: PresetRef | null;
  onChange: (preset: Preset | null) => void;
  /**
   * Every preset this picker knows, once loaded and again when the one in
   * force had to be read on its own: the composer resolves the model to fix
   * and the welcome message to show from these, so the two never disagree.
   */
  onPresetsLoaded?: (presets: readonly Preset[]) => void;
}) {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  // The one in force when the list does not offer it: deleted since.
  const [retired, setRetired] = useState<Preset | null>(null);

  // Held in a ref so adding the callback to the deps below cannot re-run the
  // fetch when a parent passes a fresh closure on every render.
  const notifyRef = useRef(onPresetsLoaded);
  useEffect(() => {
    notifyRef.current = onPresetsLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    apiFetch<PresetListing>("/api/org/presets")
      .then((listing) => {
        if (cancelled) return;
        setPresets(listing.data);
        notifyRef.current?.(listing.data);
      })
      .catch(() => {
        // No org, or a deployment without presets: the composer is its
        // plain self, which is what the picker's absence says.
        if (!cancelled) setPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const valueId = value?.id ?? null;
  const listed = valueId === null || presets === null ? undefined : presets.find((p) => p.id === valueId);
  useEffect(() => {
    if (presets === null || valueId === null || listed !== undefined) return;
    let cancelled = false;
    apiFetch<Preset>(`/api/org/presets/${valueId}`)
      .then((preset) => {
        if (cancelled) return;
        setRetired(preset);
        notifyRef.current?.([...presets, preset]);
      })
      .catch(() => {
        // The conversation's own ref still names it on the pill.
      });
    return () => {
      cancelled = true;
    };
  }, [presets, valueId, listed]);

  async function select(preset: Preset | null) {
    onChange(preset);
    if (conversationId === null) return;
    try {
      await apiFetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        json: { preset_id: preset?.id ?? null },
      });
    } catch {
      // The API decides the turn by the stored preset, so a failed save is
      // a choice that did not take; the next pick tries again.
    }
  }

  if (presets === null || (presets.length === 0 && valueId === null)) return null;

  const inForce = listed ?? (retired?.id === valueId ? retired : null) ?? null;
  const pillLabel = inForce?.name ?? value?.name ?? NO_PRESET_LABEL;
  const description =
    valueId === null
      ? "No preset: your own model and instructions."
      : `Answering with the ${pillLabel} preset${inForce?.description ? `: ${inForce.description}` : "."}`;

  return (
    <Select
      value={valueId ?? NONE_VALUE}
      onValueChange={(next) => {
        if (next === null) return;
        void select(next === NONE_VALUE ? null : (presets.find((p) => p.id === next) ?? null));
      }}
    >
      {/* The same pill as the model's: the mark, the preset's name, the
          chevron. What the preset does is each option's second line and
          the selected one's is the control's description. */}
      <SelectPrimitive.Trigger
        aria-label="Preset"
        aria-describedby="mw-preset-description"
        data-mw-preset-picker=""
        className="inline-flex h-10 max-w-36 min-w-0 shrink items-center gap-2 rounded-full border border-mw-border-emphasis bg-mw-surface-raised pr-3 pl-3.5 text-sm text-mw-text transition-colors outline-none select-none hover:bg-mw-surface-hover focus-visible:ring-2 focus-visible:ring-mw-focus focus-visible:ring-offset-2 focus-visible:ring-offset-mw-surface data-popup-open:bg-mw-surface-hover sm:max-w-56 pointer-coarse:h-11"
      >
        <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-mw-text-muted" />
        <span className="min-w-0 truncate" data-mw-preset-label="">
          {pillLabel}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-mw-text-muted" />
      </SelectPrimitive.Trigger>
      <span id="mw-preset-description" className="sr-only">
        {description}
      </span>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        sideOffset={6}
        aria-label="Presets"
        className="w-[min(22rem,calc(100vw-2rem))] max-w-none p-1"
      >
        <SelectItem value={NONE_VALUE} data-mw-preset="" description="Your own model and instructions.">
          {NO_PRESET_LABEL}
        </SelectItem>
        {presets.map((preset) => (
          <SelectItem
            key={preset.id}
            value={preset.id}
            data-mw-preset={preset.id}
            description={preset.description || `Answers with ${preset.model}.`}
          >
            {preset.name}
          </SelectItem>
        ))}
        {/* Deleted since: still the conversation's, so still choosable
            to stay on, but never offered to another conversation. */}
        {retired !== null && retired.id === valueId && listed === undefined && (
          <SelectItem value={retired.id} data-mw-preset={retired.id} description="No longer offered; this conversation keeps it.">
            {retired.name}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}


/** The "none" entry's value; the API's own is a null `preset_id`. */
const NONE_VALUE = "__none__";
const NO_PRESET_LABEL = "No preset";
