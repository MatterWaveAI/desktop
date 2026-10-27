import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgSummary } from "../../../types";
import { ShellContext, type ShellContextValue } from "../../../shell/shellContext";
import { jsonResponse } from "../../../shell/frontDoorHarness";
import { CloseOrgSection } from "./OrganisationPane";

/**
 * The Organisation pane's danger card: owners only, the org's name typed to
 * confirm, one POST /api/org/close with that name, then signed out; a
 * refusal is shown in the dialog and the session stays.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const ORG: OrgSummary = {
  id: "org-1",
  name: "Acme Ltd",
  created_at: "2026-09-28T00:00:00Z",
  role: "owner",
};

function shellValue(signOut: () => Promise<void>): ShellContextValue {
  return {
    authConfig: { auth_mode: "oidc", csrf_cookie: "mw_csrf", default_model: "m" },
    principal: {
      subject: "ada",
      kind: "user",
      email: "ada@acme.com",
      name: null,
      roles: [],
      org_id: "org-1",
      org_name: ORG.name,
      org_role: "owner",
    },
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut,
  };
}

async function render(org: OrgSummary, signOut = vi.fn(async () => {})): Promise<typeof signOut> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ShellContext.Provider value={shellValue(signOut)}>
        <CloseOrgSection org={org} />
      </ShellContext.Provider>,
    );
  });
  return signOut;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(found, `a button "${label}"`).toBeDefined();
  return found!;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-slot='dialog-content']");
  expect(found, "an open dialog").not.toBeNull();
  return found!;
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openAndType(value: string): Promise<HTMLButtonElement> {
  await act(async () => {
    button(container!, "Close organisation…").click();
  });
  const input = dialog().querySelector("input")!;
  await act(async () => {
    type(input, value);
  });
  return button(dialog(), "Close organisation");
}

describe("CloseOrgSection", () => {
  it("is not shown to an admin", async () => {
    await render({ ...ORG, role: "admin" });
    expect(container!.textContent).toBe("");
  });

  it("stays disabled until the org's name is typed, then closes and signs out", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "closed" }));
    vi.stubGlobal("fetch", fetchMock);
    const signOut = await render(ORG);
    expect(container!.textContent).toContain("Close organisation");

    const wrong = await openAndType("Acme");
    expect(wrong.disabled).toBe(true);

    await act(async () => {
      type(dialog().querySelector("input")!, "Acme Ltd");
    });
    const confirm = button(dialog(), "Close organisation");
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/org/close");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ confirm: "Acme Ltd" });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal and keeps the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { detail: "This organisation is under a legal hold and cannot be closed. Contact support." },
          409,
        ),
      ),
    );
    const signOut = await render(ORG);
    const confirm = await openAndType("Acme Ltd");
    await act(async () => {
      confirm.click();
    });
    expect(dialog().textContent).toContain("legal hold");
    expect(signOut).not.toHaveBeenCalled();
  });
});
