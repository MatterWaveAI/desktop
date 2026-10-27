import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OrgDomain, OrgIdp, OrgSummary, Principal } from "../../../types";
import { ShellContext, type ShellContextValue } from "../../../shell/shellContext";
import { jsonResponse } from "../../../shell/frontDoorHarness";
import { PARTNER_MODELS_HEADING, PARTNER_MODELS_NOTE } from "../../../lib/billing";
import { OrganisationPane } from "./OrganisationPane";
import { chooseOption, optionsOf, selectNamed, selectShown } from "./paneHarness";

/**
 * The Organisation pane: a member -- or a platform operator with no
 * membership -- is told it is for admins and nothing is fetched; an owner or
 * admin by membership sees the org's name, domains and providers, and every
 * action is the API call the routes expect. Same harness as
 * settings.test.tsx - react-dom directly, fetch stubbed by method and URL.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const authConfig: AuthConfig = { auth_mode: "oidc", csrf_cookie: "mw_csrf", default_model: "m" };

/** `roles` is the platform claim; `orgRole` the membership row the pane gates on. */
function principal(orgRole: string | null, roles: string[] = []): Principal {
  return {
    subject: "ada",
    kind: "user",
    email: "ada@acme.com",
    name: null,
    roles,
    org_id: "org-1",
    org_name: ORG.name,
    org_role: orgRole,
  };
}

function shellValue(orgRole: string | null, roles: string[]): ShellContextValue {
  return {
    authConfig,
    principal: principal(orgRole, roles),
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    // Pin, archive and the list filter. Inert here -- these harnesses
    // mount panes that never touch the conversation list.
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: async () => {},
  };
}

const ORG: OrgSummary = {
  id: "org-1",
  name: "Ada Lovelace (ada@acme.com)",
  created_at: "2026-09-28T00:00:00Z",
  role: "owner",
};
const DOMAINS: OrgDomain[] = [
  { domain: "acme.com", verified: true, verified_at: "2026-09-28T00:00:00Z", verified_by: "ada", created_at: "2026-09-28T00:00:00Z" },
  { domain: "acme.dev", verified: false, verified_at: null, verified_by: null, created_at: "2026-09-28T00:00:00Z" },
];
const IDPS: OrgIdp[] = [
  { provider: "okta", kind: "oidc", name: "Okta", issuer: "https://acme.okta.com", created_at: "2026-09-28T00:00:00Z" },
];

const ORG_INSTRUCTIONS = "Answer in British English.";

/** `GET /api/org/domains/acme.dev/challenge`: the record the API minted for the claim. */
const CHALLENGE = {
  type: "TXT",
  host: "_matterwave-verify",
  name: "_matterwave-verify.acme.dev",
  value: "matterwave-verify=tok_7f3a9c",
};

/** The verify route's state block, as a 200 (proven) answers it. */
function verified(domain: string) {
  return {
    domain,
    verified: true,
    verified_at: "2026-10-03T10:00:00Z",
    verified_by: "ada",
    method: "dns",
    last_checked_at: "2026-10-03T10:00:00Z",
    last_error: null,
    record: CHALLENGE,
  };
}

/** The 202: accepted, not proven, with what DNS actually held. */
function pending(domain: string, detail: string, found: string[]) {
  return {
    domain,
    verified: false,
    verified_at: null,
    verified_by: null,
    method: null,
    last_checked_at: "2026-10-03T10:00:00Z",
    last_error: detail,
    detail,
    record: CHALLENGE,
    found,
  };
}

const RECOVERY = {
  id: "rc-1",
  created_at: "2026-10-03T10:00:00Z",
  expires_at: "2026-11-02T10:00:00Z",
  created_by: "ada",
  used_at: null,
  code: "MWRC-ALPHA-BRAVO-CHARLIE",
  shown_once: true,
};

/** jsdom has no clipboard; the pane's Copy buttons need one to say "Copied". */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

/** The open dialog's content, rendered in a portal outside the pane's container. */
function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-slot='dialog-content']");
  expect(found, "an open dialog").not.toBeNull();
  return found!;
}

function dialogButton(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll("button")].find((b) => b.textContent === label);
  expect(found, `a dialog button "${label}"`).toBeDefined();
  return found!;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** One entry of `GET /api/org/models`: allowed, unlocked, a GRT model named by its id unless told otherwise. */
function orgModel(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    partner: false,
    context_window: null as number | null,
    research_preview: false,
    allowed: true,
    locked: false,
    ...over,
  };
}

/** `GET /api/org/models`: the plan's three models, nothing switched off, the house model locked. */
const MODELS = {
  house_model: "fake-mini",
  restricted: false,
  unlisted: [],
  data: [
    orgModel("fake-mini", { label: "Fake Mini", context_window: 8192, locked: true }),
    orgModel("big-model", { label: "Big Model", context_window: 128000 }),
    orgModel("tiny-demo", { research_preview: true }),
  ],
};

/** One audit row as `GET /api/org/audit` lists it. */
function auditRow(id: string, action: string, over: Record<string, unknown> = {}) {
  return {
    id,
    occurred_at: "2026-10-03T10:00:00+00:00",
    actor: "ada",
    actor_email: "ada@acme.com",
    action,
    target: null,
    detail: {},
    ...over,
  };
}

const AUDIT_PAGE = {
  data: [
    auditRow("e1", "org.models.updated", { detail: { allowed: ["big-model", "fake-mini"] } }),
    auditRow("e2", "org.plan.changed", { actor: "stripe:evt_1", actor_email: null, target: "pro" }),
  ],
  next_cursor: null,
  actions: ["org.models.updated", "org.plan.changed", "org.rename"],
};

/**
 * Stub fetch by "METHOD url"; the GETs answer the fixtures unless overridden.
 * The audit routes carry a query string, so they match on the path.
 */
function stubOrgApi(answers: Record<string, Record<string, unknown>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${String(input)}`;
    if (key in answers) return answers[key];
    const path = `${(init?.method ?? "GET").toUpperCase()} ${String(input).split("?")[0]}`;
    if (path in answers) return answers[path];
    if (key === "GET /api/org") return jsonResponse(ORG);
    if (key === "GET /api/org/domains") return jsonResponse({ data: DOMAINS });
    if (key === "GET /api/org/idp") return jsonResponse({ data: IDPS });
    // The pane loads the org's custom instructions with the rest.
    if (key === "GET /api/org/instructions") return jsonResponse({ text: ORG_INSTRUCTIONS });
    // And the enforcement policy: off, with nothing in the way, unless a test says otherwise.
    if (key === "GET /api/org/sso") return jsonResponse({ sso_required: false, blockers: [] });
    // And whether a second factor is required of every member: not, unless a test says so.
    if (key === "GET /api/org/mfa") return jsonResponse({ mfa_required: false });
    if (key === "GET /api/org/models") return jsonResponse(MODELS);
    // Sharing by link: on, with no links made, unless a test says otherwise.
    if (key === "GET /api/org/sharing") return jsonResponse({ enabled: true });
    if (key === "GET /api/org/shares") return jsonResponse({ data: [] });
    if (path === "GET /api/org/audit") return jsonResponse(AUDIT_PAGE);
    return jsonResponse({ detail: `no mock for ${key}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function render(orgRole: string | null, roles: string[] = []): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ShellContext.Provider value={shellValue(orgRole, roles)}>
        <OrganisationPane />
      </ShellContext.Provider>,
    );
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(found, `a button "${label}"`).toBeDefined();
  return found!;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** The pane's sub-section tabs, by their visible name. */
function tab(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>("[role='tab']")].find(
    (t) => t.textContent === name,
  );
  expect(found, `a tab "${name}"`).toBeDefined();
  return found!;
}

async function openTab(name: string): Promise<void> {
  await vi.waitFor(() => expect(container!.querySelector("[role='tablist']")).not.toBeNull());
  await click(tab(name));
}

/** The visible panel's content: the inactive ones are hidden, not gone. */
function panel(): HTMLElement {
  const found = container!.querySelector<HTMLElement>("[role='tabpanel']:not([hidden])");
  expect(found, "a visible tab panel").not.toBeNull();
  return found!;
}

/** A field's own error, through aria-describedby, the way a screen reader reaches it. */
function fieldError(input: HTMLElement): string | null {
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el?.getAttribute("role") === "alert") return el.textContent;
  }
  return null;
}

function calls(fetchMock: ReturnType<typeof vi.fn>): { key: string; body: unknown }[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const i = init as RequestInit | undefined;
    return {
      key: `${(i?.method ?? "GET").toUpperCase()} ${String(input)}`,
      body: i?.body ? JSON.parse(String(i.body)) : undefined,
    };
  });
}

describe("a member", () => {
  it("is told the pane is for admins, and nothing is fetched", async () => {
    const fetchMock = stubOrgApi();
    await render("member");
    expect(container!.textContent).toContain("Organisation settings are for admins");
    expect(container!.querySelector("form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is what a platform operator without a membership is here, whatever the claim says", async () => {
    // The Zitadel admin claim opens /admin; the API refuses every /api/org
    // route to someone with no membership row, so nothing is offered.
    const fetchMock = stubOrgApi();
    await render(null, ["admin"]);
    expect(container!.textContent).toContain("Organisation settings are for admins");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("an owner or admin by membership", () => {
  it("sees the org's name, and renames it through the API with the name trimmed", async () => {
    const fetchMock = stubOrgApi({
      "PATCH /api/org": jsonResponse({ ...ORG, name: "Acme Ltd" }),
    });
    // No platform claim at all: a self-signed-up owner has none.
    await render("owner");
    await vi.waitFor(() => {
      expect(container!.querySelector("input[name='org_name']")).not.toBeNull();
    });
    const input = container!.querySelector<HTMLInputElement>("input[name='org_name']")!;
    expect(input.value).toBe(ORG.name);
    const save = button("Save name");
    expect(save.disabled).toBe(true); // unchanged

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  Acme Ltd  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Save name").disabled).toBe(false);
    await submit(input.form!);

    expect(calls(fetchMock).find((c) => c.key === "PATCH /api/org")?.body).toEqual({
      name: "Acme Ltd",
    });
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='status'][aria-live='polite']")?.textContent).toBe("Saved.");
    });
    expect(input.value).toBe("Acme Ltd");
  });

  it("will not send a blank name", async () => {
    const fetchMock = stubOrgApi();
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("input[name='org_name']")).not.toBeNull();
    });
    const input = container!.querySelector<HTMLInputElement>("input[name='org_name']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "   ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Save name").disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await submit(input.form!);
    expect(calls(fetchMock).some((c) => c.key === "PATCH /api/org")).toBe(false);
  });

  it("sees the org's domains, their verification, and its providers", async () => {
    stubOrgApi();
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("ul[aria-label='Claimed domains']")).not.toBeNull();
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("acme.com");
    expect(text).toContain("Verified by ada");
    expect(text).toContain("acme.dev");
    expect(text).toContain("Not verified");
    // Only the unverified domain offers verification.
    expect(button("Verify acme.dev")).toBeDefined();
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent === "Verify acme.com")).toBe(false);
    await openTab("Sign-in & security");
    expect(panel().textContent).toContain("Okta");
    expect(panel().textContent).toContain("https://acme.okta.com");
    expect(panel().textContent).toContain("handle okta");
  });

  it("claims a domain, verifies one, and releases one through the API, reloading after each", async () => {
    const fetchMock = stubOrgApi({
      "POST /api/org/domains": jsonResponse({ domain: "acme.io", verified: false }, 201),
      "GET /api/org/domains/acme.dev/challenge": jsonResponse({ record: CHALLENGE }),
      "POST /api/org/domains/acme.dev/verify": jsonResponse(verified("acme.dev")),
      "DELETE /api/org/domains/acme.com": { ok: true, status: 204, json: async () => ({}), statusText: "" },
    });
    await render("owner");
    await vi.waitFor(() => {
      expect(container!.querySelector("ul[aria-label='Claimed domains']")).not.toBeNull();
    });

    const input = container!.querySelector<HTMLInputElement>("input[name='domain']")!;
    input.value = " Acme.io ";
    await submit(input.form!);
    // Verify opens the record; the check is a second, deliberate press.
    await click(button("Verify acme.dev"));
    await vi.waitFor(() => expect(button("Check acme.dev now")).toBeDefined());
    await click(button("Check acme.dev now"));
    await click(button("Remove acme.com"));

    const seen = calls(fetchMock);
    expect(seen.find((c) => c.key === "POST /api/org/domains")?.body).toEqual({ domain: "Acme.io" });
    expect(seen.some((c) => c.key === "GET /api/org/domains/acme.dev/challenge")).toBe(true);
    expect(seen.some((c) => c.key === "POST /api/org/domains/acme.dev/verify")).toBe(true);
    expect(seen.some((c) => c.key === "DELETE /api/org/domains/acme.com")).toBe(true);
    // The initial load plus one reload per action: claim, proven, release.
    expect(seen.filter((c) => c.key === "GET /api/org/domains").length).toBe(4);
  });

  it("attaches a provider with the API's body shape and removes one", async () => {
    const fetchMock = stubOrgApi({
      "POST /api/org/idp": jsonResponse({ provider: "entra", name: "Entra" }, 201),
      "DELETE /api/org/idp/okta": { ok: true, status: 204, json: async () => ({}), statusText: "" },
    });
    await render("admin");
    await openTab("Sign-in & security");
    await vi.waitFor(() => {
      expect(container!.querySelector("ul[aria-label='Identity providers']")).not.toBeNull();
    });

    const set = (name: string, value: string) => {
      container!.querySelector<HTMLInputElement>(`input[name='${name}']`)!.value = value;
    };
    set("name", "Entra");
    set("issuer", "https://login.example.com/tenant/v2.0");
    set("client_id", "app-id");
    set("client_secret", "shh");
    set("scopes", "openid email  groups");
    await submit(container!.querySelector<HTMLInputElement>("input[name='name']")!.form!);
    await click(button("Remove Okta"));

    const seen = calls(fetchMock);
    expect(seen.find((c) => c.key === "POST /api/org/idp")?.body).toEqual({
      kind: "oidc",
      name: "Entra",
      issuer: "https://login.example.com/tenant/v2.0",
      client_id: "app-id",
      client_secret: "shh",
      scopes: ["openid", "email", "groups"],
    });
    expect(seen.some((c) => c.key === "DELETE /api/org/idp/okta")).toBe(true);
  });

  it("shows the API's refusal beside the form and keeps the lists", async () => {
    stubOrgApi({
      "POST /api/org/domains": jsonResponse({ detail: "This domain is already claimed." }, 409),
    });
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("ul[aria-label='Claimed domains']")).not.toBeNull();
    });
    const input = container!.querySelector<HTMLInputElement>("input[name='domain']")!;
    input.value = "acme.com";
    await submit(input.form!);
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toBe(
        "This domain is already claimed.",
      );
    });
    // What was typed stays, so it can be corrected rather than retyped.
    expect(input.value).toBe("acme.com");
    expect(container!.querySelector("ul[aria-label='Claimed domains']")?.textContent).toContain("acme.dev");
  });
});

describe("the pane's sub-sections", () => {
  it("opens on General, with sign-in and the audit log a tab away", async () => {
    stubOrgApi();
    await render("owner");
    await vi.waitFor(() => expect(container!.querySelector("input[name='org_name']")).not.toBeNull());
    const list = container!.querySelector("[role='tablist']")!;
    expect([...list.querySelectorAll("[role='tab']")].map((t) => t.textContent)).toEqual([
      "General",
      "Sign-in & security",
      "Audit log",
    ]);
    // One row that scrolls sideways at phone width rather than wrapping.
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("flex-wrap");
    expect(tab("General").getAttribute("aria-selected")).toBe("true");
    expect(tab("Audit log").getAttribute("aria-selected")).toBe("false");
    expect(panel().querySelector("input[name='org_name']")).not.toBeNull();
    expect(panel().querySelector("ul[aria-label='Claimed domains']")).not.toBeNull();
    expect(panel().textContent).toContain("Close organisation");
    expect(panel().querySelector("[data-sso-required]")).toBeNull();

    await openTab("Sign-in & security");
    expect(tab("Sign-in & security").getAttribute("aria-selected")).toBe("true");
    expect(panel().querySelector("ul[aria-label='Identity providers']")).not.toBeNull();
    expect(panel().querySelector("[data-sso-required]")).not.toBeNull();
    expect(panel().querySelector("[data-mfa-required]")).not.toBeNull();
    expect(panel().querySelector("input[name='org_name']")).toBeNull();

    await openTab("Audit log");
    await vi.waitFor(() => {
      expect(panel().querySelector("table[aria-label='Audit events']")).not.toBeNull();
    });
  });

  it("does not read the audit trail until its tab is opened", async () => {
    const fetchMock = stubOrgApi();
    await render("owner");
    await vi.waitFor(() => expect(container!.querySelector("input[name='org_name']")).not.toBeNull());
    expect(calls(fetchMock).some((c) => c.key.startsWith("GET /api/org/audit"))).toBe(false);
    await openTab("Audit log");
    await vi.waitFor(() => {
      expect(calls(fetchMock).some((c) => c.key.startsWith("GET /api/org/audit"))).toBe(true);
    });
  });

  it("keeps a draft when the admin looks at another tab and comes back", async () => {
    stubOrgApi();
    await render("owner");
    await vi.waitFor(() => expect(container!.querySelector("input[name='org_name']")).not.toBeNull());
    const input = container!.querySelector<HTMLInputElement>("input[name='org_name']")!;
    await act(async () => {
      setValue(input, "Acme Ltd");
    });
    await openTab("Sign-in & security");
    await openTab("General");
    expect(container!.querySelector<HTMLInputElement>("input[name='org_name']")!.value).toBe("Acme Ltd");
  });

  it("moves between tabs with the arrow keys", async () => {
    stubOrgApi();
    await render("owner");
    await vi.waitFor(() => expect(container!.querySelector("[role='tablist']")).not.toBeNull());
    await act(async () => {
      tab("General").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tab("Sign-in & security").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Sign-in & security"));
    await act(async () => {
      tab("Sign-in & security").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(tab("General").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the forms' own checks", () => {
  async function renderGeneral(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi(answers);
    await render("owner");
    await vi.waitFor(() => expect(container!.querySelector("input[name='domain']")).not.toBeNull());
    return fetchMock;
  }

  it("refuses a domain that is not a bare hostname, under the field, and keeps what was typed", async () => {
    const fetchMock = await renderGeneral();
    const input = container!.querySelector<HTMLInputElement>("input[name='domain']")!;
    input.value = "https://acme.io/login";
    await submit(input.form!);
    expect(calls(fetchMock).some((c) => c.key === "POST /api/org/domains")).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(fieldError(input)).toContain("example.com");
    expect(input.value).toBe("https://acme.io/login");
  });

  it("asks for a domain when the field is empty", async () => {
    const fetchMock = await renderGeneral();
    const input = container!.querySelector<HTMLInputElement>("input[name='domain']")!;
    await submit(input.form!);
    expect(calls(fetchMock).some((c) => c.key === "POST /api/org/domains")).toBe(false);
    expect(fieldError(input)).toBe("Enter a domain.");
  });

  it("puts the API's 422 under the domain field, without pydantic's prefix, and keeps the input", async () => {
    await renderGeneral({
      "POST /api/org/domains": jsonResponse(
        { detail: [{ loc: ["body", "domain"], msg: "Value error, That domain is reserved.", type: "value_error" }] },
        422,
      ),
    });
    const input = container!.querySelector<HTMLInputElement>("input[name='domain']")!;
    input.value = "example.com";
    await submit(input.form!);
    await vi.waitFor(() => expect(fieldError(input)).toBe("That domain is reserved."));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("example.com");
  });

  it("puts the API's 422 for the name under the name field", async () => {
    await renderGeneral({
      "PATCH /api/org": jsonResponse(
        { detail: [{ loc: ["body", "name"], msg: "That name is taken.", type: "value_error" }] },
        422,
      ),
    });
    const input = container!.querySelector<HTMLInputElement>("input[name='org_name']")!;
    await act(async () => {
      setValue(input, "Acme");
    });
    await submit(input.form!);
    await vi.waitFor(() => expect(fieldError(input)).toBe("That name is taken."));
    expect(input.value).toBe("Acme");
  });

  async function renderProviders(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi(answers);
    await render("admin");
    await openTab("Sign-in & security");
    await vi.waitFor(() => expect(container!.querySelector("input[name='issuer']")).not.toBeNull());
    return fetchMock;
  }

  const idpInput = (name: string) => container!.querySelector<HTMLInputElement>(`input[name='${name}']`)!;

  it("says which provider fields are missing, each under its own field, and sends nothing", async () => {
    const fetchMock = await renderProviders();
    idpInput("name").value = "Entra";
    idpInput("issuer").value = "http://login.example.com";
    await submit(idpInput("name").form!);
    expect(calls(fetchMock).some((c) => c.key === "POST /api/org/idp")).toBe(false);
    expect(fieldError(idpInput("name"))).toBeNull();
    expect(fieldError(idpInput("issuer"))).toContain("https://");
    expect(fieldError(idpInput("client_id"))).toBe("Enter the client ID.");
    expect(fieldError(idpInput("client_secret"))).toBe("Enter the client secret.");
    expect(idpInput("client_secret").getAttribute("aria-invalid")).toBe("true");
    // The hint is still read with the field.
    expect(idpInput("issuer").getAttribute("aria-describedby")).toContain("-issuer-hint");
    expect(idpInput("issuer").value).toBe("http://login.example.com");
    expect(idpInput("name").value).toBe("Entra");
  });

  it("sorts the API's 422 onto the provider fields and summarises the rest", async () => {
    await renderProviders({
      "POST /api/org/idp": jsonResponse(
        {
          detail: [
            { loc: ["body", "issuer"], msg: "The issuer did not answer discovery.", type: "value_error" },
            { loc: ["body"], msg: "This provider is already attached.", type: "value_error" },
          ],
        },
        422,
      ),
    });
    idpInput("name").value = "Entra";
    idpInput("issuer").value = "https://login.example.com";
    idpInput("client_id").value = "app-id";
    idpInput("client_secret").value = "shh";
    await submit(idpInput("name").form!);
    await vi.waitFor(() => {
      expect(fieldError(idpInput("issuer"))).toBe("The issuer did not answer discovery.");
    });
    const summary = container!.querySelector("[data-form-summary='idp']");
    expect(summary?.getAttribute("role")).toBe("alert");
    expect(summary?.textContent).toContain("This provider is already attached.");
    expect(summary?.textContent).not.toContain("discovery");
    // Nothing typed is lost, the secret included.
    expect(idpInput("client_secret").value).toBe("shh");
    expect(idpInput("issuer").value).toBe("https://login.example.com");
  });
});

describe("proving a domain", () => {
  async function openProof(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi({
      "GET /api/org/domains/acme.dev/challenge": jsonResponse({ record: CHALLENGE }),
      ...answers,
    });
    await render("admin");
    await vi.waitFor(() => expect(button("Verify acme.dev")).toBeDefined());
    await click(button("Verify acme.dev"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-domain-proof='acme.dev']")).not.toBeNull();
    });
    return fetchMock;
  }

  it("shows the TXT record the API minted, with its name and value copyable", async () => {
    const writeText = stubClipboard();
    const fetchMock = await openProof();
    expect(calls(fetchMock).some((c) => c.key === "GET /api/org/domains/acme.dev/challenge")).toBe(true);
    // Nothing is posted by opening the record: the check is its own press.
    expect(calls(fetchMock).some((c) => c.key.endsWith("/verify"))).toBe(false);

    const proof = container!.querySelector("[data-domain-proof='acme.dev']")!;
    expect(proof.querySelector("[data-testid='txt-name']")?.textContent).toBe(CHALLENGE.name);
    expect(proof.querySelector("[data-testid='txt-value']")?.textContent).toBe(CHALLENGE.value);
    expect(proof.textContent).toContain("under acme.dev");

    const copyValue = proof.querySelector<HTMLButtonElement>(
      "button[aria-label='Copy the record value for acme.dev']",
    )!;
    await click(copyValue);
    expect(writeText).toHaveBeenCalledWith(CHALLENGE.value);
    await vi.waitFor(() => expect(copyValue.textContent).toBe("Copied"));
    await click(proof.querySelector("button[aria-label='Copy the record name for acme.dev']")!);
    expect(writeText).toHaveBeenCalledWith(CHALLENGE.name);
  });

  it("says the record is not there yet, and to keep it published, on a 202 with nothing found", async () => {
    const detail =
      "No TXT record at _matterwave-verify.acme.dev yet. DNS changes can take up to an hour to propagate.";
    const fetchMock = await openProof({
      "POST /api/org/domains/acme.dev/verify": jsonResponse(pending("acme.dev", detail, []), 202),
    });
    await click(button("Check acme.dev now"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-verify-outcome='missing']")).not.toBeNull();
    });
    const outcome = container!.querySelector("[data-verify-outcome='missing']")!;
    expect(outcome.textContent).toContain(detail);
    expect(outcome.textContent).toContain("Keep the record published");
    expect(outcome.getAttribute("role")).toBe("status");
    // Still unverified, so the record stays open and nothing reloaded.
    expect(container!.querySelector("[data-domain-proof='acme.dev']")).not.toBeNull();
    expect(calls(fetchMock).filter((c) => c.key === "GET /api/org/domains").length).toBe(1);
  });

  it("says the record exists with the wrong value, and lists what was found, on a 202 with values", async () => {
    const detail =
      "TXT _matterwave-verify.acme.dev exists but none of its values match the token below. Check for a stale record from an earlier attempt.";
    await openProof({
      "POST /api/org/domains/acme.dev/verify": jsonResponse(
        pending("acme.dev", detail, ["matterwave-verify=tok_OLD"]),
        202,
      ),
    });
    await click(button("Check acme.dev now"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-verify-outcome='mismatch']")).not.toBeNull();
    });
    const outcome = container!.querySelector("[data-verify-outcome='mismatch']")!;
    expect(outcome.textContent).toContain(detail);
    expect(outcome.textContent).toContain("matterwave-verify=tok_OLD");
    expect(outcome.textContent).toContain(CHALLENGE.name);
  });

  it("reports a 503 as the check failing, with the request id, not as the domain failing", async () => {
    await openProof({
      "POST /api/org/domains/acme.dev/verify": jsonResponse(
        {
          detail: "The domain check could not be run right now; the DNS lookup failed. Try again.",
          request_id: "req-dns-1",
        },
        503,
      ),
    });
    await click(button("Check acme.dev now"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-verify-outcome='failed']")).not.toBeNull();
    });
    const outcome = container!.querySelector("[data-verify-outcome='failed']")!;
    expect(outcome.getAttribute("role")).toBe("alert");
    expect(outcome.textContent).toContain("could not be run");
    expect(outcome.querySelector("[data-testid='request-id']")?.textContent).toBe("req-dns-1");
    // The record is still there to copy; the admin changes nothing.
    expect(container!.querySelector("[data-testid='txt-value']")?.textContent).toBe(CHALLENGE.value);
  });

  it("on a 200 says the domain is verified and reloads the list", async () => {
    const fetchMock = await openProof({
      "POST /api/org/domains/acme.dev/verify": jsonResponse(verified("acme.dev")),
    });
    await click(button("Check acme.dev now"));
    await vi.waitFor(() => {
      expect(calls(fetchMock).filter((c) => c.key === "GET /api/org/domains").length).toBe(2);
    });
  });
});

describe("requiring single sign-on", () => {
  const BLOCKERS = [
    "This organisation has no identity provider attached, so enforcing single sign-on would refuse every login. Attach one first.",
    "This organisation has no verified domain, so single sign-on cannot be offered to anyone. Verify a domain first.",
  ];

  async function renderSso(
    role: string,
    sso: Record<string, unknown>,
    answers: Record<string, Record<string, unknown>> = {},
  ) {
    // Filled in on the caller's object, not a copy, so a test can change what
    // a later GET answers after the first load.
    // The pane trusts the role /api/org reports, which is the membership row.
    answers["GET /api/org"] ??= jsonResponse({ ...ORG, role });
    answers["GET /api/org/sso"] ??= jsonResponse(sso);
    const fetchMock = stubOrgApi(answers);
    await render(role);
    await openTab("Sign-in & security");
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-sso-required]")).not.toBeNull();
    });
    return fetchMock;
  }

  it("lists the API's blockers as the reasons the switch is unavailable, each with a plain heading", async () => {
    await renderSso("owner", { sso_required: false, blockers: BLOCKERS });
    expect(container!.querySelector("[data-sso-required='false']")).not.toBeNull();
    const list = container!.querySelector("ul[aria-label='Why single sign-on cannot be required']")!;
    const items = [...list.querySelectorAll("li")];
    expect(items.map((li) => li.querySelector("span")?.textContent)).toEqual([
      "No identity provider attached",
      "No verified domain yet",
    ]);
    expect(items[0].textContent).toContain(BLOCKERS[0]);
    expect(button("Require single sign-on…").disabled).toBe(true);
  });

  it("tells an admin that only an owner can turn it on, and offers no recovery code", async () => {
    await renderSso("admin", { sso_required: false, blockers: [] });
    expect(container!.textContent).toContain("Only an organisation owner can turn this on");
    expect(button("Require single sign-on…").disabled).toBe(true);
    expect(
      [...container!.querySelectorAll("button")].some(
        (b) => b.textContent === "Generate a new recovery code…",
      ),
    ).toBe(false);
  });

  it("turns it on after a confirm that says members sign in through the IdP only, then shows the code once", async () => {
    const writeText = stubClipboard();
    const fetchMock = await renderSso(
      "owner",
      { sso_required: false, blockers: [] },
      { "PUT /api/org/sso": jsonResponse({ sso_required: true, recovery: RECOVERY }) },
    );
    const open = button("Require single sign-on…");
    expect(open.disabled).toBe(false);
    await click(open);

    expect(dialog().textContent).toContain("can only sign in through your identity provider");
    expect(calls(fetchMock).some((c) => c.key === "PUT /api/org/sso")).toBe(false);
    await click(dialogButton("Require single sign-on"));

    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/sso")?.body).toEqual({
      sso_required: true,
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-recovery-code-dialog]")).not.toBeNull();
    });
    const shown = document.querySelector("[data-recovery-code-dialog]")!;
    expect(shown.querySelector("[data-testid='recovery-code']")?.textContent).toBe(RECOVERY.code);
    expect(shown.textContent).toContain("only time it is shown");

    // Done waits for the acknowledgement.
    const done = [...shown.querySelectorAll("button")].find((b) => b.textContent === "Done")!;
    expect(done.disabled).toBe(true);
    await click(shown.querySelector("button[aria-label='Copy the recovery code']")!);
    expect(writeText).toHaveBeenCalledWith(RECOVERY.code);
    await click(shown.querySelector("input[type='checkbox']")!);
    expect(done.disabled).toBe(false);
    await click(done);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-recovery-code-dialog]")).toBeNull();
    });
    // Gone for good: nothing on the page still carries the code.
    expect(document.body.textContent).not.toContain(RECOVERY.code);
    // And the policy was re-read.
    expect(calls(fetchMock).filter((c) => c.key === "GET /api/org/sso").length).toBe(2);
  });

  it("on a 409 shows the API's sentence and re-reads the policy, so the new blockers are listed", async () => {
    const answers: Record<string, Record<string, unknown>> = {
      "PUT /api/org/sso": jsonResponse(
        {
          detail: {
            msg: "Single sign-on cannot be enforced yet: it would lock this organisation out.",
            blockers: [BLOCKERS[1]],
          },
        },
        409,
      ),
    };
    const fetchMock = await renderSso("owner", { sso_required: false, blockers: [] }, answers);
    // Between the load and the press, the verified domain was released.
    answers["GET /api/org/sso"] = jsonResponse({ sso_required: false, blockers: [BLOCKERS[1]] });
    await click(button("Require single sign-on…"));
    await click(dialogButton("Require single sign-on"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toContain(
        "would lock this organisation out",
      );
    });
    await vi.waitFor(() => {
      const list = container!.querySelector("ul[aria-label='Why single sign-on cannot be required']");
      expect(list?.textContent).toContain("No verified domain yet");
    });
    expect(calls(fetchMock).filter((c) => c.key === "GET /api/org/sso").length).toBe(2);
    expect(button("Require single sign-on…").disabled).toBe(true);
    expect(document.querySelector("[data-recovery-code-dialog]")).toBeNull();
  });

  it("repeats the API's owner-only refusal", async () => {
    await renderSso(
      "owner",
      { sso_required: false, blockers: [] },
      {
        "PUT /api/org/sso": jsonResponse(
          { detail: "Only an organisation owner can change single sign-on enforcement." },
          403,
        ),
      },
    );
    await click(button("Require single sign-on…"));
    await click(dialogButton("Require single sign-on"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toBe(
        "Only an organisation owner can change single sign-on enforcement.",
      );
    });
  });

  it("turns it off through a confirm, with no code involved", async () => {
    const fetchMock = await renderSso(
      "owner",
      { sso_required: true, blockers: [] },
      { "PUT /api/org/sso": jsonResponse({ sso_required: false }) },
    );
    expect(container!.querySelector("[data-sso-required='true']")).not.toBeNull();
    await click(button("Stop requiring single sign-on…"));
    expect(dialog().textContent).toContain("sign in with a password again");
    await click(dialogButton("Stop requiring"));
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/sso")?.body).toEqual({
      sso_required: false,
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    });
    expect(document.querySelector("[data-recovery-code-dialog]")).toBeNull();
  });

  it("mints a new recovery code after warning that the previous one stops working", async () => {
    const fetchMock = await renderSso(
      "owner",
      { sso_required: true, blockers: [] },
      {
        "POST /api/org/sso/recovery-code": jsonResponse(
          { recovery: { ...RECOVERY, id: "rc-2", code: "MWRC-DELTA-ECHO-FOXTROT" } },
          201,
        ),
      },
    );
    await click(button("Generate a new recovery code…"));
    expect(dialog().textContent).toContain("stops working the moment the new one is made");
    await click(dialogButton("Generate code"));
    expect(calls(fetchMock).some((c) => c.key === "POST /api/org/sso/recovery-code")).toBe(true);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='recovery-code']")?.textContent).toBe(
        "MWRC-DELTA-ECHO-FOXTROT",
      );
    });
  });
});

describe("requiring two-factor authentication", () => {
  const OWNER_ONLY = "Only an organisation owner can change the two-factor requirement.";

  async function renderMfa(
    role: string,
    required: boolean,
    answers: Record<string, Record<string, unknown>> = {},
  ) {
    answers["GET /api/org"] ??= jsonResponse({ ...ORG, role });
    answers["GET /api/org/mfa"] ??= jsonResponse({ mfa_required: required });
    const fetchMock = stubOrgApi(answers);
    await render(role);
    await openTab("Sign-in & security");
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-mfa-required]")).not.toBeNull();
    });
    return fetchMock;
  }

  /** The switch, found through its label the way a person finds it. */
  function mfaSwitch(): HTMLButtonElement {
    const label = [...container!.querySelectorAll("label")].find(
      (l) => l.textContent === "Require two-factor authentication",
    );
    expect(label, "the two-factor switch's label").toBeDefined();
    const control = document.getElementById(label!.htmlFor);
    expect(control, "the two-factor switch").toBeInstanceOf(HTMLButtonElement);
    expect(control!.getAttribute("role")).toBe("switch");
    return control as HTMLButtonElement;
  }

  const isOn = () => mfaSwitch().getAttribute("aria-checked") === "true";

  /** The polite line that says a change stuck. */
  function savedLine(): string {
    return container!.querySelector("[data-saved='mfa']")?.textContent ?? "";
  }

  it("shows the policy as the API reports it and says what requiring it does, in the route's terms", async () => {
    await renderMfa("owner", false);
    expect(container!.querySelector("[data-mfa-required='false']")?.textContent).toContain(
      "Two-factor authentication is optional",
    );
    expect(isOn()).toBe(false);
    const what = container!.querySelector(
      "ul[aria-label='What requiring two-factor authentication does']",
    )!;
    // Exactly what routes_mfa.py does: no refusal, enrolment at the next
    // password sign-in, no grace period, SSO sign-ins untouched.
    expect(what.textContent).toContain("not locked out");
    expect(what.textContent).toContain("next password sign-in pauses");
    expect(what.textContent).toContain("no grace period");
    expect(what.textContent).toContain("identity provider has that provider's factors");
    const saved = container!.querySelector("[data-saved='mfa']")!;
    expect(saved.getAttribute("role")).toBe("status");
    expect(saved.getAttribute("aria-live")).toBe("polite");
  });

  it("an admin sees the state with the switch disabled and is told it is the owner's", async () => {
    await renderMfa("admin", true);
    expect(container!.querySelector("[data-mfa-required='true']")?.textContent).toContain(
      "Two-factor authentication is required",
    );
    expect(isOn()).toBe(true);
    expect(mfaSwitch().disabled).toBe(true);
    expect(container!.textContent).toContain(
      "Only an organisation owner can change this, in either direction.",
    );
  });

  it("an owner turning it on is asked first, told who will be asked to set up an authenticator", async () => {
    const fetchMock = await renderMfa("owner", false, {
      "PUT /api/org/mfa": jsonResponse({ mfa_required: true }),
    });
    expect(mfaSwitch().disabled).toBe(false);
    await click(mfaSwitch());
    expect(dialog().textContent).toContain("without an authenticator");
    expect(dialog().textContent).toContain("asked to set one up");
    // Nothing is saved, and the switch has not moved, until the confirm.
    expect(calls(fetchMock).some((c) => c.key === "PUT /api/org/mfa")).toBe(false);
    expect(isOn()).toBe(false);
    await click(dialogButton("Require two-factor"));
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/mfa")?.body).toEqual({
      mfa_required: true,
    });
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-mfa-required='true']")).not.toBeNull();
    });
    expect(isOn()).toBe(true);
    expect(savedLine()).toBe("Saved.");
    expect(container!.querySelector("[role='alert']")).toBeNull();
    // The PUT's answer is the policy; nothing else was re-read.
    expect(calls(fetchMock).filter((c) => c.key === "GET /api/org/mfa").length).toBe(1);
  });

  it("cancelling the confirm leaves it off and sends nothing", async () => {
    const fetchMock = await renderMfa("owner", false);
    await click(mfaSwitch());
    await click(dialogButton("Cancel"));
    await vi.waitFor(() => {
      expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    });
    expect(calls(fetchMock).some((c) => c.key === "PUT /api/org/mfa")).toBe(false);
    expect(isOn()).toBe(false);
    expect(savedLine()).toBe("");
  });

  it("an owner turns it off with one press, and is told it saved", async () => {
    const fetchMock = await renderMfa("owner", true, {
      "PUT /api/org/mfa": jsonResponse({ mfa_required: false }),
    });
    await click(mfaSwitch());
    expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/mfa")?.body).toEqual({
      mfa_required: false,
    });
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-mfa-required='false']")).not.toBeNull();
    });
    expect(isOn()).toBe(false);
    expect(savedLine()).toBe("Saved.");
  });

  it("moves the switch back and shows the API's sentence when the change is refused", async () => {
    await renderMfa("owner", true, {
      "PUT /api/org/mfa": jsonResponse({ detail: OWNER_ONLY }, 403),
    });
    await click(mfaSwitch());
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toBe(OWNER_ONLY);
    });
    expect(isOn()).toBe(true);
    expect(container!.querySelector("[data-mfa-required='true']")).not.toBeNull();
    expect(mfaSwitch().disabled).toBe(false);
    expect(savedLine()).toBe("");
  });
});

describe("organisation instructions", () => {
  async function renderInstructions(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi(answers);
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("textarea")).not.toBeNull();
    });
    return fetchMock;
  }

  it("loads the org's text into the editor, with Save disabled until it changes", async () => {
    await renderInstructions();
    const area = container!.querySelector("textarea")!;
    expect(area.value).toBe(ORG_INSTRUCTIONS);
    expect(container!.textContent).toContain(`${ORG_INSTRUCTIONS.length} / 4000`);
    expect(button("Save instructions").disabled).toBe(true);
  });

  it("saves through PUT /api/org/instructions with the text as typed, and says so", async () => {
    const answers: Record<string, Record<string, unknown>> = {
      "PUT /api/org/instructions": jsonResponse({ text: "Answer in British English. Be brief." }),
    };
    const fetchMock = await renderInstructions(answers);
    const area = container!.querySelector("textarea")!;
    await act(async () => {
      setValue(area, "Answer in British English. Be brief.");
    });
    expect(button("Save instructions").disabled).toBe(false);
    // The save reloads the pane, and the API then holds the new text.
    answers["GET /api/org/instructions"] = jsonResponse({ text: "Answer in British English. Be brief." });
    await submit(area.form!);
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/instructions")?.body).toEqual({
      text: "Answer in British English. Be brief.",
    });
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Saved. Every conversation here will use these.");
    });
  });

  it("shows the API's refusal and keeps the draft", async () => {
    await renderInstructions({
      "PUT /api/org/instructions": jsonResponse(
        { detail: "Custom instructions are not in your plan." },
        402,
      ),
    });
    const area = container!.querySelector("textarea")!;
    await act(async () => {
      setValue(area, "Be brief.");
    });
    await submit(area.form!);
    await vi.waitFor(() => {
      expect(container!.querySelector("[role='alert']")?.textContent).toBe(
        "Custom instructions are not in your plan.",
      );
    });
    expect(area.value).toBe("Be brief.");
    expect(container!.textContent).not.toContain("Saved.");
  });
});

describe("the model allow-list", () => {
  async function renderModels(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi(answers);
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("ul[aria-label='Models']")).not.toBeNull();
    });
    return fetchMock;
  }

  function switchFor(id: string): HTMLInputElement {
    const found = container!.querySelector<HTMLInputElement>(`[data-model='${id}'] input[role='switch']`);
    expect(found, `a switch for ${id}`).not.toBeNull();
    return found!;
  }

  it("shows the plan's models as switches, with the house model on and locked", async () => {
    await renderModels();
    expect([...container!.querySelectorAll("[data-model]")].map((li) => li.getAttribute("data-model"))).toEqual([
      "fake-mini",
      "big-model",
      "tiny-demo",
    ]);
    const house = switchFor("fake-mini");
    expect(house.checked).toBe(true);
    expect(house.disabled).toBe(true);
    // The note is set off from the name, not run into it ("GRT NanoAlways on").
    expect(container!.querySelector("[data-model='fake-mini']")?.textContent).toContain("· Always on");
    expect(switchFor("big-model").disabled).toBe(false);
    expect(container!.querySelector("[data-model='big-model']")?.textContent).toContain("128,000 context");
    expect(container!.querySelector("[data-model='tiny-demo']")?.textContent).toContain("Research preview");
    expect(container!.textContent).toContain("Every model your plan includes is available");
  });

  it("names each model by its label, the way the picker and the pricing page do", async () => {
    await renderModels();
    const big = container!.querySelector("[data-model='big-model']");
    expect(big?.querySelector("label")?.textContent).toBe("Big Model");
    expect(big?.textContent).not.toContain("big-model");
    expect(switchFor("big-model").getAttribute("aria-label")).toBe("Allow Big Model");
  });

  it("an answer without labels falls back to the ids", async () => {
    const bare = {
      ...MODELS,
      data: MODELS.data.map((m) => {
        const older: Partial<typeof m> = { ...m };
        delete older.label;
        delete older.partner;
        return older;
      }),
    };
    await renderModels({ "GET /api/org/models": jsonResponse(bare) });
    expect(container!.querySelector("[data-model='big-model'] label")?.textContent).toBe("big-model");
    expect(container!.querySelector("ul[aria-label='Partner models']")).toBeNull();
  });

  it("groups partner models apart, under the heading and note the pricing pages use", async () => {
    const withPartner = {
      ...MODELS,
      data: [
        ...MODELS.data,
        orgModel("glm-4.6", { label: "GLM 4.6", partner: true }),
      ],
    };
    const fetchMock = await renderModels({
      "GET /api/org/models": jsonResponse(withPartner),
      "PUT /api/org/models": jsonResponse(withPartner),
    });
    const own = container!.querySelector("ul[aria-label='Models']")!;
    const partners = container!.querySelector("ul[aria-label='Partner models']");
    expect(partners, "a list of its own").not.toBeNull();
    expect([...own.querySelectorAll("[data-model]")].map((li) => li.getAttribute("data-model"))).toEqual([
      "fake-mini",
      "big-model",
      "tiny-demo",
    ]);
    expect([...partners!.querySelectorAll("[data-model]")].map((li) => li.getAttribute("data-model"))).toEqual([
      "glm-4.6",
    ]);
    const section = partners!.parentElement!;
    expect(section.querySelector("h3")?.textContent).toBe(PARTNER_MODELS_HEADING);
    expect(section.textContent).toContain(PARTNER_MODELS_NOTE);
    // A partner switch is an ordinary one: switching it off narrows the list.
    await act(async () => {
      switchFor("glm-4.6").click();
    });
    await vi.waitFor(() =>
      expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/models")?.body).toEqual({
        allowed: ["big-model", "tiny-demo"],
      }),
    );
  });

  it("switching one off sends the remaining ids, without the house model, and shows the API's answer", async () => {
    const answers = {
      "PUT /api/org/models": jsonResponse({
        ...MODELS,
        restricted: true,
        data: MODELS.data.map((m) => (m.id === "tiny-demo" ? { ...m, allowed: false } : m)),
      }),
    };
    const fetchMock = await renderModels(answers);
    const preview = switchFor("tiny-demo");
    await act(async () => {
      preview.click();
    });
    await vi.waitFor(() => expect(switchFor("tiny-demo").checked).toBe(false));
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/models")?.body).toEqual({
      allowed: ["big-model"],
    });
    expect(container!.textContent).toContain("Members may use only the models switched on above.");
  });

  it("switching the last one back on sends null: the plan's list, including what it adds later", async () => {
    const restricted = {
      ...MODELS,
      restricted: true,
      data: MODELS.data.map((m) => (m.id === "big-model" ? { ...m, allowed: false } : m)),
    };
    const fetchMock = await renderModels({
      "GET /api/org/models": jsonResponse(restricted),
      "PUT /api/org/models": jsonResponse(MODELS),
    });
    expect(switchFor("big-model").checked).toBe(false);
    await act(async () => {
      switchFor("big-model").click();
    });
    await vi.waitFor(() => expect(switchFor("big-model").checked).toBe(true));
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/models")?.body).toEqual({ allowed: null });
  });

  it("shows the API's refusal and leaves the switches as the API last reported them", async () => {
    await renderModels({
      "PUT /api/org/models": jsonResponse({ detail: "Not available to this organisation: tiny-demo." }, 422),
    });
    await act(async () => {
      switchFor("tiny-demo").click();
    });
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-model] ~ * [role='alert'], section [role='alert']")?.textContent).toContain(
        "Not available to this organisation: tiny-demo.",
      );
    });
    expect(switchFor("tiny-demo").checked).toBe(true);
  });

  it("names the ids the org allowed that the plan no longer offers", async () => {
    await renderModels({
      "GET /api/org/models": jsonResponse({ ...MODELS, restricted: true, unlisted: ["retired-model"] }),
    });
    expect(container!.textContent).toContain("no longer offered by your plan or the gateway: retired-model.");
  });

  it("a gateway that cannot list models fails this section alone", async () => {
    await (async () => {
      stubOrgApi({ "GET /api/org/models": jsonResponse({ detail: "Cannot reach the model gateway" }, 502) });
      await render("admin");
    })();
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Could not load the model list: Cannot reach the model gateway");
    });
    // The rest of the pane is up.
    expect(container!.querySelector("input[name='org_name']")).not.toBeNull();
    await openTab("Audit log");
    await vi.waitFor(() => {
      expect(container!.querySelector("table[aria-label='Audit events']")).not.toBeNull();
    });
  });
});

describe("the audit log", () => {
  async function renderAudit(answers: Record<string, Record<string, unknown>> = {}) {
    const fetchMock = stubOrgApi(answers);
    await render("owner");
    await openTab("Audit log");
    await vi.waitFor(() => {
      expect(container!.querySelector("table[aria-label='Audit events']")).not.toBeNull();
    });
    return fetchMock;
  }

  function auditCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return calls(fetchMock)
      .map((c) => c.key)
      .filter((key) => key.startsWith("GET /api/org/audit"));
  }

  it("wraps its filter row, so nothing overflows a phone-width pane", async () => {
    await renderAudit();
    const form = container!.querySelector<HTMLFormElement>("form[aria-label='Filter the audit log']")!;
    expect(form.className).toContain("flex-wrap");
    for (const field of form.querySelectorAll("input, select")) {
      expect(field.parentElement!.className).toContain("min-w-0");
    }
  });

  it("lists the rows newest first with the actor's email, the event and the detail", async () => {
    const fetchMock = await renderAudit();
    expect(auditCalls(fetchMock)).toEqual(["GET /api/org/audit?limit=50"]);
    const rows = [...container!.querySelectorAll("tr[data-audit-action]")];
    expect(rows.map((r) => r.getAttribute("data-audit-action"))).toEqual(["org.models.updated", "org.plan.changed"]);
    expect(rows[0].textContent).toContain("ada@acme.com");
    expect(rows[0].textContent).toContain('allowed: ["big-model","fake-mini"]');
    // A system actor has no email: the subject is shown as it is.
    expect(rows[1].textContent).toContain("stripe:evt_1");
    expect(rows[1].textContent).toContain("pro");
    // The filter offers the trail's own actions.
    const event = selectNamed(container!, "Event")!;
    expect(selectShown(event)).toBe("All events");
    expect(await optionsOf(event)).toEqual(["All events", "org.models.updated", "org.plan.changed", "org.rename"]);
    // No next page: nothing to load.
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent === "Load older events")).toBe(false);
  });

  it("applies the filters as the API's query, with the day range as instants", async () => {
    const fetchMock = await renderAudit();
    const form = container!.querySelector<HTMLFormElement>("form[aria-label='Filter the audit log']")!;
    await chooseOption(selectNamed(form, "Event")!, "org.rename");
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("input[name='actor']")!, " ada@acme.com ");
      setValue(form.querySelector<HTMLInputElement>("input[name='since']")!, "2026-10-01");
      setValue(form.querySelector<HTMLInputElement>("input[name='until']")!, "2026-10-03");
    });
    await submit(form);
    await vi.waitFor(() => {
      expect(auditCalls(fetchMock).at(-1)).toBe(
        "GET /api/org/audit?event=org.rename&actor=ada%40acme.com&since=2026-10-01T00%3A00%3A00Z&until=2026-10-04T00%3A00%3A00.000Z&limit=50",
      );
    });
  });

  it("loads the next page with the cursor and appends it", async () => {
    const first = { ...AUDIT_PAGE, next_cursor: "cur-1" };
    const second = { data: [auditRow("e3", "org.rename", { target: "org-1" })], next_cursor: null, actions: [] };
    const fetchMock = await renderAudit({
      "GET /api/org/audit?limit=50": jsonResponse(first),
      "GET /api/org/audit?cursor=cur-1&limit=50": jsonResponse(second),
    });
    await click(button("Load older events"));
    await vi.waitFor(() => {
      expect(container!.querySelectorAll("tr[data-audit-action]").length).toBe(3);
    });
    expect(auditCalls(fetchMock)).toEqual(["GET /api/org/audit?limit=50", "GET /api/org/audit?cursor=cur-1&limit=50"]);
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent === "Load older events")).toBe(false);
  });

  it("downloads the CSV through the session, with the same filters", async () => {
    const csv = "occurred_at,actor_email,actor_subject,action,target,detail\r\n";
    const fetchMock = await renderAudit({
      "GET /api/org/audit.csv": {
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({}),
        text: async () => csv,
      },
    });
    const anchors: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    const createObjectURL = vi.fn(() => "blob:audit");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));

    await click(button("Download CSV"));
    await vi.waitFor(() => expect(anchors.length).toBe(1));
    expect(anchors[0].download).toBe("audit-log.csv");
    expect(anchors[0].href).toBe("blob:audit");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit");
    const request = fetchMock.mock.calls.find(([input]) => String(input).startsWith("/api/org/audit.csv"));
    expect(request).toBeDefined();
    expect((request![1] as RequestInit).credentials).toBe("include");
    clickSpy.mockRestore();
  });

  it("says why when the export is refused", async () => {
    await renderAudit({
      "GET /api/org/audit.csv": jsonResponse({ detail: "The audit log needs Postgres; set MW_DATABASE_URL." }, 503),
    });
    await click(button("Download CSV"));
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("The audit log needs Postgres; set MW_DATABASE_URL.");
    });
  });

  it("says when nothing matches rather than showing an empty table", async () => {
    stubOrgApi({ "GET /api/org/audit": jsonResponse({ data: [], next_cursor: null, actions: [] }) });
    await render("owner");
    await openTab("Audit log");
    await vi.waitFor(() => {
      expect(container!.textContent).toContain("Nothing recorded for these filters.");
    });
  });
});

describe("sharing by link", () => {
  const LINK = {
    id: "s-1",
    conversation_id: "c-1",
    title: "Quarterly plan",
    message_count: 4,
    include_attachments: true,
    created_at: "2026-10-03T12:00:00Z",
    expires_at: null,
    revoked_at: null,
    view_count: 3,
    status: "active",
    created_by: "carol",
  };

  async function renderSharing(
    enabled: boolean,
    answers: Record<string, Record<string, unknown>> = {},
  ) {
    answers["GET /api/org/sharing"] ??= jsonResponse({ enabled });
    answers["GET /api/org/shares"] ??= jsonResponse({ data: [LINK] });
    const fetchMock = stubOrgApi(answers);
    await render("admin");
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-sharing-enabled]")).not.toBeNull();
    });
    return fetchMock;
  }

  function sharingSwitch(): HTMLButtonElement {
    const label = [...container!.querySelectorAll("label")].find(
      (l) => l.textContent === "Allow sharing by link",
    );
    expect(label, "the sharing switch's label").toBeDefined();
    const control = document.getElementById(label!.htmlFor);
    expect(control!.getAttribute("role")).toBe("switch");
    return control as HTMLButtonElement;
  }

  it("shows the switch on, every member's link with who made it, and no token", async () => {
    await renderSharing(true);
    expect(sharingSwitch().getAttribute("aria-checked")).toBe("true");
    expect(container!.querySelector("[data-sharing-enabled='true']")?.textContent).toContain(
      "Members can share a conversation by public link",
    );
    const row = container!.querySelector("[data-org-share-status='active']");
    expect(row?.textContent).toContain("Quarterly plan");
    expect(row?.textContent).toContain("By carol");
    expect(row?.textContent).toContain("3 views");
    expect(row?.textContent).toContain("with attachments");
    expect(container!.textContent).not.toContain("tok-");
  });

  it("an admin switches sharing off and the pane says what that does", async () => {
    const fetchMock = await renderSharing(true, {
      "PUT /api/org/sharing": jsonResponse({ enabled: false }),
    });
    await click(sharingSwitch());
    expect(calls(fetchMock).find((c) => c.key === "PUT /api/org/sharing")?.body).toEqual({
      enabled: false,
    });
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-sharing-enabled='false']")).not.toBeNull();
    });
    expect(container!.querySelector("[data-sharing-enabled='false']")?.textContent).toContain(
      "every existing link stops opening",
    );
    expect(container!.querySelector("[data-saved='sharing']")?.textContent).toBe("Saved.");
  });

  it("an admin revokes a member's link from the list", async () => {
    const fetchMock = await renderSharing(true, {
      "DELETE /api/org/shares/s-1": jsonResponse({ status: "revoked" }),
    });
    await click(button("Revoke"));
    await vi.waitFor(() => {
      expect(container!.querySelector("[data-org-share-status='revoked']")).not.toBeNull();
    });
    expect(calls(fetchMock).some((c) => c.key === "DELETE /api/org/shares/s-1")).toBe(true);
    expect(container!.querySelector("[data-org-share-status='revoked']")?.textContent).toContain(
      "Revoked",
    );
  });
});

describe("how members sign in: the summary", () => {
  it("says who signs in through which provider when a domain is verified and a provider attached", async () => {
    stubOrgApi();
    await render("admin");
    await openTab("Sign-in & security");
    const summary = panel().querySelector("[data-mw-signin-summary]")!;
    expect(summary.getAttribute("data-mw-signin-summary")).toBe("ready");
    expect(summary.textContent).toContain("Members at acme.com sign in with Okta.");
    // The unverified claim is named as the thing to finish, not counted as verified.
    expect(summary.textContent).toContain("Verified domain: acme.com.");
    expect(summary.textContent).toContain("Passwords still work");
    const link = summary.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/login?org=acme.com");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("says single sign-on is offered to nobody yet, and what to do next, without a provider", async () => {
    stubOrgApi({ "GET /api/org/idp": jsonResponse({ data: [] }) });
    await render("admin");
    await openTab("Sign-in & security");
    const summary = panel().querySelector("[data-mw-signin-summary]")!;
    expect(summary.getAttribute("data-mw-signin-summary")).toBe("pending");
    expect(summary.textContent).toContain("not offered to anyone yet");
    expect(summary.textContent).toContain("No identity provider attached. Attach one below.");
  });

  it("says enforcement is on when it is", async () => {
    stubOrgApi({ "GET /api/org/sso": jsonResponse({ sso_required: true, blockers: [] }) });
    await render("owner");
    await openTab("Sign-in & security");
    expect(panel().querySelector("[data-mw-signin-summary]")?.textContent).toContain(
      "passwords no longer work for members",
    );
  });
});
