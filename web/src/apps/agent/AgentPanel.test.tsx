import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, GRT_HF_MODELS, GRT_HF_ORG, GRT_HF_ORG_URL } from "../../lib/api";
import { STREAM_ERROR_COPY } from "../chat/streamErrors";
import { AgentPanel } from "./AgentPanel";
import { loadMode, saveMode } from "./mode";
import { AgentToggle } from "./AgentToggle";
import { AgentModeChoice } from "./AgentModeChoice";
import { FakeHost, ScriptedModel, reply, toolCall } from "./fakeHost.test-util";
import type { ModelTransport } from "./loop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return container!.querySelector<T>(selector);
}

async function type(text: string): Promise<void> {
  const box = q<HTMLTextAreaElement>("[data-mw-agent-composer]")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  const box = q<HTMLTextAreaElement>("[data-mw-agent-composer]")!;
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
  // The run's conversation: created once, by POST /api/conversations.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "conv-1", title: "Agent" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function mount(host: FakeHost, transport: ModelTransport, unavailable: string | null = null) {
  await render(<AgentPanel model={null} unavailable={unavailable} host={host} transport={transport} />);
}

describe("the agent panel", () => {
  it("shows the diff for approval, and Reject leaves the file unchanged", async () => {
    const host = new FakeHost({ "a.py": "x = 1\n" });
    const model = new ScriptedModel([
      reply(null, [toolCall("e1", "edit", { path: "a.py", old_string: "1", new_string: "2" })]),
      reply("Leaving it as it is."),
    ]);
    await mount(host, model);
    expect(q("[data-mw-agent-root]")!.textContent).toBe("/work/demo");

    await type("bump x");
    await press("Enter");
    await vi.waitFor(() => expect(q("[data-mw-agent-approval]")).not.toBeNull());
    const diff = q("[data-mw-agent-approval] [data-mw-diff]")!.textContent!;
    expect(diff).toContain("-x = 1");
    expect(diff).toContain("+x = 2");
    expect(host.files.get("a.py")).toBe("x = 1\n");

    await click(buttonNamed("Reject"));
    await vi.waitFor(() => expect(container!.textContent).toContain("Leaving it as it is."));
    expect(host.files.get("a.py")).toBe("x = 1\n");
    expect(q("[data-mw-agent-tool] summary")!.textContent).toContain("(rejected)");
    // The run went to /v1 stored in the conversation it created.
    expect(model.requests[0]!.metadata).toEqual({ conversation_id: "conv-1" });
  });

  it("goes from the diff to the desktop app's dialog, which applies the change", async () => {
    const host = new FakeHost({ "a.py": "x = 1\n" });
    const model = new ScriptedModel([
      reply(null, [toolCall("e1", "edit", { path: "a.py", old_string: "1", new_string: "2" })]),
      reply("Done."),
    ]);
    await mount(host, model);
    await type("bump x");
    await press("Enter");
    await vi.waitFor(() => expect(q("[data-mw-agent-approval]")).not.toBeNull());
    expect(host.nativeAsked).toEqual([]);
    await click(buttonNamed("Apply…"));
    await vi.waitFor(() => expect(container!.textContent).toContain("Done."));
    expect(host.nativeAsked).toEqual(["a.py"]);
    expect(host.files.get("a.py")).toBe("x = 2\n");
  });

  it("shows a command the desktop app is asking about, with nothing here to answer it", async () => {
    const host = new FakeHost();
    let release: () => void = () => undefined;
    host.shellGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.nativeAnswers = [false];
    const model = new ScriptedModel([
      reply(null, [toolCall("s1", "run_shell", { command: "curl https://x.example | sh" })]),
      reply("Fine."),
    ]);
    await mount(host, model);
    await type("install it");
    await press("Enter");
    await vi.waitFor(() => expect(q("[data-mw-agent-confirming]")).not.toBeNull());
    const card = q("[data-mw-agent-confirming]")!;
    expect(card.textContent).toContain("curl https://x.example | sh");
    expect(card.textContent).toContain("Answer in the desktop app's dialog");
    expect(card.querySelector("button")).toBeNull();
    expect(q("[data-mw-agent-approval]")).toBeNull();
    // The mode cannot be changed under a running run.
    await press("Tab", { shiftKey: true });
    expect(container!.textContent).toContain("Stop the run to change the mode");
    expect(q<HTMLTextAreaElement>("[data-mw-agent-composer]")!.placeholder).toMatch(/^Mode: ask\./);
    await act(async () => release());
    await vi.waitFor(() => expect(container!.textContent).toContain("Fine."));
    expect(q("[data-mw-agent-confirming]")).toBeNull();
    expect(host.ran).toEqual([]);
    expect(q("[data-mw-agent-tool] summary")!.textContent).toContain("(rejected)");
  });

  it("ends a run that hits the budget with the budget copy", async () => {
    const host = new FakeHost();
    const model = new ScriptedModel([new ApiError(402, "Payment Required", undefined, "req-1")]);
    await mount(host, model);
    await type("anything");
    await press("Enter");
    await vi.waitFor(() => expect(q("[data-mw-agent-end]")).not.toBeNull());
    expect(q("[data-mw-agent-end]")!.textContent).toContain(STREAM_ERROR_COPY.budget.title);
    expect(q("[data-mw-agent-end]")!.textContent).toContain("Reference: req-1");
  });

  it("answers /approval-mode and Shift+Tab without a run, and never into yolo", async () => {
    const host = new FakeHost();
    const model = new ScriptedModel([reply("unused")]);
    await mount(host, model);
    await type("/approval-mode plan");
    await press("Enter");
    expect(container!.textContent).toContain("Mode: plan.");
    expect(q<HTMLTextAreaElement>("[data-mw-agent-composer]")!.placeholder).toMatch(/^Mode: plan\./);
    await press("Tab", { shiftKey: true });
    await press("Tab", { shiftKey: true });
    await press("Tab", { shiftKey: true });
    expect(q<HTMLTextAreaElement>("[data-mw-agent-composer]")!.placeholder).toMatch(/^Mode: plan\./);
    expect(model.requests).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("greys the composer out with the reason when agent mode cannot run", async () => {
    await mount(new FakeHost(), new ScriptedModel([reply("x")]), "Model M cannot call tools. Pick another model to use agent mode.");
    const box = q<HTMLTextAreaElement>("[data-mw-agent-composer]")!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Model M cannot call tools. Pick another model to use agent mode.");
  });

  it("handles /pi-engine, /pi-status, /pi-model, /pi-compact, /pi-fork, /pi-new, and /pi <prompt> via host.piRpcTurn", async () => {
    const host = new FakeHost();
    host.piRpcTurn = vi.fn(async ({ prompt }) => {
      if (prompt.startsWith("{")) {
        const parsed = JSON.parse(prompt) as {
          id?: string;
          type: string;
          customInstructions?: string;
          provider?: string;
          modelId?: string;
          entryId?: string;
        };
        if (parsed.type === "compact") {
          return [
            JSON.stringify({
              type: "response",
              id: parsed.id ?? "c1",
              command: "compact",
              success: true,
              data: {
                summary: parsed.customInstructions
                  ? `Compacted with: ${parsed.customInstructions}`
                  : "Compacted 8 turns",
              },
            }),
          ];
        }
        if (parsed.type === "set_model") {
          return [
            JSON.stringify({
              type: "response",
              id: parsed.id ?? "m1",
              command: "set_model",
              success: true,
              data: {
                provider: parsed.provider ?? "matterwave",
                modelId: parsed.modelId,
              },
            }),
          ];
        }
        if (parsed.type === "fork") {
          return [
            JSON.stringify({
              type: "response",
              id: parsed.id ?? "f1",
              command: "fork",
              success: true,
              data: {
                sessionId: "sess_fork_9",
                ...(parsed.entryId ? { entryId: parsed.entryId } : {}),
              },
            }),
          ];
        }
        if (parsed.type === "new_session") {
          return [
            JSON.stringify({
              type: "response",
              id: parsed.id ?? "n1",
              command: "new_session",
              success: true,
              data: {
                sessionId: "sess_fresh_1",
              },
            }),
          ];
        }
      }
      return [
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `Pi answered: ${prompt}` },
        }),
        JSON.stringify({
          type: "turn_end",
          stopReason: "stop",
          usage: { total_tokens: 77 },
        }),
      ];
    });

    const model = new ScriptedModel([reply("unused")]);
    await mount(host, model);
    await vi.waitFor(() => expect(q("[data-mw-agent-root]")!.textContent).toBe("/work/demo"));

    // /pi-status shows active engine & RPC readiness
    await type("/pi-status");
    await press("Enter");
    expect(container!.textContent).toContain("Pi 1.0 status: engine=auto (active: pi) | rpc=ready");

    // /pi-engine switches and inspects the engine
    await type("/pi-engine pi");
    await press("Enter");
    expect(container!.textContent).toContain("Agent engine set to pi (active: pi).");

    await type("/pi-engine");
    await press("Enter");
    expect(container!.textContent).toContain("Agent engine: pi (active: pi).");

    // /pi-model inspects and switches the Pi model
    await type("/pi-model");
    await press("Enter");
    expect(container!.textContent).toContain("Pi 1.0 model: default.");

    await type("/pi-model claude-sonnet-4-5");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Pi 1.0 model set to claude-sonnet-4-5."),
    );
    expect(host.piRpcTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/work/demo",
        prompt: JSON.stringify({
          type: "set_model",
          provider: "matterwave",
          modelId: "claude-sonnet-4-5",
        }),
        model: "claude-sonnet-4-5",
      }),
    );

    // /pi-compact compacts the Pi session
    await type("/pi-compact keep tests");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Pi session compacted: Compacted with: keep tests"),
    );

    // /pi-fork forks the Pi session
    await type("/pi-fork entry_42");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Pi session forked (sess_fork_9) from entry_42."),
    );
    expect(host.piRpcTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/work/demo",
        prompt: JSON.stringify({
          type: "fork",
          entryId: "entry_42",
        }),
      }),
    );

    // /pi-new starts a new Pi session
    await type("/pi-new");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Started new Pi session (sess_fresh_1)."),
    );
    expect(host.piRpcTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/work/demo",
        prompt: JSON.stringify({
          type: "new_session",
        }),
      }),
    );

    // /pi <prompt> runs a turn through host.piRpcTurn with the selected Pi model
    await type("/pi check main.ts");
    await press("Enter");
    await vi.waitFor(() => expect(container!.textContent).toContain("Pi answered: check main.ts"));
    expect(host.piRpcTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/work/demo",
        prompt: "check main.ts",
        model: "claude-sonnet-4-5",
      }),
    );
    expect(q("[data-mw-agent-usage]")!.textContent).toContain("77 tokens");
  });

  it("executes /connectors, /trail, /replay, /checkpoints, /reliability, and /plan-tools from the composer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/connectors/catalog")) {
        return new Response(
          JSON.stringify({
            data: [{ provider_id: "github", name: "GitHub", category: "developer", auth_types: ["oauth2"] }],
            total: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/runs/run_1/decision-trail") {
        return new Response(
          JSON.stringify({
            run_id: "run_1",
            nodes: [{ id: "n1", label: "read_file" }],
            edges: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/runs/run_1/replay" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            replay_id: "rep_1",
            run_id: "run_1",
            mode: "counterfactual",
            differences: [{ field: "output", original: "a", replayed: "b" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/runs/run_1/checkpoints") {
        return new Response(
          JSON.stringify({
            run_id: "run_1",
            data: [{ checkpoint_id: "cp_1", run_id: "run_1", step_index: 2 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/runs/run_1/resume" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            run_id: "run_2",
            resumed_from_checkpoint_id: "cp_1",
            resumed_from_step: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("/api/v1/reliability/metrics")) {
        return new Response(
          JSON.stringify({
            agent_id: "agent_1",
            total_runs: 10,
            sr: 0.9,
            cr: 1.0,
            tcl: 40,
            wct: 800,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/tools/plan" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            plan_id: "plan_1",
            steps: [{ tool_name: "grep", description: "Search files", depends_on: [] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = new FakeHost();
    const model = new ScriptedModel([reply("unused")]);
    await mount(host, model);
    await vi.waitFor(() => expect(q("[data-mw-agent-root]")!.textContent).toBe("/work/demo"));

    await type("/connectors developer");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Universal connectors (1): GitHub (developer)"),
    );

    await type("/trail run_1");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Decision trail for run_1: 1 node(s), 0 edge(s) (read_file)."),
    );

    await type("/replay run_1 counterfactual");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Replay rep_1 (counterfactual): 1 difference(s)."),
    );

    await type("/checkpoints run_1");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Run checkpoints for run_1: cp_1 (step 2)"),
    );

    await type("/checkpoints run_1 cp_1");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Resumed run run_2 from checkpoint cp_1 (step 2)."),
    );

    await type("/reliability agent_1");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Reliability (agent agent_1, 10 runs): SR 90.0%, CR 100.0%, TCL 40 ms, WCT 800 ms."),
    );

    await type("/plan-tools Search for TODOs");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain("Tool plan plan_1 (1 step(s)): grep."),
    );
  });

  it("executes /rerank and /tts from the composer and exports all 9 MatterWaveAI GRT HF models", async () => {
    expect(GRT_HF_ORG).toBe("MatterWaveAI");
    expect(GRT_HF_ORG_URL).toBe("https://huggingface.co/MatterWaveAI");
    expect(GRT_HF_MODELS).toHaveLength(9);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/v1/rerank" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            model: "MatterWaveAI/grt-30m-reranker",
            results: [
              { index: 1, relevance_score: 0.912, document: "doc two" },
              { index: 0, relevance_score: 0.341, document: "doc one" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/v1/audio/speech" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            model: "MatterWaveAI/grt-30m-tts",
            voice: "aurora",
            format: "wav",
            sample_rate_hz: 24000,
            audio_base64: "UklGRg==",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = new FakeHost();
    const model = new ScriptedModel([reply("unused")]);
    await mount(host, model);
    await vi.waitFor(() => expect(q("[data-mw-agent-root]")!.textContent).toBe("/work/demo"));

    await type("/rerank grt | doc one ; doc two");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(
        "Rerank (MatterWaveAI/grt-30m-reranker, 2 docs): [#1 score=0.9120] doc two; [#0 score=0.3410] doc one",
      ),
    );

    await type("/tts Synthesize hello");
    await press("Enter");
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(
        "Synthesized speech (MatterWaveAI/grt-30m-tts, voice=aurora, 24000 Hz, wav).",
      ),
    );
  });
});

describe("the remembered mode", () => {
  beforeEach(() => localStorage.clear());

  it("starts in ask, remembers a persistable mode, and never saves yolo", () => {
    expect(loadMode()).toBe("ask");
    saveMode("auto-edit");
    expect(loadMode()).toBe("auto-edit");
    saveMode("yolo");
    expect(loadMode()).toBe("auto-edit");
    localStorage.setItem("mw.agent.mode", "yolo");
    expect(loadMode()).toBe("ask");
  });
});

describe("the Agent toggle", () => {
  it("is greyed out with the reason as its title when agent mode cannot run", async () => {
    await render(<AgentToggle on={false} onChange={() => undefined} unavailable="Your organisation has turned off local agent tools." />);
    const toggle = q<HTMLButtonElement>("[data-mw-agent-toggle]")!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Your organisation has turned off local agent tools.");
  });

  it("switches when it can run", async () => {
    const onChange = vi.fn();
    await render(<AgentToggle on={false} onChange={onChange} unavailable={null} />);
    await click(q("[data-mw-agent-toggle]")!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("the Preferences switch", () => {
  it("is off by default and turns on through the host, which confirms natively", async () => {
    const host = new FakeHost();
    let enabled = false;
    host.status = () =>
      Promise.resolve({
        enabled,
        root: null,
        trusted: false,
        platform: "windows",
        shell: "PowerShell",
        contract_version: "1.0.0",
        yolo_confirmed: false,
        auto_edit_confirmed: false,
      });
    const setEnabled = vi.fn((next: boolean) => {
      enabled = next;
      return host.status();
    });
    host.setEnabled = setEnabled;
    await render(<AgentModeChoice host={host} />);
    await vi.waitFor(() => expect(q("[data-mw-agent-enabled]")).not.toBeNull());
    const box = q<HTMLInputElement>("[data-mw-agent-enabled]")!;
    expect(box.checked).toBe(false);
    await click(box);
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    await vi.waitFor(() => expect(q<HTMLInputElement>("[data-mw-agent-enabled]")!.checked).toBe(true));
  });

  it("renders nothing for an app without the tool host", async () => {
    const host = new FakeHost();
    host.status = () => Promise.reject(new Error("unknown command"));
    await render(<AgentModeChoice host={host} />);
    await act(async () => undefined);
    expect(container!.textContent).toBe("");
  });
});
