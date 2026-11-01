import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { SimpleSelect } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { ApiError, apiFetch } from "../../../lib/api";
import { loadModels } from "../../../lib/models";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../../patterns";
import type { ModelInfo, Preset, PresetLimits, PresetListing, PresetTool } from "../../../types";
import { PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { Row, RowList } from "../rows";

/**
 * Presets: the assistants this organisation offers its members -- a name,
 * the model that answers, the instructions it carries, the tools it may
 * call and a welcome message -- picked in the composer beside the model.
 *
 * Every member reads the list, since it is what their composer offers; an
 * owner or admin (the API's `can_manage`, read from the membership row)
 * also creates, edits and deletes. A member sees the list with an
 * explanation and nothing to press. The model select offers what
 * `/api/models` offers this org, which is already narrowed to the models
 * the plan and the org allow; the API checks again on save.
 */

/** The fields a create sends and an edit compares. */
interface Draft {
  name: string;
  description: string;
  model: string;
  instructions: string;
  /** null keeps the deployment's default tools; a list (even empty) is exactly those. */
  tools: string[] | null;
  welcome_message: string;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * A 422's per-field messages, keyed by field: the API names the field a
 * bad name, model or tool came in on (routes_presets.py), so the form can
 * show the reason where it was typed.
 */
function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const detail = (err.body as { detail?: unknown } | undefined)?.detail;
  if (!Array.isArray(detail)) return {};
  const errors: Record<string, string> = {};
  for (const item of detail as Array<{ loc?: unknown[]; msg?: unknown }>) {
    const field = item.loc?.[item.loc.length - 1];
    if (typeof field === "string" && typeof item.msg === "string" && !(field in errors)) {
      errors[field] = item.msg.replace(/^Value error, /, "");
    }
  }
  return errors;
}

/** The listing's 503 is a deployment without Postgres: not something an admin can retry. */
function featureOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

export function PresetsPane() {
  const { t } = useLingui();
  const [listing, setListing] = useState<PresetListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after every write: the list is re-read rather than patched
  // locally, so what the pane shows is what the API holds.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Preset | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PresetListing>("/api/org/presets")
      .then((body) => {
        if (cancelled) return;
        setListing(body);
        setLoadError(null);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListing(null);
        const off = featureOff(err);
        setUnavailable(off);
        setLoadError(off ? null : messageOf(err, t`Could not load the presets.`));
      });
    return () => {
      cancelled = true;
    };
  }, [version, t]);

  const canManage = listing?.can_manage === true;
  useEffect(() => {
    // Only the form needs the models, and only a manager opens it.
    if (!canManage) return;
    let cancelled = false;
    loadModels()
      .then((response) => {
        if (!cancelled) setModels(response.data.filter((model) => model.included));
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  if (unavailable) {
    return (
      <EmptyState
        title={t`Not available on this deployment`}
        description={t`Presets need a database this deployment does not have, so there are none to set up here.`}
      />
    );
  }

  const maxPresets = listing?.limits.max_presets ?? null;
  const atCap = listing !== null && maxPresets !== null && listing.data.length >= maxPresets;
  const labelOf = (id: string) => models.find((model) => model.id === id)?.label ?? id;

  return (
    <div className="flex flex-col gap-7">
      {canManage && (
        <PaneActions>
          <Button type="button" size="lg" disabled={atCap} onClick={() => setCreating(true)}>
            <Trans>New preset…</Trans>
          </Button>
        </PaneActions>
      )}
      <PaneSection
        title={t`Presets`}
        flush
        description={t`A preset is a named assistant: a model, its instructions and its tools. Members pick one in the composer, beside the model.`}
      >
        {loadError ? (
          <div className="px-5 py-4">
            <ErrorState title={t`Could not load the presets`} message={loadError} onRetry={reload} />
          </div>
        ) : listing === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={3} />
          </div>
        ) : (
          <>
            {!canManage && (
              <p className="border-b border-border px-5 py-3 text-sm text-mw-text-muted" data-presets-member-note="">
                <Trans>
                  Presets are set up by an owner or admin. Pick one in the composer to answer with its model,
                  instructions and tools.
                </Trans>
              </p>
            )}
            {listing.data.length === 0 ? (
              <EmptyState
                title={t`No presets yet`}
                description={
                  canManage
                    ? t`Create one to give members a ready-made assistant: a model, instructions and the tools it may use.`
                    : t`When an administrator creates one, it is offered in the composer.`
                }
              />
            ) : (
              <RowList aria-label={t`Presets`}>
                {listing.data.map((preset) => (
                  <PresetRow
                    key={preset.id}
                    preset={preset}
                    modelLabel={labelOf(preset.model)}
                    tools={listing.tools}
                    canManage={canManage}
                    onEdit={() => setEditing(preset)}
                    onChanged={reload}
                  />
                ))}
              </RowList>
            )}
            {canManage && atCap && maxPresets !== null && (
              <p className="border-t border-border px-5 py-3 text-sm text-mw-text-muted" data-presets-at-cap="">
                <Trans>This organisation has {maxPresets} presets, the most it may have. Delete one first.</Trans>
              </p>
            )}
            {canManage && (
              <>
                <PresetDialog
                  open={creating}
                  editing={null}
                  models={models}
                  tools={listing.tools}
                  limits={listing.limits}
                  onOpenChange={setCreating}
                  onSaved={() => {
                    setCreating(false);
                    reload();
                  }}
                />
                <PresetDialog
                  open={editing !== null}
                  editing={editing}
                  models={models}
                  tools={listing.tools}
                  limits={listing.limits}
                  onOpenChange={(open) => {
                    if (!open) setEditing(null);
                  }}
                  onSaved={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              </>
            )}
          </>
        )}
      </PaneSection>
    </div>
  );
}

/** What a preset's tools come to, as its row says it. */
function ToolsSummary(props: { tools: string[] | null }) {
  const { t } = useLingui();
  if (props.tools === null) return <span>{t`Default tools`}</span>;
  if (props.tools.length === 0) return <span>{t`No tools`}</span>;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {props.tools.map((name) => (
        <Badge key={name} variant="outline">
          {name}
        </Badge>
      ))}
    </span>
  );
}

function PresetRow(props: {
  preset: Preset;
  modelLabel: string;
  tools: PresetTool[];
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const { preset } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetName = preset.name;
  const modelLabel = props.modelLabel;
  const welcome = preset.welcome_message;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/org/presets/${preset.id}`, { method: "DELETE" });
      setConfirming(false);
      props.onChanged();
    } catch (err) {
      setError(messageOf(err, t`Could not delete the preset.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      data-testid="preset-row"
      title={preset.name}
      meta={preset.description || undefined}
      extra={
        <div className="mt-1 flex flex-col gap-1 text-sm text-mw-text-muted">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>
              <Trans>Model: {modelLabel}</Trans>
            </span>
            <span aria-hidden>·</span>
            <ToolsSummary tools={preset.tools} />
          </span>
          {welcome && (
            <span className="break-words" data-preset-welcome="">
              <Trans>Welcome: “{welcome}”</Trans>
            </span>
          )}
          {error && (
            <span role="alert" className="text-mw-danger">
              {error}
            </span>
          )}
        </div>
      }
      trailing={
        props.canManage ? (
          <>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onEdit}>
              <Trans>Edit…</Trans>
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              <Trans>Delete…</Trans>
            </Button>
            <DestructiveConfirm
              open={confirming}
              onOpenChange={(open) => {
                if (!open) setConfirming(false);
              }}
              title={t`Delete ${presetName}?`}
              description={t`It is no longer offered for new conversations. Conversations already on it keep answering with it as it is now.`}
              confirmLabel={t`Delete preset`}
              onConfirm={() => void remove()}
              inFlight={busy}
            />
          </>
        ) : undefined
      }
    />
  );
}

function PresetDialog(props: {
  open: boolean;
  editing: Preset | null;
  models: ModelInfo[];
  tools: PresetTool[];
  limits: PresetLimits;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent data-preset-dialog="" className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {/* Keyed on the preset so an edit starts from it as it stands, and
            a create from nothing, without an effect copying props. */}
        <PresetForm
          key={props.editing?.id ?? "create"}
          editing={props.editing}
          models={props.models}
          tools={props.tools}
          limits={props.limits}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => props.onOpenChange(false)}
          onSaved={props.onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function draftOf(preset: Preset | null, models: ModelInfo[]): Draft {
  return {
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    model: preset?.model ?? models[0]?.id ?? "",
    instructions: preset?.instructions ?? "",
    tools: preset ? preset.tools : null,
    welcome_message: preset?.welcome_message ?? "",
  };
}

/** The fields of `next` that differ from `before`, in the API's shape. */
function changesOf(before: Draft, next: Draft): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of ["name", "description", "model", "instructions"] as const) {
    if (next[field].trim() !== before[field]) changes[field] = next[field].trim();
  }
  if (JSON.stringify(next.tools) !== JSON.stringify(before.tools)) changes.tools = next.tools;
  const welcome = next.welcome_message.trim();
  if (welcome !== before.welcome_message) changes.welcome_message = welcome || null;
  return changes;
}

function PresetForm(props: {
  editing: Preset | null;
  models: ModelInfo[];
  tools: PresetTool[];
  limits: PresetLimits;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { editing, busy, setBusy, limits } = props;
  const [initial] = useState(() => draftOf(editing, props.models));
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const nameId = useId();
  const descriptionId = useId();
  const modelId = useId();
  const instructionsId = useId();
  const welcomeId = useId();
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((d) => ({ ...d, [field]: value }));

  // The current model stays choosable even when the list no longer offers
  // it (the org switched it off since), so an edit can see what it is.
  const modelOptions = [
    ...props.models.map((model) => ({ value: model.id, label: model.label })),
    ...(draft.model && !props.models.some((model) => model.id === draft.model)
      ? [{ value: draft.model, label: draft.model }]
      : []),
  ];
  const canSave = draft.name.trim().length > 0 && draft.model.length > 0 && !busy;
  const instructionsLength = draft.instructions.length;
  const instructionsMax = limits.instructions_max_len;

  const toggleTool = (name: string) =>
    setDraft((d) => {
      const chosen = new Set(d.tools ?? []);
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      // In the registry's order, which is the order the API keeps.
      return { ...d, tools: props.tools.map((tool) => tool.name).filter((n) => chosen.has(n)) };
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (editing) {
        const changes = changesOf(initial, draft);
        if (Object.keys(changes).length > 0) {
          await apiFetch<Preset>(`/api/org/presets/${editing.id}`, { method: "PATCH", json: changes });
        }
      } else {
        await apiFetch<Preset>("/api/org/presets", {
          method: "POST",
          json: {
            name: draft.name.trim(),
            description: draft.description.trim(),
            model: draft.model,
            instructions: draft.instructions.trim(),
            tools: draft.tools,
            welcome_message: draft.welcome_message.trim() || null,
          },
        });
      }
      props.onSaved();
    } catch (err) {
      const perField = fieldErrors(err);
      setFields(perField);
      setError(
        Object.keys(perField).length > 0
          ? null
          : messageOf(err, editing ? t`Could not save the preset.` : t`Could not create the preset.`),
      );
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (name: string) =>
    fields[name] ? (
      <p role="alert" className="text-sm text-mw-danger">
        {fields[name]}
      </p>
    ) : null;

  return (
    <form noValidate aria-busy={busy} onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>{editing ? <Trans>Edit the preset</Trans> : <Trans>New preset</Trans>}</DialogTitle>
        <DialogDescription>
          <Trans>
            Members who pick it get this model, these instructions after the organisation&apos;s, and only these
            tools.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm text-mw-text-muted">
          <Trans>Name</Trans>
        </label>
        <Input
          id={nameId}
          name="name"
          maxLength={limits.name_max_len}
          placeholder={t`e.g. Support desk`}
          value={draft.name}
          aria-invalid={fields.name ? true : undefined}
          onChange={(e) => set("name", e.target.value)}
        />
        {fieldError("name")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={descriptionId} className="text-sm text-mw-text-muted">
          <Trans>
            Description <span className="text-mw-text-muted">(optional)</span>
          </Trans>
        </label>
        <Input
          id={descriptionId}
          name="description"
          maxLength={limits.description_max_len}
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
        />
        {fieldError("description")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={modelId} className="text-sm text-mw-text-muted">
          <Trans>Model</Trans>
        </label>
        <SimpleSelect
          id={modelId}
          value={draft.model || null}
          onValueChange={(model) => set("model", model)}
          options={modelOptions}
          placeholder={t`Choose a model`}
          aria-invalid={fields.model ? true : undefined}
        />
        {fieldError("model")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={instructionsId} className="text-sm text-mw-text-muted">
          <Trans>Instructions</Trans>
        </label>
        <Textarea
          id={instructionsId}
          name="instructions"
          rows={5}
          maxLength={instructionsMax}
          placeholder={t`What this assistant is for, and how it should answer.`}
          value={draft.instructions}
          aria-invalid={fields.instructions ? true : undefined}
          onChange={(e) => set("instructions", e.target.value)}
        />
        <p className="text-xs text-mw-text-muted">
          <Trans>
            {instructionsLength} of {instructionsMax} characters
          </Trans>
        </p>
        {fieldError("instructions")}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pb-1 text-sm text-mw-text-muted">
          <Trans>Tools</Trans>
        </legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            name="default-tools"
            checked={draft.tools === null}
            onChange={(e) => set("tools", e.target.checked ? null : [])}
          />
          <span>
            <Trans>This deployment&apos;s default tools</Trans>
          </span>
        </label>
        {props.tools.map((tool) => (
          <label key={tool.name} className="flex items-start gap-2 pl-6 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              name="tools"
              value={tool.name}
              disabled={draft.tools === null}
              checked={draft.tools === null || draft.tools.includes(tool.name)}
              onChange={() => toggleTool(tool.name)}
            />
            <span className="min-w-0">
              <code className="font-mono break-all">{tool.name}</code>
              <span className="ml-2 text-mw-text-muted">{tool.description}</span>
            </span>
          </label>
        ))}
        {fieldError("tools")}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={welcomeId} className="text-sm text-mw-text-muted">
          <Trans>
            Welcome message <span className="text-mw-text-muted">(optional)</span>
          </Trans>
        </label>
        <Textarea
          id={welcomeId}
          name="welcome_message"
          rows={2}
          maxLength={limits.welcome_max_len}
          placeholder={t`Shown in a new conversation on this preset.`}
          value={draft.welcome_message}
          onChange={(e) => set("welcome_message", e.target.value)}
        />
        {fieldError("welcome_message")}
      </div>
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!canSave}>
          {editing ? (busy ? t`Saving…` : t`Save changes`) : busy ? t`Creating…` : t`Create preset`}
        </Button>
      </DialogFooter>
    </form>
  );
}
