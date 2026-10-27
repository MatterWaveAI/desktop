import { useLayoutEffect, type RefObject } from "react";

/**
 * Grow a textarea with its text up to its CSS `max-height`, then scroll.
 *
 * `rows={1}` alone keeps the box one line tall however much is typed, so a
 * long message is written through a letterbox. The height is measured from
 * `scrollHeight` after resetting it, which is the only reading that also
 * shrinks the box when text is deleted; past the cap the box stops growing
 * and scrolls instead of pushing the transcript off the screen.
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    const cap = Number.parseFloat(getComputedStyle(box).maxHeight);
    const wanted = box.scrollHeight;
    const limited = Number.isFinite(cap) && cap > 0 && wanted > cap;
    // Nothing measured (a hidden box, a test DOM): leave the browser's own
    // one-row height rather than setting the box to 0px.
    if (wanted > 0) box.style.height = `${limited ? cap : wanted}px`;
    else box.style.removeProperty("height");
    box.style.overflowY = limited ? "auto" : "hidden";
  }, [ref, value]);
}
