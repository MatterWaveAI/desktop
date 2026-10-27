import { describe, expect, it } from "vitest";
import { formatMessageTime, formatMessageTimeFull } from "./formatMessageTime";

/**
 * The short form by distance from "now". Local-time strings (no `Z`) so
 * the day boundaries land the same whatever zone the runner is in, and a
 * pinned locale so the spelling is the assertion, not the machine's.
 */

/** Sunday 18 October 2026, 15:00 local. */
const NOW = new Date(2026, 9, 18, 15, 0);
const GB = "en-GB";

describe("formatMessageTime", () => {
  it("is the clock alone for today", () => {
    expect(formatMessageTime("2026-10-18T14:05:00", NOW, GB)).toBe("14:05");
    expect(formatMessageTime("2026-10-18T00:01:00", NOW, GB)).toBe("00:01");
  });

  it("names the weekday within the last six days, never on the seventh", () => {
    expect(formatMessageTime("2026-10-17T14:05:00", NOW, GB)).toBe("Sat 14:05");
    expect(formatMessageTime("2026-10-12T09:30:00", NOW, GB)).toBe("Mon 09:30");
    // Seven days back is a Sunday too: "Sun" would read as today.
    expect(formatMessageTime("2026-10-11T14:05:00", NOW, GB)).toBe("11 Oct");
  });

  it("is the date beyond a week, with the year only when it differs", () => {
    expect(formatMessageTime("2026-03-03T14:05:00", NOW, GB)).toBe("3 Mar");
    expect(formatMessageTime("2025-10-03T14:05:00", NOW, GB)).toBe("3 Oct 2025");
  });

  it("spells the clock the reader's way", () => {
    expect(formatMessageTime("2026-10-18T14:05:00", NOW, "en-US")).toBe("02:05 PM");
  });

  it("treats a message from a skewed clock as a date, not as a weekday in the future", () => {
    expect(formatMessageTime("2026-10-19T14:05:00", NOW, GB)).toBe("19 Oct");
  });

  it("says nothing for a timestamp it cannot read", () => {
    expect(formatMessageTime("not a time", NOW, GB)).toBe("");
    expect(formatMessageTimeFull("not a time", GB)).toBe("");
  });

  it("gives the full moment for the tooltip", () => {
    expect(formatMessageTimeFull("2026-10-18T14:05:00", GB)).toBe("18 Oct 2026, 14:05");
  });
});
