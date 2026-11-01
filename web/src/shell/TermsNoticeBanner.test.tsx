import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { ShellContext, type ShellContextValue } from "./shellContext";
import { TermsNoticeBanner } from "./TermsNoticeBanner";

/**
 * A minor terms revision is a notice, not the gate: it says what changed,
 * links the text, and dismissing it records the acceptance. A failed
 * dismissal stays up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config: AuthConfig = {
  auth_mode: "none",
  csrf_cookie: "mw_csrf",
  default_model: "m",
  terms_version: "2026-10",
};

function shell(principal: Partial<Principal>, updatePrincipal = vi.fn()): ShellContextValue {
  return {
    authConfig: config,
    principal: {
      subject: "ada",
      kind: "user",
      email: "ada@example.com",
      name: null,
      roles: [],
      org_id: "org",
      org_name: null,
      org_role: "owner",
      ...principal,
    },
    updatePrincipal,
  } as unknown as ShellContextValue;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(value: ShellContextValue): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ShellContext.Provider value={value}>
        <TermsNoticeBanner />
      </ShellContext.Provider>,
    );
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
});

function gotIt(el: HTMLElement): HTMLButtonElement {
  return [...el.querySelectorAll("button")].find((b) => b.textContent === "Got it")!;
}

describe("TermsNoticeBanner", () => {
  it("shows nothing for an account on the current version", async () => {
    const el = await render(shell({ terms_version: "2026-10", terms_notice: false }));
    expect(el.querySelector("[data-terms-notice]")).toBeNull();
  });

  it("says what changed and records the acceptance when dismissed", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ terms_version: "2026-10", terms_current: true }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const update = vi.fn();
    const el = await render(shell({ terms_version: "2026-09", terms_notice: true }, update));
    const notice = el.querySelector("[data-terms-notice]")!;
    expect(notice.textContent).toContain("The Terms of Service were updated.");
    expect(notice.textContent).toMatch(/overage cap/);
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/terms");

    await act(async () => {
      gotIt(el).click();
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/me/accept-terms");
    expect(JSON.parse(String(init.body))).toEqual({ version: "2026-10" });
    expect(update).toHaveBeenCalledWith({
      terms_version: "2026-10",
      terms_current: true,
      terms_notice: false,
    });
  });

  it("stays up and says so when the acknowledgement could not be recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Down" }), { status: 503 })),
    );
    const update = vi.fn();
    const el = await render(shell({ terms_version: "2026-09", terms_notice: true }, update));
    await act(async () => {
      gotIt(el).click();
    });
    expect(update).not.toHaveBeenCalled();
    expect(el.querySelector("[role=alert]")?.textContent).toBe("Down");
  });
});
