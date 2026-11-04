import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceOidcClaims,
  evaluateGuardrails,
  getOidcConfig,
  getReliabilityMetrics,
  getRunDecisionTrail,
  listConnectorCatalog,
  listRunCheckpoints,
  planTools,
  proxyOAuthRequest,
  registerOAuthAuthenticator,
  replayRun,
  resumeRun,
  syncAgentKeyOidc,
} from "./api";

describe("matterwaveClient desktop helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls OIDC, connector catalog, OAuth proxy, decision trail, replay, checkpoints, reliability, guardrails, and tool planner routes", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        return new Response(JSON.stringify({ ok: true, url, method }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await getOidcConfig();
    expect(calls[0]).toEqual({ url: "/api/v1/oidc/config", method: "GET", body: null });

    await syncAgentKeyOidc("key_1");
    expect(calls[1]).toEqual({ url: "/api/v1/agent-keys/key_1/oidc-sync", method: "POST", body: null });

    await enforceOidcClaims({ key_id: "key_1", requested_tools: ["read_file"] });
    expect(calls[2]).toEqual({
      url: "/api/v1/oidc/enforce-claims",
      method: "POST",
      body: { key_id: "key_1", requested_tools: ["read_file"] },
    });

    await listConnectorCatalog("developer", "github");
    expect(calls[3]).toEqual({
      url: "/api/v1/connectors/catalog?category=developer&q=github",
      method: "GET",
      body: null,
    });

    await registerOAuthAuthenticator({ name: "GitHub", provider_id: "github", client_id: "cid" });
    expect(calls[4]).toEqual({
      url: "/api/v1/oauth/register",
      method: "POST",
      body: { name: "GitHub", provider_id: "github", client_id: "cid" },
    });

    await proxyOAuthRequest("cred_1", {
      endpoint: "/repos",
      method: "POST",
      body: { name: "demo" },
      dry_run: true,
    });
    expect(calls[5]).toEqual({
      url: "/api/v1/oauth/proxy/cred_1",
      method: "POST",
      body: { endpoint: "/repos", method: "POST", body: { name: "demo" }, dry_run: true },
    });

    await getRunDecisionTrail("run_1");
    expect(calls[6]).toEqual({
      url: "/api/v1/runs/run_1/decision-trail",
      method: "GET",
      body: null,
    });

    await replayRun("run_1", "counterfactual", { temperature: 0 });
    expect(calls[7]).toEqual({
      url: "/api/v1/runs/run_1/replay",
      method: "POST",
      body: { mode: "counterfactual", overrides: { temperature: 0 } },
    });

    await listRunCheckpoints("run_1");
    expect(calls[8]).toEqual({
      url: "/api/v1/runs/run_1/checkpoints",
      method: "GET",
      body: null,
    });

    await resumeRun("run_1", "cp_1", { step: 2 });
    expect(calls[9]).toEqual({
      url: "/api/v1/runs/run_1/resume",
      method: "POST",
      body: { checkpoint_id: "cp_1", state_overrides: { step: 2 } },
    });

    await getReliabilityMetrics("agent_1");
    expect(calls[10]).toEqual({
      url: "/api/v1/reliability/metrics?agent_id=agent_1",
      method: "GET",
      body: null,
    });

    await evaluateGuardrails("input", "check this", { tool_name: "run_shell" });
    expect(calls[11]).toEqual({
      url: "/api/v1/guardrails/evaluate",
      method: "POST",
      body: { rail_type: "input", content: "check this", tool_name: "run_shell" },
    });

    await planTools("Run test suite", ["run_shell"], { max_steps: 3 });
    expect(calls[12]).toEqual({
      url: "/api/v1/tools/plan",
      method: "POST",
      body: {
        task: "Run test suite",
        goal: "Run test suite",
        available_tools: ["run_shell"],
        constraints: { max_steps: 3 },
      },
    });
  });
});
