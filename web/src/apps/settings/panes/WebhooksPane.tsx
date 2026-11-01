import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
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
import { formatDateTime } from "../../../i18n/format";
import { ApiError, apiFetch } from "../../../lib/api";
import { DEVELOPERS_WEBHOOKS_PATH } from "../../../shell/frontDoor";
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
 * state; the log carries what was sent and what the receiver answered.
 *
 * Below the list, the rules a receiver is written against: how to verify
 * a signature (with a placeholder where the secret goes) and every event
 * with an example payload, both from the API's own catalogue.
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
  /** Why it is off: an admin's switch, or the run of failures. */
  disabled_reason?: "admin" | "failures" | null;
  /** Until when a rotated-out secret still signs beside the current one. */
  previous_secret_expires_at?: string | null;
}

export type SnippetLanguage = "python" | "node" | "curl";
export type Snippets = Partial<Record<SnippetLanguage, string>>;

/** The create and rotate responses: the endpoint plus its secret, once. */
export interface RevealedSecret extends WebhookEndpoint {
  secret: string;
  shown_once: true;
  verification: Snippets;
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

/** One subscribable event as `GET /api/org/webhooks` lists it. */
export interface CatalogueEntry {
  type: string;
  group: string;
  description: string;
  example: Record<string, unknown>;
}

export interface WebhookLimits {
  max_endpoints: number;
  max_payload_bytes: number;
  disable_after_failures: number;
  retry_delays_s: number[];
  rotation_grace_default_s: number;
  rotation_grace_max_s: number;
}

interface ListingBody {
  data: WebhookEndpoint[];
  events: string[];
  catalogue?: CatalogueEntry[];
  groups?: string[];
  limits?: WebhookLimits;
  verification?: Snippets;
}

const STATUS_FILTERS = ["all", "pending", "sending", "delivered", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The filter's choices, as the select names them. */
const FILTER_LABELS: Record<StatusFilter, MessageDescriptor> = {
  all: msg`All deliveries`,
  pending: msg`Pending`,
  sending: msg`Sending`,
  delivered: msg`Delivered`,
  failed: msg`Failed`,
};

/** What an empty log says under each filter. */
const EMPTY_LOG: Record<StatusFilter, MessageDescriptor> = {
  all: msg`Nothing has been delivered to this endpoint yet.`,
  pending: msg`No pending deliveries.`,
  sending: msg`No sending deliveries.`,
  delivered: msg`No delivered deliveries.`,
  failed: msg`No failed deliveries.`,
};

/** A delivery's state on its badge in the log. */
const STATUS_LABELS: Record<WebhookDelivery["status"], MessageDescriptor> = {
  pending: msg`pending`,
  sending: msg`sending`,
  delivered: msg`delivered`,
  failed: msg`failed`,
};

/** What each event means, beside its name in the checklist. */
const EVENT_HINTS: Record<string, MessageDescriptor> = {
  "api_key.created": msg`An API key was created.`,
  "api_key.revoked": msg`An API key was revoked.`,
  "billing.payment_overdue": msg`A payment is overdue and a reminder stage was reached.`,
  "budget.exhausted": msg`The monthly budget is used up.`,
  "budget.warn": msg`Spend crossed 80% of the monthly budget.`,
  "conversation.compacted": msg`Older turns of a conversation were summarised to fit the model.`,
  "conversation.created": msg`Someone started a conversation (its id, never its content).`,
  "conversation.shared": msg`Someone made a public link to a conversation.`,
  "enforcement.applied": msg`A member or the organisation was warned, rate-limited or suspended.`,
  "enforcement.lifted": msg`A warning, rate limit or suspension was lifted.`,
  "export.completed": msg`A member's data export is ready to download.`,
  "member.joined": msg`Someone accepted an invitation.`,
  "member.removed": msg`Someone was removed from the organisation.`,
  "member.role_changed": msg`A member's role changed.`,
  "message.completed": msg`An assistant turn finished, with its token counts.`,
  "plan.changed": msg`The organisation's plan moved.`,
};

/** The catalogue's groups, as the checklist heads them. */
const GROUP_LABELS: Record<string, MessageDescriptor> = {
  members: msg`Members`,
  keys: msg`API keys`,
  billing: msg`Billing, plan and budget`,
  conversations: msg`Conversations`,
  moderation: msg`Moderation`,
};

const SNIPPET_LABELS: Record<SnippetLanguage, string> = { python: "Python", node: "Node", curl: "curl" };

/** How long a rotated-out secret keeps signing, as the rotate dialog offers it. */
const GRACE_CHOICES: Array<{ seconds: number; label: MessageDescriptor }> = [
  { seconds: 86_400, label: msg`Keep the old secret for 24 hours (recommended)` },
  { seconds: 3_600, label: msg`Keep the old secret for 1 hour` },
  { seconds: 604_800, label: msg`Keep the old secret for 7 days` },
  { seconds: 0, label: msg`Stop the old secret now (it may have leaked)` },
];

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

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return formatDateTime(iso, { dateStyle: "medium", timeStyle: "medium" }) || iso;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The catalogue, or one built from the bare names an older API sent. */
function catalogueOf(body: ListingBody): CatalogueEntry[] {
  if (body.catalogue && body.catalogue.length > 0) return body.catalogue;
  return body.events.map((type) => ({ type, group: "", description: "", example: {} }));
}

/** The catalogue in its groups, in the API's group order; ungrouped last. */
function grouped(catalogue: CatalogueEntry[], groups: string[]): Array<[string, CatalogueEntry[]]> {
  const order = [...groups, ...catalogue.map((entry) => entry.group).filter((g) => !groups.includes(g))];
  return [...new Set(order)]
    .map((group): [string, CatalogueEntry[]] => [group, catalogue.filter((entry) => entry.group === group)])
    .filter(([, entries]) => entries.length > 0);
}

export function WebhooksPane() {
  const { t } = useLingui();
  const { principal } = useShell();
  if (!managesOrg(principal)) {
    return (
      <EmptyState
        title={t`Webhooks are for admins`}
        description={t`Endpoints that receive this organisation's events are set up by an administrator. Ask one to make changes here.`}
      />
    );
  }
  return <WebhooksAdmin />;
}

interface Listing {
  endpoints: WebhookEndpoint[];
  catalogue: CatalogueEntry[];
  groups: string[];
  limits: WebhookLimits | null;
  verification: Snippets | null;
}

function WebhooksAdmin() {
  const { t } = useLingui();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped after every action: the list is re-read from the API rather
  // than patched locally, so what the pane shows is what the API holds.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  /** The secret just created or rotated, until Done. */
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ListingBody>("/api/org/webhooks")
      .then((body) => {
        if (cancelled) return;
        setListing({
          endpoints: body.data,
          catalogue: catalogueOf(body),
          groups: body.groups ?? [],
          limits: body.limits ?? null,
          verification: body.verification ?? null,
        });
        setLoadError(null);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListing(null);
        const off = featureOff(err);
        setUnavailable(off);
        setLoadError(off ? null : messageOf(err, t`Could not load the webhook endpoints.`));
      });
    return () => {
      cancelled = true;
    };
  }, [version, t]);

  const reveal = (secret: RevealedSecret) => {
    setRevealed(secret);
    reload();
  };

  if (unavailable) {
    return (
      <EmptyState
        title={t`Not available on this deployment`}
        description={t`Webhooks are not switched on here, so there are no endpoints to set up. Whoever runs this deployment can turn them on.`}
      />
    );
  }

  const maxEndpoints = listing?.limits?.max_endpoints ?? null;
  const atCap = listing !== null && maxEndpoints !== null && listing.endpoints.length >= maxEndpoints;
  const failedCount =
    listing?.endpoints.filter((e) => !e.enabled && e.disabled_reason === "failures").length ?? 0;
  const disableAfter = listing?.limits?.disable_after_failures ?? 5;

  return (
    <div className="flex flex-col gap-7">
      <SecretDialog revealed={revealed} onDone={() => setRevealed(null)} />
      {listing !== null && !loadError && (
        <PaneActions>
          <Button type="button" size="lg" disabled={atCap} onClick={() => setCreating(true)}>
            <Trans>Add endpoint…</Trans>
          </Button>
        </PaneActions>
      )}
      {failedCount > 0 && (
        <Alert
          variant="danger"
          data-webhooks-disabled-banner=""
          title={plural(failedCount, {
            one: "# endpoint was disabled after repeated failures",
            other: "# endpoints were disabled after repeated failures",
          })}
        >
          <Trans>
            After {disableAfter} failed deliveries in a row nothing more is sent, and the owners and
            admins were emailed. Fix the receiver, enable the endpoint, then redeliver what was missed
            from its delivery log.
          </Trans>
        </Alert>
      )}
      <PaneSection
        title={t`Endpoints`}
        flush
        description={t`Each endpoint gets a signed POST for every event it subscribes to.`}
      >
        {loadError ? (
          <div className="px-5 py-4">
            <ErrorState title={t`Could not load the endpoints`} message={loadError} onRetry={reload} />
          </div>
        ) : listing === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={3} />
          </div>
        ) : (
          <>
            {listing.endpoints.length === 0 ? (
              <EmptyState
                title={t`No endpoints yet`}
                description={t`Add one to have events from this organisation posted to a URL you run.`}
              />
            ) : (
              <RowList aria-label={t`Webhook endpoints`}>
                {listing.endpoints.map((endpoint) => (
                  <EndpointRow
                    key={endpoint.id}
                    endpoint={endpoint}
                    catalogue={listing.catalogue}
                    defaultGrace={listing.limits?.rotation_grace_default_s ?? 86_400}
                    onChanged={reload}
                    onRevealed={reveal}
                    onEdit={() => setEditing(endpoint)}
                  />
                ))}
              </RowList>
            )}
            {atCap && maxEndpoints !== null && (
              <p className="border-t border-border px-5 py-3 text-sm text-mw-text-muted" data-webhooks-at-cap="">
                <Trans>
                  This organisation has {maxEndpoints} endpoints, the most it may have. Delete one, or
                  subscribe an existing one to more events.
                </Trans>
              </p>
            )}
            <EndpointDialog
              mode="create"
              open={creating}
              catalogue={listing.catalogue}
              groups={listing.groups}
              onOpenChange={setCreating}
              onSaved={(saved) => {
                setCreating(false);
                reveal(saved as RevealedSecret);
              }}
            />
            <EndpointDialog
              mode="edit"
              open={editing !== null}
              endpoint={editing}
              catalogue={listing.catalogue}
              groups={listing.groups}
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
        <LearnMore className="border-t border-border px-5 py-3">
          <p>
            <Trans>
              Payloads carry ids, roles, counts and plan codes, never conversation content. A failed
              delivery is retried after about 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours.
              After five consecutive failures an endpoint is disabled and the owners and admins are
              told.
            </Trans>
          </p>
          <p>
            <Trans>
              Delivery is at least once: deduplicate on the{" "}
              <code className="font-mono">MatterWave-Event-Id</code> header, which stays the same across
              retries and redeliveries.
            </Trans>
          </p>
          <p>
            <a href={DEVELOPERS_WEBHOOKS_PATH} className="text-mw-link hover:text-mw-link-hover">
              <Trans>Read the webhooks guide</Trans>
            </a>
          </p>
        </LearnMore>
      </PaneSection>
      {listing !== null && !loadError && (
        <>
          {listing.verification && <VerifySection snippets={listing.verification} />}
          <EventsSection catalogue={listing.catalogue} groups={listing.groups} />
        </>
      )}
    </div>
  );
}

// --- code tabs ------------------------------------------------------------------

/** Python / Node / curl tabs over the snippets the API wrote. */
function SnippetTabs(props: { snippets: Snippets; testId?: string }) {
  const { t } = useLingui();
  const languages = (["python", "node", "curl"] as const).filter((l) => props.snippets[l]);
  const [tab, setTab] = useState<SnippetLanguage>(languages[0] ?? "python");
  const current = props.snippets[tab] ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t`Verification snippet`}>
          {languages.map((language) => (
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
              {SNIPPET_LABELS[language]}
            </button>
          ))}
        </div>
        {current && (
          <span className="ml-auto">
            <CopyButton text={current} label={t`Copy snippet`} />
          </span>
        )}
      </div>
      <pre
        data-testid={props.testId ?? "verification-snippet"}
        className="max-h-64 overflow-auto rounded-lg border border-border bg-mw-surface-hover p-3 font-mono text-xs"
      >
        {current}
      </pre>
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
  const { t } = useLingui();
  const { revealed } = props;
  const revealedUrl = revealed?.url ?? "";
  const graceUntil = formatWhen(revealed?.previous_secret_expires_at);
  return (
    // Escape and the backdrop are ignored: only Done closes it.
    <Dialog open={revealed !== null} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        data-webhook-secret-dialog=""
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Your signing secret</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              This is the only time it is shown. Every delivery to{" "}
              <span className="break-all font-mono">{revealedUrl}</span> carries a{" "}
              <code className="font-mono">MatterWave-Signature</code> header computed with it; verify
              that header before trusting a payload. Lose it and rotate the secret to get another.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Alert variant="success" title={t`Copy the secret now. It will not be shown again.`}>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code
              data-testid="webhook-secret"
              className="min-w-0 flex-1 basis-60 break-all rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
            >
              {revealed?.secret ?? ""}
            </code>
            {revealed && <CopyButton text={revealed.secret} label={t`Copy secret`} size="default" />}
          </div>
        </Alert>
        {revealed?.previous_secret_expires_at && (
          <p className="text-sm text-mw-text-muted" data-grace-note="">
            <Trans>
              The old secret keeps signing beside this one until {graceUntil}, so switch your receiver
              over any time before then.
            </Trans>
          </p>
        )}
        {revealed && <SnippetTabs snippets={revealed.verification} />}
        <DialogFooter>
          <Button type="button" onClick={props.onDone}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- creating and editing ------------------------------------------------------------

function EventChecklist(props: {
  catalogue: CatalogueEntry[];
  groups: string[];
  selected: Set<string>;
  onToggle: (event: string) => void;
  error?: string;
}) {
  const { i18n } = useLingui();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="pb-1 text-sm font-medium">
        <Trans>Events</Trans>
      </legend>
      {grouped(props.catalogue, props.groups).map(([group, entries]) => (
        <div key={group || "events"} className="flex flex-col gap-1.5" data-event-group={group}>
          {group && (
            <p className="text-xs font-medium text-mw-text-muted">
              {GROUP_LABELS[group] ? i18n._(GROUP_LABELS[group]) : group}
            </p>
          )}
          {entries.map(({ type, description }) => (
            <label key={type} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                name="events"
                value={type}
                checked={props.selected.has(type)}
                onChange={() => props.onToggle(type)}
              />
              <span className="min-w-0">
                <code className="font-mono break-all">{type}</code>
                {(EVENT_HINTS[type] || description) && (
                  <span className="ml-2 text-mw-text-muted">
                    {EVENT_HINTS[type] ? i18n._(EVENT_HINTS[type]) : description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      ))}
      {props.error && (
        <p role="alert" className="text-sm text-mw-danger">
          {props.error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Add an endpoint, or change one: the same three fields. A create answers
 * with the secret (the caller shows it); an edit sends only what changed.
 */
function EndpointDialog(props: {
  mode: "create" | "edit";
  open: boolean;
  endpoint?: WebhookEndpoint | null;
  catalogue: CatalogueEntry[];
  groups: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (saved: RevealedSecret | WebhookEndpoint) => void;
}) {
  const editing = props.mode === "edit" ? (props.endpoint ?? null) : null;
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent
        data-webhook-create-dialog={editing ? undefined : ""}
        data-webhook-edit-dialog={editing ? "" : undefined}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        {/* Keyed on the endpoint so an edit starts from it as it stands,
            and a create from nothing, without an effect copying props. */}
        <EndpointForm
          key={editing?.id ?? "create"}
          editing={editing}
          catalogue={props.catalogue}
          groups={props.groups}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => props.onOpenChange(false)}
          onSaved={props.onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function EndpointForm(props: {
  editing: WebhookEndpoint | null;
  catalogue: CatalogueEntry[];
  groups: string[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: (saved: RevealedSecret | WebhookEndpoint) => void;
}) {
  const { t } = useLingui();
  const { editing, busy, setBusy } = props;
  const [url, setUrl] = useState(editing?.url ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [events, setEvents] = useState<Set<string>>(() => new Set(editing?.events ?? []));
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

  const canSave = url.trim().length > 0 && events.size > 0 && !busy;
  const ordered = () => props.catalogue.map((entry) => entry.type).filter((name) => events.has(name));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (editing) {
        const changes: Record<string, unknown> = {};
        if (url.trim() !== editing.url) changes.url = url.trim();
        if (description.trim() !== editing.description) changes.description = description.trim();
        const chosen = ordered();
        if ([...chosen].sort().join(",") !== [...editing.events].sort().join(",")) changes.events = chosen;
        const saved =
          Object.keys(changes).length === 0
            ? editing
            : await apiFetch<WebhookEndpoint>(`/api/org/webhooks/${editing.id}`, { method: "PATCH", json: changes });
        props.onSaved(saved);
      } else {
        const created = await apiFetch<RevealedSecret>("/api/org/webhooks", {
          method: "POST",
          json: { url: url.trim(), events: ordered(), description: description.trim() },
        });
        props.onSaved(created);
      }
    } catch (err) {
      const perField = fieldErrors(err);
      setFields(perField);
      setError(
        Object.keys(perField).length > 0
          ? null
          : messageOf(err, editing ? t`Could not save the endpoint.` : t`Could not add the endpoint.`),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate aria-busy={busy} onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>{editing ? <Trans>Edit the endpoint</Trans> : <Trans>Add an endpoint</Trans>}</DialogTitle>
        <DialogDescription>
          <Trans>
            An https URL you run. It must be reachable from the internet; private and local addresses
            are refused.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="text-sm text-mw-text-muted">
          <Trans>URL</Trans>
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
          <Trans>
            Description <span className="text-mw-text-muted">(optional)</span>
          </Trans>
        </label>
        <Input
          id={descriptionId}
          name="description"
          maxLength={200}
          placeholder={t`e.g. Ops channel`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <EventChecklist
        catalogue={props.catalogue}
        groups={props.groups}
        selected={events}
        onToggle={toggle}
        error={fields.events}
      />
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
          {editing ? (busy ? t`Saving…` : t`Save changes`) : busy ? t`Adding…` : t`Add endpoint`}
        </Button>
      </DialogFooter>
    </form>
  );
}

// --- rotating -------------------------------------------------------------------

function RotateDialog(props: {
  open: boolean;
  defaultGrace: number;
  inFlight: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (graceSeconds: number) => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.inFlight) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={false} data-webhook-rotate-dialog="">
        <RotateBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's inside, mounted per opening so the choice starts at the default. */
function RotateBody(props: {
  defaultGrace: number;
  inFlight: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (graceSeconds: number) => void;
}) {
  const { t, i18n } = useLingui();
  const [grace, setGrace] = useState(String(props.defaultGrace));
  const graceId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Trans>Rotate the signing secret?</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            A new secret is shown once. Until the old one stops, every delivery is signed with both, so
            the receiver can switch at any point without a failed delivery.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={graceId} className="text-sm text-mw-text-muted">
          <Trans>The old secret</Trans>
        </label>
        <SimpleSelect
          id={graceId}
          value={grace}
          onValueChange={setGrace}
          options={GRACE_CHOICES.map((choice) => ({ value: String(choice.seconds), label: i18n._(choice.label) }))}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={props.inFlight} onClick={() => props.onOpenChange(false)}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={props.inFlight}
          onClick={() => props.onConfirm(Number(grace))}
        >
          {props.inFlight ? t`Rotating…` : t`Rotate secret`}
        </Button>
      </DialogFooter>
    </>
  );
}

// --- one endpoint ---------------------------------------------------------------

function EndpointRow(props: {
  endpoint: WebhookEndpoint;
  catalogue: CatalogueEntry[];
  defaultGrace: number;
  onChanged: () => void;
  onRevealed: (secret: RevealedSecret) => void;
  onEdit: () => void;
}) {
  const { t } = useLingui();
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
    }, t`Could not send the test event.`);

  const setEnabled = (enabled: boolean) =>
    run(async () => {
      await apiFetch(`/api/org/webhooks/${endpoint.id}`, { method: "PATCH", json: { enabled } });
      props.onChanged();
    }, enabled ? t`Could not enable the endpoint.` : t`Could not disable the endpoint.`);

  const rotate = (graceSeconds: number) =>
    run(async () => {
      const rotated = await apiFetch<RevealedSecret>(`/api/org/webhooks/${endpoint.id}/rotate`, {
        method: "POST",
        json: { grace_seconds: graceSeconds },
      });
      setConfirming(null);
      props.onRevealed(rotated);
    }, t`Could not rotate the secret.`);

  const remove = () =>
    run(async () => {
      await apiFetch(`/api/org/webhooks/${endpoint.id}`, { method: "DELETE" });
      setConfirming(null);
      props.onChanged();
    }, t`Could not delete the endpoint.`);

  const endpointUrl = endpoint.url;
  const failureCount = endpoint.failure_count;
  const addedAt = formatWhen(endpoint.created_at);
  const disabledAt = formatWhen(endpoint.disabled_at);
  const graceUntil = formatWhen(endpoint.previous_secret_expires_at);
  // An older API sends no reason: a disabled endpoint with failures on it
  // reads as disabled by them, as it always did.
  const byFailures =
    !endpoint.enabled &&
    (endpoint.disabled_reason === "failures" || (endpoint.disabled_reason == null && failureCount > 0));
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
                  ? t`Enabled`
                  : byFailures
                    ? plural(failureCount, { one: "Disabled after # failure", other: "Disabled after # failures" })
                    : t`Disabled`}
              </span>
            </span>
            {endpoint.description && <span className="break-words">· {endpoint.description}</span>}
            <span>
              · <Trans>Added {addedAt}</Trans>
              {endpoint.disabled_at && (
                <>
                  {" · "}
                  <Trans>Disabled {disabledAt}</Trans>
                </>
              )}
            </span>
          </div>
          {endpoint.previous_secret_expires_at && (
            <p className="text-sm text-mw-text-muted" data-grace-note="">
              <Trans>The previous secret also signs until {graceUntil}.</Trans>
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1" aria-label={t`Events for ${endpointUrl}`}>
            {endpoint.events.map((name) => (
              <Badge key={name} variant="outline">
                {name}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void sendTest()}>
            <Trans>Send test</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={showingLog}
            onClick={() => setShowingLog((on) => !on)}
          >
            {showingLog ? t`Hide deliveries` : t`Deliveries`}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onEdit}>
            <Trans>Edit…</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void setEnabled(!endpoint.enabled)}
          >
            {endpoint.enabled ? t`Disable` : t`Enable`}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming("rotate")}>
            <Trans>Rotate secret…</Trans>
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => setConfirming("delete")}
          >
            <Trans>Delete…</Trans>
          </Button>
        </div>
      </div>
      {byFailures && (
        <Alert variant="warning" data-endpoint-disabled-banner="">
          <Trans>
            Nothing is sent to this endpoint after {failureCount} failed deliveries in a row. Fix the
            receiver, choose Enable, then redeliver what was missed from Deliveries.
          </Trans>
        </Alert>
      )}
      {testResult && <TestResult delivery={testResult} />}
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
      {showingLog && <DeliveryLog endpoint={endpoint} catalogue={props.catalogue} />}
      <RotateDialog
        open={confirming === "rotate"}
        defaultGrace={props.defaultGrace}
        inFlight={busy}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        onConfirm={(grace) => void rotate(grace)}
      />
      <DestructiveConfirm
        open={confirming === "delete"}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t`Delete ${endpointUrl}?`}
        description={t`No further events are sent to it, and its delivery log goes with it. This cannot be undone; add the endpoint again to get a new secret.`}
        confirmLabel={t`Delete endpoint`}
        onConfirm={() => void remove()}
        inFlight={busy}
      />
    </li>
  );
}

function StatusBadge(props: { status: WebhookDelivery["status"] }) {
  const variant =
    props.status === "delivered" ? "outline" : props.status === "failed" ? "destructive" : "secondary";
  const { i18n } = useLingui();
  return <Badge variant={variant}>{i18n._(STATUS_LABELS[props.status])}</Badge>;
}

/** What the test event got back, beside the button that sent it. */
function TestResult(props: { delivery: WebhookDelivery }) {
  const { t } = useLingui();
  const { delivery } = props;
  const ok = delivery.status === "delivered";
  const responseMs = delivery.response_ms;
  return (
    <Alert
      role="status"
      data-test-result={delivery.status}
      variant={ok ? "success" : "warning"}
      title={
        <>
          {ok ? t`The receiver accepted the test event` : t`The test event was not accepted`}
          {delivery.response_code !== null && ` · HTTP ${delivery.response_code}`}
          {responseMs !== null && " · " + t`${responseMs} ms`}
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

const ALL_EVENTS = "all";

function DeliveryLog(props: { endpoint: WebhookEndpoint; catalogue: CatalogueEntry[] }) {
  const { t, i18n } = useLingui();
  const { endpoint } = props;
  const endpointUrl = endpoint.url;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [eventFilter, setEventFilter] = useState<string>(ALL_EVENTS);
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const filterId = useId();
  const eventFilterId = useId();

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filter !== "all") params.set("status", filter);
    if (eventFilter !== ALL_EVENTS) params.set("event", eventFilter);
    const query = params.toString() ? `?${params.toString()}` : "";
    apiFetch<{ data: WebhookDelivery[] }>(`/api/org/webhooks/${endpoint.id}/deliveries${query}`)
      .then((body) => {
        if (cancelled) return;
        setRows(body.data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows(null);
        setError(messageOf(err, t`Could not load the deliveries.`));
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint.id, filter, eventFilter, version, t]);

  async function redeliver(delivery: WebhookDelivery) {
    setRedelivering(delivery.id);
    setError(null);
    try {
      await apiFetch(`/api/org/webhooks/${endpoint.id}/deliveries/${delivery.id}/redeliver`, {
        method: "POST",
      });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(messageOf(err, t`Could not redeliver the event.`));
    } finally {
      setRedelivering(null);
    }
  }

  // The endpoint's own subscription, in catalogue order, then the test event.
  const eventChoices = [
    ...props.catalogue.map((entry) => entry.type).filter((type) => endpoint.events.includes(type)),
    "ping",
  ];

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" data-delivery-log="">
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
            options={STATUS_FILTERS.map((status) => ({
              value: status,
              label: i18n._(FILTER_LABELS[status]),
            }))}
          />
          <label htmlFor={eventFilterId}>
            <Trans>Event</Trans>
          </label>
          <SimpleSelect
            id={eventFilterId}
            size="sm"
            value={eventFilter}
            onValueChange={setEventFilter}
            options={[
              { value: ALL_EVENTS, label: t`All events` },
              ...eventChoices.map((type) => ({ value: type, label: type })),
            ]}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
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
        <p className="text-sm text-mw-text-muted">
          {eventFilter === ALL_EVENTS ? i18n._(EMPTY_LOG[filter]) : t`No deliveries match these filters.`}
        </p>
      ) : (
        // `relative` so the sr-only header cell, absolutely placed, is
        // clipped by this scroller instead of widening the page on a phone.
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-136 text-sm" aria-label={t`Deliveries for ${endpointUrl}`}>
            <thead className="text-left text-xs text-mw-text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Event</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Status</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Code</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>Time</Trans>
                </th>
                <th className="py-1 pr-2 font-medium">
                  <Trans>When</Trans>
                </th>
                <th className="py-1 font-medium">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((delivery) => (
                <DeliveryRows
                  key={delivery.id}
                  delivery={delivery}
                  expanded={open === delivery.id}
                  onToggle={() => setOpen(open === delivery.id ? null : delivery.id)}
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={redelivering !== null}
                      onClick={() => void redeliver(delivery)}
                    >
                      {redelivering === delivery.id ? t`Redelivering…` : t`Redeliver`}
                    </Button>
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One delivery's row and, opened, what was sent and what came back. */
function DeliveryRows(props: {
  delivery: WebhookDelivery;
  expanded: boolean;
  onToggle: () => void;
  actions: ReactNode;
}) {
  const { t } = useLingui();
  const { delivery } = props;
  const attempt = delivery.attempt;
  const nextAt = formatWhen(delivery.next_attempt_at);
  const responseMs = delivery.response_ms;
  const eventId = delivery.event_id;
  const deliveredAt = formatWhen(delivery.delivered_at);
  return (
    <>
      <tr className="border-t border-border align-top" data-delivery-id={delivery.id}>
        <td className="py-1.5 pr-2">
          <code className="font-mono text-xs">{delivery.event}</code>
          <div className="text-xs text-mw-text-muted">
            <Trans>attempt {attempt}</Trans>
            {delivery.next_attempt_at && (
              <>
                {" · "}
                <Trans>next {nextAt}</Trans>
              </>
            )}
          </div>
          {delivery.last_error && <div className="text-xs text-mw-text-muted">{delivery.last_error}</div>}
        </td>
        <td className="py-1.5 pr-2">
          <StatusBadge status={delivery.status} />
        </td>
        <td className="py-1.5 pr-2">{delivery.response_code ?? "—"}</td>
        <td className="py-1.5 pr-2">{responseMs !== null ? t`${responseMs} ms` : "—"}</td>
        <td className="py-1.5 pr-2">{formatWhen(delivery.created_at)}</td>
        <td className="py-1.5 text-right">
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" aria-expanded={props.expanded} onClick={props.onToggle}>
              {props.expanded ? t`Hide details` : t`Details`}
            </Button>
            {props.actions}
          </div>
        </td>
      </tr>
      {props.expanded && (
        <tr data-delivery-details={delivery.id}>
          <td colSpan={6} className="pb-3">
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs">
              <p className="text-mw-text-muted">
                <Trans>
                  Event id <code className="font-mono">{eventId}</code>, sent as MatterWave-Event-Id and
                  webhook-id.
                </Trans>
                {delivery.delivered_at && (
                  <>
                    {" "}
                    <Trans>Delivered {deliveredAt}.</Trans>
                  </>
                )}
              </p>
              <p className="font-medium">
                <Trans>Request body</Trans>
              </p>
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-mw-surface-hover p-2 font-mono">
                {pretty(delivery.payload)}
              </pre>
              <p className="font-medium">
                <Trans>Response (first 1000 bytes)</Trans>
              </p>
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-mw-surface-hover p-2 font-mono">
                {delivery.response_excerpt || t`No response body.`}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// --- what a receiver is written against ---------------------------------------------

function VerifySection(props: { snippets: Snippets }) {
  const { t } = useLingui();
  return (
    <PaneSection
      title={t`Verify signatures`}
      description={t`Check the MatterWave-Signature header before trusting a payload. Replace whsec_YOUR_SECRET with the endpoint's secret.`}
    >
      <div className="flex flex-col gap-3" data-webhooks-verify="">
        <SnippetTabs snippets={props.snippets} testId="standing-verification-snippet" />
        <p className="text-sm text-mw-text-muted">
          <Trans>
            Every delivery also carries the Standard Webhooks headers (webhook-id, webhook-timestamp,
            webhook-signature), so a Standard Webhooks library verifies it as is. During a rotation's
            grace period each header carries two signatures; accept the request if either matches.
          </Trans>
        </p>
      </div>
    </PaneSection>
  );
}

function EventsSection(props: { catalogue: CatalogueEntry[]; groups: string[] }) {
  const { t, i18n } = useLingui();
  const withExamples = props.catalogue.filter((entry) => Object.keys(entry.example).length > 0);
  if (withExamples.length === 0) return null;
  return (
    <PaneSection
      title={t`Event catalogue`}
      description={t`What each event means and the data it carries. Payloads never include conversation content.`}
      flush
    >
      <div className="flex flex-col divide-y divide-border" data-webhooks-events="">
        {grouped(withExamples, props.groups).map(([group, entries]) => (
          <div key={group} className="flex flex-col gap-1 px-5 py-3">
            <p className="text-xs font-medium text-mw-text-muted">
              {GROUP_LABELS[group] ? i18n._(GROUP_LABELS[group]) : group}
            </p>
            {entries.map((entry) => (
              <details key={entry.type} className="text-sm" data-event-type={entry.type}>
                <summary className="cursor-pointer rounded-sm py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <code className="font-mono">{entry.type}</code>
                  <span className="ml-2 text-mw-text-muted">
                    {EVENT_HINTS[entry.type] ? i18n._(EVENT_HINTS[entry.type]) : entry.description}
                  </span>
                </summary>
                <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border bg-mw-surface-hover p-3 font-mono text-xs">
                  {pretty({ id: "evt_…", type: entry.type, created_at: "…", org_id: "…", data: entry.example })}
                </pre>
              </details>
            ))}
          </div>
        ))}
      </div>
    </PaneSection>
  );
}
