import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useContext, useEffect } from "react";
import { Boot } from "./boot";
import { apps } from "./apps/registry";
import { withAppBoundary } from "./apps/withAppBoundary";
import { DEFAULT_PANE_ID, findPane } from "./apps/settings/panes";
import { ShellContext } from "./shell/shellContext";
import { CallbackPage } from "./shell/CallbackPage";
import { ForgotPage } from "./shell/ForgotPage";
import { JoinPage } from "./shell/JoinPage";
import { DevicePage } from "./shell/DevicePage";
import { LoginPage } from "./shell/LoginPage";
import { PrivacyPage } from "./shell/PrivacyPage";
import { PolicyPage } from "./shell/PolicyPage";
import { ResetPage } from "./shell/ResetPage";
import { SignupPage } from "./shell/SignupPage";
import { TermsPage } from "./shell/TermsPage";
import { VerifyPage } from "./shell/VerifyPage";
import { UnsubscribePage } from "./shell/UnsubscribePage";
import { HelpPage } from "./shell/HelpPage";
import { HELP_PATH } from "./shell/help";
import { SharePage } from "./apps/share/SharePage";
import { RouteError, RoutePending } from "./components/AppError";
import { NotFoundPage } from "./shell/NotFoundPage";
import { landingAfterSignIn } from "./shell/deepLink";
import {
  BILLING_SUCCESS_PATH,
  DEVICE_PATH,
  FORGOT_PATH,
  JOIN_PATH,
  PRICING_PATH,
  LOGIN_PATH,
  PRIVACY_PATH,
  POLICY_PATH,
  RESET_PATH,
  SIGNUP_PATH,
  TERMS_PATH,
  UNSUBSCRIBE_PATH,
  VERIFY_PATH,
} from "./shell/frontDoor";

/*
 * Code-split routes. Everything a signed-in user does not need on the first
 * paint -- billing and settings load as their own
 * chunk the first time their route matches. The router calls each one's
 * `preload` before rendering, so a navigation waits on the chunk rather
 * than flashing the pending skeleton; a chunk that 404s after a deploy
 * reloads the page once (lazyRouteComponent's own behaviour) and otherwise
 * lands in RouteError.
 */
const PricingPage = lazyRouteComponent(() => import("./apps/billing/PricingPage"), "PricingPage");
const BillingSuccessPage = lazyRouteComponent(
  () => import("./apps/billing/BillingSuccessPage"),
  "BillingSuccessPage",
);
const SettingsRoute = lazyRouteComponent(
  () => import("./apps/settings/SettingsRoute"),
  "SettingsRoute",
);

// The root route is the boot gate: auth-config loads before any app mounts.
const rootRoute = createRootRoute({
  component: Boot,
  // Per-route <title>; the leaf's meta wins when set.
  head: () => ({ meta: [{ title: "MatterWave" }] }),
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: CallbackPage,
  head: () => ({ meta: [{ title: "Signing in · MatterWave" }] }),
});

/**
 * The front door: signup, and with slice 2 our own login, the
 * verification code, and forgot/reset. Host routes like settings, not apps:
 * no nav entry, no app boundary, and — the part that matters — nothing here
 * demands a principal. Boot's anonymous gate lets these paths through its
 * outlet where every other path gets the landing page; `frontDoor.ts` is
 * where the two agree on the paths. The pages read `?authRequest=` and
 * `?email=` from the location themselves, so no search schema is declared.
 */
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SIGNUP_PATH,
  component: SignupPage,
  head: () => ({ meta: [{ title: "Create account · MatterWave" }] }),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LOGIN_PATH,
  component: LoginPage,
  head: () => ({ meta: [{ title: "Sign in · MatterWave" }] }),
});

const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: VERIFY_PATH,
  component: VerifyPage,
  head: () => ({ meta: [{ title: "Verify your email · MatterWave" }] }),
});

const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: FORGOT_PATH,
  component: ForgotPage,
  head: () => ({ meta: [{ title: "Reset your password · MatterWave" }] }),
});

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: RESET_PATH,
  component: ResetPage,
  head: () => ({ meta: [{ title: "Choose a new password · MatterWave" }] }),
});

// The legal pages: anonymous like the rest of the front door, since
// the signup form links them before there is an account to accept with.
const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: TERMS_PATH,
  component: TermsPage,
  head: () => ({ meta: [{ title: "Terms of Service · MatterWave" }] }),
});

const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PRIVACY_PATH,
  component: PrivacyPage,
  head: () => ({ meta: [{ title: "Privacy Policy · MatterWave" }] }),
});

// The acceptable-use policy and the enforcement ladder: on the front door so
// a suspended person can read how to appeal while every other request is refused.
const policyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: POLICY_PATH,
  component: PolicyPage,
  head: () => ({ meta: [{ title: "Acceptable Use Policy · MatterWave" }] }),
});

// The invite landing: front door like /signup, and a one-click
// accept inside the shell when already signed in.
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: JOIN_PATH,
  component: JoinPage,
  head: () => ({ meta: [{ title: "Join an organisation · MatterWave" }] }),
});

// Device login: front door like /join so the printed link opens signed
// out (the page sends the visitor to sign in); approve and deny inside.
const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: DEVICE_PATH,
  component: DevicePage,
  head: () => ({ meta: [{ title: "Sign in a device · MatterWave" }] }),
});

// One-click unsubscribe: front door like /join, since the token in the
// footer link is the credential. The page asks, then POSTs; opening it
// changes nothing.
const unsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: UNSUBSCRIBE_PATH,
  component: UnsubscribePage,
  head: () => ({ meta: [{ title: "Unsubscribe · MatterWave" }] }),
});

// The plan ladder: front door like /signup, since a stranger must be
// able to see the prices, and the same page inside the shell once signed in.
const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PRICING_PATH,
  component: PricingPage,
  head: () => ({ meta: [{ title: "Plans · MatterWave" }] }),
});

// Where Checkout returns to. Needs the session, so not in frontDoor's
// anonymous set; it polls /api/billing/status until the webhook lands.
const billingSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: BILLING_SUCCESS_PATH,
  component: BillingSuccessPage,
  head: () => ({ meta: [{ title: "Payment received · MatterWave" }] }),
});

/**
 * `/` renders through the outlet rather than redirecting.
 *
 * It used to `throw redirect({ to: apps[0].path })` unconditionally in
 * `beforeLoad`, which runs before Boot has a principal and so could not know
 * whether there was a session. A signed-out visitor arriving at the product's
 * own front page was rewritten to `/apps/chat` and shown the landing page
 * there: the right screen at the wrong URL, so a refresh, a bookmark or a
 * shared link all pointed into the app instead of the front door, and the
 * back button could not reach `/` again.
 *
 * So the redirect moved into a component, which renders only once Boot has
 * decided. `ShellContext` is null without a session — that is what the
 * anonymous gate means — so a signed-out visitor keeps `/` and the gate shows
 * them the landing page, while a signed-in one is sent to the first app
 * exactly as before.
 */
function IndexRedirect(): null {
  // Null in TWO different situations, and they are not the same:
  //
  //   - there is no session, so boot.tsx renders the front door outside
  //     the Shell and this component should do nothing; and
  //   - boot.tsx is still fetching /api/me, so the Shell has not mounted
  //     YET even though a session exists.
  //
  // `/api/auth/callback` sends the browser here the instant it sets the
  // session cookie, which lands squarely in the second case. Treating it
  // as the first one left a freshly signed-in user sitting on the landing
  // page at `/` -- signed in, looking signed out, with the sign-in they
  // just completed apparently having done nothing.
  //
  // Waiting is the whole fix: once Boot resolves, either the Shell mounts
  // (and this navigates) or the front door renders (and this stays put).
  //
  // Where it navigates: the deep link the front door remembered when a
  // signed-out visitor arrived at a page that needs a session
  // (`deepLink.ts`), since the API's callback lands here whatever page the
  // sign-in was for; otherwise the first app, as before.
  const shell = useContext(ShellContext);
  const navigate = useNavigate();
  useEffect(() => {
    if (shell === null) return;
    void navigate({ ...landingAfterSignIn(apps[0].path), replace: true });
  }, [shell, navigate]);
  return null;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRedirect,
});

/**
 * Settings. A host route, not an app: it is not in `apps` because
 * it contributes no nav entry and is not installable — the user menu links
 * it. Bare `/settings` redirects to the first pane so there is one canonical
 * URL per pane and a deep link is always shareable.
 */
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$paneId", params: { paneId: DEFAULT_PANE_ID }, replace: true });
  },
});

const settingsPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$paneId",
  component: SettingsRoute,
  // An unknown pane id falls back to the first pane rather than 404ing:
  // settings is navigation, and a stale link to a renamed pane
  // should land somewhere usable.
  head: ({ params }) => ({
    meta: [{ title: `${findPane(params.paneId).title} · Settings · MatterWave` }],
  }),
});

/**
 * Help. A host route like settings: no nav entry, nothing installable, and
 * it needs the session because it describes controls -- report, export, the
 * usage pane -- that only exist inside the shell. The shortcuts overlay and
 * the chat empty state link it.
 */
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: HELP_PATH,
  component: HelpPage,
  head: () => ({ meta: [{ title: "Help · MatterWave" }] }),
});

/**
 * A shared conversation. Front door like /pricing: a stranger holding the
 * link reads it with no session, and `frontDoor.ts` matches the prefix so
 * the anonymous gate renders it through the outlet. The page itself has no
 * shell chrome of its own; a signed-in reader sees it inside theirs.
 */
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$token",
  component: SharePage,
  head: () => ({ meta: [{ title: "Shared conversation · MatterWave" }] }),
});

/**
 * The developer portal: front door like /pricing, since a developer
 * deciding whether to build on the API reads the reference before there is
 * an account, and the same pages inside the shell once signed in. Three
 * routes rather than one with a section parameter so each page has one
 * canonical, linkable URL and its own title.
 */
/**
 * Wrap an app in its boundary, keeping a lazy app's `preload` visible to the
 * router. The wrapper is a new function, so without the copy the router
 * would not know there is a chunk to fetch and the app would suspend on
 * first render instead (still correct -- RoutePending covers it -- but a
 * skeleton flash on every first visit).
 */
function mountApp(app: (typeof apps)[number]) {
  const bounded = withAppBoundary(app);
  const lazy = app.component as { preload?: () => Promise<void> };
  if (!lazy.preload) return bounded;
  // Read at call time: lazyRouteComponent drops its preload once loaded.
  return Object.assign(bounded, { preload: () => lazy.preload?.() ?? Promise.resolve() });
}

// Every registered app mounts into the shell's route slot the same way,
// and titles itself from the registry.
const appRoutes = apps.map((app) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: app.path,
    // Each app mounts inside its own boundary: one app
    // throwing loses that app, never the shell around it.
    component: mountApp(app),
    head: () => ({ meta: [{ title: `${app.title} · MatterWave` }] }),
  }),
);

export const router = createRouter({
  // A route that throws (or whose chunk will not load) renders the branded
  // error page with Retry and Go home, not the router's bare stack trace.
  defaultErrorComponent: RouteError,
  // Shown while a lazy route's chunk is still on the wire; it also makes the
  // router wrap each route in Suspense.
  defaultPendingComponent: RoutePending,
  // An address no route matches gets the same branded page, not the
  // router's bare "Not Found" -- with the deployment's support and status
  // links under it when it has any.
  defaultNotFoundComponent: NotFoundPage,
  routeTree: rootRoute.addChildren([
    callbackRoute,
    signupRoute,
    loginRoute,
    verifyRoute,
    forgotRoute,
    resetRoute,
    termsRoute,
    privacyRoute,
    policyRoute,
    joinRoute,
    deviceRoute,
    unsubscribeRoute,
    pricingRoute,
    billingSuccessRoute,
    indexRoute,
    settingsIndexRoute,
    settingsPaneRoute,
    helpRoute,
    shareRoute,
    ...appRoutes,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
