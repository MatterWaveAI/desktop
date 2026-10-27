import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useMountedSession } from "./useMountedSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let current: ReturnType<typeof useMountedSession> | null = null;

function Probe(props: { activeId: string | null }) {
  const session = useMountedSession(props.activeId);
  // eslint-disable-next-line react-hooks/globals -- the test reads the hook back
  current = session;
  return null;
}

function render(activeId: string | null): void {
  if (!root) root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe activeId={activeId} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  current = null;
});

describe("the mounted chat session", () => {
  it("stays mounted while a new chat creates its conversation", () => {
    render(null);
    const key = current!.key;
    act(() => current!.created("a"));
    render("a");
    expect(current!.key).toBe(key);
    act(() => current!.settled());
    render("a");
    expect(current!.key).toBe(key);
  });

  it("remounts empty on New chat after the first exchange settled", () => {
    render(null);
    const key = current!.key;
    act(() => current!.created("a"));
    render("a");
    act(() => current!.settled());
    render(null);
    expect(current!.sessionId).toBeNull();
    expect(current!.key).not.toBe(key);
  });

  it("remounts empty on New chat while the first answer is still streaming", () => {
    render(null);
    const key = current!.key;
    act(() => current!.created("a"));
    render("a");
    render(null);
    expect(current!.key).not.toBe(key);
  });

  it("follows a switch to another conversation", () => {
    render("a");
    render("b");
    expect(current!.sessionId).toBe("b");
    expect(current!.key).toBe("b:0");
  });
});
