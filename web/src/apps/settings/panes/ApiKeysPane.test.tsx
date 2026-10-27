import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVELOPERS_PATH } from "../../../shell/frontDoor";
import { ApiKeysPane, keyLabel, type ApiKeyRecord } from "./ApiKeysPane";
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
 * API keys as the user sees them: the list never carries the key,
 * the create response shows it once, a revoke cannot fire without the
 * confirmation dialog, a rotate shows the new key once inside its own
 * dialog, and the expiry, allow-list and rate limit are chosen on the form
 * and read back off the row.
 */

// The intro's developer-portal link is a router <Link>, which throws
// outside a RouterProvider; a plain anchor carries the same href.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; className?: string; children?: React.ReactNode }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE: ApiKeyRecord = {
  id: "11111111-1111-7111-8111-111111111111",
  prefix: "mw_ab12cd34",
  name: "laptop script",
  scopes: ["chat:read", "chat:write"],
  created_at: "2026-09-01T10:00:00+00:00",
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  rotated_at: null,
  previous_prefix: null,
  previous_valid_until: null,
  allowed_cidrs: null,
  rpm_limit: null,
};

const REVOKED: ApiKeyRecord = {
  ...LIVE,
  id: "22222222-2222-7222-8222-222222222222",
  prefix: "mw_zz99yy88",
  name: "old ci key",
  scopes: ["chat:read"],
  revoked_at: "2026-09-10T10:00:00+00:00",
  last_used_at: "2026-09-09T10:00:00+00:00",
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setTextarea(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const dialog = () => document.querySelector("[data-slot='dialog-content']");

/** Open the create dialog from the pane and hand back its form. */
function openCreate(container: HTMLElement): HTMLFormElement {
  click(buttonNamed(container, "Create key"));
  const form = dialog()?.querySelector<HTMLFormElement>("form[aria-label='Create key']");
  if (!form) throw new Error("the create dialog did not open");
  return form;
}

describe("the API keys pane", () => {
  it("puts Create key above the list, the form behind it, and links the developer portal", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/keys" ? { status: 200, body: { data: [LIVE] } } : undefined,
    );
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;
    // No form on the page until it is asked for.
    expect(container.querySelector("input[aria-label='Key name']")).toBeNull();
    const list = container.querySelector("ul[aria-label='API keys']")!;
    const opener = buttonNamed(container, "Create key");
    // The button comes before the list: it is found without scrolling past old keys.
    expect(opener.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const portal = [...container.querySelectorAll("a")].find((a) => a.textContent === "developer portal");
    expect(portal?.getAttribute("href")).toBe(DEVELOPERS_PATH);
    // The MCP section sends the reader to the hosted guide, in a new tab.
    const guide = [...container.querySelectorAll("a")].find((a) => a.textContent === "MCP guide");
    expect(guide?.getAttribute("href")).toBe("https://matterwave.dev/docs/reference/mcp");
    expect(guide?.getAttribute("rel")).toBe("noreferrer");

    const form = openCreate(container);
    // Expires and the rate limit sit side by side in one grid, labelled alike.
    const limits = form.querySelector("[data-testid='key-limits']")!;
    const labels = [...limits.querySelectorAll("label > span:first-child")].map((s) => s.textContent);
    expect(labels).toEqual(["Expires", "Requests per minute"]);
    click(buttonNamed(dialog()!, "Cancel"));
    expect(dialog()).toBeNull();
  });

  it("lists prefix, name, scopes, dates and the revoked state, never a key", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [LIVE, REVOKED] } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["admin", "user"]));
    const list = mounted.container.querySelector("ul[aria-label='API keys']")!;
    // The revoked key is on record, not in the way: one toggle shows it.
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).not.toContain("old ci key");
    click(buttonNamed(mounted.container, "Show 1 revoked"));
    const items = [...list.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    expect(buttonNamed(mounted.container, "Hide revoked")).toBeDefined();

    expect(items[0].textContent).toContain("laptop script");
    expect(items[0].textContent).toContain("mw_ab12cd34…");
    expect(items[0].textContent).toContain("chat:write");
    expect(items[0].textContent).toContain("Never used");
    // Dates in the reader's locale, the medium form every pane uses.
    expect(items[0].textContent).toContain(
      `Created ${new Date(LIVE.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}`,
    );
    expect([...items[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Edit…",
      "Rotate…",
      "Revoke…",
    ]);
    // Nothing expires, nothing is pinned, nothing is capped: no badge, no line.
    expect(items[0].querySelector("[data-testid='expiry-badge']")).toBeNull();
    expect(items[0].textContent).not.toContain("Only from");
    expect(items[0].textContent).not.toContain("req/min");

    expect(items[1].textContent).toContain("Revoked");
    expect(items[1].querySelector("button")).toBeNull();
    // Nothing that could be a full key is on the page.
    expect(mounted.container.textContent).not.toMatch(/mw_[a-z0-9]{8}_/);
  });

  it("shows the expiry as a badge: soon in red, far off as a date, past as expired", async () => {
    const now = Date.now();
    const soon = { ...LIVE, id: "s", name: "soon", expires_at: new Date(now + 3 * DAY_MS).toISOString() };
    const later = { ...LIVE, id: "l", name: "later", expires_at: new Date(now + 60 * DAY_MS).toISOString() };
    const expired = { ...LIVE, id: "e", name: "expired", expires_at: new Date(now - DAY_MS).toISOString() };
    const pinned = {
      ...LIVE,
      id: "p",
      name: "pinned",
      allowed_cidrs: ["10.0.0.0/8", "192.0.2.7/32"],
      rpm_limit: 30,
      rotated_at: "2026-09-20T10:00:00+00:00",
      previous_prefix: "mw_old0old0",
      previous_valid_until: "2026-09-21T10:00:00+00:00",
    };
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys")
        return { status: 200, body: { data: [soon, later, expired, pinned] } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const items = [...mounted.container.querySelectorAll("ul[aria-label='API keys'] li")];
    const badge = (item: Element) => item.querySelector("[data-testid='expiry-badge']")!;

    expect(badge(items[0]).textContent).toBe("Expires in 3 days");
    expect(badge(items[0]).getAttribute("data-variant")).toBe("destructive");
    expect(badge(items[1]).textContent).toBe(
      `Expires ${new Date(later.expires_at).toLocaleDateString(undefined, { dateStyle: "medium" })}`,
    );
    expect(badge(items[1]).getAttribute("data-variant")).toBe("outline");
    expect(badge(items[2]).textContent).toContain("Expired");
    // An expired key can be edited (a new expiry revives it) or revoked, but
    // there is nothing to rotate into.
    expect([...items[2].querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Edit…",
      "Revoke…",
    ]);

    expect(items[3].textContent).toContain("Only from 10.0.0.0/8, 192.0.2.7/32");
    expect(items[3].textContent).toContain("30 req/min");
    expect(items[3].textContent).toContain("the old key mw_old0old0… works until");
  });

  it("shows an empty state, and the API's own reason when it cannot list", async () => {
    stubApi(() => ({ status: 200, body: { data: [] } }));
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    expect(mounted.container.textContent).toContain("No API keys yet");
    mounted.unmount();

    stubApi(() => ({ status: 503, body: { detail: "API keys need Postgres; set MW_DATABASE_URL." } }));
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const alert = mounted.container.querySelector("[role='alert']")!;
    expect(alert.textContent).toContain("API keys need Postgres");
  });

  it("creates a key with the chosen scopes and shows the plaintext exactly once", async () => {
    let listed: ApiKeyRecord[] = [];
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: listed } };
      if (method === "POST" && url === "/api/keys") {
        const created = { ...LIVE, name: (body as { name: string }).name, scopes: (body as { scopes: string[] }).scopes };
        listed = [created];
        return { status: 201, body: { ...created, key: "mw_ab12cd34_THE-ONE-TIME-SECRET" } };
      }
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;

    const form = openCreate(container);
    const create = buttonNamed(dialog()!, "Create key");
    expect(create.disabled).toBe(true); // no name yet

    setInputValue(form.querySelector("input[aria-label='Key name']") as HTMLInputElement, "ci");
    // Narrow the key: drop chat:write, keep the default chat:read.
    const boxes = [...form.querySelectorAll("input[type='checkbox']")] as HTMLInputElement[];
    // read, write, keys:manage, webhooks:manage, usage:read: the org scopes are opt-in.
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false, false, false]);
    click(boxes[1]);
    click(boxes[4]);
    expect(create.disabled).toBe(false);
    submit(form);
    await flush();
    // The dialog closes; the secret is shown once in the pane itself.
    expect(dialog()).toBeNull();

    // The defaults send nothing optional: never expires, anywhere, platform limit.
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "ci", scopes: ["chat:read", "usage:read"] });

    const shown = container.querySelector("[data-testid='new-key']")!;
    expect(shown.textContent).toBe("mw_ab12cd34_THE-ONE-TIME-SECRET");
    expect(container.querySelector("[role='status']")!.textContent).toContain("will not be shown again");
    // The list reloaded and shows the prefix only.
    expect(container.querySelector("ul[aria-label='API keys']")!.textContent).toContain("mw_ab12cd34…");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);

    click(buttonNamed(container, "Done"));
    expect(container.querySelector("[data-testid='new-key']")).toBeNull();
    expect(container.textContent).not.toContain("THE-ONE-TIME-SECRET");
  });

  it("sends the expiry preset, the allow-list and the rate limit the form was given", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === "/api/keys")
        return { status: 201, body: { ...LIVE, key: "mw_ab12cd34_SECRET" } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;

    let form = openCreate(container);
    setInputValue(form.querySelector("input[aria-label='Key name']") as HTMLInputElement, "deploy");
    await chooseOption(selectNamed(form, "Expires")!, "90 days");
    setTextarea(form.querySelector("textarea")!, "10.0.0.0/8\n 192.0.2.7 ,2001:db8::/32\n");
    setInputValue(form.querySelector("input[type='number']") as HTMLInputElement, "30");
    expect(form.querySelector("[role='alert']")).toBeNull();
    submit(form);
    await flush();

    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "deploy",
      scopes: ["chat:read", "chat:write"],
      expires_in_days: 90,
      allowed_cidrs: ["10.0.0.0/8", "192.0.2.7", "2001:db8::/32"],
      rpm_limit: 30,
    });
    // The form is clean again, so a second key does not inherit the first's reach.
    form = openCreate(container);
    expect((form.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(selectShown(selectNamed(form, "Expires")!)).toBe("Never");
  });

  it("sends an absolute date as the end of that day, and refuses one in the past", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === "/api/keys")
        return { status: 201, body: { ...LIVE, key: "mw_ab12cd34_SECRET" } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const form = openCreate(mounted.container);
    setInputValue(form.querySelector("input[aria-label='Key name']") as HTMLInputElement, "dated");
    await chooseOption(selectNamed(form, "Expires")!, "On a date…");
    const date = form.querySelector("input[aria-label='Expiry date']") as HTMLInputElement;
    const create = buttonNamed(dialog()!, "Create key");
    // No date yet: nothing to send, so nothing to click.
    expect(create.disabled).toBe(true);

    setInputValue(date, "2020-01-01");
    expect(create.disabled).toBe(true);
    expect(form.querySelector("[role='alert']")!.textContent).toBe("The expiry date must be after today.");

    setInputValue(date, "2099-06-30");
    expect(create.disabled).toBe(false);
    submit(form);
    await flush();
    const body = calls.find((c) => c.method === "POST")!.body as { expires_at: string; expires_in_days?: number };
    expect(body.expires_in_days).toBeUndefined();
    expect(body.expires_at).toBe(new Date("2099-06-30T23:59:59").toISOString());
  });

  it("refuses a malformed address before the API ever sees it", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const form = openCreate(mounted.container);
    setInputValue(form.querySelector("input[aria-label='Key name']") as HTMLInputElement, "x");
    const create = buttonNamed(dialog()!, "Create key");
    expect(create.disabled).toBe(false);

    for (const bad of ["office", "10.0.0.256", "10.0.0.0/33", "2001:db8::/129", "1.2.3.4/8/x"]) {
      setTextarea(form.querySelector("textarea")!, `10.0.0.0/8\n${bad}`);
      expect(create.disabled).toBe(true);
      expect(form.querySelector("[role='alert']")!.textContent).toBe(
        `Not an IP address or CIDR range: ${bad}`,
      );
    }
    setInputValue(form.querySelector("input[type='number']") as HTMLInputElement, "0");
    setTextarea(form.querySelector("textarea")!, "");
    expect(create.disabled).toBe(true);
    expect(form.querySelector("[role='alert']")!.textContent).toContain("at least 1");

    submit(form);
    await flush();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("revokes only through the confirmation, then reloads", async () => {
    let listed = [LIVE];
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: listed } };
      if (method === "DELETE" && url === `/api/keys/${LIVE.id}`) {
        listed = [{ ...LIVE, revoked_at: "2026-09-28T00:00:00+00:00" }];
        return { status: 204, body: null };
      }
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;

    click(buttonNamed(container, "Revoke…"));
    expect(dialog()!.textContent).toContain('Revoke "laptop script"?');
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    click(buttonNamed(dialog()!, "Cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    click(buttonNamed(container, "Revoke…"));
    click(buttonNamed(dialog()!, "Revoke key"));
    await flush();

    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `/api/keys/${LIVE.id}`,
    ]);
    // Nothing live is left; the revoked key is a toggle away.
    expect(container.textContent).toContain("No active API keys");
    click(buttonNamed(container, "Show 1 revoked"));
    const item = container.querySelector("ul[aria-label='API keys'] li")!;
    expect(item.textContent).toContain("Revoked");
    expect(item.querySelector("button")).toBeNull();
  });

  it("shows a device sign-in key by its client and local date, keeping the stored name on the title", async () => {
    const minted = "2026-10-23T18:04:11Z";
    const device = { ...LIVE, id: "33333333-3333-7333-8333-333333333333", name: `Device: vscode e2e ${minted}` };
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/keys" ? { status: 200, body: { data: [device] } } : undefined,
    );
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const item = mounted.container.querySelector("ul[aria-label='API keys'] li")!;
    const date = new Date(minted).toLocaleDateString(undefined, { dateStyle: "medium" });
    expect(item.querySelector("span.font-medium")?.textContent).toBe(`VS Code e2e · ${date}`);
    expect(item.querySelector("span.font-medium")?.getAttribute("title")).toBe(device.name);
    expect(item.textContent).toContain("Device sign-in");
    // The dialogs name the key as the API knows it.
    click(buttonNamed(mounted.container, "Revoke…"));
    expect(dialog()!.textContent).toContain(`Revoke "${device.name}"?`);

    expect(keyLabel("Device: matterwave-tui")).toEqual({ text: "MatterWave TUI", device: true });
    expect(keyLabel("Device: work laptop")).toEqual({ text: "work laptop", device: true });
    expect(keyLabel("laptop script")).toEqual({ text: "laptop script", device: false });
  });

  it("rotates through its dialog, shows the new key once there, then reloads", async () => {
    let listed = [LIVE];
    const rotatedRow = {
      ...LIVE,
      prefix: "mw_new1new1",
      rotated_at: "2026-09-28T00:00:00+00:00",
      previous_prefix: LIVE.prefix,
      previous_valid_until: "2026-09-29T00:00:00+00:00",
    };
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: listed } };
      if (method === "POST" && url === `/api/keys/${LIVE.id}/rotate`) {
        listed = [rotatedRow];
        return { status: 200, body: { ...rotatedRow, key: "mw_new1new1_THE-ROTATED-SECRET" } };
      }
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;

    click(buttonNamed(container, "Rotate…"));
    expect(dialog()!.textContent).toContain('Rotate "laptop script"?');
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    click(buttonNamed(dialog()!, "Cancel"));
    expect(dialog()).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    click(buttonNamed(container, "Rotate…"));
    click(buttonNamed(dialog()!, "Rotate key"));
    await flush();

    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `/api/keys/${LIVE.id}/rotate`,
    ]);
    const shown = dialog()!.querySelector("[data-testid='rotated-key']")!;
    expect(shown.textContent).toBe("mw_new1new1_THE-ROTATED-SECRET");
    expect(dialog()!.textContent).toContain("will not be shown again");
    expect(dialog()!.textContent).toContain(
      `The old key keeps working until ${new Date(rotatedRow.previous_valid_until).toLocaleString()}`,
    );
    // Not reloaded yet: the list still shows the old prefix beneath the modal.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);

    click(buttonNamed(dialog()!, "Done"));
    await flush();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain("THE-ROTATED-SECRET");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    const item = container.querySelector("ul[aria-label='API keys'] li")!;
    expect(item.textContent).toContain("mw_new1new1…");
    expect(item.textContent).toContain("the old key mw_ab12cd34… works until");
  });

  it("edits a key through the pre-filled form, sends only what changed, and updates the row in place", async () => {
    const pinned: ApiKeyRecord = {
      ...LIVE,
      scopes: ["chat:read", "chat:write"],
      allowed_cidrs: ["10.0.0.0/8"],
      rpm_limit: 60,
    };
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [pinned, REVOKED] } };
      if (method === "PATCH" && url === `/api/keys/${LIVE.id}`) {
        const patch = body as { name?: string; scopes?: string[]; rpm_limit?: number | null };
        return {
          status: 200,
          body: {
            ...pinned,
            name: patch.name ?? pinned.name,
            scopes: patch.scopes ?? pinned.scopes,
            rpm_limit: patch.rpm_limit === undefined ? pinned.rpm_limit : patch.rpm_limit,
          },
        };
      }
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    const { container } = mounted;

    click(buttonNamed(container, "Edit…"));
    const form = dialog()!.querySelector("form[aria-label='Edit key']") as HTMLFormElement;
    expect(dialog()!.textContent).toContain('Edit "laptop script"');
    // Pre-filled from the row, and the secret is nowhere on it.
    const nameInput = form.querySelector("input[aria-label='Key name']") as HTMLInputElement;
    expect(nameInput.value).toBe("laptop script");
    const boxes = [...form.querySelectorAll("input[type='checkbox']")] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false, false, false]);
    expect(selectShown(selectNamed(form, "Expires")!)).toBe("Never");
    expect((form.querySelector("textarea") as HTMLTextAreaElement).value).toBe("10.0.0.0/8");
    expect((form.querySelector("input[type='number']") as HTMLInputElement).value).toBe("60");
    expect(dialog()!.textContent).not.toMatch(/mw_[a-z0-9]{8}_/);
    // Nothing changed yet: nothing to save.
    const save = buttonNamed(dialog()!, "Save changes");
    expect(save.disabled).toBe(true);

    setInputValue(nameInput, "laptop script (eu)");
    click(boxes[1]);
    click(boxes[3]);
    setInputValue(form.querySelector("input[type='number']") as HTMLInputElement, "30");
    expect(save.disabled).toBe(false);
    submit(form);
    await flush();

    // Only the three fields that moved, and the list was patched, not reloaded.
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      name: "laptop script (eu)",
      scopes: ["chat:read", "webhooks:manage"],
      rpm_limit: 30,
    });
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(dialog()).toBeNull();
    // The revoked row is behind its toggle; the patched row is the one shown.
    const items = [...container.querySelectorAll("ul[aria-label='API keys'] li")];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("laptop script (eu)");
    expect(items[0].textContent).toContain("30 req/min");
    expect(items[0].textContent).not.toContain("chat:write");
    expect(items[0].textContent).toContain("Only from 10.0.0.0/8");
    click(buttonNamed(container, "Show 1 revoked"));
    expect(container.querySelectorAll("ul[aria-label='API keys'] li")[1].textContent).toContain("old ci key");
  });

  it("sends null to clear a setting, and keeps the edit dialog open with the API's reason", async () => {
    const dated: ApiKeyRecord = {
      ...LIVE,
      expires_at: "2099-06-30T12:00:00+00:00",
      allowed_cidrs: ["10.0.0.0/8"],
      rpm_limit: 60,
    };
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [dated] } };
      if (method === "PATCH") return { status: 422, body: { detail: "expires_at must be in the future." } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    click(buttonNamed(mounted.container, "Edit…"));
    const form = dialog()!.querySelector("form[aria-label='Edit key']") as HTMLFormElement;
    // An existing expiry opens as that date.
    expect(selectShown(selectNamed(form, "Expires")!)).toBe("On a date…");
    expect((form.querySelector("input[aria-label='Expiry date']") as HTMLInputElement).value).toBe(
      new Date(dated.expires_at!).toISOString().slice(0, 10),
    );

    await chooseOption(selectNamed(form, "Expires")!, "Never");
    setTextarea(form.querySelector("textarea")!, "");
    setInputValue(form.querySelector("input[type='number']") as HTMLInputElement, "");
    submit(form);
    await flush();

    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      expires_at: null,
      allowed_cidrs: null,
      rpm_limit: null,
    });
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector("[role='alert']")!.textContent).toBe("expires_at must be in the future.");
    // The row is as it was.
    expect(mounted.container.querySelector("ul[aria-label='API keys'] li")!.textContent).toContain("60 req/min");
  });

  it("keeps the rotate dialog open with the API's reason when the rotate fails", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/keys") return { status: 200, body: { data: [LIVE] } };
      if (method === "POST") return { status: 404, body: { detail: "No such API key" } };
      return undefined;
    });
    mounted = await mount(<ApiKeysPane />, principalWith(["user"]));
    click(buttonNamed(mounted.container, "Rotate…"));
    click(buttonNamed(dialog()!, "Rotate key"));
    await flush();
    expect(dialog()!.querySelector("[role='alert']")!.textContent).toBe("No such API key");
    expect(dialog()!.querySelector("[data-testid='rotated-key']")).toBeNull();
  });
});
