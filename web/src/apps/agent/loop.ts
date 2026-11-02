/**
 * Agent mode's loop: the model proposes tool calls through `/v1`, the
 * native host runs them, and their results go back as `role: "tool"`
 * messages until the model answers without a call -- or the person stops
 * the run, or a cap or the budget ends it.
 *
 * `/v1/chat/completions` relays `tools` to the model and hands `tool_calls`
 * back unexecuted, so the loop is the client's: the server keeps metering,
 * the budget, the model allow-list and moderation, and with
 * `metadata.conversation_id` it records the run's text into a conversation
 * the web can open. It never sees the filesystem.
 *
 * What each mode lets through is the contract's (`allowed`): `plan` is
 * only ever offered the read tools. The approval itself is the desktop
 * app's: the host puts every command in `ask` and `auto-edit`, every write
 * in `ask`, and every write to a protected file (the instructions, the
 * deny file, the agent's settings, shell startup files and credential
 * folders) in every mode, `yolo` included, to the person in a native
 * dialog before it happens, so nothing in this webview can approve on
 * their behalf. What the loop adds is the reading: where a write asks,
 * its whole diff is shown here first, and only once the person has read
 * it and chosen Apply... does the host ask. A no, here or in the dialog,
 * reaches the model as the contract's `rejected` answer, not an error.
 * The host enforces the same mode on its side, confines every path, and
 * in `plan` and `ask` asks before reading a credentials folder or shell
 * startup file.
 */
import { ApiError, apiFetch } from "../../lib/api";
import { STREAM_ERROR_COPY, classifyStreamError } from "../chat/streamErrors";
import type { AgentHost, ReadTool, RunStarted, ToolOutput } from "./host";
import { allowed, refusal, systemPrompt, toolsForMode, type Tool } from "./sdk/modes";
import { unifiedDiff } from "./sdk/diff";
import { DenyList } from "./sdk/deny";
import { CONTEXT_FILES, DENY_FILE, PROTECTED, type ContextFile, type ModeName } from "./sdk/types";
import { mentionsIn, withAttachments } from "./commands";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface CompletionRequest {
  model?: string;
  messages: AgentMessage[];
  tools: Tool[];
  tool_choice: "auto";
  metadata?: { conversation_id: string };
}

export interface CompletionResponse {
  choices: {
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] | null };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** Where the loop sends each step; `/v1` in the app, a script in tests. */
export interface ModelTransport {
  complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse>;
}

/** `/v1/chat/completions`, with the app's bearer (desktopAuth routes `/v1/` to the API). */
export const v1Transport: ModelTransport = {
  complete: (request, signal) =>
    apiFetch<CompletionResponse>("/v1/chat/completions", { method: "POST", json: request, signal }),
};

export interface Caps {
  /** Model calls per run. */
  maxSteps: number;
  /** Tokens per run, as `/v1` counts them (`usage.total_tokens`). */
  maxTokens: number;
}

export const DEFAULT_CAPS: Caps = { maxSteps: 25, maxTokens: 200_000 };

/**
 * A write in `ask`, shown here with its diff before the desktop app's own
 * dialog asks: true goes on to that dialog, false rejects it here.
 */
export type ApprovalRequest = {
  kind: "write";
  tool: "edit" | "write_file";
  path: string;
  diff: string;
  created: boolean;
};

/**
 * The paths the host reads only after the person's yes in a mode they have
 * not confirmed for the folder (`plan`, `ask`): the protected ones that are
 * not instructions or the deny file (approval.rs's `read_gate`).
 */
const READ_GATE = new DenyList(PROTECTED.filter((p) => p !== DENY_FILE && !CONTEXT_FILES.includes(p)));

/** Whether the host will ask the person natively before a read of `path` in `mode` goes ahead. */
export function readAsksNatively(mode: ModeName, path: string | null): boolean {
  return (mode === "plan" || mode === "ask") && path !== null && READ_GATE.matches(path);
}

export type AgentEvent =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: unknown; summary: string }
  | {
      kind: "tool_result";
      id: string;
      name: string;
      output: string;
      isError: boolean;
      /** The change, for a write that went through or was rejected. */
      diff?: string;
      /** A write that was applied, with its checkpoint for /restore. */
      checkpoint?: number;
      rejected?: boolean;
    }
  | { kind: "usage"; steps: number; tokens: number }
  | { kind: "notice"; text: string }
  /** The desktop app is asking the person about this call in its own dialog; its result follows. */
  | { kind: "confirming"; id: string; what: "command" | "write" | "read"; text: string };

export type StopReason =
  | "done"
  | "stopped"
  | "step_cap"
  | "token_cap"
  | "budget"
  | "rate_limit"
  | "error";

export interface AgentRunResult {
  reason: StopReason;
  /** The conversation so far, without the system prompt: the next run's history. */
  history: AgentMessage[];
  steps: number;
  tokens: number;
  /** What to tell the person when the run did not simply finish. */
  notice: { title: string; guidance: string } | null;
  requestId: string | null;
}

export interface AgentRunOptions {
  prompt: string;
  /** Earlier turns of this agent session, without a system prompt. */
  history: readonly AgentMessage[];
  mode: ModeName;
  /** Null: the deployment's default model. */
  model: string | null;
  /** Where `/v1` records the run; null keeps it unrecorded. */
  conversationId: string | null;
  caps: Caps;
  host: AgentHost;
  transport: ModelTransport;
  /** A write's diff in `ask`, read before the desktop app asks: true goes on to its dialog, false rejects. */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  /** The started run, so the caller can show the root it works in. */
  onStarted?: (run: RunStarted) => void;
  signal: AbortSignal;
}

/** The copy a run that hit its rate limit ends with. */
export const RATE_LIMIT_COPY = {
  title: "Too many requests for now",
  guidance:
    "MatterWave limits how many model calls one account makes a minute, and this run reached the limit. Nothing is lost: wait a minute, then send again to carry on from here.",
} as const;

export function stepCapCopy(maxSteps: number) {
  return {
    title: "The run reached its step limit",
    guidance: `It made ${maxSteps} model calls, the most one run may. Nothing more will run: send another message to carry on from here, or raise the limit.`,
  };
}

export function tokenCapCopy(used: number, maxTokens: number) {
  return {
    title: "The run reached its token limit",
    guidance: `It used ${used.toLocaleString("en")} tokens against a limit of ${maxTokens.toLocaleString("en")} for one run. Nothing more will run: send another message to carry on, or raise the limit.`,
  };
}

/** One line for a call, as the transcript lists it. */
export function summarize(name: string, args: Record<string, unknown>): string {
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (name) {
    case "read_file":
      return `Read ${str("path")}`;
    case "list_dir":
      return `List ${str("path") || "."}`;
    case "glob":
      return `Find ${str("pattern")}${str("path") ? ` in ${str("path")}` : ""}`;
    case "grep":
      return `Search for ${str("pattern")}${str("path") ? ` in ${str("path")}` : ""}`;
    case "edit":
      return `Edit ${str("path")}`;
    case "write_file":
      return `Write ${str("path")}`;
    case "run_shell":
      return `Run ${str("command")}`;
    default:
      return name;
  }
}

/**
 * The system prompt for one run: the contract's, with the trusted folder's
 * context files in the contract's "Project instructions" section, each
 * fenced and cut at its 32768 characters. The host loads them only from a
 * folder the person trusts.
 */
export function runSystemPrompt(mode: ModeName, run: RunStarted): string {
  const contextFiles: ContextFile[] = run.context.map((f) => ({ path: f.path, content: f.text, trusted: true }));
  return systemPrompt(mode, run.root, { platform: run.platform, contextFiles });
}

function estimateTokens(messages: readonly AgentMessage[], reply: string): number {
  return Math.ceil((JSON.stringify(messages).length + reply.length) / 4);
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** The envelope's message (`{"error": {"message"}}`), or the ApiError's own. */
function v1Message(err: ApiError): string {
  const body = err.body as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === "string" ? body.error.message : err.message;
}

class Stopped extends Error {
  constructor() {
    super("stopped");
    this.name = "AbortError";
  }
}

/** `promise`, or a rejection the moment `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const READS: readonly string[] = ["read_file", "list_dir", "glob", "grep"];
const CONTRACT_TOOLS: readonly string[] = [...READS, "edit", "write_file", "run_shell"];

/**
 * One run of the loop. Resolves with why it ended; never rejects for a
 * model or tool failure, which end the run with a notice instead.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { host, signal, caps, mode } = opts;
  const history: AgentMessage[] = [...opts.history, { role: "user", content: opts.prompt }];
  let steps = 0;
  let tokens = 0;
  let requestId: string | null = null;
  const end = (reason: StopReason, notice: AgentRunResult["notice"] = null): AgentRunResult => ({
    reason,
    history,
    steps,
    tokens,
    notice,
    requestId,
  });

  let run: RunStarted;
  try {
    run = await host.startRun(mode, opts.conversationId);
  } catch (err) {
    history.pop();
    const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
    return end("error", { title: "The run could not start", guidance: text || "The desktop app refused it." });
  }
  opts.onStarted?.(run);
  // Stop reaches the host at once: a running command is killed there,
  // not left to finish while the loop waits for it.
  const onAbort = () => void host.stopRun(run.run_id).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  if (run.untrusted_context.length > 0) {
    opts.onEvent({
      kind: "notice",
      text: `${run.untrusted_context.join(" and ")} ${run.untrusted_context.length === 1 ? "is" : "are"} in this folder but ${run.untrusted_context.length === 1 ? "was" : "were"} not loaded: the folder is not trusted. Trust it to send ${run.untrusted_context.length === 1 ? "it" : "them"} with each run.`,
    });
  }
  // `@path` mentions go with the message, read through the host like any
  // read_file (confined, deny list and all).
  const mentioned = mentionsIn(opts.prompt);
  if (mentioned.length > 0) {
    const files: { path: string; text: string; isError: boolean }[] = [];
    for (const path of mentioned) {
      try {
        const read = await host.read(run.run_id, "read_file", { path });
        files.push({ path, text: read.output, isError: read.is_error });
      } catch (err) {
        files.push({ path, text: typeof err === "string" ? err : "it could not be read", isError: true });
      }
    }
    history[history.length - 1] = { role: "user", content: withAttachments(opts.prompt, files) };
    const attached = files.filter((f) => !f.isError).map((f) => `@${f.path}`);
    const refused = files.filter((f) => f.isError).map((f) => `@${f.path}`);
    opts.onEvent({
      kind: "notice",
      text: [
        attached.length > 0 ? `Attached ${attached.join(", ")}.` : "",
        refused.length > 0 ? `Not attached: ${refused.join(", ")} (refused or unreadable; the model is told why).` : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  const system: AgentMessage = { role: "system", content: runSystemPrompt(mode, run) };
  const tools = toolsForMode(mode);

  try {
    for (;;) {
      if (signal.aborted) return end("stopped");
      if (steps >= caps.maxSteps) return end("step_cap", stepCapCopy(caps.maxSteps));
      if (tokens >= caps.maxTokens) return end("token_cap", tokenCapCopy(tokens, caps.maxTokens));
      steps += 1;
      const messages = [system, ...history];
      let response: CompletionResponse;
      try {
        response = await opts.transport.complete(
          {
            ...(opts.model === null ? {} : { model: opts.model }),
            messages,
            tools,
            tool_choice: "auto",
            ...(opts.conversationId === null ? {} : { metadata: { conversation_id: opts.conversationId } }),
          },
          signal,
        );
      } catch (err) {
        if (isAbort(err) || signal.aborted) return end("stopped");
        if (err instanceof ApiError) {
          requestId = err.requestId;
          if (err.status === 402) return end("budget", STREAM_ERROR_COPY.budget);
          if (err.status === 429) return end("rate_limit", RATE_LIMIT_COPY);
          const kind = classifyStreamError(v1Message(err), err.status);
          return end("error", STREAM_ERROR_COPY[kind]);
        }
        const kind = classifyStreamError(err instanceof Error ? err.message : "");
        return end("error", STREAM_ERROR_COPY[kind]);
      }
      const message = response.choices[0]?.message;
      const text = message?.content ?? "";
      const calls = message?.tool_calls ?? [];
      tokens += response.usage?.total_tokens ?? estimateTokens(messages, text);
      opts.onEvent({ kind: "usage", steps, tokens });
      history.push({
        role: "assistant",
        content: message?.content ?? null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      if (text) opts.onEvent({ kind: "assistant", text });
      if (calls.length === 0) return end("done");

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        // Every call the model made gets an answer, even after Stop, so the
        // history stays a valid prompt for the next run.
        const stopAt = (from: number, first: string) => {
          calls.slice(from).forEach((rest, n) =>
            history.push({
              role: "tool",
              tool_call_id: rest.id,
              content: n === 0 ? first : "Not run: the user stopped the run.",
            }),
          );
          return end("stopped");
        };
        if (signal.aborted) return stopAt(i, "Not run: the user stopped the run.");
        let result: ToolOutput;
        try {
          result = await runCall(call, run, opts);
        } catch (err) {
          if (isAbort(err) || signal.aborted) return stopAt(i, "Stopped by the user before it finished.");
          result = {
            output: `The desktop app could not run ${call.function.name}: ${typeof err === "string" ? err : err instanceof Error ? err.message : "unknown error"}`,
            is_error: true,
          };
          opts.onEvent({ kind: "tool_result", id: call.id, name: call.function.name, output: result.output, isError: true });
        }
        history.push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
    }
  } catch (err) {
    if (isAbort(err) || signal.aborted) return end("stopped");
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await host.stopRun(run.run_id).catch(() => undefined);
  }
}

async function runCall(call: ToolCall, run: RunStarted, opts: AgentRunOptions): Promise<ToolOutput> {
  const { host, signal, mode } = opts;
  const name = call.function.name;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    const result = {
      output: `The arguments for ${name} were not a JSON object (${err instanceof Error ? err.message : "unreadable"}). Send them again as JSON.`,
      is_error: true,
    };
    opts.onEvent({ kind: "tool", id: call.id, name, args: call.function.arguments, summary: name });
    opts.onEvent({ kind: "tool_result", id: call.id, name, output: result.output, isError: true });
    return result;
  }
  opts.onEvent({ kind: "tool", id: call.id, name, args, summary: summarize(name, args) });
  const report = (result: ToolOutput, extra: Partial<Extract<AgentEvent, { kind: "tool_result" }>> = {}) => {
    opts.onEvent({
      kind: "tool_result",
      id: call.id,
      name,
      output: result.output,
      isError: result.is_error,
      ...extra,
    });
    return result;
  };

  // A tool the mode denies -- or one the contract never named -- is
  // refused here, before the host hears of it (which would refuse too).
  if (!CONTRACT_TOOLS.includes(name)) {
    return report({ output: refusal("unknown_tool", { tool: name }), is_error: true });
  }
  let decision: ReturnType<typeof allowed>;
  try {
    decision = allowed(name, mode);
  } catch {
    decision = "deny";
  }
  if (decision === "deny") {
    return report({ output: refusal("mode", { tool: name, mode }), is_error: true });
  }

  if (READS.includes(name)) {
    const path = typeof args.path === "string" ? args.path : null;
    if (readAsksNatively(mode, path)) {
      opts.onEvent({ kind: "confirming", id: call.id, what: "read", text: path ?? "" });
    }
    const result = await untilAborted(host.read(run.run_id, name as ReadTool, args), signal);
    return report(result, result.rejected ? { rejected: true } : {});
  }

  if (name === "edit" || name === "write_file") {
    const preview = await untilAborted(host.write(run.run_id, name, args, { apply: false }), signal);
    if (preview.status !== "preview") {
      return report({ output: preview.output, is_error: true });
    }
    const diff = unifiedDiff(preview.before ?? "", preview.after, preview.relative);
    // A protected file asks in every mode that writes, yolo included.
    const asks = allowed(name, mode, null, { path: preview.relative }) === "ask";
    if (asks) {
      // The panel's reading of the diff; the desktop app's dialog decides.
      const ok = await untilAborted(
        opts.approve({ kind: "write", tool: name, path: preview.relative, diff, created: preview.before === null }),
        signal,
      );
      if (!ok) {
        return report({ output: refusal("rejected", { tool: name }), is_error: false }, { diff, rejected: true });
      }
      opts.onEvent({ kind: "confirming", id: call.id, what: "write", text: preview.relative });
    }
    const applied = await untilAborted(
      host.write(run.run_id, name, args, { apply: true, expectedSha256: preview.before_sha256 }),
      signal,
    );
    if (applied.status === "rejected") {
      return report({ output: applied.output, is_error: false }, { diff, rejected: true });
    }
    if (applied.status !== "applied") {
      const output = applied.status === "error" ? applied.output : `${preview.relative} was not written.`;
      return report({ output, is_error: true }, { diff });
    }
    return report({ output: applied.output, is_error: false }, { diff, checkpoint: applied.checkpoint });
  }

  if (name === "run_shell") {
    // No question here: the host shows the command whole in the desktop
    // app's dialog, which is where the person says yes or no.
    if (decision === "ask") {
      const command = typeof args.command === "string" ? args.command : "";
      opts.onEvent({ kind: "confirming", id: call.id, what: "command", text: command });
    }
    const result = await untilAborted(host.shell(run.run_id, args), signal);
    return report(result, result.rejected ? { rejected: true } : {});
  }

  return report({ output: refusal("unknown_tool", { tool: name }), is_error: true });
}
