import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { failureMessage } from "../../shell/authForms";
import { useShell } from "../../shell/shellContext";
import { endSupport, fetchSupportSession, navigateTo, type SupportSession } from "./adminApi";

/**
 * The line that says the operator is not themselves right now.
 *
 * Shown for the whole of a support session, on every page, because the
 * session changes what every request means: reads answer for the org,
 * writes are refused. It cannot be dismissed, only exited. Asked once at
 * mount, and only for an operator -- a member's shell never makes the
 * request, and an API that answers anything but an active session (an
 * older API, a stub, a 404) shows nothing.
 */
export function SupportBanner() {
  const { principal } = useShell();
  const operator = principal.roles.includes("admin");
  const [session, setSession] = useState<SupportSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!operator) return;
    let alive = true;
    fetchSupportSession()
      .then((found) => alive && setSession(found))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [operator]);

  if (!session) return null;

  async function exit() {
    setBusy(true);
    setError(null);
    try {
      await endSupport();
      navigateTo("/admin");
    } catch (err: unknown) {
      setError(failureMessage(err));
      setBusy(false);
    }
  }

  const until = new Date(session.expires_at);
  return (
    <div
      role="status"
      data-support-banner
      className="flex items-center gap-3 border-b border-mw-danger bg-mw-danger-subtle px-3 py-1.5 text-sm text-mw-danger"
    >
      <p className="min-w-0 flex-1">
        Viewing {session.org_name} as support — read only
        {!Number.isNaN(until.getTime()) && (
          <span className="text-xs"> (until {until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</span>
        )}
        {error && <span role="alert"> · {error}</span>}
      </p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void exit()}>
        Exit support
      </Button>
    </div>
  );
}
