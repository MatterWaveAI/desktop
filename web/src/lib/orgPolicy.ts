import { ApiError, apiFetch, currentToken, requestIdOf } from "./api";

/**
 * Organisation policy and visibility, typed once: the model allow-list
 * (`/api/org/models`), the audit log (`/api/org/audit`) and the per-member
 * usage report (`/api/org/usage`), from routes_org.py and routes_usage.py.
 *
 * Every shape here is read tolerantly. The panes are also mounted against
 * stubbed APIs whose catch-all answers `{data: []}` for a route it does not
 * know, and a section that throws on a missing `next_cursor` takes the whole
 * pane down with it; a missing field reads as "nothing", never as a crash.
 */

// --- the model allow-list ------------------------------------------------------

/** One of the plan's models with the org's switch on it. */
export interface OrgModel {
  id: string;
  /** What the picker and the pricing page call it; the id when nothing names it. */
  label: string;
  /** Another provider's model, listed apart under the partner heading. */
  partner: boolean;
  context_window: number | null;
  research_preview: boolean;
  /** Whether members may use it right now. */
  allowed: boolean;
  /** The house model: the switch is shown but cannot be turned off. */
  locked: boolean;
}

export interface OrgModelPolicy {
  /** The deployment's default model, allowed on every plan and never off. */
  house_model: string;
  data: OrgModel[];
  /** Ids the org once allowed that the plan or gateway no longer offers. */
  unlisted: string[];
  /** False when the org never narrowed the plan's list. */
  restricted: boolean;
}

function asOrgModel(raw: Partial<OrgModel>): OrgModel {
  const id = typeof raw.id === "string" ? raw.id : "";
  return {
    id,
    label: typeof raw.label === "string" && raw.label !== "" ? raw.label : id,
    partner: raw.partner === true,
    context_window: typeof raw.context_window === "number" ? raw.context_window : null,
    research_preview: raw.research_preview === true,
    allowed: raw.allowed === true,
    locked: raw.locked === true,
  };
}

function asModelPolicy(raw: Partial<OrgModelPolicy> | null | undefined): OrgModelPolicy {
  return {
    house_model: typeof raw?.house_model === "string" ? raw.house_model : "",
    data: Array.isArray(raw?.data) ? raw.data.map(asOrgModel) : [],
    unlisted: Array.isArray(raw?.unlisted) ? raw.unlisted : [],
    restricted: raw?.restricted === true,
  };
}

export function fetchOrgModels(): Promise<OrgModelPolicy> {
  return apiFetch<Partial<OrgModelPolicy>>("/api/org/models").then(asModelPolicy);
}

/**
 * Store the allow-list. `null` is "everything the plan permits", which is
 * what an org that switched every model back on should hold: a list that
 * happened to name every model today would silently exclude one the plan
 * adds tomorrow.
 */
export function setOrgModels(allowed: string[] | null): Promise<OrgModelPolicy> {
  return apiFetch<Partial<OrgModelPolicy>>("/api/org/models", {
    method: "PUT",
    json: { allowed },
  }).then(asModelPolicy);
}

/**
 * The list to send after one switch moves. `null` once nothing is off,
 * for the reason `setOrgModels` gives; the house model is never in the
 * list because the API adds it back whatever is sent.
 */
export function allowListAfter(
  models: readonly OrgModel[],
  changed: string,
  on: boolean,
): string[] | null {
  const next = models.map((m) => (m.id === changed ? { ...m, allowed: on } : m));
  if (next.every((m) => m.allowed)) return null;
  return next.filter((m) => m.allowed && !m.locked).map((m) => m.id);
}

// --- the audit log -------------------------------------------------------------

export interface AuditRow {
  id: string;
  occurred_at: string;
  /** The actor's subject; what every writer had in hand. */
  actor: string;
  /** Resolved for display; null for a system actor or a member since removed. */
  actor_email: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  data: AuditRow[];
  next_cursor: string | null;
  /** Every action this org's trail holds, for the filter. */
  actions: string[];
}

export interface AuditFilters {
  /** An action, exact or as a dotted prefix (`org.sso` finds `org.sso.enforced`). */
  event?: string;
  /** A subject or an email address. */
  actor?: string;
  /** `YYYY-MM-DD` as the date inputs produce it; inclusive. */
  since?: string;
  /** `YYYY-MM-DD`; inclusive, so the API is asked for the next midnight. */
  until?: string;
}

/** The day after a `YYYY-MM-DD`, at UTC midnight, as an ISO instant. */
function nextMidnightUtc(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString();
}

/** The query string the audit routes take, with blank filters left out. */
export function auditQuery(filters: AuditFilters, cursor?: string | null, limit?: number): string {
  const params = new URLSearchParams();
  if (filters.event?.trim()) params.set("event", filters.event.trim());
  if (filters.actor?.trim()) params.set("actor", filters.actor.trim());
  if (filters.since) params.set("since", `${filters.since}T00:00:00Z`);
  if (filters.until) params.set("until", nextMidnightUtc(filters.until));
  if (cursor) params.set("cursor", cursor);
  if (limit !== undefined) params.set("limit", String(limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const AUDIT_PAGE_SIZE = 50;

function asAuditPage(raw: Partial<AuditPage> | null | undefined): AuditPage {
  return {
    data: Array.isArray(raw?.data) ? raw.data : [],
    next_cursor: typeof raw?.next_cursor === "string" ? raw.next_cursor : null,
    actions: Array.isArray(raw?.actions) ? raw.actions : [],
  };
}

export function fetchAuditPage(filters: AuditFilters, cursor?: string | null): Promise<AuditPage> {
  return apiFetch<Partial<AuditPage>>(
    `/api/org/audit${auditQuery(filters, cursor, AUDIT_PAGE_SIZE)}`,
  ).then(asAuditPage);
}

export function auditCsvPath(filters: AuditFilters): string {
  return `/api/org/audit.csv${auditQuery(filters)}`;
}

// --- per-member usage ----------------------------------------------------------

export interface MemberUsage {
  subject: string;
  email: string | null;
  name: string | null;
  /** What the member's turns counted against the allowance. */
  weighted_tokens: number;
  /** Raw prompt plus completion tokens. */
  tokens: number;
  /** List-price cost of those turns, in micro-dollars. */
  cost_micros: number;
  turns: number;
  last_active: string | null;
}

export interface MemberUsageReport {
  /** `YYYY-MM`. */
  period: string;
  period_start: string;
  period_end: string;
  unit: "tokens";
  /** `org` for an owner or admin (everyone's rows); `self` for a member (their own). */
  scope: "org" | "self";
  data: MemberUsage[];
  totals: { weighted_tokens: number; tokens: number; cost_micros: number; turns: number };
}

function asMemberReport(raw: Partial<MemberUsageReport> | null | undefined): MemberUsageReport {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return {
    period: typeof raw?.period === "string" ? raw.period : "",
    period_start: typeof raw?.period_start === "string" ? raw.period_start : "",
    period_end: typeof raw?.period_end === "string" ? raw.period_end : "",
    unit: "tokens",
    scope: raw?.scope === "self" ? "self" : "org",
    data,
    totals: raw?.totals ?? {
      weighted_tokens: data.reduce((sum, r) => sum + r.weighted_tokens, 0),
      tokens: data.reduce((sum, r) => sum + r.tokens, 0),
      cost_micros: data.reduce((sum, r) => sum + r.cost_micros, 0),
      turns: data.reduce((sum, r) => sum + r.turns, 0),
    },
  };
}

function periodQuery(period?: string): string {
  return period ? `?period=${encodeURIComponent(period)}` : "";
}

export function fetchMemberUsage(period?: string): Promise<MemberUsageReport> {
  return apiFetch<Partial<MemberUsageReport>>(`/api/org/usage${periodQuery(period)}`).then(
    asMemberReport,
  );
}

export function memberUsageCsvPath(period?: string): string {
  return `/api/org/usage.csv${periodQuery(period)}`;
}

// --- files ---------------------------------------------------------------------

/**
 * Fetch a CSV route and hand the browser the file.
 *
 * Not a plain `<a download>`: the session may ride in an `Authorization`
 * header rather than a cookie (`currentToken`), and a bare link carries no
 * header. So the bytes are fetched the way every other request is and
 * saved through a blob URL. A refusal is an `ApiError` like any other, so
 * the pane shows the API's reason and its request id.
 */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const token = currentToken();
  const res = await fetch(path, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // not JSON; the status is the message
    }
    const detail = (body as { detail?: unknown } | undefined)?.detail;
    throw new ApiError(
      res.status,
      typeof detail === "string" ? detail : `Request failed (${res.status})`,
      body,
      requestIdOf(res, body),
    );
  }
  const text = await res.text();
  saveTextFile(text, filename, "text/csv;charset=utf-8");
}

/** Give the viewer a file to save, via a blob URL that is revoked after the click. */
export function saveTextFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
