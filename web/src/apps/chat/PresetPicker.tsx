import { useEffect, useRef, useState } from "react";
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
 * stays in the box without being offered again. Nothing renders while the
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
        // The conversation's own ref still names it in the box.
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
  const name = inForce?.name ?? value?.name ?? NO_PRESET_LABEL;
  // What the preset does is the line under the box, where it can be read
  // in full, the same way the model picker describes its choice.
  const description =
    valueId === null
      ? "No preset: your own model and instructions."
      : `Answering with the ${name} preset${inForce?.description ? `: ${inForce.description}` : "."}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-none">
      <label className="flex min-w-0 items-center gap-2 text-xs text-mw-text-muted">
        <span className="sr-only sm:not-sr-only">Preset</span>
        <select
          className="h-8 w-full min-w-0 rounded border border-mw-border bg-transparent px-2 text-xs sm:w-auto pointer-coarse:h-11"
          value={valueId ?? ""}
          onChange={(event) =>
            void select(
              event.target.value === ""
                ? null
                : (presets.find((p) => p.id === event.target.value) ?? retired ?? null),
            )
          }
          aria-label="Preset"
          aria-describedby="mw-preset-description"
          data-mw-preset-picker=""
        >
          <option value="">{NO_PRESET_LABEL}</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
          {/* Deleted since: still the conversation's, so still choosable
              to stay on, but never offered to another conversation. */}
          {retired !== null && retired.id === valueId && listed === undefined && (
            <option value={retired.id}>{retired.name} — no longer offered</option>
          )}
        </select>
      </label>
      <div className="hidden min-h-4 min-w-0 sm:flex">
        <p id="mw-preset-description" className="min-w-0 text-xs text-mw-text-muted">
          {description}
        </p>
      </div>
    </div>
  );
}

const NO_PRESET_LABEL = "No preset";
