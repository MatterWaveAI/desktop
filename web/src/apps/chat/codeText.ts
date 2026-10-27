/**
 * What a fenced block's text is once it is worth drawing.
 *
 * The fence's trailing newline goes, as does the indent every line shares:
 * a model that writes its code block four spaces in, or pads one line with
 * a run of spaces before the only word, produced a card whose content sat
 * off the right edge of the scroller and read as an empty box. Relative
 * indentation is kept, so Python stays Python. Lines that are only
 * whitespace do not count towards the shared indent, and a block with no
 * text at all comes back empty, which is the caller's cue to draw nothing.
 */
export function trimCodeBlock(text: string): string {
  const body = text.replace(/\n$/, "");
  if (body.trim() === "") return "";
  const lines = body.split("\n");
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (lead < indent) indent = lead;
  }
  if (!Number.isFinite(indent) || indent === 0) {
    return lines.map((line) => line.trimEnd()).join("\n");
  }
  return lines.map((line) => line.slice(Math.min(indent, line.length)).trimEnd()).join("\n");
}
