import { useEffect, useState } from "react";
import type { ReadyStatus } from "../types";
import { apiFetch } from "../lib/api";

/**
 * How often the badge re-asks `/readyz`. Thirty seconds: a gateway outage is
 * minutes long, so a tighter loop would only add requests from every open
 * tab without the badge appearing meaningfully sooner.
 */
const READY_POLL_MS = 30_000;

/** Surfaces "the model gateway is down" without touching the chat itself. */
export function ReadyBadge() {
  const [status, setStatus] = useState<ReadyStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      apiFetch<ReadyStatus>("/readyz")
        .then((next) => alive && setStatus(next))
        .catch(() => alive && setStatus({ status: "degraded", detail: "API unreachable" }));
    void check();
    const timer = setInterval(check, READY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!status || status.status !== "degraded") return null;
  return (
    <span
      className="ml-2 rounded-full bg-mw-warning-subtle px-2 py-0.5 text-xs text-mw-warning-foreground"
      title={status.detail ?? "The model gateway is down."}
    >
      Model gateway down
    </span>
  );
}
