import { useEffect, useRef, useState } from "react";

/**
 * Which conversation the chat page has mounted, given the one the shell
 * says is open.
 *
 * The mounted id stays put while a new chat creates its own conversation,
 * so the stream is never interrupted by a remount; it follows `activeId`
 * again once the exchange settles. That leaves a session whose id is still
 * null holding a conversation it created, and New chat (`activeId` back to
 * null) then changes nothing the key reads -- the old thread stayed on
 * screen and the next message went into it. So a new chat over such a
 * session bumps a generation the key carries, and the session remounts empty.
 */
export function useMountedSession(activeId: string | null) {
  const [sessionId, setSessionId] = useState<string | null>(activeId);
  const [generation, setGeneration] = useState(0);
  // The conversation a pending creation will answer with; holds the session still.
  const expectedIdRef = useRef<string | null>(null);
  // The conversation the mounted null-id session created, settled or not.
  const createdIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeId === null && sessionId === null && createdIdRef.current !== null) {
      createdIdRef.current = null;
      expectedIdRef.current = null;
      setGeneration((n) => n + 1);
      return;
    }
    if (activeId === sessionId) return;
    // Only a pending creation holds the session still. With nothing pending
    // the ref is null, and a bare `activeId === expectedIdRef.current` would
    // read "new chat" (activeId null) as "the one we are waiting for".
    if (expectedIdRef.current !== null && activeId === expectedIdRef.current) return;
    createdIdRef.current = null;
    setSessionId(activeId);
  }, [activeId, sessionId]);

  return {
    sessionId,
    key: `${sessionId ?? "new"}:${generation}`,
    created: (id: string) => {
      expectedIdRef.current = id;
      createdIdRef.current = id;
    },
    settled: () => {
      expectedIdRef.current = null;
    },
  };
}
