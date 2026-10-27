import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { useBranchedThread } from "./useBranchedThread";

/**
 * Edit and regenerate over a real SSE stream, and switching branches
 * without one.
 *
 * `fetch` is stubbed with a scripted event-stream body, so the hook is driven
 * through exactly the frames the API sends -- `message`, deltas, `done`.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

let clock = 0;

function msg(id: string, parent_id: string | null, role: "user" | "assistant"): Message {
  clock += 1;
  return {
    id,
    conversation_id: "c1",
    role,
    content: id,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    parent_id,
    model: null,
  };
}

/** q1 -> a1, with a1 regenerated as a1b. */
function tree(): Message[] {
  clock = 0;
  return [msg("q1", null, "user"), msg("a1", "q1", "assistant"), msg("a1b", "q1", "assistant")];
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Capture the hook's return value across renders. */
type Hook = ReturnType<typeof useBranchedThread>;

function mount(args: Parameters<typeof useBranchedThread>[0]): { current: Hook } {
  const ref = { current: null as unknown as Hook };
  function Probe() {
    ref.current = useBranchedThread(args);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return ref;
}

const base = {
  conversationId: "c1",
  getModel: () => null,
  onError: () => {},
};

describe("the rendered path", () => {
  it("renders the branch the server recorded", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1"]);
  });

  it("falls back to the newest leaf with no cursor", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: null });
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1b"]);
  });

  it("carries the sibling count for the switcher", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    const [q1, a1] = hook.current.path;
    expect(q1.branch).toBeNull(); // an only child needs no switcher
    expect(a1.branch).toMatchObject({ index: 0, total: 2 });
  });
});

describe("switching branches", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  it("re-renders the other branch", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    act(() => {
      hook.current.switchBranch(hook.current.path[1].message, +1);
    });
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1b"]);
  });

  it("does not block on the network: the path is already the new one", () => {
    // The PUT that records the cursor is fire-and-forget, so the render above
    // happened without awaiting anything. Proven by asserting the new path
    // synchronously inside the same act() as the click.
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    act(() => {
      hook.current.switchBranch(hook.current.path[1].message, +1);
      // No await, no flush -- if a fetch were on the critical path this would
      // still show the old branch.
    });
    expect(hook.current.leafId).toBe("a1b");
  });

  it("records the choice for the next load", async () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    await act(async () => {
      hook.current.switchBranch(hook.current.path[1].message, +1);
    });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("/api/conversations/c1/active-leaf");
    expect(calls[0][1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(calls[0][1].body)).toEqual({ message_id: "a1b" });
  });

  it("stays put at the end of the siblings", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    act(() => {
      hook.current.switchBranch(hook.current.path[1].message, -1);
    });
    expect(hook.current.leafId).toBe("a1");
  });
});

describe("edit", () => {
  it("streams a new turn onto a new branch and keeps the original", async () => {
    const edited = msg("q1b", null, "user");
    const answer = { ...msg("a2", "q1b", "assistant"), content: "answer" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("message", edited),
              frame("delta", { content: "ans" }),
              frame("delta", { content: "wer" }),
              frame("done", answer),
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );

    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    await act(async () => {
      await hook.current.edit("q1", "q1b");
    });

    // The thread shows the edited branch...
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1b", "a2"]);
    // ...and the original question and its answers are still in the tree.
    expect(hook.current.tree.map((m) => m.id).sort()).toEqual(
      ["a1", "a1b", "a2", "q1", "q1b"].sort(),
    );
    expect(hook.current.phase).toBe("idle");
  });

  it("posts to the edit route with the new content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sseBody([frame("done", msg("a2", "q1", "assistant"))]), {
            status: 200,
          }),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1" });
    await act(async () => {
      await hook.current.edit("q1", "a different question");
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/conversations/c1/messages/q1/edit");
    expect(JSON.parse(init.body)).toEqual({ content: "a different question" });
  });

  it("reports an error frame and leaves no half-written bubble", async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("message", msg("q1b", null, "user")),
              frame("delta", { content: "par" }),
              frame("error", { detail: "the gateway died" }),
            ]),
            { status: 200 },
          ),
      ),
    );

    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1", onError });
    await act(async () => {
      await hook.current.edit("q1", "q1b");
    });

    expect(onError).toHaveBeenCalledWith("the gateway died", {
      requestId: null,
      code: undefined,
    });
    expect(hook.current.tree.some((m) => m.id.startsWith("pending-"))).toBe(false);
    expect(hook.current.phase).toBe("idle");
  });

  /**
   * The dropped-stream guard, which this hook was missing.
   *
   * `chatAdapter` grew a `sawTerminal` flag because a body that simply ENDS —
   * the ordinary case on a phone — produced no `done`, no `error` and no
   * exception, and so rendered a half answer formatted exactly like a whole
   * one. Edit and regenerate stream the same shape over a different route and
   * had no such check: the fix had been applied to one of the three paths
   * that need it.
   */
  it("reports a stream that ends mid-answer instead of keeping the partial", async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("message", msg("q1b", null, "user")),
              frame("delta", { content: "half an ans" }),
              // ...and then nothing. No done, no error, the connection is gone.
            ]),
            { status: 200, headers: { "X-Request-Id": "req-branch-cut" } },
          ),
      ),
    );

    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1", onError });
    await act(async () => {
      await hook.current.edit("q1", "q1b");
    });

    // It says so, rather than passing for a finished answer.
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatch(/connection dropped/i);
    // With the id of the response it came from, which only the open call knew.
    expect(onError.mock.calls[0][1]?.requestId).toBe("req-branch-cut");
    // The truncated bubble is gone, not left looking authoritative...
    expect(hook.current.tree.some((m) => m.id.startsWith("pending-"))).toBe(false);
    // ...and the cursor is back on a branch that exists.
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1b"]);
    expect(hook.current.phase).toBe("idle");
  });

  it("stays silent when the stream ends properly", async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sseBody([frame("done", msg("a2", "q1", "assistant"))]), { status: 200 }),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1", onError });
    await act(async () => {
      await hook.current.edit("q1", "q1b");
    });
    // The truncation guard must not double-report a clean finish.
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a moderation block as a refusal, not a dropped connection", async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("moderation_block", {
                detail: "MatterWave would not send this.",
                code: "moderation",
                request_id: "req-blocked-branch",
              }),
            ]),
            { status: 200 },
          ),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1", onError });
    await act(async () => {
      await hook.current.edit("q1", "something blocked");
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).not.toMatch(/connection dropped/i);
    expect(onError.mock.calls[0][1]).toMatchObject({
      code: "moderation",
      requestId: "req-blocked-branch",
    });
  });
});

describe("regenerate", () => {
  it("adds a sibling under the same user message", async () => {
    const answer = { ...msg("a1c", "q1", "assistant"), content: "third answer" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("message", tree()[0]), // the user turn being answered again
              frame("delta", { content: "third answer" }),
              frame("done", answer),
            ]),
            { status: 200 },
          ),
      ),
    );

    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1b" });
    await act(async () => {
      await hook.current.regenerate("a1b");
    });

    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1c"]);
    // Three answers now share the one question, so the switcher reads 3/3.
    expect(hook.current.path[1].branch).toMatchObject({ index: 2, total: 3 });
  });

  it("posts to the regenerate route with no content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sseBody([frame("done", msg("a1c", "q1", "assistant"))]), {
            status: 200,
          }),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1b" });
    await act(async () => {
      await hook.current.regenerate("a1b");
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/conversations/c1/messages/a1b/regenerate");
    expect(JSON.parse(init.body)).toEqual({});
  });

  /**
   * Regenerate used to be offered on the last reply only, on the theory that
   * a sibling under an earlier answer "would strand everything below". The
   * tree never lost anything: the old continuation stays under the old
   * reply, and the switcher walks back to it.
   */
  it("on a middle reply: a sibling, the rows below leave the path, and the switcher brings them back", async () => {
    // q1 -> a1 -> q2 -> a2, with a2 the leaf on screen.
    clock = 0;
    const line = [
      msg("q1", null, "user"),
      msg("a1", "q1", "assistant"),
      msg("q2", "a1", "user"),
      msg("a2", "q2", "assistant"),
    ];
    const again = { ...msg("a1b", "q1", "assistant"), content: "a1, again" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/regenerate")
          ? new Response(
              sseBody([
                frame("message", line[0]),
                frame("delta", { content: "a1, again" }),
                frame("done", again),
              ]),
              { status: 200 },
            )
          : new Response("{}", { status: 200 }),
      ),
    );

    const hook = mount({ ...base, initialTree: line, initialLeaf: "a2" });
    await act(async () => {
      await hook.current.regenerate("a1");
    });

    // The new sibling is the leaf: q2 and a2 are off the path, not gone.
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1b"]);
    expect(hook.current.path[1].branch).toMatchObject({ index: 1, total: 2 });
    expect(hook.current.tree.map((m) => m.id).sort()).toEqual(["a1", "a1b", "a2", "q1", "q2"]);

    // Back one sibling restores the whole old continuation, newest leaf first.
    act(() => {
      hook.current.switchBranch(hook.current.path[1].message, -1);
    });
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1", "q2", "a2"]);
    expect(hook.current.path[1].branch).toMatchObject({ index: 0, total: 2 });
  });
});

describe("compaction on a branch turn", () => {
  it("puts the summary in the tree before the turn that hangs under it, and reports the count", async () => {
    const summary: Message = { ...msg("s1", "a1b", "assistant"), role: "system", content: "" };
    const question = msg("q2", "s1", "user");
    const answer = msg("a2", "q2", "assistant");
    const onContext = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([
              frame("compaction", { message: summary, covers_from: "q1", covers_to: "a1b", tokens_before: 900, tokens_after: 80 }),
              frame("message", question),
              frame("delta", { content: "a2" }),
              frame("done", answer),
              frame("context", { prompt_tokens: 120, completion_tokens: 10, context_window: 1024 }),
            ]),
            { status: 200 },
          ),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1b", onContext });
    await act(async () => {
      await hook.current.continueAnswer();
    });
    // The originals stay on the path, above the summary.
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1b", "s1", "q2", "a2"]);
    expect(onContext).toHaveBeenCalledExactlyOnceWith({ prompt_tokens: 120, completion_tokens: 10, context_window: 1024 });
  });

  it("passes a notice on without treating it as a failure", async () => {
    const onNotice = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sseBody([frame("notice", { detail: "not summarised", code: "compaction" }), frame("done", msg("a1c", "q1", "assistant"))]),
            { status: 200 },
          ),
      ),
    );
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1b", onNotice, onError });
    await act(async () => {
      await hook.current.regenerate("a1b");
    });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith("not summarised");
    expect(onError).not.toHaveBeenCalled();
  });

  it("makes a summary from Compact now the leaf when it hangs off the path on screen", () => {
    const hook = mount({ ...base, initialTree: tree(), initialLeaf: "a1b" });
    act(() => {
      hook.current.addSummary({ ...msg("s1", "a1b", "assistant"), role: "system" });
    });
    expect(hook.current.leafId).toBe("s1");
  });
});

describe("continue", () => {
  it("sends \"continue\" as a user turn and streams the answer onto the tree", async () => {
    clock = 10;
    const question = msg("q2", "a1b", "user");
    const answer = msg("a2", "q2", "assistant");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sseBody([frame("message", question), frame("delta", { content: "rest" }), frame("done", answer)]), {
            status: 200,
          }),
      ),
    );
    const hook = mount({ ...base, getModel: () => "grt-nano", initialTree: tree(), initialLeaf: "a1b" });
    await act(async () => {
      await hook.current.continueAnswer();
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/conversations/c1/messages");
    expect(JSON.parse(init.body)).toEqual({ content: "continue", model: "grt-nano" });
    expect(hook.current.path.map((e) => e.message.id)).toEqual(["q1", "a1b", "q2", "a2"]);
  });
});
