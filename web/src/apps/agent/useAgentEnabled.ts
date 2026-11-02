import { useEffect, useState } from "react";
import { agentStatus } from "./host";

/**
 * Whether the person has turned agent mode on (the native side's setting,
 * read once per mount). False in a browser and until the answer arrives.
 */
export function useAgentEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void agentStatus().then((status) => {
      if (alive) setEnabled(status.enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}
