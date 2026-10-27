import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouteComponent,
} from "@tanstack/react-router";
import { expect, vi } from "vitest";
import type { AuthConfig } from "../types";

/**
 * The harness the front-door page tests share. Same shape as
 * boot.test.tsx - react-dom directly, fetch stubbed by URL, a memory-history
 * router - because the pages read `?authRequest=` and `?email=` from the
 * router's location and signup navigates through it. Not a test file itself:
 * vitest's include is `*.test.tsx`, and nothing in the app imports it.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The router restores scroll on every navigation; jsdom logs "not implemented"
// for each one, which is noise, not a failure.
window.scrollTo = () => undefined;

export const authConfig: AuthConfig = {
  auth_mode: "oidc",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
  login_url: "/api/auth/login",
  password_login: true,
  passkey_login: true,
  terms_version: "2026-09",
};

let root: Root | null = null;
let container: HTMLElement | null = null;
let router: ReturnType<typeof createRouter> | null = null;

export function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return { ok: status < 400, status, json: async () => body, statusText: "" };
}

/** What the stub answers for one URL: a response, a rejection (network error), or a promise to settle later. */
export type Answer = Record<string, unknown> | Error | Promise<Record<string, unknown>>;

/** Stub fetch by URL; `/api/auth-config` always answers the config. */
export function stubApi(answers: Record<string, Answer>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/auth-config") return jsonResponse(authConfig);
    const answer = answers[url];
    if (answer === undefined) return jsonResponse({ detail: `no mock for ${url}` }, 404);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Mount `routes` under a bare outlet, with the memory history at `path`, and
 * wait for the page to be there: the router matches asynchronously, so the
 * outlet is empty on the first paint. Every front-door page has one h1.
 */
export async function mount(path: string, routes: Record<string, RouteComponent>): Promise<void> {
  const harnessRoot = createRootRoute({ component: Outlet });
  const children = Object.entries(routes).map(([routePath, component]) =>
    createRoute({ getParentRoute: () => harnessRoot, path: routePath, component }),
  );
  router = createRouter({
    routeTree: harnessRoot.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<RouterProvider router={router!} />);
  });
  await vi.waitFor(() => {
    expect(container!.querySelector("h1")).not.toBeNull();
  });
}

/** Where the harness router is now: the pathname and the parsed search. */
export function currentLocation(): { pathname: string; search: Record<string, unknown> } {
  const location = router!.state.location;
  return { pathname: location.pathname, search: location.search as Record<string, unknown> };
}

export function cleanup(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  router = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

/** The mounted page's DOM. */
export function view(): HTMLElement {
  expect(container, "a mounted page").not.toBeNull();
  return container!;
}

/** Set uncontrolled inputs by name: the forms read them at submit, so the value is enough. */
export function fill(values: Record<string, string | boolean>): void {
  for (const [name, value] of Object.entries(values)) {
    const input = view().querySelector<HTMLInputElement>(`input[name='${name}']`);
    expect(input, `an input named ${name}`).not.toBeNull();
    if (typeof value === "boolean") input!.checked = value;
    else input!.value = value;
  }
}

export async function submit(): Promise<void> {
  await act(async () => {
    view()
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...view().querySelectorAll("button")].find((b) => b.textContent === label);
}

export function linkTo(href: string): HTMLAnchorElement | null {
  return view().querySelector<HTMLAnchorElement>(`a[href='${href}']`);
}

export function alertText(): string {
  const alert = view().querySelector("[role='alert']");
  expect(alert, "an alert").not.toBeNull();
  return alert!.textContent ?? "";
}

/** The one call the stub saw for `url`, with its parsed init. */
export function callTo(
  fetchMock: ReturnType<typeof vi.fn>,
  url: string,
): { method?: string; body: unknown; headers: Record<string, string> } {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  expect(call, `a call to ${url}`).toBeDefined();
  const init = call![1] as RequestInit;
  return {
    method: init.method,
    body: JSON.parse(String(init.body)),
    headers: init.headers as Record<string, string>,
  };
}
