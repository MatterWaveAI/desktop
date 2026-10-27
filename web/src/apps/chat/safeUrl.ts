/**
 * URL policy for model-authored content.
 *
 * Model output is untrusted input. Every href and src in a rendered message
 * passes through here before it reaches the DOM, so the allowlist is the one
 * place to audit rather than a check repeated per component.
 */

/** Links: http, https, mailto, tel. Everything else - javascript:, data:,
 *  vbscript:, file: - is dropped. */
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Images are fetched by the browser on render, with no click required, so a
 *  model-supplied URL is an exfiltration channel: the fetch itself leaks that
 *  the message was viewed, plus the viewer's IP and headers. Only our own
 *  origin is allowed. data: is refused outright - it bypasses any origin
 *  check and can carry SVG, which is script. */
const IMAGE_ORIGINS = new Set<string>([
  // Same-origin only. A CDN goes here when one exists; the intended end
  // state is a server-side proxy so the browser never fetches a
  // model-supplied URL directly.
  typeof location === "undefined" ? "" : location.origin,
]);

export function safeLinkUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, location.href);
    return LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function safeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Refused before parsing: a data: URL has no origin to check against.
  if (/^\s*data:/i.test(url)) return undefined;
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return IMAGE_ORIGINS.has(parsed.origin) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
