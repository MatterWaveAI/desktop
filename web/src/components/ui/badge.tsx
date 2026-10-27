import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Badges and pills: a short status or count beside the thing it describes.
 * `secondary` is the neutral pill ("You", a role); the status variants pair
 * a tinted fill with its own edge and text, each pair held at 4.5:1 by
 * tokens.test.ts. Put a `StatusDot` inside for a live/clean/failed marker.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-(length:--ring-width) focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
        secondary:
          "bg-mw-surface-active text-mw-text-secondary [a]:hover:text-foreground",
        destructive:
          "border-mw-danger-border bg-mw-danger-subtle text-mw-danger",
        positive:
          "border-mw-positive-border bg-mw-positive-subtle text-mw-positive",
        warning:
          "border-mw-warning-border bg-mw-warning-subtle text-mw-warning-foreground",
        info: "border-mw-info-border bg-mw-info-subtle text-mw-info",
        outline:
          "border-border-emphasis text-foreground [a]:hover:bg-mw-surface-hover",
        ghost:
          "text-mw-text-secondary hover:bg-mw-surface-hover",
        link: "text-mw-link underline-offset-4 hover:text-mw-link-hover hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * The small round status marker: emerald for live, clean or done, the focus
 * blue for in progress, amber for degraded, red for failed. Decorative --
 * the text beside it carries the meaning.
 */
const DOT_TONES = {
  positive: "bg-mw-positive-strong",
  info: "bg-mw-focus",
  warning: "bg-mw-warning-strong",
  danger: "bg-mw-danger",
  neutral: "bg-mw-text-muted",
} as const

function StatusDot({
  tone = "positive",
  className,
}: {
  tone?: keyof typeof DOT_TONES
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_TONES[tone], className)}
    />
  )
}

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, StatusDot, badgeVariants }
