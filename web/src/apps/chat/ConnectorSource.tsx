import { GitForkIcon, MessageSquareIcon } from "lucide-react";
import type { ConversationSource } from "../../types";
import { safeLinkUrl } from "./safeUrl";
import { connectorName, connectorNoticeText, sourceLabel } from "./connectorConversation";

/**
 * A connector's conversation, as the person sees it: the badge on its
 * sidebar row, and the notice that takes the composer's place in the
 * thread. The thread it is answered in is the only place to reply; the
 * fork is how to continue it here.
 */

/** The row's mark: which connector, which channel. */
export function SourceBadge(props: { source: ConversationSource }) {
  const label = sourceLabel(props.source);
  return (
    <span
      data-mw-source-badge=""
      title={`Answered in ${label}`}
      className="inline-flex max-w-[55%] shrink-0 items-center gap-1 rounded-full border border-mw-border px-1.5 text-xs leading-4 font-normal text-mw-text-muted"
    >
      <MessageSquareIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * In the composer's place: where the answer is, a link to it when the
 * connector gave one, and the fork. Not an error -- nothing failed -- and
 * not dismissible, because the thread stays read-only here.
 */
export function ConnectorNotice(props: {
  source: ConversationSource;
  /** Absent while the fork is not possible: a support session, or no stored message yet. */
  onFork?: () => void;
  forking?: boolean;
}) {
  const url = safeLinkUrl(props.source.url ?? undefined);
  return (
    <div
      role="note"
      data-mw-connector-notice=""
      className="shrink-0 px-3"
      style={{
        paddingBottom: "max(0.75rem, var(--mw-safe-bottom))",
        paddingLeft: "max(0.75rem, var(--mw-safe-left))",
        paddingRight: "max(0.75rem, var(--mw-safe-right))",
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-mw-border-emphasis bg-mw-surface-raised px-4 py-3 text-sm text-mw-text-secondary shadow-lg">
        <p className="min-w-0 flex-1">
          <MessageSquareIcon className="mr-1.5 inline size-4 align-text-bottom" aria-hidden />
          {connectorNoticeText(props.source)}
        </p>
        {url !== undefined && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-mw-connector-open=""
            className="shrink-0 font-medium text-mw-text underline underline-offset-2 hover:text-mw-accent"
          >
            Open in {connectorName(props.source)}
          </a>
        )}
        {props.onFork !== undefined && (
          <button
            type="button"
            data-mw-connector-fork=""
            disabled={props.forking === true}
            onClick={props.onFork}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-mw-border-strong px-3 text-xs font-medium text-mw-text outline-none hover:bg-mw-surface-hover focus-visible:ring-2 focus-visible:ring-mw-focus disabled:cursor-not-allowed disabled:text-mw-text-muted pointer-coarse:min-h-11"
          >
            <GitForkIcon className="size-3.5" aria-hidden />
            Fork to continue here
          </button>
        )}
      </div>
    </div>
  );
}
