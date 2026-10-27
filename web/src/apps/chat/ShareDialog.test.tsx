import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "./ShareDialog";
import { EXPIRY_PRESETS } from "../share/share";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  stubApi,
  type Mounted,
} from "../settings/panes/paneHarness";

/**
 * The share dialog as a person meets it: the existing links load, a link
 * is created with the chosen expiry and shown once with Copy, and a link
 * can be revoked from the list. Renders through a portal, so everything is
 * found on `document`.
 */

const CONVERSATION_ID = "11111111-1111-7111-8111-111111111111";

const ACTIVE = {
  id: "s-1",
  conversation_id: CONVERSATION_ID,
  title: "Quarterly plan",
  message_count: 4,
  created_at: "2026-10-01T10:00:00Z",
  expires_at: "2026-10-08T12:00:00Z",
  revoked_at: null,
  view_count: 3,
  status: "active",
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>("[data-mw-share-dialog]");
  if (!node) throw new Error("the share dialog is not open");
  return node;
}

async function openDialog(respond: Parameters<typeof stubApi>[0]) {
  const closed: boolean[] = [];
  const calls = stubApi(respond);
  mounted = await mount(
    <ShareDialog open conversationId={CONVERSATION_ID} onOpenChange={(open) => closed.push(open)} />,
    principalWith(["user"]),
  );
  await flush();
  return { calls, closed };
}

function chooseExpiry(index: number): void {
  const select = dialog().querySelector<HTMLSelectElement>("select")!;
  act(() => {
    select.value = String(index);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("the share dialog", () => {
  it("lists the existing links with their state and says what a link is", async () => {
    const { calls } = await openDialog(({ method, url }) => {
      if (method === "GET" && url === `/api/conversations/${CONVERSATION_ID}/shares`) {
        return { status: 200, body: { data: [ACTIVE, { ...ACTIVE, id: "s-2", status: "revoked" }] } };
      }
      return undefined;
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/conversations/${CONVERSATION_ID}/shares`,
    ]);
    expect(dialog().textContent).toContain("as it is right now");
    const items = [...dialog().querySelectorAll("[data-mw-share-status]")];
    expect(items.map((li) => li.getAttribute("data-mw-share-status"))).toEqual(["active", "revoked"]);
    expect(items[0].textContent).toContain("4 messages");
    expect(items[0].textContent).toContain("3 views");
    expect(items[0].textContent).toMatch(/Expires 8 Oct 2026/);
    expect(items[1].textContent).toContain("Revoked");
    // Only the live link can be revoked; the token is never in the list.
    expect(items[0].querySelector("button")?.textContent).toBe("Revoke");
    expect(items[1].querySelector("button")).toBeNull();
    expect(dialog().textContent).not.toContain("/share/");
  });

  it("offers the expiry presets and defaults to seven days", async () => {
    await openDialog(() => ({ status: 200, body: { data: [] } }));
    const options = [...dialog().querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(EXPIRY_PRESETS.map((p) => p.label));
    expect(dialog().querySelector<HTMLSelectElement>("select")?.value).toBe("1");
    expect(dialog().textContent).toContain("No links yet.");
  });

  it("posts the chosen expiry, shows the link once with Copy, and adds it to the list", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { calls } = await openDialog(({ method, url }) => {
      if (method === "GET") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === `/api/conversations/${CONVERSATION_ID}/share`) {
        return {
          status: 201,
          body: {
            share: { ...ACTIVE, id: "s-new", view_count: 0, expires_at: null },
            token: "tok-abc",
            path: "/share/tok-abc",
          },
        };
      }
      return undefined;
    });

    chooseExpiry(EXPIRY_PRESETS.length - 1);
    click(buttonNamed(dialog(), "Create link"));
    await flush();

    expect(calls.at(-1)?.body).toEqual({ expires_in_s: null, include_attachments: false });
    expect(dialog().getAttribute("data-mw-share-dialog")).toBe("created");
    const field = dialog().querySelector<HTMLInputElement>("input[readonly]")!;
    expect(field.value).toBe(`${window.location.origin}/share/tok-abc`);
    expect(dialog().textContent).toContain("shown once");

    click(buttonNamed(dialog(), "Copy"));
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/tok-abc`);
    expect(buttonNamed(dialog(), "Copied")).toBeDefined();

    const items = [...dialog().querySelectorAll("[data-mw-share-status]")];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("Until revoked");
  });

  it("sends the preset's seconds for a timed link", async () => {
    const { calls } = await openDialog(({ method }) =>
      method === "GET"
        ? { status: 200, body: { data: [] } }
        : {
            status: 201,
            body: { share: ACTIVE, token: "t", path: "/share/t" },
          },
    );
    chooseExpiry(0);
    click(buttonNamed(dialog(), "Create link"));
    await flush();
    expect(calls.at(-1)?.body).toEqual({
      expires_in_s: EXPIRY_PRESETS[0].seconds,
      include_attachments: false,
    });
  });

  it("includes attachments only when the box is ticked, and says so in the list", async () => {
    const { calls } = await openDialog(({ method, url }) => {
      if (method === "GET" && url === `/api/conversations/${CONVERSATION_ID}/shares`) {
        return { status: 200, body: { data: [] } };
      }
      if (method === "POST" && url === `/api/conversations/${CONVERSATION_ID}/share`) {
        return {
          status: 201,
          body: {
            share: { ...ACTIVE, include_attachments: true },
            token: "tok-xyz",
            path: "/share/tok-xyz",
          },
        };
      }
      return undefined;
    });
    const box = dialog().querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(box.checked).toBe(false);
    expect(dialog().textContent).toContain("Off, they see only the file names.");
    await act(async () => {
      box.click();
    });
    click(buttonNamed(dialog(), "Create link"));
    await flush();
    const posted = calls.find((c) => c.method === "POST");
    expect(posted?.body).toEqual({
      expires_in_s: EXPIRY_PRESETS[1].seconds,
      include_attachments: true,
    });
    expect(dialog().querySelector("[data-mw-share-status='active']")?.textContent).toContain(
      "with attachments",
    );
  });

  it("revokes from the list and marks the row", async () => {
    const { calls } = await openDialog(({ method, url }) => {
      if (method === "GET") return { status: 200, body: { data: [ACTIVE] } };
      if (method === "DELETE" && url === "/api/shares/s-1") {
        return { status: 200, body: { status: "revoked" } };
      }
      return undefined;
    });
    click(buttonNamed(dialog(), "Revoke"));
    await flush();
    expect(calls.at(-1)?.url).toBe("/api/shares/s-1");
    const row = dialog().querySelector("[data-mw-share-status]")!;
    expect(row.getAttribute("data-mw-share-status")).toBe("revoked");
    expect(row.querySelector("button")).toBeNull();
  });

  it("says when a link could not be made and keeps the form", async () => {
    await openDialog(({ method }) =>
      method === "GET"
        ? { status: 200, body: { data: [] } }
        : { status: 422, body: { detail: "There is nothing to share until the conversation has a message." } },
    );
    click(buttonNamed(dialog(), "Create link"));
    await flush();
    expect(dialog().getAttribute("data-mw-share-dialog")).toBe("failed");
    expect(dialog().querySelector("[role='alert']")?.textContent).toContain("nothing to share");
    expect(dialog().querySelector("input[readonly]")).toBeNull();
    expect(buttonNamed(dialog(), "Create link")).toBeDefined();
  });

  it("closes on Done", async () => {
    const { closed } = await openDialog(() => ({ status: 200, body: { data: [] } }));
    click(buttonNamed(dialog(), "Done"));
    expect(closed).toEqual([false]);
  });
});
