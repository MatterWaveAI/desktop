import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * The element in the shell's header row where the page on screen puts its
 * own controls -- the chat's model pill, Share and conversation menu -- so
 * the title and the controls that act on it are one row, not a header with
 * a second header under it. Null outside the shell (a test that mounts the
 * page alone) and on a phone, where the page draws its controls in a row of
 * its own: one row there would leave the title no room at all.
 */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

export function useHeaderSlot(): HTMLElement | null {
  return useContext(HeaderSlotContext);
}

/** Tailwind's `md` breakpoint, where the sidebar stops being a drawer. */
export const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(DESKTOP_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/** Whether the viewport is at least `md`, kept current as it resizes. */
export function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
