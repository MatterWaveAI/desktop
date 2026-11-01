import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FolderOpenIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { ApiError, apiFetch } from "../../lib/api";
import type { Conversation } from "../../types";
import { Button } from "../../components/ui/button";
import { SimpleSelect } from "../../components/ui/select";
import { AGENT_HELP, INIT_PROMPT, parseAgentCommand } from "./commands";
import { desktopHost, hostError, type AgentHost, type AgentStatus } from "./host";
import {
  DEFAULT_CAPS,
  runAgent,
  v1Transport,
  type AgentEvent,
  type AgentMessage,
  type ApprovalRequest,
  type Caps,
  type ModelTransport,
} from "./loop";
import { MODES_BY_NAME, type ModeName } from "./sdk/types";
import { CYCLE, MODE_LABELS, loadMode, saveMode } from "./mode";

type ToolResult = Extract<AgentEvent, { kind: "tool_result" }>;

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; summary: string; result: ToolResult | null }
  | { kind: "notice"; text: string }
  | { kind: "end"; title: string; guidance: string; requestId: string | null };

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (ok: boolean) => void;
}

/**
 * Agent mode: a folder on this machine, a mode, and a loop through `/v1`
 * whose tools run in the desktop app's native host. Shown in place of the
 * chat thread when the Agent toggle is on (ChatPage), which is only offered
 * when the person turned agent mode on in Preferences.
 */
export function AgentPanel(props: {
  /** The picker's model; null is the deployment's default. */
  model: string | null;
  /** Why agent mode cannot run with this model or org, if it cannot. */
  unavailable: string | null;
  /** A run's conversation was created, for the sidebar. */
  onConversationCreated?: (conversation: Conversation) => void;
  host?: AgentHost;
  transport?: ModelTransport;
}) {
  const host = props.host ?? desktopHost;
  const transport = props.transport ?? v1Transport;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [mode, setModeState] = useState<ModeName>(loadMode);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<AgentMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [caps, setCaps] = useState<Caps>(DEFAULT_CAPS);
  const [usage, setUsage] = useState<{ steps: number; tokens: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [hostProblem, setHostProblem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    host
      .status()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch((err: unknown) => {
        if (alive) setHostProblem(hostError(err));
      });
    return () => {
      alive = false;
    };
  }, [host]);

  // Leaving the panel mid-run stops the run (and any command it runs).
  useEffect(() => () => controller.current?.abort(), []);

  const say = useCallback((text: string) => setEntries((e) => [...e, { kind: "notice", text }]), []);

  const setMode = (next: ModeName) => {
    setModeState(next);
    saveMode(next);
  };

  const hostCall = async (work: () => Promise<AgentStatus>) => {
    setHostProblem(null);
    try {
      setStatus(await work());
    } catch (err) {
      setHostProblem(hostError(err));
    }
  };

  const onEvent = useCallback((event: AgentEvent) => {
    setEntries((current) => {
      switch (event.kind) {
        case "assistant":
          return [...current, { kind: "assistant", text: event.text }];
        case "notice":
          return [...current, { kind: "notice", text: event.text }];
        case "tool":
          return [...current, { kind: "tool", id: event.id, summary: event.summary, result: null }];
        case "tool_result":
          return current.map((entry) =>
            entry.kind === "tool" && entry.id === event.id ? { ...entry, result: event } : entry,
          );
        case "usage":
          return current;
      }
    });
    if (event.kind === "usage") setUsage({ steps: event.steps, tokens: event.tokens });
  }, []);

  const run = async (prompt: string, shown: string = prompt) => {
    if (!status?.root) {
      say("Choose a folder for the agent to work in first.");
      return;
    }
    setEntries((e) => [...e, { kind: "user", text: shown }]);
    let cid = conversationId;
    if (cid === null) {
      try {
        const created = await apiFetch<Conversation>("/api/conversations", {
          method: "POST",
          json: { title: `Agent: ${shown.slice(0, 60)}` },
        });
        cid = created.id;
        setConversationId(cid);
        props.onConversationCreated?.(created);
      } catch (err) {
        say(
          `The run is not being saved to a conversation (${err instanceof ApiError ? err.message : "MatterWave could not be reached"}); it goes ahead here.`,
        );
      }
    }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setUsage(null);
    try {
      const result = await runAgent({
        prompt,
        history,
        mode,
        model: props.model,
        conversationId: cid,
        caps,
        host,
        transport,
        signal: abort.signal,
        onEvent,
        onStarted: (started) => {
          if (started.root !== status.root) void hostCall(() => host.status());
        },
        approve: (request) =>
          new Promise<boolean>((resolve) => {
            setApproval({
              request,
              resolve: (ok) => {
                setApproval(null);
                resolve(ok);
              },
            });
          }),
      });
      setHistory(result.history);
      if (result.reason === "stopped") {
        say("Stopped. Anything already changed stays changed; /restore puts files back.");
      } else if (result.notice) {
        const notice = result.notice;
        setEntries((e) => [
          ...e,
          { kind: "end", title: notice.title, guidance: notice.guidance, requestId: result.requestId },
        ]);
      }
    } finally {
      setApproval(null);
      setRunning(false);
      controller.current = null;
    }
  };

  const stop = () => {
    approval?.resolve(false);
    controller.current?.abort();
  };

  const runCommand = async (text: string): Promise<boolean> => {
    const command = parseAgentCommand(text);
    if (command === null) return false;
    switch (command.kind) {
      case "help":
        say(AGENT_HELP);
        break;
      case "approval-mode":
        if (command.mode === null) {
          say(
            command.given
              ? `There is no mode called "${command.given}". The modes are plan, ask, auto-edit and yolo.`
              : `The mode is ${mode}. ${MODES_BY_NAME[mode].summary}`,
          );
        } else {
          setMode(command.mode);
          say(
            command.mode === "yolo"
              ? "Mode: yolo. The desktop app asks you to allow it when the next run starts; it lasts this session only."
              : `Mode: ${command.mode}. ${MODES_BY_NAME[command.mode].summary}`,
          );
        }
        break;
      case "restore":
        try {
          if (command.id === null) {
            const list = await host.checkpoints();
            say(
              list.length === 0
                ? "No checkpoints yet: one is kept before each change the agent applies."
                : "Checkpoints, newest first (/restore <id> puts the files back as they were before it, and undoes every later one):\n" +
                    list
                      .map(
                        (c) =>
                          `${c.id}: ${c.tool} ${c.files.map((f) => f.relative).join(", ")} (${new Date(c.created * 1000).toLocaleString()})`,
                      )
                      .join("\n"),
            );
          } else {
            const { restored } = await host.restore(command.id);
            say(
              restored.length === 0
                ? "Nothing to restore."
                : `Restored ${restored.join(", ")} to how ${restored.length === 1 ? "it was" : "they were"} before checkpoint ${command.id}.`,
            );
          }
        } catch (err) {
          say(hostError(err));
        }
        break;
      case "init":
        if (mode === "plan") {
          say("/init writes a file, which plan mode cannot. Switch to ask first (/approval-mode ask).");
        } else {
          await run(INIT_PROMPT, "/init");
        }
        break;
      case "unknown":
        say(`/${command.name} is not an agent command. ${AGENT_HELP}`);
        break;
    }
    return true;
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    if (await runCommand(text)) return;
    await run(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const at = CYCLE.indexOf(mode);
      setMode(CYCLE[(at + 1) % CYCLE.length]!);
    } else if (event.key === "Escape" && running) {
      stop();
    }
  };

  const blocked = props.unavailable !== null;

  return (
    <div data-mw-agent-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-mw-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => void hostCall(() => host.pickRoot())}
          >
            <FolderOpenIcon aria-hidden />
            {status?.root ? "Change folder" : "Choose folder"}
          </Button>
          <span data-mw-agent-root="" className="min-w-0 flex-1 truncate font-mono text-xs text-mw-text-muted">
            {status?.root ?? "No folder chosen"}
          </span>
          {status?.root && !status.trusted && (
            <Button
              variant="ghost"
              size="sm"
              disabled={running}
              title="Load this folder's MATTERWAVE.md and AGENTS.md into each run"
              onClick={() => void hostCall(() => host.trustRoot())}
            >
              <ShieldCheckIcon aria-hidden />
              Trust folder
            </Button>
          )}
          {status?.root && status.trusted && (
            <span className="text-xs text-mw-text-muted">Trusted</span>
          )}
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pb-2 text-xs text-mw-text-muted">
          <label htmlFor="agent-mode" className="sr-only">
            Approval mode
          </label>
          <SimpleSelect<ModeName>
            id="agent-mode"
            aria-label="Approval mode"
            size="sm"
            value={mode}
            onValueChange={setMode}
            options={(Object.keys(MODE_LABELS) as ModeName[]).map((m) => ({ value: m, label: MODE_LABELS[m] }))}
          />
          <label className="flex items-center gap-1">
            Steps
            <input
              type="number"
              min={1}
              max={200}
              value={caps.maxSteps}
              disabled={running}
              onChange={(e) => setCaps((c) => ({ ...c, maxSteps: Math.max(1, Number(e.target.value) || 1) }))}
              className="w-14 rounded border border-mw-border bg-transparent px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            Tokens
            <input
              type="number"
              min={1000}
              step={10000}
              value={caps.maxTokens}
              disabled={running}
              onChange={(e) =>
                setCaps((c) => ({ ...c, maxTokens: Math.max(1000, Number(e.target.value) || 1000) }))
              }
              className="w-24 rounded border border-mw-border bg-transparent px-1 py-0.5"
            />
          </label>
          {usage && (
            <span data-mw-agent-usage="">
              {usage.steps} {usage.steps === 1 ? "step" : "steps"}, {usage.tokens.toLocaleString("en")} tokens
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4 text-sm">
          {entries.length === 0 && (
            <p className="text-mw-text-muted">
              The agent reads and searches the folder you choose, and with your approval changes files and runs
              commands there, as you. Everything it reads is sent to the model. Type /help for the commands.
            </p>
          )}
          {entries.map((entry, i) => (
            <EntryView key={i} entry={entry} />
          ))}
          {approval && (
            <ApprovalCard
              request={approval.request}
              root={status?.root ?? ""}
              onAnswer={(ok) => approval.resolve(ok)}
            />
          )}
          {running && !approval && (
            <p aria-live="polite" className="text-mw-text-muted">
              Working…
            </p>
          )}
          {hostProblem && (
            <p role="alert" className="text-mw-danger">
              {hostProblem}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-mw-border">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 py-3">
          <label htmlFor="agent-composer" className="sr-only">
            Message the agent
          </label>
          <textarea
            id="agent-composer"
            data-mw-agent-composer=""
            rows={2}
            value={draft}
            disabled={blocked}
            placeholder={
              blocked
                ? (props.unavailable ?? "")
                : `Mode: ${mode}. Ask the agent, @path to attach a file, /help for commands. Shift+Tab changes the mode.`
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-11 flex-1 resize-y rounded-lg border border-mw-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {running ? (
            <Button variant="outline" onClick={stop} data-mw-agent-stop="">
              <SquareIcon aria-hidden />
              Stop
            </Button>
          ) : (
            <Button onClick={() => void submit()} disabled={blocked || !draft.trim()}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EntryView(props: { entry: Entry }) {
  const { entry } = props;
  switch (entry.kind) {
    case "user":
      return (
        <p className="self-end whitespace-pre-wrap rounded-lg bg-mw-surface-raised px-3 py-2">{entry.text}</p>
      );
    case "assistant":
      return <p className="whitespace-pre-wrap">{entry.text}</p>;
    case "notice":
      return <p className="whitespace-pre-wrap text-xs text-mw-text-muted">{entry.text}</p>;
    case "end":
      return (
        <div role="alert" data-mw-agent-end="" className="rounded-lg border border-mw-warning-border bg-mw-warning-subtle px-3 py-2">
          <p className="font-medium">{entry.title}</p>
          <p className="text-xs">{entry.guidance}</p>
          {entry.requestId && <p className="mt-1 font-mono text-xs text-mw-text-muted">Reference: {entry.requestId}</p>}
        </div>
      );
    case "tool":
      return (
        <details data-mw-agent-tool="" className="rounded-lg border border-mw-border px-3 py-1.5">
          <summary className="cursor-pointer font-mono text-xs">
            {entry.summary}
            {entry.result === null
              ? " …"
              : entry.result.rejected
                ? " (rejected)"
                : entry.result.isError
                  ? " (error)"
                  : entry.result.checkpoint !== undefined
                    ? ` (checkpoint ${entry.result.checkpoint})`
                    : ""}
          </summary>
          {entry.result?.diff && <DiffView diff={entry.result.diff} />}
          {entry.result && (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-mw-text-muted">
              {entry.result.output}
            </pre>
          )}
        </details>
      );
  }
}

/** A unified diff, line by line, with additions and removals marked. */
export function DiffView(props: { diff: string }) {
  const lines = props.diff.replace(/\n$/, "").split("\n");
  return (
    <pre data-mw-diff="" className="mt-1 max-h-96 overflow-auto rounded border border-mw-border font-mono text-xs">
      {lines.map((line, i) => {
        const tone = line.startsWith("+++") || line.startsWith("---")
          ? "text-mw-text-muted"
          : line.startsWith("+")
            ? "bg-mw-positive-subtle text-mw-positive"
            : line.startsWith("-")
              ? "bg-mw-danger-subtle text-mw-danger"
              : line.startsWith("@@")
                ? "text-mw-info"
                : "";
        return (
          <span key={i} className={`block px-2 ${tone}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * The approval: the whole change or the whole command, never shortened,
 * and two answers. Nothing happens until one is chosen.
 */
export function ApprovalCard(props: {
  request: ApprovalRequest;
  root: string;
  onAnswer: (ok: boolean) => void;
}) {
  const { request } = props;
  return (
    <div
      role="group"
      aria-label="Approval"
      data-mw-agent-approval=""
      className="rounded-lg border border-mw-border-emphasis bg-card px-3 py-2"
    >
      {request.kind === "write" ? (
        <>
          <p className="font-medium">
            {request.created ? "Create" : "Change"} <span className="font-mono">{request.path}</span>?
          </p>
          <DiffView diff={request.diff} />
        </>
      ) : (
        <>
          <p className="font-medium">Run this command?</p>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded border border-mw-border px-2 py-1 font-mono text-xs">
            {request.command}
          </pre>
          <p className="mt-1 text-xs text-mw-text-muted">
            In {props.root}, as you, with no sandbox
            {request.timeoutS === null ? "" : `; stopped after ${request.timeoutS} s`}.
          </p>
        </>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => props.onAnswer(true)}>
          {request.kind === "write" ? "Apply" : "Run"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => props.onAnswer(false)}>
          Reject
        </Button>
      </div>
    </div>
  );
}
