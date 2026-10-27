import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../types";
import {
  completeLogin,
  rememberedLoginReturn,
  returnPathForLogin,
  signOut,
  startLogin,
} from "./auth";

/**
 * Sign-in is the API's (BFF) job. These tests pin the SPA to that shape:
 * it navigates to the API's login route and never builds an authorization
 * URL, holds a token, or talks to the identity provider's token endpoint. The
 * nonce/state binding this file used to test now lives where the exchange
 * happens - api/tests/test_auth_oidc.py. What a 401 from /api/me does is
 * Boot's decision now (boot.test.tsx): the landing page, not a bounce.
 */

const ISSUER = "https://idp.example.com";
const APP_ORIGIN = "https://app.example.com";

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    auth_mode: "oidc",
    csrf_cookie: "mw_csrf",
    default_model: "test-model",
    issuer: ISSUER,
    client_id: "matterwave",
    login_url: "/api/auth/login",
    authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
    token_endpoint: `${ISSUER}/oauth/v2/token`,
    end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
    scopes: ["openid", "profile"],
    ...overrides,
  } as AuthConfig;
}

interface LocationStub {
  origin: string;
  pathname: string;
  search: string;
  href: string;
  assign: ReturnType<typeof vi.fn>;
}

let locationStub: LocationStub;

// jsdom's location.assign cannot be spied on; replace the object.
function installLocationStub(path = "/"): LocationStub {
  const url = new URL(path, APP_ORIGIN);
  const stub: LocationStub = {
    origin: APP_ORIGIN,
    pathname: url.pathname,
    search: url.search,
    href: url.toString(),
    assign: vi.fn(),
  };
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: stub });
  locationStub = stub;
  return stub;
}

function mockFetch(status: number, body: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sessionStorage.clear();
  installLocationStub("/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startLogin", () => {
  it("navigates to the API's login route from the config", () => {
    startLogin(config({ login_url: "/api/auth/login" }));
    expect(locationStub.assign).toHaveBeenCalledWith("/api/auth/login");
  });

  it("defaults to /api/auth/login when the config names none", () => {
    startLogin(config({ login_url: undefined }));
    expect(locationStub.assign).toHaveBeenCalledWith("/api/auth/login");
  });

  it("carries the device page back to the API, and nothing else", () => {
    startLogin(config(), undefined, "/device?user_code=ABCD-2345");
    expect(locationStub.assign).toHaveBeenCalledWith(
      "/api/auth/login?return=%2Fdevice%3Fuser_code%3DABCD-2345",
    );
    startLogin(config(), "okta", "/device?user_code=ABCD-2345");
    expect(locationStub.assign).toHaveBeenLastCalledWith(
      "/api/auth/login?idp=okta&return=%2Fdevice%3Fuser_code%3DABCD-2345",
    );
    startLogin(config(), undefined, "/settings");
    expect(locationStub.assign).toHaveBeenLastCalledWith("/api/auth/login");
  });

  it("never builds an authorization URL or stores PKCE state in the browser", () => {
    startLogin(config());
    const target = String(locationStub.assign.mock.calls[0][0]);
    expect(target).not.toContain("authorize");
    expect(target).not.toContain("code_challenge");

    // The PKCE verifier, state and nonce are the API's: they live in an
    // HttpOnly cookie that `/api/auth/callback` reads, and the browser must
    // never hold them. Asserted by NAME rather than by `sessionStorage.length
    // === 0`, because the in-flight guard added for the sign-in loop does
    // store one key here -- a timestamp, which is not a secret and cannot
    // authenticate anything. A bare length check would have forced that guard
    // into a weaker place to live rather than catching a real leak.
    const stored = Object.keys(sessionStorage).map((k) => `${k}=${sessionStorage.getItem(k)}`);
    for (const entry of stored) {
      expect(entry).not.toMatch(/verifier|code_challenge|nonce|state=|token/i);
    }
    expect(sessionStorage.getItem("mw:login-starting")).toMatch(/^\d+$/);
  });
});

describe("rememberedLoginReturn", () => {
  it("is the return of the start in flight, until a start without one or the finish", () => {
    startLogin(config(), undefined, "/device?user_code=ABCD-2345");
    expect(rememberedLoginReturn()).toBe("/device?user_code=ABCD-2345");
    // A restart from the form carries it again and keeps it.
    startLogin(config(), "okta", rememberedLoginReturn());
    expect(locationStub.assign).toHaveBeenLastCalledWith(
      "/api/auth/login?idp=okta&return=%2Fdevice%3Fuser_code%3DABCD-2345",
    );
    expect(rememberedLoginReturn()).toBe("/device?user_code=ABCD-2345");

    completeLogin("/api/auth/callback?code=xyz");
    expect(rememberedLoginReturn()).toBeUndefined();

    startLogin(config(), undefined, "/device?user_code=ABCD-2345");
    startLogin(config());
    expect(rememberedLoginReturn()).toBeUndefined();
  });

  it("remembers nothing the API would not follow, and nothing older than its login state", () => {
    startLogin(config(), undefined, "/settings");
    expect(rememberedLoginReturn()).toBeUndefined();

    sessionStorage.setItem("mw:login-return", `${Date.now()} https://evil.example/device`);
    expect(rememberedLoginReturn()).toBeUndefined();

    sessionStorage.setItem("mw:login-return", `${Date.now() - 11 * 60_000} /device?user_code=1`);
    expect(rememberedLoginReturn()).toBeUndefined();
    expect(sessionStorage.getItem("mw:login-return")).toBeNull();
  });
});

describe("returnPathForLogin", () => {
  it.each(["/device", "/device?user_code=ABCD-2345", "/device/", "/device?user_code=1&x=2"])(
    "accepts the device page: %s",
    (path) => {
      expect(returnPathForLogin(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    "",
    "/",
    "/settings",
    "/devices",
    "/devicex?user_code=1",
    "device?user_code=1",
    "//evil.example/device",
    "/\\evil.example/device",
    "/device\\..\\x",
    "https://evil.example/device",
    "javascript:alert(1)",
    "/device?user_code=1\r\nx",
    `/device?${"a".repeat(600)}`,
  ])("refuses anything else: %s", (path) => {
    expect(returnPathForLogin(path)).toBeUndefined();
  });
});

describe("signOut", () => {
  it("clears the API session, then ends the IdP session with the app identified by client_id", async () => {
    const fetchMock = mockFetch(200, { status: "ok" });
    await signOut(config());
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/logout");
    const target = new URL(String(locationStub.assign.mock.calls[0][0]));
    expect(target.origin).toBe(ISSUER);
    expect(target.pathname).toBe("/oidc/v1/end_session");
    expect(target.searchParams.get("client_id")).toBe("matterwave");
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(`${APP_ORIGIN}/`);
    expect(target.searchParams.has("id_token_hint")).toBe(false);
  });

  it("still ends the IdP session when the API logout fails", async () => {
    mockFetch(500, { detail: "boom" });
    await signOut(config());
    expect(locationStub.assign).toHaveBeenCalled();
  });

  it("does nothing IdP-side in auth_mode none", async () => {
    mockFetch(200, { status: "ok" });
    await signOut(config({ auth_mode: "none", end_session_endpoint: undefined }));
    expect(locationStub.assign).not.toHaveBeenCalled();
  });
});
