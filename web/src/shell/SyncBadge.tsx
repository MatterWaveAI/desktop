import { useEffect, useState } from "react";
import {
  fetchSyncStatus,
  SYNC_CHANGED_EVENT,
  SYNC_POLL_MS,
  syncLine,
  type SyncStatus,
  type SyncTone,
} from "../lib/edgeSync";

const TONE_CLASS: Record<SyncTone, string> = {
  ok: "bg-mw-surface-hover text-mw-text-muted",
  busy: "bg-mw-surface-hover text-mw-text",
  warn: "bg-mw-warning-subtle text-mw-warning-foreground",
  error: "bg-mw-danger-subtle text-mw-danger",
};

/**
 * "Synced 4 minutes ago" on an edge box that is paired with the platform;
 * nothing on the platform itself or on a box that is not paired. The first
 * answer saying `box: false` ends the polling: a platform tab does not ask
 * every minute for a status it will never have.
 */
export function SyncBadge(props: { now?: () => number }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [, setTick] = useState(0);
  const now = props.now ?? Date.now;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const check = () =>
      fetchSyncStatus()
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          setTick((t) => t + 1);
          if (!next.box && timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        })
        // An unreachable API is the ReadyBadge's to report, not this one's.
        .catch(() => {});
    void check();
    timer = setInterval(check, SYNC_POLL_MS);
    const onChanged = () => void check();
    window.addEventListener(SYNC_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener(SYNC_CHANGED_EVENT, onChanged);
    };
  }, []);

  const line = syncLine(status, now());
  if (!line) return null;
  return (
    <span
      className={`ml-2 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[line.tone]}`}
      title={line.detail || undefined}
      role="status"
      aria-label={`Sync: ${line.text}`}
      data-tone={line.tone}
    >
      {line.text}
    </span>
  );
}
