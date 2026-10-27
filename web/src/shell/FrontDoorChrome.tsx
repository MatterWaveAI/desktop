import type { ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AuthConfig } from "../types";
import { startLogin } from "../lib/auth";
import { LOGIN_PATH, POLICY_PATH, PRIVACY_PATH, SIGNUP_PATH, TERMS_PATH } from "./frontDoor";
import { FRONT_DOOR_WIDTH, supportLinks } from "./frontDoorLinks";
import { Wordmark } from "../components/brand";

/**
 * The header and footer the signed-out pages share: the landing page,
 * /pricing, the developer pages, the sign-in and signup forms, the legal
 * pages and the not-found page before there is a session. Plain anchors,
 * like the shell's nav: each is a full route change, and an anchor is what a
 * middle-click and a copy-link expect. Sign in is the API's job -- a link to
 * our /login when the API offers password login, otherwise the button that
 * hands the browser to the API's login route.
 *
 * Every link is at least 44px tall on a coarse pointer and 24px otherwise.
 */

const PRIMARY =
  "inline-flex min-h-9 items-center rounded-lg bg-mw-accent px-4 text-sm font-semibold text-mw-accent-foreground hover:bg-mw-accent-hover pointer-coarse:min-h-11";
const QUIET =
  "inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-medium text-mw-text hover:bg-mw-surface-hover pointer-coarse:min-h-11";

export function FrontDoorHeader(props: {
  config: AuthConfig | null;
  /**
   * Leave out Sign in and Create account: the sign-in and signup forms are
   * themselves the way in, and a second "Sign in" beside the form's own
   * button is one too many.
   */
  actions?: boolean;
}) {
  return (
    <header className="border-b border-mw-border">
      <nav
        aria-label="MatterWave"
        className={`${FRONT_DOOR_WIDTH} flex min-h-17 flex-wrap items-center gap-x-6 gap-y-1 py-2`}
      >
        <a href="/" className="inline-flex min-h-6 items-center pointer-coarse:min-h-11">
          <Wordmark size="md" />
        </a>
        {props.actions !== false && (
          <div className="ml-auto flex items-center gap-2">
            <SignInAction config={props.config} className={QUIET} />
            <a href={SIGNUP_PATH} className={PRIMARY}>
              <Trans>Create account</Trans>
            </a>
          </div>
        )}
      </nav>
    </header>
  );
}

/**
 * Sign in, the way the API allows: our form, or the API's login route. With
 * no config in hand (a page that rendered before Boot's fetch, or outside
 * it) the link goes to /login, which starts the sign-in itself either way.
 */
export function SignInAction(props: { config: AuthConfig | null; className: string; children?: ReactNode }) {
  const label = props.children ?? <Trans>Sign in</Trans>;
  if (props.config === null || props.config.password_login) {
    return (
      <a href={LOGIN_PATH} className={props.className}>
        {label}
      </a>
    );
  }
  const config = props.config;
  return (
    <button type="button" className={props.className} onClick={() => startLogin(config)}>
      {label}
    </button>
  );
}

export function FrontDoorFooter(props: { config: AuthConfig | null }) {
  const { t } = useLingui();
  const links = [
    { label: t`Terms`, href: TERMS_PATH, external: false },
    { label: t`Privacy`, href: PRIVACY_PATH, external: false },
    { label: t`Acceptable use`, href: POLICY_PATH, external: false },
    ...supportLinks(props.config, true),
  ];
  return (
    <footer className="border-t border-mw-border">
      <nav
        aria-label={t`About MatterWave`}
        className={`${FRONT_DOOR_WIDTH} flex flex-wrap items-center gap-x-5 gap-y-1 py-6 text-sm text-mw-text-muted`}
      >
        <span className="mr-1">© MatterWave ai</span>
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="inline-flex min-h-6 items-center text-mw-text-secondary underline-offset-2 hover:text-mw-text hover:underline pointer-coarse:min-h-11"
            {...(link.external && !link.href.startsWith("mailto:")
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}

/**
 * A signed-out page in the front door's frame: the header, the page, the
 * footer, one scrolling column, the page in the <main> landmark. Inside the shell (`chrome={false}`) only the
 * page renders, since the shell already has a header.
 */
export function FrontDoorFrame(props: {
  config: AuthConfig | null;
  chrome?: boolean;
  actions?: boolean;
  /** False for a page that carries its own help links (the not-found page). */
  footer?: boolean;
  children: ReactNode;
}) {
  if (props.chrome === false) {
    return <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">{props.children}</div>;
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-mw-surface text-mw-text">
      <FrontDoorHeader config={props.config} actions={props.actions} />
      <main className="flex-1">{props.children}</main>
      {props.footer !== false && <FrontDoorFooter config={props.config} />}
    </div>
  );
}
