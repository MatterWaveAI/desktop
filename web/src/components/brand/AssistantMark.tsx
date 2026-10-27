import { cn } from "cn";

/**
 * The assistant's avatar: a two-colour mini wave, the logo's blue rising
 * into its green, in a small hairline tile. Decorative: the transcript
 * already says whose message it is.
 */
export function AssistantMark({ framed = true, className }: { framed?: boolean; className?: string }) {
  const wave = (
    <svg width="22" height="11" viewBox="0 0 24 12" aria-hidden focusable="false" className="shrink-0">
      <path
        d="M1 6c2-4 3-5 4.5-5S8 6 9.5 6 11 1 12.5 1"
        fill="none"
        style={{ stroke: "var(--mw-wave-blue)" }}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12.5 1c1.5 0 2 10 3.5 10s2-10 3.5-10S21 6 23 6"
        fill="none"
        style={{ stroke: "var(--mw-wave-green)" }}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
  return (
    <span
      data-slot="assistant-mark"
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        framed && "size-8 rounded-md border border-mw-border-emphasis bg-mw-surface-raised",
        className,
      )}
    >
      {wave}
    </span>
  );
}
