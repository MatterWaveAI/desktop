import { describe, expect, it, vi } from "vitest";
import { FakeHost } from "./fakeHost.test-util";
import type { AgentEvent } from "./loop";
import {
  PI_PROVIDER,
  PiRpcLineBuffer,
  compactPiRpcSession,
  createPiRpcAdapter,
  encodePiCommand,
  encodePiRpcCommand,
  forkPiRpcSession,
  getPiRpcState,
  mapPiEventToAgentActions,
  newPiRpcSession,
  parsePiEventLine,
  runPiRpcTurn,
  sendPiRpcRequest,
  setPiRpcModel,
  steerPiRpcTurn,
  type PiNormalizedEvent,
} from "./piRpc";
import {
  compactPiRpcSession as runtimeCompactPiRpcSession,
  forkPiRpcSession as runtimeForkPiRpcSession,
  getPiRpcState as runtimeGetPiRpcState,
  hasPiRpcSupport,
  newPiRpcSession as runtimeNewPiRpcSession,
  runDesktopPiTurn,
  sendPiRpcRequest as runtimeSendPiRpcRequest,
  setPiRpcModel as runtimeSetPiRpcModel,
  steerPiRpcTurn as runtimeSteerPiRpcTurn,
} from "./runtime";

describe("encodePiCommand", () => {
  it("encodes a prompt command as newline-terminated JSONL with MatterWave metadata", () => {
    const line = encodePiCommand({
      id: "req_1",
      type: "prompt",
      message: "Refactor loop.ts",
      model: "claude-sonnet-4-5",
      presetId: "preset_architect",
      temporary: true,
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      id: "req_1",
      type: "prompt",
      message: "Refactor loop.ts",
      provider: PI_PROVIDER,
      model: "claude-sonnet-4-5",
      presetId: "preset_architect",
      temporary: true,
    });
  });

  it("encodes abort, set_model, and get_state commands", () => {
    expect(JSON.parse(encodePiCommand({ id: "ab_1", type: "abort" }))).toEqual({
      id: "ab_1",
      type: "abort",
    });
    expect(JSON.parse(encodePiCommand({ type: "set_model", modelId: "gpt-5.4" }))).toEqual({
      type: "set_model",
      provider: "matterwave",
      modelId: "gpt-5.4",
    });
    expect(encodePiCommand({ type: "get_state" })).toBe('{"type":"get_state"}\n');
  });
});

describe("parsePiEventLine", () => {
  it("returns null on blank lines and reports malformed JSON as error events", () => {
    expect(parsePiEventLine("")).toBeNull();
    expect(parsePiEventLine("   \r\n")).toBeNull();

    const bad = parsePiEventLine("{not-valid-json");
    expect(bad).toMatchObject({
      kind: "error",
    });
    expect(bad && "message" in bad ? bad.message : "").toContain("Invalid Pi RPC JSON line");
  });

  it("maps message_update text_delta, tool_execution_start, tool_execution_end, and agent_end", () => {
    const delta = parsePiEventLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Checking files..." },
      }),
    );
    expect(delta).toEqual({
      kind: "text_delta",
      delta: "Checking files...",
      raw: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Checking files..." },
      },
    });

    const toolStart = parsePiEventLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: { path: "src/main.tsx" },
      }),
    );
    expect(toolStart).toMatchObject({
      kind: "tool_start",
      id: "tc_1",
      name: "read_file",
      args: { path: "src/main.tsx" },
      summary: "Read src/main.tsx",
    });

    const toolEnd = parsePiEventLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "read_file",
        result: { content: [{ type: "text", text: "import React from 'react';" }] },
        isError: false,
      }),
    );
    expect(toolEnd).toMatchObject({
      kind: "tool_end",
      id: "tc_1",
      name: "read_file",
      output: "import React from 'react';",
      isError: false,
    });

    const agentEnd = parsePiEventLine(
      JSON.stringify({
        type: "agent_end",
        stopReason: "stop",
        usage: { total_tokens: 340 },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "Done!" }] },
        ],
      }),
    );
    expect(agentEnd).toMatchObject({
      kind: "agent_end",
      stopReason: "stop",
      text: "Done!",
      steps: 1,
      tokens: 340,
    });
  });
});

describe("createPiRpcAdapter", () => {
  it("handles chunked JSONL line buffering and maps a full turn into AgentEvent items", async () => {
    const stdinLines: string[] = [];
    const agentEvents: AgentEvent[] = [];
    const piEvents: PiNormalizedEvent[] = [];
    const turnEnds: { text: string; stopReason: string; steps: number; tokens: number }[] = [];

    const adapter = createPiRpcAdapter({
      presetId: "preset_default",
      temporary: true,
      model: "gpt-5.4",
      writeStdin: (line) => {
        stdinLines.push(line);
      },
      onEvent: (e) => agentEvents.push(e),
      onPiEvent: (e) => piEvents.push(e),
      onTurnEnd: (r) => turnEnds.push(r),
    });

    await adapter.sendPrompt("Inspect package.json", { id: "p_1" });
    expect(stdinLines).toHaveLength(1);
    expect(JSON.parse(stdinLines[0]!)).toEqual({
      id: "p_1",
      type: "prompt",
      message: "Inspect package.json",
      provider: "matterwave",
      model: "gpt-5.4",
      presetId: "preset_default",
      temporary: true,
    });

    const frame1 = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Reading " },
    });
    const frame2 = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_7",
      toolName: "read_file",
      args: { path: "package.json" },
    });
    const frame3 = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_7",
      toolName: "read_file",
      result: { content: [{ type: "text", text: '{"name":"matterwave-desktop"}' }] },
      isError: false,
    });
    const frame4 = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "package.json complete." },
    });
    const frame5 = JSON.stringify({
      type: "agent_end",
      stopReason: "stop",
      usage: { total_tokens: 128 },
    });

    // Feed split across arbitrary chunk boundaries
    const combined = `${frame1}\n${frame2}\n${frame3}\n${frame4}\n${frame5}\n`;
    adapter.feedStdout(combined.slice(0, 25));
    expect(piEvents).toHaveLength(0);

    adapter.feedStdout(combined.slice(25, 190));
    adapter.feedStdout(combined.slice(190));

    expect(adapter.assistantText).toBe("Reading package.json complete.");
    expect(agentEvents).toEqual([
      {
        kind: "tool",
        id: "call_7",
        name: "read_file",
        args: { path: "package.json" },
        summary: "Read package.json",
      },
      {
        kind: "tool_result",
        id: "call_7",
        name: "read_file",
        output: '{"name":"matterwave-desktop"}',
        isError: false,
      },
      {
        kind: "assistant",
        text: "Reading package.json complete.",
      },
      {
        kind: "usage",
        steps: 1,
        tokens: 128,
      },
    ]);
    expect(turnEnds).toEqual([
      {
        text: "Reading package.json complete.",
        stopReason: "stop",
        steps: 1,
        tokens: 128,
      },
    ]);
  });

  it("generates abort command and surfaces RPC/parse errors as notice events", async () => {
    const writeStdin = vi.fn();
    const events: AgentEvent[] = [];
    const adapter = createPiRpcAdapter({
      writeStdin,
      onEvent: (e) => events.push(e),
    });

    const abortFrame = await adapter.abort("abort_99");
    expect(abortFrame).toBe('{"id":"abort_99","type":"abort"}\n');
    expect(writeStdin).toHaveBeenCalledWith('{"id":"abort_99","type":"abort"}\n');

    adapter.feedStdout(
      `${JSON.stringify({ type: "response", id: "p_1", command: "prompt", success: false, error: "Quota exceeded" })}\n`,
    );
    adapter.feedStdout("not-json-at-all");
    adapter.flush();

    expect(events).toEqual([
      { kind: "notice", text: "Pi RPC error: Quota exceeded" },
      { kind: "notice", text: expect.stringContaining("Invalid Pi RPC JSON line") },
    ]);
  });
});

describe("runPiRpcTurn and Desktop runtime wiring", () => {
  it("executes a full Pi 1.0 RPC turn end-to-end with streaming deltas, tool start/end, and turn completion", async () => {
    const sentLines: string[] = [];
    const listeners = new Set<(line: string) => void>();
    const events: AgentEvent[] = [];
    const deltas: string[] = [];

    const emitLine = (line: string) => {
      for (const listener of [...listeners]) {
        listener(line);
      }
    };

    const turnPromise = runPiRpcTurn({
      id: "turn_1",
      message: "List files and summarize",
      model: "claude-sonnet-4-5",
      presetId: "preset_code",
      temporary: true,
      send: (line) => {
        sentLines.push(line);
        const cmd = JSON.parse(line) as { type: string };
        if (cmd.type === "prompt") {
          queueMicrotask(() => {
            emitLine(
              JSON.stringify({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Listing " },
              }),
            );
            emitLine(
              JSON.stringify({
                type: "tool_execution_start",
                toolCallId: "tc_10",
                toolName: "list_dir",
                args: { path: "src" },
              }),
            );
            emitLine(
              JSON.stringify({
                type: "tool_execution_end",
                toolCallId: "tc_10",
                toolName: "list_dir",
                result: "index.ts\nloop.ts",
                isError: false,
              }),
            );
            emitLine(
              JSON.stringify({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "files complete." },
              }),
            );
            emitLine(
              JSON.stringify({
                type: "turn_end",
                stopReason: "stop",
                usage: { total_tokens: 215 },
              }),
            );
          });
        }
      },
      onLine: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      onEvent: (ev) => events.push(ev),
      onTextDelta: (delta) => deltas.push(delta),
    });

    const result = await turnPromise;

    expect(sentLines).toHaveLength(1);
    expect(JSON.parse(sentLines[0]!)).toEqual({
      id: "turn_1",
      type: "prompt",
      message: "List files and summarize",
      provider: "matterwave",
      model: "claude-sonnet-4-5",
      presetId: "preset_code",
      temporary: true,
    });
    expect(deltas).toEqual(["Listing ", "files complete."]);
    expect(result).toEqual({
      status: "completed",
      text: "Listing files complete.",
      stopReason: "stop",
      steps: 1,
      tokens: 215,
      events: [
        {
          kind: "tool",
          id: "tc_10",
          name: "list_dir",
          args: { path: "src" },
          summary: "List src",
        },
        {
          kind: "tool_result",
          id: "tc_10",
          name: "list_dir",
          output: "index.ts\nloop.ts",
          isError: false,
        },
        {
          kind: "assistant",
          text: "Listing files complete.",
        },
        {
          kind: "usage",
          steps: 1,
          tokens: 215,
        },
      ],
    });
    expect(events).toEqual(result.events);
    expect(listeners.size).toBe(0);
  });

  it("sends { type: 'abort' } when AbortSignal fires mid-turn", async () => {
    const sentLines: string[] = [];
    const listeners = new Set<(line: string) => void>();
    const controller = new AbortController();

    const turnPromise = runPiRpcTurn({
      prompt: "Long running task",
      send: (line) => {
        sentLines.push(line);
      },
      onLine: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      signal: controller.signal,
    });

    for (const listener of [...listeners]) {
      listener(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Partial output..." },
        }),
      );
    }

    controller.abort();
    const result = await turnPromise;

    expect(result.status).toBe("aborted");
    expect(result.stopReason).toBe("aborted");
    expect(result.text).toBe("Partial output...");
    expect(sentLines).toHaveLength(2);
    expect(JSON.parse(sentLines[0]!)).toMatchObject({
      type: "prompt",
      message: "Long running task",
      provider: "matterwave",
    });
    expect(JSON.parse(sentLines[1]!)).toEqual({
      type: "abort",
    });
    expect(listeners.size).toBe(0);
  });

  it("wires DesktopAgentHost via runDesktopPiTurn and PiRpcLineBuffer / mapPiEventToAgentActions", async () => {
    const baseHost = new FakeHost();
    expect(hasPiRpcSupport(baseHost)).toBe(false);

    const buf = new PiRpcLineBuffer();
    const norm = buf.feed(encodePiRpcCommand({ type: "get_state" }));
    expect(norm).toHaveLength(1);
    expect(mapPiEventToAgentActions({ kind: "error", message: "boom", raw: { type: "error" } })).toEqual([
      { kind: "notice", text: "boom" },
    ]);

    const sent: string[] = [];
    const closeSpy = vi.fn();
    baseHost.piRpcSpawn = vi.fn(async () => {
      let lineHandler: ((line: string) => void) | null = null;
      return {
        send: (line: string) => {
          sent.push(line);
          queueMicrotask(() => {
            lineHandler?.(
              JSON.stringify({
                type: "agent_end",
                stopReason: "stop",
                usage: { total_tokens: 42 },
                messages: [{ role: "assistant", content: "Spawned session reply" }],
              }),
            );
          });
        },
        onLine: (handler) => {
          lineHandler = handler;
          return () => {
            lineHandler = null;
          };
        },
        close: closeSpy,
      };
    });

    expect(hasPiRpcSupport(baseHost)).toBe(true);
    const res = await runDesktopPiTurn(baseHost, {
      prompt: "Hello Pi",
      presetId: "preset_1",
      temporary: false,
    });

    expect(res.status).toBe("completed");
    expect(res.text).toBe("Spawned session reply");
    expect(res.tokens).toBe(42);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Pi 1.0 RPC session controls (sendPiRpcRequest, compactPiRpcSession, getPiRpcState, newPiRpcSession, steerPiRpcTurn)", () => {
  function createMockRpcIo(
    responder?: (cmd: Record<string, unknown>, emit: (chunk: string) => void) => void,
  ) {
    const sent: Record<string, unknown>[] = [];
    const listeners = new Set<(line: string) => void>();
    const emit = (chunk: string) => {
      for (const listener of [...listeners]) {
        listener(chunk);
      }
    };
    const io = {
      piRpcSend: (line: string) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        sent.push(parsed);
        responder?.(parsed, emit);
      },
      onPiRpcLine: (handler: (line: string) => void) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    };
    return { io, sent, listeners, emit };
  }

  it("re-exports session control helpers from runtime.ts", () => {
    expect(runtimeSendPiRpcRequest).toBe(sendPiRpcRequest);
    expect(runtimeCompactPiRpcSession).toBe(compactPiRpcSession);
    expect(runtimeForkPiRpcSession).toBe(forkPiRpcSession);
    expect(runtimeGetPiRpcState).toBe(getPiRpcState);
    expect(runtimeNewPiRpcSession).toBe(newPiRpcSession);
    expect(runtimeSetPiRpcModel).toBe(setPiRpcModel);
    expect(runtimeSteerPiRpcTurn).toBe(steerPiRpcTurn);
  });

  it("switches model via setPiRpcModel and forks/resets session via forkPiRpcSession and newPiRpcSession", async () => {
    const host = new FakeHost();
    host.piRpcTurn = vi.fn(async ({ prompt }) => {
      const parsed = JSON.parse(prompt) as {
        type: string;
        provider?: string;
        modelId?: string;
        entryId?: string;
      };
      return [
        JSON.stringify({
          type: "response",
          command: parsed.type,
          success: true,
          data: {
            command: parsed.type,
            ...(parsed.provider ? { provider: parsed.provider } : {}),
            ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
            ...(parsed.entryId ? { entryId: parsed.entryId } : {}),
            sessionId: parsed.type === "fork" ? "sess_forked" : "sess_1",
          },
        }),
      ];
    });

    const modelRes = await setPiRpcModel(host, "/work/demo", "claude-sonnet-4-5");
    expect(host.piRpcTurn).toHaveBeenCalledWith({
      workspaceRoot: "/work/demo",
      prompt: JSON.stringify({
        type: "set_model",
        provider: "matterwave",
        modelId: "claude-sonnet-4-5",
      }),
      model: "claude-sonnet-4-5",
    });
    expect(modelRes).toMatchObject({
      command: "set_model",
      provider: "matterwave",
      modelId: "claude-sonnet-4-5",
    });

    await setPiRpcModel(host, "/work/demo", "gpt-5.4", "openai", { CUSTOM_ENV: "1" });
    expect(host.piRpcTurn).toHaveBeenCalledWith({
      workspaceRoot: "/work/demo",
      prompt: JSON.stringify({
        type: "set_model",
        provider: "openai",
        modelId: "gpt-5.4",
      }),
      model: "gpt-5.4",
      env: { CUSTOM_ENV: "1" },
    });

    const forkRes = await forkPiRpcSession(host, "/work/demo", "entry_7", { CUSTOM_ENV: "1" });
    expect(host.piRpcTurn).toHaveBeenCalledWith({
      workspaceRoot: "/work/demo",
      prompt: JSON.stringify({
        type: "fork",
        entryId: "entry_7",
      }),
      env: { CUSTOM_ENV: "1" },
    });
    expect(forkRes).toMatchObject({
      command: "fork",
      entryId: "entry_7",
      sessionId: "sess_forked",
    });

    await forkPiRpcSession(host, "/work/demo");
    expect(host.piRpcTurn).toHaveBeenCalledWith({
      workspaceRoot: "/work/demo",
      prompt: JSON.stringify({
        type: "fork",
      }),
    });

    const newRes = await newPiRpcSession(host, "/work/demo", { CUSTOM_ENV: "1" });
    expect(host.piRpcTurn).toHaveBeenCalledWith({
      workspaceRoot: "/work/demo",
      prompt: JSON.stringify({
        type: "new_session",
      }),
      env: { CUSTOM_ENV: "1" },
    });
    expect(newRes).toMatchObject({
      command: "new_session",
      sessionId: "sess_1",
    });
  });

  it("correlates sendPiRpcRequest by unique id across chunked JSONL frames and ignores unrelated responses", async () => {
    const { io, sent, listeners } = createMockRpcIo((cmd, emit) => {
      queueMicrotask(() => {
        // Emit an unrelated response first
        emit(`${JSON.stringify({ type: "response", id: "other_req", success: true, data: { ignored: true } })}\n`);
        // Emit matching response split across two chunks
        const matching = `${JSON.stringify({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: true,
          data: { ok: true, echoedType: cmd.type },
        })}\n`;
        emit(matching.slice(0, 18));
        emit(matching.slice(18));
      });
    });

    const data = await sendPiRpcRequest<{ ok: boolean; echoedType: string }>(io, {
      type: "get_state",
    });

    expect(sent).toHaveLength(1);
    expect(typeof sent[0]!.id).toBe("string");
    expect((sent[0]!.id as string).length).toBeGreaterThan(0);
    expect(data).toEqual({ ok: true, echoedType: "get_state" });
    expect(listeners.size).toBe(0);
  });

  it("compacts session via compactPiRpcSession with and without customInstructions", async () => {
    const { io, sent } = createMockRpcIo((cmd, emit) => {
      queueMicrotask(() => {
        emit(
          JSON.stringify({
            type: "response",
            id: cmd.id,
            command: "compact",
            success: true,
            data: { summary: "Compacted 12 messages", tokensBefore: 4800, tokensAfter: 900 },
          }),
        );
      });
    });

    const first = await compactPiRpcSession(io);
    expect(sent[0]).toEqual({
      id: expect.any(String),
      type: "compact",
    });
    expect(first).toEqual({
      summary: "Compacted 12 messages",
      tokensBefore: 4800,
      tokensAfter: 900,
    });

    const second = await compactPiRpcSession(io, "Preserve file paths and test commands", {
      id: "compact_custom_1",
    });
    expect(sent[1]).toEqual({
      id: "compact_custom_1",
      type: "compact",
      customInstructions: "Preserve file paths and test commands",
    });
    expect(second).toEqual({
      summary: "Compacted 12 messages",
      tokensBefore: 4800,
      tokensAfter: 900,
    });
  });

  it("queries state via getPiRpcState and resets session via newPiRpcSession", async () => {
    const { io, sent } = createMockRpcIo((cmd, emit) => {
      queueMicrotask(() => {
        if (cmd.type === "get_state") {
          emit(
            JSON.stringify({
              type: "response",
              id: cmd.id,
              command: "get_state",
              success: true,
              data: {
                sessionId: "sess_abc",
                model: { provider: "matterwave", id: "gpt-5.4" },
                messageCount: 6,
                isStreaming: false,
              },
            }),
          );
        } else if (cmd.type === "new_session") {
          emit(
            JSON.stringify({
              type: "response",
              id: cmd.id,
              command: "new_session",
              success: true,
              data: { cancelled: false, sessionId: "sess_new" },
            }),
          );
        }
      });
    });

    const state = await getPiRpcState(io, { id: "state_1" });
    expect(sent[0]).toEqual({ id: "state_1", type: "get_state" });
    expect(state).toEqual({
      sessionId: "sess_abc",
      model: { provider: "matterwave", id: "gpt-5.4" },
      messageCount: 6,
      isStreaming: false,
    });

    const reset = await newPiRpcSession(io, { id: "new_1" });
    expect(sent[1]).toEqual({ id: "new_1", type: "new_session" });
    expect(reset).toEqual({ cancelled: false, sessionId: "sess_new" });
  });

  it("sends steer command via steerPiRpcTurn", async () => {
    const { io, sent } = createMockRpcIo();
    const frame = await steerPiRpcTurn(io, "Focus on unit tests first", { id: "steer_1" });
    expect(frame).toBe('{"id":"steer_1","type":"steer","message":"Focus on unit tests first"}\n');
    expect(sent).toEqual([
      {
        id: "steer_1",
        type: "steer",
        message: "Focus on unit tests first",
      },
    ]);
  });

  it("rejects sendPiRpcRequest when success === false, on timeout, or on AbortSignal", async () => {
    // 1. success === false rejection
    const { io: errorIo, listeners: errListeners } = createMockRpcIo((cmd, emit) => {
      queueMicrotask(() => {
        emit(
          JSON.stringify({
            type: "response",
            id: cmd.id,
            command: cmd.type,
            success: false,
            error: "Session is currently streaming",
          }),
        );
      });
    });

    await expect(compactPiRpcSession(errorIo)).rejects.toThrow("Session is currently streaming");
    expect(errListeners.size).toBe(0);

    // 2. Timeout rejection
    const { io: slowIo, listeners: slowListeners } = createMockRpcIo();
    await expect(getPiRpcState(slowIo, { timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20ms/i,
    );
    expect(slowListeners.size).toBe(0);

    // 3. AbortSignal rejection
    const { io: abortIo, listeners: abortListeners } = createMockRpcIo();
    const controller = new AbortController();
    const pending = newPiRpcSession(abortIo, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(abortListeners.size).toBe(0);
  });
});
