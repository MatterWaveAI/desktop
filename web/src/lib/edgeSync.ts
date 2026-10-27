import { apiFetch } from "./api";

/**
 * The edge mirror as the SPA sees it (deploy/edge/sync-design.md). On a box
 * `GET /api/sync/status` reads the worker's state file, so it answers with
 * the uplink unplugged; on the platform it says `box: false`, and nothing
 * here renders.
 */
export interface SyncStatus {
  /** Whether this API is an edge box (`MW_ENV=edge`): it decides whether pairing is offered. */
  box: boolean;
  paired: boolean;
  device_id?: string;
  platform_url?: string;
  name?: string | null;
  paired_at?: string | null;
  last_synced_at?: string | null;
  last_attempt_at?: string | null;
  offline?: boolean;
  /** Conversations still carrying unacknowledged messages after the last run. */
  pending?: number;
  /** Messages past the acknowledged watermark right now; null when uncountable. */
  pending_messages?: number | null;
  pending_capped?: boolean;
  stopped?: "key_rejected" | "platform_newer" | null;
  last_error?: string | null;
  next_attempt_at?: number | null;
  /** Messages the platform refused for good (a 4xx other than 429) and the box stepped past. */
  skipped?: number;
  /** The latest of them: ids, the status and when; never content. */
  skipped_recent?: SkippedMessage[];
}

/** One refusal the box stepped past; `message_id` null is a whole conversation. */
export interface SkippedMessage {
  conversation_id: string;
  message_id: string | null;
  status: number;
  at: string;
}

export const SYNC_STATUS_PATH = "/api/sync/status";

/**
 * How often the badge re-reads the box's sync status. The worker runs once a
 * minute, so a tighter loop would only re-read the same file.
 */
export const SYNC_POLL_MS = 60_000;

/** Fired by the Devices pane after a pairing or an unpairing, so the badge
 * does not wait out its minute to show the change. */
export const SYNC_CHANGED_EVENT = "mw:sync-changed";

export function fetchSyncStatus(): Promise<SyncStatus> {
  return apiFetch<SyncStatus>(SYNC_STATUS_PATH);
}

/** "just now", "4 minutes ago", "2 hours ago", "3 days ago". */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export type SyncTone = "ok" | "busy" | "warn" | "error";

export interface SyncLine {
  text: string;
  tone: SyncTone;
  /** The tooltip: what is waiting and what the last failure was. */
  detail: string;
}

function pendingText(status: SyncStatus): string | null {
  const n = status.pending_messages;
  if (n === null || n === undefined || n === 0) return null;
  const count = status.pending_capped ? `${n}+` : String(n);
  return `${count} message${n === 1 ? "" : "s"} waiting to sync`;
}

function skippedText(status: SyncStatus): string | null {
  const n = status.skipped ?? 0;
  if (n === 0) return null;
  const latest = status.skipped_recent?.at(-1);
  const last = latest ? ` (last: HTTP ${latest.status})` : "";
  return `The platform refused ${n} message${n === 1 ? "" : "s"}; they were skipped${last}.`;
}

/**
 * The one status line the design names, from the last run's outcome. Null
 * when there is nothing to say: not a box, or a box that is not paired.
 */
export function syncLine(
  status: SyncStatus | null,
  now: number,
): SyncLine | null {
  if (!status || !status.box || !status.paired) return null;
  const pending = pendingText(status);
  const error = status.last_error ? `Last error: ${status.last_error}.` : null;
  const skipped = skippedText(status);
  const detail = [
    pending,
    error,
    skipped,
    status.platform_url ? `Platform: ${status.platform_url}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const last = status.last_synced_at ? ago(status.last_synced_at, now) : null;
  if (status.stopped === "key_rejected") {
    return { text: "Sync key rejected: pair again", tone: "error", detail };
  }
  if (status.stopped === "platform_newer") {
    return { text: "Box out of date for this platform", tone: "error", detail };
  }
  if (status.offline) {
    return {
      text: last ? `Offline, last synced ${last}` : "Offline, not synced yet",
      tone: "warn",
      detail,
    };
  }
  if (status.last_error) {
    return {
      text: last ? `Sync failing, last synced ${last}` : "Sync failing",
      tone: "warn",
      detail,
    };
  }
  if ((status.pending ?? 0) > 0) {
    const n = status.pending ?? 0;
    return {
      text: `Syncing ${n} conversation${n === 1 ? "" : "s"}…`,
      tone: "busy",
      detail,
    };
  }
  const refused = status.skipped ?? 0;
  if (last && refused > 0) {
    const noun = `message${refused === 1 ? "" : "s"}`;
    return {
      text: `Synced ${last}, ${refused} ${noun} not mirrored`,
      tone: "warn",
      detail,
    };
  }
  if (last) return { text: `Synced ${last}`, tone: "ok", detail };
  return { text: "Waiting for the first sync", tone: "busy", detail };
}
