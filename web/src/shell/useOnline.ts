import { useSyncExternalStore } from "react";

/**
 * Whether the browser thinks it has a network.
 *
 * useSyncExternalStore rather than useState + useEffect: the value lives
 * outside React and this is exactly what the hook is for - no effect, no
 * synchronous setState on mount, and it cannot tear between components that
 * read it in the same render.
 *
 * navigator.onLine is a weak signal. True means "an interface is up", not
 * "the API is reachable", so a captive portal or a dead uplink still reads as
 * online. It is worth having because FALSE is reliable: when the browser says
 * offline, sending is guaranteed to fail, and saying so beats a request that
 * times out thirty seconds later.
 */
function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    // Server snapshot: assume online, so nothing renders an offline banner
    // during hydration and then flips.
    () => true,
  );
}
