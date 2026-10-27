/**
 * Rendering a search snippet.
 *
 * The API marks the match with `[[` and `]]` rather than `<b>`: the snippet
 * crosses the wire as text and is rendered here as text, so a delimiter that
 * is not HTML cannot become an injection vector if a future renderer forgets
 * to escape it. These two constants are the SPA half of that contract —
 * `SNIPPET_OPEN`/`SNIPPET_CLOSE` in api/matterwave/store.py are the other.
 * Change one and you change both.
 */
export const SNIPPET_OPEN = "[[";
export const SNIPPET_CLOSE = "]]";

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Split a snippet into plain and highlighted runs, for React to render as
 * text nodes and `<mark>` elements. Never returns HTML.
 *
 * Postgres emits one `StartSel`/`StopSel` pair per highlighted term and may
 * emit several in one fragment, so this loops rather than splitting once. An
 * unterminated or stray delimiter is treated as ordinary text: a snippet that
 * renders oddly is better than one that renders as nothing.
 */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const open = rest.indexOf(SNIPPET_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(SNIPPET_CLOSE, open + SNIPPET_OPEN.length);
    if (close === -1) break;

    if (open > 0) parts.push({ text: rest.slice(0, open), match: false });
    const marked = rest.slice(open + SNIPPET_OPEN.length, close);
    if (marked) parts.push({ text: marked, match: true });
    rest = rest.slice(close + SNIPPET_CLOSE.length);
  }

  if (rest.length > 0) parts.push({ text: rest, match: false });
  return parts;
}
