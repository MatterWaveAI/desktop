import { useEffect, useState } from "react";
import { codeToHtml } from "../../styles/shiki";
import { clipboardAvailable } from "./clipboard";
import { useCopy } from "./useCopy";

/**
 * Shiki renders the code; the only HTML ever injected is shiki's own escaped
 * output. Model text itself is never rendered as HTML (Markdown.tsx owns the full
 * rendering policy).
 *
 * The header above the body names the language -- as written in the fence,
 * lower-cased, `text` when the fence had none -- and copies the raw source.
 * The source, not the highlighted HTML: a paste into an editor wants the code
 * the model wrote, and shiki's spans would arrive as markup.
 */
export function ShikiCode({ code, language }: { code: string; language: string }) {
  const lang = language.toLowerCase();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang })
      .then((rendered) => {
        if (alive) setHtml(rendered);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  return (
    <div
      className="my-3 overflow-hidden rounded-lg border border-mw-border text-xs leading-relaxed"
      data-mw-code-block
    >
      <CodeHeader language={lang} code={code} />
      {html === null ? (
        <pre className="m-0 overflow-x-auto bg-mw-surface-hover p-3">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="overflow-x-auto [&>pre]:m-0 [&>pre]:bg-transparent [&>pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function CodeHeader({ language, code }: { language: string; code: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex items-center justify-between gap-2 border-b border-mw-border bg-mw-surface-raised px-3 py-1 text-mw-text-muted">
      <span className="font-mono" data-mw-code-language>
        {language}
      </span>
      {/* No clipboard API, no button: a Copy that cannot copy is worse than none. */}
      {clipboardAvailable() && (
        <button
          type="button"
          aria-label="Copy code"
          aria-live="polite"
          onClick={() => void copy(code)}
          className="rounded px-1.5 py-0.5 hover:bg-mw-surface-hover hover:text-mw-text"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
