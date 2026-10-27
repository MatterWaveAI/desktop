import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Conversation, Folder, LibraryState, SearchHit, Tag } from "../types";
import { apiFetch, ApiError } from "../lib/api";
import { useShell } from "./shellContext";
import { ConversationListSkeleton, RequestReference } from "../apps/chat/ChatStates";
import { DestructiveConfirm, EmptyState, ErrorState } from "../patterns";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { conversationHref, writeChatHref, writeConversationUrl } from "./useShellState";
import {
  JUMP_TO_MESSAGE_EVENT,
  useConversationSearch,
  type ConversationSearch,
  type JumpToMessageDetail,
} from "./useConversationSearch";
import { splitSnippet } from "./searchSnippet";
import { groupConversations } from "./conversationGroups";
import { CONVERSATION_SEARCH_ID } from "./shortcuts";

/**
 * The conversation half of the sidebar: the search box, the folders, the
 * tag filter, the list, the archive.
 *
 * Search REPLACES the list while a query is present rather than sitting
 * beside it: the sidebar is one column and a search that pushed the list
 * down would make the user scroll past what they were not looking for.
 *
 * Folders and tags come from `/api/library` in one read and are kept here,
 * not on the shell context: the chat app has no use for them, and the
 * conversation rows the shell holds are replaced from pin, archive and
 * rename answers, which would leave a copy of the tag set on each row
 * stale. The assignment map is joined to the rows at render time instead.
 */

/** A search the palette asked for: the query, and a sequence so the same query twice still lands. */
export interface SearchRequest {
  readonly query: string;
  readonly seq: number;
}

/**
 * Called once a row or a search hit has opened a conversation: the shell
 * closes the phone drawer, which otherwise stays over the conversation the
 * person just asked for.
 */
const SidebarNavigate = createContext<(() => void) | undefined>(undefined);

export function ConversationSidebar(props: {
  searchRequest?: SearchRequest | null;
  onNavigate?: () => void;
}) {
  return (
    <SidebarNavigate.Provider value={props.onNavigate}>
      <SidebarBody searchRequest={props.searchRequest ?? null} />
    </SidebarNavigate.Provider>
  );
}

function SidebarBody(props: { searchRequest: SearchRequest | null }) {
  const search = useConversationSearch();
  const library = useLibrary();
  const inputRef = useRef<HTMLInputElement>(null);
  const request = props.searchRequest;
  const { setQuery } = search;

  // The palette's "Search conversations for …" lands in this box, focused,
  // so the person can refine it with the keyboard they were already using.
  useEffect(() => {
    if (!request) return;
    setQuery(request.query);
    inputRef.current?.focus();
  }, [request, setQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchField search={search} ref={inputRef} />
      {search.active ? (
        <SearchResults search={search} />
      ) : (
        <ConversationList library={library} />
      )}
    </div>
  );
}

// --- the library: folders, tags, assignments ----------------------------------

interface LibraryModel extends LibraryState {
  /** False until the first read answered, one way or the other. */
  loaded: boolean;
  failed: boolean;
  createFolder: (name: string) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveConversation: (conversationId: string, folderId: string | null) => Promise<void>;
  createTag: (name: string) => Promise<Tag>;
  deleteTag: (id: string) => Promise<void>;
  setTags: (conversationId: string, tagIds: string[]) => Promise<void>;
}

const EMPTY_LIBRARY: LibraryState = { folders: [], tags: [], assignments: {} };

function useLibrary(): LibraryModel {
  const shell = useShell();
  const [state, setState] = useState<LibraryState>(EMPTY_LIBRARY);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const { reloadConversations } = shell;

  const load = useCallback(async () => {
    try {
      const body = await apiFetch<Partial<LibraryState>>("/api/library");
      // A stub or an older API may answer with a shape that is not the
      // library; each half reads as empty rather than as a crash.
      setState({
        folders: Array.isArray(body.folders) ? body.folders : [],
        tags: Array.isArray(body.tags) ? body.tags : [],
        assignments:
          body.assignments && typeof body.assignments === "object" ? body.assignments : {},
      });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const createFolder = useCallback(async (name: string) => {
    const folder = await apiFetch<Folder>("/api/library/folders", {
      method: "POST",
      json: { name },
    });
    setState((s) => ({ ...s, folders: [...s.folders, folder] }));
    return folder;
  }, []);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const folder = await apiFetch<Folder>(`/api/library/folders/${id}`, {
      method: "PATCH",
      json: { name },
    });
    setState((s) => ({ ...s, folders: s.folders.map((f) => (f.id === id ? folder : f)) }));
  }, []);

  const deleteFolder = useCallback(
    async (id: string) => {
      await apiFetch(`/api/library/folders/${id}`, { method: "DELETE" });
      setState((s) => ({ ...s, folders: s.folders.filter((f) => f.id !== id) }));
      // The folder's conversations are back in the main list: re-read the
      // rows so their `folder_id` says so.
      await reloadConversations();
    },
    [reloadConversations],
  );

  const moveConversation = useCallback(
    async (conversationId: string, folderId: string | null) => {
      await apiFetch<Conversation>(`/api/library/conversations/${conversationId}/folder`, {
        method: "PUT",
        json: { folder_id: folderId },
      });
      await reloadConversations();
    },
    [reloadConversations],
  );

  const createTag = useCallback(async (name: string) => {
    const tag = await apiFetch<Tag>("/api/library/tags", { method: "POST", json: { name } });
    setState((s) =>
      s.tags.some((t) => t.id === tag.id)
        ? s
        : { ...s, tags: [...s.tags, tag].sort((a, b) => a.name.localeCompare(b.name)) },
    );
    return tag;
  }, []);

  const deleteTag = useCallback(async (id: string) => {
    await apiFetch(`/api/library/tags/${id}`, { method: "DELETE" });
    setState((s) => ({
      ...s,
      tags: s.tags.filter((t) => t.id !== id),
      assignments: Object.fromEntries(
        Object.entries(s.assignments).map(([conv, ids]) => [conv, ids.filter((t) => t !== id)]),
      ),
    }));
  }, []);

  const setTags = useCallback(async (conversationId: string, tagIds: string[]) => {
    const body = await apiFetch<{ tag_ids: string[] }>(
      `/api/library/conversations/${conversationId}/tags`,
      { method: "PUT", json: { tag_ids: tagIds } },
    );
    const ids = Array.isArray(body.tag_ids) ? body.tag_ids : tagIds;
    setState((s) => ({ ...s, assignments: { ...s.assignments, [conversationId]: ids } }));
  }, []);

  return useMemo(
    () => ({
      ...state,
      loaded,
      failed,
      createFolder,
      renameFolder,
      deleteFolder,
      moveConversation,
      createTag,
      deleteTag,
      setTags,
    }),
    [
      state,
      loaded,
      failed,
      createFolder,
      renameFolder,
      deleteFolder,
      moveConversation,
      createTag,
      deleteTag,
      setTags,
    ],
  );
}

// --- search ---------------------------------------------------------------------

function SearchField(props: {
  search: ConversationSearch;
  /** The box, so the palette's search request can focus it. */
  ref: React.Ref<HTMLInputElement>;
}) {
  const { search, ref } = props;
  return (
    <div className="px-3 pb-2">
      <div className="relative">
        <input
          ref={ref}
          id={CONVERSATION_SEARCH_ID}
          type="search"
          value={search.query}
          placeholder="Search conversations"
          aria-label="Search conversations"
          /* The browser's own clear button is hidden: the one below is the
             same action, and two crosses side by side read as two actions. */
          className="w-full rounded-md border border-mw-border bg-mw-surface px-2 py-1.5 pr-7 text-base placeholder:text-mw-text-muted focus:border-mw-focus focus:outline-none focus-visible:ring-2 focus-visible:ring-mw-focus md:text-sm pointer-coarse:min-h-11 [&::-webkit-search-cancel-button]:appearance-none"
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears the box and hands the sidebar back to the list.
            // `stopPropagation` because Escape also closes surfaces further
            // up; clearing a search should not also dismiss the sidebar.
            if (event.key === "Escape" && search.query !== "") {
              event.preventDefault();
              event.stopPropagation();
              search.clear();
            }
          }}
        />
        {search.active && (
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-mw-text-muted hover:text-mw-text"
            aria-label="Clear search"
            onClick={() => search.clear()}
          >
            <CrossIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function SearchResults(props: { search: ConversationSearch }) {
  const { search } = props;
  const shell = useShell();

  if (search.error && search.results.length === 0) {
    return (
      <ErrorState
        title="Search failed"
        message={
          <>
            Your conversations could not be searched. The list itself is unaffected — clear the box
            to go back to it. <RequestReference requestId={search.error.requestId} />
          </>
        }
      />
    );
  }
  // No skeleton on the first keystroke: the debounce is 250ms and a skeleton
  // that appears and vanishes inside a word is noise. The old results stay
  // until the new ones land.
  if (search.results.length === 0) {
    if (search.loading) return <ConversationListSkeleton />;
    return (
      <EmptyState
        title="No matches"
        description={`Nothing in your conversations mentions “${search.query.trim()}”.`}
      />
    );
  }

  const count = search.results.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* How many, before the list: a person scanning for one conversation
          wants to know whether to read twelve rows or refine the word. "So
          far" while the server has more pages than are loaded. */}
      <p role="status" data-mw-search-count="" className="px-4 pb-1 text-xs text-mw-text-muted">
        {count} {count === 1 ? "result" : "results"}
        {search.hasMore ? " so far" : ""}
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Search results">
        {search.results.map((hit) => (
          <li key={hit.id}>
            <SearchResultLink
              hit={hit}
              onOpen={(detail) => {
                shell.selectConversation(detail.conversationId);
                window.dispatchEvent(
                  new CustomEvent<JumpToMessageDetail>(JUMP_TO_MESSAGE_EVENT, { detail }),
                );
              }}
            />
          </li>
        ))}
      </ul>
      {search.hasMore && (
        <div className="border-t border-mw-border px-2 py-1.5">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-xs text-mw-text-muted hover:bg-mw-surface-hover"
            disabled={search.loadingMore}
            onClick={() => search.loadMore()}
          >
            {search.loadingMore ? "Loading…" : "More results"}
          </button>
          {search.error && (
            <p role="alert" className="px-2 pt-1 text-xs text-mw-danger">
              The next page could not be loaded.{" "}
              <RequestReference requestId={search.error.requestId} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One result. The href carries both ids -- `?c=` for the conversation and,
 * when a message matched, `?m=` for the message -- so the chat app can
 * scroll to it; a title match has no message and no `?m=`.
 */
function SearchResultLink(props: { hit: SearchHit; onOpen: (detail: JumpToMessageDetail) => void }) {
  const { hit } = props;
  const onNavigate = useContext(SidebarNavigate);
  const href = hit.message_id
    ? `/apps/chat?c=${hit.id}&m=${hit.message_id}`
    : `/apps/chat?c=${hit.id}`;
  return (
    <a
      href={href}
      className="block rounded-md px-2 py-1.5 hover:bg-mw-surface-hover"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        writeChatHref(href, "push");
        props.onOpen({ conversationId: hit.id, messageId: hit.message_id });
        onNavigate?.();
      }}
    >
      <span className="flex items-center gap-1">
        {hit.pinned_at && <PinIcon filled />}
        <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
        {/* An archived conversation is still searchable (the snippet is
            why it is here), so the result says so rather than pretending
            it is in the list. */}
        {hit.archived_at && (
          <span className="shrink-0 rounded bg-mw-surface px-1 text-xs text-mw-text-muted">
            Archived
          </span>
        )}
      </span>
      <span className="mt-0.5 block text-xs text-mw-text-muted">
        <Snippet text={hit.snippet} />
      </span>
    </a>
  );
}

/**
 * The snippet, with the match marked. Rendered as text nodes and `<mark>`,
 * never as HTML: the string came from a message body, and `ts_headline`
 * escapes nothing.
 */
function Snippet(props: { text: string }) {
  return (
    <>
      {splitSnippet(props.text).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-sm bg-mw-accent/25 text-mw-text">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

// --- the list -------------------------------------------------------------------

function ConversationList(props: { library: LibraryModel }) {
  const shell = useShell();
  const { library } = props;
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // A skeleton shaped like the list, not a line of text: the
  // rows are the height the real rows will be, so the sidebar does not reflow
  // when they land. No spinner on a content area.
  if (shell.conversationsLoading) return <ConversationListSkeleton />;
  if (shell.conversationsError) {
    return (
      <ErrorState
        title="Could not load conversations"
        message={
          <>
            The list could not be fetched. Your conversations are safe — this is only the sidebar.{" "}
            <RequestReference requestId={shell.conversationsError.requestId} />
          </>
        }
        onRetry={() => void shell.reloadConversations()}
      />
    );
  }
  // An empty list is empty under every filter, not just the default one. The
  // `default`-only guard here used to drop an empty `archived` or `all` slice
  // into a bare <ul> with nothing in it — which is the exact failure the
  // ticket calls out: an empty box that could equally be a list that failed
  // to load. Each filter says which emptiness it is.
  if (shell.conversations.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {shell.listFilter === "archived" ? (
          <EmptyState
            title="Nothing archived"
            description="Conversations you archive are kept here, out of the main list."
          />
        ) : (
          <EmptyState
            title="No conversations yet"
            description="Your chats will be listed here once you send a first message."
          />
        )}
        <ArchivedSection library={library} />
      </div>
    );
  }

  // The tag filter is applied to every section, and a folder with nothing
  // left under it is not drawn: a filter that shows empty folders is a
  // filter that mostly shows headings.
  const activeTag = tagFilter ? library.tags.find((t) => t.id === tagFilter) ?? null : null;
  const visible = activeTag
    ? shell.conversations.filter((c) => (library.assignments[c.id] ?? []).includes(activeTag.id))
    : shell.conversations;
  const folderIds = new Set(library.folders.map((f) => f.id));
  const unfiled = visible.filter((c) => !c.folder_id || !folderIds.has(c.folder_id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {library.tags.length > 0 && (
        <TagFilter tags={library.tags} active={tagFilter} onChange={setTagFilter} />
      )}
      {library.failed && (
        <p role="alert" className="px-4 pb-1 text-xs text-mw-danger">
          Folders and tags could not be loaded.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {library.folders.map((folder) => {
          const rows = visible.filter((c) => c.folder_id === folder.id);
          if (activeTag && rows.length === 0) return null;
          return (
            <FolderSection key={folder.id} folder={folder} rows={rows} library={library} />
          );
        })}
        {activeTag && visible.length === 0 ? (
          <EmptyState
            title={`Nothing tagged ${activeTag.name}`}
            description="Tag a conversation from its row menu, or clear the filter."
          />
        ) : (
          <ul className="px-2 pb-3" aria-label="Conversations">
            {groupConversations(unfiled).map((group, index) => (
              <li key={`${group.label}-${index}`}>
                <h3 className="px-2 pb-0.5 pt-2 text-xs font-medium text-mw-text-muted">
                  {group.label}
                </h3>
                <ul aria-label={group.label}>
                  {group.rows.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      library={library}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <LoadMoreControl />
      </div>
      <NewFolderControl library={library} />
      <ArchivedSection library={library} />
    </div>
  );
}

function TagFilter(props: {
  tags: Tag[];
  active: string | null;
  onChange: (tagId: string | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter by tag"
      className="flex flex-wrap gap-1 px-3 pb-2"
    >
      <button
        type="button"
        aria-pressed={props.active === null}
        onClick={() => props.onChange(null)}
        className={`rounded-full border px-2 py-0.5 text-xs ${
          props.active === null
            ? "border-mw-accent bg-mw-accent/15 text-mw-text"
            : "border-mw-border text-mw-text-muted hover:bg-mw-surface-hover"
        }`}
      >
        All
      </button>
      {props.tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          aria-pressed={props.active === tag.id}
          onClick={() => props.onChange(props.active === tag.id ? null : tag.id)}
          className={`rounded-full border px-2 py-0.5 text-xs ${
            props.active === tag.id
              ? "border-mw-accent bg-mw-accent/15 text-mw-text"
              : "border-mw-border text-mw-text-muted hover:bg-mw-surface-hover"
          }`}
        >
          {tag.name}
        </button>
      ))}
    </div>
  );
}

/**
 * One folder: a disclosure with its rows, and a small menu to rename or
 * delete it. Open by default -- the person filed things here to find them.
 */
function FolderSection(props: { folder: Folder; rows: Conversation[]; library: LibraryModel }) {
  const { folder, rows, library } = props;
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(name: string) {
    try {
      await library.renameFolder(folder.id, name);
      setRenaming(false);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename the folder.");
    }
  }

  return (
    <section aria-label={`Folder ${folder.name}`} className="px-2">
      <div className="group flex items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-mw-text-muted hover:bg-mw-surface-hover"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronIcon open={open} />
          <span className="min-w-0 flex-1 truncate text-left">{folder.name}</span>
          <span className="shrink-0 tabular-nums">{rows.length}</span>
        </button>
        <RowMenu label={`Folder options for ${folder.name}`}>
          {(close) => (
            <>
              <MenuButton
                onClick={() => {
                  close();
                  setRenaming(true);
                }}
              >
                Rename
              </MenuButton>
              <MenuButton
                danger
                onClick={() => {
                  close();
                  void library.deleteFolder(folder.id).catch(() => {
                    setError("Could not delete the folder.");
                  });
                }}
              >
                Delete folder (keeps its conversations)
              </MenuButton>
            </>
          )}
        </RowMenu>
      </div>
      {renaming && (
        <InlineNameForm
          label={`New name for ${folder.name}`}
          initial={folder.name}
          maxLength={80}
          onSubmit={rename}
          onCancel={() => setRenaming(false)}
        />
      )}
      {error && (
        <p role="alert" className="px-2 text-xs text-mw-danger">
          {error}
        </p>
      )}
      {open && (
        <ul aria-label={`Conversations in ${folder.name}`} className="pb-1">
          {rows.length === 0 && (
            <li className="px-4 py-1 text-xs text-mw-text-muted">Empty</li>
          )}
          {rows.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} library={library} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NewFolderControl(props: { library: LibraryModel }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="px-2 py-1">
      {adding ? (
        <InlineNameForm
          label="New folder name"
          placeholder="Folder name"
          initial=""
          maxLength={80}
          onSubmit={async (name) => {
            try {
              await props.library.createFolder(name);
              setAdding(false);
              setError(null);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Could not create the folder.");
            }
          }}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="w-full rounded-md px-2 py-1 text-left text-xs text-mw-text-muted hover:bg-mw-surface-hover pointer-coarse:min-h-11"
          onClick={() => setAdding(true)}
        >
          + New folder
        </button>
      )}
      {error && (
        <p role="alert" className="px-2 text-xs text-mw-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A one-field form with its label over the field and Save and Cancel under
 * it: Enter saves, Escape cancels, the field is focused on mount. The
 * buttons are there for the person who does not know the keys -- a bare
 * box that appeared under "+ New folder" with no name and no way out but
 * guessing read as a glitch.
 */
function InlineNameForm(props: {
  label: string;
  placeholder?: string;
  initial: string;
  maxLength: number;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <form
      className="flex flex-col gap-1 px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        const name = value.trim();
        if (name) void props.onSubmit(name);
      }}
    >
      <label htmlFor={inputId} className="text-xs text-mw-text-muted">
        {props.label}
      </label>
      <input
        ref={ref}
        id={inputId}
        type="text"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={value}
        maxLength={props.maxLength}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
          }
        }}
        /* 16px below the md breakpoint, as the composer: Safari zooms a
           field under 16px on focus and never zooms back. */
        className="w-full rounded-md border border-mw-border bg-mw-surface px-2 py-1 text-base placeholder:text-mw-text-muted focus:border-mw-focus focus:outline-none md:text-xs"
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded px-2 py-1 text-xs hover:bg-mw-surface-hover pointer-coarse:min-h-11"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded bg-mw-accent px-2 py-1 text-xs font-medium text-mw-accent-foreground hover:bg-mw-accent/85 disabled:opacity-40 pointer-coarse:min-h-11"
        >
          Save
        </button>
      </div>
    </form>
  );
}

// --- archive ----------------------------------------------------------------------

/**
 * Archived conversations, behind a collapsed disclosure at the
 * foot of the sidebar rather than a filter control at its head.
 *
 * A section, not a filter, because archiving is the rarely-undone half of a
 * lopsided pair: a filter puts a persistent control in front of every user to
 * serve the occasional trip to the archive, and leaves the sidebar in a mode
 * that a user who forgot they set it reads as "my conversations are gone".
 * A disclosure costs one line when closed, is stateless when it is, and
 * cannot be left switched on by accident. It fetches only when opened, so the
 * default sidebar is still one request.
 */
function ArchivedSection(props: { library: LibraryModel }) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [archived, setArchived] = useState<Conversation[] | null>(null);
  // The id, not the server's prose: this section used to print the raw
  // message straight into the sidebar.
  const [error, setError] = useState<{ requestId: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      // The list is paged; the archive asks for the largest page the server
      // allows rather than paging a disclosure that is rarely opened.
      const page = await apiFetch<{ data: Conversation[] }>(
        "/api/conversations?filter=archived&limit=200",
      );
      setError(null);
      setArchived(page.data);
    } catch (err) {
      setError({ requestId: err instanceof ApiError ? err.requestId : null });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Re-fetched when the main list changes too: unarchiving a row from here
    // has to remove it from here, and archiving one elsewhere has to add it.
  }, [open, load, shell.conversations]);

  return (
    <div className="border-t border-mw-border px-2 py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-mw-text-muted hover:bg-mw-surface-hover pointer-coarse:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon open={open} />
        Archived
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto">
          {error && (
            <div role="alert" className="px-2 py-1 text-xs text-mw-danger">
              <p>The archive could not be loaded.</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-0.5 underline hover:no-underline"
              >
                Try again
              </button>
              <p className="mt-0.5 text-mw-text-muted">
                <RequestReference requestId={error.requestId} />
              </p>
            </div>
          )}
          {/* Open but nothing back yet. Without this the disclosure shows an
              empty box that is indistinguishable from an empty archive — the
              "is it loading or is it broken?" failure, in miniature. */}
          {!error && archived === null && (
            <p role="status" className="px-2 py-1 text-xs text-mw-text-muted">
              Loading the archive…
            </p>
          )}
          {!error && archived !== null && archived.length === 0 && (
            <p className="px-2 py-1 text-xs text-mw-text-muted">Nothing archived.</p>
          )}
          <ul>
            {(archived ?? []).map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                library={props.library}
                archived
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The foot of the list while the server has more. A button, so the next
 * page is one click away wherever it is rendered; and where the browser has
 * IntersectionObserver, scrolling it into view asks for the page without the
 * click. Nothing is drawn once the last page is in.
 */
function LoadMoreControl() {
  const shell = useShell();
  const hasMore = shell.conversationsHasMore ?? false;
  const loading = shell.conversationsLoadingMore ?? false;
  const loadMore = shell.loadMoreConversations;
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMore || loading || !loadMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  if (!hasMore || !loadMore) return null;
  return (
    <div ref={sentinel} className="px-2 pb-3">
      <button
        type="button"
        disabled={loading}
        onClick={() => void loadMore()}
        className="w-full rounded-md px-2 py-1 text-left text-xs text-mw-text-muted hover:bg-mw-surface-hover disabled:cursor-default"
      >
        {loading ? "Loading more…" : "Load more"}
      </button>
      {shell.conversationsMoreError && (
        <p role="alert" className="px-2 text-xs text-mw-danger">
          More could not be loaded.{" "}
          <RequestReference requestId={shell.conversationsMoreError.requestId} />
        </p>
      )}
    </div>
  );
}

// --- one row -------------------------------------------------------------------------

function ConversationRow(props: {
  conversation: Conversation;
  library: LibraryModel;
  archived?: boolean;
}) {
  const { conversation, archived, library } = props;
  const shell = useShell();
  const onNavigate = useContext(SidebarNavigate);
  const pinned = Boolean(conversation.pinned_at);
  const active = conversation.id === shell.activeConversationId;
  const tagIds = library.assignments[conversation.id] ?? [];
  const tags = tagIds
    .map((id) => library.tags.find((t) => t.id === id))
    .filter((t): t is Tag => t !== undefined);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Delete asks first, in the app's one destructive confirm (the same the
  // delete chord opens): it is the one row action with no way back.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Enter and Escape unmount the field, and focus would fall to <body>: a
  // keyboard user who renamed a row would start again from the top of the
  // page. It goes back to the row's own link instead. A blur is the person
  // moving on, so focus is left where they put it.
  const linkRef = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) return;
    refocus.current = false;
    linkRef.current?.focus();
  }, [renaming]);
  // The field takes the row's place rather than opening under it: the
  // name being edited is the one on the row, and two copies of it would
  // leave the person wondering which one wins.
  if (renaming) {
    return (
      <li>
        <RowRenameField
          conversation={conversation}
          onDone={(returnFocus) => {
            refocus.current = returnFocus;
            setRenaming(false);
          }}
          onError={setRenameError}
        />
      </li>
    );
  }

  const confirmDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    shell
      .deleteConversation(conversation.id)
      .then(() => setConfirmingDelete(false))
      // A refused delete leaves the row; it says so on the row rather than
      // looking like a click that did nothing.
      .catch(() => {
        setConfirmingDelete(false);
        setDeleteError(`${conversation.title} could not be deleted. Try again.`);
      })
      .finally(() => setDeleting(false));
  };

  return (
    <li className="group flex flex-wrap items-center">
      {renameError && (
        <p role="alert" className="w-full px-2 text-xs text-mw-danger">
          {renameError}
        </p>
      )}
      {deleteError && (
        <p role="alert" className="w-full px-2 text-xs text-mw-danger">
          {deleteError}
        </p>
      )}
      <a
        ref={linkRef}
        href={conversationHref(conversation.id)}
        aria-current={active ? "page" : undefined}
        className={`flex min-w-0 flex-1 flex-col rounded-md px-2.5 py-1.5 text-sm pointer-coarse:min-h-11 pointer-coarse:justify-center ${
          active
            ? "bg-mw-selection font-medium text-mw-selection-foreground shadow-selected"
            : "text-mw-text-secondary hover:bg-mw-surface-hover hover:text-mw-text"
        }`}
        title={conversation.title}
        onClick={(event) => {
          // A modified click is the browser's: a new tab, a new window.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          shell.selectConversation(conversation.id);
          writeConversationUrl(conversation.id, "push");
          onNavigate?.();
        }}
      >
        <span className="flex min-w-0 items-center gap-1">
          {pinned && <PinIcon filled />}
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        </span>
        {tags.length > 0 && (
          <span className="mt-0.5 flex flex-wrap gap-1" aria-label="Tags">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full border border-mw-border px-1.5 text-xs leading-4 text-mw-text-muted"
              >
                {tag.name}
              </span>
            ))}
          </span>
        )}
      </a>
      {/* Every row action behind one button: four icons on every row were
          four things to aim between, and hid the title they belong to. */}
      <RowMenu label={`Actions for ${conversation.title}`}>
        {(close) => (
          <>
            <MenuButton
              label={`${pinned ? "Unpin" : "Pin"} ${conversation.title}`}
              onClick={() => {
                close();
                void shell.setPinned(conversation.id, !pinned);
              }}
            >
              {pinned ? "Unpin" : "Pin"}
            </MenuButton>
            {shell.renameConversation && (
              <MenuButton
                label={`Rename ${conversation.title}`}
                onClick={() => {
                  close();
                  setRenameError(null);
                  setRenaming(true);
                }}
              >
                Rename…
              </MenuButton>
            )}
            <MenuButton
              label={`${archived ? "Unarchive" : "Archive"} ${conversation.title}`}
              onClick={() => {
                close();
                void shell.setArchived(conversation.id, !archived);
              }}
            >
              {archived ? "Unarchive" : "Archive"}
            </MenuButton>
            <MenuButton
              danger
              label={`Delete ${conversation.title}`}
              onClick={() => {
                close();
                setDeleteError(null);
                setConfirmingDelete(true);
              }}
            >
              Delete…
            </MenuButton>
            <div role="separator" className="my-1 border-t border-mw-border" />
            <OrganiseItems conversation={conversation} library={library} tagIds={tagIds} />
          </>
        )}
      </RowMenu>
      <DestructiveConfirm
        open={confirmingDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmingDelete(next);
        }}
        title="Delete this conversation?"
        description={
          <>
            <span className="font-medium">{conversation.title}</span> and its messages are deleted.
            This cannot be undone; archive it instead to keep it out of the list.
          </>
        }
        confirmLabel="Delete"
        inFlight={deleting}
        onConfirm={confirmDelete}
      />
    </li>
  );
}

/**
 * The row's title, editable in place. Enter and blur save, Escape cancels.
 *
 * Blur saves, where the folder form cancels: a person who types a name and
 * clicks on the conversation expects the name to stick, and losing it to a
 * stray click is the one outcome worse than a typo. An unchanged or empty
 * name is a cancel either way -- there is nothing to send -- and Enter
 * followed by the blur it causes commits once, not twice.
 */
function RowRenameField(props: {
  conversation: Conversation;
  /** Once: whether focus should go back to the row (a key) or stay where it went (a blur). */
  onDone: (returnFocus: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const { conversation } = props;
  const shell = useShell();
  const [value, setValue] = useState(conversation.title);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function finish(save: boolean, returnFocus: boolean) {
    if (settled.current) return;
    settled.current = true;
    const name = value.trim();
    props.onDone(returnFocus);
    if (!save || !name || name === conversation.title || !shell.renameConversation) return;
    void shell.renameConversation(conversation.id, name).then(
      () => props.onError(null),
      (err: unknown) =>
        props.onError(err instanceof ApiError ? err.message : "Could not rename the conversation."),
    );
  }

  return (
    <form
      className="px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        finish(true, true);
      }}
    >
      <input
        ref={ref}
        type="text"
        aria-label={`New name for ${conversation.title}`}
        value={value}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false, true);
          }
        }}
        onBlur={() => finish(true, false)}
        /* 16px below the md breakpoint, as the composer: Safari zooms a
           field under 16px on focus and never zooms back. */
        className="w-full rounded-md border border-mw-border bg-mw-surface px-2 py-1 text-base focus:border-mw-focus focus:outline-none md:text-sm"
      />
    </form>
  );
}

/**
 * "Move to…" and the tag toggles for one row, inside the row menu, needing no
 * dragging: a folder is a click, a tag is a checkbox, and a new one of
 * either is typed right there.
 */
function OrganiseItems(props: { conversation: Conversation; library: LibraryModel; tagIds: string[] }) {
  const { conversation, library, tagIds } = props;
  const [error, setError] = useState<string | null>(null);

  function attempt(work: Promise<unknown>, failure: string) {
    void work.then(
      () => setError(null),
      (err: unknown) => setError(err instanceof ApiError ? err.message : failure),
    );
  }

  return (
    <>
      <p className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
        Move to
      </p>
      <MenuButton
        current={!conversation.folder_id}
        onClick={() =>
          attempt(library.moveConversation(conversation.id, null), "Could not move it.")
        }
      >
        No folder
      </MenuButton>
      {library.folders.map((folder) => (
        <MenuButton
          key={folder.id}
          current={conversation.folder_id === folder.id}
          onClick={() =>
            attempt(library.moveConversation(conversation.id, folder.id), "Could not move it.")
          }
        >
          {folder.name}
        </MenuButton>
      ))}
      <MenuNameForm
        label={`New folder for ${conversation.title}`}
        placeholder="New folder…"
        maxLength={80}
        onSubmit={async (name) => {
          const folder = await library.createFolder(name);
          await library.moveConversation(conversation.id, folder.id);
        }}
        onError={setError}
      />
      <p className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
        Tags
      </p>
      {library.tags.length === 0 && (
        <p className="px-2 pb-1 text-xs text-mw-text-muted">No tags yet.</p>
      )}
      {library.tags.map((tag) => {
        const on = tagIds.includes(tag.id);
        return (
          <label
            key={tag.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-mw-surface-hover"
          >
            <input
              type="checkbox"
              className="accent-mw-accent"
              checked={on}
              aria-label={`${on ? "Remove tag" : "Add tag"} ${tag.name} on ${conversation.title}`}
              onChange={() =>
                attempt(
                  library.setTags(
                    conversation.id,
                    on ? tagIds.filter((id) => id !== tag.id) : [...tagIds, tag.id],
                  ),
                  "Could not change the tags.",
                )
              }
            />
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
          </label>
        );
      })}
      <MenuNameForm
        label={`New tag for ${conversation.title}`}
        placeholder="New tag…"
        maxLength={40}
        onSubmit={async (name) => {
          const tag = await library.createTag(name);
          if (!tagIds.includes(tag.id)) await library.setTags(conversation.id, [...tagIds, tag.id]);
        }}
        onError={setError}
      />
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-mw-danger">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * A row's popup, on the shared popover: it is portalled out of the sidebar's
 * scroller and placed against the viewport, so a menu opened on the last row
 * flips up instead of opening below the screen, and one in the 256px column
 * is never clipped by it.
 *
 * The trigger is hidden until the row is hovered or holds focus -- a
 * keyboard user cannot hover, and `display: none` takes a button out of the
 * tab order -- and always shown where there is no hover (styles.css) and
 * while the menu is open, since the popup is anchored to it.
 */
function RowMenu(props: {
  label: string;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={props.label}
        title={props.label}
        className={`ml-1 shrink-0 cursor-pointer rounded p-1.5 text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text pointer-coarse:size-11 pointer-coarse:p-0 ${
          open ? "block" : "hidden group-hover:block group-focus-within:block"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="mx-auto block" aria-hidden>
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={props.label}
        className="max-h-[min(24rem,var(--available-height))] w-56 gap-0 overflow-y-auto rounded-md border border-mw-border bg-mw-surface-raised p-1 text-mw-text shadow-lg ring-0"
      >
        {typeof props.children === "function" ? props.children(close) : props.children}
      </PopoverContent>
    </Popover>
  );
}

function MenuButton(props: {
  children: React.ReactNode;
  onClick: () => void;
  current?: boolean;
  danger?: boolean;
  /** The accessible name, where the visible word needs the row's title beside it. */
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-current={props.current ? "true" : undefined}
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-mw-surface-hover pointer-coarse:py-3 pointer-coarse:text-sm ${
        props.danger ? "text-mw-danger" : ""
      }`}
    >
      <span className="w-3 shrink-0 text-mw-link" aria-hidden>
        {props.current ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
    </button>
  );
}

function MenuNameForm(props: {
  label: string;
  placeholder: string;
  maxLength: number;
  onSubmit: (name: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        const name = value.trim();
        if (!name) return;
        void props.onSubmit(name).then(
          () => {
            setValue("");
            props.onError(null);
          },
          (err: unknown) =>
            props.onError(err instanceof ApiError ? err.message : "Could not save that."),
        );
      }}
    >
      <input
        type="text"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={value}
        maxLength={props.maxLength}
        onChange={(event) => setValue(event.target.value)}
        className="w-full rounded-md border border-mw-border bg-mw-surface px-2 py-1 text-xs placeholder:text-mw-text-muted focus:border-mw-focus focus:outline-none"
      />
    </form>
  );
}

// --- icons ---------------------------------------------------------------------------

function PinIcon(props: { filled?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      className="shrink-0 text-mw-link"
      aria-hidden
    >
      <path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3-1-6z" />
    </svg>
  );
}

function ChevronIcon(props: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`shrink-0 transition-transform ${props.open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
