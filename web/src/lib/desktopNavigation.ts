/**
 * The desktop shell sending the SPA somewhere: a `matterwave://` link
 * opened from outside the app (warm, or the one that launched it), a menu
 * or tray item, a click on a notification (src-tauri/src/navigation.rs).
 * The native side keeps one request and announces it as the `navigate`
 * event; this module takes it on start-up and on every event, so the launch
 * link opens once the page is up and a later link opens exactly once.
 *
 * A conversation goes through the signed-in shell when there is one
 * (`registerDesktopShell`): the chat page reads `?c=` only when nothing is
 * open, so a link followed while another conversation is on screen has to
 * select it the way the sidebar does. Before the shell is up -- the launch
 * link, or a signed-out window -- the route itself is the way in, and the
 * front door remembers it across a sign-in.
 *
 * The native side has already refused every shape it does not know; the
 * ids are checked again here because they become part of a URL.
 */
import {
  desktopTakeNavigation,
  isDesktop,
  listenOrWarn,
  type DesktopNavigationTarget,
} from "./desktopAuth";

/** The chat app's route (apps/registry.ts); a test holds the two together. */
export const CHAT_PATH = "/apps/chat";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What the signed-in shell does for a target, in place of a bare navigation. */
export interface DesktopShellActions {
  openConversation: (id: string, message: string | null) => void;
  startNewChat: () => void;
}

let shell: DesktopShellActions | null = null;

/** The shell's actions while it is mounted; the answer unregisters them. */
export function registerDesktopShell(actions: DesktopShellActions): () => void {
  shell = actions;
  return () => {
    if (shell === actions) shell = null;
  };
}

/** How many conversations the tray lists, and how they are chosen. */
const RECENT_LIMIT = 3;

/**
 * The tray's recent chats as a stable string (JSON), so a re-render with
 * the same list sends nothing: the first few conversations not archived,
 * in the sidebar's order, by id and title.
 */
export function desktopRecentConversations(
  conversations: readonly { id: string; title: string; archived_at?: string | null }[],
): string {
  const recent = conversations
    .filter((c) => !c.archived_at && ID.test(c.id))
    .slice(0, RECENT_LIMIT)
    .map(({ id, title }) => ({ id, title }));
  return JSON.stringify(recent);
}

/** The route for a target, or null for anything malformed. */
export function hrefFor(target: DesktopNavigationTarget | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case "conversation": {
      if (!ID.test(target.id)) return null;
      const message = target.message && ID.test(target.message) ? `&m=${target.message}` : "";
      return `${CHAT_PATH}?c=${target.id}${message}`;
    }
    case "share":
      return ID.test(target.token) ? `/share/${target.token}` : null;
    case "billing":
      return "/settings/billing";
    case "new-chat":
      return CHAT_PATH;
    case "settings":
      return "/settings";
    default:
      return null;
  }
}

function open(target: DesktopNavigationTarget | null, navigate: (href: string) => void): void {
  const href = hrefFor(target);
  if (!href || !target) return;
  if (target.kind === "conversation" && shell) {
    shell.openConversation(target.id, target.message && ID.test(target.message) ? target.message : null);
    return;
  }
  // The shell's New chat also empties a conversation that is open; the
  // route alone would leave it on screen.
  if (target.kind === "new-chat" && shell) {
    shell.startNewChat();
    return;
  }
  navigate(href);
}

/**
 * Follow the native side's navigation requests for the life of the page.
 * `navigate` is the router's; nothing happens in a browser.
 */
export function installDesktopNavigation(navigate: (href: string) => void): void {
  if (!isDesktop()) return;
  const take = () => {
    desktopTakeNavigation()
      .then((target) => open(target, navigate))
      .catch((err: unknown) => {
        console.warn("[desktop] could not read the link to open", err);
      });
  };
  // Listen first, then take: a link that lands between the two is still
  // announced, and an announced request already taken answers null.
  listenOrWarn("navigate", take, () => {});
  take();
}
