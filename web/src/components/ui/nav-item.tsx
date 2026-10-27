import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva } from "class-variance-authority"
import { cn } from "cn"

/**
 * A row in a vertical nav (the sidebar, the settings and admin navs, the
 * conversation list). At rest it is the secondary text on nothing; hovered,
 * the hover fill; selected, the brand's selected style -- the navy
 * `selection` fill, its own foreground, and a 2px focus-blue bar on the
 * leading edge (`shadow-selected`, so the bar takes no layout).
 *
 * Renders an <a> by default; pass `render` for the router's Link:
 *
 *   <NavItem active={selected} render={<Link to="/settings/$paneId" params={...} />}>
 *     Members
 *   </NavItem>
 *
 * `active` sets `aria-current="page"` as well as the look, so the two never
 * disagree. `navItemVariants` is the class list alone, for a row whose
 * element is built elsewhere.
 */
const navItemVariants = cva(
  "flex min-h-9 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
  {
    variants: {
      active: {
        true: "bg-mw-selection font-medium text-mw-selection-foreground shadow-selected",
        false: "text-mw-text-secondary hover:bg-mw-surface-hover hover:text-foreground",
      },
    },
    defaultVariants: { active: false },
  }
)

function NavItem({
  active = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { active?: boolean }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(navItemVariants({ active }), className),
        "aria-current": active ? "page" : undefined,
      },
      props
    ),
    render,
    state: { slot: "nav-item", active },
  })
}

export { NavItem, navItemVariants }
