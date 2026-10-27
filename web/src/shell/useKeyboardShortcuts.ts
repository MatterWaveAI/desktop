import { useEffect, useRef } from "react";
import { isMacPlatform, matchShortcut, type ShortcutId } from "./shortcuts";

/**
 * Install the global shortcuts for as long as the caller is mounted.
 *
 * One `keydown` listener on the window, matched against `SHORTCUTS`; the
 * handlers are read through a ref so the listener is installed once and
 * still calls whatever the caller passed on its latest render. A shortcut
 * with no handler is left alone, so the browser keeps its own meaning for it.
 */
export function useKeyboardShortcuts(handlers: Partial<Record<ShortcutId, () => void>>): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      // Something nearer the key already acted on it (the composer's Enter,
      // an IME composing a character): not ours.
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = matchShortcut(event, mac);
      if (shortcut === null) return;
      const handler = handlersRef.current[shortcut.id];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
