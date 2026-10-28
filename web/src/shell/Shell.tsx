import { useCallback, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleHelpIcon } from "lucide-react";
import { AnnouncementBanner } from "./AnnouncementBanner";
import { EnforcementBanner } from "./EnforcementBanner";
import { BillingBanner } from "./BillingBanner";
import { SupportBanner } from "../apps/admin/SupportBanner";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import type { AuthConfig, Principal } from "../types";
import { useFlags } from "../lib/flags";
import { apps } from "../apps/registry";
import { ShellContext, useShell, type ShellContextValue } from "./shellContext";
import { useShellState, writeConversationUrl } from "./useShellState";
import { useVisualViewportFix } from "./useVisualViewport";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
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
import { ErrorBoundary } from "../components/AppError";
import { useSupportReadOnly } from "../apps/chat/supportMode";
import { BrandLockup, Wordmark } from "../components/brand";
import { buttonVariants } from "../components/ui/button";
import { navItemVariants } from "../components/ui/nav-item";

/** Tailwind's `md` breakpoint, where the sidebar stops being a drawer. */
const DESKTOP_QUERY = "(min-width: 768px)";

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
        />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-mw-border px-3">
            {/* The drawer toggle on a phone; on a desktop it appears only
                while the column is hidden, as the way to bring it back. */}
            <button
              type="button"
              className={`inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 hover:bg-mw-surface-hover ${sidebarCollapsed ? "" : "md:hidden"}`}
              onClick={toggleSidebar}
              aria-label={t`Toggle sidebar`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {/* The open conversation's title on the chat page, so the header
                says where the reader is; the wordmark elsewhere. */}
            <span
              data-mw-header-title=""
              className="min-w-0 truncate font-heading text-sm font-semibold tracking-tight"
              title={headerTitle ?? undefined}
            >
              {/* From md up the sidebar carries the brand; the header repeats
                  it only while that column is hidden. */}
              {headerTitle ?? <Wordmark size="sm" className={sidebarCollapsed ? "" : "md:hidden"} />}
            </span>
            <ReadyBadge />
            <SyncBadge />
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <button
                type="button"
                className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
                onClick={() => setHelpOpen(true)}
                aria-label={t`Keyboard shortcuts and help`}
                title={t`Keyboard shortcuts and help (?)`}
              >
                <CircleHelpIcon className="size-4" aria-hidden />
              </button>
              <NotificationsMenu />
              <UserMenu onOpenPalette={() => setPaletteOpen(true)} />
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
          {/* "Update available — install": nothing in a browser, where there is no updater. */}
          <UpdateBanner />
          <main className="min-h-0 flex-1">
            <Outlet />
          </main>
        </div>
      </div>
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
}) {
  const { t } = useLingui();
  const flags = useFlags();
  const { principal } = useShell();
  // A support session is read only: there is no new chat to start.
  const readOnly = useSupportReadOnly(principal);
  // Apps shipping behind an off flag stay out of the nav, as do
  // apps that need a role the viewer lacks.
  const visibleApps = apps.filter(
    (app) =>
      (!app.flag || flags[app.flag] === true) && (!app.role || principal.roles.includes(app.role)),
  );
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-(--mw-z-sidebar) flex w-64 shrink-0 flex-col border-r border-mw-border bg-mw-surface-raised transition-transform ${
        props.collapsed ? "md:hidden" : "md:static md:translate-x-0"
      } ${props.open ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center gap-2 px-3 pt-4 pb-1">
        {/* The brand, not a control: New chat and the apps nav below are
            the ways to move, and a link here would be one more Tab stop
            before them. */}
        <div className="min-w-0 flex-1 px-1.5 py-1">
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
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          className={`${buttonVariants()} w-full disabled:pointer-events-auto disabled:cursor-not-allowed`}
          disabled={readOnly}
          title={readOnly ? t`Support sessions are read only` : undefined}
          onClick={() => {
            props.onNewChat();
            props.onClose();
          }}
        >
          <Trans>New chat</Trans>
        </button>
      </div>
      <nav aria-label={t`Apps`} className="px-3 pb-2">
        {visibleApps.map((app) => (
          <Link
            key={app.id}
            to={app.path}
            className={`${navItemVariants()} data-[status=active]:bg-mw-selection data-[status=active]:font-medium data-[status=active]:text-mw-selection-foreground data-[status=active]:shadow-selected`}
          >
            {app.title}
          </Link>
        ))}
      </nav>
      {/* A crash in the list is the list's: the apps nav and New chat above it
          stay usable, and so does the conversation on screen. */}
      <ErrorBoundary name={t`Conversations`}>
        <ConversationSidebar searchRequest={props.searchRequest} onNavigate={props.onClose} />
      </ErrorBoundary>
    </aside>
  );
}
