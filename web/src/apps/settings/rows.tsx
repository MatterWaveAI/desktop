import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The list inside a panel -- people, keys, sessions, devices -- as clean
 * rows split by hairlines: an optional leading mark (initials, an icon),
 * the name with one secondary line under it, and the row's controls on the
 * trailing edge, wrapping under the name on a phone.
 */
export function RowList(props: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <ul
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      className={cn("m-0 list-none divide-y divide-border p-0", props.className)}
    >
      {props.children}
    </ul>
  );
}

export function Row(props: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Anything under the meta line: a note, an inline form. */
  extra?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <li
      data-testid={props["data-testid"]}
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4", props.className)}
    >
      {props.leading}
      <div className="flex min-w-0 flex-1 basis-56 flex-col leading-snug">
        <div className="min-w-0 font-medium break-words">{props.title}</div>
        {props.meta && <div className="text-sm break-words text-mw-text-muted">{props.meta}</div>}
        {props.extra}
      </div>
      {props.trailing && <div className="flex flex-wrap items-center gap-2">{props.trailing}</div>}
    </li>
  );
}

/** Two letters for a name or an email: "Ada Lovelace" is AL, "cy@acme.com" is CY. */
export function initialsOf(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim();
  const base = trimmed.includes("@") && !trimmed.includes(" ") ? trimmed.split("@")[0] : trimmed;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const INITIAL_TONES = [
  "border-mw-info-border bg-mw-info-subtle text-mw-info",
  "border-mw-positive-border bg-mw-positive-subtle text-mw-positive",
] as const;

/**
 * The round initials mark at the start of a person's row. Decorative --
 * the name beside it is the text -- and its tint, blue or emerald, is
 * picked from the name so a person keeps the same one.
 */
export function Initials(props: { name: string; className?: string }) {
  let hash = 0;
  for (const ch of props.name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const tone = INITIAL_TONES[Math.abs(hash) % INITIAL_TONES.length];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
        tone,
        props.className,
      )}
    >
      {initialsOf(props.name)}
    </span>
  );
}

/**
 * "Active today" (fresh, shown in the positive green), "Active yesterday",
 * then a date, and "Never active" for nobody yet: the short phrase a reader
 * scanning a list wants rather than a timestamp.
 */
export function activityLabel(iso: string | null, now: Date = new Date()): { text: string; fresh: boolean } {
  if (!iso) return { text: "Never active", fresh: false };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { text: iso, fresh: false };
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return { text: "Active today", fresh: true };
  if (days === 1) return { text: "Active yesterday", fresh: false };
  return { text: `Active ${at.toLocaleDateString(undefined, { dateStyle: "medium" })}`, fresh: false };
}

export function Activity(props: { iso: string | null; "data-testid"?: string }) {
  const { text, fresh } = activityLabel(props.iso);
  return (
    <span data-testid={props["data-testid"]} className={fresh ? "text-mw-positive" : undefined}>
      {text}
    </span>
  );
}
