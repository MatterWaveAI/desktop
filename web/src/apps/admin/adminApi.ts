import { apiFetch } from "../../lib/api";
import type { AccountState } from "../../types";
import type { BillingInvoice, DunningStage, DunningState, ModelPrice } from "../../lib/billing";

/**
 * The admin surface's API, as routes_admin.py serves it. Types and
 * fetchers only: the page is AdminPage.tsx, and keeping data out of it is
 * what keeps fast refresh working for the component file.
 */

export interface AdminOrg {
  id: string;
  name: string;
  zitadel_org_id: string;
  members: number;
  /** The org's own overage cap in micro-dollars; 0 means it runs on its plan's default. */
  overage_cap_micros: number;
  /** Weighted tokens this period. */
  tokens_used: number;
  /** Overage billed this period, in micro-dollars. */
  overage_micros: number;
  created_at: string;
}

export interface AdminUser {
  subject: string;
  email: string;
  name: string | null;
  state: AccountState;
  email_verified: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  org_id: string;
  org_name: string;
  /** The org role, or null for a users row with no membership. */
  role: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface SpendRow {
  org_id: string;
  org_name: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  weighted_tokens: number;
  /** List-price cost of every turn, in micro-dollars. */
  cost_micros: number;
  /** The part of it billed as overage. */
  overage_micros: number;
  events: number;
}

/** One page of `GET /api/admin/orgs`: the rows and the cursor for the next, null at the end. */
export interface OrgPage {
  data: AdminOrg[];
  next_cursor: string | null;
}

/**
 * Orgs newest first, narrowed by `q` the way users are (a name, the
 * identity provider's org id, a prefix of the id, an owner's email) and
 * paged by cursor. With neither, the URL is the bare route, which is what
 * the tabs that want "every org" ask for.
 */
export function fetchOrgPage(q = "", cursor: string | null = null): Promise<OrgPage> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return apiFetch<Partial<OrgPage>>(`/api/admin/orgs${query ? `?${query}` : ""}`).then((body) => ({
    data: body.data ?? [],
    next_cursor: body.next_cursor ?? null,
  }));
}

/** The first page, unfiltered: the org picker other tabs build from. */
export function fetchOrgs(): Promise<AdminOrg[]> {
  return fetchOrgPage().then((page) => page.data);
}

export function fetchUsers(q: string): Promise<AdminUser[]> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiFetch<{ data: AdminUser[] }>(`/api/admin/users${query}`).then((body) => body.data);
}

export function fetchSpend(): Promise<{ rows: SpendRow[]; periodStart: string }> {
  return apiFetch<{ data: SpendRow[]; period_start: string }>("/api/admin/spend").then(
    (body) => ({ rows: body.data, periodStart: body.period_start }),
  );
}

export function suspendUser(subject: string, reason: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/api/admin/users/${encodeURIComponent(subject)}/suspend`, {
    method: "PUT",
    json: { reason: reason.trim() || null },
  });
}

export function unsuspendUser(subject: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/api/admin/users/${encodeURIComponent(subject)}/unsuspend`, {
    method: "PUT",
  });
}

/** Whole dollars and cents from the API's integer cents: plan prices, which Stripe bills in cents. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

// --- billing --------------------------------------------------

export interface AdminPlanRow {
  code: string;
  name: string;
  price_cents_monthly: number;
  price_cents_annual: number;
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  /** Derived server-side: at least one price id, so Checkout can sell it. */
  sellable: boolean;
  limits: Record<string, unknown>;
}

export interface BillingOverview {
  /** Both the key and the webhook secret are set. Either alone is not enough. */
  configured: boolean;
  has_api_key: boolean;
  has_webhook_secret: boolean;
  /** MW_LITELLM_VIRTUAL_KEYS: with it off the app gate is the only enforcement. */
  upstream_enforcement: boolean;
  plans: AdminPlanRow[];
  plans_without_prices: string[];
}

export interface StripeEventRow {
  event_id: string;
  event_type: string;
  /** applied | ignored | unresolved */
  outcome: string;
  org_id: string | null;
  org_name: string | null;
  received_at: string;
}

export interface ReconcileReport {
  checked: number;
  repaired: number;
  failed: number;
  skipped: number;
  over_entitled: number;
  under_entitled: number;
}

export function fetchBilling(): Promise<BillingOverview> {
  return apiFetch<BillingOverview>("/api/admin/billing");
}

export function fetchStripeEvents(): Promise<StripeEventRow[]> {
  return apiFetch<{ data: StripeEventRow[] }>("/api/admin/billing/events").then((b) => b.data);
}

export function setStripePrices(
  code: string,
  monthly: string | null,
  annual: string | null,
): Promise<AdminPlanRow> {
  return apiFetch<AdminPlanRow>(
    `/api/admin/billing/plans/${encodeURIComponent(code)}/stripe`,
    { method: "PUT", json: { monthly, annual } },
  );
}

export function runReconcile(): Promise<ReconcileReport> {
  return apiFetch<ReconcileReport>("/api/admin/billing/reconcile", { method: "POST" });
}

// --- moderation -----------------------------------------------

/** A moderation_flags row: category, score and action -- never message text. */
export interface ModerationFlag {
  id: string;
  owner_subject: string;
  org_id: string | null;
  message_id: string | null;
  conversation_id: string | null;
  category: string;
  score: number | null;
  /** blocked | flagged */
  action: string;
  provider: string;
  created_at: string;
}

/** An open report in the review queue, oldest first. `note` is the reporter's own words. */
export interface ModerationReport {
  id: string;
  reporter_subject: string;
  org_id: string | null;
  message_id: string | null;
  conversation_id: string | null;
  kind: string;
  note: string | null;
  created_at: string;
}

export interface ModerationUserRecord {
  subject: string;
  violations: number;
  window_days: number;
  threshold: number;
  /** Advisory only: suspension stays a human decision with a written reason. */
  over_threshold: boolean;
}

export function fetchModerationFlags(): Promise<ModerationFlag[]> {
  return apiFetch<{ data: ModerationFlag[] }>("/api/admin/moderation/flags").then((b) => b.data);
}

export function fetchModerationReports(): Promise<ModerationReport[]> {
  return apiFetch<{ data: ModerationReport[] }>("/api/admin/moderation/reports").then((b) => b.data);
}

export function fetchModerationUser(subject: string): Promise<ModerationUserRecord> {
  return apiFetch<ModerationUserRecord>(`/api/admin/moderation/users/${encodeURIComponent(subject)}`);
}

export function resolveReport(reportId: string, resolution: string): Promise<{ id: string; reviewed_by: string }> {
  return apiFetch<{ id: string; reviewed_by: string }>(
    `/api/admin/moderation/reports/${encodeURIComponent(reportId)}/resolve`,
    { method: "PUT", json: { resolution } },
  );
}

// --- system health --------------------------------------------

export interface AdminHealth {
  version: string;
  revision: string;
  release: string;
  git_sha: string | null;
  upstream: {
    /** ok | degraded, as /readyz reports it. */
    status: string;
    models: number | null;
    detail: string | null;
  };
  database: {
    configured: boolean;
    migration: string | null;
    latest_migration: string | null;
    pending_migrations: string[];
  };
  billing_enabled: boolean;
  moderation: boolean;
  web_search: boolean;
  upstream_enforcement: boolean;
}

export function fetchHealth(): Promise<AdminHealth> {
  return apiFetch<AdminHealth>("/api/admin/health");
}

/** Live attachments by scan status, and which scanner decides them. */
export interface AttachmentScans {
  /** `none` or `clamav` (MW_ATTACHMENT_SCANNER). */
  scanner: string;
  counts: {
    scanning: number;
    clean: number;
    infected: number;
    scan_failed: number;
  };
}

export function fetchAttachmentScans(): Promise<AttachmentScans> {
  return apiFetch<AttachmentScans>("/api/admin/attachments/scans");
}

// --- per-org operations ---------------------------------------

export interface AdminKey {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface AdminInvite {
  id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  /** pending | expired (accepted and revoked ones are not listed). */
  status: string;
}

/** An org's period as `PUT /api/admin/orgs/{id}/budget` answers: the same shape as `GET /api/budget`. */
export interface AdminBudget {
  period_start: string;
  included_tokens: number;
  tokens_used: number;
  remaining_tokens: number;
  overage_enabled: boolean;
  /** The cap in force: the org's own, or the plan's default when it has none. */
  overage_cap_micros: number;
  overage_micros: number;
}

export function fetchOrgKeys(orgId: string): Promise<AdminKey[]> {
  return apiFetch<{ data: AdminKey[] }>(`/api/admin/orgs/${encodeURIComponent(orgId)}/keys`).then((b) => b.data);
}

export function revokeOrgKey(orgId: string, keyId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/orgs/${encodeURIComponent(orgId)}/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
}

/** Set an org's overage cap in micro-dollars; 0 returns it to the plan's default. */
export function setOrgBudget(orgId: string, overageCapMicros: number): Promise<AdminBudget> {
  return apiFetch<AdminBudget>(`/api/admin/orgs/${encodeURIComponent(orgId)}/budget`, {
    method: "PUT",
    json: { overage_cap_micros: overageCapMicros },
  });
}

export function fetchOrgInvites(orgId: string): Promise<AdminInvite[]> {
  return apiFetch<{ data: AdminInvite[] }>(`/api/admin/orgs/${encodeURIComponent(orgId)}/invites`).then(
    (b) => b.data,
  );
}

// --- deletion requests ----------------------------------------

export interface DeletionRequest {
  id: string;
  org_id: string | null;
  org_name: string | null;
  subject: string;
  email: string | null;
  requested_at: string;
  completed_at: string | null;
  /** Whether the identity provider confirmed the login is gone. */
  identity_removed: boolean;
  /** What the provider said when it did not. */
  notes: string | null;
}

export function fetchDeletionRequests(): Promise<DeletionRequest[]> {
  return apiFetch<{ data: DeletionRequest[] }>("/api/admin/deletion-requests").then((b) => b.data);
}

// --- the plan catalog -----------------------------------------

/** The limits every plan carries, in FREE_LIMITS' exact shape. Null is unlimited. */
export interface PlanLimits {
  /** The monthly allowance, in weighted tokens; the flat part, on a plan sold per seat. */
  included_tokens: number;
  /**
   * What each seat adds to the allowance, pooled across the org. Not null is
   * what makes a plan sold per seat: its price and default overage cap are
   * per seat and its Stripe quantity is the member count. Null is sold flat.
   */
  included_tokens_per_seat: number | null;
  /** Past the allowance: billed at list price up to the org's cap (true) or refused (false). */
  overage_enabled: boolean;
  budget_duration: string;
  tpm_limit: number | null;
  rpm_limit: number | null;
  max_parallel_requests: number | null;
  max_conversations: number | null;
  max_seats: number | null;
  /**
   * A list is what the plan adds beyond the house model, partner models
   * included only if named, and only ids the price list prices (anything
   * else is a 422). Null is every GRT model the gateway serves and never a
   * partner model.
   */
  allowed_models: string[] | null;
  features: Record<string, boolean>;
}

export interface AdminPlan {
  code: string;
  display_name: string;
  is_public: boolean;
  limits: PlanLimits;
  /** Read-only here: Stripe owns the prices; the billing tab copies the ids. */
  price_cents_monthly: number;
  price_cents_annual: number;
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  stripe_price_id_overage: string | null;
  /** Derived server-side: the plan's monthly price, as the cap an org gets by default. */
  default_overage_cap_micros: number;
  /** The live orgs on the plan now: what a feature switch-off confirms against. */
  org_count?: number;
  /** A new subscriber's free trial, in days; 0 is none. Offered once per org. */
  trial_days?: number;
}

/** One plan feature as the API describes it: its name, a label and what it gates. */
export interface FeatureInfo {
  name: string;
  label: string;
  description: string;
}

/** The editable half of a plan; what `PUT /api/admin/plans/{code}` takes. */
export interface PlanEdit {
  display_name: string;
  is_public: boolean;
  limits: PlanLimits;
  /** The free trial in days, 0 for none; left out, the plan keeps its trial. */
  trial_days?: number;
}

/** Stripe's ceiling on a trial's length, which the API enforces too. */
export const MAX_TRIAL_DAYS = 730;

/** An org a proposed cap would strand, as the 409 names it. */
export interface OverLimitOrg {
  org_id: string;
  org_name: string;
  conversations: number;
  seats: number;
  over: string[];
}

/** `GET /api/admin/plans` whole: every plan, and the models a plan may name. */
export interface AdminCatalog {
  plans: AdminPlan[];
  /** The price list, GRT first and partners after: the only ids `allowed_models` may hold. */
  models: ModelPrice[];
  /** The known plan features, in the order the editors show them. */
  features: FeatureInfo[];
  /** The model every plan allows whatever its list says; null from an API that does not name it. */
  houseModel: string | null;
}

export function fetchPlans(): Promise<AdminCatalog> {
  return apiFetch<{ data: AdminPlan[]; models?: ModelPrice[]; features?: FeatureInfo[]; house_model?: unknown }>(
    "/api/admin/plans",
  ).then((b) => ({
    plans: Array.isArray(b.data) ? b.data : [],
    models: Array.isArray(b.models) ? b.models : [],
    features: Array.isArray(b.features) ? b.features : [],
    houseModel: typeof b.house_model === "string" && b.house_model ? b.house_model : null,
  }));
}

/** An org's plan and subscription status, as its entitlement resolves them. */
export interface OrgPlan {
  plan: string;
  plan_name: string;
  status: string;
  /** No subscription row: on Free by default. */
  implicit: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
}

export function fetchOrgPlan(orgId: string): Promise<OrgPlan> {
  return apiFetch<OrgPlan>(`/api/admin/orgs/${encodeURIComponent(orgId)}/plan`);
}

/** Put the org on a catalog plan with no Stripe subscription behind it (an invoiced deal, a comp). */
export function setOrgPlan(orgId: string, plan: string, reason: string): Promise<OrgPlan> {
  return apiFetch<OrgPlan>(`/api/admin/orgs/${encodeURIComponent(orgId)}/plan`, {
    method: "PUT",
    json: { plan, reason: reason.trim() || null },
  });
}

/** `PUT /api/admin/plans/{code}/features`: switch some features; the rest keep their value. */
export function savePlanFeatures(code: string, features: Record<string, boolean>): Promise<unknown> {
  return apiFetch<unknown>(`/api/admin/plans/${encodeURIComponent(code)}/features`, {
    method: "PUT",
    json: { features },
  });
}

/** One feature for one org: the plan's value, the org's override (null inherits) and the result. */
export interface OrgFeature extends FeatureInfo {
  plan: boolean;
  override: boolean | null;
  effective: boolean;
}

export interface OrgFeatures {
  plan_code: string;
  plan_name: string;
  features: OrgFeature[];
}

/** A body with no feature list reads as an empty one rather than breaking the table. */
function orgFeaturesOf(body: OrgFeatures): OrgFeatures {
  return { ...body, features: Array.isArray(body.features) ? body.features : [] };
}

export function fetchOrgFeatures(orgId: string): Promise<OrgFeatures> {
  return apiFetch<OrgFeatures>(`/api/admin/orgs/${encodeURIComponent(orgId)}/features`).then(orgFeaturesOf);
}

/** Override one feature for one org: true or false over the plan, null to inherit it again. */
export function setOrgFeature(orgId: string, name: string, override: boolean | null): Promise<OrgFeatures> {
  return apiFetch<OrgFeatures>(
    `/api/admin/orgs/${encodeURIComponent(orgId)}/features/${encodeURIComponent(name)}`,
    { method: "PUT", json: { override } },
  ).then(orgFeaturesOf);
}

export function savePlan(code: string, edit: PlanEdit, force = false): Promise<AdminPlan> {
  return apiFetch<AdminPlan>(`/api/admin/plans/${encodeURIComponent(code)}`, {
    method: "PUT",
    json: { ...edit, force },
  });
}

/** The orgs out of a 409's body, or null when the refusal was something else. */
export function overLimitOrgs(body: unknown): OverLimitOrg[] | null {
  const detail = (body as { detail?: { orgs?: unknown } } | undefined)?.detail;
  return Array.isArray(detail?.orgs) ? (detail.orgs as OverLimitOrg[]) : null;
}

// --- feature flags --------------------------------------------

export interface FlagRollout {
  /** organizations.id values, as the orgs tab shows them. */
  orgs: string[];
  percent: number;
}

export interface AdminFlag {
  key: string;
  enabled: boolean;
  description: string;
  rollout: FlagRollout;
  updated_by: string | null;
  updated_at: string | null;
  /** What the environment (MW_FLAG_*) says; the row overrides it. */
  default: boolean;
  /** Whether a row exists. Without one the key is at its default. */
  defined: boolean;
}

export interface FlagEdit {
  enabled: boolean;
  description: string;
  rollout: FlagRollout;
}

export function fetchFlags(): Promise<AdminFlag[]> {
  return apiFetch<{ data: AdminFlag[] }>("/api/admin/flags").then((b) => b.data);
}

export function saveFlag(key: string, edit: FlagEdit): Promise<AdminFlag> {
  return apiFetch<AdminFlag>(`/api/admin/flags/${encodeURIComponent(key)}`, {
    method: "PUT",
    json: edit,
  });
}

export function resetFlag(key: string): Promise<{ key: string; default: boolean; defined: false }> {
  return apiFetch(`/api/admin/flags/${encodeURIComponent(key)}`, { method: "DELETE" });
}

// --- support mode ---------------------------------------------

export interface SupportSession {
  active: true;
  id: string;
  org_id: string;
  org_name: string;
  started_at: string;
  expires_at: string;
}

/** `GET /api/admin/support`: the operator's open session, or none. */
export function fetchSupportSession(): Promise<SupportSession | null> {
  return apiFetch<Partial<SupportSession>>("/api/admin/support").then((body) =>
    body.active === true && typeof body.org_id === "string" ? (body as SupportSession) : null,
  );
}

/** Open a support session; the reason is required and kept on the audit row. */
export function startSupport(orgId: string, reason: string): Promise<SupportSession> {
  return apiFetch<SupportSession>(`/api/admin/support/${encodeURIComponent(orgId)}`, {
    method: "POST",
    json: { reason: reason.trim() },
  });
}

export function endSupport(): Promise<void> {
  return apiFetch<unknown>("/api/admin/support", { method: "DELETE" }).then(() => undefined);
}

/**
 * A full navigation, not a router push: entering or leaving support mode
 * changes who the API thinks is asking, and everything the shell loaded at
 * boot (the principal, the feature flags from /api/auth-config) was loaded
 * for the other identity. Reloading is the honest way to get it all back.
 */
export function navigateTo(path: string): void {
  window.location.assign(path);
}

// --- data retention -------------------------------------------

export interface RetentionOrgPreview {
  org_id: string;
  org_name: string;
  retention_days: number;
  cutoff: string;
  conversations: number;
}

export interface RetentionPreview {
  generated_at: string;
  orgs: RetentionOrgPreview[];
  soft_delete_count: number;
  hard_delete_cutoff: string;
  hard_delete_count: number;
  /** The soft-to-hard window, from the job: 30 days. */
  purge_days: number;
}

export function fetchRetentionPreview(): Promise<RetentionPreview> {
  return apiFetch<RetentionPreview>("/api/admin/retention/preview");
}

export function fetchOrgRetention(orgId: string): Promise<number | null> {
  return apiFetch<{ retention_days: number | null }>(
    `/api/admin/orgs/${encodeURIComponent(orgId)}/retention`,
  ).then((b) => b.retention_days);
}

export function setOrgRetention(orgId: string, days: number | null): Promise<number | null> {
  return apiFetch<{ retention_days: number | null }>(
    `/api/admin/orgs/${encodeURIComponent(orgId)}/retention`,
    { method: "PUT", json: { retention_days: days } },
  ).then((b) => b.retention_days);
}

// --- late payments and invoice billing ----------------------------------

/** A late-payment policy with every layer applied (dunning.Policy). */
export interface DunningPolicy {
  warn_day: number;
  warn_final_day: number;
  limited_day: number;
  suspended_day: number;
  auto_suspend: boolean;
  limited_stops_overage: boolean;
  limited_blocks_new_keys: boolean;
  limited_blocks_upgrades: boolean;
  max_days_overdue: number;
  max_outstanding_micros: number;
  overridden: boolean;
  note: string | null;
}

/** The fields an org's own policy may set; absent ones inherit the platform default. */
export type DunningOverride = Partial<Omit<DunningPolicy, "overridden">>;

/** The ceilings no per-org value may pass. */
export interface DunningLimits {
  max_days_overdue_ceiling: number;
  max_outstanding_ceiling_micros: number;
}

/** One row of the Overdue tab. */
export interface OverdueRow {
  org_id: string;
  org_name: string;
  plan: string | null;
  stage: DunningStage;
  source: "card" | "invoice";
  collection_method: "charge_automatically" | "send_invoice";
  days_until_due: number | null;
  first_overdue_at: string;
  days_overdue: number;
  outstanding_micros: number;
  grace_days: number;
  next_step: { stage: DunningStage; at: string } | null;
  policy: DunningPolicy;
  overridden: boolean;
  note: string | null;
  overage_stopped: boolean;
  days_limit_hit_at: string | null;
  amount_limit_hit_at: string | null;
  invoice_id: string | null;
}

/** `GET /api/admin/orgs/{id}/billing`: one org's money as the operator manages it. */
export interface OrgBilling {
  org_id: string;
  policy: DunningPolicy;
  platform_policy: DunningPolicy;
  override: DunningOverride;
  limits: DunningLimits;
  dunning: DunningState | null;
  grace_days: number;
  collection_method: "charge_automatically" | "send_invoice";
  days_until_due: number | null;
  invoicing: { billing_email: string; po_number: string | null } | null;
  invoices: BillingInvoice[];
}

export interface InvoicingEdit {
  terms: 15 | 30 | 60;
  billing_email: string;
  po_number: string | null;
  /** Only for an org with no subscription yet. */
  plan: string | null;
  annual: boolean;
}

const orgPath = (orgId: string) => `/api/admin/orgs/${encodeURIComponent(orgId)}`;

export function fetchOverdue(): Promise<{ rows: OverdueRow[]; limits: DunningLimits }> {
  return apiFetch<{ data: OverdueRow[]; limits: DunningLimits }>("/api/admin/billing/overdue").then((b) => ({
    rows: b.data,
    limits: b.limits,
  }));
}

export function fetchOrgBilling(orgId: string): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/billing`);
}

/** Set the org's own policy; an empty object clears it. A value past a ceiling answers 422. */
export function saveDunningPolicy(orgId: string, override: DunningOverride): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/billing/policy`, { method: "PUT", json: override });
}

export function extendGrace(orgId: string, days: number, reason: string): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/billing/extend`, {
    method: "POST",
    json: { days, reason: reason.trim() || null },
  });
}

export function markInvoicePaid(orgId: string, invoiceId: string, reason: string): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/invoices/${encodeURIComponent(invoiceId)}/mark-paid`, {
    method: "POST",
    json: { reason: reason.trim() || null },
  });
}

export function resendInvoice(orgId: string, invoiceId: string): Promise<{ id: string; sent: boolean }> {
  return apiFetch<{ id: string; sent: boolean }>(
    `${orgPath(orgId)}/invoices/${encodeURIComponent(invoiceId)}/resend`,
    { method: "POST" },
  );
}

export function switchToInvoicing(orgId: string, edit: InvoicingEdit): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/billing/invoicing`, { method: "PUT", json: edit });
}

export function switchToCard(orgId: string): Promise<OrgBilling> {
  return apiFetch<OrgBilling>(`${orgPath(orgId)}/billing/invoicing`, { method: "DELETE" });
}

/** What each stage is called on the operator's pages. */
export const STAGE_LABEL: Record<DunningStage, string> = {
  pending: "Late, not yet warned",
  warn: "Warned",
  warn_final: "Final warning",
  limited: "Limited",
  suspended: "On Free",
};
