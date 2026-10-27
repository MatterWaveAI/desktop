import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeDeepLink,
  continuePath,
  landingAfterSignIn,
  peekDeepLink,
  rememberDeepLink,
} from "./deepLink";

/**
 * Where a signed-out visitor was going: only a path this origin serves and
 * that needs a session is kept, it is kept for a while and taken once, and
 * the first navigation after sign-in prefers it over the default app.
 */

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("continuePath", () => {
  it("keeps a path into the app, with its query", () => {
    expect(continuePath("/help")).toBe("/help");
    expect(continuePath("/settings/usage?period=last")).toBe("/settings/usage?period=last");
    expect(continuePath("/apps/chat")).toBe("/apps/chat");
  });

  it("drops the root and the front door: they have nowhere better to go", () => {
    for (const path of ["/", "/login", "/signup", "/pricing", "/terms", "/share/abc"]) {
      expect(continuePath(path), path).toBeUndefined();
    }
  });

  it("drops anything a browser could read as another host or a header could choke on", () => {
    for (const bad of ["//evil.test/x", "https://evil.test", "/help\\x", "/help x", "/help\n", "", undefined, "x".repeat(1100)]) {
      expect(continuePath(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("remembering a deep link", () => {
  it("is peeked without being spent, then consumed once", () => {
    rememberDeepLink("/settings/billing");
    expect(peekDeepLink()).toBe("/settings/billing");
    expect(peekDeepLink()).toBe("/settings/billing");
    expect(consumeDeepLink()).toBe("/settings/billing");
    expect(consumeDeepLink()).toBeUndefined();
  });

  it("remembers nothing for a path that is not worth coming back to", () => {
    rememberDeepLink("/");
    rememberDeepLink("/login");
    expect(peekDeepLink()).toBeUndefined();
  });

  it("forgets after a quarter of an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
    rememberDeepLink("/help");
    vi.setSystemTime(new Date("2026-10-24T10:14:00Z"));
    expect(peekDeepLink()).toBe("/help");
    vi.setSystemTime(new Date("2026-10-24T10:16:00Z"));
    expect(peekDeepLink()).toBeUndefined();
  });
});

describe("landingAfterSignIn", () => {
  it("goes back to the remembered page, and spends the memory", () => {
    rememberDeepLink("/help");
    expect(landingAfterSignIn("/apps/chat")).toEqual({ href: "/help" });
    expect(landingAfterSignIn("/apps/chat")).toEqual({ to: "/apps/chat" });
  });

  it("goes to the default app when nothing was remembered", () => {
    expect(landingAfterSignIn("/apps/chat")).toEqual({ to: "/apps/chat" });
  });
});
