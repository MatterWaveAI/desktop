import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthConfig, Conversation, ConversationFilter, Principal } from "../types";
import { apiFetch, ApiError } from "../lib/api";
import type { ShellContextValue } from "./shellContext";
import { shellSignOut } from "./signOut";

/** Where the chat app lives; `?c=` on it names the open conversation. */
export const CHAT_PATH = "/apps/chat";

/** The chat page's address for one conversation, or for a new chat. */
export function conversationHref(id: string | null): string {
  return id ? `${CHAT_PATH}?c=${encodeURIComponent(id)}` : CHAT_PATH;
}

/**
 * Put the open conversation in the address.
 *
 * `push` for a switch the person made (a row, a search hit, the palette), so
 * Back returns to the conversation they came from rather than leaving the
 * app; `replace` for the address catching up with what is already on screen
 * (a new chat getting its id), which is not a place anyone navigated to.
 * The pushed state carries the router's index one past the current one, so
 * the router reads a later Back as a step back rather than a jump.
 */
export function writeConversationUrl(id: string | null, mode: "push" | "replace"): void {
  writeChatHref(conversationHref(id), mode);
}

/** `writeConversationUrl` for an address that also carries `?m=`. */
export function writeChatHref(href: string, mode: "push" | "replace"): void {
  if (`${location.pathname}${location.search}` === href) return;
  if (mode === "replace") {
    history.replaceState(history.state, "", href);
    return;
  }
  const previous = history.state as { __TSR_index?: unknown } | null;
  const index = typeof previous?.__TSR_index === "number" ? previous.__TSR_index : 0;
  const key = Math.random().toString(36).slice(2, 10);
  history.pushState({ __TSR_index: index + 1, key, __TSR_key: key }, "", href);
}

/** One page of `GET /api/conversations`; `next_cursor` is null on the last. */
interface ConversationPage {
  data: Conversation[];
  next_cursor?: string | null;
}

/** Whether a row is in the slice of the list `filter` names, as the server filters it. */
function inFilter(c: Conversation, filter: ConversationFilter): boolean {
  if (filter === "archived") return Boolean(c.archived_at);
  if (filter === "pinned") return Boolean(c.pinned_at);
  if (filter === "all") return true;
  return !c.archived_at;
}

function stamp(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

/**
 * Negative when `a` comes before `b` in the server's list order:
 * `pinned_at DESC NULLS LAST, updated_at DESC, id DESC`.
 */
function serverOrder(a: Conversation, b: Conversation): number {
  return (
    stamp(b.pinned_at) - stamp(a.pinned_at) ||
    stamp(b.updated_at) - stamp(a.updated_at) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * The list once `row` has changed on the server: taken out, then put back
 * where the server's ORDER BY would put it if it still belongs in `filter`.
 * A row that would sort below the last loaded one while more pages remain
 * is left for the page it is on, so it is not shown out of order.
 */
export function placeRow(
  list: Conversation[],
  row: Conversation,
  filter: ConversationFilter,
  hasMore: boolean,
): Conversation[] {
  const rest = list.filter((c) => c.id !== row.id);
  if (!inFilter(row, filter)) return rest;
  const at = rest.findIndex((c) => serverOrder(row, c) < 0);
  if (at === -1) return hasMore ? rest : [...rest, row];
  return [...rest.slice(0, at), row, ...rest.slice(at)];
}

/**
 * Everything the shell puts on the context: the conversation list and the
 * actions over it.
 *
 * Split out of `Shell` so a test can drive the real list logic -- the loader,
 * the filter, pin and archive -- without mounting `<Outlet>`, which needs a
 * router that the sidebar has nothing to do with.
 */
export function useShellState(props: {
  authConfig: AuthConfig;
  principal: Principal;
}): ShellContextValue {
  // What the person has changed about themselves since Boot resolved the
  // principal (a rename), laid over it so the change shows everywhere at
  // once rather than after the next full load. An overlay rather than a
  // copy of the principal: a new one from Boot is picked up unchanged, and
  // nothing has to be synced back when it arrives.
  const [principalPatch, setPrincipalPatch] = useState<Partial<Principal>>({});
  const principal = useMemo<Principal>(
    () => ({ ...props.principal, ...principalPatch }),
    [props.principal, principalPatch],
  );
  const updatePrincipal = useCallback((patch: Partial<Principal>) => {
    setPrincipalPatch((current) => ({ ...current, ...patch }));
  }, []);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  /**
   * Whether the list failed, and the correlation id of the failure.
   *
   * Deliberately not the server's message. The sidebar's copy is fixed and
   * owned by the component - "never show a raw error body" - so the only
   * thing worth carrying out of the catch is the id, which is the one part a
   * user can usefully pass on. Storing the prose invited someone to render
   * it.
   */
  const [conversationsError, setConversationsError] = useState<{
    requestId: string | null;
  } | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // Which slice of the list the sidebar shows. `default` is the
  // list this shell has always shown -- unarchived, pinned first -- so the
  // filter is additive and nothing changes until the user asks for it.
  const [listFilter, setListFilter] = useState<ConversationFilter>("default");
  // Where the loaded rows end. The server pages the list by cursor; null
  // means the last page is in, so there is nothing to load more of. Kept
  // apart from the rows: a pin or a rename replaces a row in place and must
  // not touch where the next page starts.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<{ requestId: string | null } | null>(null);

  const reloadConversations = useCallback(async () => {
    try {
      const page = await apiFetch<ConversationPage>(`/api/conversations?filter=${listFilter}`);
      // Cleared on success rather than before the request: clearing first is a
      // synchronous setState on the effect's first run, which forces an extra
      // render pass, and a failed reload should keep showing its error until a
      // later one succeeds.
      setConversationsError(null);
      setMoreError(null);
      setConversations(page.data);
      setNextCursor(page.next_cursor ?? null);
    } catch (err) {
      setConversationsError({ requestId: err instanceof ApiError ? err.requestId : null });
    } finally {
      setConversationsLoading(false);
    }
  }, [listFilter]);

  // The next page, appended. Rows already loaded are kept rather than
  // replaced -- a row that moved up the list since the first page (a pin, a
  // new message) may come back on a later one, and it is shown once, where
  // it already is. The cursor is only advanced on success, so a failed load
  // leaves "Load more" where it was for a retry.
  const loadMoreConversations = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<ConversationPage>(
        `/api/conversations?filter=${listFilter}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setMoreError(null);
      setConversations((list) => {
        const seen = new Set(list.map((c) => c.id));
        return [...list, ...page.data.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(page.next_cursor ?? null);
    } catch (err) {
      setMoreError({ requestId: err instanceof ApiError ? err.requestId : null });
    } finally {
      setLoadingMore(false);
    }
  }, [listFilter, nextCursor, loadingMore]);

  useEffect(() => {
    // The load-on-mount. reloadConversations is also the retry handler and is
    // passed to consumers through context, so it stays a callback rather than
    // being inlined here. Its setState calls all happen after an await except
    // on the error path; the rule cannot see that across the call boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadConversations();
  }, [reloadConversations]);

  // Back and Forward between conversations. The chat route stays mounted
  // across a `?c=` change, so the address has to be read back into the
  // selection here; on any other page the route's own mount reads it.
  useEffect(() => {
    const onPop = () => {
      if (location.pathname !== CHAT_PATH) return;
      setActiveConversationId(new URLSearchParams(location.search).get("c"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      setConversations((list) => list.filter((c) => c.id !== id));
      setActiveConversationId((current) => (current === id ? null : current));
      // The address still names the conversation; a reload would ask for a
      // row that is gone. Here rather than in each caller, so the sidebar
      // and the shortcut cannot disagree.
      if (new URLSearchParams(location.search).get("c") === id) {
        history.replaceState(null, "", location.pathname);
      }
    },
    [],
  );

  // PUT sets, DELETE clears -- the method carries the intent,
  // so a retried request cannot land in the opposite state. The answer is the
  // updated conversation, and the row is replaced from it rather than patched
  // locally: the server owns `pinned_at`, and guessing the timestamp here
  // would sort the list by a value the server never wrote. The server sorts
  // pinned rows first, so the row is placed by that order, not kept where it was.
  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      const updated = await apiFetch<Conversation>(`/api/conversations/${id}/pin`, {
        method: pinned ? "PUT" : "DELETE",
      });
      setConversations((list) => placeRow(list, updated, listFilter, nextCursor !== null));
    },
    [listFilter, nextCursor],
  );

  const setArchived = useCallback(
    async (id: string, archived: boolean) => {
      const updated = await apiFetch<Conversation>(`/api/conversations/${id}/archive`, {
        method: archived ? "PUT" : "DELETE",
      });
      // Archiving moves the row out of the default list and unarchiving
      // moves it back in -- from the Archived section, where it was never in
      // this list -- so it is placed, not mapped in place.
      setConversations((list) => placeRow(list, updated, listFilter, nextCursor !== null));
    },
    [listFilter, nextCursor],
  );

  // Optimistic, unlike pin and archive: the title is the person's own text,
  // so the row can show it before the server answers, and there is no
  // server-owned value to guess. The answer still replaces the row, and a
  // refusal puts the old row back and rethrows so the caller can say so
  // where the person is looking.
  const renameConversation = useCallback(async (id: string, title: string) => {
    let previous: Conversation | undefined;
    setConversations((list) =>
      list.map((c) => {
        if (c.id !== id) return c;
        previous = c;
        return { ...c, title };
      }),
    );
    try {
      const updated = await apiFetch<Conversation>(`/api/conversations/${id}`, {
        method: "PATCH",
        json: { title },
      });
      setConversations((list) => list.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      const before = previous;
      if (before) setConversations((list) => list.map((c) => (c.id === id ? before : c)));
      throw err;
    }
  }, []);

  const context = useMemo<ShellContextValue>(
    () => ({
      authConfig: props.authConfig,
      principal,
      updatePrincipal,
      conversations,
      conversationsLoading,
      conversationsError,
      activeConversationId,
      selectConversation: setActiveConversationId,
      deleteConversation,
      setPinned,
      setArchived,
      renameConversation,
      listFilter,
      setListFilter,
      onConversationCreated: (conversation) => {
        setActiveConversationId(conversation.id);
        // The new chat has an id now, and the address says so: a reload
        // reopens this conversation, with whatever of the reply was stored,
        // rather than an empty composer. Replace, not push -- there was no
        // separate page before it to go Back to.
        if (location.pathname === CHAT_PATH) writeConversationUrl(conversation.id, "replace");
        // A temporary conversation is open but never listed: the API leaves
        // it out of every page, and the sidebar must not add it either.
        if (conversation.temporary) return;
        setConversations((list) =>
          list.some((c) => c.id === conversation.id) ? list : [conversation, ...list],
        );
      },
      onConversationRenamed: (id, title) => {
        setConversations((list) =>
          list.map((c) => (c.id === id ? { ...c, title, updated_at: new Date().toISOString() } : c)),
        );
      },
      reloadConversations,
      conversationsHasMore: nextCursor !== null,
      conversationsLoadingMore: loadingMore,
      conversationsMoreError: moreError,
      loadMoreConversations,
      signOut: () => shellSignOut(props.authConfig),
    }),
    [
      props.authConfig,
      principal,
      updatePrincipal,
      conversations,
      conversationsLoading,
      conversationsError,
      activeConversationId,
      deleteConversation,
      setPinned,
      setArchived,
      renameConversation,
      listFilter,
      reloadConversations,
      nextCursor,
      loadingMore,
      moreError,
      loadMoreConversations,
    ],
  );

  return context;
}
