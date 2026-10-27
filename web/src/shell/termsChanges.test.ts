import { describe, expect, it } from "vitest";
import { TERMS_CHANGES, termsChangesSince } from "./termsChanges";

/**
 * The list the re-accept page reads "What changed" from: newest first,
 * versions in the API's `YYYY-MM` shape, and a filter that keeps only what
 * is new to the person asked to accept.
 */
describe("TERMS_CHANGES", () => {
  it("is newest first, with the API's version shape and a line per entry", () => {
    expect(TERMS_CHANGES.length).toBeGreaterThan(0);
    for (const change of TERMS_CHANGES) {
      expect(change.version).toMatch(/^\d{4}-\d{2}$/);
      expect(change.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(change.summary.length).toBeGreaterThan(10);
    }
    const versions = TERMS_CHANGES.map((c) => c.version);
    expect([...versions].sort().reverse()).toEqual(versions);
  });

  it("describes the 2026-10 revision as the plans section", () => {
    const latest = TERMS_CHANGES.find((c) => c.version === "2026-10");
    expect(latest?.summary).toMatch(/overage cap/);
    expect(latest?.summary).toMatch(/annual plans/i);
  });
});

describe("termsChangesSince", () => {
  it("keeps only the versions after the one accepted", () => {
    expect(termsChangesSince("2026-09").map((c) => c.version)).toEqual(["2026-10"]);
    expect(termsChangesSince("2026-10")).toEqual([]);
  });

  it("keeps everything for an account with no recorded version", () => {
    expect(termsChangesSince(null)).toEqual(TERMS_CHANGES);
    expect(termsChangesSince(undefined)).toEqual(TERMS_CHANGES);
  });
});
