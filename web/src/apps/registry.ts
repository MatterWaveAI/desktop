import { lazyRouteComponent, type RouteComponent } from "@tanstack/react-router";
import type { FlagName } from "../types";
import { ChatPage } from "./chat/ChatPage";

// Chat is the landing app and stays in the main chunk. The rest are reached
// by few users, or rarely, so each loads as its own chunk on first visit.
const AdminPage = lazyRouteComponent(() => import("./admin/AdminPage"), "AdminPage");
const TokensPage = lazyRouteComponent(() => import("../dev/TokensPage"), "TokensPage");
const StatesPage = lazyRouteComponent(() => import("../dev/StatesPage"), "StatesPage");

export interface AppDescriptor {
  id: string;
  title: string;
  path: string;
  component: RouteComponent;
  /** Set while the app ships behind a flag; hidden from the nav until it is on. */
  flag?: FlagName;
  /**
   * A role from the principal's token (Zitadel project roles) the
   * viewer must hold for the nav to list this app. The API enforces the
   * same role on every route; this only keeps a link nobody can use out
   * of the sidebar.
   */
  role?: string;
}

/**
 * The app registry. Chat registers here like any third-party app would; the
 * shell builds its navigation and the router builds its routes from this
 * list. A static list on purpose: dynamic installation is a separate
 * feature, and nothing here assumes it.
 */
export const apps: readonly AppDescriptor[] = [
  { id: "chat", title: "Chat", path: "/apps/chat", component: ChatPage },
  // The operator's surface: platform admins only, by the `admin`
  // role the identity provider puts in the token, so access is revoked
  // centrally rather than in our database.
  { id: "admin", title: "Admin", path: "/admin", component: AdminPage, role: "admin" },
  // Host-owned design-system page, not a user app: registered
  // so the route tree derives from this list like every other route, flagged
  // so it never shows in end-user nav. The API does not serve `dev_tokens`
  // yet — until it does the page is reachable by URL only.
  {
    id: "dev-tokens",
    title: "Design tokens",
    path: "/dev/tokens",
    component: TokensPage,
    flag: "dev_tokens",
  },
  // Every designed state on one page, so a reviewer can see the
  // gateway-down error without killing the gateway. Same flagged-registry
  // pattern as /dev/tokens: host-owned, never in end-user nav.
  {
    id: "dev-states",
    title: "UI states",
    path: "/dev/states",
    component: StatesPage,
    flag: "dev_states",
  },
];
