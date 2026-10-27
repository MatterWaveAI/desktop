import type { ReactNode } from "react";

/**
 * The top of every full-page surface: one title, one optional standfirst,
 * optional actions pinned right. The title is the display face, as the
 * brand sets page titles; sizes come from the type scale. The admin surfaces
 * start here instead of an h1.
 */
export function PageHeader(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
      <div className="min-w-0">
        <h1 className="font-display text-display-md text-mw-text">{props.title}</h1>
        {props.description && (
          <p className="mt-1.5 max-w-2xl text-sm text-mw-text-subtle">{props.description}</p>
        )}
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
    </header>
  );
}
