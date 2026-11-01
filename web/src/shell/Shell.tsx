import { useCallback, useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleHelpIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { AnnouncementBanner } from "./AnnouncementBanner";
import { EnforcementBanner } from "./EnforcementBanner";
import { BillingBanner } from "./BillingBanner";
import { TermsNoticeBanner } from "./TermsNoticeBanner";
import { SupportBanner } from "../apps/admin/SupportBanner";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import type { AuthConfig, Principal } from "../types";
import { useFlags } from "../lib/flags";
import { apps, type AppDescriptor } from "../apps/registry";
import { ShellContext, useShell, type ShellContextValue } from "./shellContext";
import { useShellState, writeChatHref, writeConversationUrl } from "./useShellState";
import { JUMP_TO_MESSAGE_EVENT, type JumpToMessageDetail } from "./useConversationSearch";
import { desktopRecentConversations, registerDesktopShell } from "../lib/desktopNavigation";
import { desktopSetRecentConversations, isDesktop } from "../lib/desktopAuth";
import { useVisualViewportFix } from "./useVisualViewport";
import { AccountSummary, UserMenu } from "./UserMenu";
import { usePlan } from "./account";
import { DESKTOP_QUERY, HeaderSlotContext, useDesktop } from "./headerSlot";
import { ReadyBadge } from "./ReadyBadge";
import { SyncBadge } from "./SyncBadge";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { CommandPalette } from "./CommandPalette";
import { NotificationsMenu } from "./NotificationsMenu";
import { UpdateBanner } from "./UpdateBanner";
import { ConversationSidebar, type SearchRequest } from "./conversationSidebar";
import { CONVERSATION_SEARCH_ID } from "./shortcuts";
import type { PaletteAction } from "./palette";
import { HELP_PATH } from "./help";
import { installAnswerReady, setAnswerReadyFocus } from "./answerReady";
import { ErrorBoundary } from "../components/AppError";
import { useSupportReadOnly } from "../apps/chat/supportMode";
import { BrandLockup, Wordmark } from "../components/brand";
import { buttonVariants } from "../components/ui/button";

export function Shell(props: { authConfig: AuthConfig; principal: Principal }) {
  const { t } = useLingui();
  // Two states for one sidebar, because it is two things. Below `md` it is a
  // drawer that is closed by default and overlays the page; from `md` up it
  // is a column that is always there -- unless the person hides it, which
  // is what `collapsed` is. Keeping them apart means closing the drawer on a
  // phone never hides the column on the laptop the same session opens on.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What the palette's "Search conversations for …" asked the sidebar for.
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const context = useShellState(props);
  const navigate = useNavigate();
  // The chat app is the one page with a composer: the skip link leads to it
  // and the header names the open conversation only there. Elsewhere the
  // first Tab stop is the sidebar's nav, and the header carries the brand.
  const pathname = useLocation({ select: (location) => location.pathname });
  const onChat = pathname.replace(/\/$/, "") === apps[0].path;
  const headerTitle = onChat ? conversationTitle(context, t`New chat`, t`Chat`) : null;
  // From md up the account menu is the sidebar's foot row and the page's
  // own controls join this header; on a phone the header keeps the avatar,
  // since the sidebar is a drawer that is shut.
  const desktop = useDesktop();
  const flags = useFlags();
  // Apps shipping behind an off flag stay out of the switcher, as do apps
  // that need a role the viewer lacks.
  const visibleApps = apps.filter(
    (app) =>
      (!app.flag || flags[app.flag] === true) &&
      (!app.role || props.principal.roles.includes(app.role)),
  );
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useVisualViewportFix();

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia(DESKTOP_QUERY).matches) {
      setSidebarCollapsed((collapsed) => !collapsed);
    } else {
      setSidebarOpen((open) => !open);
    }
  }, []);

  const startNewChat = useCallback(() => {
    context.selectConversation(null);
    // On a phone the drawer is over the page the person asked for.
    setSidebarOpen(false);
    // The chat app is where a new conversation lives; from settings or help
    // the shortcut also goes there, and the route drops any `?c=`.
    void navigate({ to: apps[0].path });
  }, [context, navigate]);

  const focusComposer = useCallback(() => {
    const composer = document.querySelector<HTMLElement>("[data-mw-composer]");
    if (composer) composer.focus();
    else void navigate({ to: apps[0].path });
  }, [navigate]);

  // Open one conversation from anywhere: the chat app reads `?c=` on mount,
  // so from another page the search carries the id across the navigation;
  // on the chat page the row's own click path (select, then rewrite the
  // URL) is what runs.
  const openConversation = useCallback(
    (id: string) => {
      context.selectConversation(id);
      setSidebarOpen(false);
      if (window.location.pathname !== apps[0].path) {
        const search = { c: id };
        void navigate({ to: apps[0].path, search });
      } else {
        writeConversationUrl(id, "push");
      }
    },
    [context, navigate],
  );

  // A conversation link opened from outside the desktop app, or the
  // app's menu and tray: selected the way a sidebar search hit is, so it
  // opens even while another one is on screen, with `?m=` on the address
  // for the chat page to scroll to; New chat is the shell's own.
  useEffect(
    () =>
      registerDesktopShell({
        startNewChat,
        openConversation: (id, message) => {
          if (!message) {
            openConversation(id);
            return;
          }
          const search = { c: id, m: message };
          if (window.location.pathname !== apps[0].path) {
            context.selectConversation(id);
            setSidebarOpen(false);
            void navigate({ to: apps[0].path, search });
            return;
          }
          writeChatHref(`${apps[0].path}?${new URLSearchParams(search)}`, "push");
          context.selectConversation(id);
          setSidebarOpen(false);
          window.dispatchEvent(
            new CustomEvent<JumpToMessageDetail>(JUMP_TO_MESSAGE_EVENT, {
              detail: { conversationId: id, messageId: message },
            }),
          );
        },
      }),
    [context, navigate, openConversation, startNewChat],
  );

  // The desktop tray's recent chats: the conversations the sidebar lists
  // first, ids and titles only. Nothing leaves the page in a browser.
  const recent = desktopRecentConversations(context.conversations);
  useEffect(() => {
    if (!isDesktop()) return;
    desktopSetRecentConversations(JSON.parse(recent)).catch((err: unknown) => {
      console.warn("[desktop] could not update the tray's recent chats", err);
    });
  }, [recent]);

  // An answer that finished while the tab was hidden marks the title and
  // the icon until the person comes back; its notification opens the
  // conversation it belongs to.
  useEffect(() => installAnswerReady(), []);
  useEffect(() => {
    setAnswerReadyFocus(openConversation);
    return () => setAnswerReadyFocus(null);
  }, [openConversation]);

  const onPaletteAction = useCallback(
    (action: PaletteAction) => {
      switch (action.kind) {
        case "new-chat":
          startNewChat();
          break;
        case "conversation":
          openConversation(action.id);
          break;
        case "settings":
          void navigate({ to: "/settings/$paneId", params: { paneId: action.paneId } });
          break;
        case "help":
          void navigate({ to: HELP_PATH });
          break;
        case "shortcuts":
          setHelpOpen(true);
          break;
        case "search":
          // The box lives in the sidebar, so the sidebar has to be on screen
          // for the search to be: the drawer opens on a phone, the column
          // comes back if it was hidden.
          setSidebarCollapsed(false);
          setSidebarOpen(true);
          setSearchRequest((previous) => ({
            query: action.query,
            seq: (previous?.seq ?? 0) + 1,
          }));
          break;
      }
    },
    [navigate, openConversation, startNewChat],
  );

  // The sidebar comes on screen first, as for the palette's search; the box
  // can only take focus once the render that shows it has landed.
  const searchChats = useCallback(() => {
    setSidebarCollapsed(false);
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      const box = document.getElementById(CONVERSATION_SEARCH_ID);
      if (box instanceof HTMLInputElement) {
        box.focus();
        box.select();
      }
    });
  }, []);

  useKeyboardShortcuts({
    "new-chat": startNewChat,
    "search-chats": searchChats,
    "focus-composer": focusComposer,
    "toggle-sidebar": toggleSidebar,
    help: () => setHelpOpen((open) => !open),
    // Open, never toggle: pressed again while it is open the chord lands in
    // the palette's own field, and Escape is the one way out.
    "command-palette": () => setPaletteOpen(true),
  });

  return (
    <ShellContext.Provider value={context}>
      <HeaderSlotContext.Provider value={desktop ? headerSlot : null}>
      <div className="flex h-full overflow-hidden bg-mw-surface text-mw-text">
        {/* The first thing Tab reaches, and invisible until it does. A
            keyboard user lands on the page with the sidebar's whole list
            between them and the box they came to type in; this is the way
            past it. Focus moves rather than the page scrolling to an anchor,
            because the composer is a control, not a section. */}
        {onChat && (
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              focusComposer();
            }}
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-(--mw-z-modal) focus:rounded-md focus:border focus:border-mw-border focus:bg-mw-surface-raised focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-md"
          >
            <Trans>Skip to composer</Trans>
          </a>
        )}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-(--mw-z-scrim) bg-mw-scrim md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}
        <Sidebar
          open={sidebarOpen}
          collapsed={sidebarCollapsed}
          onClose={() => setSidebarOpen(false)}
          onNewChat={startNewChat}
          searchRequest={searchRequest}
          desktop={desktop}
          pathname={pathname}
          apps={visibleApps}
          onOpenPalette={openPalette}
        />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <header
            className={`flex shrink-0 items-center gap-2 border-b border-mw-border px-3 ${
              onChat ? "min-h-14 py-2 md:min-h-17 md:gap-2.5 md:px-7 md:py-3.5" : "h-12"
            }`}
          >
            {/* The drawer toggle on a phone; on a desktop it appears only
                while the column is hidden, as the way to bring it back. */}
            <button
              type="button"
              className={`inline-flex shrink-0 items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 hover:bg-mw-surface-hover ${sidebarCollapsed ? "" : "md:hidden"}`}
              onClick={toggleSidebar}
              aria-label={t`Toggle sidebar`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {/* The open conversation's title on the chat page, in the
                display serif, so the header says where the reader is; the
                wordmark elsewhere. */}
            {headerTitle !== null ? (
              <h1
                data-mw-header-title=""
                className="min-w-0 truncate font-display text-xl leading-tight font-normal tracking-tight md:text-display-sm"
                title={headerTitle}
              >
                {headerTitle}
              </h1>
            ) : (
              <span data-mw-header-title="" className="min-w-0 truncate">
                {/* From md up the sidebar carries the brand; the header repeats
                    it only while that column is hidden. */}
                <Wordmark size="sm" className={sidebarCollapsed ? "" : "md:hidden"} />
              </span>
            )}
            {/* Kept whole: squeezed, a two-word badge wraps into a column
                taller than the header. The title gives up the room instead. */}
            <div className="flex shrink-0 items-center gap-2 empty:hidden">
              <ReadyBadge />
              <SyncBadge />
            </div>
            {/* The page's own controls (the chat's model pill, Share and
                menu) land here on a desktop; see headerSlot.ts. */}
            <div aria-hidden className="min-w-0 flex-1" />
            <div
              ref={setHeaderSlot}
              data-mw-header-slot=""
              className="flex min-w-0 shrink items-center justify-end gap-2 empty:hidden"
            />
            <div className="flex shrink-0 items-center gap-1">
              <NotificationsMenu />
              <button
                type="button"
                className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
                onClick={() => setHelpOpen(true)}
                aria-label={t`Keyboard shortcuts and help`}
                title={t`Keyboard shortcuts and help (?)`}
              >
                <CircleHelpIcon className="size-4" aria-hidden />
              </button>
              {!desktop && (
                <UserMenu onOpenPalette={openPalette} apps={visibleApps} currentPath={pathname} />
              )}
            </div>
          </header>
          <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            conversations={context.conversations}
            onAction={onPaletteAction}
          />
          {/* An operator viewing an org in support mode: read only, until exited. */}
          <SupportBanner />
          <AnnouncementBanner />
          {/* The person's own standing under the acceptable-use policy, if any. */}
          <EnforcementBanner />
          <BillingBanner />
          {/* A minor terms revision since the one accepted: a notice, not the gate. */}
          <TermsNoticeBanner />
          {/* "Update available — install": nothing in a browser, where there is no updater. */}
          <UpdateBanner />
          <main className="min-h-0 flex-1">
            <Outlet />
          </main>
        </div>
      </div>
      </HeaderSlotContext.Provider>
    </ShellContext.Provider>
  );
}

/**
 * What the header calls the chat page: the open conversation's title, or
 * "New chat" before there is one. A conversation the list does not hold (a
 * temporary chat, which is never listed) is still a chat, not a new one.
 * The two fallbacks arrive translated, since this is not a component.
 */
function conversationTitle(context: ShellContextValue, newChat: string, chat: string): string {
  const id = context.activeConversationId;
  if (id === null) return newChat;
  return context.conversations.find((c) => c.id === id)?.title ?? chat;
}

function Sidebar(props: {
  /** The phone drawer is out. */
  open: boolean;
  /** The desktop column is hidden. */
  collapsed: boolean;
  onClose: () => void;
  onNewChat: () => void;
  searchRequest: SearchRequest | null;
  /** At least md: the account row is the account menu's trigger. */
  desktop: boolean;
  pathname: string;
  /** The apps the viewer may open, for the account menu's switcher. */
  apps: readonly AppDescriptor[];
  onOpenPalette: () => void;
}) {
  const { t } = useLingui();
  const { principal } = useShell();
  // A support session is read only: there is no new chat to start.
  const readOnly = useSupportReadOnly(principal);
  // On a phone the header's avatar opens the menu; the row here then only
  // says who is signed in, and needs the plan for that itself.
  const { plan } = usePlan(!props.desktop);
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-(--mw-z-sidebar) flex w-68 max-w-[85vw] shrink-0 flex-col border-r border-mw-border bg-mw-surface-raised transition-transform ${
        props.collapsed ? "md:hidden" : "md:static md:translate-x-0"
      } ${props.open ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center gap-2 px-3.5 pt-4.5 pb-1">
        {/* The brand, not a control: New chat and the list below are the
            ways to move, and a link here would be one more Tab stop before
            them. */}
        <div className="min-w-0 flex-1 px-2 py-1">
          <BrandLockup size="md" />
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 text-mw-text-muted hover:bg-mw-surface-hover md:hidden"
          onClick={props.onClose}
          aria-label={t`Close sidebar`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-3.5">
        <button
          type="button"
          className={`${buttonVariants()} h-11 w-full gap-2 rounded-lg disabled:pointer-events-auto disabled:cursor-not-allowed`}
          disabled={readOnly}
          title={readOnly ? t`Support sessions are read only` : undefined}
          onClick={() => {
            props.onNewChat();
            props.onClose();
          }}
        >
          <PlusIcon aria-hidden className="size-4" strokeWidth={2.2} />
          <Trans>New chat</Trans>
        </button>
      </div>
      {/* A crash in the list is the list's: New chat above it stays usable,
          and so does the conversation on screen. */}
      <ErrorBoundary name={t`Conversations`}>
        <ConversationSidebar searchRequest={props.searchRequest} onNavigate={props.onClose} />
      </ErrorBoundary>
      {/* Who is signed in, on which plan, and the way to settings. The app
          switcher (Chat, and Admin for a platform admin) is in the account
          menu this row opens, not a nav of its own above the list. */}
      <div
        data-mw-account-foot=""
        className="flex shrink-0 items-center gap-1 border-t border-mw-border px-2 pt-2.5 pb-3"
        style={{ paddingBottom: "max(0.75rem, var(--mw-safe-bottom))" }}
      >
        {props.desktop ? (
          <UserMenu
            variant="row"
            apps={props.apps}
            currentPath={props.pathname}
            onOpenPalette={props.onOpenPalette}
          />
        ) : (
          <span className="min-w-0 flex-1 px-1.5 py-1">
            <AccountSummary principal={principal} plan={plan} />
          </span>
        )}
        <a
          href="/settings/account"
          aria-label={t`Settings`}
          title={t`Settings`}
          className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-mw-text-muted outline-none hover:bg-mw-surface-hover hover:text-mw-text focus-visible:ring-2 focus-visible:ring-mw-focus"
        >
          <SettingsIcon aria-hidden className="size-4.5" />
        </a>
      </div>
    </aside>
  );
}
