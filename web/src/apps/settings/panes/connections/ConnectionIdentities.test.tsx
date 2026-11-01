import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionIdentities } from "./ConnectionIdentities";
import { memberLabelOf } from "./connectionsApi";
import { CONNECTION, IDENTITY_STATUSES, MEMBERS, identity } from "./fixtures";
import {
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  principalWith,
  selectNamed,
  stubApi,
  type Mounted,
  type RecordedCall,
} from "../paneHarness";

/**
 * The identities list: each person with their status and the member
 * they map to; a guest is labelled and cannot be linked; linking sends
 * the chosen member, and block, unblock and unlink each send their
 * action; the status filter is the API's query.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const IDENTITIES_URL = `/api/org/connections/${CONNECTION.id}/identities`;

const ROWS = [
  identity({}),
  identity({ id: "i-2", external_user_id: "U0NEW", display_name: "newcomer", email: "new@acme.com", subject: null, status: "unmapped" }),
  identity({ id: "i-3", external_user_id: "U0GUEST", display_name: "guest", email: "g@other.com", subject: null, status: "guest" }),
  identity({ id: "i-4", external_user_id: "U0BAD", display_name: null, email: null, subject: null, status: "blocked" }),
];

function stubIdentities(extra: (call: RecordedCall) => { status: number; body: unknown } | undefined = () => undefined) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url.startsWith(IDENTITIES_URL)) {
      const status = new URL(call.url, "http://x").searchParams.get("status");
      return { status: 200, body: { data: status ? ROWS.filter((r) => r.status === status) : ROWS } };
    }
    return undefined;
  });
}

async function render() {
  mounted = await mount(
    <ConnectionIdentities connection={CONNECTION} statuses={IDENTITY_STATUSES} members={MEMBERS} nameOf={memberLabelOf(MEMBERS)} />,
    principalWith(["user"], "admin"),
  );
  return mounted.container;
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`tr[data-identity-id='${id}']`)!;
}

describe("the identities list", () => {
  it("shows each person's status and member, and keeps guests from being linked", async () => {
    stubIdentities();
    const container = await render();
    const mapped = rowOf(container, "i-1");
    expect(mapped.textContent).toContain("jane");
    expect(mapped.textContent).toContain("U0JANE");
    expect(mapped.textContent).toContain("ada@acme.com");
    expect(mapped.textContent).toContain("Mapped");
    expect(mapped.textContent).toContain("Ada");
    expect(buttonNamed(mapped, "Unlink")).toBeTruthy();
    expect(buttonNamed(mapped, "Link to another member…")).toBeTruthy();

    const unmapped = rowOf(container, "i-2");
    expect(unmapped.textContent).toContain("Unmapped");
    expect(buttonNamed(unmapped, "Link to a member…")).toBeTruthy();
    expect([...unmapped.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Unlink");

    const guest = rowOf(container, "i-3");
    expect(guest.textContent).toContain("Guest");
    expect(guest.querySelector("[data-identity-guest-note]")!.textContent).toBe("Guests cannot be linked");
    expect(guest.querySelectorAll("button")).toHaveLength(0);

    const blocked = rowOf(container, "i-4");
    expect(blocked.textContent).toContain("Blocked");
    expect([...blocked.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Unblock"]);
  });

  it("links a person to the chosen member", async () => {
    const calls = stubIdentities(({ method, url, body }) =>
      method === "PATCH" && url === `${IDENTITIES_URL}/i-2`
        ? { status: 200, body: identity({ id: "i-2", subject: (body as { subject: string }).subject, status: "mapped" }) }
        : undefined,
    );
    const container = await render();
    click(buttonNamed(rowOf(container, "i-2"), "Link to a member…"));
    await flush();
    const form = container.querySelector("[data-identity-link-form='i-2']")!;
    const link = buttonNamed(form, "Link");
    expect(link.disabled).toBe(true);
    await chooseOption(selectNamed(form, "Member for newcomer")!, "Cy (cy@acme.com)");
    expect(link.disabled).toBe(false);
    click(link);
    await flush();
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
      url: `${IDENTITIES_URL}/i-2`,
      body: { action: "map", subject: "cy" },
    });
    // Re-read after the write.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("unlinks, blocks and unblocks with one action each", async () => {
    const calls = stubIdentities(({ method, url }) =>
      method === "PATCH" && url.startsWith(IDENTITIES_URL) ? { status: 200, body: identity({}) } : undefined,
    );
    const container = await render();
    click(buttonNamed(rowOf(container, "i-1"), "Unlink"));
    await flush();
    click(buttonNamed(rowOf(container, "i-2"), "Block"));
    await flush();
    click(buttonNamed(rowOf(container, "i-4"), "Unblock"));
    await flush();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url.slice(IDENTITIES_URL.length + 1), c.body])).toEqual([
      ["i-1", { action: "unmap" }],
      ["i-2", { action: "block" }],
      ["i-4", { action: "unblock" }],
    ]);
  });

  it("filters by status with the API's query, and reports a refused action beside the row", async () => {
    const calls = stubIdentities(({ method }) =>
      method === "PATCH" ? { status: 422, body: { detail: "Guests cannot be mapped." } } : undefined,
    );
    const container = await render();
    await chooseOption(selectNamed(container, "Show")!, "Blocked");
    expect(calls.at(-1)!.url).toBe(`${IDENTITIES_URL}?status=blocked`);
    expect(container.querySelectorAll("tr[data-identity-id]")).toHaveLength(1);
    click(buttonNamed(rowOf(container, "i-4"), "Unblock"));
    await flush();
    expect(container.querySelector("[role='alert']")!.textContent).toBe("Guests cannot be mapped.");
  });
});
