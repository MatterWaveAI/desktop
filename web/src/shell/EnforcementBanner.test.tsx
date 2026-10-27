import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnforcementBanner } from "./EnforcementBanner";
import { describeWindow, enforcementHeadline, type MyEnforcement } from "./policy";

/**
 * The banner for a person's own standing: nothing for `none`, a notice for
 * a warning, a highlighted line for a rate limit with its number and end,
 * always with the way to the policy's appeal section, and silence when the
 * read fails. The reason shown is the operator's text for the person.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

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

function stub(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<EnforcementBanner />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("EnforcementBanner", () => {
  it("renders nothing for an account in good standing", async () => {
    stub({ state: "none" });
    await mount();
    expect(container!.querySelector("[data-enforcement-state]")).toBeNull();
  });

  it("shows a warning with the reason written for the person and the appeal link", async () => {
    stub({
      state: "warned",
      reason: "Please keep the credential-testing prompts to systems you own.",
      since: "2026-10-20T10:00:00Z",
      expires_at: null,
      scope: "user",
      appeal_path: "/policy#appeal",
    } satisfies MyEnforcement);
    await mount();
    const banner = container!.querySelector("[data-enforcement-state='warned']")!;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("Your account has received a warning");
    expect(banner.textContent).toContain("credential-testing prompts");
    expect(banner.textContent).not.toContain("Ends");
    expect(banner.querySelector("a")?.getAttribute("href")).toBe("/policy#appeal");
    // Nothing to dismiss: a warning exists to be seen.
    expect(banner.querySelector("button")).toBeNull();
  });

  it("names the limit and when it ends for a rate-limited organisation", async () => {
    stub({
      state: "rate_limited",
      reason: "Automated traffic from several accounts.",
      since: "2026-10-20T10:00:00Z",
      expires_at: "2026-10-21T10:00:00Z",
      scope: "org",
      appeal_path: "/policy#appeal",
      limit: { messages: 20, window_s: 3600 },
    } satisfies MyEnforcement);
    await mount();
    const banner = container!.querySelector("[data-enforcement-state='rate_limited']")!;
    expect(banner.textContent).toContain("Your organisation is rate limited to 20 messages per hour");
    expect(banner.textContent).toContain("Ends");
  });

  it("draws nothing from a body it does not understand", async () => {
    // A proxy or a stub answering some other JSON must not become a banner.
    stub({ data: [{ email: "new@example.com" }] });
    await mount();
    expect(container!.querySelector("[data-enforcement-state]")).toBeNull();
  });

  it("shows nothing when the read fails", async () => {
    stub({ detail: "down" }, 503);
    await mount();
    expect(container!.querySelector("[data-enforcement-state]")).toBeNull();
  });
});

describe("the wording", () => {
  it("describes windows in hours or minutes", () => {
    expect(describeWindow(3600)).toBe("hour");
    expect(describeWindow(7200)).toBe("2 hours");
    expect(describeWindow(600)).toBe("10 minutes");
  });

  it("does not claim a number it was not given", () => {
    expect(enforcementHeadline({ state: "rate_limited", scope: "user" })).toBe(
      "Your account is rate limited under the Acceptable Use Policy.",
    );
  });
});
