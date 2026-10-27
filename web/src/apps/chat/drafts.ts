/**
 * Composer drafts, kept per conversation.
 *
 * Why this is a mobile problem: a phone evicts background tabs under
 * memory pressure, aggressively and without warning. A user who types a long
 * message, switches to their mail app to check a detail and comes back finds
 * the tab reloaded from scratch. In-memory React state is gone; anything not
 * written down is lost, and what was lost is the one thing in the app the user
 * actually authored.
 *
 * `localStorage` rather than `sessionStorage`: a reloaded tab is a new session
 * on some browsers, which is exactly the case this exists for.
 *
 * Every access is wrapped. Safari in private mode throws on `setItem` once the
 * quota is reached, and a storage failure must never take the composer down
 * with it — losing a draft is bad, losing the ability to type is worse.
 */

const PREFIX = "mw-draft:";

/** A conversation not yet created shares one key; it is still the user's text. */
function keyFor(conversationId: string | null): string {
  return `${PREFIX}${conversationId ?? "new"}`;
}

export function loadDraft(conversationId: string | null): string {
  try {
    return localStorage.getItem(keyFor(conversationId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(conversationId: string | null, draft: string): void {
  try {
    // An empty draft is a removal, not an empty string: it keeps the key space
    // from filling with blanks for every conversation ever opened.
    if (draft === "") localStorage.removeItem(keyFor(conversationId));
    else localStorage.setItem(keyFor(conversationId), draft);
  } catch {
    // Quota or a disabled store. The draft stays in React state for this
    // session; it simply will not survive an eviction.
  }
}

export function clearDraft(conversationId: string | null): void {
  saveDraft(conversationId, "");
}
