import { useId, useState, type FormEvent } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Alert } from "../../components/ui/alert";
import { Badge, StatusDot } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  OUTBOX_KIND_LABEL,
  applyInbound,
  fetchInbound,
  fetchOutbox,
  fetchSalesforce,
  formatWhen,
  linkOrgAccount,
  retryDeadOutbox,
  retryOutbox,
  syncSalesforce,
  testSalesforce,
  type InboundRow,
  type OutboxRow,
  type OutboxStatus,
  type SalesforceState,
} from "./integrationsApi";
import { shortId, useLoad } from "./useLoad";

/**
 * Integrations -> Salesforce: whether the CRM is configured and reachable,
 * when it last took a message, the outbox with its dead letters (each can
 * be sent again), the signed contract events Salesforce sent and what
 * became of them, and the link between an organisation and its Account.
 * Every action is audited by the API. docs/salesforce.md is the setup.
 */
export function IntegrationsTab() {
  const { t } = useLingui();
  const [state, reload] = useLoad(fetchSalesforce, "salesforce");
  const [attempt, setAttempt] = useState(0);
  const refresh = () => {
    reload();
    setAttempt((n) => n + 1);
  };
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load the Salesforce integration`} message={state.message} onRetry={reload} />;
  }
  return (
    <div className="space-y-8">
      <Connection state={state.data} onChanged={refresh} />
      <Outbox key={`outbox-${attempt}`} state={state.data} onChanged={refresh} />
      <Inbound key={`inbound-${attempt}`} onChanged={refresh} />
      <LinkAccount onChanged={refresh} />
    </div>
  );
}

function Connection({ state, onChanged }: { state: SalesforceState; onChanged: () => void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(action: () => Promise<{ text: string; ok: boolean }>) {
    setBusy(true);
    setResult(null);
    try {
      setResult(await action());
      onChanged();
    } catch (err) {
      setResult({ ok: false, text: failureMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  // fetchSalesforce fills the block in; this guards a state that came another way.
  const connection: Partial<SalesforceState["connection"]> = state.connection ?? {};
  const username = state.username;
  const lastError = connection.last_error;
  const lastErrorAt = formatWhen(connection.last_error_at ?? null);
  return (
    <section aria-labelledby="sf-connection">
      <h3 id="sf-connection" className="text-sm font-medium text-mw-text">
        Salesforce
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label={t`Salesforce connection`}>
        <dt className="text-mw-text-muted">
          <Trans>Outbound sync</Trans>
        </dt>
        <dd>
          {state.configured ? (
            <Badge variant="positive">
              <StatusDot tone="positive" />
              <Trans>configured</Trans>
            </Badge>
          ) : (
            <span>
              <Badge variant="secondary">
                <StatusDot tone="neutral" />
                <Trans>off</Trans>
              </Badge>{" "}
              <span className="text-mw-text-muted">
                <Trans>Set MW_SALESFORCE_CLIENT_ID, MW_SALESFORCE_USERNAME and MW_SALESFORCE_PRIVATE_KEY.</Trans>
              </span>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Contract events</Trans>
        </dt>
        <dd>
          {state.inbound_configured ? (
            <Badge variant="positive">
              <Trans>accepted</Trans>
            </Badge>
          ) : (
            <span>
              <Badge variant="destructive">
                <Trans>refused</Trans>
              </Badge>{" "}
              <span className="text-mw-text-muted">
                <Trans>Set MW_SALESFORCE_WEBHOOK_SECRET.</Trans>
              </span>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Event endpoint</Trans>
        </dt>
        <dd className="font-mono text-xs">{state.inbound_url}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Login</Trans>
        </dt>
        <dd>
          {state.login_url}
          {username && (
            <span className="ml-2 text-mw-text-muted">
              <Trans>as {username}</Trans>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Instance</Trans>
        </dt>
        <dd>{connection.instance_url ?? t`Not reached yet`}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Last success</Trans>
        </dt>
        <dd>{formatWhen(connection.last_ok_at ?? null)}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Last error</Trans>
        </dt>
        <dd>
          {lastError ? (
            <span className="text-mw-danger">
              <Trans>
                {lastError} ({lastErrorAt})
              </Trans>
            </span>
          ) : (
            t`None`
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Last sync</Trans>
        </dt>
        <dd>{formatWhen(state.last_sync_at)}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Accounts synced</Trans>
        </dt>
        <dd>
          {state.sync_scope === "all"
            ? t`Every organisation`
            : state.sync_scope === "linked"
              ? t`Linked organisations only`
              : t`Paid, trialing or linked organisations`}
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !state.configured}
          onClick={() =>
            void run(async () => {
              const answer = await testSalesforce();
              const user = answer.user;
              return answer.ok
                ? { ok: true, text: user ? t`Connected as ${user}.` : t`Connected.` }
                : { ok: false, text: answer.error ?? t`The connection failed.` };
            })
          }
        >
          <Trans>Test connection</Trans>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !state.configured}
          onClick={() =>
            void run(async () => {
              const answer = await syncSalesforce();
              const sent = Number(answer.report.sent ?? 0);
              return {
                ok: true,
                text: plural(sent, { one: "Sync ran: # message sent.", other: "Sync ran: # messages sent." }),
              };
            })
          }
        >
          <Trans>Sync now</Trans>
        </Button>
      </div>
      {result && (
        <Alert role={result.ok ? "status" : "alert"} variant={result.ok ? "success" : "danger"} className="mt-2">
          {result.text}
        </Alert>
      )}
    </section>
  );
}

const FILTERS: { id: OutboxStatus | null; title: MessageDescriptor }[] = [
  { id: null, title: msg`All` },
  { id: "pending", title: msg`Waiting` },
  { id: "dead", title: msg`Dead letters` },
  { id: "skipped", title: msg`Skipped` },
  { id: "sent", title: msg`Sent` },
];

const OUTBOX_STATUS_LABEL: Record<OutboxStatus, MessageDescriptor> = {
  pending: msg`pending`,
  sending: msg`sending`,
  sent: msg`sent`,
  dead: msg`dead`,
  skipped: msg`skipped`,
};

const INBOUND_STATUS_LABEL: Record<InboundRow["status"], MessageDescriptor> = {
  received: msg`received`,
  applied: msg`applied`,
  failed: msg`failed`,
  awaiting_link: msg`waiting for a link`,
};

function Outbox({ state, onChanged }: { state: SalesforceState; onChanged: () => void }) {
  const { t, i18n } = useLingui();
  const [filter, setFilter] = useState<OutboxStatus | null>(state.outbox.dead > 0 ? "dead" : null);
  const [rows, reload] = useLoad(() => fetchOutbox(filter), filter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      reload();
      onChanged();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const counts = state.outbox;
  const waiting = counts.pending + counts.sending;
  const sent = counts.sent;
  const dead = counts.dead;
  const skipped = counts.skipped;
  return (
    <section aria-labelledby="sf-outbox">
      <h3 id="sf-outbox" className="text-sm font-medium text-mw-text">
        <Trans>Outbox</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          {waiting} waiting, {sent} sent, {dead} dead, {skipped} skipped. A failed message is retried after 1 minute, 5
          minutes, 30 minutes, 2 hours and 12 hours, then kept here as a dead letter.
        </Trans>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label={t`Outbox filter`}>
        {FILTERS.map((f) => (
          <button
            key={f.id ?? "all"}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-lg px-3 py-1 text-sm ${filter === f.id ? "bg-mw-surface-raised font-medium" : "text-mw-text-muted"}`}
          >
            {i18n._(f.title)}
          </button>
        ))}
        {counts.dead > 0 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(retryDeadOutbox)}>
            <Trans>Retry all dead letters</Trans>
          </Button>
        )}
      </div>
      {error && (
        <Alert role="alert" variant="danger" className="mt-2">
          {error}
        </Alert>
      )}
      <div className="mt-2">
        {rows.phase === "loading" ? (
          <LoadingSkeleton rows={3} />
        ) : rows.phase === "error" ? (
          <ErrorState title={t`Could not load the outbox`} message={rows.message} onRetry={reload} />
        ) : rows.data.length === 0 ? (
          <EmptyState
            title={t`Nothing here`}
            description={t`Messages for the CRM appear here as the app records them.`}
          />
        ) : (
          <Table className="bg-card" aria-label={t`Outbox`}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Message</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Organisation</Trans>
                </TableHead>
                <TableHead>
                  <Trans>State</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Attempts</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Updated</Trans>
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((row) => (
                <OutboxLine key={row.id} row={row} busy={busy} onRetry={() => void act(() => retryOutbox(row.id))} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function OutboxLine({ row, busy, onRetry }: { row: OutboxRow; busy: boolean; onRetry: () => void }) {
  const { i18n } = useLingui();
  const kindLabel = OUTBOX_KIND_LABEL[row.kind];
  const label = kindLabel ? i18n._(kindLabel) : row.kind;
  return (
    <TableRow>
      <TableCell>
        {label}
        <div className="font-mono text-xs text-mw-text-muted">{row.kind}</div>
      </TableCell>
      <TableCell className="font-mono text-xs">{shortId(row.org_id)}</TableCell>
      <TableCell className="whitespace-normal">
        <OutboxBadge status={row.status} />
        {row.last_error && <div className="text-xs text-mw-text-muted">{row.last_error}</div>}
      </TableCell>
      <TableCell>{row.attempts}</TableCell>
      <TableCell>{formatWhen(row.updated_at)}</TableCell>
      <TableCell className="text-right">
        {(row.status === "dead" || row.status === "skipped") && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
            <Trans>Retry {label}</Trans>
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function OutboxBadge({ status }: { status: OutboxStatus }) {
  const { i18n } = useLingui();
  const variant = status === "dead" ? "destructive" : status === "sent" ? "positive" : "info";
  return <Badge variant={variant}>{i18n._(OUTBOX_STATUS_LABEL[status])}</Badge>;
}

function Inbound({ onChanged }: { onChanged: () => void }) {
  const { t } = useLingui();
  const [rows, reload] = useLoad(fetchInbound, "inbound");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(row: InboundRow) {
    setBusy(true);
    setError(null);
    try {
      await applyInbound(row.event_id);
      reload();
      onChanged();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sf-inbound">
      <h3 id="sf-inbound" className="text-sm font-medium text-mw-text">
        <Trans>Contract events</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          What Salesforce sent when a deal closed, and what it provisioned. One waiting for a link names an Account no
          organisation is linked to yet: link it below, then apply it.
        </Trans>
      </p>
      {error && (
        <Alert role="alert" variant="danger" className="mt-2">
          {error}
        </Alert>
      )}
      <div className="mt-2">
        {rows.phase === "loading" ? (
          <LoadingSkeleton rows={2} />
        ) : rows.phase === "error" ? (
          <ErrorState title={t`Could not load contract events`} message={rows.message} onRetry={reload} />
        ) : rows.data.length === 0 ? (
          <EmptyState
            title={t`No contract events yet`}
            description={t`A won opportunity in Salesforce appears here.`}
          />
        ) : (
          <Table className="bg-card" aria-label={t`Contract events`}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Contract</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Account</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Organisation</Trans>
                </TableHead>
                <TableHead>
                  <Trans>State</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Received</Trans>
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((row) => {
                const contractRef = row.contract_ref;
                return (
                <TableRow key={row.event_id} className="border-b border-mw-border">
                  <TableCell>
                    {row.contract_ref}
                    <div className="font-mono text-xs text-mw-text-muted">{row.event_id}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.account_id ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{shortId(row.org_id)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <InboundBadge status={row.status} />
                    {row.error && <div className="text-xs text-mw-text-muted">{row.error}</div>}
                  </TableCell>
                  <TableCell>{formatWhen(row.received_at)}</TableCell>
                  <TableCell className="text-right">
                    {(row.status === "failed" || row.status === "awaiting_link") && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void apply(row)}>
                        <Trans>Apply {contractRef}</Trans>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function InboundBadge({ status }: { status: InboundRow["status"] }) {
  const { i18n } = useLingui();
  const variant =
    status === "applied" ? "positive" : status === "failed" ? "destructive" : status === "awaiting_link" ? "warning" : "info";
  const label = INBOUND_STATUS_LABEL[status];
  return <Badge variant={variant}>{label ? i18n._(label) : status}</Badge>;
}

function LinkAccount({ onChanged }: { onChanged: () => void }) {
  const { t } = useLingui();
  const orgId = useId();
  const accountId = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const org = String(form.get("org_id") ?? "").trim();
    const account = String(form.get("account_id") ?? "").trim();
    if (!org) {
      setResult({ ok: false, text: t`The organisation id is needed.` });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const answer = await linkOrgAccount(org, account || null);
      const linkedAccount = answer.account_id;
      setResult({
        ok: true,
        text: linkedAccount
          ? answer.changed
            ? t`Linked to Account ${linkedAccount}.`
            : t`Linked to Account ${linkedAccount} (it already was).`
          : t`Unlinked.`,
      });
      onChanged();
    } catch (err) {
      setResult({ ok: false, text: failureMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sf-link">
      <h3 id="sf-link" className="text-sm font-medium text-mw-text">
        <Trans>Link an organisation to its Account</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          The Account then shows the organisation&apos;s plan, seats, invoices and late-payment stage, and its Stripe
          customer carries the Account id. Leave the Account empty to unlink.
        </Trans>
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-2 flex flex-wrap items-end gap-2">
        <label htmlFor={orgId} className="flex flex-col gap-1 text-sm">
          <Trans>Organisation id</Trans>
          <Input id={orgId} name="org_id" className="w-80 font-mono text-xs" />
        </label>
        <label htmlFor={accountId} className="flex flex-col gap-1 text-sm">
          <Trans>Salesforce Account id</Trans>
          <Input id={accountId} name="account_id" maxLength={18} className="w-52 font-mono text-xs" />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>
          <Trans>Save link</Trans>
        </Button>
      </form>
      {result && (
        <Alert role={result.ok ? "status" : "alert"} variant={result.ok ? "success" : "danger"} className="mt-2">
          {result.text}
        </Alert>
      )}
    </section>
  );
}
