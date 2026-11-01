import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBillingStatus } from "../lib/billing";
import type { Principal } from "../types";

export type Plan = { name: string; free: boolean };

/**
 * The plan, read once: on mount for the sidebar's account row, which shows
 * it at rest, or on the first `load()` for the avatar menu, which only
 * shows it once opened. Best effort -- absent until the answer lands, and
 * absent for good if it never does.
 */
export function usePlan(eager: boolean): { plan: Plan | null; load: () => void } {
  const [plan, setPlan] = useState<Plan | null>(null);
  const asked = useRef(false);
  const load = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    fetchBillingStatus()
      .then((status) => setPlan({ name: status.plan_name, free: status.plan === "free" }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (eager) load();
  }, [eager, load]);
  return { plan, load };
}

/** What the account row calls the person: their name, else the part of the address before the @. */
export function displayName(principal: Principal): string {
  if (principal.name) return principal.name;
  if (principal.email) return principal.email.split("@")[0] ?? principal.email;
  return principal.subject;
}

