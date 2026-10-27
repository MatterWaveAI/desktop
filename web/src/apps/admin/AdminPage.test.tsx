import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "../settings/panes/paneHarness";
import { apps } from "../registry";
import { AdminPage } from "./AdminPage";
import { orgBilling } from "./billingFixtures";
import type { EnforcementAction, ReviewRow } from "./enforcementApi";
import type {
  AdminHealth,
  AdminInvite,
  AdminKey,
  AdminOrg,
  AdminUser,
  DeletionRequest,
  ModerationFlag,
  SpendRow,
} from "./adminApi";

/**
 * The admin surface as the operator sees it: a non-admin gets a notice and no fetch;
 * an admin gets the three tables from the three routes; suspending goes
 * through the confirmation dialog with a reason and unsuspending is one
 * click; and the registry gates the nav entry on the admin role.
 */

const ORGS: AdminOrg[] = [
  {
    id: "0000000a-0000-0000-0000-00000000000a",
    name: "Acme",
    zitadel_org_id: "z-acme",
    members: 3,
    overage_cap_micros: 50_000_000,
    tokens_used: 21_500_000,
    overage_micros: 12_340_000,
    created_at: "2026-09-01T00:00:00+00:00",
  },
  {
    id: "0000000b-0000-0000-0000-00000000000b",
    name: "Bolt",
    zitadel_org_id: "z-bolt",
    members: 1,
    overage_cap_micros: 0,
    tokens_used: 0,
    overage_micros: 0,
    created_at: "2026-09-02T00:00:00+00:00",
  },
];

const ADA: AdminUser = {
  subject: "ada",
  email: "ada@acme.com",
  name: "Ada",
  state: "active",
  email_verified: true,
  suspended_at: null,
  suspension_reason: null,
  org_id: ORGS[0].id,
  org_name: "Acme",
  role: "owner",
  created_at: "2026-09-01T00:00:00+00:00",
  last_seen_at: "2026-09-27T00:00:00+00:00",
};

const BO: AdminUser = {
  ...ADA,
  subject: "bo",
  email: "bo@bolt.com",
  name: null,
  state: "suspended",
  suspended_at: "2026-09-20T00:00:00+00:00",
  suspension_reason: "spam",
  org_id: ORGS[1].id,
  org_name: "Bolt",
  role: null,
  last_seen_at: null,
};

const SPEND: SpendRow[] = [
  {
    org_id: ORGS[0].id,
    org_name: "Acme",
    model: "grt-nano-pro",
    prompt_tokens: 20000,
    completion_tokens: 20000,
    weighted_tokens: 200_000,
    cost_micros: 50_000,
    overage_micros: 125,
    events: 2,
  },
];

let mounted: Mounted | null = null;

afterEach(() => {
  // The open tab lives in the URL; the next test starts on the first one.
  history.replaceState(null, "", "/");
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubAdminApi(extra: Parameters<typeof stubApi>[0] = () => undefined) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url === "/api/admin/orgs") {
      return { status: 200, body: { data: ORGS, q: "", next_cursor: null } };
    }
    if (call.method === "GET" && call.url.startsWith("/api/admin/orgs?")) {
      // A search matches on the name only here; the API's matcher is its own test.
      const q = new URL(call.url, "http://x").searchParams.get("q") ?? "";
      const data = ORGS.filter((org) => org.name.toLowerCase().includes(q.toLowerCase()));
      return { status: 200, body: { data, q, next_cursor: null } };
    }
    if (call.method === "GET" && call.url.startsWith("/api/admin/users")) {
      const q = new URL(call.url, "http://x").searchParams.get("q");
      return { status: 200, body: { data: q ? [BO] : [ADA, BO] } };
    }
    if (call.method === "GET" && call.url === "/api/admin/spend") {
      return { status: 200, body: { data: SPEND, period_start: "2026-09-01" } };
    }
    return undefined;
  });
}

/** An admin tab: a link in the Admin sections strip. */
function tab(label: string): HTMLAnchorElement {
  const found = [...mounted!.container.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Admin sections'] a")].find(
    (a) => a.textContent === label,
  );
  if (!found) throw new Error(`no tab ${label}`);
  return found;
}

describe("the registry", () => {
  it("lists admin at /admin, gated on the admin role", () => {
    const admin = apps.find((app) => app.id === "admin");
    expect(admin).toBeDefined();
    expect(admin!.path).toBe("/admin");
    expect(admin!.role).toBe("admin");
    // A lazy chunk: the router preloads it on the first visit.
    expect(admin!.component).toHaveProperty("preload");
  });
});

describe("a non-admin", () => {
  it("is told the surface is for operators, and nothing is fetched", async () => {
    const calls = stubAdminApi();
    mounted = await mount(<AdminPage />, principalWith(["user"]));
    expect(mounted.container.textContent).toContain("Admin is for platform operators");
    expect(mounted.container.querySelector("table")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("an admin", () => {
  it("sees every org with members, overage cap, tokens and overage", async () => {
    stubAdminApi();
    mounted = await mount(<AdminPage />, principalWith(["admin", "user"]));
    const table = mounted.container.querySelector("table[aria-label='Organisations']")!;
    expect(table).not.toBeNull();
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(rows[0]).toContain("Acme");
    expect(rows[0]).toContain("3");
    expect(rows[0]).toContain("$50.00");
    expect(rows[0]).toContain("21,500,000");
    expect(rows[0]).toContain("$12.34");
    expect(rows[0]).toContain("z-acme");
    // 0 is not "no spend" any more: the org runs on its plan's default cap.
    expect(rows[1]).toContain("plan default");
  });

  it("searches organisations through the API, the way users are searched", async () => {
    const calls = stubAdminApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    const input = mounted.container.querySelector<HTMLInputElement>("form[role='search'] input[name='q']")!;
    expect(input.placeholder).toContain("owner email");
    setInputValue(input, " bolt ");
    submit(input.form!);
    await flush();
    expect(calls.some((c) => c.url === "/api/admin/orgs?q=bolt")).toBe(true);
    const table = mounted.container.querySelector("table[aria-label='Organisations']")!;
    expect(table.textContent).toContain("Bolt");
    expect(table.textContent).not.toContain("Acme");

    setInputValue(input, "nobody");
    submit(input.form!);
    await flush();
    expect(mounted.container.querySelector("table[aria-label='Organisations']")).toBeNull();
    expect(mounted.container.textContent).toContain('No organisations match "nobody"');
  });

  it("loads the next page of organisations with the cursor and appends it", async () => {
    const calls = stubAdminApi(({ method, url }) => {
      if (method === "GET" && url === "/api/admin/orgs") {
        return { status: 200, body: { data: [ORGS[0]], q: "", next_cursor: "c-1" } };
      }
      if (method === "GET" && url === "/api/admin/orgs?cursor=c-1") {
        return { status: 200, body: { data: [ORGS[1]], q: "", next_cursor: null } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    const rowsBefore = [...mounted.container.querySelectorAll("table[aria-label='Organisations'] tbody tr")];
    expect(rowsBefore.map((tr) => tr.textContent)).toEqual([expect.stringContaining("Acme")]);

    click(buttonNamed(mounted.container, "Load more organisations"));
    await flush();
    expect(calls.some((c) => c.url === "/api/admin/orgs?cursor=c-1")).toBe(true);
    const rows = [...mounted.container.querySelectorAll("table[aria-label='Organisations'] tbody tr")];
    expect(rows.map((tr) => tr.textContent)).toEqual([
      expect.stringContaining("Acme"),
      expect.stringContaining("Bolt"),
    ]);
    // The end of the list: nothing more to ask for.
    expect([...mounted.container.querySelectorAll("button")].some((b) => b.textContent === "Load more organisations")).toBe(
      false,
    );
  });

  it("searches users through the API and shows their state and org", async () => {
    const calls = stubAdminApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Users"));
    await flush();
    const table = mounted.container.querySelector("table[aria-label='Users']")!;
    expect(table).not.toBeNull();
    expect(table.textContent).toContain("ada@acme.com");
    expect(table.textContent).toContain("Acme");
    expect(table.textContent).toContain("owner");
    expect(table.textContent).toContain("active");
    expect(table.textContent).toContain("bo@bolt.com");
    expect(table.textContent).toContain("suspended");
    expect(table.textContent).toContain("spam");

    const input = mounted.container.querySelector<HTMLInputElement>("input[name='q']")!;
    setInputValue(input, "bo@");
    submit(input.form!);
    await flush();
    expect(calls.some((c) => c.url === "/api/admin/users?q=bo%40")).toBe(true);
    const after = mounted.container.querySelector("table[aria-label='Users']")!;
    expect(after.textContent).not.toContain("ada@acme.com");
    expect(after.textContent).toContain("bo@bolt.com");
  });

  it("suspends through the dialog with a reason, and unsuspends in one click", async () => {
    const calls = stubAdminApi(({ method, url }) => {
      if (method === "PUT" && url === "/api/admin/users/ada/suspend") {
        return { status: 200, body: { ...ADA, state: "suspended" } };
      }
      if (method === "PUT" && url === "/api/admin/users/bo/unsuspend") {
        return { status: 200, body: { ...BO, state: "active" } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Users"));
    await flush();

    click(buttonNamed(mounted.container, "Suspend ada@acme.com"));
    await flush();
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Suspend ada@acme.com?");
    setInputValue(dialog.querySelector<HTMLInputElement>("input[aria-label='Reason']")!, "abuse");
    click(buttonNamed(dialog, "Suspend"));
    await flush();
    const suspend = calls.find((c) => c.method === "PUT" && c.url.endsWith("/suspend"));
    expect(suspend?.body).toEqual({ reason: "abuse" });
    // Reloaded after the action.
    expect(calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/admin/users")).length).toBe(2);

    click(buttonNamed(mounted.container, "Unsuspend bo@bolt.com"));
    await flush();
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/admin/users/bo/unsuspend")).toBe(true);
  });

  it("shows the API's refusal beside the table", async () => {
    stubAdminApi(({ method, url }) => {
      if (method === "PUT" && url === "/api/admin/users/bo/unsuspend") {
        return { status: 404, body: { detail: "No such user in this organization." } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Users"));
    await flush();
    click(buttonNamed(mounted.container, "Unsuspend bo@bolt.com"));
    await flush();
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toBe(
      "No such user in this organization.",
    );
  });

  it("shows this month's spend by org and model with a total", async () => {
    stubAdminApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Spend"));
    await flush();
    const table = mounted.container.querySelector("table[aria-label='Spend']")!;
    expect(table).not.toBeNull();
    expect(table.textContent).toContain("Acme");
    expect(table.textContent).toContain("grt-nano-pro");
    expect(table.textContent).toContain("200,000");
    expect(table.textContent).toContain("$0.05");
    // A sub-cent overage still reads as money.
    expect(table.textContent).toContain("$0.000125");
    expect(mounted.container.textContent).toContain(
      "Since 2026-09-01: $0.05 at list price, $0.000125 of it billed as overage",
    );
  });
});

// --- the operator tabs added for moderation, health and the deletion ledger ---

const REPORT: ReviewRow = {
  id: "0000000r-0000-0000-0000-00000000000r",
  reporter_subject: "ada",
  owner_subject: "ada",
  org_id: ORGS[0].id,
  message_id: "0000000m-0000-0000-0000-00000000000m",
  conversation_id: "0000000c-0000-0000-0000-00000000000c",
  kind: "unsafe",
  note: "please look at this",
  status: "open",
  action_id: null,
  created_at: "2026-09-20T00:00:00+00:00",
  reviewed_at: null,
  reviewed_by: null,
  resolution: null,
  message: { available: true, role: "assistant", text: "the reported reply text", model: "fake-mini" },
};

const ACTION: EnforcementAction = {
  id: "0000000a-0000-0000-0000-00000000000a",
  target_kind: "user",
  target: "bo",
  org_id: ORGS[1].id,
  state: "rate_limited",
  reason: "Automated traffic.",
  notes: "farm pattern",
  evidence: [REPORT.id],
  actor_subject: "dev-user",
  created_at: "2026-09-22T00:00:00+00:00",
  expires_at: "2026-09-23T00:00:00+00:00",
  lifted_at: null,
  lifted_by: null,
  lift_reason: null,
  appeal_state: "none",
};

const FLAG: ModerationFlag = {
  id: "0000000f-0000-0000-0000-00000000000f",
  owner_subject: "bo",
  org_id: ORGS[1].id,
  message_id: null,
  conversation_id: null,
  category: "harassment",
  score: 0.91,
  action: "blocked",
  provider: "openai",
  created_at: "2026-09-21T00:00:00+00:00",
};

const HEALTH: AdminHealth = {
  version: "0.4.0",
  revision: "abc1234",
  release: "v0.4.0-abc1234",
  git_sha: "abc1234",
  upstream: { status: "degraded", models: null, detail: "Cannot reach the model gateway: refused" },
  database: {
    configured: true,
    migration: "0037_usage_metering",
    latest_migration: "0038_account_deletion_requests",
    pending_migrations: ["0038_account_deletion_requests"],
  },
  billing_enabled: false,
  moderation: true,
  web_search: false,
  upstream_enforcement: false,
};

const DELETIONS: DeletionRequest[] = [
  {
    id: "0000000d-0000-0000-0000-00000000000d",
    org_id: ORGS[1].id,
    org_name: "Bolt",
    subject: "bo",
    email: "bo@bolt.com",
    requested_at: "2026-09-22T00:00:00+00:00",
    completed_at: "2026-09-22T00:00:00+00:00",
    identity_removed: false,
    notes: "IdentityProviderError: Zitadel is unreachable for DeactivateUser (ConnectError).",
  },
  {
    id: "0000000e-0000-0000-0000-00000000000e",
    org_id: ORGS[0].id,
    org_name: "Acme",
    subject: "carol",
    email: "carol@acme.com",
    requested_at: "2026-09-21T00:00:00+00:00",
    completed_at: "2026-09-21T00:00:00+00:00",
    identity_removed: true,
    notes: null,
  },
];

const KEY: AdminKey = {
  id: "0000000k-0000-0000-0000-00000000000k",
  prefix: "mw_abcd1234",
  name: "ci",
  scopes: ["chat:read", "chat:write"],
  created_at: "2026-09-01T00:00:00+00:00",
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
};

const INVITE: AdminInvite = {
  id: "0000000i-0000-0000-0000-00000000000i",
  email: "new@acme.com",
  role: "member",
  invited_by: "ada",
  created_at: "2026-09-25T00:00:00+00:00",
  expires_at: "2026-10-02T00:00:00+00:00",
  status: "pending",
};

function stubOperatorApi(extra: Parameters<typeof stubApi>[0] = () => undefined) {
  return stubAdminApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    const { method, url } = call;
    if (method === "GET" && url === "/api/admin/moderation/queue?status=open") {
      return { status: 200, body: { data: [REPORT] } };
    }
    if (method === "GET" && url.startsWith("/api/admin/moderation/queue?status=")) return { status: 200, body: { data: [] } };
    if (method === "GET" && url === "/api/admin/enforcement") return { status: 200, body: { data: [ACTION] } };
    if (method === "GET" && url === "/api/admin/enforcement/user/bo") {
      return { status: 200, body: { target_kind: "user", target: "bo", current: ACTION, history: [ACTION] } };
    }
    if (method === "GET" && url === "/api/admin/moderation/flags") return { status: 200, body: { data: [FLAG] } };
    if (method === "GET" && url === "/api/admin/moderation/users/bo") {
      return {
        status: 200,
        body: { subject: "bo", violations: 4, window_days: 90, threshold: 3, over_threshold: true },
      };
    }
    if (method === "GET" && url === "/api/admin/health") return { status: 200, body: HEALTH };
    if (method === "GET" && url === "/api/admin/deletion-requests") return { status: 200, body: { data: DELETIONS } };
    if (method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/keys`) return { status: 200, body: { data: [KEY] } };
    if (method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/invites`) {
      return { status: 200, body: { data: [INVITE] } };
    }
    if (method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/billing`) {
      return { status: 200, body: orgBilling(ORGS[0].id) };
    }
    return undefined;
  });
}

describe("the moderation tab", () => {
  it("lists the open reports with the one reported message and closes one with a note", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "POST" && url === `/api/admin/moderation/reports/${REPORT.id}/review`) {
        return { status: 200, body: { id: REPORT.id, status: "dismissed", action_id: null } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Moderation"));
    await flush();
    const queue = mounted.container.querySelector("ul[aria-label='Open reports']")!;
    expect(queue).not.toBeNull();
    expect(queue.textContent).toContain("ada");
    expect(queue.textContent).toContain("please look at this");
    // The reported message, under the line that says why it is shown.
    const quoted = queue.querySelector("[data-testid='reported-message']")!;
    expect(quoted.textContent).toContain("the reported reply text");
    expect(quoted.textContent).toContain("shown because they reported it");
    expect(quoted.textContent).toContain("fake-mini");

    // Nothing to send until a note is written.
    const dismiss = buttonNamed(queue, "Dismiss 0000000r");
    expect(dismiss.disabled).toBe(true);
    setInputValue(
      queue.querySelector<HTMLInputElement>("input[aria-label='Note for report 0000000r']")!,
      "fiction, clearly labelled",
    );
    expect(dismiss.disabled).toBe(false);
    submit(dismiss.form!);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`/api/admin/moderation/reports/${REPORT.id}/review`);
    expect(post?.body).toEqual({ action: "dismiss", note: "fiction, clearly labelled" });
    // The queue reloads after the close.
    expect(calls.filter((c) => c.url === "/api/admin/moderation/queue?status=open").length).toBe(2);
  });

  it("says when the reported message is gone, and shows no text for a whole-conversation report", async () => {
    stubOperatorApi(({ method, url }) => {
      if (method === "GET" && url === "/api/admin/moderation/queue?status=open") {
        return {
          status: 200,
          body: {
            data: [
              { ...REPORT, message: { available: false, role: null, text: null, model: null } },
              { ...REPORT, id: "0000000s-0000-0000-0000-00000000000s", message_id: null, message: null },
            ],
          },
        };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Moderation"));
    await flush();
    const queue = mounted.container.querySelector("ul[aria-label='Open reports']")!;
    expect(queue.querySelectorAll("[data-testid='reported-message']").length).toBe(0);
    expect(queue.textContent).toContain("has since been deleted or purged");
    expect(queue.textContent).toContain("The whole conversation was reported");
  });

  it("shows the recent flags without any message text and looks up an account's violations", async () => {
    const calls = stubOperatorApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Moderation"));
    await flush();
    const flags = mounted.container.querySelector("table[aria-label='Recent flags']")!;
    expect(flags).not.toBeNull();
    expect(flags.textContent).toContain("harassment");
    expect(flags.textContent).toContain("0.91");
    expect(flags.textContent).toContain("blocked");

    click(buttonNamed(flags, "Violations for bo"));
    await flush();
    expect(calls.some((c) => c.url === "/api/admin/moderation/users/bo")).toBe(true);
    const summary = mounted.container.querySelector("dl[aria-label='Violations for bo']")!;
    expect(summary.textContent).toContain("4 in the last 90 days");
    expect(summary.textContent).toContain("over threshold of 3");
  });

  it("shows the API's refusal beside the report it was for", async () => {
    stubOperatorApi(({ method, url }) => {
      if (method === "POST" && url.endsWith("/review")) return { status: 404, body: { detail: "No such report." } };
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Moderation"));
    await flush();
    const queue = mounted.container.querySelector("ul[aria-label='Open reports']")!;
    setInputValue(queue.querySelector<HTMLInputElement>("input[aria-label='Note for report 0000000r']")!, "x");
    submit(buttonNamed(queue, "Dismiss 0000000r").form!);
    await flush();
    expect(queue.querySelector("[role='alert']")?.textContent).toBe("No such report.");
  });
});

describe("the enforcement tab", () => {
  it("lists what is in force and opens one target with its state, history and the lift form", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "POST" && url === "/api/admin/enforcement/user/bo/lift") {
        return { status: 200, body: { ...ACTION, lifted_at: "2026-09-22T12:00:00+00:00", lifted_by: "dev-user" } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Enforcement"));
    await flush();
    const inForce = mounted.container.querySelector("table[aria-label='Enforcement in force']")!;
    expect(inForce).not.toBeNull();
    expect(inForce.textContent).toContain("bo");
    expect(inForce.textContent).toContain("Rate limited");
    expect(inForce.textContent).toContain("Automated traffic.");

    click(buttonNamed(inForce, "Open bo"));
    await flush();
    expect(calls.some((c) => c.url === "/api/admin/enforcement/user/bo")).toBe(true);
    const panel = mounted.container.querySelector("[aria-label='Current state of user bo']")!;
    expect(panel.textContent).toContain("Rate limited");
    expect(panel.textContent).toContain("farm pattern");
    expect(mounted.container.querySelector("table[aria-label='Enforcement history']")).not.toBeNull();

    // Lifting needs a reason, then posts it.
    const lift = buttonNamed(panel, "Lift rate limited");
    expect(lift.disabled).toBe(true);
    setInputValue(panel.querySelector<HTMLInputElement>("input[aria-label='Reason for lifting']")!, "Appeal upheld.");
    expect(lift.disabled).toBe(false);
    submit(lift.form!);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/admin/enforcement/user/bo/lift");
    expect(post?.body).toEqual({ reason: "Appeal upheld." });
  });

  it("applies a state to a looked-up subject with the reason written first", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "GET" && url === "/api/admin/enforcement/user/ada") {
        return { status: 200, body: { target_kind: "user", target: "ada", current: null, history: [] } };
      }
      if (method === "PUT" && url === "/api/admin/enforcement/user/ada") {
        return { status: 200, body: { ...ACTION, target: "ada", state: "warned", expires_at: null } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Enforcement"));
    await flush();
    const search = mounted.container.querySelector<HTMLFormElement>("form[role='search']")!;
    setInputValue(search.querySelector<HTMLInputElement>("input[name='target']")!, "ada");
    submit(search);
    await flush();
    const form = mounted.container.querySelector<HTMLFormElement>("form[aria-label='Apply a state']")!;
    expect(form).not.toBeNull();
    const apply = buttonNamed(form, "Apply warned");
    expect(apply.disabled).toBe(true);
    setInputValue(form.querySelector<HTMLInputElement>("input[aria-label='Reason shown to the person']")!, "Read the policy.");
    expect(apply.disabled).toBe(false);
    submit(form);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/admin/enforcement/user/ada");
    expect(put?.body).toEqual({ state: "warned", reason: "Read the policy." });
  });
});

describe("the health tab", () => {
  it("shows the build, the pending migration and which capabilities are off", async () => {
    stubOperatorApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Health"));
    await flush();
    const text = mounted.container.textContent!;
    expect(text).toContain("0.4.0");
    expect(text).toContain("abc1234");
    expect(text).toContain("Cannot reach the model gateway");
    expect(text).toContain("Pending: 0038_account_deletion_requests");
    expect(text).toContain("MW_LITELLM_VIRTUAL_KEYS is off");
    expect(text).toContain("Prompts are screened before they are sent.");
    expect(text).toContain("No MW_SEARCH_API_KEY");
  });
});

describe("the deletions tab", () => {
  it("lists every request with whether the login was removed", async () => {
    stubOperatorApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Deletions"));
    await flush();
    expect(mounted.container.textContent).toContain("1 deletion still has a working login");
    const table = mounted.container.querySelector("table[aria-label='Deletion requests']")!;
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(rows[0]).toContain("bo@bolt.com");
    expect(rows[0]).toContain("Bolt");
    expect(rows[0]).toContain("login remains");
    expect(rows[0]).toContain("Zitadel is unreachable");
    expect(rows[1]).toContain("carol@acme.com");
    expect(rows[1]).toContain("removed");
  });
});

describe("an organisation's details", () => {
  it("open beneath its row with keys and invites, revoke a key through the dialog and set the overage cap", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "DELETE" && url === `/api/admin/orgs/${ORGS[0].id}/keys/${KEY.id}`) {
        return { status: 200, body: { ...KEY, revoked_at: "2026-09-28T00:00:00+00:00" } };
      }
      if (method === "PUT" && url === `/api/admin/orgs/${ORGS[0].id}/budget`) {
        return {
          status: 200,
          body: {
            period_start: "2026-09-01",
            included_tokens: 20_000_000,
            tokens_used: 21_500_000,
            remaining_tokens: 0,
            overage_enabled: true,
            overage_cap_micros: 75_000_000,
            overage_micros: 12_340_000,
          },
        };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const details = mounted.container.querySelector("[aria-label='Acme details']")!;
    expect(details).not.toBeNull();
    expect(details.querySelector("table[aria-label='Acme API keys']")?.textContent).toContain("mw_abcd1234");
    expect(details.querySelector("table[aria-label='Acme invites']")?.textContent).toContain("new@acme.com");

    // Revoke: confirmed in the dialog, then the list reloads.
    click(buttonNamed(details, "Revoke ci"));
    await flush();
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Revoke ci?");
    click(buttonNamed(dialog, "Revoke"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/keys/${KEY.id}`))).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/keys")).length).toBe(2);

    // Overage cap: dollars in, micro-dollars out, and the orgs table reloads with the new cap.
    const limit = details.querySelector<HTMLInputElement>("input[type='number']")!;
    expect(limit.value).toBe("50.00");
    const save = buttonNamed(details, "Save overage cap for Acme");
    expect(save.disabled).toBe(true);
    setInputValue(limit, "75");
    expect(save.disabled).toBe(false);
    submit(save.form!);
    await flush();
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/budget"));
    expect(put?.body).toEqual({ overage_cap_micros: 75_000_000 });
    expect(details.querySelector("[role='status']")?.textContent).toBe("Overage cap saved: $75.00 a month.");
    expect(calls.filter((c) => c.method === "GET" && c.url === "/api/admin/orgs").length).toBe(2);
  });
});
