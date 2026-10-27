import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "cn"

/**
 * A notice inside the page: info (blue), success (emerald), warning (amber)
 * and danger (red), each a tinted fill with its own hairline edge, a title
 * in the strong tone and copy in the body tone (pairs tokens.test.ts holds
 * at 4.5:1 in both themes). An optional action sits on the trailing edge,
 * and wraps under the copy on a phone.
 *
 *   <Alert variant="warning" title="2 of 1 seat in use"
 *     action={<Button>Add seats</Button>}>
 *     Invites are paused until a seat is free.
 *   </Alert>
 *
 * It announces nothing by itself: a notice that appears after an action
 * should pass `role="status"` (or `role="alert"` for a failure), one that is
 * part of the page on load should not.
 */
const alertVariants = cva(
  "flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border px-5 py-4 text-sm",
  {
    variants: {
      variant: {
        info: "border-mw-info-border bg-mw-info-subtle text-foreground",
        success: "border-mw-positive-border bg-mw-positive-subtle text-foreground",
        warning: "border-mw-warning-border bg-mw-warning-subtle text-mw-warning-body",
        danger: "border-mw-danger-border bg-mw-danger-subtle text-foreground",
      },
    },
    defaultVariants: { variant: "info" },
  }
)

const TITLE_TONE = {
  info: "text-mw-info",
  success: "text-mw-positive",
  warning: "text-mw-warning-foreground",
  danger: "text-mw-danger",
} as const

const ICONS = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  danger: CircleAlertIcon,
} as const

function Alert({
  variant = "info",
  title,
  action,
  icon = true,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof alertVariants> & {
    title?: React.ReactNode
    action?: React.ReactNode
    /** The variant's icon before the copy; false leaves it out. */
    icon?: boolean
  }) {
  const tone = variant ?? "info"
  const Icon = ICONS[tone]
  return (
    <div data-slot="alert" data-variant={tone} className={cn(alertVariants({ variant }), className)} {...props}>
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        {icon && <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TITLE_TONE[tone])} />}
        <div className="flex min-w-0 flex-col gap-1">
          {title && <p className={cn("font-semibold", TITLE_TONE[tone])}>{title}</p>}
          {children && <div data-slot="alert-description">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * A meter for a notice or a card: how much of a limit is used. The fill is
 * the variant's strong tone on its track; the number belongs in the text
 * beside it, so the bar itself is decorative.
 */
const METER_TONES = {
  brand: { track: "bg-mw-surface-active", fill: "bg-mw-brand-strong" },
  positive: { track: "bg-mw-surface-active", fill: "bg-mw-positive-strong" },
  warning: { track: "bg-mw-warning-track", fill: "bg-mw-warning-strong" },
  danger: { track: "bg-mw-surface-active", fill: "bg-mw-danger-strong" },
} as const

function Meter({
  value,
  tone = "brand",
  className,
}: {
  /** 0-100; clamped. */
  value: number
  tone?: keyof typeof METER_TONES
  className?: string
}) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      aria-hidden
      data-slot="meter"
      className={cn("h-1.5 w-full overflow-hidden rounded-full", METER_TONES[tone].track, className)}
    >
      <div className={cn("h-full rounded-full", METER_TONES[tone].fill)} style={{ width: `${pct}%` }} />
    </div>
  )
}

export { Alert, Meter, alertVariants }
