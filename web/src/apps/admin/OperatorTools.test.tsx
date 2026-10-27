import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { SupportBanner } from "./SupportBanner";
import { diffPlan } from "./planDiff";
import { orgBilling } from "./billingFixtures";
import type { AdminFlag, AdminOrg, AdminPlan, RetentionPreview, SupportSession } from "./adminApi";
import type { ModelPrice } from "../../lib/billing";
import { chooseOption, combobox, optionLabels, selectedValue } from "./selectTesting";

/**
 * The operator's tools: the plan catalog editor with its diff preview and
 * the force path, the flag rows with a per-org override, the retention
 * preview and the per-org window, and support mode -- the button that
 * opens an org and the banner that says the operator is in it.
 *
 * Each test states the API it expects in one place and asserts the exact
 * request the API received; the API's own behaviour is api/tests'.
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

const FREE: AdminPlan = {
  code: "free",
  display_name: "Free",
  is_public: true,
  limits: {
    included_tokens: 1_000_000,
    included_tokens_per_seat: null,
    overage_enabled: false,
    budget_duration: "1mo",
    tpm_limit: 10000,
    rpm_limit: 20,
    max_parallel_requests: 2,
    max_conversations: 25,
    max_seats: 1,
    allowed_models: [],
    features: { api_keys: true, custom_instructions: false, org_sso: false },
  },
  price_cents_monthly: 0,
  price_cents_annual: 0,
  stripe_price_id_monthly: null,
  stripe_price_id_annual: null,
  stripe_price_id_overage: null,
  default_overage_cap_micros: 0,
};

const PRO: AdminPlan = {
  ...FREE,
  code: "pro",
  display_name: "Pro",
  limits: {
    ...FREE.limits,
    included_tokens: 20_000_000,
    overage_enabled: true,
    max_conversations: null,
    allowed_models: ["grt-nano-pro"],
    max_seats: 5,
  },
  price_cents_monthly: 2000,
  price_cents_annual: 20000,
  stripe_price_id_monthly: "price_m",
  default_overage_cap_micros: 20_000_000,
};

// Seeded with an explicit list, as every seeded plan now is: null would
// still mean "every GRT model", but no shipped plan relies on it.
const PRO_PLUS: AdminPlan = {
  ...PRO,
  code: "pro_plus",
  display_name: "Pro Plus",
  limits: { ...PRO.limits, included_tokens: 60_000_000, allowed_models: ["grt-nano-pro", "grt-nano-max"] },
  price_cents_monthly: 6000,
  price_cents_annual: 60000,
  default_overage_cap_micros: 60_000_000,
};

/** The price list `GET /api/admin/plans` sends beside the plans: GRT first, then a partner. */
const PRICED: ModelPrice[] = [
  { id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false },
  { id: "grt-nano-pro", label: "GRT Nano Pro", multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2, partner: false },
  { id: "grt-nano-max", label: "GRT Nano Max", multiplier: 20, input_usd_per_m: 2, output_usd_per_m: 8, partner: false },
  { id: "glm-4.6", label: "GLM 4.6", multiplier: 6, input_usd_per_m: 0.6, output_usd_per_m: 2.2, partner: true },
];

const AGENTS_UI: AdminFlag = {
  key: "agents_ui",
  enabled: false,
  description: "",
  rollout: { orgs: [], percent: 0 },
  updated_by: null,
  updated_at: null,
  default: false,
  defined: false,
};

const APP_REGISTRY: AdminFlag = {
  ...AGENTS_UI,
  key: "app_registry",
  enabled: false,
  description: "trial",
  rollout: { orgs: [ORGS[1].id], percent: 10 },
  updated_by: "ops",
  updated_at: "2026-10-01T00:00:00+00:00",
  default: true,
  defined: true,
};

const PREVIEW: RetentionPreview = {
  generated_at: "2026-10-03T02:00:00+00:00",
  orgs: [
    {
      org_id: ORGS[0].id,
      org_name: "Acme",
      retention_days: 30,
      cutoff: "2026-09-03T02:00:00+00:00",
      conversations: 4,
    },
  ],
  soft_delete_count: 4,
  hard_delete_cutoff: "2026-09-03T02:00:00+00:00",
  hard_delete_count: 2,
  purge_days: 30,
};

const SESSION: SupportSession = {
  active: true,
  id: "sess-1",
  org_id: ORGS[0].id,
  org_name: "Acme",
  started_at: "2026-10-03T10:00:00+00:00",
  expires_at: "2026-10-03T10:30:00+00:00",
};

let mounted: Mounted | null = null;
const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  // The open tab lives in the URL; every test starts on the first one.
  history.replaceState(null, "", "/");
  // Entering and leaving support mode is a full navigation
  // (adminApi.navigateTo); jsdom cannot navigate, so the call is recorded.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  assign.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubOperatorApi(extra: Parameters<typeof stubApi>[0] = () => undefined) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    const { method, url } = call;
    if (method === "GET" && url === "/api/admin/orgs") return { status: 200, body: { data: ORGS } };
    if (method === "GET" && url === "/api/admin/plans") {
      return { status: 200, body: { data: [FREE, PRO], models: PRICED } };
    }
    if (method === "GET" && url === "/api/admin/flags") {
      return { status: 200, body: { data: [AGENTS_UI, APP_REGISTRY] } };
    }
    if (method === "GET" && url === "/api/admin/retention/preview") return { status: 200, body: PREVIEW };
    if (method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/retention`) {
      return { status: 200, body: { org_id: ORGS[0].id, retention_days: null } };
    }
    if (method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/billing`) {
      return { status: 200, body: orgBilling(ORGS[0].id) };
    }
    if (method === "GET" && url.startsWith(`/api/admin/orgs/${ORGS[0].id}/`)) {
      return { status: 200, body: { data: [] } };
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

function form(name: string): HTMLFormElement {
  const found = mounted!.container.querySelector<HTMLFormElement>(`form[aria-label='${name}']`);
  if (!found) throw new Error(`no form named ${name}`);
  return found;
}

function labelled(scope: ParentNode, text: string): HTMLInputElement {
  const label = [...scope.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(text));
  const input = label?.querySelector("input") ?? (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled ${text}`);
  return input;
}


// --- the plan catalog ----------------------------------------------------------

describe("diffPlan", () => {
  it("names each field that would change, old to new, and nothing else", () => {
    expect(diffPlan(FREE, { display_name: "Free", is_public: true, limits: FREE.limits })).toEqual([]);
    const changes = diffPlan(FREE, {
      display_name: "Starter",
      is_public: false,
      limits: {
        ...FREE.limits,
        max_conversations: null,
        included_tokens: 2_000_000,
        overage_enabled: true,
        allowed_models: ["grt-nano-pro"],
        features: { ...FREE.limits.features, custom_instructions: true },
      },
    });
    expect(changes).toEqual([
      { field: "Display name", from: "Free", to: "Starter" },
      { field: "Listed", from: "on", to: "off" },
      { field: "Included tokens", from: "1000000", to: "2000000" },
      { field: "Overage", from: "off", to: "on" },
      { field: "Conversations", from: "25", to: "unlimited" },
      { field: "Allowed models", from: "house model only", to: "grt-nano-pro" },
      { field: "Feature custom_instructions", from: "off", to: "on" },
    ]);
  });
});

describe("the free trial in the plan editor", () => {
  it("diffs the trial as days, and says none for 0", () => {
    expect(diffPlan(PRO, { display_name: PRO.display_name, is_public: PRO.is_public, limits: PRO.limits, trial_days: 14 })).toEqual([
      { field: "Free trial", from: "none", to: "14 days" },
    ]);
    expect(
      diffPlan({ ...PRO, trial_days: 14 }, { display_name: PRO.display_name, is_public: PRO.is_public, limits: PRO.limits, trial_days: 0 }),
    ).toEqual([{ field: "Free trial", from: "14 days", to: "none" }]);
  });

  it("sends trial_days with the plan, and refuses a length past Stripe's ceiling", async () => {
    const calls = stubOperatorApi(({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro" ? { status: 200, body: { ...PRO, trial_days: 14 } } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const pro = form("Pro plan");
    const trial = labelled(pro, "Free trial");
    expect(trial.value).toBe("0");

    setInputValue(trial, "731");
    expect(pro.querySelector("[role='alert']")?.textContent).toContain("free trial is a whole number of days up to 730");
    expect(buttonNamed(pro, "Save Pro").disabled).toBe(true);

    setInputValue(trial, "14");
    expect(pro.querySelector("[aria-label='Changes to Pro']")!.textContent).toContain("Free trial: none → 14 days");
    submit(pro);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/admin/plans/pro");
    expect((put?.body as { trial_days: number }).trial_days).toBe(14);
  });
});

describe("the plans tab", () => {
  it("previews the diff before saving, and sends exactly the shape with prices left out", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "PUT" && url === "/api/admin/plans/free") {
        return { status: 200, body: { ...FREE, limits: { ...FREE.limits, max_conversations: 10 } } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const free = form("Free plan");
    expect(free.textContent).toContain("Nothing changed.");
    const save = buttonNamed(free, "Save Free");
    expect(save.disabled).toBe(true);

    setInputValue(labelled(free, "Conversations"), "10");
    const changes = free.querySelector("[aria-label='Changes to Free']")!;
    expect(changes.textContent).toContain("Conversations: 25 → 10");
    expect(save.disabled).toBe(false);

    submit(free);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/admin/plans/free");
    expect(put?.body).toEqual({
      display_name: "Free",
      is_public: true,
      limits: { ...FREE.limits, max_conversations: 10 },
      trial_days: 0,
      force: false,
    });
    expect(free.querySelector("[role='status']")?.textContent).toBe("Free saved: 1 change.");
    expect(calls.filter((c) => c.url === "/api/admin/plans").length).toBe(2);
  });

  it("edits the allowance and overage, and sends exactly the API's limits keys", async () => {
    const calls = stubOperatorApi(({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/free" ? { status: 200, body: FREE } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const free = form("Free plan");
    const included = labelled(free, "Included tokens");
    expect(included.value).toBe("1000000");
    setInputValue(included, "1500000");
    click(labelled(free, "Overage past the allowance"));
    const changes = free.querySelector("[aria-label='Changes to Free']")!;
    expect(changes.textContent).toContain("Included tokens: 1000000 → 1500000");
    expect(changes.textContent).toContain("Overage: off → on");

    // Blank is not "unlimited" for the allowance: the API requires a number.
    setInputValue(included, "");
    expect(free.querySelector("[role='alert']")?.textContent).toContain("Included tokens is a whole number");
    expect(buttonNamed(free, "Save Free").disabled).toBe(true);
    setInputValue(included, "1500000");

    submit(free);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    const limits = (put?.body as { limits: Record<string, unknown> }).limits;
    expect(Object.keys(limits).sort()).toEqual(
      [
        "allowed_models",
        "budget_duration",
        "features",
        "included_tokens",
        "included_tokens_per_seat",
        "max_conversations",
        "max_parallel_requests",
        "max_seats",
        "overage_enabled",
        "rpm_limit",
        "tpm_limit",
      ].sort(),
    );
    expect(limits.included_tokens).toBe(1_500_000);
    expect(limits.overage_enabled).toBe(true);
  });

  it("sells a plan per seat by giving it tokens per seat, and flat again by clearing them", async () => {
    const calls = stubOperatorApi(({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro" ? { status: 200, body: PRO } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const pro = form("Pro plan");
    const perSeat = labelled(pro, "Tokens per seat");
    expect(perSeat.value).toBe("");
    setInputValue(perSeat, "30000000");
    const changes = pro.querySelector("[aria-label='Changes to Pro']")!;
    expect(changes.textContent).toContain("Tokens per seat: not sold per seat → 30000000");
    setInputValue(perSeat, "3e7");
    expect(pro.querySelector("[role='alert']")?.textContent).toContain("tokens per seat is a whole number");
    setInputValue(perSeat, "30000000");
    submit(pro);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { limits: Record<string, unknown> }).limits.included_tokens_per_seat).toBe(30_000_000);

    setInputValue(perSeat, "");
    expect(changes.textContent).not.toContain("Tokens per seat");
  });

  it("names the orgs a cap would strand and saves again only with force", async () => {
    const stranded = [
      { org_id: ORGS[0].id, org_name: "Acme", conversations: 40, seats: 3, over: ["max_conversations"] },
    ];
    const calls = stubOperatorApi(({ method, url, body }) => {
      if (method === "PUT" && url === "/api/admin/plans/free") {
        const forced = (body as { force: boolean }).force;
        return forced
          ? { status: 200, body: FREE }
          : { status: 409, body: { detail: { message: "over a limit", orgs: stranded } } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const free = form("Free plan");
    setInputValue(labelled(free, "Conversations"), "10");
    submit(free);
    await flush();

    const alert = free.querySelector("[role='alert']")!;
    expect(alert.textContent).toContain("1 organisation over a limit");
    expect(alert.textContent).toContain("Acme: 40 conversations, 3 seats (over max_conversations)");
    const again = buttonNamed(free, "Save Free anyway");
    expect(again.disabled).toBe(false);
    submit(free);
    await flush();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => (c.body as { force: boolean }).force)).toEqual([false, true]);
    expect(free.querySelector("[role='status']")?.textContent).toBe("Free saved: 1 change.");
  });

  it("refuses to send a count that is not a whole number", async () => {
    const calls = stubOperatorApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const free = form("Free plan");
    setInputValue(labelled(free, "Seats"), "1.5");
    expect(free.querySelector("[role='alert']")?.textContent).toContain("whole number");
    expect(buttonNamed(free, "Save Free").disabled).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows prices as Stripe's and marks an unlisted plan", async () => {
    stubOperatorApi(({ method, url }) =>
      method === "GET" && url === "/api/admin/plans"
        ? { status: 200, body: { data: [FREE, { ...PRO, is_public: false }] } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const pro = form("Pro plan");
    expect(pro.textContent).toContain("$20.00/month, $200.00/year");
    expect(pro.textContent).toContain("default overage cap $20.00");
    expect(pro.textContent).toContain("prices are Stripe's");
    expect(pro.textContent).toContain("unlisted");
    expect(pro.querySelector("input[value='price_m']")).toBeNull();
  });
});

// --- feature flags --------------------------------------------------------------

describe("the flags tab", () => {
  it("lists defaults and rows with which layer decided, and adds a per-org override", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "PUT" && url === "/api/admin/flags/agents_ui") {
        return { status: 200, body: { ...AGENTS_UI, defined: true, rollout: { orgs: [ORGS[0].id], percent: 0 } } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Flags"));
    await flush();
    const agents = form("Flag agents_ui");
    expect(agents.textContent).toContain("default");
    expect(agents.textContent).toContain("environment default: off");
    expect(agents.textContent).toContain("no organisation in particular");
    const registry = form("Flag app_registry");
    expect(registry.textContent).toContain("row");
    expect(registry.textContent).toContain("environment default: on");
    expect(registry.querySelector("[aria-label='Organisations with app_registry']")?.textContent).toContain("Bolt");
    expect(registry.textContent).toContain("by ops");

    const save = buttonNamed(agents, "Save agents_ui");
    expect(save.disabled).toBe(true);
    await chooseOption(combobox(agents), ORGS[0].name);
    click(buttonNamed(agents, "Add to agents_ui"));
    expect(agents.querySelector("[aria-label='Organisations with agents_ui']")?.textContent).toContain("Acme");
    expect(save.disabled).toBe(false);
    submit(agents);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/admin/flags/agents_ui");
    expect(put?.body).toEqual({
      enabled: false,
      description: "",
      rollout: { orgs: [ORGS[0].id], percent: 0 },
    });
    expect(agents.querySelector("[role='status']")?.textContent).toBe("agents_ui saved.");
    expect(calls.filter((c) => c.url === "/api/admin/flags").length).toBe(2);
  });

  it("resets a row to its default, and only a row has the button", async () => {
    const calls = stubOperatorApi(({ method, url }) =>
      method === "DELETE" && url === "/api/admin/flags/app_registry"
        ? { status: 200, body: { key: "app_registry", default: true, defined: false } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Flags"));
    await flush();
    expect(() => buttonNamed(form("Flag agents_ui"), "Reset agents_ui to default")).toThrow();
    click(buttonNamed(form("Flag app_registry"), "Reset app_registry to default"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/admin/flags/app_registry")).toBe(true);
  });

  it("defines a new flag by key and shows the API's refusal", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      if (method === "PUT" && url === "/api/admin/flags/new_sidebar") {
        return { status: 422, body: { detail: "A flag key is snake_case." } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Flags"));
    await flush();
    const create = form("New flag");
    const define = buttonNamed(create, "Define flag");
    setInputValue(labelled(create, "New flag key"), "Bad Key");
    expect(define.disabled).toBe(true);
    setInputValue(labelled(create, "New flag key"), "agents_ui");
    expect(define.disabled).toBe(true);
    setInputValue(labelled(create, "New flag key"), "new_sidebar");
    expect(define.disabled).toBe(false);
    submit(create);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ enabled: false, description: "", rollout: { orgs: [], percent: 0 } });
    expect(create.querySelector("[role='alert']")?.textContent).toBe("A flag key is snake_case.");
  });
});

// --- retention --------------------------------------------------------------------

describe("the retention tab", () => {
  it("shows what the next run would do, per organisation", async () => {
    stubOperatorApi();
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Retention"));
    await flush();
    const text = mounted.container.textContent!;
    expect(text).toContain("soft-delete 4 conversations across 1 organisation");
    expect(text).toContain("permanently delete 2 soft-deleted conversations older than 30 days");
    const table = mounted.container.querySelector("table[aria-label='Retention by organisation']")!;
    expect(table.textContent).toContain("Acme");
    expect(table.textContent).toContain("30 days");
    expect([...table.querySelectorAll("tbody td")].at(-1)?.textContent).toBe("4");
  });

  it("says when no organisation has a window", async () => {
    stubOperatorApi(({ method, url }) =>
      method === "GET" && url === "/api/admin/retention/preview"
        ? { status: 200, body: { ...PREVIEW, orgs: [], soft_delete_count: 0 } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Retention"));
    await flush();
    expect(mounted.container.textContent).toContain("No organisation has a retention window");
  });
});

describe("an organisation's retention window", () => {
  it("loads as keep, saves a number of days, and clears back to keep", async () => {
    const calls = stubOperatorApi(({ method, url, body }) => {
      if (method === "PUT" && url === `/api/admin/orgs/${ORGS[0].id}/retention`) {
        return { status: 200, body: { org_id: ORGS[0].id, ...(body as object) } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const details = mounted.container.querySelector("[aria-label='Acme details']")!;
    const input = details.querySelector<HTMLInputElement>("input[placeholder='keep']")!;
    expect(input.value).toBe("");
    const save = buttonNamed(details, "Save retention for Acme");
    expect(save.disabled).toBe(true);

    setInputValue(input, "0");
    expect(details.textContent).toContain("Between 1 and 3650 days");
    expect(save.disabled).toBe(true);

    setInputValue(input, "30");
    expect(save.disabled).toBe(false);
    submit(save.form!);
    await flush();
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/retention"));
    expect(put?.body).toEqual({ retention_days: 30 });
    expect(details.textContent).toContain("untouched for 30 days are deleted nightly");
  });
});

// --- support mode -----------------------------------------------------------------

/** Type the reason into the support dialog and open the session. */
function confirmSupport(reason: string): void {
  const dialog = document.querySelector("[data-slot='dialog-content']")!;
  setInputValue(dialog.querySelector<HTMLInputElement>("input[aria-label='Reason']")!, reason);
  click(buttonNamed(dialog, "Open as support"));
}

describe("opening an organisation as support", () => {
  it("starts the session and reloads the shell into it", async () => {
    const calls = stubOperatorApi(({ method, url }) =>
      method === "POST" && url === `/api/admin/support/${ORGS[0].id}` ? { status: 201, body: SESSION } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Open Acme as support"));
    await flush();
    confirmSupport("customer asked");
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url === `/api/admin/support/${ORGS[0].id}`)).toBe(true);
    expect(assign).toHaveBeenCalledWith("/apps/chat");
  });

  it("shows the refusal and stays put", async () => {
    stubOperatorApi(({ method }) =>
      method === "POST" ? { status: 404, body: { detail: "No such organization." } } : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Open Bolt as support"));
    await flush();
    confirmSupport("customer asked");
    await flush();
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toBe("No such organization.");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the support banner", () => {
  it("names the org, says read only, and exits through the API and a reload", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/admin/support") return { status: 200, body: SESSION };
      if (method === "DELETE" && url === "/api/admin/support") return { status: 200, body: { active: false } };
      return undefined;
    });
    mounted = await mount(<SupportBanner />, principalWith(["admin"]));
    const banner = mounted.container.querySelector("[data-support-banner]")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("Viewing Acme as support — read only");
    click(buttonNamed(banner, "Exit support"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/admin/support")).toBe(true);
    expect(assign).toHaveBeenCalledWith("/admin");
  });

  it("is absent with no session, and never asks for a member", async () => {
    const calls = stubApi(({ method, url }) =>
      method === "GET" && url === "/api/admin/support" ? { status: 200, body: { active: false } } : undefined,
    );
    mounted = await mount(<SupportBanner />, principalWith(["admin"]));
    expect(mounted.container.querySelector("[data-support-banner]")).toBeNull();
    mounted.unmount();
    mounted = await mount(<SupportBanner />, principalWith(["user"]));
    expect(mounted.container.querySelector("[data-support-banner]")).toBeNull();
    expect(calls.length).toBe(1);
  });

  it("treats anything but an active session as none, so an older API shows nothing", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/admin/support" ? { status: 200, body: { data: [] } } : undefined,
    );
    mounted = await mount(<SupportBanner />, principalWith(["admin"]));
    expect(mounted.container.querySelector("[data-support-banner]")).toBeNull();
  });
});

describe("the plans tab's model list", () => {
  function planModel(scope: ParentNode, id: string): HTMLLabelElement {
    const found = scope.querySelector<HTMLLabelElement>(`[data-plan-model='${id}']`);
    if (!found) throw new Error(`no checkbox for ${id}`);
    return found;
  }

  async function plansTab(plans: AdminPlan[], extra: Parameters<typeof stubApi>[0] = () => undefined) {
    const calls = stubOperatorApi((call) => {
      const answered = extra(call);
      if (answered) return answered;
      return call.method === "GET" && call.url === "/api/admin/plans"
        ? { status: 200, body: { data: plans, models: PRICED } }
        : undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    return calls;
  }

  it("offers the price list as a checklist, by label, with partner models tagged", async () => {
    await plansTab([PRO_PLUS]);
    const plus = form("Pro Plus plan");
    expect(labelled(plus, "Every GRT model").checked).toBe(false);
    expect([...plus.querySelectorAll("[data-plan-model]")].map((l) => l.getAttribute("data-plan-model"))).toEqual([
      "grt-nano",
      "grt-nano-pro",
      "grt-nano-max",
      "glm-4.6",
    ]);
    expect(planModel(plus, "grt-nano-pro").textContent).toContain("GRT Nano Pro");
    expect(planModel(plus, "grt-nano-pro").querySelector("input")!.checked).toBe(true);
    expect(planModel(plus, "grt-nano").querySelector("input")!.checked).toBe(false);
    expect(planModel(plus, "glm-4.6").textContent).toContain("partner");
    expect(planModel(plus, "grt-nano-max").textContent).not.toContain("partner");
    // Every model input is a checkbox: there is no free text to type an id into.
    const fieldset = planModel(plus, "grt-nano").closest("fieldset")!;
    expect([...fieldset.querySelectorAll("input")].every((i) => i.type === "checkbox")).toBe(true);
  });

  it("ticks a partner model onto a seeded list and sends the ids", async () => {
    const calls = await plansTab([PRO_PLUS], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro_plus" ? { status: 200, body: PRO_PLUS } : undefined,
    );
    const plus = form("Pro Plus plan");
    click(planModel(plus, "glm-4.6").querySelector("input")!);
    click(planModel(plus, "grt-nano-pro").querySelector("input")!);
    const changes = plus.querySelector("[aria-label='Changes to Pro Plus']")!;
    expect(changes.textContent).toContain("Allowed models: grt-nano-pro, grt-nano-max → grt-nano-max, glm-4.6");
    submit(plus);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { limits: { allowed_models: string[] } }).limits.allowed_models).toEqual([
      "grt-nano-max",
      "glm-4.6",
    ]);
  });

  it("marks an id the row holds that the price list does not, and unticking it clears it", async () => {
    const stale: AdminPlan = { ...PRO, limits: { ...PRO.limits, allowed_models: ["grt-nano-pro", "retired-model"] } };
    await plansTab([stale]);
    const pro = form("Pro plan");
    const retired = planModel(pro, "retired-model");
    expect(retired.textContent).toContain("not on the price list");
    expect(retired.querySelector("input")!.checked).toBe(true);
    click(retired.querySelector("input")!);
    expect(pro.querySelector("[data-plan-model='retired-model']")).toBeNull();
    expect(pro.querySelector("[aria-label='Changes to Pro']")!.textContent).toContain(
      "Allowed models: grt-nano-pro, retired-model → grt-nano-pro",
    );
  });

  it("shows the API's refusal of an unpriced model as it worded it", async () => {
    const stale: AdminPlan = { ...PRO, limits: { ...PRO.limits, allowed_models: ["grt-nano-pro", "retired-model"] } };
    const detail =
      "allowed_models names a model with no price: retired-model. The priced models are: grt-nano, grt-nano-pro";
    await plansTab([stale], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro" ? { status: 422, body: { detail } } : undefined,
    );
    const pro = form("Pro plan");
    setInputValue(labelled(pro, "Conversations"), "10");
    submit(pro);
    await flush();
    expect(pro.querySelector("[role='alert']")?.textContent).toContain(detail);
  });

  it("shows the house model locked on, never as a box to tick", async () => {
    stubOperatorApi(({ method, url }) =>
      method === "GET" && url === "/api/admin/plans"
        ? { status: 200, body: { data: [PRO_PLUS], models: PRICED, house_model: "grt-nano" } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    const plus = form("Pro Plus plan");
    const house = planModel(plus, "grt-nano");
    const box = house.querySelector("input")!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(house.textContent).toContain("house model, on every plan");
    click(box);
    expect(plus.querySelector("[aria-label='Changes to Pro Plus']")!.textContent).toContain("Nothing changed.");
    // The others are still the plan's own list.
    expect(planModel(plus, "grt-nano-pro").querySelector("input")!.disabled).toBe(false);
  });

  it("names what a null list means: every GRT model, partner models only when listed", async () => {
    const calls = await plansTab([PRO_PLUS], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro_plus" ? { status: 200, body: PRO_PLUS } : undefined,
    );
    const plus = form("Pro Plus plan");
    click(labelled(plus, "Every GRT model"));
    // The checklist goes: null names nothing.
    expect(plus.querySelector("[data-plan-model]")).toBeNull();
    const changes = plus.querySelector("[aria-label='Changes to Pro Plus']")!;
    expect(changes.textContent).toContain(
      "Allowed models: grt-nano-pro, grt-nano-max → every GRT model; partner models only when listed",
    );
    expect(changes.textContent).not.toContain("unlimited");
    submit(plus);
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { limits: { allowed_models: string[] | null } }).limits.allowed_models).toBeNull();
  });
});

// --- plan features ------------------------------------------------------------------

/** The feature list `GET /api/admin/plans` sends beside the plans. */
const FEATURE_INFO = [
  { name: "api_keys", label: "API keys", description: "Creating API keys." },
  { name: "custom_instructions", label: "Custom instructions", description: "Saving custom instructions." },
  { name: "org_sso", label: "Single sign-on", description: "Lists single sign-on on /pricing." },
];

describe("the plans tab's feature switches", () => {
  function featureSwitch(scope: ParentNode, name: string): HTMLInputElement {
    const row = scope.querySelector(`[data-plan-feature='${name}']`);
    const input = row?.querySelector<HTMLInputElement>("input[role='switch']");
    if (!input) throw new Error(`no switch for ${name}`);
    return input;
  }

  async function plansTab(plans: AdminPlan[], extra: Parameters<typeof stubApi>[0] = () => undefined) {
    const calls = stubOperatorApi((call) => {
      const answered = extra(call);
      if (answered) return answered;
      return call.method === "GET" && call.url === "/api/admin/plans"
        ? { status: 200, body: { data: plans, models: PRICED, features: FEATURE_INFO } }
        : undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(tab("Plans"));
    await flush();
    return calls;
  }

  it("labels each switch, says what it gates and shows the row's value", async () => {
    await plansTab([{ ...FREE, org_count: 3 }]);
    const section = mounted!.container.querySelector("[aria-label='Free features']")!;
    const keys = featureSwitch(section, "api_keys");
    expect(keys.checked).toBe(true);
    expect(keys.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(`label[for='${keys.id}']`)?.textContent).toBe("API keys");
    expect(featureSwitch(section, "custom_instructions").checked).toBe(false);
    expect(section.textContent).toContain("Saving custom instructions.");
    expect(section.textContent).toContain("3 organisations on this plan");
  });

  it("sits outside the Save form, as its own section that saves as it switches", async () => {
    await plansTab([{ ...FREE, org_count: 3 }]);
    const free = form("Free plan");
    expect(free.querySelector("[aria-label='Free features']")).toBeNull();
    const section = mounted!.container.querySelector("[aria-label='Free features']")!;
    expect(section.closest("form")).toBeNull();
    expect(section.textContent).toContain("Saved as you switch");
    // The form's Changes list is for the form alone.
    expect(free.textContent).toContain("Nothing changed.");
  });

  it("turns a feature on at once, with only that feature sent", async () => {
    const calls = await plansTab([{ ...FREE, org_count: 3 }], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/free/features" ? { status: 200, body: {} } : undefined,
    );
    click(featureSwitch(mounted!.container, "custom_instructions"));
    await flush();
    expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/admin/plans/free/features");
    expect(put?.body).toEqual({ features: { custom_instructions: true } });
    expect(mounted!.container.textContent).toContain("Custom instructions is on for Free.");
    expect(calls.filter((c) => c.url === "/api/admin/plans").length).toBe(2);
  });

  it("asks before turning a feature off on a plan with orgs on it, naming how many", async () => {
    const calls = await plansTab([{ ...FREE, org_count: 3 }], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/free/features" ? { status: 200, body: {} } : undefined,
    );
    click(featureSwitch(mounted!.container, "api_keys"));
    await flush();
    let dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Turn off API keys for Free?");
    expect(dialog.textContent).toContain("The 3 organisations on Free lose it");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    click(buttonNamed(dialog, "Cancel"));
    await flush();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    click(featureSwitch(mounted!.container, "api_keys"));
    await flush();
    dialog = document.querySelector("[data-slot='dialog-content']")!;
    click(buttonNamed(dialog, "Turn off"));
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ features: { api_keys: false } });
  });

  it("turns a feature off without asking on a plan nobody is on", async () => {
    const calls = await plansTab([{ ...PRO, org_count: 0 }], ({ method, url }) =>
      method === "PUT" && url === "/api/admin/plans/pro/features" ? { status: 200, body: {} } : undefined,
    );
    click(featureSwitch(mounted!.container, "api_keys"));
    await flush();
    expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ features: { api_keys: false } });
  });

  it("shows a refused switch's reason", async () => {
    await plansTab([{ ...PRO, org_count: 0 }], ({ method }) =>
      method === "PUT" ? { status: 422, body: { detail: "unknown features: x" } } : undefined,
    );
    click(featureSwitch(mounted!.container, "org_sso"));
    await flush();
    const section = mounted!.container.querySelector("[aria-label='Pro features']")!;
    expect(section.querySelector("[role='alert']")?.textContent).toBe("unknown features: x");
  });
});

describe("an organisation's feature overrides", () => {
  const ORG_FEATURES = {
    plan_code: "free",
    plan_name: "Free",
    features: [
      { ...FEATURE_INFO[0], plan: true, override: null, effective: true },
      { ...FEATURE_INFO[1], plan: false, override: true, effective: true },
      { ...FEATURE_INFO[2], plan: false, override: null, effective: false },
    ],
  };

  function overrideSelect(scope: ParentNode, label: string): HTMLElement {
    return combobox(scope, `${label} override for Acme`);
  }

  it("shows plan, override and effective value, and saves on/off/inherit", async () => {
    const calls = stubOperatorApi(({ method, url, body }) => {
      const base = `/api/admin/orgs/${ORGS[0].id}/features`;
      if (method === "GET" && url === base) return { status: 200, body: ORG_FEATURES };
      if (method === "PUT" && url === `${base}/api_keys`) {
        const override = (body as { override: boolean | null }).override;
        return {
          status: 200,
          body: {
            ...ORG_FEATURES,
            features: [
              { ...ORG_FEATURES.features[0], override, effective: override ?? true },
              ...ORG_FEATURES.features.slice(1),
            ],
          },
        };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const details = mounted.container.querySelector("[aria-label='Acme details']")!;
    const table = details.querySelector("table[aria-label='Acme features']")!;
    expect(details.textContent).toContain("On the Free plan.");
    const row = (name: string) => table.querySelector(`[data-org-feature='${name}']`)!;
    expect(row("custom_instructions").textContent).toContain("Saving custom instructions.");
    expect(selectedValue(overrideSelect(table, "Custom instructions"))).toBe("on");
    expect(selectedValue(overrideSelect(table, "API keys"))).toBe("inherit");
    expect(row("org_sso").querySelectorAll("td")[3].textContent).toBe("off");

    await chooseOption(overrideSelect(table, "API keys"), "Off");
    await flush();
    let put = calls.filter((c) => c.method === "PUT");
    expect(put.at(-1)?.url).toBe(`/api/admin/orgs/${ORGS[0].id}/features/api_keys`);
    expect(put.at(-1)?.body).toEqual({ override: false });
    expect(selectedValue(overrideSelect(details, "API keys"))).toBe("off");
    expect(row("api_keys").querySelectorAll("td")[3].textContent).toBe("off");
    expect(details.textContent).toContain("API keys is off for Acme, whatever the plan says.");

    await chooseOption(overrideSelect(details, "API keys"), "Inherit (on)");
    await flush();
    put = calls.filter((c) => c.method === "PUT");
    expect(put.at(-1)?.body).toEqual({ override: null });
    expect(details.textContent).toContain("API keys follows the plan again: on.");
  });
});

// --- one organisation's plan and keys --------------------------------------------

describe("an organisation's plan", () => {
  const ON_PRO = {
    org_id: ORGS[0].id,
    plan: "pro",
    plan_name: "Pro",
    status: "past_due",
    implicit: false,
    current_period_end: "2026-11-01T00:00:00+00:00",
    cancel_at_period_end: false,
    trial_end: null,
  };

  it("heads the details with the plan and status, and moves it through the operator route", async () => {
    const calls = stubOperatorApi(({ method, url }) => {
      const path = `/api/admin/orgs/${ORGS[0].id}/plan`;
      if (method === "GET" && url === path) return { status: 200, body: ON_PRO };
      if (method === "PUT" && url === path) {
        return { status: 200, body: { ...ON_PRO, plan: "free", plan_name: "Free", status: "active" } };
      }
      return undefined;
    });
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const header = mounted.container.querySelector("[aria-label='Acme plan']")!;
    expect(header.textContent).toContain("Pro");
    expect(header.textContent).toContain("past due");

    const select = combobox(header, "Plan for Acme");
    expect(await optionLabels(select)).toEqual(["Free", "Pro"]);
    expect(selectedValue(select)).toBe("pro");
    expect(buttonNamed(header, "Set Acme's plan").disabled).toBe(true);
    await chooseOption(select, "Free");
    setInputValue(header.querySelector<HTMLInputElement>("input[aria-label='Reason for the plan change']")!, "comp");
    click(buttonNamed(header, "Set Acme's plan"));
    await flush();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Put Acme on Free?");
    click(buttonNamed(dialog, "Set plan"));
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(`/api/admin/orgs/${ORGS[0].id}/plan`);
    expect(put?.body).toEqual({ plan: "free", reason: "comp" });
    expect(header.textContent).toContain("Acme is on Free.");
  });

  it("says on Free by default when the org has no subscription", async () => {
    stubOperatorApi(({ method, url }) =>
      method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/plan`
        ? { status: 200, body: { ...ON_PRO, plan: "free", plan_name: "Free", status: "active", implicit: true } }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const header = mounted.container.querySelector("[aria-label='Acme plan']")!;
    expect(header.textContent).toContain("no subscription");
  });
});

describe("an organisation's API keys", () => {
  it("marks an expired key Expired and offers no Revoke for it", async () => {
    const base = {
      prefix: "mw_live_ab",
      scopes: ["chat"],
      created_at: "2026-01-01T00:00:00+00:00",
      revoked_at: null,
      last_used_at: null,
    };
    stubOperatorApi(({ method, url }) =>
      method === "GET" && url === `/api/admin/orgs/${ORGS[0].id}/keys`
        ? {
            status: 200,
            body: {
              data: [
                { ...base, id: "k-old", name: "old", expires_at: "2026-02-01T00:00:00+00:00" },
                { ...base, id: "k-live", name: "live", expires_at: "2999-01-01T00:00:00+00:00" },
              ],
            },
          }
        : undefined,
    );
    mounted = await mount(<AdminPage />, principalWith(["admin"]));
    click(buttonNamed(mounted.container, "Manage Acme"));
    await flush();
    const table = mounted.container.querySelector("table[aria-label='Acme API keys']")!;
    const rows = [...table.querySelectorAll(":scope > tbody > tr")];
    expect(rows[0].textContent).toContain("Expired");
    expect([...rows[0].querySelectorAll("button")]).toEqual([]);
    expect(rows[1].textContent).not.toContain("Expired");
    expect(buttonNamed(rows[1], "Revoke live")).toBeDefined();
  });
});
