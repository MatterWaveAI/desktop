import { useContext, useEffect } from "react";
import { HomeIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { getAuthConfig } from "../lib/auth";
import { WaveMark } from "../components/brand";
import { FrontDoorFrame } from "./FrontDoorChrome";
import { supportLinks } from "./frontDoorLinks";
import { SessionContext } from "./sessionContext";
import { ShellContext } from "./shellContext";

/**
 * The router's not-found page: the waves, a display title, one line on what
 * happened and the way home, with the deployment's support and status links
 * under it when it has any. The links come from the auth config Boot fetched
 * before any route rendered, so this page asks nothing; a deployment that
 * set neither sees the plain page. Outside the shell it wears the front
 * door's header, so a stranger who mistyped an address still has the way in.
 */
export function NotFoundPage() {
  const { t } = useLingui();
  const config = getAuthConfig();
  const links = supportLinks(config);
  const shell = useContext(ShellContext);
  const session = useContext(SessionContext);
  const tabTitle = t`Page not found · MatterWave`;

  // No route matched, so no route's `head` names this page: the tab would
  // keep whatever title the last page left. Set here, and put back on the
  // way out so the next page's own title is not overwritten.
  useEffect(() => {
    const previous = document.title;
    document.title = tabTitle;
    return () => {
      document.title = previous;
    };
  }, [tabTitle]);

  return (
    <FrontDoorFrame config={session?.config ?? config} chrome={shell === null} actions={session === null} footer={false}>
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 px-4 py-20 text-center sm:py-28">
        <WaveMark width={220} className="h-auto max-w-full" />
        <p className="font-mono text-xs tracking-wide text-mw-link">404</p>
        <h1 className="font-display text-display-lg">
          <Trans>
            Page <em>not found</em>
          </Trans>
        </h1>
        <p className="text-mw-text-subtle">
          <Trans>Nothing lives at this address. It may have moved, or the link may be mistyped.</Trans>
        </p>
        <a
          href="/"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-mw-accent px-5 text-sm font-semibold text-mw-accent-foreground hover:bg-mw-accent-hover pointer-coarse:min-h-11"
        >
          <HomeIcon aria-hidden className="size-4" />
          <Trans>Go home</Trans>
        </a>
        {links.length > 0 && (
          <nav
            aria-label={t`Help`}
            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 pt-2 text-sm text-mw-text-muted"
          >
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="inline-flex min-h-6 items-center text-mw-text-secondary underline-offset-2 hover:text-mw-text hover:underline pointer-coarse:min-h-11"
                {...(link.href.startsWith("mailto:") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
              >
                {link.kind === "contact" ? <Trans>Contact support</Trans> : <Trans>Service status</Trans>}
              </a>
            ))}
          </nav>
        )}
      </div>
    </FrontDoorFrame>
  );
}
