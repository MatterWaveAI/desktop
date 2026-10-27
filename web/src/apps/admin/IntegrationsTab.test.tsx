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
import { AdminPage } from "./AdminPage";
import type { InboundRow, OutboxRow, SalesforceState } from "./integrationsApi";

/**
 * Integrations -> Salesforce: the connection and its last sync, the dead
 * letters with their retry, the contract events with apply, and the
 * Account link. Each test asserts the request the API received; what the
 * API does with it is api/tests/test_crm.py's.
 */

const BASE = "/api/admin/integrations/salesforce";
const ORG_ID = "0000000a-0000-0000-0000-00000000000a";

const STATE: SalesforceState = {
  provider: "salesforce",
  configured: true,
  active: true,
  inbound_configured: false,
  login_url: "https://login.salesforce.com",
  username: "integration@acme.example",
  api_version: "62.0",
  sync_scope: "paid",
  inbound_url: "https://app.test/api/integrations/salesforce/events",
  connection: {
    instance_url: "https://acme.my.salesforce.com",
    last_ok_at: "2026-10-20T09:00:00+00:00",
    last_error: "Salesforce 400 on PATCH sobjects/Account: INVALID_FIELD: No such column",
    last_error_at: "2026-10-20T09:05:00+00:00",
  },
  last_sync_at: "2026-10-20T09:00:00+00:00",
  outbox: { pending: 1, sending: 0, sent: 12, dead: 1, skipped: 0 },
  inbound: { received: 0, applied: 1, failed: 0, awaiting_link: 1 },
};

const DEAD: OutboxRow = {
  id: "0190000a-0000-7000-8000-000000000001",
  org_id: ORG_ID,
  kind: "invoice.updated",
  dedupe_key: "invoice:in_1:open:20000000",
  payload: {},
  status: "dead",
  attempts: 6,
  next_attempt_at: "2026-10-20T09:05:00+00:00",
  last_error: "Salesforce 400 on PATCH sobjects/MatterWave_Invoice__c: INVALID_FIELD",
  crm_ref: null,
  created_at: "2026-10-19T09:05:00+00:00",
  updated_at: "2026-10-20T09:05:00+00:00",
  sent_at: null,
};

const WAITING: InboundRow = {
  event_id: "evt-sf-1",
  kind: "contract.signed",
  contract_ref: "00000101",
  opportunity_id: "006000000000001AAA",
  account_id: "001000000000002AAA",
  org_id: null,
  status: "awaiting_link",
  error: "No organisation is linked to Account 001000000000002AAA",
  attempts: 1,
  received_at: "2026-10-20T09:10:00+00:00",
  applied_at: null,
};

let mounted: Mounted | null = null;

afterEach(() => {
  // The open tab lives in the URL; the next test starts on the first one.
  history.replaceState(null, "", "/");
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub() {
  return stubApi((call) => {
    if (call.method === "GET" && call.url === "/api/admin/orgs") return { status: 200, body: { data: [] } };
    if (call.method === "GET" && call.url === BASE) return { status: 200, body: STATE };
    if (call.method === "GET" && call.url === `${BASE}/outbox?status=dead`) return { status: 200, body: { data: [DEAD] } };
    if (call.method === "GET" && call.url === `${BASE}/inbound`) return { status: 200, body: { data: [WAITING] } };
    if (call.method === "POST" && call.url === `${BASE}/outbox/${DEAD.id}/retry`) {
      return { status: 200, body: { data: { ...DEAD, status: "pending", attempts: 0 } } };
    }
    if (call.method === "POST" && call.url === `${BASE}/inbound/${WAITING.event_id}/apply`) {
      return { status: 200, body: { data: { ...WAITING, status: "applied", org_id: ORG_ID } } };
    }
    if (call.method === "POST" && call.url === `${BASE}/test`) {
      return { status: 200, body: { ok: true, user: "integration@acme.example", state: STATE } };
    }
    if (call.method === "PUT" && call.url === `/api/admin/orgs/${ORG_ID}/salesforce`) {
      return { status: 200, body: { org_id: ORG_ID, account_id: (call.body as { account_id?: string } | undefined)?.account_id, changed: true } };
    }
    return undefined;
  });
}

function tab(name: string): HTMLAnchorElement {
  const found = [...mounted!.container.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Admin sections'] a")].find(
    (b) => b.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  return found;
}

async function openTab(): Promise<HTMLElement> {
  mounted = await mount(<AdminPage />, principalWith(["admin"]));
  click(tab("Integrations"));
  await flush();
  await flush();
  return mounted.container;
}

describe("the integrations tab", () => {
  it("shows the connection, the last sync and that contract events are refused without a secret", async () => {
    stub();
    const view = await openTab();
    const connection = view.querySelector("dl[aria-label='Salesforce connection']")!;
    expect(connection.textContent).toContain("configured");
    expect(connection.textContent).toContain("as integration@acme.example");
    expect(connection.textContent).toContain("https://acme.my.salesforce.com");
    expect(connection.textContent).toContain("INVALID_FIELD: No such column");
    expect(connection.textContent).toContain("Set MW_SALESFORCE_WEBHOOK_SECRET.");
    expect(connection.textContent).toContain("https://app.test/api/integrations/salesforce/events");
    expect(view.textContent).toContain("1 waiting, 12 sent, 1 dead, 0 skipped");
  });

  it("opens on the dead letters and retries one", async () => {
    const calls = stub();
    const view = await openTab();
    const table = view.querySelector("table[aria-label='Outbox']")!;
    expect(table.textContent).toContain("Invoice");
    expect(table.textContent).toContain("INVALID_FIELD");
    click(buttonNamed(table, "Retry Invoice"));
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/outbox/${DEAD.id}/retry`)).toBe(true);
  });

  it("applies a contract event once its organisation is linked", async () => {
    const calls = stub();
    const view = await openTab();
    const form = view.querySelector("section[aria-labelledby='sf-link'] form") as HTMLFormElement;
    setInputValue(form.querySelector<HTMLInputElement>("input[name='org_id']")!, ORG_ID);
    setInputValue(form.querySelector<HTMLInputElement>("input[name='account_id']")!, "001000000000002AAA");
    submit(form);
    await flush();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/admin/orgs/${ORG_ID}/salesforce`);
    expect(put.body).toEqual({ account_id: "001000000000002AAA" });
    expect(view.textContent).toContain("Linked to Account 001000000000002AAA.");

    const events = view.querySelector("table[aria-label='Contract events']")!;
    expect(events.textContent).toContain("waiting for a link");
    click(buttonNamed(events, "Apply 00000101"));
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/inbound/evt-sf-1/apply`)).toBe(true);
  });

  it("tests the connection and says as whom", async () => {
    stub();
    const view = await openTab();
    click(buttonNamed(view, "Test connection"));
    await flush();
    expect(view.querySelector("section[aria-labelledby='sf-connection'] [role='status']")?.textContent).toBe(
      "Connected as integration@acme.example.",
    );
  });
});
