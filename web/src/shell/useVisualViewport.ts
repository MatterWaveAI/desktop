import { useEffect, useSyncExternalStore } from "react";

/**
 * The on-screen keyboard, as far as the layout is concerned.
 *
 * The problem this exists for: `100vh`, `100dvh`, `100svh` and `100lvh` ALL
 * ignore the virtual keyboard. The CSS spec treats it as an overlay that
 * shrinks the *visual* viewport and leaves the *layout* viewport — the thing
 * those units measure — untouched. A bottom-anchored composer in a
 * `height: 100dvh` column therefore sits behind the keyboard.
 *
 * The platforms then diverge, which is the whole difficulty:
 *
 * - **Android/Chromium** can be told to resize the layout viewport instead,
 *   with `interactiveWidget=resizes-content` in the viewport meta. With that
 *   set, `dvh` is correct and `window.resize` fires.
 * - **iOS/Safari** ignores that key. The visual viewport shrinks and scrolls,
 *   `visualViewport` fires `resize` and `scroll` — and **`window.resize` does
 *   not fire at all**. A handler on `window` silently does nothing on the
 *   platform that most needs it.
 *
 * So the source of truth is `visualViewport`, published as `--vvh` for CSS to
 * size the app shell with. `100dvh` stays the no-JS fallback in styles.css.
 */

/** Publish `visualViewport.height` as `--vvh` on <html>. */
export function useVisualViewportFix(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--vvh");
    };
  }, []);
}

/**
 * Subscribe to visual-viewport geometry changes.
 *
 * Exported separately from the `--vvh` writer because the two have different
 * consumers: the writer is shell-wide and runs once, while this is for a
 * component that must *react* to the keyboard — the transcript re-pinning
 * itself to the bottom is the case that matters.
 *
 * `scroll` as well as `resize`: on iOS the keyboard both shrinks the visual
 * viewport and scrolls it, and a handler that listens only for `resize`
 * misses the second half.
 */
export function subscribeToViewport(onChange: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) {
    // No visualViewport (old browser, jsdom): window.resize is all there is.
    // It is wrong on iOS, but a browser without visualViewport is not iOS.
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
  }
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  return () => {
    vv.removeEventListener("resize", onChange);
    vv.removeEventListener("scroll", onChange);
  };
}

/**
 * The visual viewport's current height, re-read whenever it changes.
 *
 * Rounded to whole pixels: iOS reports fractional heights that jitter by
 * hundredths during the keyboard animation, and an unrounded value would
 * re-render the subscriber on every frame of it.
 */
export function useViewportHeight(): number {
  return useSyncExternalStore(
    subscribeToViewport,
    () => Math.round(window.visualViewport?.height ?? window.innerHeight),
    () => 0,
  );
}
