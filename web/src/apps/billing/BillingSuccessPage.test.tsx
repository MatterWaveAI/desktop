import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_SUCCESS_PATH, PRICING_PATH } from "../../shell/frontDoor";
import { cleanup, currentLocation, jsonResponse, mount, stubApi, view } from "../../shell/frontDoorHarness";
import { BillingSuccessPage } from "./BillingSuccessPage";

/**
 * Where Checkout lands: only with the session Stripe appends, never a
 * bare visit claiming a payment; and nothing on it pulses, because pulsing
 * muted text drops below a readable contrast half the time.
 */

const STATUS = {
  org_id: "org-a",
  plan: "pro",
  plan_name: "Pro",
  status: "active",
  implicit: false,
  billing_enabled: true,
};

function Pricing() {
  return <h1>Plans</h1>;
}

afterEach(cleanup);

describe("/billing/success", () => {
  it("sends a visit without a checkout session to the plans, saying nothing about a payment", async () => {
    stubApi({ "/api/billing/status": jsonResponse({ ...STATUS, implicit: true, plan: "free" }) });
    await mount(BILLING_SUCCESS_PATH, { [BILLING_SUCCESS_PATH]: BillingSuccessPage, [PRICING_PATH]: Pricing });
    await vi.waitFor(() => expect(currentLocation().pathname).toBe(PRICING_PATH));
    expect(view().textContent).not.toMatch(/payment/i);
  });

  it("waits for the plan without pulsing text, then names it", async () => {
    stubApi({ "/api/billing/status": jsonResponse(STATUS) });
    await mount(`${BILLING_SUCCESS_PATH}?session_id=cs_test_1`, { [BILLING_SUCCESS_PATH]: BillingSuccessPage });
    expect(view().querySelector(".animate-pulse")).toBeNull();
    await vi.waitFor(() => expect(view().querySelector("h1")?.textContent).toBe("You're on Pro"));
  });
});
