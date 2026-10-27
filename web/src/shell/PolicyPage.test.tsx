import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyPage } from "./PolicyPage";
import { POLICY_PATH, isAnonymousPath } from "./frontDoor";
import { cleanup, linkTo, mount, stubApi, view } from "./frontDoorHarness";
import type { PolicyStats } from "./policy";

/**
 * The acceptable-use policy page: on the front door, the ladder and the
 * appeal section a 403 can deep-link to, and the numbers read from the
 * public aggregate -- shown as zeros when that is what they are, and as a
 * plain line when the read fails.
 */

const ROUTES = { [POLICY_PATH]: PolicyPage };

const ZEROS: PolicyStats = {
  reports: {
    by_kind: { unsafe: 0, unhelpful: 0 },
    unsafe_by_status: { open: 0, reviewed: 0, actioned: 0, dismissed: 0 },
  },
  enforcement: {
    by_state: { warned: 0, rate_limited: 0, suspended: 0 },
    active: { warned: 0, rate_limited: 0, suspended: 0 },
    appeals: { received: 0, upheld: 0, overturned: 0 },
  },
};

afterEach(cleanup);

describe("/policy", () => {
  it("is reachable without a session", () => {
    expect(isAnonymousPath(POLICY_PATH)).toBe(true);
  });

  it("explains the ladder, how to report and how to appeal, with an anchor for the 403", async () => {
    stubApi({ "/api/policy/stats": { ok: true, status: 200, json: async () => ZEROS } });
    await mount(POLICY_PATH, ROUTES);
    const text = view().textContent ?? "";
    expect(view().querySelector("h1")?.textContent).toBe("Acceptable Use Policy");
    expect(text).toContain("we do not read your conversations");
    for (const heading of ["What is not allowed", "What happens: the ladder", "How to appeal", "How to report", "The numbers"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Warning");
    expect(text).toContain("Rate limit");
    expect(text).toContain("Suspension");
    expect(text).toContain("A model declining is not a violation");
    expect(view().querySelector("#appeal")).not.toBeNull();
    expect(text).toContain("five business days");
    expect(linkTo("/terms")).not.toBeNull();
    expect(linkTo("/privacy")).not.toBeNull();
  });

  it("shows the numbers as zeros when there is no data yet", async () => {
    stubApi({ "/api/policy/stats": { ok: true, status: 200, json: async () => ZEROS } });
    await mount(POLICY_PATH, ROUTES);
    await vi.waitFor(() => {
      expect(view().querySelector("[data-testid='policy-numbers']")).not.toBeNull();
    });
    const numbers = view().querySelector("[data-testid='policy-numbers']")!;
    expect(numbers.textContent).toContain("Suspensions");
    expect(numbers.textContent).toContain("Appeals upheld");
    const values = [...numbers.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(values.length).toBeGreaterThan(8);
    expect(new Set(values)).toEqual(new Set(["0"]));
  });

  it("shows real counts and sums the actions in force", async () => {
    const stats: PolicyStats = {
      reports: {
        by_kind: { unsafe: 3, unhelpful: 12 },
        unsafe_by_status: { open: 1, reviewed: 0, actioned: 1, dismissed: 1 },
      },
      enforcement: {
        by_state: { warned: 2, rate_limited: 1, suspended: 1 },
        active: { warned: 1, rate_limited: 0, suspended: 1 },
        appeals: { received: 1, upheld: 1, overturned: 0 },
      },
    };
    stubApi({ "/api/policy/stats": { ok: true, status: 200, json: async () => stats } });
    await mount(POLICY_PATH, ROUTES);
    await vi.waitFor(() => {
      expect(view().querySelector("[data-testid='policy-numbers']")).not.toBeNull();
    });
    const rows = Object.fromEntries(
      [...view().querySelectorAll("[data-testid='policy-numbers'] > div")].map((row) => [
        row.querySelector("dt")!.textContent,
        row.querySelector("dd")!.textContent,
      ]),
    );
    expect(rows["Reports received, unsafe"]).toBe("3");
    expect(rows["Reports received, unhelpful"]).toBe("12");
    expect(rows["Suspensions"]).toBe("1");
    expect(rows["Actions in force now"]).toBe("2");
    expect(rows["Appeals upheld"]).toBe("1");
  });

  it("says so when the counts cannot be read, and the policy still reads", async () => {
    stubApi({ "/api/policy/stats": { ok: false, status: 503, json: async () => ({ detail: "down" }) } });
    await mount(POLICY_PATH, ROUTES);
    await vi.waitFor(() => {
      expect(view().textContent).toContain("could not be loaded");
    });
    expect(view().textContent).toContain("How to appeal");
  });
});
