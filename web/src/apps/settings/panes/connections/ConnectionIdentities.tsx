import { useCallback, useEffect, useId, useState } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { SimpleSelect } from "../../../../components/ui/select";
import { LoadingSkeleton } from "../../../../patterns";
import {
  fetchIdentities,
  messageOf,
  updateIdentity,
  type Connection,
  type Identity,
  type IdentityAction,
  type IdentityStatus,
  type MemberOption,
} from "./connectionsApi";

/**
 * Identities: everyone the connection has heard from, and which member
 * each is. The email match maps most of them on first sight; an admin
 * links the rest by hand, unlinks, blocks and unblocks. A guest of the
 * workspace is labelled and cannot be linked, as the API refuses it: the
 * rule is that only members of the organisation are answered.
 */

const ALL = "all";

const STATUS_LABELS: Record<IdentityStatus, MessageDescriptor> = {
  mapped: msg`Mapped`,
  unmapped: msg`Unmapped`,
  guest: msg`Guest`,
  blocked: msg`Blocked`,
};

const STATUS_VARIANTS: Record<IdentityStatus, "positive" | "outline" | "warning" | "destructive"> = {
  mapped: "positive",
  unmapped: "outline",
  guest: "warning",
  blocked: "destructive",
};

/** What an empty list says under each filter. */
const EMPTY: Record<IdentityStatus | typeof ALL, MessageDescriptor> = {
  all: msg`Nobody has mentioned this connection yet.`,
  mapped: msg`Nobody is mapped to a member yet.`,
  unmapped: msg`Everyone who asked is mapped, a guest or blocked.`,
  guest: msg`No guests have asked.`,
  blocked: msg`Nobody is blocked.`,
};

function isStatus(value: string): value is IdentityStatus {
  return value in STATUS_LABELS;
}

function memberOptionLabel(member: MemberOption): string {
  return member.name ? `${member.name} (${member.email})` : member.email;
}

export function ConnectionIdentities(props: {
  connection: Connection;
  statuses: string[];
  members: MemberOption[];
  nameOf: (subject: string) => string;
}) {
  const { t, i18n } = useLingui();
  const { connection } = props;
  const [filter, setFilter] = useState<string>(ALL);
  const [rows, setRows] = useState<Identity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const filterId = useId();

  useEffect(() => {
    let cancelled = false;
    fetchIdentities(connection.id, isStatus(filter) ? filter : null)
      .then((data) => {
        if (cancelled) return;
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows(null);
        setError(messageOf(err, t`Could not load the identities.`));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, filter, version, t]);

  const displayName = connection.display_name;
  const emptyKey = isStatus(filter) ? filter : ALL;

  return (
    <div className="flex flex-col gap-3" data-connection-identities="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={filterId}>
            <Trans>Show</Trans>
          </label>
          <SimpleSelect
            id={filterId}
            size="sm"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: ALL, label: t`Everyone` },
              ...props.statuses.map((status) => ({
                value: status,
                label: isStatus(status) ? i18n._(STATUS_LABELS[status]) : status,
              })),
            ]}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={reload}>
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : rows === null ? (
        <LoadingSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-mw-text-muted">{i18n._(EMPTY[emptyKey])}</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-136 text-sm" aria-label={t`People who asked through ${displayName}`}>
            <thead className="text-left text-xs text-mw-text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">
                  <Trans>External user</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Email</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Status</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Member</Trans>
                </th>
                <th className="py-1 font-medium">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((identity) => (
                <IdentityRow
                  key={identity.id}
                  connection={connection}
                  identity={identity}
                  members={props.members}
                  nameOf={props.nameOf}
                  onChanged={reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IdentityRow(props: {
  connection: Connection;
  identity: Identity;
  members: MemberOption[];
  nameOf: (subject: string) => string;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const { identity } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [subject, setSubject] = useState<string | null>(null);

  async function act(action: IdentityAction, chosen?: string) {
    setBusy(true);
    setError(null);
    try {
      await updateIdentity(props.connection.id, identity.id, action, chosen);
      setLinking(false);
      props.onChanged();
    } catch (err) {
      setError(messageOf(err, t`Could not change the identity.`));
    } finally {
      setBusy(false);
    }
  }

  const who = identity.display_name || identity.external_user_id;
  const guest = identity.status === "guest";
  const blocked = identity.status === "blocked";
  return (
    <>
      <tr className="border-t border-border align-top" data-identity-id={identity.id} data-identity-status={identity.status}>
        <td className="py-1.5 pr-2">
          {identity.display_name && <div>{identity.display_name}</div>}
          <code className="font-mono text-xs text-mw-text-muted">{identity.external_user_id}</code>
        </td>
        <td className="py-1.5 pr-2 break-all">{identity.email ?? "—"}</td>
        <td className="py-1.5 pr-2">
          <Badge variant={STATUS_VARIANTS[identity.status]}>{i18n._(STATUS_LABELS[identity.status])}</Badge>
        </td>
        <td className="py-1.5 pr-2 break-all">{identity.subject ? props.nameOf(identity.subject) : "—"}</td>
        <td className="py-1.5 text-right">
          <div className="flex flex-wrap justify-end gap-1.5">
            {guest ? (
              <span className="text-xs text-mw-text-muted" data-identity-guest-note="">
                <Trans>Guests cannot be linked</Trans>
              </span>
            ) : (
              <>
                {!blocked && !linking && (
                  <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => setLinking(true)}>
                    {identity.subject ? t`Link to another member…` : t`Link to a member…`}
                  </Button>
                )}
                {identity.subject && !blocked && (
                  <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void act("unmap")}>
                    <Trans>Unlink</Trans>
                  </Button>
                )}
                {blocked ? (
                  <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void act("unblock")}>
                    <Trans>Unblock</Trans>
                  </Button>
                ) : (
                  <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => void act("block")}>
                    <Trans>Block</Trans>
                  </Button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {(linking || error) && (
        <tr data-identity-link-form={linking ? identity.id : undefined}>
          <td colSpan={5} className="pb-2">
            {linking && (
              <div className="flex flex-wrap items-center gap-2">
                <SimpleSelect
                  aria-label={t`Member for ${who}`}
                  size="sm"
                  value={subject}
                  onValueChange={setSubject}
                  placeholder={t`Choose a member`}
                  options={props.members.map((member) => ({
                    value: member.subject,
                    label: memberOptionLabel(member),
                  }))}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || subject === null}
                  onClick={() => {
                    if (subject !== null) void act("map", subject);
                  }}
                >
                  {busy ? t`Linking…` : t`Link`}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setLinking(false)}>
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-mw-danger">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
