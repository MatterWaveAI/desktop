import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Alert } from "../../../components/ui/alert";
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
import { SimpleSelect } from "../../../components/ui/select";
import { ApiError, apiFetch } from "../../../lib/api";
import { managesOrg } from "../../../lib/auth";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { RowList } from "../rows";

/**
 * Webhooks: the endpoints this organisation's own systems receive events
 * at, their delivery log, and the one rule the pane is shaped around --
 * the signing secret is shown once. The create and rotate responses are
 * the only places it exists, so each opens a dialog that holds the secret
 * beside the code that verifies it, and nothing else on the pane can
 * show it again. The list carries the URL, the subscription and the
 * state; the log carries what the receiver answered.
 *
 * For owners and admins by membership (`org_role`), enforced the same way
 * by the API; a member sees what the pane is for and nothing to press.
 */

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  failure_count: number;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

/** The create and rotate responses: the endpoint plus its secret, once. */
export interface RevealedSecret extends WebhookEndpoint {
  secret: string;
  shown_once: true;
  verification: { python: string; node: string };
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  event_id: string;
  payload: unknown;
  attempt: number;
  status: "pending" | "sending" | "delivered" | "failed";
  response_code: number | null;
  response_ms: number | null;
  response_excerpt: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_FILTERS = ["all", "pending", "sending", "delivered", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** What each event means, beside its name in the checklist. */
const EVENT_HINTS: Record<string, string> = {
  "api_key.revoked": "An API key was revoked.",
  "budget.exhausted": "The monthly budget is used up.",
  "budget.warn": "Spend crossed 80% of the monthly budget.",
  "conversation.created": "Someone started a conversation (its id, never its content).",
  "member.joined": "Someone accepted an invitation.",
  "member.removed": "Someone was removed from the organisation.",
  "message.completed": "An assistant turn finished, with its token counts.",
  "plan.changed": "The organisation's plan moved.",
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * A 422's per-field messages, keyed by field. The API answers a bad URL
 * or subscription under its field (routes_webhooks.py) so the form can
 * show the reason where it was typed rather than above the whole form.
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

/**
 * The listing's 503 is the route's store dependency refusing: no signing
 * key or no Postgres on this deployment. That is the operator's setting,
 * not something an org admin can fix or retry, so it is not an error here.
 */
function featureOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function WebhooksPane() {
  const { principal } = useShell();
  if (!managesOrg(principal)) {
    return (
      <EmptyState
        title="Webhooks are for admins"
        description="Endpoints that receive this organisation's events are set up by an administrator. Ask one to make changes here."
      />
    );
  }
  return <WebhooksAdmin />;
}

interface Listing {
  endpoints: WebhookEndpoint[];
  events: string[];
}

function WebhooksAdmin() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after every action: the list is re-read from the API rather
  // than patched locally, so what the pane shows is what the API holds.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [creating, setCreating] = useState(false);
  /** The secret just created or rotated, until Done. */
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: WebhookEndpoint[]; events: string[] }>("/api/org/webhooks")
      .then((body) => {
        if (cancelled) return;
        setListing({ endpoints: body.data, events: body.events });
        setLoadError(null);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListing(null);
        const off = featureOff(err);
        setUnavailable(off);
        setLoadError(off ? null : messageOf(err, "Could not load the webhook endpoints."));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const reveal = (secret: RevealedSecret) => {
    setRevealed(secret);
    reload();
  };

  if (unavailable) {
    return (
      <EmptyState
        title="Not available on this deployment"
        description="Webhooks are not switched on here, so there are no endpoints to set up. Whoever runs this deployment can turn them on."
      />
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <SecretDialog revealed={revealed} onDone={() => setRevealed(null)} />
      {listing !== null && !loadError && (
        <PaneActions>
          <Button type="button" size="lg" onClick={() => setCreating(true)}>
            Add endpoint…
          </Button>
        </PaneActions>
      )}
      <PaneSection
        title="Endpoints"
        flush
        description="Each endpoint gets a signed POST for every event it subscribes to."
      >
        {loadError ? (
          <div className="px-5 py-4">
            <ErrorState title="Could not load the endpoints" message={loadError} onRetry={reload} />
          </div>
        ) : listing === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={3} />
          </div>
        ) : (
          <>
            {listing.endpoints.length === 0 ? (
              <EmptyState
                title="No endpoints yet"
                description="Add one to have events from this organisation posted to a URL you run."
              />
            ) : (
              <RowList aria-label="Webhook endpoints">
                {listing.endpoints.map((endpoint) => (
                  <EndpointRow
                    key={endpoint.id}
                    endpoint={endpoint}
                    onChanged={reload}
                    onRevealed={reveal}
                  />
                ))}
              </RowList>
            )}
            <CreateDialog
              open={creating}
              events={listing.events}
              onOpenChange={setCreating}
              onCreated={(created) => {
                setCreating(false);
                reveal(created);
              }}
            />
          </>
        )}
        <LearnMore className="border-t border-border px-5 py-3">
          <p>
            Payloads carry ids, roles, counts and plan codes, never conversation content. After five
            consecutive failures an endpoint is disabled and the owners are told.
          </p>
        </LearnMore>
      </PaneSection>
    </div>
  );
}

// --- the secret, once ---------------------------------------------------------

/**
 * The one place the secret is visible. Not dismissable by Escape or the
 * backdrop: closing it is an acknowledgement, and an accidental close
 * would be a secret nobody copied.
 */
function SecretDialog(props: { revealed: RevealedSecret | null; onDone: () => void }) {
  const { revealed } = props;
  const [tab, setTab] = useState<"python" | "node">("python");
  return (
    // Escape and the backdrop are ignored: only Done closes it.
    <Dialog open={revealed !== null} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} data-webhook-secret-dialog="" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Your signing secret</DialogTitle>
          <DialogDescription>
            This is the only time it is shown. Every delivery to{" "}
            <span className="break-all font-mono">{revealed?.url ?? ""}</span> carries a{" "}
            <code className="font-mono">MatterWave-Signature</code> header computed with it; verify
            that header before trusting a payload. Lose it and rotate the secret to get another.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="success" title="Copy the secret now. It will not be shown again.">
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code
              data-testid="webhook-secret"
              className="min-w-0 flex-1 basis-60 break-all rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
            >
              {revealed?.secret ?? ""}
            </code>
            {revealed && <CopyButton text={revealed.secret} label="Copy secret" size="default" />}
          </div>
        </Alert>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Verification snippet">
            {(["python", "node"] as const).map((language) => (
              <button
                key={language}
                type="button"
                role="tab"
                aria-selected={tab === language}
                className={`rounded-md border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  tab === language
                    ? "border-border-emphasis bg-mw-surface-active font-medium text-foreground"
                    : "border-border text-mw-text-muted hover:bg-mw-surface-hover"
                }`}
                onClick={() => setTab(language)}
              >
                {language === "python" ? "Python" : "Node"}
              </button>
            ))}
            {revealed && (
              <span className="ml-auto">
                <CopyButton text={revealed.verification[tab]} label="Copy snippet" />
              </span>
            )}
          </div>
          <pre
            data-testid="verification-snippet"
            className="max-h-64 overflow-auto rounded-lg border border-border bg-mw-surface-hover p-3 font-mono text-xs"
          >
            {revealed?.verification[tab] ?? ""}
          </pre>
        </div>
        <DialogFooter>
          <Button type="button" onClick={props.onDone}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- creating one -----------------------------------------------------------------

function CreateDialog(props: {
  open: boolean;
  events: string[];
  onOpenChange: (open: boolean) => void;
  onCreated: (created: RevealedSecret) => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const urlId = useId();
  const descriptionId = useId();

  const toggle = (event: string) =>
    setEvents((current) => {
      const next = new Set(current);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });

  const reset = () => {
    setUrl("");
    setDescription("");
    setEvents(new Set());
    setError(null);
    setFields({});
  };

  const canCreate = url.trim().length > 0 && events.size > 0 && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const created = await apiFetch<RevealedSecret>("/api/org/webhooks", {
        method: "POST",
        json: {
          url: url.trim(),
          events: props.events.filter((name) => events.has(name)),
          description: description.trim(),
        },
      });
      reset();
      props.onCreated(created);
    } catch (err) {
      const perField = fieldErrors(err);
      setFields(perField);
      setError(
        Object.keys(perField).length > 0 ? null : messageOf(err, "Could not add the endpoint."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (busy) return;
        if (!open) reset();
        props.onOpenChange(open);
      }}
    >
      <DialogContent data-webhook-create-dialog="" className="sm:max-w-lg">
        <form noValidate aria-busy={busy} onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>Add an endpoint</DialogTitle>
            <DialogDescription>
              An https URL you run. It must be reachable from the internet; private and local
              addresses are refused.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId} className="text-sm text-mw-text-muted">
              URL
            </label>
            <Input
              id={urlId}
              name="url"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://example.com/matterwave"
              value={url}
              aria-invalid={fields.url ? true : undefined}
              onChange={(e) => setUrl(e.target.value)}
            />
            {fields.url && (
              <p role="alert" className="text-sm text-mw-danger">
                {fields.url}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={descriptionId} className="text-sm text-mw-text-muted">
              Description <span className="text-mw-text-muted">(optional)</span>
            </label>
            <Input
              id={descriptionId}
              name="description"
              maxLength={200}
              placeholder="e.g. Ops channel"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1 text-sm font-medium">Events</legend>
            {props.events.map((name) => (
              <label key={name} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  name="events"
                  value={name}
                  checked={events.has(name)}
                  onChange={() => toggle(name)}
                />
                <span>
                  <code className="font-mono">{name}</code>
                  {EVENT_HINTS[name] && (
                    <span className="ml-2 text-mw-text-muted">{EVENT_HINTS[name]}</span>
                  )}
                </span>
              </label>
            ))}
            {fields.events && (
              <p role="alert" className="text-sm text-mw-danger">
                {fields.events}
              </p>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-mw-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                props.onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {busy ? "Adding…" : "Add endpoint"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- one endpoint ---------------------------------------------------------------

function EndpointRow(props: {
  endpoint: WebhookEndpoint;
  onChanged: () => void;
  onRevealed: (secret: RevealedSecret) => void;
}) {
  const { endpoint } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<WebhookDelivery | null>(null);
  const [showingLog, setShowingLog] = useState(false);
  const [confirming, setConfirming] = useState<"rotate" | "delete" | null>(null);

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

  const sendTest = () =>
    run(async () => {
      setTestResult(null);
      const result = await apiFetch<WebhookDelivery>(`/api/org/webhooks/${endpoint.id}/test`, {
        method: "POST",
      });
      setTestResult(result);
    }, "Could not send the test event.");

  const setEnabled = (enabled: boolean) =>
    run(async () => {
      await apiFetch(`/api/org/webhooks/${endpoint.id}`, { method: "PATCH", json: { enabled } });
      props.onChanged();
    }, enabled ? "Could not enable the endpoint." : "Could not disable the endpoint.");

  const rotate = () =>
    run(async () => {
      const rotated = await apiFetch<RevealedSecret>(`/api/org/webhooks/${endpoint.id}/rotate`, {
        method: "POST",
      });
      setConfirming(null);
      props.onRevealed(rotated);
    }, "Could not rotate the secret.");

  const remove = () =>
    run(async () => {
      await apiFetch(`/api/org/webhooks/${endpoint.id}`, { method: "DELETE" });
      setConfirming(null);
      props.onChanged();
    }, "Could not delete the endpoint.");

  return (
    // Not a rows.tsx Row: the e2e specs find an endpoint by the li's
    // data-endpoint-url, and the test result and delivery log need the
    // row's full width under it. The head is laid out as a Row is.
    <li className="flex flex-col gap-3 px-5 py-4" data-endpoint-url={endpoint.url}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1 leading-snug">
          <span className="font-mono text-sm font-medium break-all">{endpoint.url}</span>
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-mw-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={endpoint.enabled ? "positive" : "danger"} />
              <span className={endpoint.enabled ? "text-mw-positive" : "text-mw-danger"}>
                {endpoint.enabled
                  ? "Enabled"
                  : `Disabled${endpoint.failure_count > 0 ? ` after ${endpoint.failure_count} failures` : ""}`}
              </span>
            </span>
            {endpoint.description && <span className="break-words">· {endpoint.description}</span>}
            <span>
              · Added {formatWhen(endpoint.created_at)}
              {endpoint.disabled_at && ` · Disabled ${formatWhen(endpoint.disabled_at)}`}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1" aria-label={`Events for ${endpoint.url}`}>
            {endpoint.events.map((name) => (
              <Badge key={name} variant="outline">
                {name}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void sendTest()}>
            Send test
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={showingLog}
            onClick={() => setShowingLog((on) => !on)}
          >
            {showingLog ? "Hide deliveries" : "Deliveries"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void setEnabled(!endpoint.enabled)}
          >
            {endpoint.enabled ? "Disable" : "Enable"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming("rotate")}>
            Rotate secret…
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => setConfirming("delete")}
          >
            Delete…
          </Button>
        </div>
      </div>
      {testResult && <TestResult delivery={testResult} />}
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      {showingLog && <DeliveryLog endpoint={endpoint} />}
      <DestructiveConfirm
        open={confirming === "rotate"}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Rotate the signing secret?"
        description="A new secret is shown once. The old one stops signing immediately, so update the receiver before the next event or its deliveries will fail verification."
        confirmLabel="Rotate secret"
        onConfirm={() => void rotate()}
        inFlight={busy}
      />
      <DestructiveConfirm
        open={confirming === "delete"}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`Delete ${endpoint.url}?`}
        description="No further events are sent to it, and its delivery log goes with it. This cannot be undone; add the endpoint again to get a new secret."
        confirmLabel="Delete endpoint"
        onConfirm={() => void remove()}
        inFlight={busy}
      />
    </li>
  );
}

function StatusBadge(props: { status: WebhookDelivery["status"] }) {
  const variant =
    props.status === "delivered" ? "outline" : props.status === "failed" ? "destructive" : "secondary";
  return <Badge variant={variant}>{props.status}</Badge>;
}

/** What the test event got back, beside the button that sent it. */
function TestResult(props: { delivery: WebhookDelivery }) {
  const { delivery } = props;
  const ok = delivery.status === "delivered";
  return (
    <Alert
      role="status"
      data-test-result={delivery.status}
      variant={ok ? "success" : "warning"}
      title={
        <>
          {ok ? "The receiver accepted the test event" : "The test event was not accepted"}
          {delivery.response_code !== null && ` · HTTP ${delivery.response_code}`}
          {delivery.response_ms !== null && ` · ${delivery.response_ms} ms`}
        </>
      }
    >
      {(delivery.last_error || delivery.response_excerpt) && (
        <div className="flex flex-col gap-1.5">
          {delivery.last_error && <p>{delivery.last_error}</p>}
          {delivery.response_excerpt && (
            <pre className="max-h-32 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground">
              {delivery.response_excerpt}
            </pre>
          )}
        </div>
      )}
    </Alert>
  );
}

// --- the delivery log -------------------------------------------------------------

function DeliveryLog(props: { endpoint: WebhookEndpoint }) {
  const { endpoint } = props;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const filterId = useId();

  useEffect(() => {
    let cancelled = false;
    const query = filter === "all" ? "" : `?status=${filter}`;
    apiFetch<{ data: WebhookDelivery[] }>(`/api/org/webhooks/${endpoint.id}/deliveries${query}`)
      .then((body) => {
        if (cancelled) return;
        setRows(body.data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows(null);
        setError(messageOf(err, "Could not load the deliveries."));
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint.id, filter, version]);

  async function redeliver(delivery: WebhookDelivery) {
    setRedelivering(delivery.id);
    setError(null);
    try {
      await apiFetch(`/api/org/webhooks/${endpoint.id}/deliveries/${delivery.id}/redeliver`, {
        method: "POST",
      });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(messageOf(err, "Could not redeliver the event."));
    } finally {
      setRedelivering(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" data-delivery-log="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={filterId}>Show</label>
          <SimpleSelect
            id={filterId}
            size="sm"
            value={filter}
            onValueChange={setFilter}
            options={STATUS_FILTERS.map((status) => ({
              value: status,
              label: status === "all" ? "All deliveries" : status[0].toUpperCase() + status.slice(1),
            }))}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
          Refresh
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      ) : rows === null ? (
        <LoadingSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-mw-text-muted">
          {filter === "all" ? "Nothing has been delivered to this endpoint yet." : `No ${filter} deliveries.`}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-136 text-sm" aria-label={`Deliveries for ${endpoint.url}`}>
            <thead className="text-left text-xs text-mw-text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Event</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Code</th>
                <th className="py-1 pr-2 font-medium">Time</th>
                <th className="py-1 pr-2 font-medium">When</th>
                <th className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((delivery) => (
                <tr key={delivery.id} className="border-t border-border align-top" data-delivery-id={delivery.id}>
                  <td className="py-1.5 pr-2">
                    <code className="font-mono text-xs">{delivery.event}</code>
                    <div className="text-xs text-mw-text-muted">
                      attempt {delivery.attempt}
                      {delivery.next_attempt_at && ` · next ${formatWhen(delivery.next_attempt_at)}`}
                    </div>
                    {delivery.last_error && (
                      <div className="text-xs text-mw-text-muted">{delivery.last_error}</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="py-1.5 pr-2">{delivery.response_code ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    {delivery.response_ms !== null ? `${delivery.response_ms} ms` : "—"}
                  </td>
                  <td className="py-1.5 pr-2">{formatWhen(delivery.created_at)}</td>
                  <td className="py-1.5 text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={redelivering !== null}
                      onClick={() => void redeliver(delivery)}
                    >
                      {redelivering === delivery.id ? "Redelivering…" : "Redeliver"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
