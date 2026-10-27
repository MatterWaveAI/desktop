import { cn } from "cn";
import { WaveMark } from "./WaveMark";

/**
 * The wordmark as the logo sets it: "Matter" upright, "Wave" italic, and a
 * smaller upright "ai", all in Instrument Serif. Text, not an image, so it
 * is crisp at every size, selectable, and read as "MatterWave ai".
 *
 * `size` picks a display step; the "ai" is sized relative to it (the logo's
 * 27px against 38px) by the `.mw-wordmark-ai` rule in styles.css.
 */

const SIZES = {
  sm: "text-xl",
  md: "text-display-sm",
  lg: "text-display-md",
} as const;

export type WordmarkSize = keyof typeof SIZES;

export function Wordmark({ size = "md", className }: { size?: WordmarkSize; className?: string }) {
  return (
    <span
      data-slot="wordmark"
      className={cn("inline-block font-display leading-none whitespace-nowrap text-mw-text", SIZES[size], className)}
    >
      Matter<em className="italic">Wave</em> <span className="mw-wordmark-ai">ai</span>
    </span>
  );
}

const WAVE_WIDTH: Record<WordmarkSize, number> = { sm: 104, md: 132, lg: 164 };

/**
 * The stacked lockup the sidebar uses: the wordmark over the waves, as in
 * the logo. The waves are decorative here; the wordmark is the name.
 */
export function BrandLockup({ size = "md", className }: { size?: WordmarkSize; className?: string }) {
  return (
    <span data-slot="brand-lockup" className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Wordmark size={size} />
      <WaveMark width={WAVE_WIDTH[size]} />
    </span>
  );
}
