import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog";
import { Input } from "../../../../components/ui/input";
import { SimpleSelect } from "../../../../components/ui/select";
import { DestructiveConfirm, LoadingSkeleton } from "../../../../patterns";
import {
  createRoute,
  deleteRoute,
  fetchRoutes,
  fieldErrors,
  messageOf,
  updateRoute,
  type Connection,
  type MemberOption,
  type PresetOption,
  type Route,
  type RouteDraft,
} from "./connectionsApi";

/**
 * Routing: the channels a connection answers, each with the preset that
 * answers and the member whose budget pays. A channel not listed is never
 * answered, which is the whole of the governance -- so the copy says so
 * above the table. A route whose preset was deleted is flagged: the API
 * refuses its mentions (`preset_missing`) until an admin points it at
 * another preset.
 */

/** The member as the select names them: email first, then a name. */
function memberOptionLabel(member: MemberOption): string {
  return member.name ? `${member.name} (${member.email})` : member.email;
}

export function ConnectionRouting(props: {
  connection: Connection;
  presets: PresetOption[];
  members: MemberOption[];
  nameOf: (subject: string) => string;
}) {
  const { t } = useLingui();
  const { connection } = props;
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Route | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRoutes(connection.id)
      .then((rows) => {
        if (cancelled) return;
        setRoutes(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRoutes(null);
        setError(messageOf(err, t`Could not load the routing.`));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, version, t]);

  const displayName = connection.display_name;

  return (
    <div className="flex flex-col gap-3" data-connection-routing="">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-mw-text-muted">
          <Trans>
            Only channels listed here are answered. Spend is charged to the paying member and counts
            against their cap.
          </Trans>
        </p>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Trans>Add channel…</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : routes === null ? (
        <LoadingSkeleton rows={2} />
      ) : routes.length === 0 ? (
        <p className="text-sm text-mw-text-muted">
          <Trans>No channels yet. Mentions in this workspace are refused until one is added.</Trans>
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-136 text-sm" aria-label={t`Channels answered for ${displayName}`}>
            <thead className="text-left text-xs text-mw-text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Channel</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Preset</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Paying member</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Enabled</Trans>
                </th>
                <th className="py-1 font-medium">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <RouteRow
                  key={route.id}
                  connection={connection}
                  route={route}
                  nameOf={props.nameOf}
                  onEdit={() => setEditing(route)}
                  onChanged={reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RouteDialog
        open={creating}
        connection={connection}
        editing={null}
        presets={props.presets}
        members={props.members}
        onOpenChange={setCreating}
        onSaved={() => {
          setCreating(false);
          reload();
        }}
      />
      <RouteDialog
        open={editing !== null}
        connection={connection}
        editing={editing}
        presets={props.presets}
        members={props.members}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </div>
  );
}

function RouteRow(props: {
  connection: Connection;
  route: Route;
  nameOf: (subject: string) => string;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const { route } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const setEnabled = (enabled: boolean) =>
    run(async () => {
      await updateRoute(props.connection.id, route.id, { enabled });
      props.onChanged();
    }, enabled ? t`Could not enable the channel.` : t`Could not disable the channel.`);

  const remove = () =>
    run(async () => {
      await deleteRoute(props.connection.id, route.id);
      setConfirming(false);
      props.onChanged();
    }, t`Could not remove the channel.`);

  const channel = route.channel_label || route.external_channel_id;
  return (
    <>
      <tr className="border-t border-border align-top" data-route-id={route.id} data-route-channel={route.external_channel_id}>
        <td className="py-1.5 pr-2">
          {route.channel_label && <div>{route.channel_label}</div>}
          <code className="font-mono text-xs text-mw-text-muted">{route.external_channel_id}</code>
        </td>
        <td className="py-1.5 pr-2">
          {route.preset_name !== null ? (
            route.preset_name
          ) : (
            <Badge variant="destructive" data-route-preset-missing="">
              <Trans>Preset deleted</Trans>
            </Badge>
          )}
        </td>
        <td className="py-1.5 pr-2 break-all">{props.nameOf(route.paying_subject)}</td>
        <td className="py-1.5 pr-2">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              name="enabled"
              aria-label={t`Answer in ${channel}`}
              checked={route.enabled}
              disabled={busy}
              onChange={(e) => void setEnabled(e.target.checked)}
            />
            <span className="sr-only">{route.enabled ? t`Enabled` : t`Disabled`}</span>
          </label>
        </td>
        <td className="py-1.5 text-right">
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={props.onEdit}>
              <Trans>Edit…</Trans>
            </Button>
            <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => setConfirming(true)}>
              <Trans>Remove…</Trans>
            </Button>
          </div>
          <DestructiveConfirm
            open={confirming}
            onOpenChange={(open) => {
              if (!open) setConfirming(false);
            }}
            title={t`Stop answering in ${channel}?`}
            description={t`Mentions there are refused from now on. The conversations already opened stay with their paying member.`}
            confirmLabel={t`Remove channel`}
            onConfirm={() => void remove()}
            inFlight={busy}
          />
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={5} className="pb-2">
            <p role="alert" className="text-sm text-mw-danger">
              {error}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

// --- adding and editing -----------------------------------------------------------

function RouteDialog(props: {
  open: boolean;
  connection: Connection;
  editing: Route | null;
  presets: PresetOption[];
  members: MemberOption[];
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
      <DialogContent
        data-route-create-dialog={props.editing ? undefined : ""}
        data-route-edit-dialog={props.editing ? "" : undefined}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        {/* Keyed on the route so an edit starts from it as it stands, and
            an add from nothing, without an effect copying props. */}
        {props.open && (
          <RouteForm
            key={props.editing?.id ?? "create"}
            connection={props.connection}
            editing={props.editing}
            presets={props.presets}
            members={props.members}
            busy={busy}
            setBusy={setBusy}
            onCancel={() => props.onOpenChange(false)}
            onSaved={props.onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function draftOf(route: Route | null): RouteDraft {
  return {
    external_channel_id: route?.external_channel_id ?? "",
    channel_label: route?.channel_label ?? "",
    preset_id: route?.preset_id ?? "",
    paying_subject: route?.paying_subject ?? "",
    enabled: route?.enabled ?? true,
  };
}

/** The fields of `next` that differ from `before`, in the API's shape. */
function changesOf(before: RouteDraft, next: RouteDraft): Partial<Omit<RouteDraft, "external_channel_id">> {
  const changes: Partial<Omit<RouteDraft, "external_channel_id">> = {};
  if (next.channel_label.trim() !== before.channel_label) changes.channel_label = next.channel_label.trim();
  if (next.preset_id !== before.preset_id) changes.preset_id = next.preset_id;
  if (next.paying_subject !== before.paying_subject) changes.paying_subject = next.paying_subject;
  if (next.enabled !== before.enabled) changes.enabled = next.enabled;
  return changes;
}

function RouteForm(props: {
  connection: Connection;
  editing: Route | null;
  presets: PresetOption[];
  members: MemberOption[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { editing, busy, setBusy } = props;
  const [initial] = useState(() => draftOf(editing));
  const [draft, setDraft] = useState<RouteDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const channelId = useId();
  const labelId = useId();
  const presetId = useId();
  const payerId = useId();
  const set = <K extends keyof RouteDraft>(field: K, value: RouteDraft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));

  // A deleted preset is not offered, so the select of a route on one
  // starts empty and the admin has to choose: that is the point of the flag.
  const presetOptions = props.presets.map((preset) => ({ value: preset.id, label: preset.name }));
  const memberOptions = props.members.map((member) => ({
    value: member.subject,
    label: memberOptionLabel(member),
  }));
  const canSave =
    draft.external_channel_id.trim().length > 0 && draft.preset_id !== "" && draft.paying_subject !== "" && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (editing) {
        const changes = changesOf(initial, draft);
        if (Object.keys(changes).length > 0) await updateRoute(props.connection.id, editing.id, changes);
      } else {
        await createRoute(props.connection.id, {
          ...draft,
          external_channel_id: draft.external_channel_id.trim(),
          channel_label: draft.channel_label.trim(),
        });
      }
      props.onSaved();
    } catch (err) {
      const perField = fieldErrors(err);
      setFields(perField);
      setError(
        Object.keys(perField).length > 0
          ? null
          : messageOf(err, editing ? t`Could not save the channel.` : t`Could not add the channel.`),
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
        <DialogTitle>{editing ? <Trans>Edit the channel</Trans> : <Trans>Answer in a channel</Trans>}</DialogTitle>
        <DialogDescription>
          <Trans>
            Mentions in this channel are answered by the preset, and each answer is charged to the paying
            member and counts against their cap.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={channelId} className="text-sm text-mw-text-muted">
          <Trans>Channel id</Trans>
        </label>
        {editing ? (
          <code id={channelId} className="font-mono text-sm">
            {editing.external_channel_id}
          </code>
        ) : (
          <Input
            id={channelId}
            name="external_channel_id"
            autoComplete="off"
            placeholder="C0123456789"
            value={draft.external_channel_id}
            aria-invalid={fields.external_channel_id ? true : undefined}
            onChange={(e) => set("external_channel_id", e.target.value)}
          />
        )}
        {!editing && (
          <p className="text-xs text-mw-text-muted">
            <Trans>In Slack, open the channel&apos;s details; the id is at the bottom.</Trans>
          </p>
        )}
        {fieldError("external_channel_id")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={labelId} className="text-sm text-mw-text-muted">
          <Trans>
            Label <span className="text-mw-text-muted">(optional)</span>
          </Trans>
        </label>
        <Input
          id={labelId}
          name="channel_label"
          maxLength={200}
          placeholder={t`e.g. #support`}
          value={draft.channel_label}
          onChange={(e) => set("channel_label", e.target.value)}
        />
        {fieldError("channel_label")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={presetId} className="text-sm text-mw-text-muted">
          <Trans>Preset</Trans>
        </label>
        <SimpleSelect
          id={presetId}
          value={draft.preset_id || null}
          onValueChange={(value) => set("preset_id", value)}
          options={presetOptions}
          placeholder={presetOptions.length === 0 ? t`No presets yet` : t`Choose a preset`}
          disabled={presetOptions.length === 0}
          aria-invalid={fields.preset_id ? true : undefined}
        />
        {presetOptions.length === 0 && (
          <p className="text-xs text-mw-text-muted">
            <Trans>Create a preset first; it is what answers here.</Trans>
          </p>
        )}
        {fieldError("preset_id")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={payerId} className="text-sm text-mw-text-muted">
          <Trans>Paying member</Trans>
        </label>
        <SimpleSelect
          id={payerId}
          value={draft.paying_subject || null}
          onValueChange={(value) => set("paying_subject", value)}
          options={memberOptions}
          placeholder={t`Choose a member`}
          aria-invalid={fields.paying_subject ? true : undefined}
        />
        {fieldError("paying_subject")}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          name="enabled"
          checked={draft.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        <span>
          <Trans>Answer in this channel</Trans>
        </span>
      </label>
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
          {editing ? (busy ? t`Saving…` : t`Save changes`) : busy ? t`Adding…` : t`Add channel`}
        </Button>
      </DialogFooter>
    </form>
  );
}
