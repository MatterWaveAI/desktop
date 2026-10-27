import { useParams } from "@tanstack/react-router";
import { SettingsPage } from "./SettingsPage";

/**
 * Route adapter: turns the `/settings/$paneId` path param into the page's
 * prop. It exists so `SettingsPage` stays a plain component a test can
 * render at any pane without standing up a router, and so `routes.ts` — a
 * `.ts` file with no JSX — can register a component rather than build one.
 *
 * `strict: false` because the same adapter serves `/settings`, which has no
 * param; `findPane` falls back to the first pane there.
 */
export function SettingsRoute() {
  const params = useParams({ strict: false }) as { paneId?: string };
  return <SettingsPage paneId={params.paneId} />;
}
