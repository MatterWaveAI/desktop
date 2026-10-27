import { useContext, useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { managesOrg } from "../lib/auth";
import { fetchBillingStatus, fetchUsage, type BillingStatus, type UsageSummary } from "../lib/billing";
import { noticeFor } from "./billingNotice";
import { ShellContext } from "./shellContext";

// The Billing pane draws the subscription notice at its top; the banner
// repeating it above would say the same thing twice on one screen.
const BILLING_PANE_PATH = "/settings/billing";

/**
 * The one line between the header and the app that says money or tokens
 * need attention. Absent when nothing does, which is
 * nearly always, so it never becomes furniture.
 *
 * Priority, highest first, one at a time: a payment problem (past due,
 * read-only after a downgrade), then the hard stop, then overage, then the
 * 80% warning. The API decides the usage state (routes_usage.py); this
 * component only orders them, so the Usage pane and this line can never
 * disagree about which message a person sees.
 *
 * Fetches on mount and then every minute. Not after every chat turn: the
 * balance moves by a few tokens per turn and a banner that flickered on
 * each send would train people to ignore it. Both fetches are best effort
 * and swallow their own errors -- a billing read failing must not take the
 * shell with it, and the shell's tests stub `fetch` with a 404 for anything
 * they do not know, which this must survive silently.
 */

const REFRESH_MS = 60_000;

export function BillingBanner() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchBillingStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
      fetchUsage()
        .then((u) => alive && setUsage(u))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const shell = useContext(ShellContext);
  const pathname = useLocation({ select: (location) => location.pathname });
  const notice = noticeFor(status, usage, { managesOrg: managesOrg(shell?.principal) });
  // A warning can be dismissed for the session; the hard stop and a payment
  // problem cannot, because dismissing them changes nothing about the next
  // request being refused.
  if (!notice || (notice.tone === "warning" && dismissed === notice.text)) return null;
  if (notice.kind === "subscription" && pathname.replace(/\/$/, "") === BILLING_PANE_PATH) return null;

  return (
    <div
      role="status"
      data-billing-banner={notice.tone}
      className={`flex items-center gap-3 border-b px-3 py-1.5 text-sm ${
        notice.tone === "danger"
          ? "border-mw-danger bg-mw-danger-subtle text-mw-danger"
          : "border-mw-border bg-mw-surface-raised text-mw-text"
      }`}
    >
      <p className="line-clamp-2 min-w-0 flex-1" title={notice.text}>
        {notice.text}
      </p>
      <Link
        to={notice.link.to}
        params={{ paneId: notice.link.paneId }}
        className="shrink-0 underline underline-offset-2"
      >
        {notice.link.label}
      </Link>
      {notice.tone === "warning" && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(notice.text)}
          className="shrink-0 text-mw-text-muted hover:text-mw-text"
        >
          ×
        </button>
      )}
    </div>
  );
}
