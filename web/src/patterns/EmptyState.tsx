import type { ReactNode } from "react";

/**
 * Nothing here yet. The pattern every list/detail surface needs: a centred
 * icon, a one-line title, at most one action. The chat surface composes this for its
 * empty states; apps use it instead of inventing their own centred div.
 */
export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {props.icon && (
        <span className="flex size-10 items-center justify-center rounded-full bg-mw-surface-hover text-mw-text-muted [&_svg]:size-5">
          {props.icon}
        </span>
      )}
      <p className="text-lg font-medium">{props.title}</p>
      {props.description && (
        <p className="max-w-md text-sm text-mw-text-muted">{props.description}</p>
      )}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  );
}
