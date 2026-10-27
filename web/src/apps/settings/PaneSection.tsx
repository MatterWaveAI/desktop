import { type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { EmptyState } from "../../patterns";

/**
 * One titled block inside a pane: the brand's panel -- a raised surface,
 * a hairline edge, no shadow -- with its title (and one short line under
 * it) in a header strip and its content below. Panes are made of these so
 * a feature landing later adds a section rather than redesigning the pane.
 *
 * `actions` sit on the header's trailing edge (a filter, a small button).
 * `flush` drops the body's padding for content that runs edge to edge, a
 * `RowList` of people or keys. `tone="danger"` is a danger zone: the red
 * notice's tint and edge rather than the neutral panel.
 */
export function PaneSection(props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  tone?: "default" | "danger";
  id?: string;
  className?: string;
  /** h2 under a pane's h1; h3 for a section nested inside another heading. */
  headingLevel?: 2 | 3;
  children?: ReactNode;
}) {
  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const danger = props.tone === "danger";
  return (
    <section
      id={props.id}
      data-slot="pane-section"
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border",
        danger ? "border-mw-danger-border bg-mw-danger-subtle" : "border-border bg-card text-card-foreground",
        props.className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5",
          props.children ? "border-b" : undefined,
          danger ? "border-mw-danger-border" : "border-border",
        )}
      >
        <div className="min-w-0 flex-1 basis-60">
          <Heading className={cn("text-base font-semibold", danger && "text-mw-danger")}>
            {props.title}
          </Heading>
          {props.description && <div className="mt-0.5 text-sm text-mw-text-subtle">{props.description}</div>}
        </div>
        {props.actions && <div className="ml-auto flex flex-wrap items-center gap-2">{props.actions}</div>}
      </div>
      {props.children && <div className={props.flush ? "min-w-0" : "min-w-0 px-5 py-4"}>{props.children}</div>}
    </section>
  );
}

/**
 * The detail a one-line description used to spell out, one click away:
 * a disclosure that reads "Learn more" until opened.
 */
export function LearnMore(props: { children: ReactNode; label?: string; className?: string }) {
  return (
    <details className={cn("group text-sm text-mw-text-subtle", props.className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-mw-link outline-none select-none hover:text-mw-link-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        {props.label ?? "Learn more"}
      </summary>
      <div className="mt-2 flex flex-col gap-2">{props.children}</div>
    </details>
  );
}

/**
 * A pane whose feature has not landed renders this, not a 404. It names
 * what is coming so the placeholder reads as a commitment rather than a gap.
 */
export function PendingPane(props: { what: string }) {
  return (
    <EmptyState
      title="Coming soon"
      description={`${props.what} is not built yet. This pane is where it will live; until then there is nothing here to change.`}
    />
  );
}
