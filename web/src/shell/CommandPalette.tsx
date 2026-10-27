import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import type { Conversation } from "../types";
import { groupRuns, paletteCommands, type PaletteAction, type PaletteCommand } from "./palette";

/**
 * The command palette: Mod+K, type, arrow, Enter.
 *
 * Keyboard-only by design. The dialog traps focus (Base UI's Dialog does
 * that, the same way the shortcuts overlay relies on it) and the input keeps
 * it: the list is an ARIA listbox the input controls through
 * `aria-activedescendant`, so arrowing through it never moves focus off the
 * field and a screen reader still announces the active option. Enter runs
 * it, Escape closes, and Tab stays inside the dialog.
 *
 * What it can do is `palette.ts`'s list; this component only draws it and
 * hands the chosen action back. A pointer works too -- an option is a
 * button -- but nothing here needs one.
 */
export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: Conversation[];
  onAction: (action: PaletteAction) => void;
}) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the palette is closing because a command ran. A command decides
  // where focus goes (the sidebar's search box, a settings pane), so the
  // dialog must not then put it back on whatever had it before Mod+K.
  const ranRef = useRef(false);
  const listId = useId();

  // The provider's i18n re-renders this on a locale change, so the list is
  // rebuilt with labels in the new language.
  const commands = useMemo(
    () => paletteCommands(query, props.conversations, i18n),
    [query, props.conversations, i18n],
  );
  // One heading per run of a group, not a word on every row: eight rows
  // each tagged "Conversations" said the same thing eight times, and the
  // tag was the first thing the eye landed on instead of the title.
  const sections = useMemo(() => groupRuns(commands), [commands]);

  // A fresh palette every time it opens: the last query and the last
  // selection are not what the person reaches for Mod+K to get back to.
  useEffect(() => {
    if (!props.open) return;
    ranRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
    setActive(0);
    // After the dialog's own focus handling has run.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.open]);

  // The list changed under the cursor (typing shortened it): keep the
  // active row on a row that exists.
  const activeIndex = Math.min(active, Math.max(commands.length - 1, 0));
  const activeCommand: PaletteCommand | undefined = commands[activeIndex];

  function run(command: PaletteCommand | undefined) {
    if (!command) return;
    ranRef.current = true;
    props.onOpenChange(false);
    props.onAction(command.action);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((commands.length ? (activeIndex + 1) % commands.length : 0));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((commands.length ? (activeIndex - 1 + commands.length) % commands.length : 0));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(Math.max(commands.length - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        run(activeCommand);
        break;
      case "Tab":
        // The input is the only control that takes focus; Tab must not
        // escape the dialog or land on the (focusable) options and leave
        // the typed query behind.
        event.preventDefault();
        break;
      default:
        break;
    }
  }

  /** The heading over a run of one group, in the reader's language. */
  function groupLabel(group: PaletteCommand["group"]): string {
    switch (group) {
      case "Actions":
        return t`Actions`;
      case "Conversations":
        return t`Conversations`;
      case "Settings":
        return t`Settings`;
      case "Help":
        return t`Help`;
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-mw-command-palette=""
        aria-label={t`Command palette`}
        finalFocus={() => !ranRef.current}
        className="top-[15%] translate-y-0 gap-2 p-2 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">
          <Trans>Command palette</Trans>
        </DialogTitle>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? `${listId}-${activeCommand.id}` : undefined}
          aria-label={t`Type a command or a conversation title`}
          placeholder={t`Type a command or a conversation title…`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-mw-border bg-mw-surface px-3 py-2 text-sm placeholder:text-mw-text-muted focus:border-mw-focus focus:outline-none"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={t`Commands`}
          className="max-h-80 overflow-y-auto"
        >
          {commands.length === 0 && (
            <li className="px-3 py-2 text-sm text-mw-text-muted" aria-live="polite">
              <Trans>Nothing matches.</Trans>
            </li>
          )}
          {sections.map((section) => (
            <li
              key={`${section.group}:${section.start}`}
              role="group"
              aria-labelledby={`${listId}-group-${section.start}`}
            >
              <div
                id={`${listId}-group-${section.start}`}
                className="px-3 pb-0.5 pt-2 text-xs font-medium uppercase tracking-wide text-mw-text-muted"
              >
                {groupLabel(section.group)}
              </div>
              <ul role="presentation">
                {section.commands.map((command, offset) => {
                  const index = section.start + offset;
                  return (
                    <li
                      key={command.id}
                      id={`${listId}-${command.id}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm ${
                        index === activeIndex ? "bg-mw-surface-hover" : ""
                      }`}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => {
                        // Run on press rather than click, so the input never
                        // loses focus between the two and the dialog's trap
                        // has nothing to put back.
                        event.preventDefault();
                        run(command);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <p className="px-3 pb-1 text-xs text-mw-text-muted">
          <Trans>
            <kbd className="font-mono">↑↓</kbd> to choose, <kbd className="font-mono">Enter</kbd> to
            run, <kbd className="font-mono">Esc</kbd> to close.
          </Trans>
        </p>
      </DialogContent>
    </Dialog>
  );
}
