import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, RouteError, RouteNotFound, RoutePending } from "./AppError";

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => undefined;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

let shouldThrow = true;
function Flaky(): React.ReactNode {
  if (shouldThrow) throw new Error("pane exploded");
  return <p>recovered</p>;
}

describe("ErrorBoundary", () => {
  it("contains a crash to the section and retries it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    const el = await render(
      <div>
        <p>outside</p>
        <ErrorBoundary name="Webhooks">
          <Flaky />
        </ErrorBoundary>
      </div>,
    );
    expect(el.textContent).toContain("outside");
    const alert = el.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Webhooks stopped working");
    // App copy for the user; the exception itself only reaches the console.
    expect(alert.textContent).toContain("This section could not be shown. Retry.");
    expect(alert.textContent).not.toContain("pane exploded");
    expect(logged.mock.calls.some((call) => call.some((arg) => arg instanceof Error && arg.message === "pane exploded"))).toBe(true);
    // A section has no Go home: the page around it is still there.
    expect(alert.querySelector("a")).toBeNull();
    shouldThrow = false;
    await act(async () => alert.querySelector("button")!.click());
    expect(el.textContent).toContain("recovered");
  });

  it("shows the caller's copy in place of the default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    const el = await render(
      <ErrorBoundary name="Integrations" message="The Salesforce status could not be read. Retry.">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(el.querySelector("[role=alert]")!.textContent).toContain("The Salesforce status could not be read. Retry.");
    expect(el.textContent).not.toContain("pane exploded");
  });

  it("clears when a reset key changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    const at = (pane: string) => (
      <ErrorBoundary resetKeys={[pane]}>
        <Flaky />
      </ErrorBoundary>
    );
    const el = await render(at("a"));
    expect(el.querySelector("[role=alert]")).not.toBeNull();
    shouldThrow = false;
    await act(async () => root!.render(at("b")));
    expect(el.textContent).toContain("recovered");
  });

  it("uses a custom fallback when given one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    const el = await render(
      <ErrorBoundary fallback={({ error }) => <p>custom: {error.message}</p>}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(el.textContent).toBe("custom: pane exploded");
  });
});

describe("RouteError", () => {
  async function mountThrowing(message: string): Promise<HTMLElement> {
    const rootRoute = createRootRoute({ component: Outlet });
    const page = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => {
        throw new Error(message);
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultErrorComponent: RouteError,
    });
    const el = await render(<RouterProvider router={router} />);
    await act(async () => {
      await router.load();
    });
    return el;
  }

  it("replaces the router default with Retry and Go home", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = await mountThrowing("boom");
    const alert = el.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("MatterWave");
    expect(alert.textContent).toContain("This page could not load");
    expect(alert.textContent).not.toContain("boom");
    expect(alert.textContent).toContain("could not recover from");
    expect(alert.querySelector("button")!.textContent).toBe("Retry");
    expect(alert.querySelector("a")!.getAttribute("href")).toBe("/");
  });

  it("offers a reload when a chunk from an old deploy is gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = await mountThrowing("Failed to fetch dynamically imported module: /assets/x.js");
    const alert = el.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("MatterWave was updated");
    expect(alert.querySelector("button")!.textContent).toBe("Reload");
  });
});

describe("RouteNotFound", () => {
  it("answers an unknown address with the branded page and a way home", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rootRoute = createRootRoute({ component: Outlet });
    const page = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p>home</p>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/no/such/page"] }),
      defaultNotFoundComponent: RouteNotFound,
    });
    const el = await render(<RouterProvider router={router} />);
    await act(async () => {
      await router.load();
    });
    const alert = el.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("MatterWave");
    expect(alert.textContent).toContain("Page not found");
    expect(el.querySelector("a[href='/']")?.textContent).toContain("Go home");
  });

  it("names itself in the tab, and gives the title back on the way out", async () => {
    document.title = "MatterWave";
    const el = await render(<RouteNotFound />);
    expect(el.textContent).toContain("Page not found");
    expect(document.title).toBe("Page not found · MatterWave");
    await act(async () => root?.unmount());
    expect(document.title).toBe("MatterWave");
  });
});

describe("RoutePending", () => {
  it("announces loading", async () => {
    const el = await render(<RoutePending />);
    expect(el.querySelector("[role=status]")!.textContent).toContain("Loading");
  });
});
