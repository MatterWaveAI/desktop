import * as React from "react"
import { cn } from "cn"

/**
 * A block that scrolls sideways inside itself, with the TabStrip's edge
 * fade: while there is more to the right (or the left) that edge fades
 * out, so a clipped column reads as "more this way" rather than as the end.
 * On a phone the plan comparison grid cut its last column off with nothing
 * to say so.
 *
 * While it scrolls it takes a Tab stop, as a region named after what it
 * holds, so the hidden part can be reached with the arrow keys (axe
 * scrollable-region-focusable); content that fits adds no Tab stop.
 */
function ScrollFade({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
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
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [measure])

  const scrolls = fade.start || fade.end
  return (
    <div
      ref={scroller}
      onScroll={measure}
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? label : undefined}
      data-fade-start={fade.start || undefined}
      data-fade-end={fade.end || undefined}
      className={cn(
        "mw-scroll-fade overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { ScrollFade }
