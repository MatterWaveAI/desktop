import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Badge, StatusDot } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { formatDateTime } from "../../../i18n/format";
import { managesOrg } from "../../../lib/auth";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { RowList } from "../rows";
import { SectionTabs } from "./organisation/SectionTabs";
import { ConnectionEvents } from "./connections/ConnectionEvents";
import { ConnectionIdentities } from "./connections/ConnectionIdentities";
import { ConnectionNotifications } from "./connections/ConnectionNotifications";
import { ConnectionRouting } from "./connections/ConnectionRouting";
import { ConnectSlackWizard } from "./connections/ConnectSlackWizard";
import {
  CONNECTOR_LABELS,
  SLACK,
  credentialsFailure,
  deleteConnection,
  featureOff,
  fetchConnections,
  fetchMemberOptions,
  fetchPresetOptions,
  fieldErrors,
  memberLabelOf,
  messageOf,
  rotateConnectionUrl,
  updateConnection,
  type Connection,
  type ConnectionListing,
  type ConnectionStatus,
  type MemberOption,
  type PresetOption,
} from "./connections/connectionsApi";

/**
 * Connections: the chat workspaces (Slack first) that can ask this
 * organisation's presets a question, and everything that governs one --
 * which channels are answered and on whose budget (Routing), who the
 * people asking are (Identities), what each event became (Trigger log)
 * and where administrative notices go (Notifications). Each connection is
 * a row; Manage opens those four under it.
 *
 * For owners and admins by membership (`org_role`), enforced the same way
 * by the API, whose listing refuses anyone else; a member sees what the
 * pane is for and nothing to press.
 */

/** A connection's state, as its row says it. */
const STATUS_LABELS: Record<ConnectionStatus, MessageDescriptor> = {
  pending: msg`Waiting for the app to be installed`,
  active: msg`Active`,
  disabled: msg`Disabled`,
  revoked: msg`Removed from the workspace`,
  error: msg`Not working`,
};

const STATUS_TONES: Record<ConnectionStatus, "positive" | "info" | "warning" | "danger" | "neutral"> = {
  pending: "info",
  active: "positive",
  disabled: "neutral",
  revoked: "danger",
  error: "danger",
};

/** The credentials each connector takes, as the replace dialog asks for them. */
const CREDENTIAL_FIELDS: Record<string, Array<{ key: string; label: MessageDescriptor }>> = {
  slack: [
    { key: "bot_token", label: msg`Bot token` },
    { key: "signing_secret", label: msg`Signing secret` },
  ],
};

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return formatDateTime(iso, { dateStyle: "medium", timeStyle: "short" }) || iso;
}

export function ConnectionsPane() {
  const { t } = useLingui();
  const { principal } = useShell();
  if (!managesOrg(principal)) {
    return (
      <EmptyState
        title={t`Connections are for admins`}
        description={t`Workspaces that can ask this organisation's presets a question are connected by an administrator. Ask one to make changes here.`}
      />
    );
  }
  return <ConnectionsAdmin />;
}

interface Loaded {
  listing: ConnectionListing;
  members: MemberOption[];
  presets: PresetOption[];
}

function ConnectionsAdmin() {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after every action: the list is re-read from the API rather
  // than patched locally, so what the pane shows is what the API holds.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [connecting, setConnecting] = useState(false);
  /** The row whose Routing, Identities, log and notifications are open. */
  const [managing, setManaging] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The members name who installed a connection and who pays for a
    // route; the presets fill the routing select. Both are what the API
    // offers every member, so they cannot refuse an admin.
    Promise.all([fetchConnections(), fetchMemberOptions(), fetchPresetOptions()])
      .then(([listing, members, presets]) => {
        if (cancelled) return;
        setLoaded({ listing, members, presets });
        setLoadError(null);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded(null);
        const off = featureOff(err);
        setUnavailable(off);
        setLoadError(off ? null : messageOf(err, t`Could not load the connections.`));
      });
    return () => {
      cancelled = true;
    };
  }, [version, t]);

  if (unavailable) {
    return (
      <EmptyState
        title={t`Not available on this deployment`}
        description={t`Connectors are not switched on here, so there is no workspace to connect. Whoever runs this deployment can turn them on.`}
      />
    );
  }

  const canConnectSlack = loaded?.listing.connectors.includes(SLACK) ?? false;
  const nameOf = memberLabelOf(loaded?.members ?? []);

  return (
    <div className="flex flex-col gap-7">
      {loaded !== null && !loadError && canConnectSlack && (
        <PaneActions>
          <Button type="button" size="lg" onClick={() => setConnecting(true)}>
            <Trans>Connect Slack…</Trans>
          </Button>
        </PaneActions>
      )}
      <PaneSection
        title={t`Connections`}
        flush
        description={t`Each connection is one workspace whose mentions are answered by the presets its routing names.`}
      >
        {loadError ? (
          <div className="px-5 py-4">
            <ErrorState title={t`Could not load the connections`} message={loadError} onRetry={reload} />
          </div>
        ) : loaded === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={3} />
          </div>
        ) : loaded.listing.data.length === 0 ? (
          <EmptyState
            title={t`No connections yet`}
            description={
              canConnectSlack
                ? t`Connect a Slack workspace to have @MatterWave answered in its channels by a preset of your choosing.`
                : t`No connector is available on this deployment.`
            }
          />
        ) : (
          <RowList aria-label={t`Connections`}>
            {loaded.listing.data.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                listing={loaded.listing}
                members={loaded.members}
                presets={loaded.presets}
                nameOf={nameOf}
                managing={managing === connection.id}
                onManage={() => setManaging(managing === connection.id ? null : connection.id)}
                onChanged={reload}
              />
            ))}
          </RowList>
        )}
        <LearnMore className="border-t border-border px-5 py-3">
          <p>
            <Trans>
              Only channels listed in a connection&apos;s routing are answered, and only people mapped to a
              member of this organisation are. Each answer is charged to the route&apos;s paying member and
              counts against their cap.
            </Trans>
          </p>
          <p>
            <Trans>
              The trigger log keeps ids and outcomes, never what anyone wrote. What was said lives in the
              conversation, which belongs to the paying member.
            </Trans>
          </p>
        </LearnMore>
      </PaneSection>
      {loaded !== null && canConnectSlack && (
        <ConnectSlackWizard
          open={connecting}
          onOpenChange={setConnecting}
          onConnected={(connection) => {
            setConnecting(false);
            setManaging(connection.id);
            reload();
          }}
        />
      )}
    </div>
  );
}

// --- one connection ---------------------------------------------------------------

function ConnectionRow(props: {
  connection: Connection;
  listing: ConnectionListing;
  members: MemberOption[];
  presets: PresetOption[];
  nameOf: (subject: string) => string;
  managing: boolean;
  onManage: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const { connection } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"rate" | "rotate" | "credentials" | "remove" | null>(null);
  /** The connection as it stands after a rotation, until Done: the dialog shows its new URL. */
  const [rotated, setRotated] = useState<Connection | null>(null);

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

  const setStatus = (status: "active" | "disabled") =>
    run(async () => {
      await updateConnection(connection.id, { status });
      props.onChanged();
    }, status === "active" ? t`Could not enable the connection.` : t`Could not disable the connection.`);

  const rotate = () =>
    run(async () => {
      const next = await rotateConnectionUrl(connection.id);
      setDialog(null);
      setRotated(next);
      props.onChanged();
    }, t`Could not rotate the URL.`);

  const remove = () =>
    run(async () => {
      await deleteConnection(connection.id);
      setDialog(null);
      props.onChanged();
    }, t`Could not remove the connection.`);

  const connectorLabel = CONNECTOR_LABELS[connection.connector]
    ? i18n._(CONNECTOR_LABELS[connection.connector])
    : connection.connector;
  const displayName = connection.display_name;
  const installedBy = props.nameOf(connection.installed_by);
  const installedAt = formatWhen(connection.created_at);
  const lastEvent = formatWhen(connection.last_event_at);
  const switchable = connection.status === "active" || connection.status === "disabled";
  // A pending connection has no app yet: nothing to route, nobody heard
  // from, no credentials to replace. It can only be removed.
  const installed = connection.status !== "pending";
  const tabs = [
    {
      id: "routing",
      label: t`Routing`,
      content: (
        <ConnectionRouting
          connection={connection}
          presets={props.presets}
          members={props.members}
          nameOf={props.nameOf}
        />
      ),
    },
    {
      id: "identities",
      label: t`Identities`,
      content: (
        <ConnectionIdentities
          connection={connection}
          statuses={props.listing.identity_statuses}
          members={props.members}
          nameOf={props.nameOf}
        />
      ),
    },
    {
      id: "events",
      label: t`Trigger log`,
      content: <ConnectionEvents connection={connection} outcomes={props.listing.outcomes} nameOf={props.nameOf} />,
    },
    {
      id: "notifications",
      label: t`Notifications`,
      content: (
        <ConnectionNotifications
          connection={connection}
          events={props.listing.notifiable_events}
          onChanged={props.onChanged}
        />
      ),
    },
  ];

  return (
    // Not a rows.tsx Row: the four sections need the row's full width under
    // its head. The head is laid out as a Row is.
    <li
      className="flex flex-col gap-3 px-5 py-4"
      data-connection-id={connection.id}
      data-connection-status={connection.status}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1 leading-snug">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium break-words">{connection.display_name}</span>
            <Badge variant="outline">{connectorLabel}</Badge>
          </span>
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-mw-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={STATUS_TONES[connection.status]} />
              <span data-testid="connection-status">{i18n._(STATUS_LABELS[connection.status])}</span>
            </span>
            {connection.last_event_at ? (
              <span>
                · <Trans>Last event {lastEvent}</Trans>
              </span>
            ) : (
              <span>
                · <Trans>No events yet</Trans>
              </span>
            )}
            <span>
              · <Trans>Connected by {installedBy}, {installedAt}</Trans>
            </span>
          </div>
          {connection.last_error && connection.status === "error" && (
            <p className="text-sm text-mw-danger" data-connection-error="">
              {connection.last_error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {installed && (
            <Button
              type="button"
              variant={props.managing ? "secondary" : "outline"}
              size="sm"
              aria-expanded={props.managing}
              onClick={props.onManage}
            >
              {props.managing ? t`Close` : t`Manage`}
            </Button>
          )}
          {switchable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void setStatus(connection.status === "active" ? "disabled" : "active")}
            >
              {connection.status === "active" ? t`Disable` : t`Enable`}
            </Button>
          )}
          {installed && (
            <>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog("rate")}>
                <Trans>Rate limit…</Trans>
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog("rotate")}>
                <Trans>Rotate URL…</Trans>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setDialog("credentials")}
              >
                <Trans>Replace credentials…</Trans>
              </Button>
            </>
          )}
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => setDialog("remove")}>
            <Trans>Remove…</Trans>
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      {props.managing && installed && (
        <div className="border-t border-border pt-3" data-connection-detail="">
          <SectionTabs label={t`Sections of ${displayName}`} tabs={tabs} />
        </div>
      )}
      <RateLimitDialog
        open={dialog === "rate"}
        connection={connection}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSaved={() => {
          setDialog(null);
          props.onChanged();
        }}
      />
      <DestructiveConfirm
        open={dialog === "rotate"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t`Rotate the URL of ${displayName}?`}
        description={t`The current URL stops accepting events now. The app's Request URL in the workspace (for Slack, under Event Subscriptions) must be updated to the new one, which is shown next.`}
        confirmLabel={t`Rotate URL`}
        onConfirm={() => void rotate()}
        inFlight={busy}
      />
      <CredentialsDialog
        open={dialog === "credentials"}
        connection={connection}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSaved={() => {
          setDialog(null);
          props.onChanged();
        }}
      />
      <DestructiveConfirm
        open={dialog === "remove"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t`Remove ${displayName}?`}
        description={t`Its routing, identities and trigger log go with it, and the workspace is no longer answered. The conversations it opened stay with their paying members. Uninstall the app from the workspace as well.`}
        confirmLabel={t`Remove connection`}
        onConfirm={() => void remove()}
        inFlight={busy}
      />
      <IngressUrlDialog connection={rotated} onDone={() => setRotated(null)} />
    </li>
  );
}

// --- the new URL, after a rotation -----------------------------------------------------

function IngressUrlDialog(props: { connection: Connection | null; onDone: () => void }) {
  const { t } = useLingui();
  const url = props.connection?.ingress_url ?? "";
  return (
    <Dialog
      open={props.connection !== null}
      onOpenChange={(open) => {
        if (!open) props.onDone();
      }}
    >
      <DialogContent data-connection-url-dialog="" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>The new Request URL</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Put this in the app&apos;s Request URL in the workspace. Until then, nothing it sends is
              accepted.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid="connection-ingress-url"
            className="min-w-0 flex-1 basis-60 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm break-all"
          >
            {url}
          </code>
          {url && <CopyButton text={url} label={t`Copy URL`} size="default" />}
        </div>
        <DialogFooter>
          <Button type="button" onClick={props.onDone}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- the rate limit ---------------------------------------------------------------------

function RateLimitDialog(props: {
  open: boolean;
  connection: Connection;
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
      <DialogContent data-connection-rate-dialog="" className="sm:max-w-md">
        {/* Mounted per opening so the field starts from the current limit. */}
        {props.open && (
          <RateLimitForm
            connection={props.connection}
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

function RateLimitForm(props: {
  connection: Connection;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { busy, setBusy } = props;
  const [value, setValue] = useState(
    props.connection.rate_limit_per_minute === null ? "" : String(props.connection.rate_limit_per_minute),
  );
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const limit = Number(value);
  const valid = /^\d+$/.test(value.trim()) && limit >= 1 && limit <= 10_000;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateConnection(props.connection.id, { rate_limit_per_minute: limit });
      props.onSaved();
    } catch (err) {
      const perField = fieldErrors(err);
      setError(perField.rate_limit_per_minute ?? messageOf(err, t`Could not change the rate limit.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate aria-busy={busy} onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>
          <Trans>Rate limit</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            How many mentions this connection answers per minute across all its channels. Past it, a
            mention is refused with a note to the person and logged as rate limited.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm text-mw-text-muted">
          <Trans>Mentions per minute</Trans>
        </label>
        <Input
          id={fieldId}
          name="rate_limit_per_minute"
          type="number"
          inputMode="numeric"
          min={1}
          max={10_000}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="text-xs text-mw-text-muted">
          <Trans>Between 1 and 10,000.</Trans>
        </p>
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
        <Button type="submit" disabled={!valid || busy}>
          {busy ? t`Saving…` : t`Save limit`}
        </Button>
      </DialogFooter>
    </form>
  );
}

// --- replacing credentials ----------------------------------------------------------

function CredentialsDialog(props: {
  open: boolean;
  connection: Connection;
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
      <DialogContent data-connection-credentials-dialog="" className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {/* Mounted per opening: a secret typed and cancelled is not kept. */}
        {props.open && (
          <CredentialsForm
            connection={props.connection}
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

function CredentialsForm(props: {
  connection: Connection;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useLingui();
  const { busy, setBusy } = props;
  const fields = CREDENTIAL_FIELDS[props.connection.connector] ?? null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();

  /** What the form sends: the named fields, or the JSON typed for a connector without a known shape. */
  function credentials(): Record<string, unknown> | null {
    if (fields) {
      const entries = fields.map((field) => [field.key, (values[field.key] ?? "").trim()] as const);
      if (entries.some(([, value]) => value === "")) return null;
      return Object.fromEntries(entries);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  const ready = credentials() !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = credentials();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateConnection(props.connection.id, { credentials: body });
      props.onSaved();
    } catch (err) {
      setError(credentialsFailure(err, t`Could not replace the credentials.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate aria-busy={busy} onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>
          <Trans>Replace the credentials</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            They are checked with the workspace before anything changes, and kept encrypted. The old
            ones stop being used at once.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      {fields ? (
        fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <label htmlFor={`${baseId}-${field.key}`} className="text-sm text-mw-text-muted">
              {i18n._(field.label)}
            </label>
            <Input
              id={`${baseId}-${field.key}`}
              name={field.key}
              type="password"
              autoComplete="off"
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
            />
          </div>
        ))
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${baseId}-raw`} className="text-sm text-mw-text-muted">
            <Trans>Credentials (JSON)</Trans>
          </label>
          <Textarea
            id={`${baseId}-raw`}
            name="credentials"
            rows={4}
            className="font-mono"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!ready || busy}>
          {busy ? t`Checking…` : t`Replace credentials`}
        </Button>
      </DialogFooter>
    </form>
  );
}
