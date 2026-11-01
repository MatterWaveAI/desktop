import { useId, useState, type FormEvent } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import {
  NOTIFY_CHANNEL_KEY,
  NOTIFY_EVENTS_KEY,
  fieldErrors,
  messageOf,
  updateConnection,
  type Connection,
} from "./connectionsApi";

/**
 * Notifications: a channel in the workspace where administrative events
 * are posted as one line each -- a budget nearly spent, a member joined,
 * a key revoked, the plan changed. Only the events the API allows are
 * offered: nothing about conversations ever reaches a workspace this way.
 * Saved into the connection's config, beside the adapter's own keys.
 */

/** What each event means, beside its name in the checklist. */
const EVENT_HINTS: Record<string, MessageDescriptor> = {
  "api_key.revoked": msg`An API key was revoked.`,
  "budget.exhausted": msg`The monthly budget is used up.`,
  "budget.warn": msg`Spend crossed 80% of the monthly budget.`,
  "member.joined": msg`Someone accepted an invitation.`,
  "member.removed": msg`Someone was removed from the organisation.`,
  "member.role_changed": msg`A member's role changed.`,
  "plan.changed": msg`The organisation's plan moved.`,
};

function configuredEvents(config: Record<string, unknown>): string[] {
  const value = config[NOTIFY_EVENTS_KEY];
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
}

function configuredChannel(config: Record<string, unknown>): string {
  const value = config[NOTIFY_CHANNEL_KEY];
  return typeof value === "string" ? value : "";
}

export function ConnectionNotifications(props: {
  connection: Connection;
  events: string[];
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const { connection } = props;
  const [channel, setChannel] = useState(() => configuredChannel(connection.config));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(configuredEvents(connection.config)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const channelId = useId();

  const toggle = (event: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });

  // In the API's order, which is the order it keeps.
  const chosen = props.events.filter((event) => selected.has(event));
  const changed =
    channel.trim() !== configuredChannel(connection.config) ||
    chosen.join(",") !== configuredEvents(connection.config).join(",");
  const canSave = changed && !busy && (chosen.length === 0 || channel.trim().length > 0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateConnection(connection.id, {
        config: { ...connection.config, [NOTIFY_CHANNEL_KEY]: channel.trim(), [NOTIFY_EVENTS_KEY]: chosen },
      });
      setSaved(true);
      props.onChanged();
    } catch (err) {
      setError(fieldErrors(err).config ?? messageOf(err, t`Could not save the notifications.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      aria-busy={busy}
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3"
      data-connection-notifications=""
    >
      <p className="max-w-prose text-sm text-mw-text-muted">
        <Trans>
          One line per event, posted to a channel of the workspace. Only these administrative events can
          be sent; nothing about conversations ever is.
        </Trans>
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={channelId} className="text-sm text-mw-text-muted">
          <Trans>Channel id</Trans>
        </label>
        <Input
          id={channelId}
          name="notify_channel"
          autoComplete="off"
          placeholder="C0123456789"
          className="max-w-xs"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
        <p className="text-xs text-mw-text-muted">
          <Trans>The app must be a member of the channel.</Trans>
        </p>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pb-1 text-sm font-medium">
          <Trans>Events</Trans>
        </legend>
        {props.events.map((event) => (
          <label key={event} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              name="notify_events"
              value={event}
              checked={selected.has(event)}
              onChange={() => toggle(event)}
            />
            <span className="min-w-0">
              <code className="font-mono break-all">{event}</code>
              {EVENT_HINTS[event] && <span className="ml-2 text-mw-text-muted">{i18n._(EVENT_HINTS[event])}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      {saved && !changed && (
        <p role="status" className="text-sm text-mw-positive">
          <Trans>Saved.</Trans>
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={!canSave}>
          {busy ? t`Saving…` : t`Save notifications`}
        </Button>
      </div>
    </form>
  );
}
