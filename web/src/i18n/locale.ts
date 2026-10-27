import { i18n } from "@lingui/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { messages as enGB } from "../locales/en-GB.po";

/**
 * Which language the chrome speaks, and how that is decided.
 *
 * Three locales for now: en-GB is the source (the wording in the components),
 * en-US differs by spelling only, and es-ES is a machine-drafted pilot of the
 * pipeline (docs/i18n.md). The preference is "match device" unless the
 * person picked a language in Settings > Preferences; it is kept in
 * localStorage so the first paint is already in the right language, and on
 * the account (`/api/me/preferences`, `locale`) so it follows them to the
 * next device -- `adoptServerLocale` reconciles the two once a session is
 * known.
 *
 * The source catalogue is in the main bundle, since the English it holds was
 * in the components before; every other locale is its own chunk, fetched the
 * first time it is activated. `<html lang>` and `dir` follow the active
 * locale: screen readers pick pronunciation from the first, and the second
 * is what mirrors the layout when a right-to-left locale arrives.
 */

export const SOURCE_LOCALE = "en-GB";
export type SupportedLocale = "en-GB" | "en-US" | "es-ES";

export interface LocaleOption {
  tag: SupportedLocale;
  /** The language's own name for itself, which is what a person scans for. */
  label: string;
  /** Machine-drafted and not yet reviewed by a native speaker; the label says so. */
  draft?: boolean;
}

export const LOCALES: readonly LocaleOption[] = [
  { tag: "en-GB", label: "English (UK)" },
  { tag: "en-US", label: "English (US)" },
  { tag: "es-ES", label: "Español (borrador)", draft: true },
];

/** The preference that means "whatever the device is set to". */
export const DEVICE_LOCALE = "device";
export type LocalePreference = SupportedLocale | typeof DEVICE_LOCALE;

const STORAGE_KEY = "mw-locale";

/** Languages written right to left, by primary subtag; none is shipped yet. */
const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "ug", "ur", "yi"]);

export function isSupportedLocale(tag: string | null | undefined): tag is SupportedLocale {
  return LOCALES.some((option) => option.tag === tag);
}

export function getLocalePreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {
    // private mode; match the device for this page
  }
  return DEVICE_LOCALE;
}

/**
 * The supported locale closest to what the device asks for: an exact tag
 * first ("en-US"), then the first supported locale in the same language
 * ("es-MX" reads es-ES, "en-AU" reads en-GB), then the source locale.
 */
export function matchDeviceLocale(languages: readonly string[]): SupportedLocale {
  for (const wanted of languages) {
    const exact = LOCALES.find((option) => option.tag.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact.tag;
  }
  for (const wanted of languages) {
    const language = wanted.split("-")[0].toLowerCase();
    const same = LOCALES.find((option) => option.tag.split("-")[0] === language);
    if (same) return same.tag;
  }
  return SOURCE_LOCALE;
}

export function resolveLocale(
  preference: LocalePreference,
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): SupportedLocale {
  return preference === DEVICE_LOCALE ? matchDeviceLocale(languages) : preference;
}

export function directionFor(tag: string): "ltr" | "rtl" {
  return RTL_LANGUAGES.has(tag.split("-")[0].toLowerCase()) ? "rtl" : "ltr";
}

export function currentLocale(): SupportedLocale {
  return isSupportedLocale(i18n.locale) ? i18n.locale : SOURCE_LOCALE;
}

// The source catalogue ships in the main chunk; the rest are their own.
i18n.load(SOURCE_LOCALE, enGB);
const loaded = new Set<SupportedLocale>([SOURCE_LOCALE]);
const loaders: Record<Exclude<SupportedLocale, typeof SOURCE_LOCALE>, () => Promise<typeof import("*.po")>> = {
  "en-US": () => import("../locales/en-US.po"),
  "es-ES": () => import("../locales/es-ES.po"),
};

export function applyDocumentLocale(tag: SupportedLocale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = tag;
  document.documentElement.dir = directionFor(tag);
}

/**
 * Switch the running app to `tag`, fetching its catalogue the first time.
 * A chunk that will not load (offline, or a deploy moved it) leaves the app
 * in the source locale rather than without a language at all.
 */
export async function activateLocale(tag: SupportedLocale): Promise<SupportedLocale> {
  let next = tag;
  if (!loaded.has(tag)) {
    try {
      const { messages } = await loaders[tag as keyof typeof loaders]();
      i18n.load(tag, messages);
      loaded.add(tag);
    } catch (err) {
      console.warn(`[i18n] could not load the ${tag} catalogue; staying in ${SOURCE_LOCALE}`, err);
      next = SOURCE_LOCALE;
    }
  }
  if (i18n.locale !== next) i18n.activate(next);
  applyDocumentLocale(next);
  for (const listener of listeners) listener();
  return next;
}

/** Before the first render: the stored preference, or the device's language. */
export function initLocale(): Promise<SupportedLocale> {
  return activateLocale(resolveLocale(getLocalePreference()));
}

/** Remember the choice on this device and apply it now. */
export async function setLocalePreference(preference: LocalePreference): Promise<SupportedLocale> {
  try {
    if (preference === DEVICE_LOCALE) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // private mode; the catalogue still applies for this page
  }
  for (const listener of listeners) listener();
  return activateLocale(resolveLocale(preference));
}

/**
 * The account's saved preference, as the API answers it: a tag, or null for
 * "match device". Applied when it differs from what this device remembers,
 * so a language picked on one device is spoken on the next. A tag this
 * build does not ship is left alone.
 */
export async function adoptServerLocale(saved: string | null | undefined): Promise<void> {
  if (saved && !isSupportedLocale(saved)) return;
  const preference: LocalePreference = isSupportedLocale(saved) ? saved : DEVICE_LOCALE;
  if (preference === getLocalePreference()) return;
  await setLocalePreference(preference);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) void activateLocale(resolveLocale(getLocalePreference()));
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference and the locale it resolves to, as a hook. */
export function useLocalePreference(): {
  preference: LocalePreference;
  locale: SupportedLocale;
  setPreference: (preference: LocalePreference) => Promise<SupportedLocale>;
} {
  const preference = useSyncExternalStore(
    subscribe,
    getLocalePreference,
    (): LocalePreference => DEVICE_LOCALE,
  );
  const locale = useSyncExternalStore(subscribe, currentLocale, (): SupportedLocale => SOURCE_LOCALE);
  const setPreference = useCallback((next: LocalePreference) => setLocalePreference(next), []);
  return useMemo(() => ({ preference, locale, setPreference }), [preference, locale, setPreference]);
}
