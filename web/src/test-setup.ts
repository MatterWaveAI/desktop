import { activateLocale, SOURCE_LOCALE } from "./i18n/locale";

/**
 * Vitest setup. jsdom does not implement window.matchMedia; the shell's
 * theme subscription (and anything else media-query aware) needs it. Tests
 * that care about the answer can vi.stubGlobal a controllable mock on top.
 *
 * The source locale is activated explicitly: jsdom's navigator reports
 * en-US, and matching the device would spell "organization" in every
 * assertion written against the en-GB wording the components carry.
 */
await activateLocale(SOURCE_LOCALE);

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null) => {
        if (listener != null) listeners.add(listener as EventListener);
      },
      removeListener: (
        listener: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null,
      ) => {
        if (listener != null) listeners.delete(listener as EventListener);
      },
      dispatchEvent: () => false,
    };
  };
}
