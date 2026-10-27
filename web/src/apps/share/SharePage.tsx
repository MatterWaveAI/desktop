import { useContext, useEffect, useState } from "react";
import { ShellContext } from "../../shell/shellContext";
import { useParams } from "@tanstack/react-router";
import { ApiError } from "../../lib/api";
import { PROSE_LINK_CLASS } from "../../shell/authForms";
import { AI_DISCLOSURE } from "../chat/aiDisclosureText";
import { MarkdownText } from "../chat/Markdown";
import { AssistantMark, Wordmark } from "../../components/brand";
import {
  CONTINUE_PATH,
  fetchPublicShare,
  formatDate,
  sharedAttachmentUrl,
  type PublicAttachmentPart,
  type PublicMessage,
  type PublicPart,
  type PublicShare,
} from "./share";

/**
 * The public page a share link opens: the snapshot, read-only, under the
 * product's own header, with the AI disclosure above it and a way into
 * MatterWave under it.
 *
 * Rendered through the front door for a stranger -- `frontDoor.ts` lets
 * `/share/...` through the anonymous gate -- so there is no shell, no
 * sidebar and no composer: nothing on this page can act on the
 * conversation it shows. A signed-in reader sees the same page inside
 * their own shell, exactly as /pricing and /join behave.
 *
 * Assistant text goes through `MarkdownText`, the same security boundary
 * the chat uses, because it is still model output. An attachment is a
 * name unless the person sharing chose to include attachments; then the
 * snapshot names its id and the public attachment route serves it, scoped
 * to this link. The page asks crawlers to stay out: the link is private to
 * whoever holds it, and the API sends the same header.
 */
export function SharePage() {
  const { token } = useParams({ from: "/share/$token" });
  return <SharedTranscript token={token} />;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; share: PublicShare }
  | { phase: "missing" }
  | { phase: "limited"; message: string }
  | { phase: "error" };

export function SharedTranscript(props: { token: string }) {
  const shell = useContext(ShellContext);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    fetchPublicShare(props.token)
      .then((share) => {
        if (alive) setState({ phase: "ready", share });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setState({ phase: "missing" });
        else if (err instanceof ApiError && err.status === 429) {
          setState({ phase: "limited", message: err.message });
        } else setState({ phase: "error" });
      });
    return () => {
      alive = false;
    };
  }, [props.token]);

  // Robots: the page is private to whoever holds the link. Added while the
  // page is shown and removed with it, so the rest of the SPA is unaffected.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);

  // Inside a signed-in reader's shell its <main> already holds the page.
  const Body = shell === null ? "main" : "div";
  return (
    <div className="h-full overflow-y-auto bg-mw-surface text-mw-text" data-mw-share-page={state.phase}>
      <header className="sticky top-0 z-10 border-b border-mw-border bg-mw-surface/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <a href="/" className="flex items-center gap-2" aria-label="MatterWave home">
            <Wordmark size="md" />
          </a>
          <span className="font-mono text-xs tracking-wide text-mw-text-muted uppercase">Shared conversation</span>
          <a
            href={CONTINUE_PATH}
            data-mw-share-cta=""
            className="ml-auto inline-flex min-h-6 items-center rounded-lg bg-mw-accent px-3.5 py-1.5 text-sm font-semibold text-mw-accent-foreground hover:bg-mw-accent-hover pointer-coarse:min-h-11"
          >
            Continue in MatterWave
          </a>
        </div>
      </header>

      <Body className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <div className="flex flex-col gap-1">
          {state.phase === "ready" && (
            <>
              <h1 className="font-display text-display-md sm:text-display-lg">{state.share.title || "Shared conversation"}</h1>
              <p className="text-sm text-mw-text-muted">
                {state.share.org_name !== null && <>Shared by {state.share.org_name} · </>}
                {state.share.shared_at !== null && <>Snapshot from {formatDate(state.share.shared_at)}</>}
              </p>
            </>
          )}
        </div>

        {state.phase === "loading" && (
          <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
            Loading the conversation…
          </p>
        )}
        {state.phase === "missing" && (
          <Unavailable title="This shared conversation is not available">
            The link may have expired, or the person who shared it may have turned it off.
            Shared links can be set to expire, and whoever shared one can revoke it at any
            time. If you need the conversation, ask them to share it again.
          </Unavailable>
        )}
        {state.phase === "limited" && (
          <Unavailable title="Too many shared pages opened">{state.message}</Unavailable>
        )}
        {state.phase === "error" && (
          <Unavailable title="The conversation could not be loaded">
            Something went wrong on the way. Try again in a moment.
          </Unavailable>
        )}

        {state.phase === "ready" && (
          <>
            {/* The disclosure, before the first reply: a stranger reading
                this never saw the chat's empty state where it normally sits. */}
            <p className="rounded-xl border border-mw-info-border bg-mw-info-subtle px-4 py-3 text-sm text-mw-text">
              {AI_DISCLOSURE}
            </p>
            <article aria-label="Shared conversation" className="flex flex-col">
              {state.share.messages.map((message, index) => (
                <MessageRow key={index} message={message} token={props.token} />
              ))}
            </article>
            <aside className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-mw-border bg-mw-surface-raised px-5 py-5 sm:px-7">
              <p className="text-sm">
                <span className="font-medium">Want to carry this on?</span>{" "}
                <span className="text-mw-text-subtle">
                  MatterWave keeps your conversations yours: export them any time, or bring them in
                  from elsewhere.
                </span>
              </p>
              <a
                href={CONTINUE_PATH}
                className="inline-flex min-h-6 items-center rounded-lg bg-mw-accent px-4 py-2 text-sm font-semibold text-mw-accent-foreground hover:bg-mw-accent-hover pointer-coarse:min-h-11"
              >
                Continue in MatterWave
              </a>
            </aside>
          </>
        )}

        <footer className="mt-4 border-t border-mw-border pt-4 text-sm text-mw-text-muted">
          <a href="/" className={PROSE_LINK_CLASS}>
            Made with MatterWave
          </a>
        </footer>
      </Body>
    </div>
  );
}

/**
 * A link that opens nothing: a heading that says so, a plain explanation,
 * and the front page as the way on. Never why in detail -- "expired" and
 * "revoked" are the same answer to a stranger, and saying which would tell
 * them something about the sharer's choices.
 */
function Unavailable(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-mw-border bg-mw-surface-raised p-5 sm:p-7">
      <h1 className="font-display text-display-md">{props.title}</h1>
      <p role="status" className="text-sm text-mw-text-subtle">
        {props.children}
      </p>
      <div>
        <a
          href="/"
          className="inline-flex min-h-6 items-center rounded-lg bg-mw-accent px-4 py-2 text-sm font-semibold text-mw-accent-foreground hover:bg-mw-accent-hover pointer-coarse:min-h-11"
        >
          Go to MatterWave
        </a>
      </div>
    </section>
  );
}

function MessageRow(props: { message: PublicMessage; token: string }) {
  const { message, token } = props;
  if (message.role === "user") {
    return (
      <div className="mb-4 flex flex-col items-end">
        <Attachments parts={message.parts} token={token} />
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-mw-inverse-border bg-mw-inverse px-4 py-2.5 text-sm text-mw-inverse-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  const label = message.model_label || message.model;
  return (
    <div className="mb-6 flex items-start gap-3">
      <AssistantMark className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {message.parts.map((part, i) =>
          isText(part) && part.text !== "" ? <MarkdownText key={i} text={part.text} /> : null,
        )}
        <Attachments parts={message.parts} token={token} />
        {label && (
          <p className="mt-1 font-mono text-xs text-mw-text-muted" data-mw-share-model={message.model ?? ""}>
            {label}
          </p>
        )}
      </div>
    </div>
  );
}

function isText(part: PublicPart): part is { type: "text"; text: string } {
  return part.type === "text";
}

function isAttachment(part: PublicPart): part is PublicAttachmentPart {
  return part.type === "attachment";
}

/**
 * Attachments: an image or a download when the sharer included them,
 * otherwise a name. The bytes come from the share's own route, never from
 * the owner's signed URLs.
 */
function Attachments(props: { parts: readonly PublicPart[]; token: string }) {
  const attachments = props.parts.filter(isAttachment);
  if (attachments.length === 0) return null;
  return (
    <ul className="mb-1 flex flex-wrap gap-2">
      {attachments.map((part, i) => {
        const name = part.filename || (part.kind === "image" ? "image" : "document");
        if (!part.attachment_id) {
          return (
            <li
              key={i}
              className="rounded-lg border border-dashed border-mw-border px-2 py-1 text-xs text-mw-text-muted"
            >
              {name} — not included in the share
            </li>
          );
        }
        const url = sharedAttachmentUrl(props.token, part.attachment_id);
        if (part.kind === "image") {
          return (
            <li key={i}>
              <img
                src={url}
                alt={name}
                loading="lazy"
                className="max-h-64 max-w-full rounded-lg border border-mw-border"
              />
            </li>
          );
        }
        return (
          <li key={i} className="rounded-lg border border-mw-border px-2 py-1 text-xs">
            <a href={url} download={name} className={PROSE_LINK_CLASS}>
              {name}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
