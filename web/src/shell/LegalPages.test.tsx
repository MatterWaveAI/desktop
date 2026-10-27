import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyPage } from "./PrivacyPage";
import { TermsPage } from "./TermsPage";
import { PRIVACY_PATH, SIGNUP_PATH, TERMS_PATH, isAnonymousPath } from "./frontDoor";
import { authConfig, cleanup, jsonResponse, linkTo, mount, stubApi, view } from "./frontDoorHarness";
import { SessionContext } from "./sessionContext";
import { ShellContext, type ShellContextValue } from "./shellContext";
import type { Principal } from "../types";

/**
 * The legal pages the signup form links. Both render without a
 * session, both carry a "last updated" date, and the terms page shows the
 * version the API stamps on the account - fetched from /api/auth-config,
 * because the SPA must never carry its own copy of that string.
 */

const ROUTES = { [TERMS_PATH]: TermsPage, [PRIVACY_PATH]: PrivacyPage };

afterEach(cleanup);

describe("the front door", () => {
  it("lets a stranger reach both legal pages", () => {
    expect(isAnonymousPath(TERMS_PATH)).toBe(true);
    expect(isAnonymousPath(PRIVACY_PATH)).toBe(true);
  });
});

describe("/terms", () => {
  // First in the file on purpose: lib/auth caches the config once fetched,
  // and a later test in this module would read the cache, not the 503.
  it("reads without the version line when auth-config cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "down" }, 503)),
    );
    await mount(TERMS_PATH, ROUTES);

    expect(view().querySelector("h1")?.textContent).toBe("Terms of Service");
    expect(view().querySelectorAll("h2").length).toBeGreaterThan(3);
    expect(view().querySelector("[data-testid='terms-version']")).toBeNull();
  });

  it("describes the self-serve plans the Plans page sells: allowance, overage up to a cap, annual without", async () => {
    stubApi({});
    await mount(TERMS_PATH, ROUTES);
    const text = view().textContent ?? "";
    expect(text).toContain("Plans, fees and limits");
    expect(text).toContain("subscribe to a paid plan on the Plans page");
    expect(text).toMatch(/billed as overage .* up to\s+an overage cap/);
    expect(text).toContain("Annual plans have no overage");
    expect(text).not.toContain("monthly budget");
  });

  it("shows the heading, the last-updated date and the API's terms version", async () => {
    stubApi({});
    await mount(TERMS_PATH, ROUTES);

    expect(view().querySelector("h1")?.textContent).toBe("Terms of Service");
    expect(view().textContent).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}/);
    await vi.waitFor(() => {
      expect(view().querySelector("[data-testid='terms-version']")?.textContent).toBe(
        "Version 2026-09",
      );
    });
  });

  it("links the privacy policy and the signup form", async () => {
    stubApi({});
    await mount(TERMS_PATH, ROUTES);
    expect(linkTo(PRIVACY_PATH)?.textContent).toBe("Privacy Policy");
    expect(linkTo(SIGNUP_PATH)?.textContent).toBe("Create account");
  });
});

describe("the legal pages' way onward", () => {
  const principal: Principal = {
    subject: "ada",
    kind: "user",
    email: "ada@example.com",
    name: null,
    roles: [],
    org_id: "org",
    org_name: null,
    org_role: "owner",
  };

  it("offers an account to a stranger", async () => {
    stubApi({});
    await mount(TERMS_PATH, ROUTES);
    expect(view().querySelector("[data-testid='legal-onward']")?.textContent).toBe("Create account");
    expect(view().querySelector("[data-testid='legal-onward']")?.getAttribute("href")).toBe(SIGNUP_PATH);
  });

  it("sends a person held at the terms gate back to it, never to signup", async () => {
    stubApi({});
    const Page = () => (
      <SessionContext.Provider value={{ config: authConfig, principal, gate: "terms" }}>
        <TermsPage />
      </SessionContext.Provider>
    );
    await mount(TERMS_PATH, { [TERMS_PATH]: Page });
    const onward = view().querySelector("[data-testid='legal-onward']")!;
    expect(onward.textContent).toBe("Back to MatterWave");
    expect(onward.getAttribute("href")).toBe("/");
    expect(view().textContent).not.toContain("Create account");
  });

  it("sends a signed-in reader back into the app", async () => {
    stubApi({});
    const shell = { authConfig, principal } as unknown as ShellContextValue;
    const Page = () => (
      <ShellContext.Provider value={shell}>
        <SessionContext.Provider value={{ config: authConfig, principal, gate: null }}>
          <PrivacyPage />
        </SessionContext.Provider>
      </ShellContext.Provider>
    );
    await mount(PRIVACY_PATH, { [PRIVACY_PATH]: Page });
    const onward = view().querySelector("[data-testid='legal-onward']")!;
    expect(onward.textContent).toBe("Back to MatterWave");
    expect(onward.getAttribute("href")).toBe("/apps/chat");
  });

  it("describes itself as pre-release terms to be updated, not a placeholder", async () => {
    stubApi({});
    await mount(TERMS_PATH, ROUTES);
    expect(view().textContent).toContain("These are the pre-release terms for MatterWave.");
    expect(view().textContent).toContain("updated before general availability");
    expect(view().textContent?.toLowerCase()).not.toContain("placeholder");
  });
});

describe("/privacy", () => {
  it("shows the heading and the last-updated date, and names the controls Settings has", async () => {
    const fetchMock = stubApi({});
    await mount(PRIVACY_PATH, ROUTES);

    expect(view().querySelector("h1")?.textContent).toBe("Privacy Policy");
    expect(view().textContent).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}/);
    expect(view().textContent).toContain("export everything");
    expect(view().textContent).toContain("pre-release privacy policy");
    expect(view().textContent?.toLowerCase()).not.toContain("placeholder");
    expect(linkTo(TERMS_PATH)?.textContent).toBe("Terms of Service");
    // No version line on the policy, so nothing to fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
