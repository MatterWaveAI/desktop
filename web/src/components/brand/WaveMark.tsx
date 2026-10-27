import { useId } from "react";
import { cn } from "cn";

/**
 * The logo's waves: the blue wave, the green wave, and the bold M and W
 * highlights where they cross. The four paths and four gradients are the
 * owner's logo (sites/matterwave_ai_cloudflare/new-logo.svg) verbatim; only
 * the viewBox is cropped to the waves, and the stop colours come from the
 * `--mw-wave-*` tokens (theme.css) rather than colour literals here.
 *
 * Gradient ids are per instance (useId): two marks on one page with fixed
 * ids would both paint with whichever <defs> the document met first, and a
 * mark inside a hidden subtree would then lose its colour entirely.
 *
 * Decorative by default (aria-hidden). Pass `label` when the mark stands on
 * its own as the brand, and it becomes an img with that name.
 */

/** The waves' bounding box in the logo's own coordinates, stroke included. */
const VIEW_BOX = { x: 94, y: 61, width: 328, height: 46 };
const WAVE_ASPECT = VIEW_BOX.width / VIEW_BOX.height;

const BLUE_WAVE = `M 97.0,84.0
  C 99.5,84.0 102.0,80.0 105.0,80.0
  C 109.5,80.0 114.0,88.0 119.0,88.0
  C 124.0,88.0 129.5,75.0 135.5,75.0
  C 141.5,75.0 146.5,93.0 152.5,93.0
  C 158.5,93.0 164.0,69.0 170.0,69.0
  C 176.0,69.0 181.5,99.0 187.5,99.0
  C 193.0,99.0 199.0,65.0 205.0,65.0
  C 211.0,65.0 214.5,103.0 220.5,103.0
  C 226.5,103.0 230.0,65.0 236.0,65.0
  C 242.0,65.0 245.5,103.0 251.5,103.0
  C 257.5,103.0 261.0,66.0 267.0,66.0
  C 271.0,66.0 274.0,84.0 276.0,84.0`;

const GREEN_WAVE = `M 244.0,84.0
  C 246.0,84.0 248.5,66.0 251.5,66.0
  C 257.5,66.0 261.0,103.0 267.0,103.0
  C 273.0,103.0 276.5,65.0 282.5,65.0
  C 288.5,65.0 292.0,103.0 298.0,103.0
  C 304.0,103.0 307.5,65.0 313.5,65.0
  C 319.5,65.0 324.0,98.0 330.0,98.0
  C 336.0,98.0 341.0,70.0 347.0,70.0
  C 353.0,70.0 359.0,92.0 365.0,92.0
  C 371.0,92.0 377.0,76.0 383.0,76.0
  C 389.0,76.0 395.0,87.5 401.0,87.5
  C 406.0,87.5 412.0,84.0 418.0,84.0`;

const M_HIGHLIGHT = `M 197.0,84.0
  C 199.5,84.0 201.5,65.0 205.0,65.0
  C 211.0,65.0 214.5,103.0 220.5,103.0
  C 226.5,103.0 230.0,65.0 236.0,65.0
  C 239.5,65.0 242.0,84.0 244.0,84.0`;

const W_HIGHLIGHT = `M 259.0,84.0
  C 261.0,84.0 263.5,103.0 267.0,103.0
  C 273.0,103.0 276.5,65.0 282.5,65.0
  C 288.5,65.0 292.0,103.0 298.0,103.0
  C 301.5,103.0 304.0,84.0 306.0,84.0`;

type Stop = { offset: string; color: string; opacity?: number };

function Gradient(props: { id: string; x1: number; x2: number; stops: Stop[] }) {
  return (
    <linearGradient id={props.id} x1={props.x1} y1="0" x2={props.x2} y2="0" gradientUnits="userSpaceOnUse">
      {props.stops.map((stop) => (
        <stop
          key={stop.offset}
          offset={stop.offset}
          style={{ stopColor: `var(${stop.color})`, stopOpacity: stop.opacity ?? 1 }}
        />
      ))}
    </linearGradient>
  );
}

const STROKE = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function WaveMark({
  width = 150,
  label,
  className,
}: {
  /** Rendered width in px; the height follows the logo's proportions. */
  width?: number;
  /** An accessible name; without one the mark is decorative. */
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/[^\w-]/g, "");
  const ids = { blue: `${uid}-blue`, green: `${uid}-green`, m: `${uid}-m`, w: `${uid}-w` };
  return (
    <svg
      data-slot="wave-mark"
      width={width}
      height={Math.round((width / WAVE_ASPECT) * 100) / 100}
      viewBox={`${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}`}
      className={cn("shrink-0", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: "false" })}
    >
      <defs>
        <Gradient
          id={ids.blue}
          x1={97}
          x2={276}
          stops={[
            { offset: "0%", color: "--mw-wave-blue", opacity: 0 },
            { offset: "30%", color: "--mw-wave-blue", opacity: 0.85 },
            { offset: "85%", color: "--mw-wave-sky" },
            { offset: "100%", color: "--mw-wave-sky", opacity: 0 },
          ]}
        />
        <Gradient
          id={ids.green}
          x1={244}
          x2={418}
          stops={[
            { offset: "0%", color: "--mw-wave-green", opacity: 0 },
            { offset: "15%", color: "--mw-wave-green" },
            { offset: "70%", color: "--mw-wave-emerald", opacity: 0.85 },
            { offset: "100%", color: "--mw-wave-emerald", opacity: 0 },
          ]}
        />
        <Gradient
          id={ids.m}
          x1={197}
          x2={244}
          stops={[
            { offset: "0%", color: "--mw-wave-m" },
            { offset: "50%", color: "--mw-wave-blue" },
            { offset: "100%", color: "--mw-wave-m" },
          ]}
        />
        <Gradient
          id={ids.w}
          x1={259}
          x2={306}
          stops={[
            { offset: "0%", color: "--mw-wave-w" },
            { offset: "50%", color: "--mw-wave-green" },
            { offset: "100%", color: "--mw-wave-emerald" },
          ]}
        />
      </defs>
      <path d={BLUE_WAVE} stroke={`url(#${ids.blue})`} strokeWidth={4.8} {...STROKE} />
      <path d={GREEN_WAVE} stroke={`url(#${ids.green})`} strokeWidth={4.8} {...STROKE} />
      <path d={M_HIGHLIGHT} stroke={`url(#${ids.m})`} strokeWidth={6.4} {...STROKE} />
      <path d={W_HIGHLIGHT} stroke={`url(#${ids.w})`} strokeWidth={6.4} {...STROKE} />
    </svg>
  );
}
