import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "./drafts";

/**
 * The case this exists for is a phone evicting a background
 * tab while the user is in another app — so the tests are about surviving a
 * reload and about never throwing when storage refuses.
 */

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("composer drafts", () => {
  it("round-trips a draft for a conversation", () => {
    saveDraft("c-1", "half a message");
    expect(loadDraft("c-1")).toBe("half a message");
  });

  it("keeps drafts separate per conversation", () => {
    saveDraft("c-1", "one");
    saveDraft("c-2", "two");
    expect(loadDraft("c-1")).toBe("one");
    expect(loadDraft("c-2")).toBe("two");
  });

  it("gives a conversation with no draft an empty string, not null", () => {
    expect(loadDraft("never-typed-in")).toBe("");
  });

  it("stores a not-yet-created conversation's draft under its own key", () => {
    saveDraft(null, "typed before the conversation existed");
    expect(loadDraft(null)).toBe("typed before the conversation existed");
    // And it does not leak into a real conversation.
    expect(loadDraft("c-1")).toBe("");
  });

  it("removes the key rather than storing an empty string", () => {
    saveDraft("c-1", "something");
    clearDraft("c-1");
    expect(localStorage.getItem("mw-draft:c-1")).toBeNull();
    expect(loadDraft("c-1")).toBe("");
  });

  it("does not throw when storage refuses to write", () => {
    // Safari in private mode throws on setItem at quota. Losing a draft is
    // bad; taking the composer down with it is worse.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveDraft("c-1", "text")).not.toThrow();
  });

  it("does not throw when storage refuses to read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(loadDraft("c-1")).toBe("");
  });
});
