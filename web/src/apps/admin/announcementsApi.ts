import { apiFetch } from "../../lib/api";

/**
 * Operator announcements, as api/matterwave/announcements.py serves them:
 * the admin routes behind the Announcements tab and the signed-in read the
 * shell's banner polls. Types and fetchers only.
 */

export type AnnouncementSeverity = "info" | "warning" | "critical";

/** What the banner gets: no authoring columns. */
export interface ActiveAnnouncement {
  id: string;
  message: string;
  severity: AnnouncementSeverity;
  link: string | null;
  starts_at: string;
  ends_at: string | null;
  /** Always false for a critical one: the API forces it. */
  dismissible: boolean;
}

/** The operator's row: every column, and where its window stands now. */
export interface AdminAnnouncement extends ActiveAnnouncement {
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  state: "scheduled" | "active" | "ended";
}

export interface AnnouncementDraft {
  message: string;
  severity: AnnouncementSeverity;
  link: string | null;
  /** ISO; null on create means now. */
  starts_at: string | null;
  /** ISO; null means until someone ends it. */
  ends_at: string | null;
  dismissible: boolean;
}

export const MAX_ANNOUNCEMENT_LENGTH = 500;

export function fetchActiveAnnouncements(): Promise<ActiveAnnouncement[]> {
  return apiFetch<{ data: ActiveAnnouncement[] }>("/api/announcements").then((b) => b.data);
}

export function fetchAnnouncements(): Promise<AdminAnnouncement[]> {
  return apiFetch<{ data: AdminAnnouncement[] }>("/api/admin/announcements").then((b) => b.data);
}

export function createAnnouncement(draft: AnnouncementDraft): Promise<AdminAnnouncement> {
  const { starts_at, ...rest } = draft;
  return apiFetch<AdminAnnouncement>("/api/admin/announcements", {
    method: "POST",
    json: starts_at === null ? rest : draft,
  });
}

export function updateAnnouncement(id: string, changes: Partial<AnnouncementDraft>): Promise<AdminAnnouncement> {
  return apiFetch<AdminAnnouncement>(`/api/admin/announcements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: changes,
  });
}

/** Ends it on the server's clock, not this browser's. */
export function endAnnouncement(id: string): Promise<AdminAnnouncement> {
  return apiFetch<AdminAnnouncement>(`/api/admin/announcements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: { end_now: true },
  });
}

export function deleteAnnouncement(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `<input type="datetime-local">` speaks local wall-clock time without a zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
