import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../types";
import { JoinPage } from "./JoinPage";
import { VerifyPage } from "./VerifyPage";
import { JOIN_PATH, VERIFY_PATH } from "./frontDoor";
import { ShellContext, type ShellContextValue } from "./shellContext";
import {
  alertText,
  authConfig,
  buttonNamed,
  callTo,
  cleanup,
  click,
  currentLocation,
  fill,
  jsonResponse,
  mount,
  stubApi,
  submit,
  view,
  type Answer,
} from "./frontDoorHarness";

/**
 * The invite landing: a stranger gets the signup form with the address
 * locked and the token in the body; a signed-in person with the invited
 * email accepts in one click; anyone else is told whose invite it is; and
 * a link the API refuses says so instead of showing a form.
 */

const LOOKUP = {
  org_name: "Acme",
  email: "eve@acme.com",
  role: "admin",
  expires_at: "2026-10-05T00:00:00+00:00",
  status: "pending",
};

function principal(email: string | null): Principal {
  return {
    subject: "eve",
    kind: "user",
    email,
    name: null,
    roles: [],
    org_id: "org-a",
    org_name: null,
    org_role: "member",
  };
}

function shellValue(email: string | null): ShellContextValue {
  return {
    authConfig,
    principal: principal(email),
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    // Pin, archive and the list filter. Inert here -- these harnesses
    // mount panes that never touch the conversation list.
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: vi.fn(async () => {}),
  };
}

function mountAnonymous(token = "tok-1"): Promise<void> {
  return mount(`${JOIN_PATH}?token=${token}`, { [JOIN_PATH]: JoinPage, [VERIFY_PATH]: VerifyPage });
}

function mountSignedIn(email: string | null): { shell: ShellContextValue; ready: Promise<void> } {
  const shell = shellValue(email);
  const Page = () => (
    <ShellContext.Provider value={shell}>
      <JoinPage />
    </ShellContext.Provider>
  );
  return { shell, ready: mount(`${JOIN_PATH}?token=tok-1`, { [JOIN_PATH]: Page }) };
}

function stubJoin(lookup: Answer, extra: Record<string, Answer> = {}) {
  return stubApi({ "/api/org/invites/lookup": lookup, ...extra });
}

afterEach(cleanup);

describe("a stranger with an invite link", () => {
  it("gets the signup form with the invited address locked, and the token goes in the body", async () => {
    const fetchMock = stubJoin(jsonResponse(LOOKUP), {
      "/api/signup": jsonResponse({ status: "pending_verification", email: "eve@acme.com" }, 202),
    });
    await mountAnonymous();
    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Join Acme");
    });
    expect(callTo(fetchMock, "/api/org/invites/lookup").body).toEqual({ token: "tok-1" });
    expect(view().textContent).toContain("invited to Acme as admin");

    const email = view().querySelector<HTMLInputElement>("input[name='email']")!;
    expect(email.value).toBe("eve@acme.com");
    expect(email.readOnly).toBe(true);

    fill({
      first_name: "Eve",
      last_name: "Adams",
      password: "correct horse battery",
      password_confirm: "correct horse battery",
      accept_terms: true,
    });
    await submit();
    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(VERIFY_PATH);
    });
    const { body } = callTo(fetchMock, "/api/signup");
    expect(body).toMatchObject({ email: "eve@acme.com", invite_token: "tok-1" });
  });

  it("shows the API's refusal for an unknown link, and no form", async () => {
    stubJoin(jsonResponse({ detail: "This invite link is not valid." }, 404));
    await mountAnonymous("bogus");
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain("This invite link is not valid.");
    expect(view().querySelector("form")).toBeNull();
  });

  it("says why a spent or expired link cannot be used", async () => {
    stubJoin(jsonResponse({ ...LOOKUP, status: "expired" }));
    await mountAnonymous();
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain("expired");
    expect(view().querySelector("form")).toBeNull();
  });

  it("refuses a link with no token without asking the API", async () => {
    const fetchMock = stubJoin(jsonResponse(LOOKUP));
    await mount(JOIN_PATH, { [JOIN_PATH]: JoinPage });
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain("missing its token");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("/api/org/invites/lookup");
  });
});

describe("a signed-in person", () => {
  it("with the invited email accepts in one click", async () => {
    const fetchMock = stubJoin(jsonResponse(LOOKUP), {
      "/api/org/invites/accept": jsonResponse({ subject: "eve", role: "admin" }),
    });
    await mountSignedIn("Eve@acme.com").ready;
    await vi.waitFor(() => {
      expect(buttonNamed("Join Acme")).toBeDefined();
    });
    expect(view().querySelector("form")).toBeNull();
    await click(buttonNamed("Join Acme")!);
    await vi.waitFor(() => {
      expect(view().textContent).toContain("You are now an admin of Acme.");
    });
    expect(callTo(fetchMock, "/api/org/invites/accept").body).toEqual({ token: "tok-1" });
    expect(view().querySelector("a[href='/apps/chat']")).not.toBeNull();
  });

  it("with another email is told whose invite it is, with a way to sign out", async () => {
    stubJoin(jsonResponse(LOOKUP));
    const { shell } = mountSignedIn("someone@else.com");
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain("sent to eve@acme.com");
    expect(alertText()).toContain("signed in as someone@else.com");
    expect(buttonNamed("Join Acme")).toBeUndefined();
    await click(buttonNamed("Sign out")!);
    expect(shell.signOut).toHaveBeenCalledTimes(1);
  });

  it("shows the API's 409 when the account belongs to another organisation", async () => {
    const detail =
      "Your account already belongs to another organization. One account belongs to one organization.";
    stubJoin(jsonResponse(LOOKUP), { "/api/org/invites/accept": jsonResponse({ detail }, 409) });
    await mountSignedIn("eve@acme.com").ready;
    await vi.waitFor(() => {
      expect(buttonNamed("Join Acme")).toBeDefined();
    });
    await click(buttonNamed("Join Acme")!);
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain(detail);
    expect(buttonNamed("Join Acme")).toBeDefined(); // still there: the person may retry after signing out
  });
});

// --- shareable invite links: /join?link= ----------------------------------------------------

const LINK_LOOKUP = {
  org_name: "Acme",
  role: "viewer",
  expires_at: "2026-10-05T00:00:00+00:00",
  status: "active",
};
const LINK_TOKEN = "lnk-1";
const LINK_LOOKUP_PATH = "/api/join/lookup";
const LINK_JOIN_PATH = "/api/join";

/** The link's lookup and its join, each a POST with the token in the body. */
function stubLink(
  lookup: Record<string, unknown>,
  join: Record<string, unknown> = jsonResponse({ subject: "eve", role: "viewer" }),
  extra: Record<string, Record<string, unknown>> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth-config") return jsonResponse(authConfig);
    if (url === LINK_LOOKUP_PATH) return lookup;
    if (url === LINK_JOIN_PATH) return join;
    return extra[url] ?? jsonResponse({ detail: `no mock for ${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Which of the link's two calls were made, in order. Each must be a POST
 * carrying the token in its body: in the path it would land in access logs.
 */
function linkCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([input]) => [LINK_LOOKUP_PATH, LINK_JOIN_PATH].includes(String(input)))
    .map(([input, init]) => {
      const req = init as RequestInit | undefined;
      expect(req?.method).toBe("POST");
      expect(JSON.parse(String(req?.body))).toEqual({ token: LINK_TOKEN });
      return String(input) === LINK_LOOKUP_PATH ? "lookup" : "join";
    });
}

async function mountLinkSignedIn(email: string | null): Promise<ShellContextValue> {
  const shell = shellValue(email);
  const Page = () => (
    <ShellContext.Provider value={shell}>
      <JoinPage />
    </ShellContext.Provider>
  );
  await mount(`${JOIN_PATH}?link=lnk-1`, { [JOIN_PATH]: Page });
  return shell;
}

describe("a stranger with a shareable invite link", () => {
  it("gets the signup form with the address open, and the link's token goes in the body", async () => {
    const fetchMock = stubLink(jsonResponse(LINK_LOOKUP), jsonResponse({}, 405), {
      "/api/signup": jsonResponse({ status: "pending_verification", email: "sam@acme.com" }, 202),
    });
    await mount(`${JOIN_PATH}?link=lnk-1`, { [JOIN_PATH]: JoinPage, [VERIFY_PATH]: VerifyPage });
    await vi.waitFor(() => {
      expect(view().querySelector("h1")?.textContent).toBe("Join Acme");
    });
    expect(linkCalls(fetchMock)).toEqual(["lookup"]);
    expect(view().textContent).toContain("invited to Acme as viewer");
    const email = view().querySelector<HTMLInputElement>("input[name='email']")!;
    expect(email.readOnly).toBe(false);
    expect(email.value).toBe("");

    fill({
      first_name: "Sam",
      last_name: "Lee",
      email: "sam@acme.com",
      password: "correct horse battery",
      password_confirm: "correct horse battery",
      accept_terms: true,
    });
    await submit();
    await vi.waitFor(() => {
      expect(currentLocation().pathname).toBe(VERIFY_PATH);
    });
    const { body } = callTo(fetchMock, "/api/signup");
    expect(body).toMatchObject({ email: "sam@acme.com", invite_link_token: "lnk-1" });
    expect(body).not.toHaveProperty("invite_token");
    // Never joined directly: the signup is the join for a stranger.
    expect(linkCalls(fetchMock)).toEqual(["lookup"]);
  });

  it.each([
    ["used_up", "used up"],
    ["expired", "expired"],
  ])("says a link whose status is %s cannot be used, with no form", async (status, words) => {
    stubLink(jsonResponse({ ...LINK_LOOKUP, status }));
    await mount(`${JOIN_PATH}?link=lnk-1`, { [JOIN_PATH]: JoinPage });
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain(words);
    expect(view().querySelector("form")).toBeNull();
  });

  it("shows the API's refusal for a revoked or unknown link", async () => {
    stubLink(jsonResponse({ detail: "This invite link is not valid." }, 404));
    await mount(`${JOIN_PATH}?link=lnk-1`, { [JOIN_PATH]: JoinPage });
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain("This invite link is not valid.");
    expect(view().querySelector("form")).toBeNull();
  });
});

describe("a signed-in person with a shareable invite link", () => {
  it("joins in one click with a POST to the link", async () => {
    const fetchMock = stubLink(jsonResponse(LINK_LOOKUP));
    await mountLinkSignedIn("eve@acme.com");
    await vi.waitFor(() => {
      expect(buttonNamed("Join Acme")).toBeDefined();
    });
    await click(buttonNamed("Join Acme")!);
    await vi.waitFor(() => {
      expect(view().textContent).toContain("You are now a viewer of Acme.");
    });
    expect(linkCalls(fetchMock)).toEqual(["lookup", "join"]);
  });

  it("shows the API's 409 for an account in another organisation, with a way to sign out", async () => {
    const detail =
      "Your account already belongs to another organization. One account belongs to one organization.";
    stubLink(jsonResponse(LINK_LOOKUP), jsonResponse({ detail }, 409));
    const shell = await mountLinkSignedIn("eve@else.com");
    await vi.waitFor(() => {
      expect(buttonNamed("Join Acme")).toBeDefined();
    });
    await click(buttonNamed("Join Acme")!);
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(alertText()).toContain(detail);
    await click(buttonNamed("Sign out")!);
    expect(shell.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("an invite that cannot be used", () => {
  function links(): string[] {
    return Array.from(view().querySelectorAll("a")).map((a) => `${a.textContent}|${a.getAttribute("href")}`);
  }

  it.each([
    ["an expired mailed invite", () => stubJoin(jsonResponse({ ...LOOKUP, status: "expired" })), "token=tok-1"],
    ["a refused mailed invite", () => stubJoin(jsonResponse({ detail: "Not valid." }, 404)), "token=tok-1"],
    ["a used-up link", () => stubLink(jsonResponse({ ...LINK_LOOKUP, status: "used_up" })), "link=lnk-1"],
    ["a refused link", () => stubLink(jsonResponse({ detail: "Not valid." }, 404)), "link=lnk-1"],
  ])("%s offers sign in, home, and asking for a new link", async (_name, stub, query) => {
    stub();
    await mount(`${JOIN_PATH}?${query}`, { [JOIN_PATH]: JoinPage });
    await vi.waitFor(() => {
      expect(view().querySelector("[role='alert']")).not.toBeNull();
    });
    expect(view().textContent).toContain("Ask the person who invited you for a new link.");
    expect(links()).toContain("Go to sign in|/login");
    expect(links()).toContain("Go to MatterWave|/");
    // Announced, not focused: a focus ring round the whole page on load
    // reads as something to fix.
    expect(document.activeElement).not.toBe(view().querySelector("[role='alert']"));
  });
});
