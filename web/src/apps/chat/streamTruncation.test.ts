import { describe, expect, it, vi } from "vitest";
import { createChatAdapter } from "./chatAdapter";
import type { ChatMessage } from "./chatAdapter";

/**
 * A stream that ends without a terminal event must say so.
 *
 * This is the mobile failure that matters most. A phone drops its
 * connection constantly — screen lock, app switch, wifi-to-cellular handover,
 * a tunnel — and when it does the response body simply ENDS. There is no
 * exception to catch and no `error` frame to read: `reader.read()` reports
 * `done: true` and the parse loop falls out of the bottom exactly as it does
 * on success.
 *
 * Before this, that silence rendered as a finished answer. The user was shown
 * a half sentence formatted identically to a complete one, with no error, no
 * retry and nothing to say it was cut off.
 */

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function hooks() {
  // Not spread with overrides: spreading widens `onError` back to the plain
  // hook signature and `.mock` is then unreachable. No test here needs an
  // override, so the concrete mock type is kept.
  return {
    getConversationId: () => "c-1" as string | null,
    getModel: () => null,
    onConversationCreated: vi.fn(),
    onRenamed: vi.fn(),
    onSettled: vi.fn(),
    onError: vi.fn<
      (message: string, meta?: { requestId?: string | null; code?: string }) => void
    >(),
  };
}

const PROMPT: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

async function drain(adapter: ReturnType<typeof createChatAdapter>, signal: AbortSignal) {
  const out = [];
  for await (const chunk of adapter.run({ messages: PROMPT, abortSignal: signal })) {
    out.push(chunk);
  }
  return out;
}

/** Stub `fetch` so apiStream resolves to `frames`, with optional headers. */
function stubFetch(frames: string[], headers?: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(sseStream(frames), { status: 200, headers })),
  );
}

describe("a stream that ends without a terminal event", () => {
  it("still reports truncation when only a compaction and a context frame arrived", async () => {
    // Neither frame is terminal: a fold ran and the answer never came.
    stubFetch([
      `event: compaction
data: {"message":{"id":"s1","role":"system"},"covers_from":"q1","covers_to":"a1","tokens_before":900,"tokens_after":80}

`,
      `event: context
data: {"prompt_tokens":100,"completion_tokens":0,"context_window":1024}

`,
    ]);
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0][1]?.code).toBe("truncated");
    vi.unstubAllGlobals();
  });

  it("reports an error when the body ends after a delta with no done", async () => {
    stubFetch([
      `event: part_start\ndata: {"index":0,"type":"text"}\n\n`,
      `id: g:0\nevent: delta\ndata: {"content":"a partial ","index":0}\n\n`,
      `id: g:1\nevent: delta\ndata: {"content":"answer","index":0}\n\n`,
      // and then nothing — the connection went away.
    ]);
    const h = hooks();
    const chunks = await drain(createChatAdapter(h), new AbortController().signal);

    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0][0]).toMatch(/connection dropped/i);
    // Whatever arrived is still yielded, so the UI keeps the partial text.
    const last = chunks[chunks.length - 1];
    expect(last.content?.map((p) => ("text" in p ? p.text : "")).join("")).toBe("a partial answer");
    vi.unstubAllGlobals();
  });

  it("stays silent when the stream ended properly with done", async () => {
    stubFetch([
      `event: part_start\ndata: {"index":0,"type":"text"}\n\n`,
      `id: g:0\nevent: delta\ndata: {"content":"a whole answer","index":0}\n\n`,
      `event: done\ndata: {"model":"m"}\n\n`,
    ]);
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);
    expect(h.onError).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stays silent when the stream ended with an explicit error frame", async () => {
    stubFetch([
      `event: part_start\ndata: {"index":0,"type":"text"}\n\n`,
      `event: error\ndata: {"detail":"the gateway refused"}\n\n`,
    ]);
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);
    // Exactly one error, the server's own — never doubled by the truncation
    // check, which must not fire once a terminal frame has been seen.
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0][0]).toBe("the gateway refused");
    vi.unstubAllGlobals();
  });

  it("stays silent when the user pressed Stop", async () => {
    stubFetch([
      `event: part_start\ndata: {"index":0,"type":"text"}\n\n`,
      `id: g:0\nevent: delta\ndata: {"content":"half","index":0}\n\n`,
    ]);
    const controller = new AbortController();
    const h = hooks();
    // Aborted before the body is drained: a user who cancelled knows why the
    // answer stopped and must not be told the connection failed.
    controller.abort();
    await drain(createChatAdapter(h), controller.signal).catch(() => undefined);
    expect(h.onError).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * The correlation id has to survive the one failure that has no
 * ApiError to carry it: a stream that opened as a 200 and then died. The
 * Response is out of scope by then, so the id must be captured up front.
 */
describe("the correlation id on a stream failure", () => {
  it("quotes the X-Request-Id of a stream that dies mid-answer", async () => {
    stubFetch(
      [
        `event: part_start\ndata: {"index":0,"type":"text"}\n\n`,
        `id: g:0\nevent: delta\ndata: {"content":"cut off","index":0}\n\n`,
      ],
      { "X-Request-Id": "req-truncated-01" },
    );
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);

    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0][1]?.requestId).toBe("req-truncated-01");
    vi.unstubAllGlobals();
  });

  it("prefers the error frame's own request_id over the response header", async () => {
    stubFetch(
      [`event: error\ndata: {"detail":"upstream died","request_id":"req-from-frame"}\n\n`],
      { "X-Request-Id": "req-from-header" },
    );
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);
    expect(h.onError.mock.calls[0][1]?.requestId).toBe("req-from-frame");
    vi.unstubAllGlobals();
  });

  it("reports no id rather than inventing one when nothing carries it", async () => {
    stubFetch([`event: error\ndata: {"detail":"upstream died"}\n\n`]);
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);
    // Null, not "" and not a fabricated value: an id that does not appear in
    // the logs wastes the support conversation it was supposed to start.
    expect(h.onError.mock.calls[0][1]?.requestId).toBeNull();
    vi.unstubAllGlobals();
  });
});

/**
 * The API streams a content block as a 200 with its own frame. Before this was
 * handled the frame fell through the adapter's event chain unrecognised, the
 * body then ended with no `done`, and the truncation guard above reported it
 * as "the connection dropped" — a network lie about a refusal, which invites
 * the one action guaranteed not to work.
 */
describe("a moderation block", () => {
  it("is reported as a refusal with its code, not as a dropped connection", async () => {
    stubFetch([
      `event: moderation_block\ndata: {"detail":"MatterWave would not send this.","code":"moderation","request_id":"req-blocked-7"}\n\n`,
    ]);
    const h = hooks();
    await drain(createChatAdapter(h), new AbortController().signal);

    expect(h.onError).toHaveBeenCalledOnce();
    const [message, meta] = h.onError.mock.calls[0];
    expect(message).not.toMatch(/connection dropped/i);
    expect(meta?.code).toBe("moderation");
    expect(meta?.requestId).toBe("req-blocked-7");
    vi.unstubAllGlobals();
  });
});
