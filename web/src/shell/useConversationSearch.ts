import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchHit, SearchPage } from "../types";
import { ApiError, apiFetch } from "../lib/api";

/**
 * The sidebar search box.
 *
 * Debounced because every keystroke would otherwise be a full-text query and
 * a `ts_headline` call per matched row; 250ms is below the threshold where
 * typing feels laggy and well above a fast typist's inter-key interval, so a
 * word costs one query rather than one per letter.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Fired on `window` when a search result is chosen: the conversation to
 * open and, when a message matched, the message to scroll to. The URL
 * carries the same two ids (`?c=` and `?m=`), so the chat app may honour
 * either; the sidebar owns neither the transcript nor its scrolling.
 */
export const JUMP_TO_MESSAGE_EVENT = "mw:jump-to-message";

export interface JumpToMessageDetail {
  readonly conversationId: string;
  readonly messageId: string | null;
}

export interface ConversationSearch {
  query: string;
  setQuery: (value: string) => void;
  clear: () => void;
  /** True while a query is present — the sidebar shows results, not the list. */
  active: boolean;
  results: SearchHit[];
  loading: boolean;
  /** A further page exists; `loadMore` fetches it onto the end of `results`. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /**
   * Set when the search request failed, carrying only the correlation id.
   *
   * Was the server's own message, which the sidebar rendered verbatim - the
   * "never show a raw error body" rule broken in the one place that actually
   * printed one. The copy belongs to the component; the id is the part worth
   * passing out of here.
   */
  error: SearchFailure | null;
}

/** A failed search: that it failed, and what to quote about it. */
export interface SearchFailure {
  readonly requestId: string | null;
}

interface Outcome {
  /** The trimmed query these results belong to, so stale ones can be ignored. */
  query: string;
  results: SearchHit[];
  nextCursor: string | null;
  error: SearchFailure | null;
}

const NOTHING: Outcome = { query: "", results: [], nextCursor: null, error: null };

function searchUrl(query: string, cursor: string | null): string {
  const params = new URLSearchParams({ q: query });
  if (cursor) params.set("cursor", cursor);
  return `/api/search?${params.toString()}`;
}

export function useConversationSearch(): ConversationSearch {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(NOTHING);
  const [loadingMore, setLoadingMore] = useState(false);

  // The sequence number of the most recently STARTED request. A slow query
  // for "vel" must not overwrite the results for "velocity" when it lands
  // late -- out-of-order responses are the classic search-box bug, and the
  // fix belongs here rather than in the component.
  const latest = useRef(0);

  const trimmed = query.trim();
  const active = trimmed.length > 0;

  // Derived, not stored: clearing the box shows the list again the moment it
  // is cleared, with no effect scheduling a reset and no render in between
  // where stale hits are still on screen. The outcome carries the query it
  // belongs to, so results for a query the user has since changed are simply
  // not this render's results.
  const current = outcome.query === trimmed ? outcome : NOTHING;
  const loading = active && current !== outcome;

  useEffect(() => {
    // An empty box issues no request at all; the derivation above has already
    // taken the results off screen.
    if (!active) return;

    const seq = ++latest.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const page = await apiFetch<Partial<SearchPage>>(searchUrl(trimmed, null));
          if (seq !== latest.current) return;
          setOutcome({
            query: trimmed,
            // A stub or an older API may answer without the cursor; absent
            // reads as the last page.
            results: Array.isArray(page.data) ? page.data : [],
            nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
            error: null,
          });
        } catch (err) {
          if (seq !== latest.current) return;
          setOutcome({
            query: trimmed,
            results: [],
            nextCursor: null,
            error: { requestId: err instanceof ApiError ? err.requestId : null },
          });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    // Typing again before the timer fires cancels the request that never
    // started, which is what makes this a debounce rather than a throttle.
    return () => clearTimeout(timer);
  }, [trimmed, active]);

  const loadMore = useCallback(() => {
    const cursor = current.nextCursor;
    if (!cursor || loadingMore) return;
    const seq = latest.current;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await apiFetch<Partial<SearchPage>>(searchUrl(trimmed, cursor));
        // The query moved on while this page was in flight: it belongs to
        // results no longer on screen.
        if (seq !== latest.current) return;
        setOutcome((previous) =>
          previous.query === trimmed
            ? {
                ...previous,
                results: [...previous.results, ...(Array.isArray(page.data) ? page.data : [])],
                nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
              }
            : previous,
        );
      } catch (err) {
        if (seq !== latest.current) return;
        setOutcome((previous) =>
          previous.query === trimmed
            ? { ...previous, error: { requestId: err instanceof ApiError ? err.requestId : null } }
            : previous,
        );
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [current.nextCursor, loadingMore, trimmed]);

  return {
    query,
    setQuery,
    clear: () => setQuery(""),
    active,
    results: current.results,
    loading,
    hasMore: current.nextCursor !== null,
    loadingMore,
    loadMore,
    error: current.error,
  };
}
