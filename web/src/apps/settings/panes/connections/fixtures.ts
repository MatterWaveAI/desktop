import type {
  Connection,
  ConnectionListing,
  ConnectorEvent,
  Identity,
  MemberOption,
  PresetOption,
  Route,
} from "./connectionsApi";

/*
 * Rows as the connectors routes answer them, for the pane tests: one
 * active Slack connection, one still pending, and the vocabularies the
 * listing carries. Exported so the section tests and the Members and
 * Usage pane tests describe the same registry.
 */

export const OUTCOMES = [
  "accepted",
  "answered",
  "duplicate",
  "bad_signature",
  "stale",
  "unmapped",
  "guest",
  "blocked",
  "channel_not_routed",
  "rate_limited",
  "budget_refused",
  "preset_missing",
  "disabled",
  "suspended",
  "moderation_blocked",
  "model_not_allowed",
  "error",
];

export const IDENTITY_STATUSES = ["mapped", "unmapped", "guest", "blocked"];

export const NOTIFIABLE_EVENTS = [
  "api_key.revoked",
  "budget.exhausted",
  "budget.warn",
  "member.joined",
  "member.removed",
  "member.role_changed",
  "plan.changed",
];

export const CONNECTION: Connection = {
  id: "11111111-1111-7111-8111-111111111111",
  connector: "slack",
  display_name: "Acme Slack",
  status: "active",
  ingress_url: "https://app.example.com/api/hooks/slack/tok-one",
  config: { notify_channel: "C0ADMIN", notify_events: ["budget.warn"] },
  external_workspace_id: "T0ACME",
  rate_limit_per_minute: 60,
  installed_by: "ada",
  last_event_at: "2026-10-20T10:00:00+00:00",
  last_error: null,
  created_at: "2026-10-01T10:00:00+00:00",
  updated_at: "2026-10-20T10:00:00+00:00",
};

export const PENDING: Connection = {
  ...CONNECTION,
  id: "22222222-2222-7222-8222-222222222222",
  display_name: "Beta Slack",
  status: "pending",
  ingress_url: "https://app.example.com/api/hooks/slack/tok-two",
  config: {},
  external_workspace_id: null,
  rate_limit_per_minute: null,
  installed_by: "dev-user",
  last_event_at: null,
  created_at: "2026-10-21T10:00:00+00:00",
};

export const MEMBERS: MemberOption[] = [
  { subject: "ada", email: "ada@acme.com", name: "Ada" },
  { subject: "dev-user", email: "dev@localhost", name: null },
  { subject: "cy", email: "cy@acme.com", name: "Cy" },
];

export const PRESETS: PresetOption[] = [
  { id: "p-support", name: "Support desk" },
  { id: "p-sales", name: "Sales" },
];

export function listing(connections: Connection[]): ConnectionListing {
  return {
    data: connections,
    connectors: ["slack"],
    notifiable_events: NOTIFIABLE_EVENTS,
    outcomes: OUTCOMES,
    identity_statuses: IDENTITY_STATUSES,
  };
}

export function route(overrides: Partial<Route>): Route {
  return {
    id: "r-1",
    connection_id: CONNECTION.id,
    external_channel_id: "C0SUPPORT",
    channel_label: "#support",
    preset_id: "p-support",
    preset_name: "Support desk",
    paying_subject: "ada",
    enabled: true,
    created_by: "ada",
    created_at: "2026-10-02T10:00:00+00:00",
    updated_at: "2026-10-02T10:00:00+00:00",
    ...overrides,
  };
}

export function identity(overrides: Partial<Identity>): Identity {
  return {
    id: "i-1",
    connection_id: CONNECTION.id,
    external_user_id: "U0JANE",
    display_name: "jane",
    email: "ada@acme.com",
    subject: "ada",
    status: "mapped",
    mapped_by: "auto",
    created_at: "2026-10-03T10:00:00+00:00",
    updated_at: "2026-10-03T10:00:00+00:00",
    ...overrides,
  };
}

export function event(overrides: Partial<ConnectorEvent>): ConnectorEvent {
  return {
    id: "e-1",
    connection_id: CONNECTION.id,
    external_event_id: "Ev1",
    received_at: "2026-10-20T10:00:00+00:00",
    kind: "mention",
    outcome: "answered",
    external_user_id: "U0JANE",
    external_channel_id: "C0SUPPORT",
    conversation_id: "conv-1",
    paying_subject: "ada",
    detail: null,
    updated_at: "2026-10-20T10:00:05+00:00",
    ...overrides,
  };
}

/** The three GETs the pane makes on load, answered with the fixtures. */
export function paneLoad(connections: Connection[]) {
  return ({ method, url }: { method: string; url: string }) => {
    if (method !== "GET") return undefined;
    if (url === "/api/org/connections") return { status: 200, body: listing(connections) };
    if (url === "/api/org/members") return { status: 200, body: { data: MEMBERS, role: "admin" } };
    if (url === "/api/org/presets") return { status: 200, body: { data: PRESETS, can_manage: true } };
    return undefined;
  };
}
