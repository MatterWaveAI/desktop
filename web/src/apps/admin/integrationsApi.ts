import { apiFetch } from "../../lib/api";

/**
 * The Integrations tab's API, as routes_crm.py serves it. Its own file
 * beside adminApi.ts so the CRM's types and fetchers stay in one place.
 */

export type OutboxStatus = "pending" | "sending" | "sent" | "dead" | "skipped";
export type InboundStatus = "received" | "applied" | "failed" | "awaiting_link";

export interface SalesforceState {
  provider: "salesforce";
  /** The outbound sync can reach Salesforce: client id, user and key are set. */
  configured: boolean;
  /** Messages are being recorded (configured, or a fake in a test). */
  active: boolean;
  /** MW_SALESFORCE_WEBHOOK_SECRET is set, so signed contract events are accepted. */
  inbound_configured: boolean;
  login_url: string;
  username: string | null;
  api_version: string;
  sync_scope: string;
  /** Where Salesforce posts its signed contract events. */
  inbound_url: string;
  connection: {
    instance_url: string | null;
    last_ok_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
  };
  last_sync_at: string | null;
  outbox: Record<OutboxStatus, number>;
  inbound: Record<InboundStatus, number>;
}

export interface OutboxRow {
  id: string;
  org_id: string | null;
  kind: string;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  crm_ref: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface InboundRow {
  event_id: string;
  kind: string;
  contract_ref: string | null;
  opportunity_id: string | null;
  account_id: string | null;
  org_id: string | null;
  status: InboundStatus;
  error: string | null;
  attempts: number;
  received_at: string;
  applied_at: string | null;
}

const BASE = "/api/admin/integrations/salesforce";

/**
 * The state with every block the tab reads filled in: an older or partial
 * answer (no `connection`, no counts) shows as "not reached yet" and zeros
 * rather than a TypeError that takes the tab down.
 */
export function fetchSalesforce(): Promise<SalesforceState> {
  return apiFetch<Partial<SalesforceState> | null>(BASE).then((raw) => {
    const body = raw ?? {};
    const connection: Partial<SalesforceState["connection"]> = body.connection ?? {};
    const outbox: Partial<SalesforceState["outbox"]> = body.outbox ?? {};
    const inbound: Partial<SalesforceState["inbound"]> = body.inbound ?? {};
    return {
      provider: "salesforce",
      configured: body.configured === true,
      active: body.active === true,
      inbound_configured: body.inbound_configured === true,
      login_url: body.login_url ?? "",
      username: body.username ?? null,
      api_version: body.api_version ?? "",
      sync_scope: body.sync_scope ?? "",
      inbound_url: body.inbound_url ?? "",
      connection: {
        instance_url: connection.instance_url ?? null,
        last_ok_at: connection.last_ok_at ?? null,
        last_error: connection.last_error ?? null,
        last_error_at: connection.last_error_at ?? null,
      },
      last_sync_at: body.last_sync_at ?? null,
      outbox: {
        pending: outbox.pending ?? 0,
        sending: outbox.sending ?? 0,
        sent: outbox.sent ?? 0,
        dead: outbox.dead ?? 0,
        skipped: outbox.skipped ?? 0,
      },
      inbound: {
        received: inbound.received ?? 0,
        applied: inbound.applied ?? 0,
        failed: inbound.failed ?? 0,
        awaiting_link: inbound.awaiting_link ?? 0,
      },
    };
  });
}

export function testSalesforce(): Promise<{ ok: boolean; error?: string; user?: string | null; state: SalesforceState }> {
  return apiFetch(`${BASE}/test`, { method: "POST" });
}

export function syncSalesforce(): Promise<{ report: Record<string, unknown>; state: SalesforceState }> {
  return apiFetch(`${BASE}/sync`, { method: "POST" });
}

export function fetchOutbox(status: OutboxStatus | null): Promise<OutboxRow[]> {
  const query = status ? `?status=${status}` : "";
  return apiFetch<{ data?: OutboxRow[] }>(`${BASE}/outbox${query}`).then((body) => body.data ?? []);
}

export function retryOutbox(id: string): Promise<{ data: OutboxRow }> {
  return apiFetch(`${BASE}/outbox/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export function retryDeadOutbox(): Promise<{ retried: number }> {
  return apiFetch(`${BASE}/outbox/retry-dead`, { method: "POST" });
}

export function fetchInbound(): Promise<InboundRow[]> {
  return apiFetch<{ data?: InboundRow[] }>(`${BASE}/inbound`).then((body) => body.data ?? []);
}

export function applyInbound(eventId: string): Promise<{ data: InboundRow }> {
  return apiFetch(`${BASE}/inbound/${encodeURIComponent(eventId)}/apply`, { method: "POST" });
}

export function linkOrgAccount(
  orgId: string,
  accountId: string | null,
): Promise<{ org_id: string; account_id: string | null; changed: boolean }> {
  return apiFetch(`/api/admin/orgs/${encodeURIComponent(orgId)}/salesforce`, {
    method: "PUT",
    json: { account_id: accountId },
  });
}

/** Date and time, for the sync columns: "Never" for nothing yet. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export const OUTBOX_KIND_LABEL: Record<string, string> = {
  "org.created": "Organisation created",
  "org.updated": "Plan or link changed",
  "seats.changed": "Members changed",
  "invoice.updated": "Invoice",
  "dunning.stage": "Late-payment stage",
  "contract.applied": "Contract outcome",
  "org.summary": "Nightly summary",
  "lead.created": "Enterprise lead",
};
