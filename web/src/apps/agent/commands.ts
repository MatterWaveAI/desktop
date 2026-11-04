/**
 * Agent mode's composer: its slash commands and `@path` mentions. Pure, so
 * the parsing is testable without a desktop.
 */
import { MODE_NAMES, type ModeName } from "./sdk/types";

export const PI_ENGINE_NAMES = ["auto", "pi", "builtin"] as const;
export type PiEngineName = (typeof PI_ENGINE_NAMES)[number];

export const REPLAY_MODES = ["strict", "simulated", "counterfactual"] as const;
export type ReplayModeName = (typeof REPLAY_MODES)[number];

export type AgentSlashCommand =
  | { kind: "approval-mode"; mode: ModeName | null; given: string }
  | { kind: "restore"; id: number | null }
  | { kind: "init" }
  | { kind: "help" }
  | { kind: "pi"; prompt: string }
  | { kind: "pi-engine"; engine: PiEngineName | null }
  | { kind: "pi-model"; model: string }
  | { kind: "pi-compact"; instructions: string }
  | { kind: "pi-fork"; entryId: string }
  | { kind: "pi-new" }
  | { kind: "pi-status" }
  | { kind: "connectors"; category: string }
  | { kind: "trail"; runId: string }
  | { kind: "replay"; runId: string; mode: ReplayModeName }
  | { kind: "checkpoints"; runId: string; checkpointId: string }
  | { kind: "reliability"; agentId: string }
  | { kind: "plan-tools"; goal: string }
  | { kind: "unknown"; name: string };

export type AgentCommand = AgentSlashCommand;

/** The composer's text as a command, or null when it is a prompt. */
export function parseAgentCommand(text: string): AgentSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const arg = rest.join(" ").trim();
  switch (name) {
    case "approval-mode":
    case "mode": {
      const wanted = arg.toLowerCase();
      const mode = (MODE_NAMES as readonly string[]).includes(wanted) ? (wanted as ModeName) : null;
      return { kind: "approval-mode", mode, given: arg };
    }
    case "restore": {
      const id = /^\d+$/.test(arg) ? Number(arg) : null;
      return { kind: "restore", id };
    }
    case "init":
      return { kind: "init" };
    case "help":
      return { kind: "help" };
    case "pi":
      return { kind: "pi", prompt: arg };
    case "pi-engine":
    case "agent-engine": {
      const wanted = arg.toLowerCase();
      const engine = (PI_ENGINE_NAMES as readonly string[]).includes(wanted)
        ? (wanted as PiEngineName)
        : null;
      return { kind: "pi-engine", engine };
    }
    case "pi-model":
      return { kind: "pi-model", model: arg };
    case "pi-compact":
      return { kind: "pi-compact", instructions: arg };
    case "pi-fork":
      return { kind: "pi-fork", entryId: arg };
    case "pi-new":
      return { kind: "pi-new" };
    case "pi-status":
      return { kind: "pi-status" };
    case "connectors":
      return { kind: "connectors", category: arg };
    case "trail":
      return { kind: "trail", runId: arg };
    case "replay": {
      const runId = (rest[0] ?? "").trim();
      const rawMode = (rest[1] ?? "").trim().toLowerCase();
      const mode: ReplayModeName = (REPLAY_MODES as readonly string[]).includes(rawMode)
        ? (rawMode as ReplayModeName)
        : "simulated";
      return { kind: "replay", runId, mode };
    }
    case "checkpoints": {
      const runId = (rest[0] ?? "").trim();
      const checkpointId = (rest[1] ?? "").trim();
      return { kind: "checkpoints", runId, checkpointId };
    }
    case "reliability":
      return { kind: "reliability", agentId: arg };
    case "plan-tools":
      return { kind: "plan-tools", goal: arg };
    default:
      return { kind: "unknown", name };
  }
}

export const AGENT_HELP =
  "Agent commands: /approval-mode [plan|ask|auto-edit|yolo] shows or sets the mode " +
  "(Shift+Tab cycles plan, ask and auto-edit while no run is going; auto-edit and yolo are each allowed in the desktop app's own dialog once per folder per session, and yolo is never remembered). " +
  "/restore lists the file checkpoints, and /restore <id> puts the files back as they were before it. " +
  "/init drafts a MATTERWAVE.md for this folder. " +
  "/pi <prompt> runs a prompt through the Pi 1.0 RPC engine, /pi-engine [auto|pi|builtin] shows or switches the agent engine, " +
  "/pi-model [model] shows or sets the Pi 1.0 model, /pi-compact [instructions] compacts the Pi 1.0 session, " +
  "/pi-fork [entryId] forks the Pi 1.0 session, /pi-new starts a new Pi 1.0 session, and /pi-status shows Pi 1.0 engine status. " +
  "/connectors [category] lists universal connectors, /trail <runId> inspects a run decision trail, " +
  "/replay <runId> [strict|simulated|counterfactual] replays a run, /checkpoints <runId> [checkpointId] lists or resumes run checkpoints, " +
  "/reliability [agentId] shows agent reliability metrics, and /plan-tools <goal> generates a tool execution plan. " +
  "@path attaches a file from the folder to your message.";

/** What /init asks the agent to do. It goes through approval like any write (and in auto-edit, MATTERWAVE.md still asks). */
export const INIT_PROMPT =
  "Look around this folder and draft a MATTERWAVE.md at its root for future agent runs: what the project is, " +
  "how it is laid out, how to build, test and lint it, and the conventions its code follows. Read before you " +
  "write, keep it short and factual, and say nothing you did not check. If a MATTERWAVE.md already exists, " +
  "improve it with edit rather than replacing it. Create it with write_file.";

/** At most this many `@path` files go with one message. */
export const MAX_MENTIONS = 5;

/**
 * The `@path` mentions in a prompt, in order and without repeats: an `@`
 * at the start or after whitespace, then a path. An email address is not
 * one (its `@` follows a letter).
 */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([\w./\\-]*[\w/\\-])/g)) {
    const path = match[1]!.replace(/[.,;:]+$/, "");
    if (path && !found.includes(path)) found.push(path);
  }
  return found.slice(0, MAX_MENTIONS);
}

/** The prompt with each mentioned file's text (or its refusal) attached below it. */
export function withAttachments(prompt: string, files: readonly { path: string; text: string; isError: boolean }[]): string {
  if (files.length === 0) return prompt;
  const blocks = files.map((f) =>
    f.isError
      ? `[@${f.path} was not attached: ${f.text}]`
      : `<file path="${f.path}">\n${f.text.replace(/\n$/, "")}\n</file>`,
  );
  return `${prompt}\n\nFiles the user attached (line numbers are not part of the files):\n\n${blocks.join("\n\n")}`;
}
