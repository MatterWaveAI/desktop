import { Skeleton } from "../components/ui/skeleton";

/**
 * Content-shaped placeholder: the rows echo the layout that will appear, so
 * the page does not jump when data lands. Announced as busy via the
 * screen-reader text; the bars themselves are aria-hidden decoration.
 */
export function LoadingSkeleton(props: { rows?: number; className?: string }) {
  const rows = Math.max(1, props.rows ?? 3);
  return (
    <div role="status" className={`flex flex-col gap-3 p-4 ${props.className ?? ""}`}>
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton
            key={index}
            className={`h-4 ${index === rows - 1 && rows > 1 ? "w-2/3" : "w-full"}`}
          />
        ))}
      </div>
    </div>
  );
}
