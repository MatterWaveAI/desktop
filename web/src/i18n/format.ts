import { i18n } from "@lingui/core";
import { SOURCE_LOCALE } from "./locale";

/**
 * Dates, times and numbers in the reader's language and timezone, through
 * `Intl`. Every surface that shows a timestamp should come through here
 * rather than call `toLocaleDateString` with a hard-coded locale: the
 * locale is the active catalogue's, so switching the language in
 * Preferences switches "24 October 2026" to "24 de octubre de 2026" too.
 *
 * Money and token counts are NOT here. `lib/billing.ts` formats both on
 * purpose in one dialect -- USD list prices read the same to every buyer,
 * and "1.5M tokens" is a unit, not a quantity -- so they stay locale-free.
 *
 * Timezone: the browser's, which is what every call here means by default.
 * A caller that must show a date as the server meant it (a terms revision
 * dated by day, not by instant) passes `timeZone: "UTC"`.
 */

function locale(): string {
  return i18n.locale || SOURCE_LOCALE;
}

// Intl formatters are costly to build and cheap to keep; one per
// locale-and-options is plenty for a page of timestamps.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const listFormatters = new Map<string, Intl.ListFormat>();

function keyed<T>(cache: Map<string, T>, options: object, make: () => T): T {
  const key = `${locale()}|${JSON.stringify(options)}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter;
}

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "24 October 2026" / "October 24, 2026" / "24 de octubre de 2026". */
export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" },
): string {
  const date = toDate(value);
  if (!date) return "";
  return keyed(dateFormatters, options, () => new Intl.DateTimeFormat(locale(), options)).format(date);
}

/** "24 Oct 2026, 14:05" in the reader's timezone. */
export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return formatDate(value, options);
}

/** "14:05" / "2:05 PM", as the locale writes a clock time. */
export function formatTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { timeStyle: "short" },
): string {
  return formatDate(value, options);
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return keyed(numberFormatters, options, () => new Intl.NumberFormat(locale(), options)).format(value);
}

/** A fraction (0.8) as the locale writes a percentage ("80%" / "80 %"). */
export function formatPercent(fraction: number, options: Intl.NumberFormatOptions = {}): string {
  return formatNumber(fraction, { style: "percent", maximumFractionDigits: 0, ...options });
}

/** "Terms, Privacy and Contact" / "Terms, Privacy y Contact". */
export function formatList(
  items: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  const options = { type, style: "long" as const };
  return keyed(listFormatters, options, () => new Intl.ListFormat(locale(), options)).format(items);
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/**
 * "3 minutes ago", "yesterday", "in 2 weeks" -- the largest unit that fits,
 * with the locale's words for the adjacent ones (`numeric: "auto"` is what
 * turns "1 day ago" into "yesterday"). Under a minute reads as "now".
 */
export function formatRelativeTime(value: string | number | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const options: Intl.RelativeTimeFormatOptions = { numeric: "auto" };
  const formatter = keyed(
    relativeFormatters,
    options,
    () => new Intl.RelativeTimeFormat(locale(), options),
  );
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return formatter.format(0, "second");
}
