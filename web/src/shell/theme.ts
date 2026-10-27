import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Three-state theming: the user picks system / light / dark,
 * `system` follows the OS and updates live. "next-themes-style" behaviour
 * without the dependency: the preference lives in localStorage under
 * `mw-theme` (same key the two-state toggle used, so stored "light"/"dark"
 * values keep working), and the resolved theme is the `.dark` class on
 * <html> — which is also what the shiki dual-theme CSS and the
 * `@custom-variant dark` hook into.
 *
 * The pre-paint script in index.html applies the same resolution before
 * first paint, so there is no flash; this module only needs to keep the
 * class in sync afterwards.
 *
 * Dark is the brand's default: with nothing stored the app is dark, and
 * "system" (follow the OS) is a choice the person makes in the account
 * menu, as "light" is.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "mw-theme";
/** What an unset (or unreadable) preference means. */
export const DEFAULT_THEME: ThemePreference = "dark";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "system" || stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // private mode; the default for this page
  }
  return DEFAULT_THEME;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // private mode; the class still applies for this page
  }
  applyTheme(preference);
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

/**
 * useSyncExternalStore subscription: fires when the preference changes (any
 * tab, via the storage event) and when the OS theme changes while the
 * preference is "system" — re-applying the class so the UI follows live.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  const media = window.matchMedia(DARK_QUERY);
  const onSystemChange = () => {
    if (getThemePreference() === "system") {
      applyTheme("system");
      for (const l of listeners) l();
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      applyTheme(getThemePreference());
      for (const l of listeners) l();
    }
  };

  media.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current preference and a setter, as a hook. */
export function useThemePreference(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(
    subscribe,
    getThemePreference,
    () => DEFAULT_THEME,
  );
  const setPreference = useCallback(
    (next: ThemePreference) => setThemePreference(next),
    [],
  );
  // Memoized so the identity is stable: a fresh object here re-renders every
  // consumer of the hook on every render of its owner.
  return useMemo(
    () => ({ preference, resolved: resolveTheme(preference), setPreference }),
    [preference, setPreference],
  );
}
