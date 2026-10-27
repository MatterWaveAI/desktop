import type { CommandSpec } from "./commands";
import { optionId } from "./useCommandMenu";

/**
 * The slash-command popover over the composer: the commands that match
 * what has been typed, one highlighted. The textarea keeps focus and drives
 * it through `aria-activedescendant` (the pattern the shell's palette
 * uses), so the arrow keys never leave the box and a screen reader hears
 * the highlighted command. A tap or click on a row picks it too, for a
 * phone with no arrow keys; `onMouseDown` prevents the blur that would
 * otherwise close the list before the click lands.
 */

export function CommandMenu(props: {
  id: string;
  options: readonly CommandSpec[];
  activeIndex: number;
  onPick: (command: CommandSpec) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul
      id={props.id}
      role="listbox"
      aria-label="Commands"
      data-mw-command-menu=""
      className="absolute bottom-full left-0 right-0 z-10 mx-auto mb-2 w-full max-w-3xl rounded-lg border border-mw-border bg-mw-surface-raised p-1 shadow-lg"
    >
      {props.options.map((command, index) => (
        <li
          key={command.name}
          id={optionId(props.id, command)}
          role="option"
          aria-selected={index === props.activeIndex}
          className={`flex cursor-pointer items-baseline gap-3 rounded-md px-3 py-2 text-sm ${
            index === props.activeIndex ? "bg-mw-surface-hover" : ""
          }`}
          onMouseDown={(event) => {
            // Keep the textarea focused: a blur here would close the menu
            // before the click arrives.
            event.preventDefault();
            props.onPick(command);
          }}
          onMouseEnter={() => props.onHover(index)}
        >
          <span className="font-mono">/{command.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-mw-text-muted">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
