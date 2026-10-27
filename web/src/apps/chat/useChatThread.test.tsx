import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatModelAdapter, ChatModelRunResult } from "./chatAdapter";
import { useChatThread, type ThreadPhase } from "./useChatThread";

/**
 * The hook must distinguish "sent, nothing back yet" from
 * "tokens arriving". A `running` boolean cannot, and a cold model spends
 * several seconds in the first of those two states.
 *
 * The adapter here is a hand-driven async generator, so the test controls
 * exactly when the first delta lands and can assert the phase in between.
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
});

/** An adapter whose chunks are released one at a time by the test. */
function controllableAdapter() {
  let release: (() => void) | null = null;
  const queue: ChatModelRunResult[] = [];
  let done = false;

  const gate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const adapter: ChatModelAdapter = {
    async *run() {
      while (!done) {
        await gate();
        while (queue.length > 0) yield queue.shift()!;
      }
    },
  };

  return {
    adapter,
    /** Push a chunk and let the generator emit it. */
    async emit(result: ChatModelRunResult) {
      queue.push(result);
      await act(async () => {
        release?.();
        release = null;
        await Promise.resolve();
      });
    },
    async finish() {
      done = true;
      await act(async () => {
        release?.();
        release = null;
        await Promise.resolve();
      });
    },
  };
}

interface Observed {
  phase: ThreadPhase;
  running: boolean;
  canRetry: boolean;
  send: (text: string) => Promise<void>;
}

function mount(adapter: ChatModelAdapter): { current: Observed } {
  const ref: { current: Observed } = {
    current: { phase: "idle", running: false, canRetry: false, send: async () => undefined },
  };
  function Probe() {
    const thread = useChatThread(adapter);
    ref.current = {
      phase: thread.phase,
      running: thread.running,
      canRetry: thread.canRetry,
      send: thread.send,
    };
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

describe("useChatThread phase", () => {
  it("is awaiting-first-token after send and only becomes streaming on real text", async () => {
    const driver = controllableAdapter();
    const thread = mount(driver.adapter);

    expect(thread.current.phase).toBe("idle");
    expect(thread.current.running).toBe(false);

    act(() => {
      void thread.current.send("hello");
    });

    // Sent, nothing back yet: this is the several-seconds window a cold model
    // sits in, and it must not read as "streaming".
    expect(thread.current.phase).toBe("awaiting-first-token");
    expect(thread.current.running).toBe(true);

    // An empty chunk is the adapter settling, not the model speaking.
    await driver.emit({ content: [{ type: "text", text: "" }] });
    expect(thread.current.phase).toBe("awaiting-first-token");

    // The first real token flips it.
    await driver.emit({ content: [{ type: "text", text: "Hi" }] });
    expect(thread.current.phase).toBe("streaming");

    await driver.finish();
    expect(thread.current.phase).toBe("idle");
    expect(thread.current.running).toBe(false);
  });

  it("remembers the last prompt so a failed exchange can be retried", async () => {
    const driver = controllableAdapter();
    const thread = mount(driver.adapter);
    expect(thread.current.canRetry).toBe(false);
    act(() => {
      void thread.current.send("ask me again");
    });
    expect(thread.current.canRetry).toBe(true);
    await driver.finish();
    expect(thread.current.canRetry).toBe(true);
  });

  it("ignores an empty prompt", async () => {
    const adapter: ChatModelAdapter = {
      // eslint-disable-next-line require-yield -- the test asserts it is never entered.
      async *run() {
        throw new Error("the adapter must not run for an empty prompt");
      },
    };
    const thread = mount(adapter);
    await act(async () => {
      await thread.current.send("   ");
    });
    // The adapter throws if entered, so reaching here at all is the assertion.
    expect(thread.current.phase).toBe("idle");
    expect(thread.current.canRetry).toBe(false);
  });
});
