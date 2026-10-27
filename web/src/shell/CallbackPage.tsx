import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * Legacy landing spot. The OIDC callback is the API's (`/api/auth/callback`),
 * which sets the session cookie and redirects to `/` itself; nothing
 * sends the browser here any more. Kept so a bookmark or an old redirect URI
 * still ends up in the app instead of a 404.
 */
export function CallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({ to: "/", replace: true });
  }, [navigate]);

  return (
    <div className="flex h-full items-center justify-center text-mw-text-muted">
      <p aria-live="polite" className="animate-pulse text-sm">
        Signing in…
      </p>
    </div>
  );
}
