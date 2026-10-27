import { useEffect, useState } from "react";
import type { Principal } from "../../types";
import { fetchSupportSession } from "../admin/adminApi";

/**
 * Whether this page is an operator's support session: viewing an org's
 * conversations read only, where the API refuses every write.
 *
 * Asked of `/api/admin/support`, the same read the support banner makes,
 * and only for an operator -- a member never has a session and never makes
 * the request. Anything but an active session (an older API, a 404, a
 * failure) reads as "not support": the API still refuses the writes, so the
 * worst case is a composer that is enabled and then says no.
 */
export function useSupportReadOnly(principal: Principal): boolean {
  const operator = principal.roles.includes("admin");
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!operator) return;
    let alive = true;
    fetchSupportSession()
      .then((session) => {
        if (alive) setActive(session !== null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [operator]);
  return operator && active;
}
