import * as React from "react"
import { cn } from "cn"

/**
 * The brand's panel: the raised surface with a hairline edge, a 14px
 * radius and no shadow. A Card groups one thing (a member list, a key, a
 * plan); its header carries a short title and any actions, its footer the
 * card's own buttons.
 *
 *   <Card>
 *     <CardHeader>
 *       <CardTitle>2 people</CardTitle>
 *       <CardAction><SearchInput aria-label="Filter members" /></CardAction>
 *     </CardHeader>
 *     <CardContent>...</CardContent>
 *   </Card>
 *
 * `Section` is the titled block a page is made of: a display-face title, an
 * optional standfirst, then its content, with no box of its own.
 */

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({
  className,
  as: Heading = "h2",
  ...props
}: React.ComponentProps<"h2"> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Heading
      data-slot="card-title"
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-mw-text-subtle", className)}
      {...props}
    />
  )
}

/** Pinned to the header's trailing edge. */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("ml-auto flex items-center gap-2", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 py-4", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex flex-wrap items-center gap-2 border-t border-border px-5 py-3.5", className)}
      {...props}
    />
  )
}

function Section({
  title,
  description,
  actions,
  className,
  children,
  headingLevel = 2,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  headingLevel?: 2 | 3
}) {
  const id = React.useId()
  const Heading = headingLevel === 2 ? "h2" : "h3"
  return (
    <section
      data-slot="section"
      aria-labelledby={`${id}-title`}
      className={cn("flex flex-col gap-3.5", className)}
      {...props}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <Heading id={`${id}-title`} className="font-display text-display-sm text-foreground">
            {title}
          </Heading>
          {description && <p className="mt-1 text-sm text-mw-text-subtle">{description}</p>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Section }
