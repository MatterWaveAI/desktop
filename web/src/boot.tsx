import { useEffect, useState, type ReactNode } from "react";
import { HeadContent, Outlet, useLocation, useMatches, useNavigate, useRouter, type AnyRouter } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import type { AuthConfig, Preferences, Principal } from "./types";
import { ApiError, apiFetch, isSuspended, setActingSubject, SUSPENDED_EVENT } from "./lib/api";
import { adoptServerLocale } from "./i18n/locale";
import { fetchAuthConfig, fetchMe } from "./lib/auth";
import { Shell } from "./shell/Shell";
import { LandingPage } from "./shell/LandingPage";
import { SuspendedNotice } from "./shell/SuspendedNotice";
import { PendingVerificationNotice } from "./shell/PendingVerificationNotice";
import { AcceptTermsNotice } from "./shell/AcceptTermsNotice";
import { Onboarding } from "./shell/Onboarding";
import { isAnonymousPath, LOGIN_PATH, onboardingWaits } from "./shell/frontDoor";
import { rememberDeepLink } from "./shell/deepLink";
import { NotFoundPage } from "./shell/NotFoundPage";
import { SessionContext, type SessionContextValue } from "./shell/sessionContext";

type BootState =
  | { phase: "loading" }
  | { phase: "error"; reason: "expired" | "unreachable" }
  // OIDC mode with no session: the front door, not a bounce to the IdP.
  | { phase: "anonymous"; config: AuthConfig }
  // The API answered 403 suspended, at boot or from inside the shell.
  | { phase: "suspended"; config: AuthConfig }
  // A session for an account that has not confirmed its email.
  | { phase: "pending"; config: AuthConfig; principal: Principal }
  // A verified account whose accepted terms are not the version in force.
  | { phase: "terms"; config: AuthConfig; principal: Principal }
  // A verified, agreed account that has not seen the first-run walkthrough.
  | { phase: "onboarding"; config: AuthConfig; principal: Principal }
  | { phase: "ready"; config: AuthConfig; principal: Principal };

/**
 * Which gate, if any, stands between a principal and the shell. Verification
 * first: a person who has not proved their address is not asked to agree to
 * anything yet; the terms before the walkthrough, because agreement is a
 * condition of use and the walkthrough is not. `terms_current` and
 * `onboarding_completed` absent read as done (types.ts).
 */
function phaseFor(config: AuthConfig, principal: Principal): BootState {
  if (principal.state === "pending_verification") return { phase: "pending", config, principal };
  if (principal.terms_current === false) return { phase: "terms", config, principal };
  if (principal.onboarding_completed === false) return { phase: "onboarding", config, principal };
  return { phase: "ready", config, principal };
}

/**
 * Boot sequence: fetch /api/auth-config first, then render. No build-time
 * config, so one image runs in every environment.
 */
export function Boot() {
  const [state, setState] = useState<BootState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // No synchronous setState here: the initial state is already "loading",
    // and a retry sets it when the attempt counter is bumped, so setting it
    // again on entry only costs an extra render pass.
    (async () => {
      try {
        const config = await fetchAuthConfig();
        let principal: Principal;
        try {
          principal = await fetchMe();
          // Every later call names this account, so a switch made in another
          // tab is refused rather than acted on (lib/api.ts).
          setActingSubject(principal.subject);
        } catch (err) {
          setActingSubject(null);
          // No session in OIDC mode is not an error: a stranger at the front
          // door gets the landing page. Boot used to send the browser
          // straight to the login route here, which left nowhere for "Create
          // account" to live. `none` mode never 401s - the API synthesises a
          // dev principal - so a 401 there still surfaces as the error below.
          if (config.auth_mode === "oidc" && err instanceof ApiError && err.status === 401) {
            if (alive) setState({ phase: "anonymous", config });
            return;
          }
          // A session for a suspended account: the notice, with a way to
          // sign out, rather than "could not reach the API".
          if (isSuspended(err)) {
            if (alive) setState({ phase: "suspended", config });
            return;
          }
          throw err;
        }
        if (alive) {
          // An account that holds a session but has not verified its email
          // gets the "check your email" screen, not the shell.
          //
          // Nothing checked this before: `/api/me` has always reported the
          // state, and the only place the API refuses an unverified account
          // is password login — so a session obtained any other way (SSO, the
          // dev `none` mode, or one left behind by the signup→verify flow)
          // landed on the full chat UI. The user could then send messages
          // from an address nobody has proved they control.
          //
          // `state` is optional: an API that predates the field sends none,
          // and absent reads as active, so an older API is not locked out.
          setState(phaseFor(config, principal));
        }
      } catch (err) {
        if (alive) {
          setState({
            phase: "error",
            reason: err instanceof ApiError && err.status === 401 ? "expired" : "unreachable",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => {
    // Suspended while the shell is open: whichever request noticed fired
    // the event (lib/api.ts). Only a mounted shell moves to the notice - the
    // login page gets the same 403 for a suspended address and shows it
    // inline, where there is no session to sign out of.
    const onSuspended = () =>
      setState((current) =>
        current.phase === "ready" ? { phase: "suspended", config: current.config } : current,
      );
    window.addEventListener(SUSPENDED_EVENT, onSuspended);
    return () => window.removeEventListener(SUSPENDED_EVENT, onSuspended);
  }, []);

  if (state.phase === "loading") {
    return (
      <>
        <HeadContent />
        <div className="flex h-full items-center justify-center bg-mw-surface text-mw-text-muted">
          <p aria-live="polite" className="animate-pulse text-sm">
            <Trans>Loading MatterWave…</Trans>
          </p>
        </div>
      </>
    );
  }
  if (state.phase === "error") {
    return (
      <>
        <HeadContent />
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-mw-surface text-mw-text">
          <p className="text-lg font-medium">
            {state.reason === "expired" ? (
              <Trans>Your session has expired.</Trans>
            ) : (
              <Trans>Could not reach the MatterWave API.</Trans>
            )}
          </p>
          <p className="text-sm text-mw-text-muted">
            <Trans>The API may be down, or this origin may not be allowed by CORS.</Trans>
          </p>
          <button
            type="button"
            className="rounded-md border border-mw-border px-3 py-1.5 text-sm hover:bg-mw-surface-hover"
            onClick={() => {
              // Show the loading state from the event, not from inside the
              // effect: the effect setting it synchronously on every run costs
              // an extra render pass on first mount, where it is already loading.
              setState({ phase: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            <Trans>Retry</Trans>
          </button>
        </div>
      </>
    );
  }
  if (state.phase === "anonymous") {
    return (
      <>
        <HeadContent />
        <FrontDoor config={state.config} />
      </>
    );
  }
  if (state.phase === "suspended") {
    return (
      <>
        <HeadContent />
        <SuspendedNotice config={state.config} />
      </>
    );
  }
  if (state.phase === "pending") {
    return (
      <Session config={state.config} principal={state.principal} gate="pending">
        <PendingVerification config={state.config} principal={state.principal} />
      </Session>
    );
  }
  if (state.phase === "terms") {
    return (
      <Session config={state.config} principal={state.principal} gate="terms">
        <TermsGate
          config={state.config}
          principal={state.principal}
          onAccepted={(principal) => setState(phaseFor(state.config, principal))}
        />
      </Session>
    );
  }
  if (state.phase === "onboarding") {
    // The walkthrough stands in for the shell, like the two gates above,
    // on every path but the one-task pages (`onboardingWaits`): nothing on
    // the front door is its way out, and the person leaves it by finishing
    // or skipping, both of which record the flag and both of which land
    // them where they were going.
    return (
      <Session config={state.config} principal={state.principal} gate="onboarding">
        <OnboardingGate
          config={state.config}
          principal={state.principal}
          onDone={(principal) => setState(phaseFor(state.config, principal))}
        />
      </Session>
    );
  }
  return (
    <Session config={state.config} principal={state.principal} gate={null}>
      <Shell authConfig={state.config} principal={state.principal} />
    </Session>
  );
}

/**
 * Every branch with a principal, gated or not, says so to the pages under
 * it. The front-door routes render through the outlet at every gate, and
 * /pricing or /terms must not tell a signed-in person to create an account
 * because the shell -- and so `ShellContext` -- is not mounted yet.
 */
function Session(props: SessionContextValue & { children: ReactNode }) {
  const { children, ...value } = props;
  // The account's language, once there is an account to ask: a preference
  // saved on another device is adopted here, and the catalogue switches
  // before most of the shell has painted. Best effort -- the device's own
  // setting stands if the request fails.
  const ready = value.gate === null;
  useEffect(() => {
    if (!ready) return;
    apiFetch<Preferences>("/api/me/preferences")
      .then((preferences) => adoptServerLocale(preferences.locale))
      .catch(() => undefined);
  }, [ready]);
  return (
    <SessionContext.Provider value={value}>
      <HeadContent />
      {children}
    </SessionContext.Provider>
  );
}

/**
 * The walkthrough, unless the person is here to approve a device or accept
 * an invite: then the shell, with the walkthrough still owed.
 */
function OnboardingGate(props: { config: AuthConfig; principal: Principal; onDone: (principal: Principal) => void }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (onboardingWaits(pathname)) return <Shell authConfig={props.config} principal={props.principal} />;
  return <Onboarding config={props.config} principal={props.principal} onDone={props.onDone} />;
}

/**
 * Whether the router has nothing for this path. The same test the router
 * itself applies before falling back to its not-found component: no route
 * matched, or only one through a splat it did not want.
 */
function isUnknownPath(router: AnyRouter, pathname: string): boolean {
  const [, rawParams, foundRoute] = router.getMatchedRoutes(pathname);
  if (foundRoute) return foundRoute.path !== "/" && rawParams["**"] !== undefined;
  return pathname.replace(/\/+$/, "") !== "";
}

/**
 * The anonymous gate. Without a session only the front-door routes
 * (signup, login, verify, forgot and reset, the legal pages, pricing --
 * `frontDoor.ts` lists them) render through the outlet. The shell is not
 * mounted at all, so nothing behind it ever renders without a principal.
 *
 * Every other path is one of two things. An address the app does not serve
 * gets the not-found page, as it would signed in: showing the landing page
 * for a mistyped link told the visitor nothing. A deep link into the app --
 * a settings pane, the help page, a conversation -- is remembered
 * (`deepLink.ts`) so the sign-in can land there, and the person is sent to
 * our login page where it says "Sign in to continue"; without password login
 * the landing page's Sign in starts the IdP round trip with the same memory.
 */
function FrontDoor(props: { config: AuthConfig }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  // The path the outlet would render right now. During a navigation the
  // location moves first and the matches follow once the new route has
  // loaded, so for a frame they disagree: a deep link redirected to /login
  // has the login location while the outlet still holds the settings pane.
  const matchedPathname = useMatches({
    select: (matches) => matches[matches.length - 1]?.pathname ?? pathname,
  });
  const router = useRouter();
  const navigate = useNavigate();
  const anonymous = isAnonymousPath(pathname);
  const unknown = !anonymous && isUnknownPath(router, pathname);
  // "/" is the front page itself, not a page behind the gate.
  const deepLink = !anonymous && !unknown && pathname.replace(/\/+$/, "") !== "";
  const passwordLogin = props.config.password_login === true;

  useEffect(() => {
    if (!deepLink) return;
    rememberDeepLink(`${pathname}${searchStr}`);
    if (passwordLogin) void navigate({ to: LOGIN_PATH, replace: true });
  }, [deepLink, pathname, searchStr, passwordLogin, navigate]);

  if (anonymous) {
    // Only when the outlet holds a front-door page too: until the redirect
    // lands, rendering it would mount the page behind the gate.
    return isAnonymousPath(matchedPathname) ? <Outlet /> : null;
  }
  if (unknown) return <NotFoundPage />;
  return <LandingPage config={props.config} />;
}

/**
 * The gate for a session whose email is not confirmed.
 *
 * The notice is not the whole answer, because the notice's own primary action
 * is "enter the code" — and the page that takes the code is a front-door
 * route rendered through the outlet. Blocking every path would make the
 * button a dead end and leave the user with no way out of the screen telling
 * them what to do.
 *
 * So the front-door routes still render: /verify to finish, and the rest so a
 * user who would rather start over, recover a password or read the terms is
 * not trapped. Everything else — the shell, every app, settings — is the
 * notice, which is the half that has to hold.
 */
function PendingVerification(props: { config: AuthConfig; principal: Principal }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return isAnonymousPath(pathname) ? (
    <Outlet />
  ) : (
    <PendingVerificationNotice config={props.config} principal={props.principal} />
  );
}

/**
 * The gate for an account whose accepted terms are out of date. The same
 * shape as the verification gate, for the same reason: the notice links to
 * /terms, which is a front-door route, so blocking every path would make
 * "read the terms" a dead end. Everything behind the shell waits until the
 * person has agreed to the version in force.
 */
function TermsGate(props: {
  config: AuthConfig;
  principal: Principal;
  onAccepted: (principal: Principal) => void;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return isAnonymousPath(pathname) ? (
    <Outlet />
  ) : (
    <AcceptTermsNotice
      config={props.config}
      principal={props.principal}
      onAccepted={props.onAccepted}
    />
  );
}
