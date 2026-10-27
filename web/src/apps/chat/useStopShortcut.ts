import { useKeyboardShortcuts } from "../../shell/useKeyboardShortcuts";

/**
 * Esc stops the answer being written, from anywhere on the chat page.
 *
 * The same listener the shell installs, with only the `stop` handler, and
 * only while a turn is in flight: with no handler the key is left alone, so
 * an idle page keeps the browser's own Esc. A dialog, the command palette or
 * the composer's slash menu that is open claims the key first -- each
 * prevents the default on its way to closing -- and the listener skips a
 * press something nearer has already acted on.
 */
export function useStopShortcut(running: boolean, cancel: () => void): void {
  useKeyboardShortcuts({ stop: running ? cancel : undefined });
}
