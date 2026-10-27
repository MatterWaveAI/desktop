import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "cn"

/**
 * A row of section links -- settings panes, admin tabs -- that never wraps.
 * On a narrow screen it scrolls sideways inside itself, and a fade on the
 * clipped edge says there is more (`.mw-tabstrip` in styles.css). The
 * active item is scrolled into view on mount and whenever it changes, so a
 * deep link to the eighth pane does not open with its tab off-screen.
 *
 * Navigation, not a tablist: each item is a link to its own URL, marked
 * `aria-current="page"` when active. Render it as the router's Link:
 *
 *   <TabStrip aria-label="Settings">
 *     {panes.map((pane) => (
 *       <TabStripItem
 *         key={pane.id}
 *         active={pane.id === paneId}
 *         render={<Link to="/settings/$paneId" params={{ paneId: pane.id }} />}
 *       >
 *         {pane.title}
 *       </TabStripItem>
 *     ))}
 *   </TabStrip>
 */
function TabStrip({
  className,
  children,
  "aria-label": ariaLabel,
}: {
  className?: string
  children: React.ReactNode
  "aria-label": string
}) {
  const scroller = React.useRef<HTMLDivElement>(null)
  const [fade, setFade] = React.useState({ start: false, end: false })

  const measure = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    // One pixel of slack: fractional widths leave scrollLeft a hair short.
    const start = el.scrollLeft > 1
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [])

  React.useEffect(() => {
    const el = scroller.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  // Bring the active item into view, centred when it was off-screen so the
  // tabs on both sides of it (and a group label before it) are readable,
  // rather than pinned to the edge with its neighbour clipped to "ructions".
  // scrollLeft rather than scrollIntoView, which would also scroll the page
  // vertically to reach the strip.
  const activeKey = React.Children.toArray(children).findIndex(
    (child) => React.isValidElement<{ active?: boolean }>(child) && child.props.active
  )
  React.useEffect(() => {
    const el = scroller.current
    const item = el?.querySelector<HTMLElement>("[data-active]")
    if (!el || !item) return
    const left = item.offsetLeft
    const right = left + item.offsetWidth
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - (el.clientWidth - item.offsetWidth) / 2)
    }
    measure()
  }, [activeKey, measure])

  return (
    <nav aria-label={ariaLabel} data-slot="tab-strip" className={cn("border-b border-border", className)}>
      <div
        ref={scroller}
        onScroll={measure}
        data-fade-start={fade.start || undefined}
        data-fade-end={fade.end || undefined}
        className="mw-tabstrip flex flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden px-1"
      >
        {children}
      </div>
    </nav>
  )
}

function TabStripItem({
  className,
  active = false,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { active?: boolean }) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        className: cn(
          "relative inline-flex h-10 shrink-0 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-(length:--ring-width) focus-visible:ring-ring focus-visible:ring-inset",
          "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent",
          "data-active:text-foreground data-active:after:bg-mw-focus",
          className
        ),
      },
      props
    ),
    state: { slot: "tab-strip-item", active },
  })
}

export { TabStrip, TabStripItem }
