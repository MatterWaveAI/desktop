import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebhooksPane,
  type RevealedSecret,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./WebhooksPane";
import {
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  principalWith,
  selectNamed,
  selectShown,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * Webhooks as an admin sees them: a member is told the pane is for admins
 * and nothing is fetched; the list never carries a secret; creating one
 * shows the secret and the verification snippet once; the test button
 * reports the receiver's answer beside itself; the delivery log filters
 * and redelivers with the calls the routes expect.
 */

const EVENTS = [
  "api_key.revoked",
  "budget.exhausted",
  "budget.warn",
  "conversation.created",
  "member.joined",
  "member.removed",
  "message.completed",
  "plan.changed",
];

const ENDPOINT: WebhookEndpoint = {
  id: "11111111-1111-7111-8111-111111111111",
  url: "https://hooks.example.com/matterwave",
  description: "Ops channel",
  events: ["budget.warn", "member.joined"],
  enabled: true,
  failure_count: 0,
  created_at: "2026-10-01T10:00:00+00:00",
  updated_at: "2026-10-01T10:00:00+00:00",
  disabled_at: null,
};

const DISABLED: WebhookEndpoint = {
  ...ENDPOINT,
  id: "22222222-2222-7222-8222-222222222222",
  url: "https://old.example.com/hook",
  description: "",
  events: ["plan.changed"],
  enabled: false,
  failure_count: 5,
  disabled_at: "2026-10-02T10:00:00+00:00",
};

const SECRET = "whsec_THE-ONE-TIME-SIGNING-SECRET";

const REVEALED: RevealedSecret = {
  ...ENDPOINT,
  secret: SECRET,
  shown_once: true,
  verification: {
    python: `SECRET = "${SECRET}"\n# python`,
    node: `const SECRET = "${SECRET}";\n// node`,
  },
};

function delivery(overrides: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    id: "d-1",
    endpoint_id: ENDPOINT.id,
    event: "ping",
    event_id: "evt_1",
    payload: { id: "evt_1", type: "ping" },
    attempt: 1,
    status: "delivered",
    response_code: 200,
    response_ms: 42,
    response_excerpt: '{"ok":true}',
    next_attempt_at: null,
    delivered_at: "2026-10-03T10:00:00+00:00",
    last_error: null,
    created_at: "2026-10-03T10:00:00+00:00",
    ...overrides,
  };
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const listing = (endpoints: WebhookEndpoint[]) => ({ status: 200, body: { data: endpoints, events: EVENTS } });

describe("the webhooks pane", () => {
  it("tells a member it is for admins and fetches nothing", async () => {
    const calls = stubApi(() => undefined);
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "member"));
    expect(mounted.container.textContent).toContain("Webhooks are for admins");
    expect(calls).toHaveLength(0);
  });

  it("lists each endpoint's URL, events and state, never a secret", async () => {
    stubApi(({ method, url }) => (method === "GET" && url === "/api/org/webhooks" ? listing([ENDPOINT, DISABLED]) : undefined));
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "admin"));
    const list = mounted.container.querySelector("ul[aria-label='Webhook endpoints']")!;
    const items = [...list.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-endpoint-url")).toBe(ENDPOINT.url);
    expect(items[0].textContent).toContain("Ops channel");
    expect(items[0].textContent).toContain("budget.warn");
    expect(items[0].textContent).toContain("Enabled");
    expect(items[1].textContent).toContain("Disabled after 5 failures");
    expect(buttonNamed(items[1], "Enable")).toBeTruthy();
    expect(mounted.container.textContent).not.toContain("whsec_");
  });

  it("shows an empty state, and a neutral note with nothing to retry when the feature is off", async () => {
    stubApi(() => listing([]));
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    expect(mounted.container.textContent).toContain("No endpoints yet");
    mounted.unmount();

    stubApi(() => ({
      status: 503,
      body: { detail: "Outbound webhooks are not enabled on this deployment; set MW_WEBHOOK_SECRET_KEY." },
    }));
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    // Off on this deployment is not a failure the admin can fix from here:
    // no alert, no Retry, and no server configuration names.
    expect(mounted.container.textContent).toContain("Not available on this deployment");
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
    expect(mounted.container.textContent).not.toContain("MW_WEBHOOK_SECRET_KEY");
    expect([...mounted.container.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
    expect([...mounted.container.querySelectorAll("button")].some((b) => b.textContent === "Add endpoint…")).toBe(false);
  });

  it("still reports any other load failure as an error with Retry", async () => {
    stubApi(() => ({ status: 500, body: { detail: "Something broke." } }));
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain("Something broke.");
    expect([...mounted.container.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true);
  });

  it("creates an endpoint with the chosen events and shows the secret exactly once", async () => {
    let endpoints: WebhookEndpoint[] = [];
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/webhooks") return listing(endpoints);
      if (method === "POST" && url === "/api/org/webhooks") {
        endpoints = [ENDPOINT];
        return { status: 201, body: REVEALED };
      }
      return undefined;
    });
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    click(buttonNamed(mounted.container, "Add endpoint…"));
    await flush();
    const dialog = document.querySelector("[data-webhook-create-dialog]")!;
    expect(dialog).not.toBeNull();
    const add = buttonNamed(dialog, "Add endpoint");
    expect(add.disabled).toBe(true); // no URL, no events yet

    setInputValue(dialog.querySelector("input[name='url']") as HTMLInputElement, " https://hooks.example.com/matterwave ");
    setInputValue(dialog.querySelector("input[name='description']") as HTMLInputElement, "Ops channel");
    const boxes = [...dialog.querySelectorAll("input[name='events']")] as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(EVENTS);
    click(boxes[EVENTS.indexOf("member.joined")]);
    click(boxes[EVENTS.indexOf("budget.warn")]);
    expect(add.disabled).toBe(false);
    submit(dialog.querySelector("form")!);
    await flush();

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      url: "https://hooks.example.com/matterwave",
      events: ["budget.warn", "member.joined"], // the API's order, not the click order
      description: "Ops channel",
    });

    const shown = document.querySelector("[data-webhook-secret-dialog]")!;
    expect(shown).not.toBeNull();
    expect(shown.querySelector("[data-testid='webhook-secret']")!.textContent).toBe(SECRET);
    expect(shown.textContent).toContain("only time it is shown");
    expect(shown.querySelector("[data-testid='verification-snippet']")!.textContent).toContain("# python");
    click([...shown.querySelectorAll("[role='tab']")].find((t) => t.textContent === "Node")!);
    expect(shown.querySelector("[data-testid='verification-snippet']")!.textContent).toContain("// node");
    expect(shown.querySelector("[data-testid='verification-snippet']")!.textContent).toContain(SECRET);

    click(buttonNamed(shown, "Done"));
    await flush();
    expect(document.querySelector("[data-webhook-secret-dialog]")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    // The list reloaded and shows the endpoint without any secret.
    expect(mounted.container.querySelector("ul[aria-label='Webhook endpoints']")!.textContent).toContain(ENDPOINT.url);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("shows a bad URL under its field, from the 422 the API answers", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/webhooks") return listing([]);
      if (method === "POST" && url === "/api/org/webhooks") {
        return {
          status: 422,
          body: { detail: [{ loc: ["body", "url"], msg: "The URL resolves to a private address.", type: "value_error" }] },
        };
      }
      return undefined;
    });
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    click(buttonNamed(mounted.container, "Add endpoint…"));
    await flush();
    const dialog = document.querySelector("[data-webhook-create-dialog]")!;
    setInputValue(dialog.querySelector("input[name='url']") as HTMLInputElement, "https://10.0.0.1/");
    click(dialog.querySelector("input[name='events']") as HTMLInputElement);
    submit(dialog.querySelector("form")!);
    await flush();
    expect(dialog.querySelector("[role='alert']")!.textContent).toBe("The URL resolves to a private address.");
    expect(document.querySelector("[data-webhook-secret-dialog]")).toBeNull();
  });

  it("sends a test event and reports the receiver's answer beside the button", async () => {
    let outcome = delivery({});
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/webhooks") return listing([ENDPOINT]);
      if (method === "POST" && url === `/api/org/webhooks/${ENDPOINT.id}/test`) return { status: 200, body: outcome };
      return undefined;
    });
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "admin"));
    const row = mounted.container.querySelector("li[data-endpoint-url]")!;
    click(buttonNamed(row, "Send test"));
    await flush();
    const ok = row.querySelector("[data-test-result='delivered']")!;
    expect(ok.textContent).toContain("accepted the test event");
    expect(ok.textContent).toContain("HTTP 200");
    expect(ok.textContent).toContain("42 ms");
    expect(ok.textContent).toContain('{"ok":true}');
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

    outcome = delivery({
      status: "failed",
      response_code: 500,
      response_ms: 7,
      response_excerpt: "receiver exploded",
      last_error: "The endpoint answered HTTP 500.",
    });
    click(buttonNamed(row, "Send test"));
    await flush();
    const failed = row.querySelector("[data-test-result='failed']")!;
    expect(failed.textContent).toContain("was not accepted");
    expect(failed.textContent).toContain("HTTP 500");
    expect(failed.textContent).toContain("receiver exploded");
    expect(row.querySelector("[data-test-result='delivered']")).toBeNull();
  });

  it("opens the delivery log, filters by status and redelivers one row", async () => {
    const rows = [
      delivery({ id: "d-2", event: "member.joined", status: "failed", response_code: 503, response_ms: 9, last_error: "The endpoint answered HTTP 503.", response_excerpt: "down" }),
      delivery({ id: "d-1" }),
    ];
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/webhooks") return listing([ENDPOINT]);
      if (method === "GET" && url === `/api/org/webhooks/${ENDPOINT.id}/deliveries`) return { status: 200, body: { data: rows, status: null } };
      if (method === "GET" && url === `/api/org/webhooks/${ENDPOINT.id}/deliveries?status=failed`) {
        return { status: 200, body: { data: rows.filter((r) => r.status === "failed"), status: "failed" } };
      }
      if (method === "POST" && url === `/api/org/webhooks/${ENDPOINT.id}/deliveries/d-2/redeliver`) {
        rows.unshift(delivery({ id: "d-3", event: "member.joined", event_id: rows[0].event_id }));
        return { status: 202, body: rows[0] };
      }
      return undefined;
    });
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    const row = mounted.container.querySelector("li[data-endpoint-url]")!;
    click(buttonNamed(row, "Deliveries"));
    await flush();
    const table = row.querySelector("table")!;
    expect(table.getAttribute("aria-label")).toBe(`Deliveries for ${ENDPOINT.url}`);
    const bodyRows = () => [...row.querySelectorAll("tbody tr")];
    expect(bodyRows().map((r) => r.getAttribute("data-delivery-id"))).toEqual(["d-2", "d-1"]);
    expect(bodyRows()[0].textContent).toContain("member.joined");
    expect(bodyRows()[0].textContent).toContain("failed");
    expect(bodyRows()[0].textContent).toContain("503");
    expect(bodyRows()[0].textContent).toContain("9 ms");
    expect(bodyRows()[0].textContent).toContain("The endpoint answered HTTP 503.");

    const show = selectNamed(row, "Show")!;
    expect(selectShown(show)).toBe("All deliveries");
    await chooseOption(show, "Failed");
    expect(calls.some((c) => c.url.endsWith("/deliveries?status=failed"))).toBe(true);
    expect(bodyRows().map((r) => r.getAttribute("data-delivery-id"))).toEqual(["d-2"]);

    click(buttonNamed(bodyRows()[0], "Redeliver"));
    await flush();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `/api/org/webhooks/${ENDPOINT.id}/deliveries/d-2/redeliver`,
    ]);
    // The log re-read itself after the redelivery, under the same filter.
    expect(calls.filter((c) => c.url.endsWith("/deliveries?status=failed"))).toHaveLength(2);
  });

  it("rotates behind a confirmation and shows the new secret once; disables and deletes with their calls", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/webhooks") return listing([ENDPOINT]);
      if (method === "POST" && url === `/api/org/webhooks/${ENDPOINT.id}/rotate`) return { status: 200, body: { ...REVEALED, secret: "whsec_ROTATED" } };
      if (method === "PATCH" && url === `/api/org/webhooks/${ENDPOINT.id}`) return { status: 200, body: { ...ENDPOINT, enabled: false } };
      if (method === "DELETE" && url === `/api/org/webhooks/${ENDPOINT.id}`) return { status: 204, body: null };
      return undefined;
    });
    mounted = await mount(<WebhooksPane />, principalWith(["user"], "owner"));
    const row = () => mounted!.container.querySelector("li[data-endpoint-url]")!;

    click(buttonNamed(row(), "Rotate secret…"));
    await flush();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // the confirm is the gate
    click(buttonNamed(document.querySelector("[data-slot='dialog-content']")!, "Rotate secret"));
    await flush();
    const shown = document.querySelector("[data-webhook-secret-dialog]")!;
    expect(shown.querySelector("[data-testid='webhook-secret']")!.textContent).toBe("whsec_ROTATED");
    click(buttonNamed(shown, "Done"));
    await flush();
    expect(document.body.textContent).not.toContain("whsec_ROTATED");

    click(buttonNamed(row(), "Disable"));
    await flush();
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ enabled: false });

    click(buttonNamed(row(), "Delete…"));
    await flush();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    click(buttonNamed(document.querySelector("[data-slot='dialog-content']")!, "Delete endpoint"));
    await flush();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/org/webhooks/${ENDPOINT.id}`]);
  });
});
