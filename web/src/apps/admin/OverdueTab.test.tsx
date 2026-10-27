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
import { LATE, OPEN_INVOICE, orgBilling, overdueRow } from "./billingFixtures";
import { chooseOption, combobox, optionLabels } from "./selectTesting";

/**
 * The Overdue tab: every late org on one page, and the operator's levers
 * on each -- grace, the per-org policy (a ceiling refusal shown as the
 * API's 422), mark paid, resend, invoice billing. Each test asserts the
 * exact request the API received; what the API does with it is
 * api/tests/test_dunning.py's.
 */

const ORG_ID = "0000000a-0000-0000-0000-00000000000a";
const BASE = `/api/admin/orgs/${ORG_ID}`;
const LATE_BILLING = orgBilling(ORG_ID, {
  dunning: LATE,
  collection_method: "send_invoice",
  days_until_due: 30,
  invoicing: { billing_email: "ap@acme.test", po_number: "PO-7781" },
  invoices: [OPEN_INVOICE],
});

let mounted: Mounted | null = null;

afterEach(() => {
  // The open tab lives in the URL; the next test starts on the first one.
  history.replaceState(null, "", "/");
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub(extra: Parameters<typeof stubApi>[0] = () => undefined) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url === "/api/admin/orgs") return { status: 200, body: { data: [] } };
    if (call.method === "GET" && call.url === "/api/admin/billing/overdue") {
      return {
        status: 200,
        body: {
          data: [overdueRow(ORG_ID, "Acme")],
          limits: { max_days_overdue_ceiling: 180, max_outstanding_ceiling_micros: 5_000_000_000 },
        },
      };
    }
    if (call.method === "GET" && call.url === `${BASE}/billing`) return { status: 200, body: LATE_BILLING };
    return undefined;
  });
}

async function openAcme(): Promise<HTMLElement> {
  mounted = await mount(<AdminPage />, principalWith(["admin", "user"]));
  click(adminTab(mounted.container, "Overdue"));
  await flush();
  click(buttonNamed(mounted.container, "Manage Acme"));
  await flush();
  return mounted.container;
}

/** An admin tab: a link in the Admin sections strip. */
function adminTab(scope: ParentNode, name: string): HTMLAnchorElement {
  const found = [...scope.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Admin sections'] a")].find(
    (a) => a.textContent === name,
  );
  if (!found) throw new Error(`no tab ${name}`);
  return found;
}

function inputLabelled(scope: ParentNode, text: string): HTMLInputElement {
  const label = [...scope.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(text));
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled ${text}`);
  return input;
}

describe("the Overdue tab", () => {
  it("lists each late org with its stage, amount, next step, policy and the limit that fired", async () => {
    stub();
    mounted = await mount(<AdminPage />, principalWith(["admin", "user"]));
    click(adminTab(mounted.container, "Overdue"));
    await flush();
    const row = mounted.container.querySelector("[data-overdue-stage='limited']");
    expect(row?.textContent).toContain("Acme");
    expect(row?.textContent).toContain("invoice, net 30");
    expect(row?.textContent).toContain("Limited");
    expect(row?.textContent).toContain("$120.00");
    expect(row?.textContent).toContain("On Free,");
    expect(row?.textContent).toContain("own");
    expect(row?.textContent).toContain("Reseller");
    expect(row?.textContent).toContain("amount limit: overage stopped");
  });

  it("says so when nobody is late", async () => {
    stub((call) =>
      call.url === "/api/admin/billing/overdue"
        ? { status: 200, body: { data: [], limits: { max_days_overdue_ceiling: 180, max_outstanding_ceiling_micros: 1 } } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin", "user"]));
    click(adminTab(mounted.container, "Overdue"));
    await flush();
    expect(mounted.container.textContent).toContain("Nobody is overdue");
  });

  it("extends the grace with a reason", async () => {
    const calls = stub((call) =>
      call.method === "POST" && call.url === `${BASE}/billing/extend`
        ? { status: 200, body: { ...LATE_BILLING, grace_days: 10 } }
        : undefined,
    );
    const page = await openAcme();
    setInputValue(inputLabelledById(page, "Days of grace for Acme"), "10");
    setInputValue(page.querySelector<HTMLInputElement>("input[aria-label='Reason for the extension']")!, "asked nicely");
    submit(buttonNamed(page, "Extend grace for Acme").closest("form")!);
    await flush();
    expect(calls.filter((c) => c.method !== "GET").at(-1)).toEqual({
      method: "POST",
      url: `${BASE}/billing/extend`,
      body: { days: 10, reason: "asked nicely" },
    });
    expect(page.textContent).toContain("10 in all");
  });

  it("sends only the fields an operator set, and shows the ceiling refusal", async () => {
    const calls = stub((call) =>
      call.method === "PUT" && call.url === `${BASE}/billing/policy`
        ? { status: 422, body: { detail: "max_days_overdue is 365 days, past the platform ceiling of 180 days overdue" } }
        : undefined,
    );
    const page = await openAcme();
    setInputValue(inputLabelled(page, "Limited regardless after"), "365");
    await chooseOption(combobox(page, "Moves to Free at the suspend day"), "Off");
    setInputValue(inputLabelled(page, "Why"), "Partner");
    submit(buttonNamed(page, "Save policy for Acme").closest("form")!);
    await flush();
    expect(calls.filter((c) => c.method !== "GET").at(-1)).toEqual({
      method: "PUT",
      url: `${BASE}/billing/policy`,
      body: { max_days_overdue: 365, auto_suspend: false, note: "Partner" },
    });
    expect(page.querySelector("[role='alert']")?.textContent).toContain("past the platform ceiling");
  });

  it("marks an invoice paid with how it was paid, and resends one", async () => {
    const calls = stub((call) => {
      if (call.method === "POST" && call.url === `${BASE}/invoices/in_1/mark-paid`) {
        return { status: 200, body: { ...LATE_BILLING, dunning: null, invoices: [{ ...OPEN_INVOICE, status: "paid" }] } };
      }
      if (call.method === "POST" && call.url === `${BASE}/invoices/in_1/resend`) {
        return { status: 200, body: { id: "in_1", sent: true } };
      }
      return undefined;
    });
    const page = await openAcme();
    click(buttonNamed(page, "Resend ACME-0007"));
    await flush();
    expect(calls.filter((c) => c.method !== "GET").at(-1)).toEqual({ method: "POST", url: `${BASE}/invoices/in_1/resend`, body: undefined });
    expect(page.textContent).toContain("ACME-0007 sent again.");

    click(buttonNamed(page, "Mark ACME-0007 paid"));
    await flush();
    const dialog = document.querySelector("[role='alertdialog'], [role='dialog']")!;
    setInputValue(dialog.querySelector<HTMLInputElement>("input[aria-label='How it was paid']")!, "wire 4471");
    click(buttonNamed(dialog, "Mark paid"));
    await flush();
    expect(calls.filter((c) => c.method !== "GET").at(-1)).toEqual({
      method: "POST",
      url: `${BASE}/invoices/in_1/mark-paid`,
      body: { reason: "wire 4471" },
    });
    expect(page.textContent).toContain("In good standing");
  });

  it("switches an org on a card to invoices with terms, address and PO", async () => {
    const calls = stub((call) => {
      if (call.method === "GET" && call.url === `${BASE}/billing`) {
        return { status: 200, body: orgBilling(ORG_ID, { dunning: LATE }) };
      }
      if (call.method === "PUT" && call.url === `${BASE}/billing/invoicing`) {
        return { status: 200, body: LATE_BILLING };
      }
      if (call.method === "GET" && call.url === "/api/admin/plans") {
        return {
          status: 200,
          body: { data: [{ code: "free", display_name: "Free" }, { code: "pro", display_name: "Pro" }] },
        };
      }
      return undefined;
    });
    const page = await openAcme();
    await chooseOption(combobox(page, "Net terms"), "60 days");
    setInputValue(inputLabelled(page, "Billing email"), "ap@acme.test");
    setInputValue(inputLabelled(page, "PO number"), "PO-7781");
    // The plan is a pick from the catalog, never a typed code.
    const plan = combobox(page, "Plan, if it has no subscription yet");
    expect(await optionLabels(plan)).toEqual(["Keep its plan", "Free", "Pro"]);
    await chooseOption(plan, "Pro");
    submit(buttonNamed(page, "Bill Acme by invoice").closest("form")!);
    await flush();
    expect(calls.filter((c) => c.method !== "GET").at(-1)).toEqual({
      method: "PUT",
      url: `${BASE}/billing/invoicing`,
      body: { terms: 60, billing_email: "ap@acme.test", po_number: "PO-7781", plan: "pro", annual: false },
    });
    expect(page.textContent).toContain("Billed by invoice, net 30, to ap@acme.test, PO PO-7781");
  });
});

function inputLabelledById(scope: ParentNode, text: string): HTMLInputElement {
  const label = [...scope.querySelectorAll("label")].find((l) => l.textContent?.trim() === text);
  const input = label?.htmlFor ? (scope as Element).querySelector<HTMLInputElement>(`[id='${label.htmlFor}']`) : null;
  if (!input) throw new Error(`no input labelled ${text}`);
  return input;
}
