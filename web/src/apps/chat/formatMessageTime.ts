/**
 * When a message was sent, as short as the distance allows: `14:05` for
 * today, `Mon 14:05` within the last week, `3 Oct` for anything older this
 * year and `3 Oct 2025` beyond that. Local time, in the reader's own
 * locale's spelling (`02:05 PM` where that is what a clock says), with the
 * two-digit hour the shell's other clocks use so a column of times lines up.
 *
 * A week is six days back, not seven: `Mon` on the seventh day would name
 * today's weekday for a message that is not today's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatMessageTime(iso: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  // Rounded: a DST change makes a day 23 or 25 hours long.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) {
    return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  }
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The whole moment, for the tooltip behind the short form. */
export function formatMessageTimeFull(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
