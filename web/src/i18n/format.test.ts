import { afterEach, describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from "./format";
import { activateLocale, SOURCE_LOCALE } from "./locale";

/**
 * The Intl helpers follow the active catalogue's locale: the same instant
 * reads as the British, American and Spanish conventions in turn, and a
 * value that is not a date renders as nothing rather than "Invalid Date".
 */

const NOON = "2026-10-24T12:05:00Z";

afterEach(async () => {
  await activateLocale(SOURCE_LOCALE);
});

describe("dates", () => {
  it("writes a date the way the active locale does", async () => {
    const options = { dateStyle: "long" as const, timeZone: "UTC" };
    expect(formatDate(NOON, options)).toBe("24 October 2026");
    await activateLocale("en-US");
    expect(formatDate(NOON, options)).toBe("October 24, 2026");
    await activateLocale("es-ES");
    expect(formatDate(NOON, options)).toBe("24 de octubre de 2026");
  });

  it("accepts a Date, a timestamp or an ISO string, and nothing for garbage", () => {
    const options = { dateStyle: "medium" as const, timeZone: "UTC" };
    expect(formatDate(new Date(NOON), options)).toBe("24 Oct 2026");
    expect(formatDate(Date.parse(NOON), options)).toBe("24 Oct 2026");
    expect(formatDate("not a date")).toBe("");
  });

  it("has date-and-time and time-only shapes in the same locale", () => {
    expect(formatDateTime(NOON, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })).toBe(
      "24 Oct 2026, 12:05",
    );
    expect(formatTime(NOON, { timeStyle: "short", timeZone: "UTC" })).toBe("12:05");
  });
});

describe("numbers", () => {
  it("groups and punctuates for the locale", async () => {
    expect(formatNumber(1234567.5)).toBe("1,234,567.5");
    expect(formatPercent(0.8)).toBe("80%");
    await activateLocale("es-ES");
    expect(formatNumber(1234567.5)).toBe("1.234.567,5");
    // Spanish writes a space before the sign; whichever space Intl picks,
    // the digits and the sign are what the test is about.
    expect(formatPercent(0.8).replace(/\s/g, "")).toBe("80%");
  });

  it("joins a list with the locale's conjunction", async () => {
    expect(formatList(["Terms", "Privacy", "Contact"])).toBe("Terms, Privacy and Contact");
    expect(formatList(["Terms", "Privacy"], "disjunction")).toBe("Terms or Privacy");
    await activateLocale("es-ES");
    expect(formatList(["Términos", "Privacidad"])).toBe("Términos y Privacidad");
  });
});

describe("relative time", () => {
  const now = new Date(NOON);

  it("picks the largest unit that fits and the locale's words for the near ones", async () => {
    expect(formatRelativeTime("2026-10-24T12:04:30Z", now)).toBe("now");
    expect(formatRelativeTime("2026-10-24T12:02:00Z", now)).toBe("3 minutes ago");
    expect(formatRelativeTime("2026-10-24T09:05:00Z", now)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-10-23T12:05:00Z", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-11-07T12:05:00Z", now)).toBe("in 2 weeks");
    expect(formatRelativeTime("2025-10-24T12:05:00Z", now)).toBe("last year");
    await activateLocale("es-ES");
    expect(formatRelativeTime("2026-10-23T12:05:00Z", now)).toBe("ayer");
    expect(formatRelativeTime("2026-10-24T12:02:00Z", now)).toBe("hace 3 minutos");
  });

  it("renders nothing for a value that is not a date", () => {
    expect(formatRelativeTime("soon", now)).toBe("");
  });
});
