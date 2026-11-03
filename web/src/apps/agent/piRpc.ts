/**
 * Pi 1.0 (`pi --mode rpc`) JSON-Lines RPC protocol codec and session driver
 * for the Desktop Agent Panel.
 *
 * Maps Pi 1.0's JSONL stdout stream (`message_update` with `text_delta`,
 * `tool_execution_start`, `tool_execution_end`, and `agent_end`) into the
 * Desktop Agent Panel's `AgentEvent` turn/tool stream, and injects MatterWave
 * auth/preset metadata (`provider: "matterwave"`, `presetId`, `temporary`).
 */
import { summarize, type AgentEvent } from "./loop";

export const PI_PROVIDER = "matterwave" as const;

export interface PiPresetMetadata {
  provider?: string;
  model?: string | null;
  presetId?: string | null;
  temporary?: boolean;
}

export type PiRpcCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
      provider: string;
      model?: string;
      presetId?: string;
      temporary?: boolean;
    }
  | {
      id?: string;
      type: "abort";
    }
  | {
      id?: string;
      type: "set_model";
      provider: string;
      modelId: string;
    }
  | {
      id?: string;
      type: "get_state";
    };

export interface PiRawEvent {
  type: string;
  [key: string]: unknown;
}

export type PiNormalizedEvent =
  | { kind: "text_delta"; delta: string; raw: PiRawEvent }
  | {
      kind: "tool_start";
      id: string;
      name: string;
      args: Record<string, unknown>;
      summary: string;
      raw: PiRawEvent;
    }
  | {
      kind: "tool_end";
      id: string;
      name: string;
      output: string;
      isError: boolean;
      raw: PiRawEvent;
    }
  | {
      kind: "agent_end";
      stopReason: string;
      text: string | null;
      steps: number;
      tokens: number;
      raw: PiRawEvent;
    }
  | {
      kind: "response";
      id: string | null;
      command: string | null;
      success: boolean;
      error: string | null;
      raw: PiRawEvent;
    }
  | {
      kind: "error";
      message: string;
      raw: PiRawEvent;
    }
  | {
      kind: "other";
      raw: PiRawEvent;
    };

/**
 * Encode a Pi 1.0 RPC command as a single newline-delimited JSONL frame
 * suitable for writing to `pi --mode rpc`'s `stdin`.
 */
export function encodePiCommand(
  command:
    | {
        id?: string;
        type: "prompt";
        message: string;
        provider?: string;
        model?: string | null;
        presetId?: string | null;
        temporary?: boolean;
      }
    | { id?: string; type: "abort" }
    | { id?: string; type: "set_model"; provider?: string; modelId: string }
    | { id?: string; type: "get_state" },
): string {
  if (command.type === "prompt") {
    const payload: Record<string, unknown> = {
      ...(command.id ? { id: command.id } : {}),
      type: "prompt",
      message: command.message,
      provider: command.provider ?? PI_PROVIDER,
    };
    if (command.model) payload.model = command.model;
    if (command.presetId) payload.presetId = command.presetId;
    if (typeof command.temporary === "boolean") payload.temporary = command.temporary;
    return `${JSON.stringify(payload)}\n`;
  }
  if (command.type === "set_model") {
    const payload: Record<string, unknown> = {
      ...(command.id ? { id: command.id } : {}),
      type: "set_model",
      provider: command.provider ?? PI_PROVIDER,
      modelId: command.modelId,
    };
    return `${JSON.stringify(payload)}\n`;
  }
  const payload: Record<string, unknown> = {
    ...(command.id ? { id: command.id } : {}),
    type: command.type,
  };
  return `${JSON.stringify(payload)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractToolOutput(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  const obj = asRecord(result);
  if (obj) {
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.content)) {
      const parts: string[] = [];
      for (const item of obj.content) {
        if (typeof item === "string") {
          parts.push(item);
        } else {
          const block = asRecord(item);
          if (block && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
    if (typeof obj.output === "string") return obj.output;
  }
  return JSON.stringify(result);
}

/**
 * Parse a single JSON-Lines frame from Pi 1.0's `stdout`.
 * Returns `null` when the line is empty or whitespace-only.
 */
export function parsePiEventLine(line: string): PiNormalizedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      kind: "error",
      message: `Invalid Pi RPC JSON line: ${err instanceof Error ? err.message : String(err)}`,
      raw: { type: "parse_error", line: trimmed },
    };
  }

  const raw = asRecord(parsed);
  if (!raw || typeof raw.type !== "string") {
    return {
      kind: "error",
      message: "Pi RPC event must be a JSON object with a string `type` field.",
      raw: { type: "invalid_event", payload: parsed },
    };
  }

  const event: PiRawEvent = { ...raw, type: raw.type };

  switch (event.type) {
    case "message_update": {
      const sub = asRecord(event.assistantMessageEvent);
      let delta = "";
      if (sub) {
        if (
          (sub.type === "text_delta" || sub.type === "thinking_delta" || sub.type === undefined) &&
          typeof sub.delta === "string"
        ) {
          delta = sub.delta;
        } else if (typeof sub.text === "string") {
          delta = sub.text;
        }
      } else if (typeof event.delta === "string") {
        delta = event.delta;
      } else if (typeof event.text === "string") {
        delta = event.text;
      }
      return { kind: "text_delta", delta, raw: event };
    }

    case "tool_execution_start": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) ||
        (typeof event.tool_call_id === "string" && event.tool_call_id) ||
        (typeof event.id === "string" && event.id) ||
        "tool_call";
      const name =
        (typeof event.toolName === "string" && event.toolName) ||
        (typeof event.tool_name === "string" && event.tool_name) ||
        (typeof event.name === "string" && event.name) ||
        "tool";
      const argsObj = asRecord(event.args) ?? asRecord(event.arguments) ?? {};
      return {
        kind: "tool_start",
        id,
        name,
        args: argsObj,
        summary: summarize(name, argsObj),
        raw: event,
      };
    }

    case "tool_execution_end": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) ||
        (typeof event.tool_call_id === "string" && event.tool_call_id) ||
        (typeof event.id === "string" && event.id) ||
        "tool_call";
      const name =
        (typeof event.toolName === "string" && event.toolName) ||
        (typeof event.tool_name === "string" && event.tool_name) ||
        (typeof event.name === "string" && event.name) ||
        "tool";
      const isError = Boolean(event.isError ?? event.is_error ?? false);
      const rawResult = "result" in event ? event.result : event.output;
      return {
        kind: "tool_end",
        id,
        name,
        output: extractToolOutput(rawResult),
        isError,
        raw: event,
      };
    }

    case "agent_end":
    case "turn_end": {
      let stopReason =
        (typeof event.stopReason === "string" && event.stopReason) ||
        (typeof event.stop_reason === "string" && event.stop_reason) ||
        "stop";
      const usageObj = asRecord(event.usage);
      let tokens =
        usageObj && typeof usageObj.total_tokens === "number"
          ? usageObj.total_tokens
          : usageObj && typeof usageObj.totalTokens === "number"
            ? usageObj.totalTokens
            : 0;
      let steps = typeof event.steps === "number" ? event.steps : 1;
      let finalText: string | null = typeof event.text === "string" ? event.text : null;

      if (Array.isArray(event.messages)) {
        const assistantMessages = event.messages
          .map((m) => asRecord(m))
          .filter((m): m is Record<string, unknown> => m !== null && m.role === "assistant");
        if (assistantMessages.length > 0) {
          steps = assistantMessages.length;
          const last = assistantMessages[assistantMessages.length - 1]!;
          if (typeof last.content === "string") {
            finalText = last.content;
          } else if (Array.isArray(last.content)) {
            const parts = last.content
              .map((b) => asRecord(b))
              .filter((b): b is Record<string, unknown> => b !== null && typeof b.text === "string")
              .map((b) => b.text as string);
            if (parts.length > 0) finalText = parts.join("");
          }
          if (typeof last.stopReason === "string" && stopReason === "stop") {
            stopReason = last.stopReason;
          }
          const msgUsage = asRecord(last.usage);
          if (tokens === 0 && msgUsage) {
            if (typeof msgUsage.total_tokens === "number") tokens = msgUsage.total_tokens;
            else if (typeof msgUsage.totalTokens === "number") tokens = msgUsage.totalTokens;
          }
        }
      }

      return {
        kind: "agent_end",
        stopReason,
        text: finalText,
        steps,
        tokens,
        raw: event,
      };
    }

    case "response": {
      const success = event.success !== false;
      const error = typeof event.error === "string" ? event.error : null;
      return {
        kind: "response",
        id: typeof event.id === "string" ? event.id : null,
        command: typeof event.command === "string" ? event.command : null,
        success,
        error,
        raw: event,
      };
    }

    case "error": {
      const message =
        (typeof event.message === "string" && event.message) ||
        (typeof event.error === "string" && event.error) ||
        "Pi RPC runtime error";
      return {
        kind: "error",
        message,
        raw: event,
      };
    }

    default:
      return { kind: "other", raw: event };
  }
}

export interface PiRpcAdapterOptions extends PiPresetMetadata {
  /** Writes a JSONL command frame to the Pi RPC process's `stdin`. */
  writeStdin: (line: string) => void | Promise<void>;
  /** Emits Desktop `AgentEvent` updates into the Agent Panel transcript. */
  onEvent: (event: AgentEvent) => void;
  /** Optional hook called for every normalized Pi RPC event. */
  onPiEvent?: (event: PiNormalizedEvent) => void;
  /** Optional hook called when `agent_end` completes a turn. */
  onTurnEnd?: (result: { text: string; stopReason: string; steps: number; tokens: number }) => void;
}

export interface PiRpcAdapter {
  /** Send a `prompt` command with MatterWave provider/preset metadata. */
  sendPrompt(message: string, overrides?: PiPresetMetadata & { id?: string }): Promise<string>;
  /** Send an `abort` command to cancel the active Pi turn. */
  abort(id?: string): Promise<string>;
  /** Feed arbitrary (potentially chunked/split) stdout text into the JSONL line parser. */
  feedStdout(chunk: string): PiNormalizedEvent[];
  /** Flush any trailing buffered line on stream close. */
  flush(): PiNormalizedEvent[];
  /** The accumulated assistant text for the current turn. */
  readonly assistantText: string;
}

/**
 * Create a stateful Pi 1.0 JSONL RPC session driver that buffers chunked
 * `stdout`, maps Pi events to Desktop `AgentEvent` items, and encodes `stdin`
 * RPC commands with MatterWave auth/preset metadata.
 */
export function createPiRpcAdapter(options: PiRpcAdapterOptions): PiRpcAdapter {
  let buffer = "";
  let accumulatedText = "";
  let toolCount = 0;

  const processLine = (line: string): PiNormalizedEvent | null => {
    const ev = parsePiEventLine(line);
    if (!ev) return null;

    options.onPiEvent?.(ev);

    switch (ev.kind) {
      case "text_delta":
        if (ev.delta) {
          accumulatedText += ev.delta;
        }
        break;

      case "tool_start":
        toolCount += 1;
        options.onEvent({
          kind: "tool",
          id: ev.id,
          name: ev.name,
          args: ev.args,
          summary: ev.summary,
        });
        break;

      case "tool_end":
        options.onEvent({
          kind: "tool_result",
          id: ev.id,
          name: ev.name,
          output: ev.output,
          isError: ev.isError,
        });
        break;

      case "agent_end": {
        const finalText = accumulatedText || ev.text || "";
        if (finalText) {
          options.onEvent({
            kind: "assistant",
            text: finalText,
          });
        }
        const steps = Math.max(ev.steps, toolCount > 0 ? toolCount : 1);
        options.onEvent({
          kind: "usage",
          steps,
          tokens: ev.tokens,
        });
        options.onTurnEnd?.({
          text: finalText,
          stopReason: ev.stopReason,
          steps,
          tokens: ev.tokens,
        });
        break;
      }

      case "response":
        if (!ev.success && ev.error) {
          options.onEvent({
            kind: "notice",
            text: `Pi RPC error: ${ev.error}`,
          });
        }
        break;

      case "error":
        options.onEvent({
          kind: "notice",
          text: ev.message,
        });
        break;

      case "other":
        break;
    }

    return ev;
  };

  return {
    get assistantText() {
      return accumulatedText;
    },

    async sendPrompt(message, overrides) {
      accumulatedText = "";
      toolCount = 0;
      const frame = encodePiCommand({
        id: overrides?.id,
        type: "prompt",
        message,
        provider: overrides?.provider ?? options.provider ?? PI_PROVIDER,
        model: overrides?.model !== undefined ? overrides.model : options.model,
        presetId: overrides?.presetId !== undefined ? overrides.presetId : options.presetId,
        temporary: overrides?.temporary !== undefined ? overrides.temporary : options.temporary,
      });
      await options.writeStdin(frame);
      return frame;
    },

    async abort(id) {
      const frame = encodePiCommand({ id, type: "abort" });
      await options.writeStdin(frame);
      return frame;
    },

    feedStdout(chunk: string): PiNormalizedEvent[] {
      buffer += chunk;
      const emitted: PiNormalizedEvent[] = [];
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const ev = processLine(line);
        if (ev) emitted.push(ev);
        newlineIdx = buffer.indexOf("\n");
      }
      return emitted;
    },

    flush(): PiNormalizedEvent[] {
      if (!buffer.trim()) {
        buffer = "";
        return [];
      }
      const trailing = buffer;
      buffer = "";
      const ev = processLine(trailing);
      return ev ? [ev] : [];
    },
  };
}

/** Alias for `encodePiCommand` used by Desktop RPC callers. */
export const encodePiRpcCommand = encodePiCommand;

/**
 * Stateful JSONL line buffer for Pi 1.0 (`pi --mode rpc`) stdout streams.
 */
export class PiRpcLineBuffer {
  private buffer = "";

  feed(chunk: string): PiNormalizedEvent[] {
    this.buffer += chunk;
    const events: PiNormalizedEvent[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const ev = parsePiEventLine(line);
      if (ev) events.push(ev);
      newlineIdx = this.buffer.indexOf("\n");
    }
    return events;
  }

  flush(): PiNormalizedEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const trailing = this.buffer;
    this.buffer = "";
    const ev = parsePiEventLine(trailing);
    return ev ? [ev] : [];
  }
}

/**
 * Map a normalized Pi 1.0 RPC event into Desktop `AgentEvent` actions.
 */
export function mapPiEventToAgentActions(
  ev: PiNormalizedEvent,
  state?: { accumulatedText?: string; toolCount?: number },
): AgentEvent[] {
  switch (ev.kind) {
    case "tool_start":
      return [
        {
          kind: "tool",
          id: ev.id,
          name: ev.name,
          args: ev.args,
          summary: ev.summary,
        },
      ];
    case "tool_end":
      return [
        {
          kind: "tool_result",
          id: ev.id,
          name: ev.name,
          output: ev.output,
          isError: ev.isError,
        },
      ];
    case "agent_end": {
      const actions: AgentEvent[] = [];
      const finalText = state?.accumulatedText || ev.text || "";
      if (finalText) {
        actions.push({ kind: "assistant", text: finalText });
      }
      const toolCount = state?.toolCount ?? 0;
      const steps = Math.max(ev.steps, toolCount > 0 ? toolCount : 1);
      actions.push({ kind: "usage", steps, tokens: ev.tokens });
      return actions;
    }
    case "response":
      if (!ev.success && ev.error) {
        return [{ kind: "notice", text: `Pi RPC error: ${ev.error}` }];
      }
      return [];
    case "error":
      return [{ kind: "notice", text: ev.message }];
    case "text_delta":
    case "other":
      return [];
  }
}

export interface PiRpcTurnOptions extends PiPresetMetadata {
  /** User prompt message to send to `pi --mode rpc`. */
  prompt?: string;
  /** Alias for `prompt`. */
  message?: string;
  /** Optional RPC command correlation id. */
  id?: string;
  /** Writes a JSONL command frame to Pi's `stdin`. */
  send?: (line: string) => void | Promise<void>;
  /** Alias for `send`. */
  writeStdin?: (line: string) => void | Promise<void>;
  /** Subscribes to stdout lines/chunks from the Pi RPC process; returns an unsubscribe callback. */
  onLine: (handler: (line: string) => void) => () => void;
  /** Dispatches Desktop `AgentEvent` items as they arrive. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional streaming text delta callback. */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Optional normalized Pi event callback. */
  onPiEvent?: (event: PiNormalizedEvent) => void;
  /** Optional AbortSignal; when aborted, sends `{"type":"abort"}` and resolves as aborted. */
  signal?: AbortSignal;
}

export interface PiRpcTurnResult {
  status: "completed" | "aborted" | "error";
  text: string;
  stopReason: string;
  steps: number;
  tokens: number;
  error?: string;
  events: AgentEvent[];
}

/**
 * Execute a single turn against `pi --mode rpc`:
 * - Sends `encodePiRpcCommand({ type: "prompt", message })`
 * - Buffers and parses incoming JSONL frames via `PiRpcLineBuffer`
 * - Dispatches `mapPiEventToAgentActions` to `onEvent`
 * - Resolves when `agent_end` / `turn_end` or `error` arrives, or sends `{"type":"abort"}` on `signal` abort
 */
export async function runPiRpcTurn(options: PiRpcTurnOptions): Promise<PiRpcTurnResult> {
  const writer = options.send ?? options.writeStdin;
  if (!writer) {
    throw new Error("runPiRpcTurn requires a `send` or `writeStdin` callback.");
  }
  const message = options.message ?? options.prompt ?? "";
  const lineBuffer = new PiRpcLineBuffer();
  const events: AgentEvent[] = [];
  let accumulatedText = "";
  let toolCount = 0;

  const emitEvent = (ev: AgentEvent) => {
    events.push(ev);
    options.onEvent?.(ev);
  };

  return new Promise<PiRpcTurnResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        const unsub = unsubscribe;
        unsubscribe = null;
        unsub();
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const finish = (result: PiRpcTurnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleNormalizedEvents = (normalized: PiNormalizedEvent[]) => {
      for (const ev of normalized) {
        if (settled) return;
        options.onPiEvent?.(ev);

        if (ev.kind === "text_delta" && ev.delta) {
          accumulatedText += ev.delta;
          options.onTextDelta?.(ev.delta, accumulatedText);
        } else if (ev.kind === "tool_start") {
          toolCount += 1;
        }

        const actions = mapPiEventToAgentActions(ev, { accumulatedText, toolCount });
        for (const action of actions) {
          emitEvent(action);
        }

        if (ev.kind === "agent_end") {
          const finalText = accumulatedText || ev.text || "";
          const steps = Math.max(ev.steps, toolCount > 0 ? toolCount : 1);
          finish({
            status: "completed",
            text: finalText,
            stopReason: ev.stopReason,
            steps,
            tokens: ev.tokens,
            events,
          });
          return;
        }

        if (ev.kind === "error") {
          const steps = Math.max(1, toolCount);
          finish({
            status: "error",
            text: accumulatedText,
            stopReason: "error",
            steps,
            tokens: 0,
            error: ev.message,
            events,
          });
          return;
        }

        if (ev.kind === "response" && !ev.success) {
          const steps = Math.max(1, toolCount);
          finish({
            status: "error",
            text: accumulatedText,
            stopReason: "error",
            steps,
            tokens: 0,
            error: ev.error ?? "Pi RPC command failed",
            events,
          });
          return;
        }
      }
    };

    const handleAbort = () => {
      if (settled) return;
      const abortLine = encodePiRpcCommand({ type: "abort" });
      Promise.resolve(writer(abortLine))
        .catch(() => undefined)
        .finally(() => {
          finish({
            status: "aborted",
            text: accumulatedText,
            stopReason: "aborted",
            steps: Math.max(1, toolCount),
            tokens: 0,
            events,
          });
        });
    };

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }

    options.signal?.addEventListener("abort", handleAbort, { once: true });

    unsubscribe = options.onLine((incoming: string) => {
      if (settled) return;
      let chunk = incoming;
      if (!chunk.includes("\n")) {
        const trimmed = chunk.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            JSON.parse(trimmed);
            chunk = `${chunk}\n`;
          } catch {
            // Incomplete JSON chunk; wait for remaining bytes or newline.
          }
        }
      }
      handleNormalizedEvents(lineBuffer.feed(chunk));
    });

    const promptFrame = encodePiRpcCommand({
      id: options.id,
      type: "prompt",
      message,
      provider: options.provider ?? PI_PROVIDER,
      model: options.model,
      presetId: options.presetId,
      temporary: options.temporary,
    });

    Promise.resolve(writer(promptFrame)).catch((err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
