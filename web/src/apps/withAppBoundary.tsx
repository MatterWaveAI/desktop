import type { RouteComponent } from "@tanstack/react-router";
import type { AppDescriptor } from "./registry";
import { AppErrorBoundary } from "../shell/AppErrorBoundary";

/**
 * Wrap a registered app's component in its own error boundary.
 *
 * Applied at the mount point rather than inside each app, for two reasons. An
 * app cannot opt out of it — which matters once the apps are not all ours —
 * and an app added to the registry later gets the boundary without anyone
 * remembering to add it.
 *
 * Per app, not one at the root. A root boundary catches the throw but replaces
 * the shell along with the app, which leaves the user exactly where the white
 * screen would have: no nav, no way out, nothing but an apology. Scoped here,
 * the shell chrome survives and the failure is contained to the <Outlet/>.
 */
export function withAppBoundary(app: AppDescriptor): RouteComponent {
  const Mounted = app.component;
  function BoundedApp() {
    return (
      <AppErrorBoundary appName={app.title}>
        <Mounted />
      </AppErrorBoundary>
    );
  }
  BoundedApp.displayName = `WithAppBoundary(${app.id})`;
  return BoundedApp;
}
