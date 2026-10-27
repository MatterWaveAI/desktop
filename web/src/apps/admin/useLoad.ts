import { useCallback, useEffect, useState } from "react";
import { failureMessage } from "../../shell/authForms";
import { fetchPlans, type AdminPlan } from "./adminApi";

/**
 * The admin tabs' one loading shape: loading, error with a retry, or the
 * data. Shared by every tab so a table and its empty/error states look the
 * same whichever route fed them.
 */
export type Loaded<T> = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: T };

/** One load per `key`; the effect owns the fetch so an unmounted tab never sets state. */
export function useLoad<T>(load: () => Promise<T>, key: unknown): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ phase: "ready", data });
      })
      .catch((err: unknown) => {
        if (alive) setState({ phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
    // `load` is a stable module function or a closure over `key`; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, reload];
}

/** The plan catalog for a picker: every plan, listed or not; [] while it loads or if it cannot. */
export function usePlanCatalog(): AdminPlan[] {
  const [state] = useLoad(fetchPlans, "plans");
  return state.phase === "ready" ? state.data.plans : [];
}

/** The first characters of a UUID: enough to match against a log line, not the whole thing. */
export function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}
