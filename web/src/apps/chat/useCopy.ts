import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard";

/** How long a Copy control reads "Copied" before it offers Copy again. */
export const COPIED_FOR_MS = 2000;

/**
 * One Copy control's state: `copy(text)` writes to the clipboard and
 * `copied` is true for two seconds afterwards, which is what the control's
 * label shows. A write that fails leaves `copied` false, so the label never
 * claims a copy that did not happen.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_FOR_MS);
  }, []);

  return { copied, copy };
}
