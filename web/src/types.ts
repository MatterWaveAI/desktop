import type { MessagePart } from "./apps/chat/chatAdapter";

export type AuthMode = "none" | "oidc";

/** The flags this build reads by name; the API may serve others an operator defined. */
export type FlagName = "agents_ui" | "app_registry" | "dev_tokens" | "dev_states";

export interface AuthConfig {
  auth_mode: AuthMode;
  csrf_cookie: string;
  default_model: string;
  /**
   * The flags `GET /api/auth-config` serves under `flags`, resolved for the
   * caller's org: the shipped defaults plus every row an operator defined
   * (/admin, Flags), so the keys are not a closed set.
   */
  flags?: Partial<Record<FlagName, boolean>> & Record<string, boolean | undefined>;
  issuer?: string;
  client_id?: string;
  /** The API route that starts sign-in; the SPA only navigates to it. */
  login_url?: string;
  /**
   * Zitadel hands its login UI to us: the landing page's Sign
   * in goes to our `/login` instead of straight to the IdP. Optional because
   * an API that predates the flag does not send it, and that API has no
   * password endpoint to post to - so absent reads as false.
   */
  password_login?: boolean;
  /**
   * Passkeys are offered on /login and in Settings: the API relays the
   * WebAuthn ceremony to the identity provider (passkeys.py). Absent reads
   * as false, like `password_login`.
   */
  passkey_login?: boolean;
  /**
   * The terms version signup stamps on the account, e.g. "2026-09".
   * The /terms page shows it; the API owns the constant, the SPA has no copy.
   */
  terms_version?: string;
  /**
   * Where to get help and where the service's status is published, when
   * the deployment sets them (MW_SUPPORT_URL / MW_STATUS_URL). Absent
   * otherwise, and the pages that link them show nothing.
   */
  support_url?: string;
  status_url?: string;
  /**
   * Whether `POST /api/speech/transcribe` has a transcriber behind it
   * (MW_SPEECH_TRANSCRIBER). The composer's dictation uses it only in a
   * browser with no SpeechRecognition of its own; absent reads as false.
   */
  speech_transcription?: boolean;
  redirect_uri?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  end_session_endpoint?: string;
  scopes?: string[];
}

/**
 * The onboarding state machine, derived by the API from the
 * users row: `pending_verification` -> `active` -> `suspended`. A suspended
 * account never reaches the shell - the API answers 403 with
 * `status: "suspended"` instead - so a Principal here is one of the first two.
 */
export type AccountState = "pending_verification" | "active" | "suspended";

export interface Principal {
  subject: string;
  kind: string;
  email: string | null;
  name: string | null;
  /** The platform claim: operator authority (/admin), never the org's. */
  roles: string[];
  org_id: string | null;
  /** The org's display name, null for an identity with no users row. */
  org_name: string | null;
  /**
   * The caller's `organization_members.role` -- owner, admin, member or
   * viewer -- which is what every org-level pane gates on. Null when the
   * caller holds no membership row, which a platform operator may not.
   */
  org_role: string | null;
  /** Optional because an API that predates it sends none; absent reads as active. */
  state?: AccountState;
  /** The terms version this account accepted; null for an identity with no users row. */
  terms_version?: string | null;
  /**
   * Whether that version is the one in force. False is the re-accept gate;
   * optional because an API that predates it sends none, and absent reads
   * as current so an older API cannot lock everyone out.
   */
  terms_current?: boolean;
  /**
   * Whether the first-run walkthrough was finished or skipped. False is the
   * onboarding gate; optional because an API that predates it sends none,
   * and absent reads as done so an older API never shows the gate.
   */
  onboarding_completed?: boolean;
  /**
   * Whether the account has a password to change: false under
   * MW_AUTH_MODE=none and for an SSO-only account, and the Password card
   * is hidden. Optional because an API that predates it sends none, and
   * absent reads as none so an older API never shows a card that cannot work.
   */
  has_password?: boolean;
}

/** One browser session, as `GET /api/me/sessions` lists it. */
export interface SessionInfo {
  id: string;
  /** The session making the request. */
  current: boolean;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
}

/** `GET/PUT /api/me/preferences`: the whole shape, every time. */
export interface Preferences {
  email: {
    product_updates: boolean;
    usage_alerts: boolean;
    /** Transactional, so always true; the API refuses false. */
    billing_receipts: true;
  };
  locale: string | null;
  notifications: {
    budget_warn: boolean;
  };
}

/** The org itself, as `GET /api/org` answers it, with the caller's own role. */
export interface OrgSummary {
  id: string;
  name: string;
  created_at: string;
  role: string;
}

/** An org's claimed email domain, as `/api/org/domains` lists it. */
export interface OrgDomain {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

/** An org's attached identity provider, as `/api/org/idp` lists it; never the secret. */
export interface OrgIdp {
  /** The handle `/api/auth/login?idp=` takes; unique across orgs. */
  provider: string;
  kind: "oidc" | "saml";
  name: string;
  issuer: string | null;
  created_at: string;
}

/** `GET /api/auth/idp?email=`: the provider /login offers for a verified domain. */
export interface LoginIdp {
  provider: string;
  name: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /**
   * Which branch the thread shows. A conversation is a tree through
   * `Message.parent_id`; this is the leaf whose root-ward path `messages` is.
   * Optional because an API that predates the column does not send it.
   */
  current_leaf_message_id?: string | null;
  /**
   * Pin and archive are nullable timestamps, not booleans — the API
   * sends the ISO string or null, and "when" is what orders two pinned rows.
   * Optional here because the seeder and older fixtures predate the columns.
   */
  pinned_at?: string | null;
  archived_at?: string | null;
  /**
   * The folder this conversation is filed in, null for the main list.
   * Optional because an API that predates folders does not send it.
   */
  folder_id?: string | null;
  /**
   * Not kept: absent from every list and search, never shared, pinned or
   * filed, and deleted a day after its last message. Fixed at creation.
   * Optional because an API that predates temporary chat does not send it.
   */
  temporary?: boolean;
}

/**
 * One row of `GET /api/search`: a conversation plus where it matched.
 * The snippet is built by Postgres (`ts_headline`) with the match wrapped
 * in SNIPPET_OPEN/SNIPPET_CLOSE, so the highlight follows the same stemmer
 * the search did. `message_id` is null when the TITLE matched: there is
 * nothing in the transcript to jump to.
 */
export interface SearchHit extends Conversation {
  snippet: string;
  message_id: string | null;
}

/** One page of `GET /api/search`; `next_cursor` is null on the last. */
export interface SearchPage {
  data: SearchHit[];
  query: string;
  next_cursor: string | null;
}

/** A sidebar folder, as `GET /api/library` lists it. */
export interface Folder {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  name: string;
  created_at: string;
}

/**
 * `GET /api/library`: the folders, the tags, and which tag ids each
 * conversation carries. One read because the sidebar needs all three to
 * draw itself and they change together.
 */
export interface LibraryState {
  folders: Folder[];
  tags: Tag[];
  assignments: Record<string, string[]>;
}

/** One row of `GET /api/me/notifications`. */
export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** An in-app path to open, or null when there is nowhere to go. */
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationsPage {
  data: Notification[];
  unread_count: number;
}

/** What `GET /api/conversations?filter=` accepts. */
export type ConversationFilter = "default" | "all" | "pinned" | "archived";

/**
 * The two fields custom instructions ask for: what MatterWave should
 * know about you, and how it should respond. `GET/PUT /api/me/instructions`.
 */
export interface UserInstructions {
  about: string;
  style: string;
}

/**
 * What is in force for one conversation, level by level.
 *
 * The precedence is the API's, never re-derived here: org instructions are
 * additive policy and always apply, and a conversation prompt REPLACES the
 * user's two fields for that thread. `effective` is the assembled text the
 * model actually receives, so the UI shows what is in force rather than its
 * own guess at how the levels combine.
 */
export interface EffectiveInstructions {
  org: string;
  user: UserInstructions;
  conversation: string;
  /** True when a conversation prompt is displacing the user's own. */
  user_overridden: boolean;
  effective: string;
}

export interface ConversationWithMessages extends Conversation {
  /** The active path root-to-leaf, not every message. */
  messages: Message[];
  /** Every message, including the siblings the path leaves out. `?full=1`. */
  tree?: Message[];
  /** What is in force for this conversation, level by level. */
  instructions: EffectiveInstructions;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  /**
   * The ordered typed parts of the message. Optional because an API
   * that predates typed parts sends only `content`; a client reading such a
   * response falls back to one text part.
   */
  parts?: MessagePart[];
  /** The text of the parts, flattened. Always sent, so an older client works. */
  content: string;
  /** The parts schema this message was written against. */
  content_version?: number;
  created_at: string;
  parent_id: string | null;
  model: string | null;
}

export interface ReadyStatus {
  status: "ok" | "degraded";
  detail?: string;
}

/** One entry of `GET /api/models`. */
export interface ModelInfo {
  id: string;
  object?: string;
  /** What the upstream exposes; null when it does not say. */
  context_window: number | null;
  /**
   * A model the deployment marks as experimental (`MW_RESEARCH_PREVIEW_MODELS`
   * on the API): rendered as a research preview, never as a plain picker choice.
   */
  research_preview: boolean;
  /**
   * Whether this model accepts image input, as the gateway
   * reports it. **Tri-state, and `null` is not `false`:** it means the
   * gateway said nothing, which a bare llama.cpp or vLLM `/v1/models` does
   * for every model it serves. `vision.py` on the API side owns the reasoning
   * and `apps/chat/vision.ts` mirrors the reading of it; the short version is
   * that unknown is allowed through, because refusing every attachment on a
   * gateway that publishes no metadata would make the feature dead on the
   * default local setup.
   *
   * Optional because an API that predates attachments does not send it, and absent
   * reads the same as `null`.
   */
  supports_vision?: boolean | null;
  /** The display name, from the deployment's price list (the id when it names none). */
  label: string;
  /** How many allowance tokens one of this model's tokens counts as. */
  multiplier: number;
  /** List price per million tokens, in US dollars. */
  input_usd_per_m: number;
  output_usd_per_m: number;
  /**
   * Whether the caller's plan includes this model. A model it does not is
   * still listed, so a person learns it exists and what unlocks it; a turn
   * on it is refused with a 402.
   */
  included: boolean;
  /** The cheapest plan, by display name, that includes it; null when none does or it is included. */
  upgrade_to: string | null;
  /**
   * Another provider's model, offered for testing: included only on a plan
   * that names it, which by default none does. The picker lists these apart.
   */
  partner: boolean;
}

/** The model picker's source of truth: whatever the upstream serves. */
export interface ModelsResponse {
  object: "list";
  data: ModelInfo[];
  default_model: string;
}
