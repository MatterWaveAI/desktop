import { MICROS_PER_USD } from "../../../lib/billing";

/**
 * Micro-dollars on the wire, dollars in the field. Its own file so the
 * pane exports only its component (fast refresh) and the parsing is
 * testable without a DOM.
 */

const MICROS_PER_CENT = MICROS_PER_USD / 100;

/** "$12.5" and "12" both mean 1250 and 1200 cents; anything else is null. */
export function parseDollars(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

/**
 * The overage cap field as micro-dollars: whole cents typed in dollars, and
 * an empty field as 0, which the API reads as "the plan's default". Null
 * while the text is not an amount.
 */
export function parseCapMicros(text: string): number | null {
  if (text.trim() === "") return 0;
  const cents = parseDollars(text);
  return cents === null ? null : cents * MICROS_PER_CENT;
}

/**
 * A cap read back into the field: two places, no symbol, no grouping, so
 * it parses again unchanged. A cap set below a cent elsewhere (the API
 * takes any micro-dollar amount) rounds to the nearest cent here, which
 * only matters if the admin saves it back.
 */
export function capFieldText(micros: number): string {
  return (micros / MICROS_PER_USD).toFixed(2);
}

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  // The API's months are calendar months, not instants: read them in UTC so
  // the first of the month never slips back into the one before.
  timeZone: "UTC",
});

/**
 * A billing month as a person says it: "2026-10" or a period start
 * "2026-10-01" becomes "October 2026" in the reader's locale. Anything
 * else is returned as given rather than shown as "Invalid Date".
 */
export function formatMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return Number.isNaN(date.getTime()) ? value : MONTH_FORMAT.format(date);
}
