import { useState } from "react";
import { matchCommands, type CommandSpec } from "./commands";

/**
 * The state behind the composer's slash-command popover (`CommandMenu`):
 * which commands match the draft, which one is highlighted, and whether
 * the reader closed it. In its own file so the component file exports
 * only components, which is what fast refresh wants.
 */

export type CommandMenuState = {
  /** Open: at least one command matches and the reader has not closed it. */
  readonly open: boolean;
  readonly options: readonly CommandSpec[];
  readonly activeIndex: number;
  readonly active: CommandSpec | null;
  readonly move: (delta: number) => void;
  /** Close until the draft changes again (Escape). */
  readonly dismiss: () => void;
};

export function useCommandMenu(
  draft: string,
  filter: { compactable?: boolean } = {},
): CommandMenuState {
  const options = matchCommands(draft, filter);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Each keystroke is a new question: the highlight goes back to the top
  // and a dismissed list may open again for the next word. Reset during
  // render, keyed on the draft, rather than in an effect that would paint
  // the stale highlight first.
  const [seenDraft, setSeenDraft] = useState(draft);
  if (seenDraft !== draft) {
    setSeenDraft(draft);
    setDismissed(false);
    setActiveIndex(0);
  }
  const open = options.length > 0 && !dismissed;
  const index = Math.min(activeIndex, Math.max(options.length - 1, 0));
  return {
    open,
    options,
    activeIndex: index,
    active: open ? options[index] : null,
    move: (delta) =>
      setActiveIndex((current) => (current + delta + options.length) % Math.max(options.length, 1)),
    dismiss: () => setDismissed(true),
  };
}

/** The DOM id of a command's row, for `aria-activedescendant`. */
export function optionId(listId: string, command: CommandSpec): string {
  return `${listId}-${command.name}`;
}
