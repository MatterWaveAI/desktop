import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The settings header's action slot. SettingsPage owns the element (to the
 * right of the pane's title) and provides it here; a pane renders its
 * primary action through `PaneActions` and it lands in the header.
 */
export const PaneActionsSlot = createContext<HTMLElement | null>(null);

/**
 * A pane's primary action, shown at the top right of the page beside the
 * pane's title. Rendered without the page around it -- a pane test mounts
 * the pane alone -- it falls back to rendering in place, so the control is
 * still there to find and press.
 */
export function PaneActions(props: { children: ReactNode }) {
  const slot = useContext(PaneActionsSlot);
  if (!slot) return <div className="flex flex-wrap items-center justify-end gap-2">{props.children}</div>;
  return createPortal(props.children, slot);
}
