import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { Shell } from "../shell/Shell";
import { apps } from "./registry";
import { withAppBoundary } from "./withAppBoundary";

/**
 * The rule is "No unhandled render error produces a
 * white screen, proved by a test that throws inside a mounted app and asserts
 * the shell survives."
 *
 * The throw is a real render-time throw inside a component mounted through the
 * registry's wrapper, into the shell's <Outlet/> slot — not a simulated one.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let root: Root | null = null;
let container: HTMLElement | null = null;

function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return { ok: status < 400, status, json: async () => body, statusText: "OK" };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/conversations") return jsonResponse({ data: [] });
      if (url === "/readyz") return jsonResponse({ status: "ok" });
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    }),
  );
  // React logs the caught error; the test is about the boundary, not the noise.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
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

function BrokenApp(): never {
  throw new Error("this app is broken");
}

describe("withAppBoundary", () => {
  it("is applied to every app the registry mounts", () => {
    for (const app of apps) {
      const wrapped = withAppBoundary(app);
      expect(wrapped, app.id).not.toBe(app.component);
      expect((wrapped as { displayName?: string }).displayName).toBe(
        `WithAppBoundary(${app.id})`,
      );
    }
  });

  it("contains a throwing app: the shell chrome survives, no white screen", async () => {
    const Mounted = withAppBoundary({
      id: "broken",
      title: "Broken app",
      path: "/apps/broken",
      component: BrokenApp,
    });

    const harnessRoot = createRootRoute({
      component: () => <Shell authConfig={authConfig} principal={principal} />,
    });
    const harnessIndex = createRoute({
      getParentRoute: () => harnessRoot,
      path: "/",
      component: Mounted,
    });
    const harnessRouter = createRouter({
      routeTree: harnessRoot.addChildren([harnessIndex]),
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<RouterProvider router={harnessRouter} />);
    });

    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")).not.toBeNull();
    });

    // The app's failure is reported where the app was.
    const alert = container!.querySelector("main [role='alert']")!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Broken app stopped working");

    // And the shell is still there: header, nav, and the way out.
    expect(container!.querySelector("header")).not.toBeNull();
    expect(container!.querySelector("nav[aria-label='Apps']")).not.toBeNull();
    expect(container!.textContent).toContain("MatterWave");
  });
});
