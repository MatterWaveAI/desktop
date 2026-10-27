import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatModelAdapter, ChatModelRunResult } from "./chatAdapter";
import { createChatAdapter, textOfParts, type ChatAdapterHooks } from "./chatAdapter";

/**
 * The rule is "tokens render progressively." The adapter is the seam
 * where the API's SSE stream meets the chat UI — every `delta` frame must
 * yield immediately with the text accumulated so far, or the thread sits
 * empty until the exchange finishes. These tests drive the shipped adapter
 * through `run`, stubbing only `fetch` (the same seam `auth.test.ts` uses);
 * the frames mirror `app.py`'s contract: `message`/`delta`/`title`/`error`/`done`.
 */

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** What `lib/api.ts` reads off a Response: ok, status, json, body. */
function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return { ok: status < 400, status, json: async () => body, statusText: "OK" };
}

function sseResponse(frames: string[]): Record<string, unknown> {
  return { ok: true, status: 200, body: sseBody(frames), statusText: "OK" };
}

const conversation = {
  id: "c1",
  title: "New chat",
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
};

/**
 * The adapter consumes only `messages` and `abortSignal` from the run
 * options, so the rest of the option object is not rebuilt here.
 */
function runOptions(prompt: string, signal?: AbortSignal): Parameters<ChatModelAdapter["run"]>[0] {
  return {
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: prompt }] },
    ],
    abortSignal: signal ?? new AbortController().signal,
  } as unknown as Parameters<ChatModelAdapter["run"]>[0];
}

function hooks(overrides: Partial<ChatAdapterHooks> = {}): ChatAdapterHooks & {
  [K in keyof ChatAdapterHooks]: ReturnType<typeof vi.fn>;
} {
  return {
    getConversationId: vi.fn(() => null),
    getModel: vi.fn(() => null),
    onConversationCreated: vi.fn(),
    onRenamed: vi.fn(),
    onSettled: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as ChatAdapterHooks & { [K in keyof ChatAdapterHooks]: ReturnType<typeof vi.fn> };
}

function textOf(result: ChatModelRunResult): string {
  // A message is a part list, so this narrows to the text parts rather
  // than assuming every part has `.text`.
  return textOfParts(result.content ?? []);
}

/** Stub fetch with a per-URL handler; records (url, init) for assertions. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `ChatModelAdapter.run` is typed as `Promise | AsyncGenerator` (either arm is
 * a legal adapter); `createChatAdapter`'s run is an async generator function,
 * so the cast picks the arm the shipped adapter actually returns.
 */
async function collect(
  adapter: ChatModelAdapter,
  options: Parameters<ChatModelAdapter["run"]>[0],
): Promise<ChatModelRunResult[]> {
  const results: ChatModelRunResult[] = [];
  const run = adapter.run(options) as AsyncGenerator<ChatModelRunResult, void>;
  for await (const result of run) results.push(result);
  return results;
}

describe("createChatAdapter", () => {
  it("yields after every delta with the text so far, so tokens render progressively", async () => {
    const h = hooks();
    const abortController = new AbortController();
    const fetchMock = stubFetch((url) => {
      if (url === "/api/conversations") return jsonResponse(conversation, 201);
      if (url === "/api/conversations/c1/messages")
        return sseResponse([
          sse("message", { role: "assistant", content: "" }),
          sse("delta", { content: "Say " }),
          sse("delta", { content: "hello" }),
          sse("delta", { content: "!" }),
          sse("title", { title: "Say hello" }),
          sse("done", { model: "fake-mini" }),
        ]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const adapter = createChatAdapter(h);
    const results = await collect(adapter, runOptions("Say hello", abortController.signal));

    // Three deltas, each yielded as it arrives with the accumulated text —
    // not one buffered yield at the end — plus the final `done` re-emit.
    expect(results.map(textOf)).toEqual(["Say ", "Say hello", "Say hello!", "Say hello!"]);

    // The model claim arrives only with the `done` event.
    expect(results[2].metadata).toBeUndefined();
    expect(results[3].metadata?.custom).toEqual({ model: "fake-mini" });

    // The exchange's lifecycle: conversation created once, title applied,
    // settled exactly once.
    expect(h.onConversationCreated).toHaveBeenCalledExactlyOnceWith(conversation);
    expect(h.onRenamed).toHaveBeenCalledExactlyOnceWith("c1", "Say hello");
    expect(h.onSettled).toHaveBeenCalledExactlyOnceWith();

    // First request creates the conversation; the second carries the prompt
    // (no model key when the picker has no selection) and the stop-button
    // signal, so aborting the run cancels the request.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/conversations/c1/messages");
    const sendInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(sendInit.body as string)).toEqual({ content: "Say hello" });
    expect(sendInit.signal).toBe(abortController.signal);
  });

  it("reuses the existing conversation and rides the picker's model on each send", async () => {
    const h = hooks({
      getConversationId: vi.fn(() => "c1"),
      getModel: vi.fn(() => "grt-20m"),
    });
    const fetchMock = stubFetch((url) => {
      if (url === "/api/conversations/c1/messages")
        return sseResponse([sse("delta", { content: "hi" }), sse("done", { model: "grt-20m" })]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const adapter = createChatAdapter(h);
    const results = await collect(adapter, runOptions("hi"));

    // No conversation was created and none was reported to the shell.
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/conversations/c1/messages",
      expect.objectContaining({
        body: JSON.stringify({ content: "hi", model: "grt-20m" }),
      }),
    );
    expect(h.onConversationCreated).not.toHaveBeenCalled();
    expect(results.map(textOf)).toEqual(["hi", "hi"]);
    expect(results[1].metadata?.custom).toEqual({ model: "grt-20m" });
  });

  it("surfaces a stream error, keeps what was streamed and settles", async () => {
    const h = hooks();
    stubFetch((url) => {
      if (url === "/api/conversations") return jsonResponse(conversation, 201);
      if (url === "/api/conversations/c1/messages")
        return sseResponse([
          sse("delta", { content: "partial" }),
          sse("error", { detail: "upstream unavailable" }),
        ]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const adapter = createChatAdapter(h);
    const results = await collect(adapter, runOptions("anything"));

    // The detail, plus what the transport knew about the failure.
    // `requestId` is null here because the stubbed response carries no
    // X-Request-Id and the frame no `request_id` — which is the honest answer,
    // and is what the UI reports rather than inventing one.
    expect(h.onError).toHaveBeenCalledExactlyOnceWith("upstream unavailable", {
      requestId: null,
      code: undefined,
    });
    expect(h.onSettled).toHaveBeenCalledExactlyOnceWith();
    expect(results.map(textOf)).toEqual(["partial"]);
  });

  it("sends nothing when the prompt is empty", async () => {
    const h = hooks();
    const fetchMock = stubFetch(() => jsonResponse({}, 200));

    const adapter = createChatAdapter(h);
    const results = await collect(adapter, runOptions(""));

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.onSettled).not.toHaveBeenCalled();
  });
  it("streams typed parts, so a tool call renders while it runs", async () => {
    const h = hooks();
    const fetchMock = stubFetch((url) => {
      if (url === "/api/conversations") return jsonResponse(conversation, 201);
      if (url === "/api/conversations/c1/messages")
        return sseResponse([
          sse("message", { role: "user", content: "what time is it?" }),
          // The API ran the tool; the client only watches. The call frame
          // arrives before its result, which is the window the UI renders
          // as "running".
          sse("part_start", {
            index: 0,
            type: "tool_call",
            id: "c1",
            name: "get_current_time",
            arguments: '{"timezone":"UTC"}',
          }),
          sse("part_end", { index: 0 }),
          sse("part_start", {
            index: 1,
            type: "tool_result",
            id: "c1",
            output: '{"human":"ten"}',
            is_error: false,
          }),
          sse("part_end", { index: 1 }),
          sse("part_start", { index: 2, type: "text" }),
          sse("delta", { content: "It is ", index: 2 }),
          sse("delta", { content: "ten.", index: 2 }),
          sse("part_end", { index: 2 }),
          sse("done", { model: "grt-nano" }),
        ]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const adapter = createChatAdapter(h);
    const results = await collect(
      adapter,
      runOptions("what time is it?", new AbortController().signal),
    );

    // The tool call is in the yielded content before its result exists: that
    // is what lets the UI draw it mid-flight.
    const whileRunning = results[0].content!;
    expect(whileRunning).toHaveLength(1);
    expect(whileRunning[0]).toMatchObject({ type: "tool_call", name: "get_current_time" });

    const final = results.at(-1)!.content!;
    expect(final.map((p) => p.type)).toEqual(["tool_call", "tool_result", "text"]);
    expect(final[1]).toMatchObject({ id: "c1", is_error: false });
    // Text accumulated into its own part, not into one flat string.
    expect(textOf(results.at(-1)!)).toBe("It is ten.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an unknown part kind instead of dropping it", async () => {
    const h = hooks();
    stubFetch((url) => {
      if (url === "/api/conversations") return jsonResponse(conversation, 201);
      if (url === "/api/conversations/c1/messages")
        return sseResponse([
          sse("part_start", { index: 0, type: "hologram", id: "h1" }),
          sse("part_end", { index: 0 }),
          sse("part_start", { index: 1, type: "text" }),
          sse("delta", { content: "after", index: 1 }),
          sse("done", { model: "grt-nano" }),
        ]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const results = await collect(
      createChatAdapter(h),
      runOptions("hi", new AbortController().signal),
    );

    // The renderer needs the part to be present to show its placeholder; an
    // adapter that dropped it would silently lose content.
    expect(results.at(-1)!.content!.map((p) => p.type)).toEqual(["hologram", "text"]);
  });

  it("accumulates reasoning into its own part, separate from the answer", async () => {
    const h = hooks();
    stubFetch((url) => {
      if (url === "/api/conversations") return jsonResponse(conversation, 201);
      if (url === "/api/conversations/c1/messages")
        return sseResponse([
          sse("part_start", { index: 0, type: "reasoning" }),
          sse("delta", { reasoning: "thinking ", index: 0 }),
          sse("delta", { reasoning: "hard", index: 0 }),
          sse("part_end", { index: 0 }),
          sse("part_start", { index: 1, type: "text" }),
          sse("delta", { content: "the answer", index: 1 }),
          sse("done", { model: "grt-nano" }),
        ]);
      return jsonResponse({ detail: `no mock for ${url}` }, 404);
    });

    const results = await collect(
      createChatAdapter(h),
      runOptions("hi", new AbortController().signal),
    );

    const final = results.at(-1)!.content!;
    expect(final[0]).toEqual({ type: "reasoning", text: "thinking hard" });
    // `textOf` is the answer only: a reasoning trace is not what was said.
    expect(textOf(results.at(-1)!)).toBe("the answer");
  });
});

describe("compaction frames", () => {
  it("reports the fold, the real count and a notice, none of them as the end of the stream", async () => {
    const onCompaction = vi.fn();
    const onContext = vi.fn();
    const onNotice = vi.fn();
    const h = hooks({ getConversationId: vi.fn(() => "c1"), onCompaction, onContext, onNotice });
    const summary = { id: "s1", role: "system", parts: [{ type: "summary", text: "earlier" }] };
    stubFetch(() =>
      sseResponse([
        sse("compaction", { message: summary, covers_from: "q1", covers_to: "a2", tokens_before: 900, tokens_after: 80 }),
        // The API's shapes and order: a notice carries `detail`, and the
        // context frame comes just before `done`.
        sse("notice", { detail: "Could not summarise; sent in full.", code: "compaction" }),
        sse("delta", { content: "ok" }),
        sse("context", { prompt_tokens: 300, completion_tokens: 20, context_window: 1024 }),
        sse("done", { id: "a3", model: "m" }),
      ]),
    );
    const results = await collect(createChatAdapter(h), runOptions("next"));

    expect(onCompaction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: summary, covers_to: "a2" }));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith("Could not summarise; sent in full.");
    expect(onContext).toHaveBeenCalledExactlyOnceWith({ prompt_tokens: 300, completion_tokens: 20, context_window: 1024 });
    expect(h.onError).not.toHaveBeenCalled();
    expect(results.map(textOf).at(-1)).toBe("ok");
  });

  it("says when a complete stream carried an answer cut at the token limit", async () => {
    const onLengthTruncated = vi.fn();
    const h = hooks({ getConversationId: vi.fn(() => "c1"), onLengthTruncated });
    stubFetch(() =>
      sseResponse([
        sse("delta", { content: "half an ans" }),
        sse("done", { id: "a1", model: "m", truncated: true, finish_reason: "length" }),
      ]),
    );
    await collect(createChatAdapter(h), runOptions("long"));
    expect(onLengthTruncated).toHaveBeenCalledExactlyOnceWith("a1");
    // Not an error: the stream itself ended properly.
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reports nothing for an answer that finished", async () => {
    const onLengthTruncated = vi.fn();
    const h = hooks({ getConversationId: vi.fn(() => "c1"), onLengthTruncated });
    stubFetch(() => sseResponse([sse("delta", { content: "done" }), sse("done", { id: "a1", model: "m" })]));
    await collect(createChatAdapter(h), runOptions("short"));
    expect(onLengthTruncated).not.toHaveBeenCalled();
  });
});
