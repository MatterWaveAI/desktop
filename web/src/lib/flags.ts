import type { FlagName } from "../types";
import { getAuthConfig } from "./auth";

/**
 * Feature flags arrive in the auth-config payload the boot gate already
 * fetched, so reading them is a lookup, not a request. Config is set
 * before anything mounts and does not change for the session.
 */
export function useFlags(): Partial<Record<FlagName, boolean>> {
  return getAuthConfig()?.flags ?? {};
}

export function useFlag(name: FlagName): boolean {
  return useFlags()[name] === true;
}
