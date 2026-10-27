import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetLoginMethod,
  lastLoginMethod,
  rememberLoginMethod,
  rememberSsoFailure,
  ssoFailureFromQuery,
  ssoFailureMessage,
  takeSsoFailure,
} from "./loginMemory";

/**
 * What the login page remembers between visits, and what it does not: the
 * method and the email, never a password; a failure shown exactly once.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("the last sign-in method", () => {
  it("is nothing on a fresh browser", () => {
    expect(lastLoginMethod()).toBeNull();
  });

  it("remembers the organisation sign-in with its email and provider", () => {
    rememberLoginMethod({ kind: "sso", email: "ada@acme.com", provider: "okta", providerName: "Okta" });
    expect(lastLoginMethod()).toEqual({
      kind: "sso",
      email: "ada@acme.com",
      provider: "okta",
      providerName: "Okta",
    });
  });

  it("remembers a password or passkey sign-in with the email only", () => {
    rememberLoginMethod({ kind: "password", email: "ada@acme.com" });
    expect(lastLoginMethod()).toEqual({ kind: "password", email: "ada@acme.com" });
    expect(localStorage.getItem("mw:login-method")).not.toContain("password\":");
    rememberLoginMethod({ kind: "passkey" });
    expect(lastLoginMethod()).toEqual({ kind: "passkey", email: undefined });
  });

  it("ignores a corrupt or half-written entry rather than throwing", () => {
    localStorage.setItem("mw:login-method", "{not json");
    expect(lastLoginMethod()).toBeNull();
    localStorage.setItem("mw:login-method", JSON.stringify({ kind: "sso", email: "x@y.z" }));
    expect(lastLoginMethod()).toBeNull();
  });

  it("can be forgotten", () => {
    rememberLoginMethod({ kind: "passkey", email: "ada@acme.com" });
    forgetLoginMethod();
    expect(lastLoginMethod()).toBeNull();
  });
});

describe("an organisation sign-in that failed", () => {
  it("is read from the callback's query, for the two reasons the callback sends", () => {
    expect(ssoFailureFromQuery("?sso_error=idp&sso_detail=access_denied")).toEqual({
      reason: "idp",
      detail: "access_denied",
    });
    expect(ssoFailureFromQuery("sso_error=mismatch&sso_detail=bob%40other.com")).toEqual({
      reason: "mismatch",
      detail: "bob@other.com",
    });
    expect(ssoFailureFromQuery("?sso_error=anything-else")).toBeNull();
    expect(ssoFailureFromQuery("?authRequest=abc")).toBeNull();
  });

  it("survives one restart and is shown once", () => {
    rememberSsoFailure({ reason: "idp", detail: "server_error" });
    expect(takeSsoFailure()).toEqual({ reason: "idp", detail: "server_error" });
    expect(takeSsoFailure()).toBeNull();
  });

  it("is worded for each reason, naming the domain or the address", () => {
    expect(ssoFailureMessage({ reason: "not_configured", detail: "acme.com" })).toContain(
      "No single sign-on is set up for acme.com",
    );
    expect(ssoFailureMessage({ reason: "unavailable", detail: "" })).toContain("could not be reached");
    expect(ssoFailureMessage({ reason: "idp", detail: "access_denied" })).toContain("access_denied");
    expect(ssoFailureMessage({ reason: "mismatch", detail: "bob@other.com" })).toContain(
      "signed in bob@other.com",
    );
  });
});
