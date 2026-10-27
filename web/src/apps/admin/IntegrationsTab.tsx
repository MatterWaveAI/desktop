import { useId, useState, type FormEvent } from "react";
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
  const [state, reload] = useLoad(fetchSalesforce, "salesforce");
  const [attempt, setAttempt] = useState(0);
  const refresh = () => {
    reload();
    setAttempt((n) => n + 1);
  };
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load the Salesforce integration" message={state.message} onRetry={reload} />;
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
  return (
    <section aria-labelledby="sf-connection">
      <h3 id="sf-connection" className="text-sm font-medium text-mw-text">
        Salesforce
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Salesforce connection">
        <dt className="text-mw-text-muted">Outbound sync</dt>
        <dd>
          {state.configured ? (
            <Badge variant="positive">
              <StatusDot tone="positive" />
              configured
            </Badge>
          ) : (
            <span>
              <Badge variant="secondary">
                <StatusDot tone="neutral" />
                off
              </Badge>{" "}
              <span className="text-mw-text-muted">
                Set MW_SALESFORCE_CLIENT_ID, MW_SALESFORCE_USERNAME and MW_SALESFORCE_PRIVATE_KEY.
              </span>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">Contract events</dt>
        <dd>
          {state.inbound_configured ? (
            <Badge variant="positive">accepted</Badge>
          ) : (
            <span>
              <Badge variant="destructive">refused</Badge>{" "}
              <span className="text-mw-text-muted">Set MW_SALESFORCE_WEBHOOK_SECRET.</span>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">Event endpoint</dt>
        <dd className="font-mono text-xs">{state.inbound_url}</dd>
        <dt className="text-mw-text-muted">Login</dt>
        <dd>
          {state.login_url}
          {state.username && <span className="ml-2 text-mw-text-muted">as {state.username}</span>}
        </dd>
        <dt className="text-mw-text-muted">Instance</dt>
        <dd>{connection.instance_url ?? "Not reached yet"}</dd>
        <dt className="text-mw-text-muted">Last success</dt>
        <dd>{formatWhen(connection.last_ok_at ?? null)}</dd>
        <dt className="text-mw-text-muted">Last error</dt>
        <dd>
          {connection.last_error ? (
            <span className="text-mw-danger">
              {connection.last_error} ({formatWhen(connection.last_error_at ?? null)})
            </span>
          ) : (
            "None"
          )}
        </dd>
        <dt className="text-mw-text-muted">Last sync</dt>
        <dd>{formatWhen(state.last_sync_at)}</dd>
        <dt className="text-mw-text-muted">Accounts synced</dt>
        <dd>
          {state.sync_scope === "all"
            ? "Every organisation"
            : state.sync_scope === "linked"
              ? "Linked organisations only"
              : "Paid, trialing or linked organisations"}
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
              return answer.ok
                ? { ok: true, text: `Connected${answer.user ? ` as ${answer.user}` : ""}.` }
                : { ok: false, text: answer.error ?? "The connection failed." };
            })
          }
        >
          Test connection
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !state.configured}
          onClick={() =>
            void run(async () => {
              const answer = await syncSalesforce();
              const sent = Number(answer.report.sent ?? 0);
              return { ok: true, text: `Sync ran: ${sent} message${sent === 1 ? "" : "s"} sent.` };
            })
          }
        >
          Sync now
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

const FILTERS: { id: OutboxStatus | null; title: string }[] = [
  { id: null, title: "All" },
  { id: "pending", title: "Waiting" },
  { id: "dead", title: "Dead letters" },
  { id: "skipped", title: "Skipped" },
  { id: "sent", title: "Sent" },
];

function Outbox({ state, onChanged }: { state: SalesforceState; onChanged: () => void }) {
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
  return (
    <section aria-labelledby="sf-outbox">
      <h3 id="sf-outbox" className="text-sm font-medium text-mw-text">
        Outbox
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        {counts.pending + counts.sending} waiting, {counts.sent} sent, {counts.dead} dead, {counts.skipped} skipped.
        A failed message is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then kept here as a
        dead letter.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label="Outbox filter">
        {FILTERS.map((f) => (
          <button
            key={f.title}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-lg px-3 py-1 text-sm ${filter === f.id ? "bg-mw-surface-raised font-medium" : "text-mw-text-muted"}`}
          >
            {f.title}
          </button>
        ))}
        {counts.dead > 0 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(retryDeadOutbox)}>
            Retry all dead letters
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
          <ErrorState title="Could not load the outbox" message={rows.message} onRetry={reload} />
        ) : rows.data.length === 0 ? (
          <EmptyState title="Nothing here" description="Messages for the CRM appear here as the app records them." />
        ) : (
          <Table className="bg-card" aria-label="Outbox">
            <TableHeader>
              <TableRow>
                <TableHead>Message</TableHead>
                <TableHead>Organisation</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
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
  const label = OUTBOX_KIND_LABEL[row.kind] ?? row.kind;
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
            Retry {label}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function OutboxBadge({ status }: { status: OutboxStatus }) {
  if (status === "dead") return <Badge variant="destructive">dead</Badge>;
  if (status === "sent") return <Badge variant="positive">sent</Badge>;
  return <Badge variant="info">{status}</Badge>;
}

function Inbound({ onChanged }: { onChanged: () => void }) {
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
        Contract events
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        What Salesforce sent when a deal closed, and what it provisioned. One waiting for a link names an Account no
        organisation is linked to yet: link it below, then apply it.
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
          <ErrorState title="Could not load contract events" message={rows.message} onRetry={reload} />
        ) : rows.data.length === 0 ? (
          <EmptyState title="No contract events yet" description="A won opportunity in Salesforce appears here." />
        ) : (
          <Table className="bg-card" aria-label="Contract events">
            <TableHeader>
              <TableRow>
                <TableHead>Contract</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Organisation</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((row) => (
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
                        Apply {row.contract_ref}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function InboundBadge({ status }: { status: InboundRow["status"] }) {
  if (status === "applied") return <Badge variant="positive">applied</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  if (status === "awaiting_link") return <Badge variant="warning">waiting for a link</Badge>;
  return <Badge variant="info">{status}</Badge>;
}

function LinkAccount({ onChanged }: { onChanged: () => void }) {
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
      setResult({ ok: false, text: "The organisation id is needed." });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const answer = await linkOrgAccount(org, account || null);
      setResult({
        ok: true,
        text: answer.account_id
          ? `Linked to Account ${answer.account_id}${answer.changed ? "" : " (it already was)"}.`
          : "Unlinked.",
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
        Link an organisation to its Account
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        The Account then shows the organisation's plan, seats, invoices and late-payment stage, and its Stripe customer
        carries the Account id. Leave the Account empty to unlink.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-2 flex flex-wrap items-end gap-2">
        <label htmlFor={orgId} className="flex flex-col gap-1 text-sm">
          Organisation id
          <Input id={orgId} name="org_id" className="w-80 font-mono text-xs" />
        </label>
        <label htmlFor={accountId} className="flex flex-col gap-1 text-sm">
          Salesforce Account id
          <Input id={accountId} name="account_id" maxLength={18} className="w-52 font-mono text-xs" />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>
          Save link
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
