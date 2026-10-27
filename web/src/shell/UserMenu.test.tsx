import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { DEVELOPERS_PATH } from "./frontDoor";
import { HELP_PATH } from "./help";
import { reloadAsSwitchedAccount } from "../lib/accounts";
import { ShellContext, type ShellContextValue } from "./shellContext";
import { UserMenu } from "./UserMenu";

// A switch ends in a full navigation jsdom cannot perform.
vi.mock("../lib/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/accounts")>();
  return { ...actual, reloadAsSwitchedAccount: vi.fn() };
});

/**
 * The account menu names the org a person belongs to and never shows
 * them its id. Same harness as conversationSidebar.test.tsx: react-dom
 * plus act, no testing-library, a hand-built shell context. The menu is
 * portalled, so its content is looked for on the document once opened.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    subject: "dev-user",
    kind: "user",
    email: "dev@example.com",
    name: "Dev",
    roles: [],
    org_id: "0f3c1c2e-5b7a-7d1e-8a9b-0c1d2e3f4a5b",
    org_name: "Acme",
    org_role: "member",
    ...over,
  };
}

type Accounts = { accounts: Record<string, unknown>[]; max: number; room: boolean } | null;

/** `/api/billing/status`, `/api/models` and `/api/accounts`, as the menu reads them on open. */
function stubApi(plan: { plan: string; plan_name: string } | null, accounts: Accounts = null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      let body: unknown = { detail: "no such route" };
      let status = 404;
      if (url === "/api/billing/status" && plan !== null) {
        body = plan;
        status = 200;
      } else if (url === "/api/accounts" && accounts !== null) {
        body = accounts;
        status = 200;
      } else if (url === "/api/accounts/switch" && init?.method === "POST") {
        body = { status: "ok", subject: "ada", email: "ada@acme.com" };
        status = 200;
      } else if (url === "/api/accounts/1/logout" && init?.method === "POST") {
        body = { status: "ok" };
        status = 200;
      } else if (url === "/api/models") {
        body = { object: "list", data: [{ id: "fake-mini", label: "GRT Nano" }], default_model: "fake-mini" };
        status = 200;
      }
      return Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
}

async function render(who: Principal, onOpenPalette?: () => void): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    authConfig: { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "fake-mini" } as AuthConfig,
    principal: who,
    signOut: async () => {},
  } as unknown as ShellContextValue;
  await act(async () => {
    root!.render(
      <ShellContext.Provider value={value}>
        <UserMenu onOpenPalette={onOpenPalette} />
      </ShellContext.Provider>,
    );
  });
}

/** Open the menu and let the two reads it makes settle. */
async function open(): Promise<HTMLElement> {
  const trigger = container!.querySelector<HTMLElement>('[aria-label="Account and organisation"]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return document.querySelector<HTMLElement>("[data-mw-user-menu]")!;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  try {
    localStorage.removeItem("mw-theme");
  } catch {
    // private mode
  }
});

describe("UserMenu", () => {
  it("names the org and never shows its id", async () => {
    stubApi(null);
    await render(principal());
    const menu = await open();
    expect(menu.textContent).toContain("dev@example.com");
    expect(menu.textContent).toContain("Acme");
    expect(menu.textContent).not.toContain("0f3c1c2e");
    // The caption says what the lines under it are, in words.
    expect(menu.textContent).toContain("Signed in as");
    expect(menu.textContent).not.toMatch(/account — org/i);
  });

  it("shows the email alone for a principal with no org name, not a uuid or a placeholder", async () => {
    stubApi(null);
    await render(principal({ org_name: null }));
    const menu = await open();
    expect(menu.textContent).toContain("dev@example.com");
    expect(menu.textContent).not.toContain("0f3c1c2e");
    expect(menu.textContent).not.toMatch(/no org/i);
  });

  it("links settings, the developer pages and help, in that order", async () => {
    stubApi(null);
    await render(principal());
    const menu = await open();
    const links = [...menu.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Settings", "/settings/account"],
      ["Developers", DEVELOPERS_PATH],
      ["Help", HELP_PATH],
    ]);
    expect(HELP_PATH).toBe("/help");
  });

  it("names the default model by its label, never its id", async () => {
    stubApi(null);
    await render(principal());
    const menu = await open();
    expect(menu.querySelector("[data-mw-default-model]")?.textContent).toBe("Default model: GRT Nano");
    expect(menu.textContent).not.toContain("fake-mini");
  });

  it("offers Upgrade on the free plan and Manage billing on a paid one", async () => {
    stubApi({ plan: "free", plan_name: "Free" });
    await render(principal());
    let plan = (await open()).querySelector("[data-mw-plan]")!;
    expect(plan.textContent).toContain("Free plan");
    expect(plan.querySelector("a")?.textContent).toBe("Upgrade");
    expect(plan.querySelector("a")?.getAttribute("href")).toBe("/pricing");

    act(() => root?.unmount());
    container?.remove();
    stubApi({ plan: "pro", plan_name: "Pro" });
    await render(principal());
    plan = (await open()).querySelector("[data-mw-plan]")!;
    expect(plan.textContent).toContain("Pro plan");
    expect(plan.querySelector("a")?.textContent).toBe("Manage billing");
    expect(plan.querySelector("a")?.getAttribute("href")).toBe("/settings/billing");
  });

  it("says nothing about the plan when billing cannot be read", async () => {
    stubApi(null);
    await render(principal());
    const menu = await open();
    expect(menu.querySelector("[data-mw-plan]")).toBeNull();
  });

  it("Commands is a button that opens the palette and closes the menu", async () => {
    stubApi(null);
    const onOpenPalette = vi.fn();
    await render(principal(), onOpenPalette);
    const menu = await open();
    const commands = [...menu.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Commands"),
    )!;
    expect(commands.querySelector("kbd")?.textContent).toMatch(/Ctrl\+K|⌘K/);
    await act(async () => {
      commands.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-mw-user-menu]")).toBeNull();
  });

  it("switches the theme between system, light and dark", async () => {
    stubApi(null);
    await render(principal());
    const menu = await open();
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("[aria-pressed]")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["System", "Light", "Dark"]);
    // Dark is the default with nothing stored.
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    const after = [...menu.querySelectorAll<HTMLButtonElement>("[aria-pressed]")];
    expect(after.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    await act(async () => {
      after[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("system");
  });
});


describe("UserMenu: several accounts on this browser", () => {
  const ADA = { slot: 1, current: false, subject: "ada", email: "ada@acme.com", name: "Ada", org_name: "Acme" };
  const ME = { slot: 0, current: true, subject: "dev-user", email: "dev@example.com", name: "Dev", org_name: "Acme" };

  async function settled(menu: HTMLElement): Promise<void> {
    await vi.waitFor(() => {
      expect(menu.querySelector("[data-mw-accounts]")).not.toBeNull();
    });
  }

  it("offers Add account alone when nobody else is signed in", async () => {
    stubApi(null, { accounts: [ME], max: 4, room: true });
    await render(principal());
    const menu = await open();
    await vi.waitFor(() => {
      expect(menu.querySelector("[data-mw-add-account]")).not.toBeNull();
    });
    expect(menu.querySelector("[data-mw-add-account]")?.getAttribute("href")).toBe(
      "/api/auth/login?add=true",
    );
    expect(menu.querySelector("[data-mw-accounts]")).toBeNull();
    expect(menu.textContent).not.toContain("Sign out of all accounts");
  });

  it("lists the other accounts apart from the acting one, and switches in one click", async () => {
    stubApi(null, { accounts: [ME, ADA], max: 4, room: true });
    await render(principal());
    const menu = await open();
    await settled(menu);
    const list = menu.querySelector("[data-mw-accounts]")!;
    expect(list.textContent).toContain("ada@acme.com");
    // The acting account is named above the list, never inside it.
    expect(list.textContent).not.toContain("dev@example.com");
    expect(menu.textContent).toContain("Signed in as");

    const switchButton = list.querySelector<HTMLButtonElement>('[aria-label="Switch to ada@acme.com"]')!;
    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(reloadAsSwitchedAccount).toHaveBeenCalled();
    });
    const posted = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/accounts/switch")!;
    expect(JSON.parse(String((posted[1] as RequestInit).body))).toEqual({ slot: 1 });
  });

  it("signs one other account out without touching the acting one, and offers to sign out of all", async () => {
    stubApi(null, { accounts: [ME, ADA], max: 4, room: true });
    await render(principal());
    const menu = await open();
    await settled(menu);
    expect(menu.textContent).toContain("Sign out of all accounts");
    const out = menu.querySelector<HTMLButtonElement>('[aria-label="Sign out ada@acme.com"]')!;
    await act(async () => {
      out.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(menu.querySelector("[data-mw-accounts]")).toBeNull();
    });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/accounts/1/logout")).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/logout")).toBe(false);
  });

  it("hides Add account when the browser is full", async () => {
    stubApi(null, { accounts: [ME, ADA], max: 2, room: false });
    await render(principal());
    const menu = await open();
    await settled(menu);
    expect(menu.querySelector("[data-mw-add-account]")).toBeNull();
  });
});
