import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface PaneTab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Sub-sections inside one settings pane. A plain tab strip rather than
 * components/ui/tabs because that one is styled with the shadcn palette and
 * wraps nothing at phone width; this one keeps one row that scrolls sideways.
 *
 * A panel is mounted the first time its tab is opened and only hidden after
 * that: a half-typed name survives a look at another tab, and a section that
 * loads its own data (the audit trail) is not fetched until someone asks.
 */
export function SectionTabs(props: { label: string; tabs: readonly PaneTab[] }) {
  const baseId = useId();
  const [active, setActive] = useState(props.tabs[0]?.id ?? "");
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([active]));
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  function select(id: string, focus = false) {
    setActive(id);
    setVisited((seen) => (seen.has(id) ? seen : new Set([...seen, id])));
    if (focus) tabRefs.current.get(id)?.focus();
  }

  // Arrow keys move along the strip and select as they go, Home and End
  // jump to the ends: the tabs pattern a screen-reader user expects.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = props.tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : event.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    select(props.tabs[next].id, true);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="tablist"
        aria-label={props.label}
        className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:thin]"
      >
        {props.tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:bg-mw-surface-hover focus-visible:ring-2 focus-visible:ring-mw-focus focus-visible:ring-inset ${
                selected
                  ? "border-mw-accent font-medium text-mw-text"
                  : "border-transparent text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {props.tabs.map((tab) =>
        visited.has(tab.id) ? (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${baseId}-panel-${tab.id}`}
            aria-labelledby={`${baseId}-tab-${tab.id}`}
            hidden={tab.id !== active}
            className="flex min-w-0 flex-col gap-4"
          >
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
