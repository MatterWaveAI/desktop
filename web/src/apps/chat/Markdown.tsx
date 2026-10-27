import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex, { type Options as KatexOptions } from "rehype-katex";
import "katex/dist/katex.min.css";
import { ShikiCode } from "./CodeBlock";
import { trimCodeBlock } from "./codeText";
import { MarkdownErrorBoundary } from "./MarkdownErrorBoundary";
import { safeImageUrl, safeLinkUrl } from "./safeUrl";

/**
 * Markdown rendering is a security boundary. Model output is untrusted
 * input, and every decision here is a deliberate refusal:
 *
 * - **`rehype-raw` is NOT enabled, and must not be.** It parses raw HTML out of
 *   the markdown, which hands a model `<script>`, `<iframe>` and every event
 *   handler attribute. If raw HTML ever becomes genuinely necessary (the usual
 *   request is `<details>`), `rehype-sanitize` with the GitHub schema has to run
 *   AFTER it in the plugin list - a later plugin can reintroduce what an earlier
 *   one removed.
 * - **URLs go through an allowlist** (`./safeUrl`): `javascript:` and `data:`
 *   never reach the DOM, and images are same-origin only, because the browser
 *   fetches them on render with no click - a model-supplied image URL is an
 *   exfiltration channel that fires just by viewing the message.
 * - **No `dangerouslySetInnerHTML` anywhere in this file.**
 *
 * Mermaid is deliberately not shipped: it renders model-authored text into SVG,
 * and SVG is script. KaTeX renders TeX with `trust: false`, so `\href`,
 * `\url` and `\includegraphics` stay off: it emits its own spans, never a
 * link or an image from model text, and a malformed formula shows as its
 * source in the error colour rather than throwing.
 */

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

const components = {
  a({ children, href }: { children?: ReactNode; href?: string }) {
    const safe = safeLinkUrl(href);
    // A link whose protocol was refused renders as text, not as a dead anchor:
    // the reader still sees what the model wrote, without a clickable target.
    if (!safe) return <span>{children}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline underline-offset-2"
      >
        {children}
      </a>
    );
  },

  img({ src, alt }: { src?: string | Blob; alt?: string }) {
    const raw = typeof src === "string" ? src : undefined;
    const safe = safeImageUrl(raw);
    if (safe) {
      return (
        <img
          src={safe}
          alt={alt ?? ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="max-w-full rounded-md"
        />
      );
    }
    // Step 5: an off-origin image is not silently dropped - the URL is shown as
    // text with an explicit click-through, so the reader decides whether to
    // fetch it. Nothing loads until they do.
    if (!raw) return null;
    return (
      <span className="inline-flex flex-col gap-1 rounded-md border border-mw-border bg-mw-surface-raised p-2 text-xs">
        <span className="text-mw-text-muted">
          Image not shown: it is hosted outside this app.
        </span>
        <span className="break-all font-mono">{raw}</span>
        {safeLinkUrl(raw) && (
          <a
            href={safeLinkUrl(raw)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2"
          >
            Open it in a new tab
          </a>
        )}
      </span>
    );
  },

  code({ className, children }: { className?: string; children?: ReactNode }) {
    const text = nodeText(children);
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!language && !text.includes("\n")) {
      return <code className="rounded bg-mw-surface-hover px-1 py-0.5 text-xs">{text}</code>;
    }
    // A fence with nothing in it, or one that is a line of a thousand
    // spaces with a word at the end, drew a card that looked empty: the
    // common indent goes, and a block with no text left draws nothing.
    const code = trimCodeBlock(text);
    if (code === "") return null;
    return <ShikiCode code={code} language={language ?? "text"} />;
  },

  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
};

const KATEX_OPTIONS: KatexOptions = {
  trust: false,
  strict: "ignore",
  // A formula cannot set a size that blows the message box open.
  maxSize: 10,
  maxExpand: 1000,
};
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: [[typeof rehypeKatex, KatexOptions]] = [[rehypeKatex, KATEX_OPTIONS]];

/** Renders one message's markdown. Untrusted input: see the note above. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <MarkdownErrorBoundary fallbackText={text}>
      <div className="prose-mw max-w-full text-sm leading-relaxed">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          /* KaTeX only. No rehype-raw: see the note at the top of this file. */
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}
