import { createContext, useContext } from "react";
import type { AuthConfig, Conversation, ConversationFilter, Principal } from "../types";

export interface ShellContextValue {
  authConfig: AuthConfig;
  principal: Principal;
  conversations: Conversation[];
  conversationsLoading: boolean;
  /**
   * Set when the list request failed, carrying only the correlation id.
   * The sidebar owns the wording; this says "it broke" and
   * "here is what to quote", which is everything a caller may render.
   */
  conversationsError: { requestId: string | null } | null;
  activeConversationId: string | null;
  selectConversation: (id: string | null) => void;
  deleteConversation: (id: string) => Promise<void>;
  /**
   * Pin and archive are PUT/DELETE on the conversation, so the
   * caller states the state it wants rather than toggling — a double-click
   * cannot land in the opposite one.
   */
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  /**
   * Rename, optimistically: the row shows the new title at once and is
   * replaced from the server's answer; a refusal puts the old title back and
   * rethrows, so the caller can say so where the person is looking. Optional
   * for the same reason as `updatePrincipal`: a harness that mounts one pane
   * need not provide it.
   */
  renameConversation?: (id: string, title: string) => Promise<void>;
  /** Which slice the sidebar is showing; `default` is unarchived, pinned first. */
  listFilter: ConversationFilter;
  setListFilter: (filter: ConversationFilter) => void;
  onConversationCreated: (conversation: Conversation) => void;
  onConversationRenamed: (id: string, title: string) => void;
  reloadConversations: () => Promise<void>;
  /**
   * The list is one page at a time. `conversationsHasMore` says the server
   * has a page after the loaded rows; `loadMoreConversations` appends it.
   * Optional so a harness that mounts one pane need not provide them.
   */
  conversationsHasMore?: boolean;
  conversationsLoadingMore?: boolean;
  conversationsMoreError?: { requestId: string | null } | null;
  loadMoreConversations?: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Fold a change the person just saved (a rename) into the principal the
   * shell shows, without a reload. Optional so a harness that mounts one
   * pane need not provide it; a pane that saves falls back to its own copy.
   */
  updatePrincipal?: (patch: Partial<Principal>) => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside the app shell");
  return value;
}
