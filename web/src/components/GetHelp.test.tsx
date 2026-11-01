import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../types";

let config: Partial<AuthConfig> | null = null;
vi.mock("../lib/auth", () => ({ getAuthConfig: () => config }));

import { GetHelp } from "./GetHelp";
import { ErrorBoundary, ErrorFallback } from "./AppError";
import { ErrorState } from "../patterns";
import { TranscriptError } from "../apps/chat/ChatStates";
import {
  collectDiagnostics,
  formatDiagnostics,
  resetDiagnosticsForTests,
  setDiagnosticsIdentity,
  supportRequestHref,
} from "../lib/diagnostics";
import { apiFetch } from "../lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function openDialog(el: HTMLElement): Promise<HTMLElement> {
  const button = el.querySelector<HTMLButtonElement>("[data-get-help]")!;
  await act(async () => {
    button.click();
  });
  // Let the /healthz answer land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelector<HTMLElement>("[data-get-help-dialog]")!;
}

function stubHealthz(revision = "abc1234") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/healthz") {
        return new Response(JSON.stringify({ version: "0.1.0", revision, release: "dev" }), {
          status: 200,
        });
      }
      const res = new Response(
        JSON.stringify({ detail: "Nope", request_id: "req-api", trace_id: "t-api" }),
        { status: 503, headers: { "X-Request-Id": "req-api" } },
      );
      Object.defineProperty(res, "url", { value: `http://localhost${url}` });
      return res;
    }),
  );
}

beforeEach(() => {
  resetDiagnosticsForTests();
  config = null;
  window.history.replaceState(null, "", "/apps/chat?c=secret-search");
  setDiagnosticsIdentity({
    subject: "sub-1",
    email: "ada@example.com",
    orgId: "org-9",
    orgName: "Analytical",
  });
  stubHealthz();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("diagnostics", () => {
  it("carries account, org, release, ids and the route, and no query string", () => {
    const d = collectDiagnostics({ requestId: "req-1", traceId: "trace-1", release: "abc1234" });
    const text = formatDiagnostics(d);
    expect(text).toContain("Account: ada@example.com");
    expect(text).toContain("Organisation: Analytical (org-9)");
    expect(text).toContain("Release: abc1234");
    expect(text).toContain("Request id: req-1");
    expect(text).toContain("Trace id: trace-1");
    expect(text).toContain("Page: /apps/chat");
    expect(text).not.toContain("secret-search");
  });

  it("falls back to the last failed API call", async () => {
    await expect(apiFetch("/api/conversations?q=private")).rejects.toThrow();
    const d = collectDiagnostics({});
    expect(d.requestId).toBe("req-api");
    expect(d.traceId).toBe("t-api");
    expect(d.failedCall).toBe("503 /api/conversations");
  });

  it("pre-fills a mailto address and opens a web form as configured", () => {
    const d = collectDiagnostics({ requestId: "req-1" });
    const mail = supportRequestHref("mailto:help@example.com", d, "Help: req-1")!;
    expect(mail.prefilled).toBe(true);
    expect(mail.href.startsWith("mailto:help@example.com?")).toBe(true);
    const body = new URLSearchParams(mail.href.split("?")[1]).get("body")!;
    expect(body).toContain("Request id: req-1");
    expect(mail.href).not.toContain("+");
    expect(supportRequestHref("https://help.example.com/new", d, "x")).toEqual({
      href: "https://help.example.com/new",
      prefilled: false,
    });
    expect(supportRequestHref(null, d, "x")).toBeNull();
    expect(supportRequestHref("javascript:alert(1)", d, "x")).toBeNull();
  });
});

describe("GetHelp", () => {
  it("offers a pre-filled support request when an address is configured", async () => {
    config = { support_url: "mailto:help@example.com", status_url: "https://status.example.com" };
    const el = await render(<GetHelp requestId="req-77" />);
    const dialog = await openDialog(el);
    const details = dialog.querySelector<HTMLTextAreaElement>("[data-testid=support-diagnostics]")!;
    expect(details.value).toContain("Request id: req-77");
    expect(details.value).toContain("Release: abc1234");
    const contact = dialog.querySelector<HTMLAnchorElement>("[data-contact-support]")!;
    expect(contact.href).toContain("mailto:help@example.com");
    expect(decodeURIComponent(contact.href)).toContain("Request id: req-77");
    expect(dialog.querySelector("[data-support-missing]")).toBeNull();
    expect(dialog.textContent).toContain("Service status");
  });

  it("offers the details to copy, not a dead link, when no address is configured", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    const el = await render(<GetHelp requestId="req-1" />);
    const dialog = await openDialog(el);
    expect(dialog.querySelector("[data-contact-support]")).toBeNull();
    expect(dialog.querySelector("[data-support-missing]")).not.toBeNull();
    expect(dialog.textContent).toContain("Copy details");
  });
});

describe("every error state has a Get help", () => {
  function Boom(): React.ReactNode {
    throw new Error("boom");
  }

  it.each([
    ["ErrorFallback page", <ErrorFallback key="a" homeHref="/" />],
    ["ErrorFallback section", <ErrorFallback key="b" variant="section" />],
    ["ErrorState", <ErrorState key="c" title="Could not load" onRetry={() => undefined} />],
    ["TranscriptError", <TranscriptError key="d" kind="gateway" requestId="req-5" />],
    [
      "ErrorBoundary",
      <ErrorBoundary key="e" name="Pane">
        <Boom />
      </ErrorBoundary>,
    ],
  ])("%s", async (_name, node) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = await render(node);
    expect(el.querySelector("[data-get-help]")).not.toBeNull();
  });

  it("carries the transcript failure's own id", async () => {
    const el = await render(<TranscriptError kind="gateway" requestId="req-5" />);
    const dialog = await openDialog(el);
    expect(dialog.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain(
      "Request id: req-5",
    );
  });
});
