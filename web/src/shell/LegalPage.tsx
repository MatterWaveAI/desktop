import { useContext, useEffect, useState, type ReactNode } from "react";
import { ensureAuthConfig } from "./authForms";
import { POLICY_PATH, PRIVACY_PATH, SIGNUP_PATH, TERMS_PATH } from "./frontDoor";
import { TAP_LINK_CLASS } from "./frontDoorLinks";
import { SessionContext } from "./sessionContext";
import { ShellContext } from "./shellContext";
import { getAuthConfig } from "../lib/auth";
import { FrontDoorFrame } from "./FrontDoorChrome";

/**
 * The frame the two legal pages share. Both render under the front
 * door - the signup form links them from its acceptance line, so a stranger
 * reads them before there is a session - and both also render inside the
 * shell for a signed-in person following the same links, which is why this
 * is a plain scrollable block and not `AuthPage`'s narrow form frame.
 *
 * The version line is the API's `terms_version` from /api/auth-config: it is
 * the string signup stamps on the users row, and it must be the one shown
 * here, so the SPA fetches it rather than keeping a copy that can drift.
 */

/** A dated heading: the date says which revision of the text this is. */
export interface LegalDocument {
  title: string;
  /** Shown as "Last updated"; the ISO date the text below was last changed. */
  lastUpdated: string;
  intro: ReactNode;
  sections: readonly { heading: string; body: ReactNode }[];
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The way onward from the bottom of the page, by who is reading: a
 * stranger is offered an account; a signed-in person inside the shell goes
 * back to the app; one held at a gate (terms to accept, email to verify)
 * goes back to the gate, which is at "/".
 */
function onwardLink(signedIn: boolean, inShell: boolean): { href: string; label: string } {
  if (inShell) return { href: "/apps/chat", label: "Back to MatterWave" };
  if (signedIn) return { href: "/", label: "Back to MatterWave" };
  return { href: SIGNUP_PATH, label: "Create account" };
}

export function LegalPage(props: { document: LegalDocument; showVersion?: boolean }) {
  const { title, lastUpdated, intro, sections } = props.document;
  const [version, setVersion] = useState<string | undefined>();
  const shell = useContext(ShellContext);
  const session = useContext(SessionContext);
  const onward = onwardLink(session !== null, shell !== null);

  useEffect(() => {
    if (!props.showVersion) return;
    let alive = true;
    ensureAuthConfig()
      .then((config) => {
        if (alive) setVersion(config.terms_version);
      })
      .catch(() => {
        // The text is readable without the version line; nothing to show.
      });
    return () => {
      alive = false;
    };
  }, [props.showVersion]);

  return (
    <FrontDoorFrame
      config={session?.config ?? getAuthConfig()}
      chrome={shell === null}
      actions={session === null}
    >
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:py-16">
        <header className="flex flex-col gap-3">
          <h1 className="font-display text-display-lg">{title}</h1>
          <p className="text-sm text-mw-text-muted">
            <span>Last updated {formatDate(lastUpdated)}</span>
            {version && (
              <>
                {" · "}
                <span data-testid="terms-version">Version {version}</span>
              </>
            )}
          </p>
        </header>

        <div className="flex flex-col gap-8 rounded-2xl border border-mw-border bg-mw-surface-raised p-5 sm:p-8">
          <div className="text-sm leading-relaxed text-mw-text-secondary [&_a]:text-mw-link">{intro}</div>

          {sections.map((section, index) => (
            <section key={section.heading} className="flex flex-col gap-2">
              <h2 className="font-display text-display-sm">
                <span className="mr-2 font-mono text-sm text-mw-link">{String(index + 1).padStart(2, "0")}</span>
                {section.heading}
              </h2>
              <div className="flex flex-col gap-2 text-sm leading-relaxed text-mw-text-secondary [&_a]:text-mw-link">
                {section.body}
              </div>
            </section>
          ))}
        </div>

        <nav aria-label="Legal pages" className="flex flex-wrap gap-x-5 gap-y-1">
          <a href={TERMS_PATH} className={TAP_LINK_CLASS}>
            Terms of Service
          </a>
          <a href={PRIVACY_PATH} className={TAP_LINK_CLASS}>
            Privacy Policy
          </a>
          <a href={POLICY_PATH} className={TAP_LINK_CLASS}>
            Acceptable Use Policy
          </a>
          <a href={onward.href} className={TAP_LINK_CLASS} data-testid="legal-onward">
            {onward.label}
          </a>
        </nav>
      </article>
    </FrontDoorFrame>
  );
}
