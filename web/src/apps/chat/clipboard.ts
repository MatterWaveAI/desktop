/**
 * The clipboard, behind one check.
 *
 * `navigator.clipboard` is absent in an insecure context (plain http on a LAN
 * address, which is how the kind cluster is reached) and in older WebViews,
 * and `writeText` rejects when the document is not focused. Every Copy
 * control asks `clipboardAvailable()` before it renders, so a browser that
 * cannot copy shows no button rather than one that fails; `copyText` turns a
 * rejection into `false` so a click handler never throws.
 */

export function clipboardAvailable(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function"
  );
}

export async function copyText(text: string): Promise<boolean> {
  if (!clipboardAvailable()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
