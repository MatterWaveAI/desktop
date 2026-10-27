import { useState } from "react";
import type {
  DocumentPart,
  ImagePart,
  MessagePart,
  ToolCallPart,
  ToolResultPart,
} from "./chatAdapter";
import {
  isDocumentPart,
  isImagePart,
  isImportNotePart,
  isReasoningPart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
} from "./chatAdapter";
import { MarkdownText } from "./Markdown";
import { safeLinkUrl } from "./safeUrl";
import { MessageFeedback } from "./MessageFeedback";
import type { Feedback } from "./feedback";

/**
 * Renders one assistant message's ordered parts.
 *
 * The switch has an explicit default, and that default is the point: a part
 * kind this build has never heard of renders as a quiet placeholder rather
 * than throwing, so an older client does not crash on a message written by a
 * newer API. Adding a part type is then additive on both sides.
 *
 * Text still goes through `MarkdownText`, which is the security
 * boundary; nothing here renders model output any other way. Tool arguments
 * and tool output are rendered as plain text in a `<pre>` -- deliberately
 * NOT as markdown, because they are data the model or a tool produced and
 * there is no reason to give them link or image rendering.
 */
export function MessageParts(props: {
  parts: readonly MessagePart[];
  /**
   * Thumbs under the parts, for a stored assistant reply. Absent for a user
   * turn, a reply still streaming (no server id to rate yet) and the public
   * share page, which is read-only.
   */
  feedback?: {
    messageId: string;
    current: Feedback | null;
    onChange: (next: Feedback | null) => void;
  };
}) {
  // Results are matched to their call by id so a call renders with its own
  // output, not with whichever result happened to arrive next.
  const results = new Map<string, ToolResultPart>();
  for (const part of props.parts) {
    if (isToolResultPart(part)) results.set(part.id, part);
  }

  return (
    <>
      {props.parts.map((part, i) => {
        if (isTextPart(part)) {
          // An empty text part is a part the stream opened and has not filled
          // yet; rendering it would add a blank line to the transcript.
          if (part.text === "") return null;
          return <MarkdownText key={i} text={part.text} />;
        }
        if (isReasoningPart(part)) {
          return <ReasoningRow key={i} text={part.text} />;
        }
        if (isToolCallPart(part)) {
          return <ToolCallRow key={i} call={part} result={results.get(part.id)} />;
        }
        if (isImagePart(part)) {
          return <ImageRow key={i} part={part} />;
        }
        if (isDocumentPart(part)) {
          return <DocumentRow key={i} part={part} />;
        }
        if (isImportNotePart(part)) {
          return <ImportNoteRow key={i} text={part.text} />;
        }
        // A tool result is rendered inside its call's row, above.
        if (isToolResultPart(part)) return null;
        return <UnknownRow key={i} kind={part.type} />;
      })}
      {props.feedback !== undefined && (
        <MessageFeedback
          messageId={props.feedback.messageId}
          current={props.feedback.current}
          onChange={props.feedback.onChange}
        />
      )}
    </>
  );
}

/** A collapsed disclosure row: the shape every non-text part uses. */
function Disclosure(props: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <div className="my-2 rounded-lg border border-mw-border text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-mw-text-muted hover:text-mw-text"
      >
        <span aria-hidden="true" className="text-xs">
          {open ? "▾" : "▸"}
        </span>
        {props.summary}
      </button>
      {open && <div className="border-t border-mw-border px-3 py-2">{props.children}</div>}
    </div>
  );
}

/** One cited source from a `web_search` result. */
type SearchSource = { readonly title: string; readonly url: string; readonly snippet: string };

/**
 * The sources in a `web_search` tool result, or undefined if this is not one.
 *
 * Every field is checked for being a string rather than cast. The output is
 * a string the server built from third-party data, and a renderer that
 * assumed the shape would render `undefined` -- or throw -- the first time a
 * provider, a cache entry or a stored row from an older build disagreed.
 * Returning undefined falls back to the generic `<pre>`, which shows the
 * user what actually arrived instead of an empty list.
 */
function searchSources(name: string, result: ToolResultPart): readonly SearchSource[] | undefined {
  if (name !== "web_search" || result.is_error) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rows = (parsed as { results?: unknown }).results;
  if (!Array.isArray(rows)) return undefined;
  const sources: SearchSource[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { title, url, snippet } = row as Record<string, unknown>;
    if (typeof url !== "string") continue;
    sources.push({
      title: typeof title === "string" && title !== "" ? title : url,
      url,
      snippet: typeof snippet === "string" ? snippet : "",
    });
  }
  // A search that ran and found nothing is not a citation list: fall back to
  // the raw result so the user can see it returned zero rows.
  return sources.length > 0 ? sources : undefined;
}

function ToolCallRow(props: { call: ToolCallPart; result?: ToolResultPart }) {
  const { call, result } = props;
  const sources = result === undefined ? undefined : searchSources(call.name, result);
  return (
    <Disclosure
      // Sources open by default, every other tool collapsed. A citation the
      // user has to go looking for is one they will not check, which is the
      // whole point of showing it; a tool's raw arguments are
      // diagnostics and stay out of the way.
      defaultOpen={sources !== undefined}
      summary={
        <span className="flex flex-1 items-center gap-2">
          <span>
            {sources === undefined ? (
              <>
                Called <code className="font-mono text-mw-text">{call.name}</code>
              </>
            ) : (
              `Searched the web — ${sources.length} ${sources.length === 1 ? "source" : "sources"}`
            )}
          </span>
          {result === undefined ? (
            // The call is on the record but its result has not landed: the
            // server is running the tool right now.
            <span className="text-xs italic">running…</span>
          ) : result.is_error ? (
            <span className="text-xs text-mw-danger">failed</span>
          ) : null}
        </span>
      }
    >
      <PreBlock label="Arguments" text={call.arguments || "{}"} />
      {result !== undefined &&
        (sources === undefined ? (
          <PreBlock label={result.is_error ? "Error" : "Result"} text={result.output} />
        ) : (
          <SourceList sources={sources} />
        ))}
    </Disclosure>
  );
}

/**
 * The sources a `web_search` result cited.
 *
 * Why this exists at all: an answer built from search results that does not
 * say where they came from is unverifiable, and the raw `<pre>` the generic
 * branch renders shows the URL as unclickable text inside a JSON blob. The
 * citation has to be reachable, so a search result gets a list of links.
 *
 * Every href goes through `safeLinkUrl` and a result whose URL it refuses is
 * dropped. The API already refused anything but http/https before the part
 * was stored (`websearch.safe_result_url`), so this is the second check on
 * the same string, deliberately: the URL is attacker-chosen text that is
 * about to become an `href`, and a client-side allowlist that trusts the
 * server is one API bug away from being no allowlist.
 *
 * `rel="noopener noreferrer nofollow"` and `target="_blank"`: noopener
 * because the opened page must not reach back into `window.opener`,
 * noreferrer so the destination is not told which conversation sent the
 * click, and nofollow because these are not endorsements -- a model picked
 * them off a search page.
 *
 * The title and snippet are plain text, never markdown. They are quoted from
 * a page we do not own, and giving third-party text link and image rendering
 * would widen the markdown security boundary to anyone who can rank for a query.
 */
function SourceList(props: { sources: readonly SearchSource[] }) {
  return (
    <div className="mt-1 first:mt-0">
      <p className="mb-1 text-xs uppercase tracking-wide text-mw-text-muted">Sources</p>
      <ol className="space-y-2">
        {props.sources.map((source, i) => {
          const href = safeLinkUrl(source.url);
          if (href === undefined) return null;
          return (
            <li key={i} className="text-xs">
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="font-medium text-mw-text hover:underline"
              >
                {source.title}
              </a>
              <p className="mt-0.5 break-all text-mw-text-muted">{href}</p>
              {source.snippet !== "" && (
                <p className="mt-0.5 text-mw-text-muted">{source.snippet}</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReasoningRow(props: { text: string }) {
  // Collapsed by default: a reasoning trace is the model's scratch
  // space, not its answer, and it should never be the first thing read.
  return (
    <Disclosure summary={<span className="flex-1">Reasoning</span>}>
      <PreBlock text={props.text} />
    </Disclosure>
  );
}

/**
 * An attached image, rendered through the app's own download route.
 *
 * The URL is built from the attachment id rather than taken from the part,
 * because the part deliberately carries no URL: a signed URL is short-lived
 * and scoped to the viewer, so one baked into stored content would be stale
 * (or, worse, a bearer token that outlived its session). The metadata route
 * mints a fresh one per render.
 *
 * `loading="lazy"` because a long conversation with a dozen screenshots
 * should not fetch all of them to show the last turn.
 */
function ImageRow(props: { part: ImagePart }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/attachments/${encodeURIComponent(props.part.attachment_id)}/view`;
  if (failed) {
    return (
      <Attachment
        name={props.part.filename}
        detail="This image is no longer available."
        id={props.part.attachment_id}
      />
    );
  }
  return (
    <figure className="my-2">
      <img
        src={src}
        alt={props.part.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-96 rounded-lg border border-mw-border object-contain"
      />
      <figcaption className="mt-1 text-xs text-mw-text-muted">{props.part.filename}</figcaption>
    </figure>
  );
}

/**
 * An attached document.
 *
 * The extracted text is NOT rendered inline: it is the file's content, it can
 * be 32,000 characters, and the user already knows what they attached. What
 * matters is the filename and -- the reason `truncated` exists at all --
 * whether the model saw the whole thing (the rule: "say so in the UI when
 * it is truncated").
 */
function DocumentRow(props: { part: DocumentPart }) {
  const { part } = props;
  const detail =
    part.text === null
      ? "Stored and attached. Its text was not extracted, so the model did not read its contents."
      : part.truncated
        ? "Only the first part of this file was sent to the model; it was too long to include in full."
        : undefined;
  return <Attachment name={part.filename} detail={detail} id={part.attachment_id} />;
}

/** The shared row for a non-image attachment, and for an image that failed. */
function Attachment(props: { name: string; detail?: string; id: string }) {
  return (
    <div className="my-2 rounded-lg border border-mw-border px-3 py-2 text-sm">
      <a
        href={`/api/attachments/${encodeURIComponent(props.id)}/view`}
        className="font-medium text-mw-text hover:underline"
      >
        {props.name}
      </a>
      {props.detail !== undefined && (
        <p className="mt-1 text-xs text-mw-text-muted">{props.detail}</p>
      )}
    </div>
  );
}

/** Where an imported conversation came from and what the import left out. */
function ImportNoteRow(props: { text: string }) {
  return (
    <p
      data-mw-import-note=""
      className="my-2 rounded-lg border border-dashed border-mw-border px-3 py-2 text-xs text-mw-text-muted"
    >
      {props.text}
    </p>
  );
}

function UnknownRow(props: { kind: string }) {
  return (
    <div className="my-2 rounded-lg border border-dashed border-mw-border px-3 py-2 text-sm text-mw-text-muted">
      This message has a <code className="font-mono">{props.kind}</code> part this version cannot
      show yet.
    </div>
  );
}

function PreBlock(props: { label?: string; text: string }) {
  return (
    <div className="mt-1 first:mt-0">
      {props.label !== undefined && (
        <p className="mb-1 text-xs uppercase tracking-wide text-mw-text-muted">{props.label}</p>
      )}
      {/* Plain text, never markdown: this is tool data, and giving it link
          and image rendering would widen the markdown security boundary for no reason. */}
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-mw-text">
        {props.text}
      </pre>
    </div>
  );
}
