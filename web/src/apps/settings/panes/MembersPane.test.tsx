import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MembersPane,
  inviteBlockedReason,
  type Invite,
  type InviteLink,
  type Member,
  type OrgRole,
  type Seats,
} from "./MembersPane";
import {
  accessibleName,
  buttonLabelled,
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  optionsOf,
  principalWith,
  selectNamed,
  selectShown,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
  type RecordedCall,
} from "./paneHarness";

/**
 * The Members pane: every member sees the list; what the pane offers
 * follows the ORG role the API reports, not the token's roles; each action
 * is the API call routes_members.py expects, and the lists reload after it.
 */

// UpgradePrompt's "See plans" is a router <Link>, which throws outside a
// RouterProvider; a plain anchor carries the same href for the assertion.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; className?: string; children?: React.ReactNode }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

const MEMBERS: Member[] = [
  { subject: "ada", email: "ada@acme.com", name: "Ada", role: "owner", state: "active", created_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-10-10T12:00:00Z" },
  { subject: "dev-user", email: "dev@localhost", name: null, role: "admin", state: "active", created_at: "2026-09-02T00:00:00Z", last_seen_at: "2026-10-19T08:00:00Z" },
  { subject: "cy", email: "cy@acme.com", name: "Cy", role: "member", state: "pending_verification", created_at: "2026-09-03T00:00:00Z", last_seen_at: null },
  { subject: "eve", email: "eve@acme.com", name: null, role: "member", state: "active", created_at: "2026-09-04T00:00:00Z", last_seen_at: "2026-09-05T00:00:00Z" },
];

/** Four members and one invite against a five-seat plan. */
const SEATS: Seats = { used: 5, max: 5, billed: null };

const INVITES: Invite[] = [
  {
    id: "33333333-3333-7333-8333-333333333333",
    email: "new@acme.com",
    role: "viewer",
    invited_by: "ada",
    created_at: "2026-09-20T00:00:00Z",
    expires_at: "2026-09-27T00:00:00Z",
    status: "pending",
  },
];

const LINKS: InviteLink[] = [
  {
    id: "44444444-4444-7444-8444-444444444444",
    role: "member",
    max_uses: 10,
    uses: 2,
    created_by: "ada",
    created_at: "2026-09-20T00:00:00Z",
    expires_at: "2026-09-27T00:00:00Z",
    status: "active",
  },
  {
    id: "55555555-5555-7555-8555-555555555555",
    role: "viewer",
    max_uses: 1,
    uses: 1,
    created_by: "dev-user",
    created_at: "2026-09-19T00:00:00Z",
    expires_at: "2026-09-26T00:00:00Z",
    status: "used_up",
  },
];

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The two GETs answer the fixtures with the caller's role; `extra` answers the actions. */
function stubMembersApi(
  role: OrgRole,
  extra: (call: RecordedCall) => { status: number; body: unknown } | undefined = () => undefined,
  seats: Seats = SEATS,
): RecordedCall[] {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url === "/api/org/members") {
      return { status: 200, body: { data: MEMBERS, role, seats } };
    }
    if (call.method === "GET" && call.url === "/api/org/invites") {
      return { status: 200, body: { data: INVITES } };
    }
    if (call.method === "GET" && call.url === "/api/org/invite-links") {
      return { status: 200, body: { data: LINKS } };
    }
    return undefined;
  });
}

function noContent() {
  return { status: 204, body: {} };
}

/**
 * Every button by the name a screen reader announces: the row's email rides
 * in aria-label. The styled selects' triggers are comboboxes, not buttons,
 * to a reader, so they are left out.
 */
function buttons(): string[] {
  return [...mounted!.container.querySelectorAll("button")]
    .filter((b) => b.getAttribute("role") !== "combobox")
    .map(accessibleName);
}

/** A styled select by its accessible name. */
function select(label: string): HTMLElement | null {
  return selectNamed(mounted!.container, label);
}

/** The styled select labelled by the form's own <label> -- the invite forms' Role, Expires after. */
function labelledSelect(scope: ParentNode, label: string): HTMLElement {
  const forId = [...scope.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)!.htmlFor;
  return scope.querySelector<HTMLElement>(`[id="${forId}"]`)!;
}

function seats(): string {
  return mounted!.container.querySelector("[data-testid='seats']")?.textContent ?? "";
}

function dialog(): Element {
  return document.querySelector("[data-slot='dialog-content']")!;
}

describe("a viewer", () => {
  it("sees the members, the seats and the pending invites, and can only leave", async () => {
    stubMembersApi("viewer");
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    const list = mounted.container.querySelector("ul[aria-label='Members']")!;
    expect(list).not.toBeNull();
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("ada@acme.com");
    expect(rows[0]).toContain("Owner");
    expect(rows[1]).toContain("Unverified");
    expect(rows[2]).toContain("You");
    expect(seats()).toContain("5 of 5 seats");
    expect(mounted.container.textContent).toContain("new@acme.com");
    expect(mounted.container.querySelector("[role=combobox][aria-label^='Role of']")).toBeNull();
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(buttons()).toEqual(["Leave"]);
  });

  it("reads an uncapped plan as unlimited", async () => {
    stubMembersApi("viewer", () => undefined, { used: 1, max: null, billed: null });
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(seats()).toContain("1 seat, unlimited");
  });

  it("reads a plan sold per seat as the seats billed, without the pending invite", async () => {
    stubMembersApi("viewer", () => undefined, { used: 5, max: null, billed: 4 });
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(seats()).toContain("4 seats, billed per seat");
    expect(seats()).toContain("Seats update automatically as members join or leave");
    expect(seats()).not.toContain("unlimited");
  });

  it("leaves through a dialog that says the account is deactivated, then the row is deleted", async () => {
    const calls = stubMembersApi("viewer", ({ method, url }) =>
      method === "DELETE" && url === "/api/org/members/dev-user" ? noContent() : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    click(buttonNamed(mounted.container, "Leave"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(dialog().textContent).toContain("Leave this organisation?");
    // The consequence is stated, not hidden: leaving suspends the users row.
    expect(dialog().textContent).toContain("deactivates your account");
    expect(dialog().textContent).toContain("sign up with a different address");
    click(buttonNamed(dialog(), "Leave and deactivate my account"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/org/members/dev-user")).toBe(true);
  });
});

describe("an admin", () => {
  it("can re-role and remove members below ownership, and invite everything but an owner", async () => {
    stubMembersApi("admin");
    // The token says nothing about the org: an admin here with no IdP roles.
    mounted = await mount(<MembersPane />, principalWith([]));
    await flush();
    expect(select("Role of ada@acme.com")).toBeNull(); // an owner is out of reach
    const cyRole = select("Role of cy@acme.com")!;
    expect(selectShown(cyRole)).toBe("Member");
    expect(await optionsOf(cyRole)).toEqual(["Admin", "Member", "Viewer"]);
    expect(buttons()).toContain("Remove cy@acme.com");
    expect(buttons()).not.toContain("Remove ada@acme.com");
    expect(buttons()).toContain("Leave");
    expect(buttons().some((b) => b.startsWith("Transfer ownership"))).toBe(false);
    const inviteForm = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!.form!;
    expect(await optionsOf(labelledSelect(inviteForm, "Role"))).toEqual(["Admin", "Member", "Viewer"]);
    expect(buttons()).toContain("Resend to new@acme.com");
    expect(buttons()).toContain("Revoke invite to new@acme.com");
  });

  it("keeps the action buttons short, with the person named in the accessible name", async () => {
    stubMembersApi("admin");
    mounted = await mount(<MembersPane />, principalWith([]));
    const remove = buttonLabelled(mounted.container, "Remove cy@acme.com");
    expect(remove.textContent).toBe("Remove");
    expect(buttonLabelled(mounted.container, "Resend to new@acme.com").textContent).toBe("Resend");
    expect(buttonLabelled(mounted.container, "Revoke invite to new@acme.com").textContent).toBe("Revoke");
  });

  it("shows names where the API has them, the email otherwise, never a subject id", async () => {
    stubMembersApi("admin");
    mounted = await mount(<MembersPane />, principalWith([]));
    const members = mounted.container.querySelector("ul[aria-label='Members']")!;
    const ada = [...members.querySelectorAll("li")].find((li) => li.textContent?.includes("ada@acme.com"))!;
    expect(ada.textContent).toContain("Ada");
    const invite = mounted.container.querySelector("ul[aria-label='Pending invites'] li")!;
    expect(invite.textContent).toContain("invited by Ada");
    expect(invite.textContent).not.toContain("invited by ada");
    const links = [...mounted.container.querySelectorAll("ul[aria-label='Invite links'] li")];
    expect(links[0].textContent).toContain("made by Ada");
    // dev-user has no name: the email stands in.
    expect(links[1].textContent).toContain("made by dev@localhost");
  });

  it("says what is wrong with the invite address, at the field, before any request", async () => {
    const calls = stubMembersApi("admin");
    mounted = await mount(<MembersPane />, principalWith([]));
    const email = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!;
    submit(email.form!);
    await flush();
    const alert = email.form!.querySelector("[role='alert']")!;
    expect(alert.textContent).toBe("Enter an email address.");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(alert.id);
    setInputValue(email, "not-an-email");
    submit(email.form!);
    await flush();
    expect(email.form!.querySelector("[role='alert']")!.textContent).toBe(
      "Enter an email address like name@example.com.",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("changes a role through the API and reloads", async () => {
    const calls = stubMembersApi("admin", ({ method, url }) =>
      method === "PUT" && url === "/api/org/members/cy/role"
        ? { status: 200, body: { ...MEMBERS[2], role: "admin" } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    await chooseOption(select("Role of cy@acme.com")!, "Admin");
    await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/org/members/cy/role");
    expect(put?.body).toEqual({ role: "admin" });
    expect(calls.filter((c) => c.url === "/api/org/members").length).toBe(2);
  });

  it("removes a member only through the confirmation dialog", async () => {
    const calls = stubMembersApi("admin", ({ method, url }) =>
      method === "DELETE" && url === "/api/org/members/cy" ? noContent() : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    click(buttonLabelled(mounted.container, "Remove cy@acme.com"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    expect(dialog.textContent).toContain("Remove cy@acme.com?");
    click(buttonNamed(dialog, "Remove member"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/org/members/cy")).toBe(true);
  });

  it("sends an invite with the API's body, reports the mail, and revokes one", async () => {
    const calls = stubMembersApi("admin", ({ method, url }) => {
      if (method === "POST" && url === "/api/org/invites") {
        return { status: 201, body: { ...INVITES[0], email: "eve@acme.com", role: "member", mail: "sent" } };
      }
      if (method === "DELETE" && url === `/api/org/invites/${INVITES[0].id}`) return noContent();
      return undefined;
    });
    mounted = await mount(<MembersPane />, principalWith([]));
    const email = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!;
    setInputValue(email, "Eve@acme.com");
    submit(email.form!);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ email: "Eve@acme.com", role: "member" });
    expect(mounted.container.querySelector("[role='status']")?.textContent).toBe(
      "Invitation sent to eve@acme.com.",
    );

    // One click only asks: the invite is revoked from the confirmation.
    click(buttonLabelled(mounted.container, "Revoke invite to new@acme.com"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(dialog().textContent).toContain("Revoke the invite to new@acme.com?");
    click(buttonNamed(dialog(), "Revoke invite"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(INVITES[0].id))).toBe(true);
  });

  it("shows the API's refusal beside the form", async () => {
    stubMembersApi("admin", ({ method, url }) =>
      method === "POST" && url === "/api/org/invites"
        ? { status: 409, body: { detail: "That person is already a member." } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    const email = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!;
    setInputValue(email, "cy@acme.com");
    submit(email.form!);
    await flush();
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toBe(
      "That person is already a member.",
    );
  });

  it("renders a seat refusal as the upgrade prompt, from the headers, not as an alert", async () => {
    // The pane harness's stub carries no headers; the 402's machine half
    // rides in them (entitlement_gate.UpgradeRequired), so this one is
    // stubbed by hand the way lib/api.ts `ourHeaders` reads it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          ({ ok: status < 400, status, statusText: "", headers: new Headers(headers), json: async () => body }) as Response;
        if (method === "POST" && url === "/api/org/invites") {
          return reply(402, { detail: "The Pro plan includes 5 seat(s), and this organisation already has 5." }, {
            "X-MatterWave-Upgrade-Feature": "max_seats",
            "X-MatterWave-Plan": "pro",
            "X-MatterWave-Upgrade-To": "Team",
          });
        }
        if (url === "/api/org/members") return reply(200, { data: MEMBERS, role: "admin", seats: SEATS });
        if (url === "/api/org/invites") return reply(200, { data: INVITES });
        if (url === "/api/org/invite-links") return reply(200, { data: LINKS });
        return reply(404, { detail: `no mock for ${method} ${url}` });
      }),
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    const email = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!;
    setInputValue(email, "six@acme.com");
    submit(email.form!);
    await flush();
    const prompt = mounted.container.querySelector("[data-upgrade-feature='max_seats']")!;
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain("already has 5");
    expect(prompt.textContent).toContain("You are on the pro plan.");
    expect(prompt.textContent).toContain("Team includes this.");
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
  });

  it("resends an invite and reports the mail on its row", async () => {
    const calls = stubMembersApi("admin", ({ method, url }) =>
      method === "POST" && url === `/api/org/invites/${INVITES[0].id}/resend`
        ? { status: 200, body: { ...INVITES[0], mail: "sent" } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    click(buttonLabelled(mounted.container, "Resend to new@acme.com"));
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/resend"))).toBe(true);
    const row = [...mounted.container.querySelectorAll("ul[aria-label='Pending invites'] li")][0];
    expect(row.querySelector("[role='status']")?.textContent).toBe("Invitation re-sent to new@acme.com.");
    // The lists are re-read after the action, and the outcome survives the reload.
    expect(calls.filter((c) => c.url === "/api/org/invites").length).toBe(2);
  });

  it("says when the resend's mail did not go out", async () => {
    stubMembersApi("admin", ({ method, url }) =>
      method === "POST" && url.endsWith("/resend")
        ? { status: 200, body: { ...INVITES[0], mail: "failed", detail: "The invite was created but the mail could not be sent; resend it." } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    click(buttonLabelled(mounted.container, "Resend to new@acme.com"));
    await flush();
    expect(mounted.container.querySelector("[role='status']")?.textContent).toContain("could not be sent");
  });
});

describe("an organisation over its seats", () => {
  it("warns, says why, and switches off both invite forms", async () => {
    stubMembersApi("admin", () => undefined, { used: 2, max: 1, billed: null });
    mounted = await mount(<MembersPane />, principalWith([]));
    const { container } = mounted;
    const warning = container.querySelector("[data-testid='over-capacity']")!;
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toContain("Over capacity: 2 seats are taken on a plan with 1 seat");
    expect(warning.querySelector("a")?.getAttribute("href")).toBe("/pricing");
    expect(seats()).toContain("2 of 1 seat");

    const email = container.querySelector<HTMLInputElement>("input[name='email']")!;
    // The whole form is switched off through its fieldset, the field included.
    expect(email.closest("fieldset")?.disabled).toBe(true);
    expect(buttonNamed(container, "Send invite").disabled).toBe(true);
    const link = container.querySelector<HTMLFormElement>("form[aria-label='Create an invite link']")!;
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(buttonNamed(container, "Create link").disabled).toBe(true);
    // Said once, in the alert; the two switched-off forms do not repeat it.
    expect(container.textContent?.match(/Over capacity/g)).toHaveLength(1);
  });

  it("is only over the cap, never at it or without one", () => {
    expect(inviteBlockedReason({ used: 5, max: 5, billed: null })).toBeNull();
    expect(inviteBlockedReason({ used: 9, max: null, billed: null })).toBeNull();
    expect(inviteBlockedReason({ used: 2, max: 1, billed: null })).toMatch(/^Over capacity: 2 seats/);
  });

  it("keeps the forms on at the cap: the API's refusal names the plan with the seats", async () => {
    stubMembersApi("admin");
    mounted = await mount(<MembersPane />, principalWith([]));
    expect(mounted.container.querySelector("[data-testid='over-capacity']")).toBeNull();
    expect(buttonNamed(mounted.container, "Send invite").disabled).toBe(false);
  });
});

describe("the only owner", () => {
  it("is offered neither Leave nor a role of their own, and told why", async () => {
    const soleOwner: Member[] = [
      { ...MEMBERS[1], role: "owner" }, // dev-user, the caller
      { ...MEMBERS[0], role: "admin" },
      MEMBERS[2],
      MEMBERS[3],
    ];
    stubMembersApi("owner", ({ method, url }) =>
      method === "GET" && url === "/api/org/members"
        ? { status: 200, body: { data: soleOwner, role: "owner", seats: SEATS } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    expect(buttons()).not.toContain("Leave");
    expect(select("Role of dev@localhost")).toBeNull();
    expect(mounted.container.querySelector("[data-testid='sole-owner']")?.textContent).toContain(
      "Transfer ownership to someone before leaving",
    );
    // Everyone else is still theirs to manage, and the hand-over is on the other rows.
    expect(select("Role of ada@acme.com")).not.toBeNull();
    expect(buttons()).toContain("Remove ada@acme.com");
    expect(buttons().filter((b) => b.startsWith("Transfer ownership"))).toEqual([
      "Transfer ownership to ada@acme.com",
      "Transfer ownership to eve@acme.com",
    ]);
  });

  it("can leave once there is another owner", async () => {
    const twoOwners: Member[] = [{ ...MEMBERS[1], role: "owner" }, MEMBERS[0], MEMBERS[2], MEMBERS[3]];
    stubMembersApi("owner", ({ method, url }) =>
      method === "GET" && url === "/api/org/members"
        ? { status: 200, body: { data: twoOwners, role: "owner", seats: SEATS } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    expect(buttons()).toContain("Leave");
    expect(select("Role of dev@localhost")).not.toBeNull();
    expect(mounted.container.querySelector("[data-testid='sole-owner']")).toBeNull();
  });
});

describe("an owner", () => {
  it("can grant ownership and reach other owners", async () => {
    stubMembersApi("owner");
    mounted = await mount(<MembersPane />, principalWith([]));
    const adaRole = select("Role of ada@acme.com")!;
    expect(await optionsOf(adaRole)).toEqual(["Owner", "Admin", "Member", "Viewer"]);
    expect(buttons()).toContain("Remove ada@acme.com");
    const inviteForm = mounted.container.querySelector<HTMLInputElement>("input[name='email']")!.form!;
    expect(await optionsOf(labelledSelect(inviteForm, "Role"))).toEqual(["Owner", "Admin", "Member", "Viewer"]);
  });

  it("is offered a transfer to an active non-owner only: not to an owner, not to themselves, not to an unverified account", async () => {
    stubMembersApi("owner");
    mounted = await mount(<MembersPane />, principalWith([]));
    const transfers = buttons().filter((b) => b.startsWith("Transfer ownership"));
    expect(transfers).toEqual(["Transfer ownership to eve@acme.com"]);
  });

  it("transfers only after the phrase is typed, and the API gets one POST", async () => {
    const calls = stubMembersApi("owner", ({ method, url }) =>
      method === "POST" && url === "/api/org/members/eve/transfer-ownership"
        ? { status: 200, body: { ...MEMBERS[3], role: "owner" } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    click(buttonLabelled(mounted.container, "Transfer ownership to eve@acme.com"));
    await flush();
    expect(dialog().textContent).toContain("Transfer ownership to eve@acme.com?");
    const confirm = buttonNamed(dialog(), "Transfer ownership");
    expect(confirm.disabled).toBe(true);
    click(confirm);
    await flush();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    setInputValue(dialog().querySelector("input")!, "Transfer Ownership");
    expect(confirm.disabled).toBe(false);
    click(confirm);
    await flush();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual(["/api/org/members/eve/transfer-ownership"]);
    expect(calls.filter((c) => c.url === "/api/org/members").length).toBe(2);
  });
});

describe("the invite link card", () => {
  function linkRows(): HTMLLIElement[] {
    return [...mounted!.container.querySelectorAll<HTMLLIElement>("ul[aria-label='Invite links'] li")];
  }

  function linkForm(): HTMLFormElement {
    return mounted!.container.querySelector<HTMLFormElement>("form[aria-label='Create an invite link']")!;
  }

  it.each<OrgRole>(["member", "viewer"])("is not shown to a %s, and the links are never asked for", async (role) => {
    const calls = stubMembersApi(role);
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(mounted.container.textContent).not.toContain("Invite link");
    expect(calls.some((c) => c.url === "/api/org/invite-links")).toBe(false);
  });

  it("lists each link with its role, its uses and its state, and offers no owner link even to an owner", async () => {
    stubMembersApi("owner");
    mounted = await mount(<MembersPane />, principalWith([]));
    const rows = linkRows().map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("as Member");
    expect(rows[0]).toContain("2 of 10 uses");
    expect(rows[0]).toContain("expires");
    expect(rows[1]).toContain("1 of 1 use ·");
    expect(rows[1]).toContain("used up");
    const role = labelledSelect(linkForm(), "Role");
    expect(selectShown(role)).toBe("Member");
    expect(await optionsOf(role)).toEqual(["Admin", "Member", "Viewer"]);
  });

  it("creates a link with the chosen role, uses and expiry, shows it once, and copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const url = "https://app.example.com/join?link=tok-new";
    const calls = stubMembersApi("admin", ({ method, url: path }) =>
      method === "POST" && path === "/api/org/invite-links"
        ? { status: 201, body: { ...LINKS[0], id: "new", role: "viewer", max_uses: 25, uses: 0, token: "tok-new", url } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    expect(mounted.container.querySelector("[data-testid='new-invite-link']")).toBeNull();
    const form = linkForm();
    await chooseOption(labelledSelect(form, "Role"), "Viewer");
    setInputValue(form.querySelector<HTMLInputElement>("input[name='max_uses']")!, "25");
    await chooseOption(labelledSelect(form, "Expires after"), "30 days");
    submit(form);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/org/invite-links");
    expect(post?.body).toEqual({ role: "viewer", max_uses: 25, expires_in_days: 30 });

    const shown = mounted.container.querySelector("[data-testid='new-invite-link']")!;
    expect(shown.querySelector("input")?.value).toBe(url);
    click(buttonNamed(shown, "Copy link"));
    await flush();
    expect(writeText).toHaveBeenCalledWith(url);
    expect(buttonNamed(shown, "Copied")).toBeDefined();
    // The list is re-read after the create, so the new uses count is the API's.
    expect(calls.filter((c) => c.url === "/api/org/invite-links" && c.method === "GET").length).toBe(2);
  });

  it("revokes a link with a DELETE and reloads the list", async () => {
    const calls = stubMembersApi("admin", ({ method, url }) =>
      method === "DELETE" && url === `/api/org/invite-links/${LINKS[0].id}` ? noContent() : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    click(buttonNamed(linkRows()[0], "Revoke link"));
    await flush();
    // The click asks first: a revoked link cannot be brought back.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(dialog().textContent).toContain("Revoke this invite link?");
    click(buttonNamed(dialog(), "Revoke link"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/org/invite-links/${LINKS[0].id}`)).toBe(true);
    expect(calls.filter((c) => c.url === "/api/org/invite-links" && c.method === "GET").length).toBe(2);
  });

  it("shows the API's refusal in the card, and nothing is shown to copy", async () => {
    stubMembersApi("admin", ({ method, url }) =>
      method === "POST" && url === "/api/org/invite-links"
        ? { status: 422, body: { detail: "Ownership is never granted by link; invite an owner by email." } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    submit(linkForm());
    await flush();
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toContain("never granted by link");
    expect(mounted.container.querySelector("[data-testid='new-invite-link']")).toBeNull();
  });

  it("keeps the rest of the pane working when the links cannot be loaded", async () => {
    stubMembersApi("admin", ({ method, url }) =>
      method === "GET" && url === "/api/org/invite-links"
        ? { status: 500, body: { detail: "The links are unavailable." } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith([]));
    expect(mounted.container.querySelector("ul[aria-label='Members']")).not.toBeNull();
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toContain("unavailable");
  });
});

describe("finding a member", () => {
  function rowEmails(): string[] {
    const list = mounted!.container.querySelector("ul[aria-label='Members']")!;
    return [...list.querySelectorAll("li")].map(
      (li) => li.querySelector("[data-testid='member-email']")?.textContent ?? "",
    );
  }
  function filter(): HTMLInputElement {
    return mounted!.container.querySelector<HTMLInputElement>("input[aria-label='Filter members']")!;
  }
  function lastActive(email: string): string {
    const list = mounted!.container.querySelector("ul[aria-label='Members']")!;
    const row = [...list.querySelectorAll("li")].find((li) => li.textContent?.includes(email))!;
    return row.querySelector("[data-testid='last-active']")?.textContent ?? "";
  }

  it("filters on email, name or role, case-insensitively", async () => {
    stubMembersApi("viewer");
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    setInputValue(filter(), "ACME");
    expect(rowEmails()).toEqual(["ada@acme.com", "cy@acme.com", "eve@acme.com"]);
    setInputValue(filter(), "cy");
    expect(rowEmails()).toEqual(["cy@acme.com"]);
    setInputValue(filter(), "admin");
    expect(rowEmails()).toEqual(["dev@localhost"]);
    setInputValue(filter(), "nobody");
    expect(rowEmails()).toEqual([]);
    // A miss names the filter, so it does not read as an empty organisation.
    expect(mounted.container.textContent).toContain('No members match "nobody".');
    expect(mounted.container.textContent).not.toContain("No members yet");
  });

  it("says there are no members yet when the list itself is empty, not that a filter missed", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/members") {
        return { status: 200, body: { data: [], role: "viewer", seats: SEATS } };
      }
      if (method === "GET" && url === "/api/org/invites") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(mounted.container.textContent).toContain("No members yet.");
    expect(mounted.container.textContent).toContain("No invites yet.");
    expect(mounted.container.textContent).not.toContain("match");
  });

  it("sorts by name by default and by last active on request, the never-seen last", async () => {
    stubMembersApi("viewer");
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(rowEmails()).toEqual(["ada@acme.com", "cy@acme.com", "dev@localhost", "eve@acme.com"]);
    await chooseOption(select("Sort members")!, "Sort by last active");
    expect(rowEmails()).toEqual(["dev@localhost", "ada@acme.com", "eve@acme.com", "cy@acme.com"]);
  });

  it("says Never active for someone who has not signed in, and a local date for the rest", async () => {
    stubMembersApi("viewer");
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(lastActive("cy@acme.com")).toBe("Never active");
    const expected = new Date("2026-10-10T12:00:00Z").toLocaleDateString(undefined, { dateStyle: "medium" });
    expect(lastActive("ada@acme.com")).toBe(`Active ${expected}`);
  });

  it("says Active today, in the positive tone, for someone seen today", async () => {
    const seenNow: Member[] = MEMBERS.map((m) =>
      m.email === "ada@acme.com" ? { ...m, last_seen_at: new Date().toISOString() } : m,
    );
    stubMembersApi("viewer", ({ method, url }) =>
      method === "GET" && url === "/api/org/members"
        ? { status: 200, body: { data: seenNow, role: "viewer", seats: SEATS } }
        : undefined,
    );
    mounted = await mount(<MembersPane />, principalWith(["user"]));
    expect(lastActive("ada@acme.com")).toBe("Active today");
  });
});
