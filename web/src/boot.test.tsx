import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "./types";
import { Boot } from "./boot";
import { signOut, startLogin } from "./lib/auth";
import { router } from "./routes";
import { HELP_PATH } from "./shell/help";
import { LOGIN_PATH, SIGNUP_PATH } from "./shell/frontDoor";
import { PRODUCT_LINE } from "./shell/productCopy";
import { peekDeepLink } from "./shell/deepLink";
import { SignupPage } from "./shell/SignupPage";

/**
 * The front door. A 401 in OIDC mode used to hand the browser to the
 * IdP before anything rendered; now it renders a landing page with a way to
 * sign in and a way to create an account, and lets `/signup` through without
 * a session. Same harness as withAppBoundary.test.tsx - react-dom directly,
 * a memory-history router with Boot at its root.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Sign-in and sign-out are navigations; jsdom cannot perform one, and the
// assertion is only that Boot asked for it.
vi.mock("./lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/auth")>();
  return { ...actual, startLogin: vi.fn(), signOut: vi.fn(async () => {}) };
});

const oidcConfig: AuthConfig = {
  auth_mode: "oidc",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
  login_url: "/api/auth/login",
};

const noneConfig: AuthConfig = {
  auth_mode: "none",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
};

const principal: Principal = {
  subject: "dev@localhost",
  kind: "dev",
  email: "dev@localhost",
  name: null,
  roles: [],
  org_id: "dev-org",
  org_name: null,
  org_role: null,
};

let root: Root | null = null;
let container: HTMLElement | null = null;
// How many times the stand-in for a page behind the gate rendered: a
// deep link must never reach it, not even for the frame between the
// redirect to /login starting and the login route taking over.
let gatedRenders = 0;

function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return { ok: status < 400, status, json: async () => body, statusText: "" };
}

/** Stub fetch by URL; `me` is what /api/me answers, `extra` overrides any other path. */
function stubApi(
  config: AuthConfig,
  me: Record<string, unknown>,
  extra: Record<string, Record<string, unknown>> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    // The conversation list carries a query string
    // (`?filter=default`), so it is matched by path: these tests are about
    // the auth chain, not about which slice the sidebar asked for.
    const path = url.split("?")[0];
    if (url in extra) return extra[url];
    if (path in extra) return extra[path];
    if (url === "/api/auth-config") return jsonResponse(config);
    if (url === "/api/me") return me;
    if (path === "/api/conversations") return jsonResponse({ data: [] });
    if (url === "/readyz") return jsonResponse({ status: "ok" });
    return jsonResponse({ detail: `no mock for ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Mount Boot at `path` with an app stub at "/", the signup page at its
 * route, and two stand-ins: /help for a page that needs a session, /login
 * for where a signed-out deep link is sent.
 */
function mountAt(path: string): void {
  const harnessRoot = createRootRoute({ component: Boot });
  const harnessIndex = createRoute({
    getParentRoute: () => harnessRoot,
    path: "/",
    component: () => <p data-testid="app-slot">the app</p>,
  });
  const harnessSignup = createRoute({
    getParentRoute: () => harnessRoot,
    path: SIGNUP_PATH,
    component: SignupPage,
  });
  const harnessHelp = createRoute({
    getParentRoute: () => harnessRoot,
    path: HELP_PATH,
    component: () => {
      gatedRenders += 1;
      return <p data-testid="help-slot">the help page</p>;
    },
  });
  const harnessLogin = createRoute({
    getParentRoute: () => harnessRoot,
    path: LOGIN_PATH,
    component: () => <p data-testid="login-slot">the login page</p>,
  });
  const harnessRouter = createRouter({
    routeTree: harnessRoot.addChildren([harnessIndex, harnessSignup, harnessHelp, harnessLogin]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<RouterProvider router={harnessRouter} />);
  });
}

function buttonNamed(label: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button, `a "${label}" button`).toBeDefined();
  return button!;
}

beforeEach(() => {
  vi.mocked(startLogin).mockClear();
  vi.mocked(signOut).mockClear();
  sessionStorage.clear();
  gatedRenders = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Walk a TanStack route tree and collect every route's `fullPath`. */
function routePaths(node: unknown): string[] {
  const n = node as { fullPath?: unknown; children?: readonly unknown[] };
  const own = typeof n.fullPath === "string" ? [n.fullPath] : [];
  const kids = Array.isArray(n.children) ? (n.children as readonly unknown[]) : [];
  return [...own, ...kids.flatMap(routePaths)];
}

describe("the shipped router", () => {
  it("registers /signup as a plain route, outside the app registry", () => {
    expect(routePaths(router.routeTree)).toContain(SIGNUP_PATH);
  });
});

describe("Boot without a session (OIDC mode)", () => {
  it("renders the landing page on a 401, with Sign in and Create account", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "no session" }, 401));
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain(PRODUCT_LINE.message);
    });
    expect(buttonNamed("Sign in")).toBeDefined();
    const create = container!.querySelector(`a[href='${SIGNUP_PATH}']`);
    expect(create?.textContent).toBe("Create account");
    // The app behind the gate never mounted, and nobody was bounced.
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("Sign in hands the browser to the API's login route via startLogin", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "no session" }, 401));
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain(PRODUCT_LINE.message);
    });

    act(() => {
      buttonNamed("Sign in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(startLogin).toHaveBeenCalledWith(oidcConfig);
  });

  it("makes Sign in a link to /login when the API offers password login (slice 2)", async () => {
    stubApi({ ...oidcConfig, password_login: true }, jsonResponse({ detail: "no session" }, 401));
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain(PRODUCT_LINE.message);
    });

    const signIn = container!.querySelector(`a[href='${LOGIN_PATH}']`);
    expect(signIn?.textContent).toBe("Sign in");
    expect([...container!.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Sign in",
    );
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("lets /signup through the gate without a principal", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "no session" }, 401));
    mountAt(SIGNUP_PATH);

    await vi.waitFor(() => {
      expect(container!.querySelector("form")).not.toBeNull();
    });
    expect(container!.textContent).toContain("Create your account");
    expect(container!.textContent).not.toContain(PRODUCT_LINE.message);
  });

  it("shows the not-found page, not the landing page, for an address nothing serves", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "no session" }, 401));
    mountAt("/no/such/page");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Page not found");
    });
    expect(container!.textContent).not.toContain(PRODUCT_LINE.message);
    expect(container!.querySelector("a[href='/']")).not.toBeNull();
    expect(peekDeepLink()).toBeUndefined();
  });

  it("remembers a deep link into the app and sends the visitor to sign in", async () => {
    stubApi({ ...oidcConfig, password_login: true }, jsonResponse({ detail: "no session" }, 401));
    mountAt(`${HELP_PATH}?from=mail`);

    // Generous: the landing page's chunk is heavier than the harness's, and
    // this is the first test to render it in a cold run.
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-testid='login-slot']")).not.toBeNull();
    }, { timeout: 3000 });
    expect(peekDeepLink()).toBe(`${HELP_PATH}?from=mail`);
    // Nothing behind the gate rendered on the way.
    expect(container!.querySelector("[data-testid='help-slot']")).toBeNull();
  });

  it("never renders the page behind the gate on the way to sign in, not even for a frame", async () => {
    // The redirect to /login moves the location before the router has
    // swapped the rendered match: for that frame the location is a
    // front-door path while the outlet still holds the deep link's page.
    // Rendered then, a settings pane threw "useShell must be used inside
    // the app shell" and its boundary logged a crash.
    stubApi({ ...oidcConfig, password_login: true }, jsonResponse({ detail: "no session" }, 401));
    mountAt(HELP_PATH);

    await vi.waitFor(() => {
      expect(container!.querySelector("[data-testid='login-slot']")).not.toBeNull();
    }, { timeout: 3000 });
    expect(gatedRenders).toBe(0);
  });

  it("without password login, remembers the deep link and shows the landing page's Sign in", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "no session" }, 401));
    mountAt(HELP_PATH);

    await vi.waitFor(() => {
      expect(container!.textContent).toContain(PRODUCT_LINE.message);
    }, { timeout: 3000 });
    // The memory is written by an effect, which lands a tick after the paint.
    await vi.waitFor(() => {
      expect(peekDeepLink()).toBe(HELP_PATH);
    });
    expect(buttonNamed("Sign in")).toBeDefined();
  });

  it("keeps the error state for a failure that is not a 401", async () => {
    stubApi(oidcConfig, jsonResponse({ detail: "down" }, 503));
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Could not reach the MatterWave API.");
    });
    expect(container!.textContent).not.toContain(PRODUCT_LINE.message);
    expect(buttonNamed("Retry")).toBeDefined();
  });
});

const suspended403 = jsonResponse(
  { detail: "This account is suspended.", status: "suspended" },
  403,
);

describe("Boot with a suspended account", () => {
  it("shows the notice instead of the shell on a 403 suspended, with Sign out", async () => {
    stubApi(oidcConfig, suspended403);
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Your account is suspended");
    });
    expect(container!.querySelector("[role='alert']")).not.toBeNull();
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
    expect(container!.textContent).not.toContain(PRODUCT_LINE.message);
    expect(container!.textContent).not.toContain("Could not reach the MatterWave API.");

    act(() => {
      buttonNamed("Sign out").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith(oidcConfig);
  });

  it("leaves the shell for the notice when a later request answers 403 suspended", async () => {
    // /api/me passes, then the shell's first request finds the account suspended.
    stubApi(noneConfig, jsonResponse(principal), { "/api/conversations": suspended403 });
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Your account is suspended");
    });
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
  });
});

describe("Boot in auth_mode none", () => {
  it("mounts the shell with the dev principal and never shows the landing page", async () => {
    stubApi(noneConfig, jsonResponse(principal));
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.querySelector("[data-testid='app-slot']")).not.toBeNull();
    });
    expect(container!.textContent).not.toContain(PRODUCT_LINE.message);
    expect(startLogin).not.toHaveBeenCalled();
  });
});

/**
 * An account that holds a session but has not confirmed its
 * email used to land on the full chat UI: `/api/me` has always reported the
 * state and nothing read it, and the only place the API refuses an unverified
 * account is password login — so any session obtained another way (SSO, the
 * dev `none` mode, or one left behind by the signup/verify flow) walked
 * straight in and could send messages from an unproven address.
 *
 * The ticket is explicit that the answer is a screen, not a 403: this user did
 * everything right and is one inbox click away.
 */
describe("Boot with an unverified account", () => {
  const pendingPrincipal: Principal = {
    ...principal,
    email: "new@example.com",
    state: "pending_verification",
  };

  it("shows 'check your email' instead of the shell", async () => {
    stubApi(noneConfig, jsonResponse(pendingPrincipal));
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Check your email");
    });
    // The app behind the gate never mounted.
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
    // Not a refusal, and not "something went wrong" either.
    expect(container!.textContent).not.toContain("suspended");
    expect(container!.textContent).not.toContain("Could not reach the MatterWave API.");
    // The address is named, so the user knows which inbox to open.
    expect(container!.textContent).toContain("new@example.com");
  });

  it("shows the example prompts, disabled, as a preview of what verifying unlocks", async () => {
    stubApi(noneConfig, jsonResponse(pendingPrincipal));
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Check your email");
    });

    // Visible but inert: the screen is a preview, not only a gate, so the trip
    // to the inbox has a destination the user has already seen.
    const cards = [...container!.querySelectorAll("[aria-disabled='true']")];
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(container!.textContent).toContain("Once you are verified");
  });

  it("offers a way to finish: enter the code, or send a new one", async () => {
    stubApi(noneConfig, jsonResponse(pendingPrincipal), {
      "/api/signup/resend": jsonResponse({ status: "sent" }, 202),
    });
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Check your email");
    });

    // The primary action goes to /verify with the address prefilled.
    const verifyLink = container!.querySelector("a[href^='/verify']")!;
    expect(verifyLink).not.toBeNull();
    expect(verifyLink.getAttribute("href")).toContain(encodeURIComponent("new@example.com"));

    const resend = buttonNamed("Send a new code");
    await act(async () => {
      resend.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("A new code is on its way");
    });
  });

  it("still lets the front door render, so the notice's own action is not a dead end", async () => {
    // Blocking every path would make "Enter the code" lead nowhere, trapping
    // the user on the screen that tells them what to do.
    stubApi(noneConfig, jsonResponse(pendingPrincipal));
    mountAt(SIGNUP_PATH);

    await vi.waitFor(() => {
      expect(container!.querySelector("form")).not.toBeNull();
    });
    expect(container!.textContent).not.toContain("Check your email");
  });

  it("treats an API that sends no state as active, so an older API is not locked out", async () => {
    stubApi(noneConfig, jsonResponse(principal));
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-testid='app-slot']")).not.toBeNull();
    });
    expect(container!.textContent).not.toContain("Check your email");
  });
});

/**
 * The terms gate. A verified account whose accepted version is not the
 * one in force sees one page -- what changed, a link to the text, one
 * action -- and nothing behind the shell until it has agreed. The version
 * posted is the one /api/auth-config advertises, never a copy held here.
 */
describe("Boot with stale terms", () => {
  const termsConfig: AuthConfig = { ...noneConfig, terms_version: "2026-09" };
  const stalePrincipal: Principal = {
    ...principal,
    state: "active",
    terms_version: "2025-01",
    terms_current: false,
  };

  function checkbox(): HTMLInputElement {
    const box = container!.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(box, "the acceptance checkbox").not.toBeNull();
    return box!;
  }

  it("shows the re-accept page instead of the shell, naming both versions and linking the terms", async () => {
    stubApi(termsConfig, jsonResponse(stalePrincipal));
    mountAt("/");

    await vi.waitFor(() => {
      expect(container!.textContent).toContain("The terms have changed");
    });
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
    expect(container!.textContent).toContain("2025-01");
    expect(container!.textContent).toContain("2026-09");
    expect(container!.querySelector("a[href='/terms']")).not.toBeNull();
    // Nothing is accepted until the box is ticked.
    expect(buttonNamed("Accept and continue").disabled).toBe(true);
  });

  it("posts the advertised version on accept and then mounts the shell", async () => {
    const fetchMock = stubApi(termsConfig, jsonResponse(stalePrincipal), {
      "/api/me/accept-terms": jsonResponse({
        terms_version: "2026-09",
        terms_accepted_at: "2026-10-03T09:00:00Z",
        terms_current: true,
      }),
    });
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("The terms have changed");
    });

    await act(async () => {
      checkbox().click();
    });
    const accept = buttonNamed("Accept and continue");
    expect(accept.disabled).toBe(false);
    await act(async () => {
      accept.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      expect(container!.querySelector("[data-testid='app-slot']")).not.toBeNull();
    });
    const post = fetchMock.mock.calls.find((call) => call[0] === "/api/me/accept-terms");
    expect(post).toBeDefined();
    const init = post![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ version: "2026-09" });
  });

  it("keeps the page up and says why when the API refuses", async () => {
    stubApi(termsConfig, jsonResponse(stalePrincipal), {
      "/api/me/accept-terms": jsonResponse({ detail: "The current terms are version 2026-10." }, 422),
    });
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("The terms have changed");
    });

    await act(async () => {
      checkbox().click();
    });
    await act(async () => {
      buttonNamed("Accept and continue").form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toContain("2026-10");
    });
    expect(container!.querySelector("[data-testid='app-slot']")).toBeNull();
  });

  it("still lets the front door render, so the link to the terms is not a dead end", async () => {
    stubApi(termsConfig, jsonResponse(stalePrincipal));
    mountAt(SIGNUP_PATH);
    await vi.waitFor(() => {
      expect(container!.querySelector("form")).not.toBeNull();
    });
    expect(container!.textContent).not.toContain("The terms have changed");
  });

  it("verification comes first: an unverified account with stale terms sees the email notice", async () => {
    stubApi(termsConfig, jsonResponse({ ...stalePrincipal, state: "pending_verification" }));
    mountAt("/");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Check your email");
    });
    expect(container!.textContent).not.toContain("The terms have changed");
  });
});
