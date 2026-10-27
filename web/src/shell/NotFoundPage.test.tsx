import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAuthConfig } from "../lib/auth";
import { NotFoundPage } from "./NotFoundPage";
import { HelpPage } from "./HelpPage";
import { jsonResponse } from "./frontDoorHarness";

/**
 * The two pages that link the deployment's support and status URLs read
 * them from the auth config Boot fetched: with neither set they show
 * nothing, and with them set they show exactly those two links.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "m" };

let root: Root | null = null;
let container: HTMLElement | null = null;

async function loadConfig(config: Record<string, unknown>): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(config)));
  await fetchAuthConfig();
}

function render(node: React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function external(page: HTMLElement): string[] {
  return [...page.querySelectorAll("a[href^='http'], a[href^='mailto:']")].map(
    (a) => `${a.textContent?.trim()}|${a.getAttribute("href")}`,
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("the not-found page", () => {
  it("is the branded page with no help links when the deployment named none", async () => {
    await loadConfig(BASE);
    const page = render(<NotFoundPage />);
    expect(page.textContent).toContain("Page not found");
    expect(page.querySelector("a[href='/']")).not.toBeNull();
    expect(page.querySelector("nav[aria-label='Help']")).toBeNull();
  });

  it("links support and status when the deployment named them", async () => {
    await loadConfig({ ...BASE, support_url: "https://help.example.test", status_url: "https://status.example.test" });
    const page = render(<NotFoundPage />);
    expect(external(page)).toEqual([
      "Contact support|https://help.example.test",
      "Service status|https://status.example.test",
    ]);
  });

  it("links only what is set", async () => {
    await loadConfig({ ...BASE, status_url: "https://status.example.test" });
    const page = render(<NotFoundPage />);
    expect(external(page)).toEqual(["Service status|https://status.example.test"]);
  });
});

describe("the help page's support section", () => {
  it("is absent when the deployment named nothing", async () => {
    await loadConfig(BASE);
    const page = render(<HelpPage mac={false} />);
    expect(page.textContent).not.toContain("Support and status");
  });

  it("links support and status, opening elsewhere, when they are set", async () => {
    await loadConfig({ ...BASE, support_url: "mailto:help@example.test", status_url: "https://status.example.test" });
    const page = render(<HelpPage mac={false} />);
    expect(page.textContent).toContain("Support and status");
    expect(external(page)).toEqual([
      "Contact support|mailto:help@example.test",
      "Service status|https://status.example.test",
    ]);
    expect(page.textContent).toContain("never paste an API key");
  });
});
