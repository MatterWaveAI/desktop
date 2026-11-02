/**
 * The webview's side of the native tool host (src-tauri/src/agent): typed
 * wrappers over its allow-listed commands, and nothing else. Every file
 * read or write and every command happens in Rust, which confines each
 * path itself; nothing here touches a file, and nothing here is trusted
 * by the other side. A command, and a write the mode asks about, is
 * approved by the person in the desktop app's own dialog, which the host
 * raises from inside the call: nothing here can answer it.
 *
 * `AgentHost` is the seam the loop runs against, so the loop's tests drive
 * it with an in-memory fake instead of a desktop.
 */
import { desktopInvoke, isDesktop } from "../../lib/desktopAuth";
import type { ModeName } from "./sdk/types";

/** What the host reports of agent mode. */
export interface AgentStatus {
  enabled: boolean;
  /** The workspace root picked this session, if any. */
  root: string | null;
  /** Whether the root's context files are trusted. */
  trusted: boolean;
  platform: "windows" | "macos" | "linux";
  shell: string;
  contract_version: string;
  yolo_confirmed: boolean;
  /** auto-edit was allowed in the desktop app's dialog for this folder this session. */
  auto_edit_confirmed: boolean;
}

export const AGENT_OFF: AgentStatus = {
  enabled: false,
  root: null,
  trusted: false,
  platform: "linux",
  shell: "sh",
  contract_version: "",
  yolo_confirmed: false,
  auto_edit_confirmed: false,
};

export interface ContextFile {
  path: string;
  text: string;
  truncated: boolean;
}

export interface RunStarted {
  run_id: string;
  mode: ModeName;
  root: string;
  platform: "windows" | "macos" | "linux";
  /** The trusted root's MATTERWAVE.md / AGENTS.md / MATTERWAVE.local.md. */
  context: ContextFile[];
  /** Context files that exist but were not loaded: the folder is not trusted. */
  untrusted_context: string[];
}

/** A tool's answer for the model. */
export interface ToolOutput {
  output: string;
  is_error: boolean;
  /** The person said no in the desktop app's dialog: an answer, not an error. */
  rejected?: boolean;
}

/** What a write would do, for the diff the approval shows. */
export interface WritePreview {
  status: "preview";
  relative: string;
  /** The file as it is; null when it does not exist yet. */
  before: string | null;
  after: string;
  before_sha256: string;
}

export type WriteOutcome =
  | WritePreview
  | { status: "applied"; output: string; relative: string; checkpoint: number }
  /** The person said no in the desktop app's dialog. */
  | { status: "rejected"; output: string }
  | { status: "error"; output: string };

export type ReadTool = "read_file" | "list_dir" | "glob" | "grep";
export type WriteTool = "edit" | "write_file";

export interface Checkpoint {
  id: number;
  /** Unix seconds. */
  created: number;
  tool: string;
  label: string | null;
  files: { relative: string; existed: boolean }[];
}

export interface AgentHost {
  status(): Promise<AgentStatus>;
  setEnabled(enabled: boolean): Promise<AgentStatus>;
  pickRoot(): Promise<AgentStatus>;
  trustRoot(): Promise<AgentStatus>;
  startRun(mode: ModeName, label: string | null): Promise<RunStarted>;
  stopRun(runId: string): Promise<void>;
  read(runId: string, tool: ReadTool, args: unknown): Promise<ToolOutput>;
  /**
   * A write's preview, or its apply against the preview's fingerprint.
   * Where the mode asks, the apply waits on the desktop app's dialog.
   */
  write(
    runId: string,
    tool: WriteTool,
    args: unknown,
    step: { apply: false } | { apply: true; expectedSha256: string },
  ): Promise<WriteOutcome>;
  /** One command; where the mode asks, after the desktop app's dialog. */
  shell(runId: string, args: unknown): Promise<ToolOutput>;
  checkpoints(): Promise<Checkpoint[]>;
  /** Confirmed in the desktop app's dialog, with the files it puts back. */
  restore(checkpointId: number): Promise<{ restored: string[] }>;
}

const READ_COMMANDS: Record<ReadTool, string> = {
  read_file: "agent_read_file",
  list_dir: "agent_list_dir",
  glob: "agent_glob",
  grep: "agent_grep",
};

/** The host in the desktop shell: one native command per call. */
export const desktopHost: AgentHost = {
  status: () => desktopInvoke<AgentStatus>("agent_state"),
  setEnabled: (enabled) => desktopInvoke<AgentStatus>("agent_set_enabled", { enabled }),
  pickRoot: () => desktopInvoke<AgentStatus>("agent_pick_root"),
  trustRoot: () => desktopInvoke<AgentStatus>("agent_trust_root"),
  startRun: (mode, label) => desktopInvoke<RunStarted>("agent_start_run", { mode, label }),
  stopRun: (runId) => desktopInvoke<void>("agent_stop_run", { run_id: runId }),
  read: (runId, tool, args) => desktopInvoke<ToolOutput>(READ_COMMANDS[tool], { run_id: runId, args }),
  write: (runId, tool, args, step) =>
    desktopInvoke<WriteOutcome>(tool === "edit" ? "agent_edit" : "agent_write_file", {
      run_id: runId,
      args,
      apply: step.apply,
      expected_sha256: step.apply ? step.expectedSha256 : null,
    }),
  shell: (runId, args) => desktopInvoke<ToolOutput>("agent_run_shell", { run_id: runId, args }),
  checkpoints: () => desktopInvoke<Checkpoint[]>("agent_checkpoints"),
  restore: (checkpointId) =>
    desktopInvoke<{ restored: string[] }>("agent_restore", { checkpoint_id: checkpointId }),
};

/**
 * Whether agent mode is switched on, as the host says. Off outside the
 * desktop shell and when the host cannot be asked (an older app).
 */
export async function agentStatus(host: AgentHost = desktopHost): Promise<AgentStatus> {
  if (host === desktopHost && !isDesktop()) return AGENT_OFF;
  try {
    return await host.status();
  } catch {
    return AGENT_OFF;
  }
}

/** A native command's refusal, as a sentence. Tauri rejects with the string the command returned. */
export function hostError(err: unknown): string {
  if (typeof err === "string" && err) return err;
  if (err instanceof Error && err.message) return err.message;
  return "The desktop app could not do that.";
}
