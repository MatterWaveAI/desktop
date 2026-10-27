import * as React from "react"
import { cn } from "cn"

/**
 * A data table. The wrapper scrolls sideways so a wide table never drags the
 * page with it (1.4.10 reflow); cells do not wrap by default, which is what
 * makes the scroll useful rather than a column of one-word lines. Give a
 * cell `className="whitespace-normal"` for free text.
 *
 * While the table is wider than its wrapper, the wrapper takes a Tab stop
 * (and becomes a region named after the table) so the hidden columns can be
 * scrolled into view with the arrow keys: a table of plain text has nothing
 * else focusable, and a mouse-only scroll is a WCAG 2.1.1 failure (axe
 * `scrollable-region-focusable`). A table that fits adds no Tab stop.
 *
 *   <Table aria-label="Members">
 *     <TableHeader><TableRow><TableHead>Name</TableHead></TableRow></TableHeader>
 *     <TableBody><TableRow><TableCell>Ada</TableCell></TableRow></TableBody>
 *   </Table>
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrolls = useOverflowsX(containerRef)
  const label = props["aria-label"]
  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls && label ? "region" : undefined}
      aria-label={scrolls && label ? label : undefined}
      className="relative w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

/** Whether the element is wider inside than out, re-measured as either side resizes. */
function useOverflowsX(ref: React.RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [ref])
  return overflows
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-mw-surface [&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-2 align-middle whitespace-nowrap", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-3 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
