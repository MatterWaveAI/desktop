import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "@tanstack/react-router";
import type { AuthConfig, Principal } from "../types";
import { router } from "../routes";
import { ShellContext, type ShellContextValue } from "../shell/shellContext";
import { activateLocale, SOURCE_LOCALE } from "./locale";
import { MembersPane, type Member } from "../apps/settings/panes/MembersPane";
import { BillingPane } from "../apps/settings/panes/BillingPane";
import { WebhooksPane } from "../apps/settings/panes/WebhooksPane";
import { AdminPage } from "../apps/admin/AdminPage";

/**
 * The screens wrapped for translation, rendered in the es-ES pilot: none of
 * their key labels may still read in the source English. The unit tests
 * elsewhere run in en-GB and assert the English; this is the other side,
 * the proof that the strings go through the catalogue at all.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const authConfig: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "m" };

function principal(orgRole: string, roles: string[] = ["user"]): Principal {
  return {
    subject: "u1",
    kind: "dev",
    email: "dev@localhost",
    name: null,
    roles,
    org_id: "org-1",
    org_name: "Org One",
    org_role: orgRole,
  };
}

function shellValue(p: Principal): ShellContextValue {
  return {
    authConfig,
    principal: p,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: async () => {},
  } as unknown as ShellContextValue;
}

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = url.split("?")[0];
      const found = path in routes;
      return {
        ok: found,
        status: found ? 200 : 404,
        statusText: "",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => (found ? routes[path] : { detail: `no mock for ${path}` }),
        text: async () => JSON.stringify(found ? routes[path] : {}),
      };
    }),
  );
}

async function render(node: React.ReactNode, p: Principal) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RouterContextProvider router={router}>
        <ShellContext.Provider value={shellValue(p)}>{node}</ShellContext.Provider>
      </RouterContextProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Everything a reader or a screen reader gets: the text and the labelling attributes. */
function readable(): string {
  const attributes = [...container!.querySelectorAll("[aria-label],[title],[placeholder]")].flatMap((el) =>
    ["aria-label", "title", "placeholder"].map((name) => el.getAttribute(name) ?? ""),
  );
  return [container!.textContent ?? "", ...attributes].join("\n");
}

function expectNoEnglish(labels: string[]) {
  const text = readable();
  for (const label of labels) expect(text, `"${label}" is still English`).not.toContain(label);
}

beforeEach(async () => {
  await activateLocale("es-ES");
});

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  await activateLocale(SOURCE_LOCALE);
});

const MEMBERS: Member[] = [
  { subject: "ada", email: "ada@acme.com", name: "Ada", role: "owner", state: "active", created_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-10-10T12:00:00Z" },
  { subject: "u1", email: "dev@localhost", name: null, role: "admin", state: "active", created_at: "2026-09-02T00:00:00Z", last_seen_at: null },
];

const BILLING = {
  org_id: "org-1",
  plan: "pro",
  plan_name: "Pro",
  status: "active",
  seats: 1,
  per_seat: false,
  billed_seats: 1,
  price_cents_monthly: 2000,
  price_cents_annual: 20000,
  implicit: false,
  current_period_end: "2026-11-01T00:00:00+00:00",
  cancel_at_period_end: false,
  billing_interval: "month",
  default_overage_cap_micros: 20_000_000,
  limits: { included_tokens: 20_000_000, overage_enabled: true },
  over_capacity: 0,
  writes_blocked: false,
  read_only_reason: null,
  billing_enabled: true,
};

describe("in es-ES", () => {
  it("Settings > Members", async () => {
    stub({
      "/api/org/members": { data: MEMBERS, role: "admin", seats: { used: 2, max: 5, billed: null } },
      "/api/org/invites": { data: [] },
      "/api/org/invite-links": { data: [] },
    });
    await render(<MembersPane />, principal("admin"));
    expect(readable()).toContain("Enviar invitación");
    expectNoEnglish([
      "Invite people",
      "Send invite",
      "Invite link",
      "Pending invites",
      "Filter members",
      "Sort by name",
      "Never active",
      "seats",
      "Owner",
      "Email",
      "Leave",
    ]);
  });

  it("Settings > Billing", async () => {
    stub({ "/api/billing/status": BILLING, "/api/billing/invoices": { data: [] }, "/api/plan/history": { data: [] } });
    await render(<BillingPane />, principal("owner"));
    expect(readable()).toContain("Gestionar la facturación");
    expectNoEnglish(["Manage billing", "Status", "Renews", "Change plan", "Invoices", "Plan history", "Payment"]);
  });

  it("Settings > Webhooks", async () => {
    stub({ "/api/org/webhooks": { data: [], events: ["member.added", "invoice.paid"] } });
    await render(<WebhooksPane />, principal("owner"));
    expectNoEnglish(["Learn more", "Each endpoint", "Add endpoint", "No endpoints", "Events"]);
  });

  it("the admin console", async () => {
    stub({ "/api/admin/orgs": { data: [] } });
    await render(<AdminPage />, principal("owner", ["admin", "user"]));
    expect(readable()).toContain("Organizaciones");
    expectNoEnglish([
      "Organisations",
      "Users",
      "Billing",
      "Overdue",
      "Plans",
      "Flags",
      "Announcements",
      "Integrations",
      "Retention",
      "Moderation",
      "Search organisations",
      "Admin sections",
    ]);
  });
});
