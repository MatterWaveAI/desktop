import { apiFetch } from "./api";
import { loginUrl } from "./auth";
import type { AuthConfig } from "../types";

/**
 * The accounts signed in on this browser (api/matterwave/accounts.py).
 *
 * One of them is acting -- its cookie is the one every request carries --
 * and the rest are parked in cookies of their own. The list is what the
 * envelopes already told this browser (an email, a name, an org name);
 * switching swaps two cookies on the server and the page reloads, so no
 * state of the previous account survives in memory. Adding one is an
 * ordinary sign-in with `?add=true`, which parks the acting cookie first.
 */

export interface AccountEntry {
  /** 0 is the acting account; 1.. are parked. */
  slot: number;
  current: boolean;
  subject: string;
  email: string | null;
  name: string | null;
  org_name: string | null;
}

export interface AccountList {
  accounts: AccountEntry[];
  max: number;
  /** Whether "Add account" is possible: a free slot, or none needed. */
  room: boolean;
}

export async function fetchAccounts(): Promise<AccountList> {
  const body = await apiFetch<Partial<AccountList>>("/api/accounts");
  // Defensive about the shape: a stub or an older API may answer less.
  return {
    accounts: Array.isArray(body.accounts) ? body.accounts : [],
    max: typeof body.max === "number" ? body.max : 4,
    room: body.room !== false,
  };
}

/** Make the parked account in `slot` the acting one. The caller reloads. */
export function switchAccount(slot: number): Promise<{ subject: string; email: string | null }> {
  return apiFetch("/api/accounts/switch", { method: "POST", json: { slot } });
}

/**
 * After a switch: start the SPA over at the root as the new account. A
 * full navigation, not a state reset, so nothing of the previous account
 * can survive in memory. A function so a test can see it was asked for.
 */
export function reloadAsSwitchedAccount(): void {
  location.assign("/");
}

/** Sign one parked account out; the acting one and the rest stay. */
export function signOutParked(slot: number): Promise<void> {
  return apiFetch<void>(`/api/accounts/${slot}/logout`, { method: "POST" });
}

/** Every account on this browser, then the provider's end_session as a plain sign-out. */
export async function signOutAll(config: AuthConfig): Promise<void> {
  let endSession: string | undefined;
  try {
    const body = await apiFetch<{ end_session_endpoint?: string }>("/api/accounts/logout-all", {
      method: "POST",
    });
    endSession = body.end_session_endpoint;
  } catch {
    // The cookies may already be gone; finish at the provider regardless.
  }
  const target = endSession ?? config.end_session_endpoint;
  if (config.auth_mode === "oidc" && target) {
    const url = new URL(target);
    if (config.client_id) url.searchParams.set("client_id", config.client_id);
    url.searchParams.set("post_logout_redirect_uri", `${location.origin}/`);
    location.assign(url.toString());
    return;
  }
  location.assign("/");
}

/** Where "Add account" sends the browser: the login start, parking the acting account. */
export function addAccountUrl(config: AuthConfig): string {
  return `${loginUrl(config)}?add=true`;
}

/** A line naming an account the way a person recognises it. */
export function accountLabel(account: Pick<AccountEntry, "email" | "name" | "subject">): string {
  return account.email ?? account.name ?? account.subject;
}
