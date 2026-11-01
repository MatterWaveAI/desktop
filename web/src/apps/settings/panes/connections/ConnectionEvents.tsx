import { useEffect, useId, useState } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { SimpleSelect } from "../../../../components/ui/select";
import { formatDateTime } from "../../../../i18n/format";
import { LoadingSkeleton } from "../../../../patterns";
import { useShell } from "../../../../shell/shellContext";
import { conversationHref } from "../../../../shell/useShellState";
import { fetchEvents, messageOf, type Connection, type ConnectorEvent } from "./connectionsApi";

/**
 * The trigger log: what the connection received and what became of each
 * event -- answered, refused and why, forged -- newest first, filtered by
 * outcome and paged by cursor. It carries ids and outcomes, never what
 * anyone wrote; the conversation an answer opened belongs to the paying
 * member, so only they get a link to it and everyone else sees its id.
 */

const ALL = "all";
const PAGE = 50;

/** Each outcome as a reader understands it; one the API adds later reads as its name. */
const OUTCOME_LABELS: Record<string, MessageDescriptor> = {
  accepted: msg`Accepted`,
  answered: msg`Answered`,
  duplicate: msg`Duplicate`,
  bad_signature: msg`Bad signature`,
  stale: msg`Stale signature`,
  unmapped: msg`Not a member`,
  guest: msg`Guest`,
  blocked: msg`Blocked`,
  channel_not_routed: msg`Channel not routed`,
  rate_limited: msg`Rate limited`,
  budget_refused: msg`Budget refused`,
  preset_missing: msg`Preset deleted`,
  disabled: msg`Connection disabled`,
  suspended: msg`Member suspended`,
  moderation_blocked: msg`Blocked by moderation`,
  model_not_allowed: msg`Model not allowed`,
  error: msg`Error`,
};

/** Green for an answer, neutral for the in-between states, red for a refusal or a forgery. */
function outcomeVariant(outcome: string): "positive" | "secondary" | "destructive" {
  if (outcome === "answered") return "positive";
  if (outcome === "accepted" || outcome === "duplicate") return "secondary";
  return "destructive";
}

function formatWhen(iso: string): string {
  return formatDateTime(iso, { dateStyle: "medium", timeStyle: "medium" }) || iso;
}

export function ConnectionEvents(props: {
  connection: Connection;
  outcomes: string[];
  nameOf: (subject: string) => string;
}) {
  const { t, i18n } = useLingui();
  const { principal } = useShell();
  const { connection } = props;
  const [filter, setFilter] = useState<string>(ALL);
  const [rows, setRows] = useState<ConnectorEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const filterId = useId();
  const outcome = filter === ALL ? null : filter;

  useEffect(() => {
    let cancelled = false;
    fetchEvents(connection.id, { outcome, limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setRows(page.data);
        setCursor(page.next_cursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows(null);
        setCursor(null);
        setError(messageOf(err, t`Could not load the trigger log.`));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, outcome, version, t]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchEvents(connection.id, { outcome, cursor, limit: PAGE });
      setRows((current) => [...(current ?? []), ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(messageOf(err, t`Could not load more of the trigger log.`));
    } finally {
      setLoadingMore(false);
    }
  }

  const labelOf = (name: string) => (OUTCOME_LABELS[name] ? i18n._(OUTCOME_LABELS[name]) : name);
  const displayName = connection.display_name;

  return (
    <div className="flex flex-col gap-2" data-connection-events="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={filterId}>
            <Trans>Outcome</Trans>
          </label>
          <SimpleSelect
            id={filterId}
            size="sm"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: ALL, label: t`All outcomes` },
              ...props.outcomes.map((name) => ({ value: name, label: labelOf(name) })),
            ]}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      {rows === null ? (
        !error && <LoadingSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-mw-text-muted">
          {outcome === null ? t`Nothing has been received on this connection yet.` : t`No events with this outcome.`}
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-136 text-sm" aria-label={t`Trigger log for ${displayName}`}>
            <thead className="text-left text-xs text-mw-text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">
                  <Trans>When</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Outcome</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>External user</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Channel</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Conversation</Trans>
                </th>
                <th className="py-1 font-medium">
                  <Trans>Paying member</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <tr key={event.id} className="border-t border-border align-top" data-event-id={event.id} data-event-outcome={event.outcome}>
                  <td className="py-1.5 pr-2 whitespace-nowrap">{formatWhen(event.received_at)}</td>
                  <td className="py-1.5 pr-2">
                    <Badge variant={outcomeVariant(event.outcome)}>{labelOf(event.outcome)}</Badge>
                    {event.detail && <div className="text-xs text-mw-text-muted">{event.detail}</div>}
                  </td>
                  <td className="py-1.5 pr-2">
                    {event.external_user_id ? <code className="font-mono text-xs">{event.external_user_id}</code> : "—"}
                  </td>
                  <td className="py-1.5 pr-2">
                    {event.external_channel_id ? (
                      <code className="font-mono text-xs">{event.external_channel_id}</code>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {event.conversation_id === null ? (
                      "—"
                    ) : event.paying_subject === principal.subject ? (
                      <a
                        href={conversationHref(event.conversation_id)}
                        className="font-mono text-xs text-mw-link hover:text-mw-link-hover"
                        data-event-conversation-link=""
                      >
                        {event.conversation_id}
                      </a>
                    ) : (
                      <code className="font-mono text-xs">{event.conversation_id}</code>
                    )}
                  </td>
                  <td className="py-1.5 break-all">{event.paying_subject ? props.nameOf(event.paying_subject) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t`Loading…` : t`Load more`}
          </Button>
        </div>
      )}
    </div>
  );
}
