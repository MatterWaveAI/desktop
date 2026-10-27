import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import { PageHeader } from "../../patterns";
import { fetchBillingStatus, type BillingStatus } from "../../lib/billing";
import { queryParam } from "../../shell/authForms";
import { PRICING_PATH } from "../../shell/frontDoor";

/**
 * Where Checkout sends the browser back.
 *
 * Stripe has taken the payment, but the plan lands through the webhook, and
 * the webhook arrives when it arrives -- usually within seconds, sometimes
 * after this page has loaded. So the page polls `/api/billing/status` until
 * the org is on a paid plan, and says what it is doing, because a success
 * page that still shows "Free" is the exact moment a person reaches for the
 * dispute button.
 *
 * Bounded: after ~30 seconds it stops polling and says so, with a link to
 * Billing where the reconcile backstop will have caught up by the time they
 * look. It never says "failed" -- the payment did not fail, the message is
 * late -- and never retries Checkout.
 *
 * Only Checkout's own return counts: Stripe appends `session_id`, and a
 * visit without one -- a bookmark, a typed URL -- goes to the plans rather
 * than being told a payment was received.
 */

const POLL_MS = 2_000;
const POLL_LIMIT = 15;

export function BillingSuccessPage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  if (!queryParam(searchStr, "session_id")) return <Navigate to={PRICING_PATH} replace />;
  return <CheckoutReturn />;
}

function CheckoutReturn() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [polls, setPolls] = useState(0);
  const landed = status !== null && !status.implicit && status.status !== "incomplete";
  const gaveUp = !landed && polls >= POLL_LIMIT;

  useEffect(() => {
    if (landed || gaveUp) return;
    let alive = true;
    const timer = window.setTimeout(
      () => {
        fetchBillingStatus()
          .then((s) => {
            if (!alive) return;
            setStatus(s);
            setPolls((n) => n + 1);
          })
          .catch(() => alive && setPolls((n) => n + 1));
      },
      polls === 0 ? 0 : POLL_MS,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [polls, landed, gaveUp]);

  return (
    <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      <div className="mx-auto w-full max-w-md px-4 py-12">
        <PageHeader
          title={landed ? "You're on " + status.plan_name : "Checkout complete"}
          description={
            landed
              ? "Your plan is active. Its token allowance and limits apply from now."
              : gaveUp
                ? "Checkout went through, but the plan has not shown up here yet. It will within the hour; check Billing."
                : "Activating your plan…"
          }
        />
        <div className="px-4" aria-live="polite" data-billing-landed={landed ? "true" : "false"}>
          {!landed && !gaveUp && (
            <p className="text-sm text-mw-text-muted">Waiting for Stripe to confirm.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {/* `/` rather than the chat path: the index route sends a signed-in
                person to the first app, and app paths are not in the typed
                route union because the registry generates them. */}
            <Link to="/" className="underline underline-offset-2">
              Start chatting
            </Link>
            <Link to="/settings/$paneId" params={{ paneId: "billing" }} className="underline underline-offset-2">
              Billing
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
