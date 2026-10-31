/**
 * The desktop dev pane's one gate. Dev build AND desktop shell: a pane that
 * only means something when there is a native side to ask and a `tauri dev`
 * (or any dev bundle) running it. In a release build `import.meta.env.DEV`
 * is false, so the pane does not exist there at all -- not hidden, absent
 * -- and the vitest environment (no Tauri globals) never sees it either.
 */
import { isDesktop } from "./desktopAuth";

export function desktopDevEnabled(): boolean {
  return isDesktop() && import.meta.env.DEV;
}
