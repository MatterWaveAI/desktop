import { afterEach, describe, expect, it, vi } from "vitest";
import { click, flush, mount, principalWith, stubApi, type Mounted } from "../settings/panes/paneHarness";
import { AdminPage } from "./AdminPage";
import type { DisputeRow } from "./adminApi";

/**
 * The Disputes tab: every chargeback and fraud warning in the API's order
 * (open by deadline, then closed), a passed deadline marked, and each row's
 * way to Stripe. The order and the overdue flag are the API's
 * (api/tests/test_disputes.py); this asserts they are shown.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  history.replaceState(null, "", "/");
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function dispute(id: string, over: Partial<DisputeRow> = {}): DisputeRow {
  return {
    id,
    kind: "dispute",
    org_id: "0000000a-0000-0000-0000-00000000000a",
    org_name: "Acme",
    charge_id: "ch_1",
    invoice_id: "in_1",
    invoice_number: "ACME-0001",
    amount_micros: 20_000_000,
    currency: "usd",
    reason: "product_not_received",
    status: "needs_response",
    evidence_due_by: "2026-11-06T08:59:59+00:00",
    overdue: false,
    outcome: null,
    funds_withdrawn_at: null,
    funds_reinstated_at: null,
    refund_id: null,
    opened_at: "2026-10-27T09:00:00+00:00",
    closed_at: null,
    dashboard_url: `https://dashboard.stripe.com/test/disputes/${id}`,
    ...over,
  };
}

function stub(rows: DisputeRow[]) {
  return stubApi((call) => {
    if (call.method === "GET" && call.url === "/api/admin/orgs") return { status: 200, body: { data: [] } };
    if (call.method === "GET" && call.url === "/api/admin/billing/disputes") return { status: 200, body: { data: rows } };
    return undefined;
  });
}

function adminTab(scope: ParentNode, name: string): HTMLAnchorElement {
  const found = [...scope.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Admin sections'] a")].find(
    (a) => a.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  return found;
}

async function openDisputes(rows: DisputeRow[]): Promise<HTMLElement> {
  stub(rows);
  mounted = await mount(<AdminPage />, principalWith(["admin", "user"]));
  click(adminTab(mounted.container, "Disputes"));
  await flush();
  return mounted.container;
}

describe("the Disputes tab", () => {
  it("lists them in the API's order, marks a passed deadline and links each to Stripe", async () => {
    const container = await openDisputes([
      dispute("dp_late", { overdue: true, evidence_due_by: "2026-10-20T08:59:59+00:00" }),
      dispute("dp_soon"),
      dispute("dp_lost", { status: "lost", outcome: "lost", closed_at: "2026-11-10T09:00:00+00:00" }),
    ]);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-dispute-id]")];
    expect(rows.map((r) => r.dataset.disputeId)).toEqual(["dp_late", "dp_soon", "dp_lost"]);

    expect(rows[0].dataset.overdue).toBe("true");
    expect(rows[0].textContent).toContain("past due");
    expect(rows[1].dataset.overdue).toBeUndefined();
    expect(rows[1].textContent).toContain("Needs response");
    expect(rows[1].textContent).toContain("$20.00");
    expect(rows[1].textContent).toContain("product not received");
    expect(rows[1].textContent).toContain("ACME-0001");
    // A closed one has no deadline left to show.
    expect(rows[2].textContent).toContain("Lost");
    expect(rows[2].textContent).not.toContain("past due");

    const link = rows[1].querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("Open in Stripe");
    expect(link.getAttribute("href")).toBe("https://dashboard.stripe.com/test/disputes/dp_soon");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows a refunded fraud warning and an org nobody here owns", async () => {
    const container = await openDisputes([
      dispute("issfr_1", {
        kind: "fraud_warning",
        org_id: null,
        org_name: null,
        invoice_id: null,
        invoice_number: null,
        reason: "made_with_stolen_card",
        status: "refunded",
        evidence_due_by: null,
        refund_id: "re_1",
        closed_at: "2026-10-26T09:00:00+00:00",
      }),
    ]);
    const row = container.querySelector("[data-dispute-id='issfr_1']")!;
    expect(row.textContent).toContain("Unknown organisation");
    expect(row.textContent).toContain("Early fraud warning");
    expect(row.textContent).toContain("Refunded");
    expect(row.textContent).toContain("refunded, subscription cancelled");
  });

  it("says so when there are none", async () => {
    const container = await openDisputes([]);
    expect(container.textContent).toContain("No disputes");
  });
});
