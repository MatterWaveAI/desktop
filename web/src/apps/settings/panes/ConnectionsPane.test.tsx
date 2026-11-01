import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPane } from "./ConnectionsPane";
import { CONNECTION, PENDING, listing, paneLoad, route } from "./connections/fixtures";
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
  type RecordedCall,
} from "./paneHarness";

/**
 * Connections as an admin sees them: a member is told the pane is for
 * admins and nothing is fetched; each row says its state, who connected
 * it and when it last heard anything; a pending row can only be removed;
 * every row action is the call routes_connectors.py expects, and the
 * rotation shows the new URL with the warning about the app's Request URL.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function row(id: string): HTMLElement {
  const li = mounted!.container.querySelector<HTMLElement>(`li[data-connection-id='${id}']`);
  if (!li) throw new Error(`no row for ${id}`);
  return li;
}

function stubPane(extra: (call: RecordedCall) => { status: number; body: unknown } | undefined = () => undefined) {
  const load = paneLoad([CONNECTION, PENDING]);
  return stubApi((call) => extra(call) ?? load(call));
}

describe("the connections pane", () => {
  it("tells a member it is for admins and fetches nothing", async () => {
    const calls = stubApi(() => undefined);
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "member"));
    expect(mounted.container.textContent).toContain("Connections are for admins");
    expect(calls).toHaveLength(0);
  });

  it("lists each connection's state, who connected it and its last event", async () => {
    stubPane();
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    const list = mounted.container.querySelector("ul[aria-label='Connections']")!;
    expect(list.querySelectorAll("li")).toHaveLength(2);
    const active = row(CONNECTION.id);
    expect(active.textContent).toContain("Acme Slack");
    expect(active.textContent).toContain("Slack");
    expect(active.querySelector("[data-testid='connection-status']")!.textContent).toBe("Active");
    expect(active.textContent).toContain("Connected by Ada");
    expect(active.textContent).toContain("Last event");
    expect(buttonNamed(active, "Disable")).toBeTruthy();
    expect(buttonNamed(active, "Manage")).toBeTruthy();

    const pending = row(PENDING.id);
    expect(pending.querySelector("[data-testid='connection-status']")!.textContent).toBe(
      "Waiting for the app to be installed",
    );
    expect(pending.textContent).toContain("No events yet");
    // Nothing to route or replace until the app exists: only Remove.
    expect([...pending.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Remove…"]);
    expect(buttonNamed(mounted.container, "Connect Slack…")).toBeTruthy();
  });

  it("shows a stopped connection's reason, and an empty state", async () => {
    stubApi(paneLoad([{ ...CONNECTION, status: "error", last_error: "invalid_auth" }]));
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "owner"));
    expect(row(CONNECTION.id).querySelector("[data-connection-error]")!.textContent).toBe("invalid_auth");
    expect(row(CONNECTION.id).querySelector("[data-testid='connection-status']")!.textContent).toBe("Not working");
    mounted.unmount();

    stubApi(paneLoad([]));
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.textContent).toContain("No connections yet");
  });

  it("says the feature is off on this deployment without an error, and reports other failures with Retry", async () => {
    stubApi(({ url }) =>
      url === "/api/org/connections" ? { status: 503, body: { detail: "Connectors need Postgres; set MW_DATABASE_URL." } } : undefined,
    );
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.textContent).toContain("Not available on this deployment");
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
    expect(mounted.container.textContent).not.toContain("MW_DATABASE_URL");
    mounted.unmount();

    stubApi(() => ({ status: 500, body: { detail: "Something broke." } }));
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain("Something broke.");
    expect([...mounted.container.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true);
  });

  it("disables and enables with a status PATCH", async () => {
    let status: "active" | "disabled" = "active";
    const calls = stubApi(({ method, url, body }) => {
      if (method === "PATCH" && url === `/api/org/connections/${CONNECTION.id}`) {
        status = (body as { status: "active" | "disabled" }).status;
        return { status: 200, body: { ...CONNECTION, status } };
      }
      return paneLoad([{ ...CONNECTION, status }])({ method, url });
    });
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(CONNECTION.id), "Disable"));
    await flush();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "disabled" });
    expect(row(CONNECTION.id).querySelector("[data-testid='connection-status']")!.textContent).toBe("Disabled");
    expect(buttonNamed(row(CONNECTION.id), "Enable")).toBeTruthy();
  });

  it("changes the rate limit from a dialog that starts at the current one", async () => {
    const calls = stubPane(({ method, url }) =>
      method === "PATCH" && url === `/api/org/connections/${CONNECTION.id}`
        ? { status: 200, body: { ...CONNECTION, rate_limit_per_minute: 30 } }
        : undefined,
    );
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(CONNECTION.id), "Rate limit…"));
    await flush();
    const dialog = document.querySelector("[data-connection-rate-dialog]")!;
    const field = dialog.querySelector<HTMLInputElement>("input[name='rate_limit_per_minute']")!;
    expect(field.value).toBe("60");
    setInputValue(field, "30");
    submit(dialog.querySelector("form")!);
    await flush();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ rate_limit_per_minute: 30 });
  });

  it("rotates the URL after a warning about the app's Request URL, then shows the new one", async () => {
    const calls = stubPane(({ method, url }) =>
      method === "POST" && url === `/api/org/connections/${CONNECTION.id}/rotate-url`
        ? { status: 200, body: { ...CONNECTION, ingress_url: "https://app.example.com/api/hooks/slack/tok-new" } }
        : undefined,
    );
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(CONNECTION.id), "Rotate URL…"));
    await flush();
    const confirm = document.querySelector("[role='dialog']")!;
    expect(confirm.textContent).toContain("Request URL");
    click(buttonNamed(confirm, "Rotate URL"));
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/rotate-url"))).toBe(true);
    const shown = document.querySelector("[data-connection-url-dialog]")!;
    expect(shown.querySelector("[data-testid='connection-ingress-url']")!.textContent).toBe(
      "https://app.example.com/api/hooks/slack/tok-new",
    );
  });

  it("replaces the credentials, showing the provider's refusal in plain words", async () => {
    let attempt = 0;
    const calls = stubPane(({ method, url }) => {
      if (method === "PATCH" && url === `/api/org/connections/${CONNECTION.id}`) {
        attempt += 1;
        return attempt === 1
          ? {
              status: 422,
              body: { detail: [{ loc: ["body", "credentials"], msg: "Slack says this token was revoked.", type: "value_error" }] },
            }
          : { status: 200, body: CONNECTION };
      }
      return undefined;
    });
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(CONNECTION.id), "Replace credentials…"));
    await flush();
    const dialog = document.querySelector("[data-connection-credentials-dialog]")!;
    const replace = buttonNamed(dialog, "Replace credentials");
    expect(replace.disabled).toBe(true);
    setInputValue(dialog.querySelector("input[name='bot_token']")!, "xoxb-new");
    setInputValue(dialog.querySelector("input[name='signing_secret']")!, "sec-new");
    expect(replace.disabled).toBe(false);
    submit(dialog.querySelector("form")!);
    await flush();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      credentials: { bot_token: "xoxb-new", signing_secret: "sec-new" },
    });
    expect(dialog.querySelector("[role='alert']")!.textContent).toBe("Slack says this token was revoked.");
    submit(dialog.querySelector("form")!);
    await flush();
    expect(document.querySelector("[data-connection-credentials-dialog]")).toBeNull();
  });

  it("removes a connection only through the confirmation", async () => {
    let rows = [CONNECTION, PENDING];
    const calls = stubApi(({ method, url }) => {
      if (method === "DELETE" && url === `/api/org/connections/${PENDING.id}`) {
        rows = [CONNECTION];
        return { status: 204, body: {} };
      }
      return paneLoad(rows)({ method, url });
    });
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(PENDING.id), "Remove…"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const confirm = document.querySelector("[role='dialog']")!;
    expect(confirm.textContent).toContain("Remove Beta Slack?");
    click(buttonNamed(confirm, "Remove connection"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(mounted.container.querySelectorAll("li[data-connection-id]")).toHaveLength(1);
  });

  it("opens a connection's four sections under its row, routing first", async () => {
    const calls = stubPane(({ method, url }) =>
      method === "GET" && url === `/api/org/connections/${CONNECTION.id}/routes`
        ? { status: 200, body: { data: [route({})] } }
        : undefined,
    );
    mounted = await mount(<ConnectionsPane />, principalWith(["user"], "admin"));
    click(buttonNamed(row(CONNECTION.id), "Manage"));
    await flush();
    const tabs = [...row(CONNECTION.id).querySelectorAll("[role='tab']")].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Routing", "Identities", "Trigger log", "Notifications"]);
    expect(calls.some((c) => c.url === `/api/org/connections/${CONNECTION.id}/routes`)).toBe(true);
    expect(row(CONNECTION.id).textContent).toContain("Only channels listed here are answered.");
    expect(row(CONNECTION.id).textContent).toContain("#support");
    expect(listing([CONNECTION]).connectors).toContain("slack");
  });
});
