import { apiFetch } from "./api";

export interface OidcConfig {
  adapter: string;
  issuer_url: string;
  token_endpoint: string;
  jwks_uri: string;
  admin_url: string;
  project_id: string;
  connected: boolean;
  status: string;
  [key: string]: unknown;
}

export interface A2ALimits {
  max_tokens: number;
  max_duration_seconds: number;
  max_cost_usd: number;
}

export interface A2APermissionEnvelope {
  allowed_tools: string[];
  denied_tools: string[];
  allowed_models: string[];
  cwd_scope: string;
  limits: A2ALimits;
}

export interface OidcSyncResult {
  key_id: string;
  idp_client_id: string;
  oidc_issuer: string;
  adapter: string;
  synced_at: string;
  scopes: string[];
  resource_pattern: string;
  a2a: A2APermissionEnvelope;
  [key: string]: unknown;
}

export interface EnforceOidcClaimsParams {
  key_id?: string;
  claims?: Record<string, unknown>;
  requested_tools?: string[];
  requested_model?: string;
  requested_cwd?: string;
  estimated_tokens?: number;
  estimated_duration_seconds?: number;
  estimated_cost_usd?: number;
  [key: string]: unknown;
}

export interface EnforceClaimsResult {
  allowed: boolean;
  violation_claim: string | null;
  detail: string;
  effective_tools: string[];
  resolved_cwd: string;
  limits: A2ALimits;
  [key: string]: unknown;
}

export interface ConnectorCatalogEntry {
  provider_id?: string;
  id?: string;
  name?: string;
  display_name?: string;
  category: string;
  auth_types?: string[];
  auth_type?: string;
  authorize_url?: string;
  token_url?: string;
  api_base_url?: string;
  default_scopes?: string[];
  scopes?: string[];
  description?: string;
  pkce_supported?: boolean;
  refresh_supported?: boolean;
  revoke_url?: string;
  docs_url?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface ConnectorCatalogList {
  data?: ConnectorCatalogEntry[];
  connectors?: ConnectorCatalogEntry[];
  total: number;
  [key: string]: unknown;
}

export interface RegisterOAuthAuthenticatorParams {
  name: string;
  provider_id?: string;
  connector_id?: string;
  client_id?: string;
  client_secret?: string;
  authorize_url?: string;
  token_url?: string;
  redirect_uri?: string;
  scopes?: string[];
  api_base_url?: string;
  tenant_id?: string | null;
  extra_authorize_params?: Record<string, string>;
  [key: string]: unknown;
}

export interface OAuthAuthenticator {
  authenticator_id?: string;
  credential_id?: string;
  name: string;
  provider_id?: string;
  connector_id?: string;
  org_id?: string;
  client_id?: string;
  client_secret_masked?: string;
  authorize_url?: string;
  token_url?: string;
  redirect_uri?: string;
  scopes: string[];
  api_base_url?: string;
  tenant_id?: string | null;
  extra_authorize_params?: Record<string, string>;
  created_at?: string;
  [key: string]: unknown;
}

export interface ProxyOAuthRequestOptions {
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  dryRun?: boolean;
  dry_run?: boolean;
}

export interface ProxyOAuthRequestInput extends ProxyOAuthRequestOptions {
  endpoint: string;
}

export interface CredentialProxyResponse {
  credential_id: string;
  provider_id?: string;
  connector_id?: string;
  method: string;
  target_url: string;
  status_code: number;
  auto_refreshed?: boolean;
  broker?: string;
  headers_injected: string[];
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DecisionNode {
  id?: string;
  node_id?: string;
  type?: string;
  node_type?: string;
  label: string;
  step_id?: string;
  step_index?: number;
  timestamp?: string;
  duration_ms?: number;
  confidence?: number;
  tokens_used?: number;
  cost_usd?: number;
  outcome?: string;
  rationale?: string;
  evidence?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DecisionEdge {
  from_node?: string;
  to_node?: string;
  source?: string;
  target?: string;
  edge_type?: string;
  relation?: string;
  label?: string;
  [key: string]: unknown;
}

export interface DecisionTrailStatistics {
  total_nodes: number;
  total_edges: number;
  tool_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  success: boolean;
}

export interface DecisionTrail {
  run_id: string;
  org?: string;
  nodes: DecisionNode[];
  edges: DecisionEdge[];
  statistics?: DecisionTrailStatistics;
  root_hash?: string | null;
  verified?: boolean;
  [key: string]: unknown;
}

export type ReplayMode = "strict" | "simulated" | "counterfactual";

export interface ReplayDifference {
  step_id?: string;
  step_index?: number;
  field: string;
  original: unknown;
  replayed: unknown;
  significance?: string;
}

export interface ReplayRunResult {
  replay_id?: string;
  replay_run_id?: string;
  run_id?: string;
  original_run_id?: string;
  mode: string;
  success?: boolean;
  status?: string;
  original_outcome?: Record<string, unknown>;
  replayed_outcome?: Record<string, unknown>;
  differences: ReplayDifference[];
  duration_ms?: number;
  created_at?: string;
  [key: string]: unknown;
}

export interface CheckpointRecord {
  checkpoint_id: string;
  thread_id?: string;
  run_id: string;
  step_id?: string;
  step_index: number;
  timestamp?: string;
  created_at?: string;
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parent_checkpoint_id?: string | null;
  [key: string]: unknown;
}

export interface CheckpointList {
  run_id: string;
  data?: CheckpointRecord[];
  checkpoints?: CheckpointRecord[];
  total?: number;
  [key: string]: unknown;
}

export interface ResumeRunResult {
  run_id?: string;
  resumed_run_id?: string;
  source_run_id?: string;
  original_run_id?: string;
  resumed_from_checkpoint_id?: string;
  checkpoint_id?: string;
  resumed_from_step: string | number;
  state?: string | Record<string, unknown>;
  status?: string;
  restored_state?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
}

export interface ReliabilityMetrics {
  org?: string;
  agent_id: string | null;
  sr?: number;
  cr?: number;
  pc?: number;
  hir?: number;
  ma?: number;
  tcl?: number;
  wct?: number;
  success_rate?: number;
  completion_rate?: number;
  tool_call_latency_ms?: number;
  wall_clock_time_ms?: number;
  cost_per_success?: number;
  total_runs: number;
  window?: string;
  [key: string]: unknown;
}

export type GuardrailType = "input" | "dialog" | "retrieval" | "execution" | "output" | (string & {});

export interface EvaluateGuardrailsOptions {
  toolName?: string;
  tool_name?: string;
  toolArgs?: Record<string, unknown>;
  tool_args?: Record<string, unknown>;
  policies?: string[];
}

export interface GuardrailViolation {
  rail_id?: string;
  rail_type?: string;
  category?: string;
  severity: string;
  message: string;
  matched_text?: string | null;
}

export interface GuardrailEvaluation {
  rail_type: string;
  action: string;
  allowed: boolean;
  modified_content?: string;
  refusal_message?: string | null;
  triggered_rails?: string[];
  violations: GuardrailViolation[];
  [key: string]: unknown;
}

export interface ToolPlanStep {
  step_id?: string;
  step_index?: number;
  tool_name: string;
  description: string;
  arguments?: Record<string, unknown>;
  arguments_template?: Record<string, unknown>;
  depends_on: Array<string | number>;
  estimated_cost_usd?: number;
  estimated_time_ms?: number;
  fallback_tool?: string | null;
}

export interface ToolPlan {
  plan_id: string;
  task?: string;
  goal?: string;
  steps: ToolPlanStep[];
  execution_order?: string[][];
  total_estimated_cost_usd?: number;
  total_estimated_time_ms?: number;
  confidence?: number;
  [key: string]: unknown;
}

export interface GrtModelEntry {
  repo_id: string;
  alias: string;
  model_type: string;
  auto_class: string;
  pipeline_tag: string;
  hf_url: string;
  weight_sha256: string | null;
  config_sha256: string;
}

export interface GrtSuiteCatalog {
  organization: string;
  hf_url: string;
  total: number;
  models: GrtModelEntry[];
  data?: GrtModelEntry[];
  [key: string]: unknown;
}

export interface RerankItem {
  index: number;
  relevance_score: number;
  score?: number;
  document?: { text: string; [key: string]: unknown } | string;
}

export interface RerankResult {
  model: string;
  query?: string;
  results: RerankItem[];
  data?: RerankItem[];
  [key: string]: unknown;
}

export interface SpeechSynthesisResult {
  model: string;
  voice: string;
  format: string;
  sample_rate_hz: number;
  duration_ms?: number;
  audio_base64: string;
  [key: string]: unknown;
}

export const GRT_HF_ORG = "MatterWaveAI";
export const GRT_HF_ORG_URL = "https://huggingface.co/MatterWaveAI";

export const GRT_HF_MODELS: readonly GrtModelEntry[] = [
  {
    repo_id: "MatterWaveAI/grt-30m",
    alias: "grt-30m",
    model_type: "grt",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m",
    weight_sha256: "205f76f3ed59fee0ed54bb8133ea1b1a64527994c68776066057b4707f1b2456",
    config_sha256: "5ffa4facb3cfba2b39512bbc54c7b7ecda637c70f40fd18ede13396cd8e5a86b",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-chat",
    alias: "grt-30m-chat",
    model_type: "grt",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-chat",
    weight_sha256: "ee613803cb7b2c618def7e6c79476e1aab4e887cc08e234204b6bad12ad772bc",
    config_sha256: "c2b264a05e11914a8e41c1610f3c81e15d38151c459a1c66caaaa0381d804685",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-mor",
    alias: "grt-30m-mor",
    model_type: "grt_mor",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-mor",
    weight_sha256: "5633a578073e808d18fe3e52fb0fbf0005dc015b6bb10a1bff339f5d83225a07",
    config_sha256: "bf652df2d4107c7e7ef3c23d0854436aedb0030f0821f97939ed6ed858254013",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-embedding",
    alias: "grt-30m-embedding",
    model_type: "grt",
    auto_class: "GRTModel",
    pipeline_tag: "feature-extraction",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-embedding",
    weight_sha256: "5cdab387c5e2ee9bb3907acaccfccfaa7cc10060c21e3f265ce981a4a7d38226",
    config_sha256: "c987cec1b71deba4a1749a939032309921872ae2a6c21378f8160edb29b210df",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-reranker",
    alias: "grt-30m-reranker",
    model_type: "grt",
    auto_class: "GRTForSequenceClassification",
    pipeline_tag: "text-classification",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-reranker",
    weight_sha256: "6d090decc4426a1c21a372c1bd718a6b80626e2c7b460c9ab79b713d84320ef9",
    config_sha256: "6f401b7ed6af93ed7fc93eedc6de44ad67f2f19ecdc5b3c96dcc92ee564750fc",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-vl",
    alias: "grt-30m-vl",
    model_type: "grt_vl",
    auto_class: "GRTVLForConditionalGeneration",
    pipeline_tag: "image-text-to-text",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-vl",
    weight_sha256: "b21667c9d39c67513671af4fe4480551f26ac738b23821902fd78ae55a4f1dfe",
    config_sha256: "0fd2f34d415723412d54055ecb174bcbb60cccaf43235af52b6c13826e6bb859",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-tts",
    alias: "grt-30m-tts",
    model_type: "grt_tts",
    auto_class: "GRTTTSForConditionalGeneration",
    pipeline_tag: "text-to-speech",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tts",
    weight_sha256: "9df117cf2d9fdd14a972495293628bfea4ab503ee4fbcb270ffb667763e314f4",
    config_sha256: "74dca6d26f2726ae96033446d5d418a152aef8368a8e49aa49bb15f6364ca75a",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-omni",
    alias: "grt-30m-omni",
    model_type: "grt_omni",
    auto_class: "GRTOmniForConditionalGeneration",
    pipeline_tag: "any-to-any",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-omni",
    weight_sha256: "b314996ce883a0c875de18da67f5d23103c507c79b7421b8b8c52cef95d2fbf7",
    config_sha256: "5bc88f708534280522872f046e89deade537f286a78bc261c1e039d03fa6d0cf",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-tokenizer",
    alias: "grt-30m-tokenizer",
    model_type: "grt",
    auto_class: "AutoTokenizer",
    pipeline_tag: "feature-extraction",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tokenizer",
    weight_sha256: null,
    config_sha256: "4c7ed24fcbaf5b1c62ec160296e682eb7b700ea19d88f0a8e01e363b125d505f",
  },
];

/** `GET /api/v1/oidc/config`: retrieve OIDC identity provider configuration. */
export function getOidcConfig(): Promise<OidcConfig> {
  return apiFetch<OidcConfig>("/api/v1/oidc/config");
}

/** `POST /api/v1/agent-keys/{keyId}/oidc-sync`: synchronize an agent key with OIDC claims and A2A permissions. */
export function syncAgentKeyOidc(keyId: string): Promise<OidcSyncResult> {
  const cleaned = keyId.trim();
  if (!cleaned) throw new Error("keyId must not be empty");
  return apiFetch<OidcSyncResult>(`/api/v1/agent-keys/${encodeURIComponent(cleaned)}/oidc-sync`, {
    method: "POST",
  });
}

/** `POST /api/v1/oidc/enforce-claims`: evaluate OIDC claims and A2A permission envelope. */
export function enforceOidcClaims(payload: EnforceOidcClaimsParams): Promise<EnforceClaimsResult> {
  return apiFetch<EnforceClaimsResult>("/api/v1/oidc/enforce-claims", {
    method: "POST",
    json: payload,
  });
}

/** `GET /api/v1/connectors/catalog`: list providers in the universal connector catalog. */
export function listConnectorCatalog(category?: string, q?: string): Promise<ConnectorCatalogList> {
  const params = new URLSearchParams();
  if (category && category.trim()) params.set("category", category.trim());
  if (q && q.trim()) params.set("q", q.trim());
  const qs = params.toString();
  return apiFetch<ConnectorCatalogList>(`/api/v1/connectors/catalog${qs ? `?${qs}` : ""}`);
}

/** `POST /api/v1/oauth/register`: register an OAuth authenticator for a connector provider. */
export function registerOAuthAuthenticator(
  payload: RegisterOAuthAuthenticatorParams,
): Promise<OAuthAuthenticator> {
  return apiFetch<OAuthAuthenticator>("/api/v1/oauth/register", {
    method: "POST",
    json: payload,
  });
}

/** `POST /api/v1/oauth/proxy/{credentialId}`: execute a credential-brokered OAuth proxy request. */
export function proxyOAuthRequest(
  credentialId: string,
  request: ProxyOAuthRequestInput | string,
  methodOrOptions: string | ProxyOAuthRequestOptions = "GET",
  options: ProxyOAuthRequestOptions = {},
): Promise<CredentialProxyResponse> {
  const cleanedId = credentialId.trim();
  if (!cleanedId) throw new Error("credentialId must not be empty");
  let endpoint: string;
  let merged: ProxyOAuthRequestOptions;
  if (typeof request === "object" && request !== null) {
    const { endpoint: ep, ...rest } = request;
    endpoint = ep;
    merged =
      typeof methodOrOptions === "object" && methodOrOptions !== null
        ? { ...rest, ...methodOrOptions, ...options }
        : { ...rest, ...options };
  } else {
    endpoint = request;
    merged =
      typeof methodOrOptions === "string"
        ? { ...options, method: methodOrOptions }
        : { ...methodOrOptions, ...options };
  }
  const cleanedEndpoint = endpoint.trim();
  if (!cleanedEndpoint) throw new Error("endpoint must not be empty");
  const payload: Record<string, unknown> = {
    endpoint: cleanedEndpoint,
    method: (merged.method ?? "GET").trim().toUpperCase(),
  };
  if (merged.params !== undefined) payload.params = merged.params;
  if (merged.headers !== undefined) payload.headers = merged.headers;
  if (merged.body !== undefined) payload.body = merged.body;
  const dryRun = merged.dryRun ?? merged.dry_run;
  if (dryRun !== undefined) payload.dry_run = dryRun;
  return apiFetch<CredentialProxyResponse>(
    `/api/v1/oauth/proxy/${encodeURIComponent(cleanedId)}`,
    {
      method: "POST",
      json: payload,
    },
  );
}

/** `GET /api/v1/runs/{runId}/decision-trail`: retrieve the cryptographic decision trail DAG for a run. */
export function getRunDecisionTrail(runId: string): Promise<DecisionTrail> {
  const cleaned = runId.trim();
  if (!cleaned) throw new Error("runId must not be empty");
  return apiFetch<DecisionTrail>(`/api/v1/runs/${encodeURIComponent(cleaned)}/decision-trail`);
}

/** `POST /api/v1/runs/{runId}/replay`: replay a recorded run in strict, simulated, or counterfactual mode. */
export function replayRun(
  runId: string,
  mode: ReplayMode = "simulated",
  overrides?: Record<string, unknown>,
): Promise<ReplayRunResult> {
  const cleaned = runId.trim();
  if (!cleaned) throw new Error("runId must not be empty");
  return apiFetch<ReplayRunResult>(`/api/v1/runs/${encodeURIComponent(cleaned)}/replay`, {
    method: "POST",
    json: {
      mode,
      overrides: overrides ?? {},
    },
  });
}

/** `GET /api/v1/runs/{runId}/checkpoints`: list recorded execution checkpoints for a run. */
export function listRunCheckpoints(runId: string): Promise<CheckpointList> {
  const cleaned = runId.trim();
  if (!cleaned) throw new Error("runId must not be empty");
  return apiFetch<CheckpointList>(`/api/v1/runs/${encodeURIComponent(cleaned)}/checkpoints`);
}

/** `POST /api/v1/runs/{runId}/resume`: resume a run from a recorded checkpoint. */
export function resumeRun(
  runId: string,
  checkpointId?: string,
  stateOverrides?: Record<string, unknown>,
): Promise<ResumeRunResult> {
  const cleaned = runId.trim();
  if (!cleaned) throw new Error("runId must not be empty");
  const payload: Record<string, unknown> = {};
  if (checkpointId && checkpointId.trim()) payload.checkpoint_id = checkpointId.trim();
  if (stateOverrides !== undefined) payload.state_overrides = stateOverrides;
  return apiFetch<ResumeRunResult>(`/api/v1/runs/${encodeURIComponent(cleaned)}/resume`, {
    method: "POST",
    json: payload,
  });
}

/** `GET /api/v1/reliability/metrics`: retrieve agent reliability metrics (SR, CR, TCL, WCT, PC). */
export function getReliabilityMetrics(agentId?: string): Promise<ReliabilityMetrics> {
  const params = new URLSearchParams();
  if (agentId && agentId.trim()) params.set("agent_id", agentId.trim());
  const qs = params.toString();
  return apiFetch<ReliabilityMetrics>(`/api/v1/reliability/metrics${qs ? `?${qs}` : ""}`);
}

/** `POST /api/v1/guardrails/evaluate`: evaluate programmable guardrails on content or tool calls. */
export function evaluateGuardrails(
  railType: GuardrailType,
  content: string,
  options: EvaluateGuardrailsOptions = {},
): Promise<GuardrailEvaluation> {
  const payload: Record<string, unknown> = {
    rail_type: railType.trim(),
    content,
  };
  const toolName = options.toolName ?? options.tool_name;
  if (toolName !== undefined) payload.tool_name = toolName;
  const toolArgs = options.toolArgs ?? options.tool_args;
  if (toolArgs !== undefined) payload.tool_args = toolArgs;
  if (options.policies !== undefined) payload.policies = options.policies;
  return apiFetch<GuardrailEvaluation>("/api/v1/guardrails/evaluate", {
    method: "POST",
    json: payload,
  });
}

/** `POST /api/v1/tools/plan`: generate a structured multi-step tool execution plan for a goal. */
export function planTools(
  goal: string,
  availableTools?: string[],
  constraints?: Record<string, unknown>,
): Promise<ToolPlan> {
  const cleaned = goal.trim();
  if (!cleaned) throw new Error("goal must not be empty");
  const payload: Record<string, unknown> = {
    task: cleaned,
    goal: cleaned,
  };
  if (availableTools !== undefined) payload.available_tools = availableTools;
  if (constraints !== undefined) payload.constraints = constraints;
  return apiFetch<ToolPlan>("/api/v1/tools/plan", {
    method: "POST",
    json: payload,
  });
}

/** `POST /v1/rerank`: score and rank candidate documents against a query using `MatterWaveAI/grt-30m-reranker`. */
export function rerank(
  query: string,
  documents: string[],
  model = "MatterWaveAI/grt-30m-reranker",
): Promise<RerankResult> {
  const cleaned = query.trim();
  if (!cleaned) throw new Error("query must not be empty");
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("documents must be a non-empty array");
  }
  return apiFetch<RerankResult>("/v1/rerank", {
    method: "POST",
    json: {
      query: cleaned,
      documents: [...documents],
      model,
    },
  });
}

/** `POST /v1/audio/speech`: synthesize speech audio from text using `MatterWaveAI/grt-30m-tts`. */
export function synthesizeSpeech(
  text: string,
  model = "MatterWaveAI/grt-30m-tts",
  voice = "aurora",
): Promise<SpeechSynthesisResult> {
  const cleaned = text.trim();
  if (!cleaned) throw new Error("text must not be empty");
  return apiFetch<SpeechSynthesisResult>("/v1/audio/speech", {
    method: "POST",
    json: {
      input: cleaned,
      text: cleaned,
      model,
      voice,
    },
  });
}

/** `GET /api/v1/models/grt-suite`: retrieve the 9-model MatterWaveAI GRT-30M Hugging Face suite catalog. */
export function getGrtSuite(): Promise<GrtSuiteCatalog> {
  return apiFetch<GrtSuiteCatalog>("/api/v1/models/grt-suite");
}
