import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * The brand's buttons. Primary is the action blue with white text; outline is
 * the secondary action, a hairline on the page; secondary is a quiet filled
 * one; ghost is an icon or toolbar button; destructive is the tinted danger
 * action, danger the solid one for the last step of a destructive flow.
 *
 * The focus ring is the brand's focus blue, offset by 2px of the page so it
 * still reads around a primary button of nearly the same blue.
 *
 * Disabled is a solid muted fill, not half opacity: half-opacity blue on a
 * near-black page read as a smudge (text about 2:1). text-muted on
 * surface-active is a pair tokens.test.ts holds at 4.5:1 in both themes.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg pointer-coarse:min-h-11 pointer-coarse:min-w-11 border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary font-semibold text-primary-foreground hover:bg-primary-hover disabled:bg-mw-surface-active disabled:text-mw-text-muted",
        outline:
          "border-border-emphasis bg-transparent text-foreground hover:bg-mw-surface-hover aria-expanded:bg-mw-surface-hover disabled:text-mw-text-muted",
        secondary:
          "border-border-emphasis bg-mw-surface-hover text-foreground hover:bg-mw-surface-active aria-expanded:bg-mw-surface-active disabled:text-mw-text-muted",
        ghost:
          "text-mw-text-secondary hover:bg-mw-surface-hover hover:text-foreground aria-expanded:bg-mw-surface-hover aria-expanded:text-foreground disabled:text-mw-text-muted",
        destructive:
          "border-mw-danger-border bg-mw-danger-subtle text-mw-danger hover:bg-mw-surface-active disabled:border-transparent disabled:bg-mw-surface-active disabled:text-mw-text-muted",
        danger:
          "bg-mw-danger-strong font-semibold text-mw-danger-foreground hover:bg-mw-danger-strong/90 disabled:bg-mw-surface-active disabled:text-mw-text-muted",
        link: "h-auto px-0 text-mw-link underline-offset-4 hover:text-mw-link-hover hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 rounded-md px-3 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 rounded-xl px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-9",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-11 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
