import { ApiError, apiFetch } from "../../lib/api";

/**
 * Share links: the shapes the API serves and the requests the dialog, the
 * Data pane, the organisation pane and the public page make.
 *
 * Data and fetches outside the components so each component file exports
 * only a component (fast refresh) and the mapping is testable without a DOM.
 * A share is a SNAPSHOT of the transcript at share time, not a live view;
 * the API owns that decision and the dialog says so in its copy.
 */

export type ShareStatus = "active" | "expired" | "revoked";

/** One share as its owner sees it: never the token. */
export interface ShareRecord {
  readonly id: string;
  readonly conversation_id: string;
  readonly title: string;
  readonly message_count: number;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly view_count: number;
  readonly status: ShareStatus;
  /** Whether the owner let readers open the attachments. Off by default. */
  readonly include_attachments?: boolean;
}

/** A share as an org admin sees it: the owner's record plus who made it. */
export interface OrgShareRecord extends ShareRecord {
  readonly created_by: string;
}

/** `POST .../share`: the record plus the token, which appears only here. */
export interface ShareCreated {
  readonly share: ShareRecord;
  readonly token: string;
  /** The SPA path the link opens; the origin is this page's own. */
  readonly path: string;
}

/** What the public page gets: the snapshot and, if the org opted in, its name. */
export interface PublicShare {
  readonly title: string;
  readonly shared_at: string | null;
  readonly messages: readonly PublicMessage[];
  readonly org_name: string | null;
}

export interface PublicMessage {
  readonly role: "user" | "assistant";
  readonly parts: readonly PublicPart[];
  readonly content: string;
  readonly model: string | null;
  /** The model's display name, as the picker shows it; absent on older snapshots. */
  readonly model_label?: string | null;
  readonly created_at: string;
}

/**
 * An attachment in a snapshot: its name always; its id and type only when
 * the owner chose to include attachments, in which case the public
 * attachment route serves the bytes.
 */
export interface PublicAttachmentPart {
  readonly type: "attachment";
  readonly kind: "image" | "document";
  readonly filename: string;
  readonly attachment_id?: string;
  readonly content_type?: string;
}

/**
 * The parts a snapshot keeps: text, and an attachment. Anything else the
 * API may add later renders as nothing rather than throwing.
 */
export type PublicPart =
  | { readonly type: "text"; readonly text: string }
  | PublicAttachmentPart
  | { readonly type: string };

/** The expiry choices the dialog offers; `null` is "until I revoke it". */
export interface ExpiryPreset {
  readonly label: string;
  readonly seconds: number | null;
}

export const EXPIRY_PRESETS: readonly ExpiryPreset[] = [
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { label: "Until revoked", seconds: null },
];

export const DEFAULT_EXPIRY_INDEX = 1;

export function createShare(
  conversationId: string,
  expiresInSeconds: number | null,
  includeAttachments = false,
): Promise<ShareCreated> {
  return apiFetch<ShareCreated>(`/api/conversations/${conversationId}/share`, {
    method: "POST",
    json: { expires_in_s: expiresInSeconds, include_attachments: includeAttachments },
  });
}

export async function listConversationShares(conversationId: string): Promise<ShareRecord[]> {
  const body = await apiFetch<{ data: ShareRecord[] }>(
    `/api/conversations/${conversationId}/shares`,
  );
  return body.data;
}

export async function listMyShares(): Promise<ShareRecord[]> {
  const body = await apiFetch<{ data: ShareRecord[] }>("/api/me/shares");
  return body.data;
}

export function revokeShare(shareId: string): Promise<{ status: "revoked" }> {
  return apiFetch(`/api/shares/${shareId}`, { method: "DELETE" });
}

export function fetchPublicShare(token: string): Promise<PublicShare> {
  return apiFetch<PublicShare>(`/api/share/${encodeURIComponent(token)}`);
}

/** Where the public page fetches an attachment the owner included. */
export function sharedAttachmentUrl(token: string, attachmentId: string): string {
  return `/api/share/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachmentId)}`;
}

// --- the organisation's side ------------------------------------------------------

export interface OrgSharingPolicy {
  readonly enabled: boolean;
}

export function fetchOrgSharing(): Promise<OrgSharingPolicy> {
  return apiFetch<OrgSharingPolicy>("/api/org/sharing");
}

export function setOrgSharing(enabled: boolean): Promise<OrgSharingPolicy> {
  return apiFetch<OrgSharingPolicy>("/api/org/sharing", { method: "PUT", json: { enabled } });
}

export async function listOrgShares(): Promise<OrgShareRecord[]> {
  const body = await apiFetch<{ data: OrgShareRecord[] }>("/api/org/shares");
  return body.data;
}

export function revokeOrgShare(shareId: string): Promise<{ status: "revoked" }> {
  return apiFetch(`/api/org/shares/${shareId}`, { method: "DELETE" });
}

/** What switching sharing off does, in the words the pane shows. */
export function sharingStatusLine(enabled: boolean): string {
  return enabled
    ? "Members can share a conversation by public link. Each link is a snapshot, and whoever made it can revoke it."
    : "Sharing by link is off. Nobody can make a new link, and every existing link stops opening until sharing is switched back on.";
}

// --- helpers ------------------------------------------------------------------------

/** The absolute link a person copies: this origin plus the API's path. */
export function shareUrl(path: string, origin: string = window.location.origin): string {
  return `${origin}${path}`;
}

/** Where "Continue in MatterWave" goes: the front door, which sends a signed-in reader to chat. */
export const CONTINUE_PATH = "/";

/** The SPA route of the public page; `frontDoor.ts` lets it through anonymously. */
export const SHARE_PATH_PREFIX = "/share/";

/** Short, for a list: "Expires 12 Oct 2026" / "Until revoked" / "Revoked" / "Expired". */
export function describeExpiry(share: ShareRecord): string {
  if (share.status === "revoked") return "Revoked";
  if (share.status === "expired") return "Expired";
  if (share.expires_at === null) return "Until revoked";
  return `Expires ${formatDate(share.expires_at)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The line to show when a share request failed; the 404 is the one worth naming. */
export function shareFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This conversation could not be found.";
    if (err.status === 403) return err.message;
    if (err.status === 422) return err.message;
    if (err.status === 429) return err.message;
  }
  return "The link could not be created. Try again in a moment.";
}
