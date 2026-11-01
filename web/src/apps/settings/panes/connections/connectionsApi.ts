import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { ApiError, apiFetch } from "../../../../lib/api";

/*
 * The connectors registry as `/api/org/connections` and its neighbours
 * answer it (api/matterwave/routes_connectors.py), and every call the
 * Connections pane makes of it. The shapes live here so a field the API
 * renames is one edit, and so the pane's parts -- the list, the wizard,
 * routing, identities, the trigger log, notifications -- share one copy.
 */

/**
 * `revoked` and `error` are the provider's to set; `pending` is a Slack
 * connection whose app has not been installed yet (the wizard's first
 * step); an admin switches between `active` and `disabled`.
 */
export type ConnectionStatus = "pending" | "active" | "disabled" | "revoked" | "error";

export interface Connection {
  id: string;
  connector: string;
  display_name: string;
  status: ConnectionStatus;
  ingress_url: string;
  /** The adapter's keys plus the platform's `notify_events` and `notify_channel_id`. */
  config: Record<string, unknown>;
  external_workspace_id: string | null;
  rate_limit_per_minute: number | null;
  installed_by: string;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** `GET /api/org/connections`: the rows and the vocabularies the pane offers. */
export interface ConnectionListing {
  data: Connection[];
  /** The connectors this deployment can make a connection with. */
  connectors: string[];
  notifiable_events: string[];
  outcomes: string[];
  identity_statuses: string[];
}

export interface Route {
  id: string;
  connection_id: string;
  external_channel_id: string;
  channel_label: string;
  preset_id: string;
  /** Null once the preset is deleted; the route then refuses until it is repointed. */
  preset_name: string | null;
  paying_subject: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type IdentityStatus = "mapped" | "unmapped" | "guest" | "blocked";

export interface Identity {
  id: string;
  connection_id: string;
  external_user_id: string;
  display_name: string | null;
  email: string | null;
  subject: string | null;
  status: IdentityStatus;
  mapped_by: string;
  created_at: string;
  updated_at: string;
}

/** `GET /api/org/connector-identities?subject=`: an identity with its connection named. */
export interface LinkedIdentity extends Identity {
  connector: string;
  connection_name: string;
}

export type IdentityAction = "map" | "unmap" | "block" | "unblock";

export interface ConnectorEvent {
  id: string;
  connection_id: string;
  external_event_id: string | null;
  received_at: string;
  kind: string;
  outcome: string;
  external_user_id: string | null;
  external_channel_id: string | null;
  conversation_id: string | null;
  paying_subject: string | null;
  detail: string | null;
  updated_at: string;
}

export interface EventPage {
  data: ConnectorEvent[];
  /** The page after this one; null on the last. */
  next_cursor: string | null;
}

/** One org preset, as much of it as a route needs: `GET /api/org/presets`. */
export interface PresetOption {
  id: string;
  name: string;
}

/** A member as the routing and identity selects name them: `GET /api/org/members`. */
export interface MemberOption {
  subject: string;
  email: string;
  name: string | null;
}

/** The connectors by name as a reader knows them; any other reads as its id. */
export const CONNECTOR_LABELS: Record<string, MessageDescriptor> = {
  slack: msg`Slack`,
};

/** A member's account on a connected workspace, as the Members pane lists it. */
export interface LinkedAccount {
  connector: string;
  connection_name: string;
  identity: Identity;
}

/**
 * Every member's linked accounts in one pass: the connections, then the
 * mapped identities of each, grouped by member. One call per connection
 * rather than one per member, which is the smaller number by far. For a
 * caller the registry refuses, or a deployment without connectors, the
 * map is empty and the pane says nothing about linked accounts.
 */
export async function fetchLinkedAccounts(): Promise<Map<string, LinkedAccount[]>> {
  const linked = new Map<string, LinkedAccount[]>();
  let connections: Connection[];
  try {
    connections = (await fetchConnections()).data;
  } catch {
    return linked;
  }
  const perConnection = await Promise.all(
    connections.map((connection) => fetchIdentities(connection.id, "mapped").catch((): Identity[] => [])),
  );
  connections.forEach((connection, index) => {
    for (const identity of perConnection[index]) {
      if (identity.subject === null) continue;
      const accounts = linked.get(identity.subject) ?? [];
      accounts.push({ connector: connection.connector, connection_name: connection.display_name, identity });
      linked.set(identity.subject, accounts);
    }
  });
  return linked;
}

/** The person behind a subject: their name, else their email, else the subject itself. */
export function memberLabelOf(members: MemberOption[]): (subject: string) => string {
  const bySubject = new Map(members.map((m) => [m.subject, m.name || m.email || m.subject]));
  return (subject) => bySubject.get(subject) ?? subject;
}

/** The config keys the platform reads for notifications; the rest are the adapter's. */
export const NOTIFY_EVENTS_KEY = "notify_events";
export const NOTIFY_CHANNEL_KEY = "notify_channel";

export const CONNECTIONS_PATH = "/api/org/connections";

export const connectionPath = (id: string) => `${CONNECTIONS_PATH}/${encodeURIComponent(id)}`;

// --- the Slack wizard ---------------------------------------------------------------

export const SLACK = "slack";

/** The credentials a Slack app hands over once it is installed. */
export interface SlackCredentials {
  bot_token: string;
  signing_secret: string;
}

/** `GET /api/org/connections/slack/manifest?connection_id=` (routes_slack.py). */
export interface SlackManifest {
  connection_id: string;
  status: ConnectionStatus;
  /** The ingress URL the manifest names as the app's Request URL. */
  request_url: string;
  /** Whether Slack could post to that URL at all: https, on a host that is not local. */
  publicly_reachable: boolean;
  manifest: Record<string, unknown>;
  /** Slack's create-from-manifest page, with the manifest in the address. */
  create_url: string;
}

/** Step one: the pending row, so the Request URL exists before the Slack app does. */
export function createPendingSlackConnection(displayName: string): Promise<Connection> {
  return apiFetch<Connection>(CONNECTIONS_PATH, {
    method: "POST",
    json: { connector: SLACK, display_name: displayName },
  });
}

export function fetchSlackManifest(connectionId: string): Promise<SlackManifest> {
  return apiFetch<SlackManifest>(
    `${CONNECTIONS_PATH}/${SLACK}/manifest?connection_id=${encodeURIComponent(connectionId)}`,
  );
}

/** Step two: the credentials are checked with Slack (`auth.test`) and the row goes active. */
export function activateSlackConnection(connectionId: string, credentials: SlackCredentials): Promise<Connection> {
  return apiFetch<Connection>(connectionPath(connectionId), { method: "PATCH", json: { credentials } });
}

// --- the registry ---------------------------------------------------------------------

export function fetchConnections(): Promise<ConnectionListing> {
  return apiFetch<ConnectionListing>(CONNECTIONS_PATH);
}

export function updateConnection(
  id: string,
  changes: {
    display_name?: string;
    status?: "active" | "disabled";
    rate_limit_per_minute?: number;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  },
): Promise<Connection> {
  return apiFetch<Connection>(connectionPath(id), { method: "PATCH", json: changes });
}

export function deleteConnection(id: string): Promise<void> {
  return apiFetch(connectionPath(id), { method: "DELETE" }).then(() => undefined);
}

export function rotateConnectionUrl(id: string): Promise<Connection> {
  return apiFetch<Connection>(`${connectionPath(id)}/rotate-url`, { method: "POST" });
}

export function fetchRoutes(connectionId: string): Promise<Route[]> {
  return apiFetch<{ data: Route[] }>(`${connectionPath(connectionId)}/routes`).then((body) => body.data);
}

export interface RouteDraft {
  external_channel_id: string;
  channel_label: string;
  preset_id: string;
  paying_subject: string;
  enabled: boolean;
}

export function createRoute(connectionId: string, draft: RouteDraft): Promise<Route> {
  return apiFetch<Route>(`${connectionPath(connectionId)}/routes`, { method: "POST", json: draft });
}

export function updateRoute(
  connectionId: string,
  routeId: string,
  changes: Partial<Omit<RouteDraft, "external_channel_id">>,
): Promise<Route> {
  return apiFetch<Route>(`${connectionPath(connectionId)}/routes/${encodeURIComponent(routeId)}`, {
    method: "PATCH",
    json: changes,
  });
}

export function deleteRoute(connectionId: string, routeId: string): Promise<void> {
  return apiFetch(`${connectionPath(connectionId)}/routes/${encodeURIComponent(routeId)}`, {
    method: "DELETE",
  }).then(() => undefined);
}

export function fetchIdentities(connectionId: string, status: IdentityStatus | null): Promise<Identity[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch<{ data: Identity[] }>(`${connectionPath(connectionId)}/identities${query}`).then(
    (body) => body.data,
  );
}

export function updateIdentity(
  connectionId: string,
  identityId: string,
  action: IdentityAction,
  subject?: string,
): Promise<Identity> {
  return apiFetch<Identity>(`${connectionPath(connectionId)}/identities/${encodeURIComponent(identityId)}`, {
    method: "PATCH",
    json: subject === undefined ? { action } : { action, subject },
  });
}

export function fetchLinkedIdentities(subject: string): Promise<LinkedIdentity[]> {
  return apiFetch<{ data: LinkedIdentity[] }>(
    `/api/org/connector-identities?subject=${encodeURIComponent(subject)}`,
  ).then((body) => body.data);
}

export function fetchEvents(
  connectionId: string,
  query: { outcome?: string | null; cursor?: string | null; limit?: number },
): Promise<EventPage> {
  const params = new URLSearchParams();
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const search = params.toString() ? `?${params.toString()}` : "";
  return apiFetch<EventPage>(`${connectionPath(connectionId)}/events${search}`);
}

export function fetchPresetOptions(): Promise<PresetOption[]> {
  return apiFetch<{ data: PresetOption[] }>("/api/org/presets").then((body) =>
    body.data.map((preset) => ({ id: preset.id, name: preset.name })),
  );
}

export function fetchMemberOptions(): Promise<MemberOption[]> {
  return apiFetch<{ data: MemberOption[] }>("/api/org/members").then((body) =>
    body.data.map((member) => ({ subject: member.subject, email: member.email, name: member.name })),
  );
}

// --- errors -------------------------------------------------------------------------------

export function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * A 422's per-field messages, keyed by field: the API answers a refused
 * preset, member or credential under its field (routes_connectors.py) so
 * the form shows the reason where it was typed.
 */
export function fieldErrors(err: unknown): Record<string, string> {
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
 * The provider's word on new credentials, in plain words. The 422 under
 * `credentials` carries the adapter's reason (a token Slack refused, a
 * revoked one, one for another workspace); anything else is the API's
 * own message, a 502 for a provider that could not be asked among them.
 */
export function credentialsFailure(err: unknown, fallback: string): string {
  return fieldErrors(err).credentials ?? messageOf(err, fallback);
}

/** The listing's 503: connectors are off or there is no Postgres, neither of which an admin can retry. */
export function featureOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}
