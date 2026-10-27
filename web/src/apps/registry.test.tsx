import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { router } from "../routes";
import { Shell } from "../shell/Shell";
import { ChatPage } from "./chat/ChatPage";
import { apps } from "./registry";

/**
 * The rule is "chat is registered through the app registry rather than
 * hard-wired into the shell." Everything asserted here derives its
 * expectations from the shipped `apps` array — if an app is added to or
 * removed from the registry, the route tree and the sidebar nav must follow,
 * and a route or link that exists without a registry entry fails the test.
 *
 * The nav test mounts the shipped `Shell` itself. It does not mount the full
 * app at `/apps/chat`: assistant-ui's `useLocalRuntime` throws inside jsdom
 * (`Cannot set properties of undefined (setting '_getInitializePromise')`,
 * observed in this tree), so the in-browser chat mount is the owner's window
 * test. What the jsdom test covers is the shell's half — the nav entries and
 * the `<Outlet/>` slot — plus the registry→route-tree wiring by structure.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Walk a TanStack route tree and collect every route's `fullPath`. */
function routePaths(node: unknown): string[] {
  const n = node as { fullPath?: unknown; children?: readonly unknown[] };
  const own = typeof n.fullPath === "string" ? [n.fullPath] : [];
  const kids = Array.isArray(n.children) ? (n.children as readonly unknown[]) : [];
  return [...own, ...kids.flatMap(routePaths)];
}

const authConfig: AuthConfig = {
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

// A harness router whose root renders the shipped Shell exactly as Boot does
// in the app (boot.tsx line 72); the index child stands in for a mounted app.
const harnessRoot = createRootRoute({
  component: () => <Shell authConfig={authConfig} principal={principal} />,
});
const harnessIndex = createRoute({
  getParentRoute: () => harnessRoot,
  path: "/",
  component: () => <p data-testid="app-slot" />,
});
const harnessRouter = createRouter({
  routeTree: harnessRoot.addChildren([harnessIndex]),
});

let root: Root | null = null;
let container: HTMLElement | null = null;

function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return { ok: status < 400, status, json: async () => body, statusText: "OK" };
}

function stubShellApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/conversations") return jsonResponse({ data: [] });
    if (url === "/readyz") return jsonResponse({ status: "ok" });
    return jsonResponse({ detail: `no mock for ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

describe("the shipped app registry", () => {
  it("registers chat as an app under /apps/chat with the ChatPage component", () => {
    const chat = apps.find((app) => app.id === "chat");
    expect(chat).toBeDefined();
    expect(chat!.path).toBe("/apps/chat");
    expect(chat!.component).toBe(ChatPage);
  });

  it("builds the route tree from the registry: one route per app, nothing extra", () => {
    const paths = routePaths(router.routeTree);
    // Shell-owned routes only; every other route must come from `apps`.
    // `/settings` and `/settings/$paneId` are host routes, not apps:
    // settings has no nav entry and is not installable, so it is registered
    // here rather than in `apps`. `/signup`, `/login`, `/verify`, `/forgot`
    // and `/reset` are the front door: they render without a
    // session, which no app may; `/terms` and `/privacy` join them
    // because the signup form links them before there is an account.
    const expected = new Set([
      "/",
      "/auth/callback",
      "/settings",
      "/settings/$paneId",
      "/signup",
      "/login",
      "/verify",
      "/forgot",
      "/reset",
      "/terms",
      "/privacy",
      // `/policy` is the acceptable-use policy: the 403 a suspended person
      // gets points at its appeal section, so it must open without a session.
      "/policy",
      // `/join` is the invite landing: anonymous like /signup, and
      // a one-click accept when already signed in.
      "/join",
      // `/pricing` is anonymous like /signup -- a paywall that hides
      // its prices behind a login gets screenshotted -- and `/billing/success`
      // is where Checkout returns to; neither is installable, so neither is
      // an app.
      "/pricing",
      "/billing/success",
      // `/help` is a host route like settings: no nav entry, not
      // installable, linked from the shortcuts overlay and the chat empty state.
      "/help",
      // `/share/$token` is the public page a share link opens: anonymous
      // like /pricing (the token is the credential), not installable, so
      // not an app.
      "/share/$token",
      // The developer portal moved to the public site (matterwave.dev) and
      // the app links there externally; the app carries no routes for it.
      // `/device` is where a terminal or editor's sign-in code is approved:
      // reachable signed out (it sends to login first), not installable, so
      // not an app.
      "/device",
      // `/unsubscribe` confirms a one-click unsubscribe from a mail: the
      // signed token is the credential, so it is anonymous; not an app.
      "/unsubscribe",
      ...apps.map((app) => app.path),
    ]);
    expect(new Set(paths)).toEqual(expected);
    for (const app of apps) {
      expect(paths).toContain(app.path);
    }
  });
});

describe("the shell navigation", () => {
  it("renders a nav entry for every unflagged, ungated registered app, and the route slot apps mount into", async () => {
    stubShellApi();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<RouterProvider router={harnessRouter} />);
    });

    // The sidebar nav lists exactly the unflagged registry apps.
    await vi.waitFor(() => {
      expect(container!.querySelector("nav[aria-label='Apps']")).not.toBeNull();
    });
    const nav = container!.querySelector("nav[aria-label='Apps']")!;
    const links = [...nav.querySelectorAll("a")];
    // The harness principal holds no roles, so a role-gated app (admin)
    // is absent exactly as a flagged one is.
    const visibleApps = apps.filter((app) => !app.flag && !app.role);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(visibleApps.map((a) => a.path));

    const chatLink = links.find((a) => a.getAttribute("href") === "/apps/chat");
    expect(chatLink?.textContent?.trim()).toBe(
      visibleApps.find((a) => a.path === "/apps/chat")?.title,
    );

    // The shell chrome hosts apps in its <Outlet/> slot; a mounted app
    // renders inside <main>, not in place of the chrome.
    expect(container!.querySelector("main [data-testid='app-slot']")).not.toBeNull();
    expect(container!.querySelector("header")).not.toBeNull();
  });
});
