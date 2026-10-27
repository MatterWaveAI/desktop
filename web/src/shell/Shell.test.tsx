import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { apps } from "../apps/registry";
import { Shell } from "./Shell";
import { useShell } from "./shellContext";

/**
 * The shell's header and skip link, which depend on where the person is:
 * the chat page names the open conversation and offers "Skip to composer";
 * every other page carries the brand and starts its Tab order at the nav.
 * Same harness as registry.test.tsx: the shipped Shell at the root of a
 * small router, with fetch stubbed the way the shell's tests stub it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no scrollTo; the router calls it on every navigation.
window.scrollTo = () => undefined;

const authConfig: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "fake-mini" };
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

const CONVERSATION = {
  id: "c1",
  title: "Quarterly velocity planning",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

/** The chat page in miniature: opens `?c=` the way the real one does on mount. */
function ChatStandIn() {
  const shell = useShell();
  const { selectConversation } = shell;
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("c");
    if (id) selectConversation(id);
  }, [selectConversation]);
  return <textarea data-mw-composer="" aria-label="Message" />;
}

function stubShellApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body });
      if (url.startsWith("/api/conversations")) return ok({ data: [CONVERSATION] });
      if (url === "/readyz") return ok({ status: "ok" });
      return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), json: async () => ({ detail: `no mock for ${url}` }) };
    }),
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(path: string): Promise<HTMLElement> {
  stubShellApi();
  const rootRoute = createRootRoute({
    component: () => <Shell authConfig={authConfig} principal={principal} />,
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>home</p> });
  const chat = createRoute({ getParentRoute: () => rootRoute, path: apps[0].path, component: ChatStandIn });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, chat]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  // The stand-in reads `location.search` as the real page does.
  history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await router.load();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

function headerTitle(el: HTMLElement): string | null | undefined {
  return el.querySelector("[data-mw-header-title]")?.textContent;
}

function skipLink(el: HTMLElement): HTMLAnchorElement | undefined {
  return [...el.querySelectorAll("a")].find((a) => a.textContent === "Skip to composer");
}

describe("the shell header", () => {
  it("names the open conversation on the chat page", async () => {
    const el = await mount(`${apps[0].path}?c=c1`);
    expect(headerTitle(el)).toBe("Quarterly velocity planning");
  });

  it("says New chat on the chat page before there is a conversation", async () => {
    const el = await mount(apps[0].path);
    expect(headerTitle(el)).toBe("New chat");
  });

  it("carries the brand on every other page", async () => {
    const el = await mount("/");
    expect(headerTitle(el)).toBe("MatterWave ai");
  });
});

describe("Skip to composer", () => {
  it("is the first link on the chat page and goes to the message box", async () => {
    const el = await mount(apps[0].path);
    const link = skipLink(el)!;
    expect(link).toBeDefined();
    expect(el.querySelector("a")).toBe(link);
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(el.querySelector("[data-mw-composer]"));
  });

  it("is absent on a page with no composer, so Tab starts at the nav", async () => {
    const el = await mount("/");
    expect(skipLink(el)).toBeUndefined();
  });
});
