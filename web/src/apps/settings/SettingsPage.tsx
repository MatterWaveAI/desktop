import { Link } from "@tanstack/react-router";
import { ErrorBoundary } from "../../components/AppError";
import { TabStrip, TabStripItem } from "../../components/ui/tab-strip";
import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { navItemVariants } from "../../components/ui/nav-item";
import { paneComponents } from "./paneComponents";
import { PaneActionsSlot } from "./paneActions";
import { SETTINGS_GROUPS, findPane, settingsPanes } from "./panes";

/**
 * The settings page. Not a settings *framework* — the slots an installed
 * app contributes through are a separate feature. This is the page and the
 * platform's own panes, which exist whether or not a second app ever
 * installs.
 *
 * Every pane is deep-linkable at `/settings/<id>`, so anything can link
 * straight at a pane, and every pane renders whether or not its feature
 * has landed.
 *
 * The nav is TanStack `Link`s. It used to be raw `<a href>`, on the
 * reasoning that a middle-click and a copy-link expect an anchor -- true,
 * but `Link` RENDERS an anchor with a real href, so it keeps both and adds
 * client-side navigation on a plain click.
 *
 * With raw anchors every tab switch was a full document load: a new request,
 * Boot refetching /api/auth-config and /api/me, and the whole React tree
 * remounting. The visible symptom is the page flashing white between tabs,
 * in what is supposed to be a single-page app.
 *
 * The nav is two layouts of one list, only one of them displayed at a time
 * (so assistive tech meets one landmark). On a phone it is the TabStrip: a
 * single row that scrolls sideways with the current tab kept in view --
 * twelve wrapped tabs took four rows before the pane began. The strip keeps
 * the side column's group headings as small overlines before each group's
 * first tab, so "Members" is read as the organisation's and a tab reached
 * mid-scroll still says whose settings it is. From `md` up it is a side
 * column grouped under headings, all twelve visible at once.
 *
 * The pane's title is the page's h1, in the display face, with one line
 * under it and the pane's primary action (if it has one, through
 * `PaneActions`) on the right -- the settings page has no title of its
 * own, the nav says where you are.
 *
 * Each pane sits in its own ErrorBoundary, keyed on the pane id, so one
 * pane crashing leaves the nav working and clears when you switch away.
 */
export function SettingsPage(props: { paneId?: string }) {
  const active = findPane(props.paneId);
  const Pane = paneComponents[active.id];
  // The header's action slot: a pane portals its primary action into it.
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);

  const link = (paneId: string) => (
    // The route PATTERN plus params, not an interpolated path: that is
    // what gives the typed router a checked link, so a renamed route
    // breaks the build instead of the page.
    <Link to="/settings/$paneId" params={{ paneId }} />
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full flex-col md:flex-row">
        <TabStrip aria-label="Settings sections" className="mx-4 mt-3 md:hidden">
          {/* One flat list, not fragments per group: the strip finds the
              active item among its direct children to scroll it into view. */}
          {settingsPanes.flatMap((pane, index) => [
            ...(index === 0 || settingsPanes[index - 1].group !== pane.group
              ? [
                  <span
                    key={`group-${pane.group}`}
                    aria-hidden="true"
                    data-slot="tab-strip-group"
                    className="shrink-0 self-center pr-1 pl-3 text-xs font-medium whitespace-nowrap text-mw-text-muted first:pl-1"
                  >
                    {pane.group}
                  </span>,
                ]
              : []),
            <TabStripItem key={pane.id} active={pane.id === active.id} render={link(pane.id)}>
              {pane.title}
            </TabStripItem>,
          ])}
        </TabStrip>

        <nav
          aria-label="Settings sections"
          data-layout="side"
          className="hidden w-60 shrink-0 border-r border-border bg-mw-surface-raised md:block lg:w-66"
        >
          <div className="sticky top-0 flex flex-col gap-5 px-3.5 py-5">
            <Link
              to="/"
              className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-sm text-mw-text-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeftIcon aria-hidden className="size-4" />
              Back to chat
            </Link>
            {SETTINGS_GROUPS.map((group) => (
              <div key={group} role="group" aria-label={group} className="flex flex-col gap-0.5">
                <p aria-hidden="true" className="px-2.5 pb-1.5 text-xs font-medium text-mw-text-muted">
                  {group}
                </p>
                {settingsPanes
                  .filter((pane) => pane.group === group)
                  .map((pane) => {
                    const selected = pane.id === active.id;
                    return (
                      <Link
                        key={pane.id}
                        to="/settings/$paneId"
                        params={{ paneId: pane.id }}
                        aria-current={selected ? "page" : undefined}
                        className={navItemVariants({ active: selected })}
                      >
                        {pane.title}
                      </Link>
                    );
                  })}
              </div>
            ))}
          </div>
        </nav>

        <section
          aria-labelledby="settings-pane-title"
          className="min-w-0 flex-1 px-4 pt-5 pb-12 md:px-8 md:pt-10 lg:px-12 lg:pt-11"
        >
          <div className="mx-auto flex w-full max-w-215 flex-col gap-7 md:mx-0">
            <header className="flex flex-wrap items-end gap-4">
              <div className="min-w-0">
                <h1
                  id="settings-pane-title"
                  className="font-display text-display-md text-foreground md:text-display-lg"
                >
                  {active.title}
                </h1>
                <p className="mt-1.5 text-mw-text-subtle">{active.description}</p>
              </div>
              <div
                ref={setActionsSlot}
                data-slot="pane-actions"
                className="ml-auto flex flex-wrap items-center gap-2 empty:hidden"
              />
            </header>
            <PaneActionsSlot.Provider value={actionsSlot}>
              <ErrorBoundary name={active.title} resetKeys={[active.id]}>
                {Pane && <Pane />}
              </ErrorBoundary>
            </PaneActionsSlot.Provider>
          </div>
        </section>
      </div>
    </div>
  );
}
