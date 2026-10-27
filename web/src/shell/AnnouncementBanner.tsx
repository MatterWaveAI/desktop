import { useEffect, useRef, useState } from "react";
import { fetchActiveAnnouncements, type ActiveAnnouncement } from "../apps/admin/announcementsApi";
import { safeLinkUrl } from "../apps/chat/safeUrl";

/**
 * The operator's announcements between the header and the app: an incident,
 * planned maintenance, a new feature. The API returns the ones inside their
 * window, most severe first; this only draws them.
 *
 * At most one line per severity, so a busy day cannot push the app off a
 * phone screen: the first of each tier, clamped to two lines, with the rest
 * of the tier behind "N more". Expanding a tier shows all of it in full.
 *
 * A dismissible one, once dismissed, stays dismissed on this device (the ids
 * in localStorage). A critical one is never dismissed for good -- the API
 * guarantees that -- but can be hidden for now, until the next load, so it
 * does not hold a small screen hostage. Storage that throws -- a private
 * window, blocked site data -- means a dismissal lasts until the next load,
 * never a broken shell.
 *
 * Fetches on mount and then every two minutes, best effort: a failed read
 * shows nothing rather than an error, the same as BillingBanner.
 */

const REFRESH_MS = 120_000;
const DISMISSED_KEY = "mw-dismissed-announcements";
// Only the newest ids are kept, so the list cannot grow without bound.
const MAX_REMEMBERED = 100;

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    // Storage unavailable: the dismissal holds for this page only.
  }
}

type Severity = ActiveAnnouncement["severity"];

const TIERS: readonly Severity[] = ["critical", "warning", "info"];

const TONE: Record<Severity, string> = {
  critical: "border-mw-danger bg-mw-danger-subtle text-mw-danger",
  warning: "border-mw-warning bg-mw-warning-subtle text-mw-text",
  info: "border-mw-border bg-mw-surface-raised text-mw-text",
};

export function AnnouncementBanner() {
  const [rows, setRows] = useState<ActiveAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  // Critical ones hidden for this page only; never written to storage.
  const [hidden, setHidden] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Severity[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchActiveAnnouncements()
        .then((data) => alive && setRows(data))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const visible = rows.filter(
    (row) =>
      !hidden.includes(row.id) &&
      !(row.dismissible && row.severity !== "critical" && dismissed.includes(row.id)),
  );
  if (visible.length === 0) return null;

  function dismiss(row: ActiveAnnouncement) {
    if (row.severity === "critical") {
      setHidden((ids) => [...ids, row.id]);
      return;
    }
    const next = [...dismissed.filter((d) => d !== row.id), row.id];
    setDismissed(next);
    writeDismissed(next);
  }

  function toggle(tier: Severity) {
    setExpanded((open) => (open.includes(tier) ? open.filter((t) => t !== tier) : [...open, tier]));
  }

  return (
    <div aria-label="Announcements">
      {TIERS.map((tier) => {
        const list = visible.filter((row) => row.severity === tier);
        if (list.length === 0) return null;
        const open = expanded.includes(tier);
        return (open ? list : list.slice(0, 1)).map((row, i) => (
          <AnnouncementRow
            key={row.id}
            row={row}
            open={open}
            more={i === 0 ? list.length - 1 : 0}
            onToggle={i === 0 ? () => toggle(tier) : undefined}
            onDismiss={() => dismiss(row)}
          />
        ));
      })}
    </div>
  );
}

function AnnouncementRow(props: {
  row: ActiveAnnouncement;
  open: boolean;
  /** How many more of this tier sit behind the toggle; only the tier's first row has one. */
  more: number;
  onToggle?: () => void;
  onDismiss: () => void;
}) {
  const { row, open, more, onToggle } = props;
  const text = useRef<HTMLParagraphElement>(null);
  // Whether the clamp is cutting the message off: a lone long message needs
  // the toggle as much as a tier with more behind it.
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = text.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflows(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const href = row.link ? safeLinkUrl(row.link) : undefined;
  // A page on this site opens in place; anywhere else, in a new tab.
  const external = href !== undefined && new URL(href).origin !== location.origin;
  const showToggle = onToggle !== undefined && (more > 0 || overflows || open);
  const critical = row.severity === "critical";
  return (
    <div
      role={critical ? "alert" : "status"}
      data-announcement={row.severity}
      className={`flex items-start gap-3 border-b px-3 py-1.5 text-sm ${TONE[row.severity]}`}
    >
      <p ref={text} className={`min-w-0 flex-1 break-words ${open ? "" : "line-clamp-2"}`}>
        {row.message}
      </p>
      {showToggle && (
        <button type="button" aria-expanded={open} onClick={onToggle} className="shrink-0 underline underline-offset-2">
          {open ? "Show less" : more > 0 ? `${more} more` : "More"}
        </button>
      )}
      {href && (
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="shrink-0 underline underline-offset-2"
        >
          Details
        </a>
      )}
      {(critical || row.dismissible) && (
        <button
          type="button"
          aria-label={critical ? "Hide announcement for now" : "Dismiss announcement"}
          title={critical ? "Hidden until the page is reloaded" : undefined}
          onClick={props.onDismiss}
          className="shrink-0 text-mw-text-muted hover:text-mw-text"
        >
          ×
        </button>
      )}
    </div>
  );
}
