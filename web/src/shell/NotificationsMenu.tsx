import { useCallback, useEffect, useRef, useState } from "react";
import { BellIcon } from "lucide-react";
import type { Notification, NotificationsPage } from "../types";
import { apiFetch } from "../lib/api";

/**
 * The bell in the header: an unread count, and a menu of what it counts.
 *
 * Polled every minute, like the billing banner and for the same reasons --
 * no websockets, and a count that moved on every request would be noise.
 * Opening the menu marks everything read: the person has seen the list,
 * which is what "read" means here, and the badge goes with it.
 *
 * Best effort throughout: a failed read leaves the last list and says so
 * inside the menu; a failed mark-read keeps the badge honest rather than
 * clearing it locally. The shell's tests stub `fetch` with a 404 for routes
 * they do not know, and this must survive that silently.
 */

const NOTIFICATIONS_REFRESH_MS = 60_000;

/** How many rows the menu asks for; the bell is a list of recent events, not a history. */
const PAGE_SIZE = 20;

export function NotificationsMenu() {
  const [rows, setRows] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const page = await apiFetch<Partial<NotificationsPage>>(
        `/api/me/notifications?limit=${PAGE_SIZE}`,
      );
      // A stub or an older API may answer without the count or the rows;
      // either reads as "none" rather than as a crash.
      setRows(Array.isArray(page.data) ? page.data : []);
      setUnread(typeof page.unread_count === "number" ? page.unread_count : 0);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void load();
    };
    tick();
    const timer = window.setInterval(tick, NOTIFICATIONS_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [load]);

  async function markAllRead() {
    if (unread === 0) return;
    try {
      await apiFetch("/api/me/notifications/read-all", { method: "POST" });
      const now = new Date().toISOString();
      setRows((list) => list.map((n) => (n.read_at ? n : { ...n, read_at: now })));
      setUnread(0);
    } catch {
      // The badge stays: it still counts rows the server holds as unread.
    }
  }

  return (
    <details
      className="relative"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          void load().then(markAllRead);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.currentTarget.open = false;
        summaryRef.current?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        event.currentTarget.open = false;
      }}
    >
      <summary
        ref={summaryRef}
        className="relative flex cursor-pointer list-none items-center justify-center rounded p-1.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
      >
        <BellIcon className="size-4" aria-hidden />
        {unread > 0 && (
          <span
            data-mw-unread-count=""
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-mw-accent px-1 text-xs font-medium leading-none text-mw-accent-foreground"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </summary>
      {/* Pinned to the viewport on a phone: the bell is not the rightmost
          control, so a 20rem menu anchored to it would run off the left
          edge of a 360px screen. From `sm` up it hangs from the bell. */}
      <div
        className="fixed inset-x-2 top-12 z-(--mw-z-menu) rounded-md border border-mw-border bg-mw-surface-raised p-1 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80"
        aria-label="Notifications"
      >
        <p className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
          Notifications
        </p>
        {failed && (
          <p role="alert" className="px-2 py-1 text-xs text-mw-danger">
            Notifications could not be loaded.
          </p>
        )}
        {!failed && rows.length === 0 && (
          <p className="px-2 py-2 text-sm text-mw-text-muted">Nothing to see yet.</p>
        )}
        <ul className="max-h-96 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id}>
              <NotificationRow row={row} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function NotificationRow(props: { row: Notification }) {
  const { row } = props;
  const body = (
    <>
      <span className="flex items-start gap-2">
        {/* The unread dot: an aria-hidden mark beside the title; the summary's
            label carries the count for a screen reader. */}
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${row.read_at ? "bg-transparent" : "bg-mw-accent"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{row.title}</span>
          {row.body && <span className="block text-xs text-mw-text-muted">{row.body}</span>}
          <span className="block text-xs text-mw-text-muted">
            <time dateTime={row.created_at}>{formatWhen(row.created_at)}</time>
          </span>
        </span>
      </span>
    </>
  );
  // A plain anchor like the account menu's: this renders in unit tests
  // without a RouterProvider, where <Link> throws.
  if (row.link) {
    return (
      <a href={row.link} className="block rounded px-2 py-1.5 hover:bg-mw-surface-hover">
        {body}
      </a>
    );
  }
  return <div className="rounded px-2 py-1.5">{body}</div>;
}

/** "Today 09:12", "3 Oct", "3 Oct 2025": enough to place it, no relative arithmetic to go stale. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
