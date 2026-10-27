import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../shell/frontDoorHarness";
import { ApiError } from "./api";
import { MFA_REQUIRED_EXPLANATION, fetchMfaSettings, mfaStatusLine, setMfaRequired } from "./orgMfa";

/**
 * The org MFA policy's API shape, as routes_org.py serves it: one boolean
 * read from and written to /api/org/mfa, and the owner-only refusal
 * arriving as the ApiError the pane shows verbatim.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body as Record<string, unknown>, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchMfaSettings", () => {
  it("reads the policy from GET /api/org/mfa", async () => {
    const fetchMock = stubFetch(200, { mfa_required: true });
    await expect(fetchMfaSettings()).resolves.toEqual({ mfa_required: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("/api/org/mfa");
    expect(init?.method ?? "GET").toBe("GET");
  });
});

describe("setMfaRequired", () => {
  it("PUTs the one boolean the route takes and returns what it holds afterwards", async () => {
    const fetchMock = stubFetch(200, { mfa_required: true });
    await expect(setMfaRequired(true)).resolves.toEqual({ mfa_required: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/org/mfa");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ mfa_required: true });
  });

  it("surfaces the owner-only refusal as an ApiError carrying the API's sentence", async () => {
    stubFetch(403, { detail: "Only an organisation owner can change the two-factor requirement." });
    const err = await setMfaRequired(false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe(
      "Only an organisation owner can change the two-factor requirement.",
    );
  });
});

describe("the policy's wording", () => {
  it("states each side of the switch in one sentence", () => {
    expect(mfaStatusLine(true)).toContain("required");
    expect(mfaStatusLine(false)).toContain("optional");
  });

  it("says what the route does: enrol at the next password sign-in, no lock-out, no grace period", () => {
    const text = MFA_REQUIRED_EXPLANATION.join(" ");
    expect(text).toContain("not locked out");
    expect(text).toContain("next password sign-in");
    expect(text).toContain("no grace period");
    expect(text).toContain("identity provider");
  });
});
