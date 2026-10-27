import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../../types";
import { RouterContextProvider } from "@tanstack/react-router";
import { router } from "../../routes";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { DestructiveConfirm } from "../../patterns";
import { SettingsPage } from "./SettingsPage";
import { PaneActions } from "./paneActions";
import { paneComponents } from "./paneComponents";
import { settingsPanes } from "./panes";

/**
 * Every pane is reachable by URL, and deletion cannot fire
 * without its confirmation. Same harness as registry.test.tsx — react-dom
 * directly, no testing library.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const authConfig: AuthConfig = {
  auth_mode: "none",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
};

const principal: Principal = {
  subject: "dev-user",
  kind: "dev",
  email: "dev@localhost",
  name: null,
  roles: [],
  org_id: "dev-org",
  org_name: null,
  org_role: null,
};

function shellValue(): ShellContextValue {
  return {
    authConfig,
    principal,
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
    signOut: async () => {},
  };
}

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    // Wrapped in the router because the tab nav uses TanStack `Link`, which
    // needs one. `Link` rather than a raw anchor is what keeps a tab switch
    // a client-side navigation instead of a full document load; see
    // SettingsPage.tsx. RouterContextProvider mounts the context WITHOUT
    // taking over rendering, so these tests still render the pane directly.
    root!.render(
      <RouterContextProvider router={router}>
        <ShellContext.Provider value={shellValue()}>{node}</ShellContext.Provider>
      </RouterContextProvider>,
    );
  });
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

/** Walk a TanStack route tree and collect every route's `fullPath`. */
function routePaths(node: unknown): string[] {
  const n = node as { fullPath?: unknown; children?: readonly unknown[] };
  const own = typeof n.fullPath === "string" ? [n.fullPath] : [];
  const kids = Array.isArray(n.children) ? (n.children as readonly unknown[]) : [];
  return [...own, ...kids.flatMap(routePaths)];
}

describe("the settings route", () => {
  it("registers /settings and a per-pane deep link", () => {
    const paths = routePaths(router.routeTree);
    expect(paths).toContain("/settings");
    expect(paths).toContain("/settings/$paneId");
  });

  it("declares every platform pane in nav order, with billing beside budget rather than inside it", () => {
    expect(settingsPanes.map((pane) => pane.id)).toEqual([
      "account",
      "preferences",
      "instructions",
      "data",
      "organisation",
      "members",
      "webhooks",
      "keys",
      "devices",
      "usage",
      // Billing sits beside Budget, not inside it (panes.ts says why).
      "budget",
      "billing",
    ]);
  });
});

describe("the pane components", () => {
  it("has a component for every pane the nav lists", () => {
    for (const pane of settingsPanes) expect(paneComponents[pane.id], pane.id).toBeDefined();
  });

  it("keeps a crashing pane inside its own boundary, with the nav still there", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = paneComponents.data;
    paneComponents.data = () => {
      throw new Error("boom");
    };
    try {
      render(<SettingsPage paneId="data" />);
      expect(container!.textContent).toContain("Data stopped working");
      expect(container!.querySelector("nav[aria-label='Settings sections']")).not.toBeNull();
    } finally {
      paneComponents.data = original;
    }
  });
});

describe("the section nav", () => {
  it("groups the panes under a heading each, in the panes' order", () => {
    render(<SettingsPage paneId="members" />);
    const nav = container!.querySelector("nav[data-layout='side']")!;
    expect(nav.getAttribute("aria-label")).toBe("Settings sections");
    const groups = [...nav.querySelectorAll("[role='group']")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "You",
      "Organisation",
      "Plan and usage",
    ]);
    expect(groups[1].querySelector("a[aria-current='page']")?.textContent).toBe("Members");
  });

  it("leads back to the chat above the groups", () => {
    render(<SettingsPage paneId="members" />);
    const nav = container!.querySelector("nav[data-layout='side']")!;
    const back = nav.querySelector("a")!;
    expect(back.textContent).toBe("Back to chat");
    expect(back.getAttribute("href")).toBe("/");
    // Outside the groups, so each group still lists only its panes.
    expect(back.closest("[role='group']")).toBeNull();
  });

  it("is one scrolling row on a narrow screen, never wrapping onto more rows", () => {
    render(<SettingsPage paneId="account" />);
    const strip = container!.querySelector("nav[data-slot='tab-strip'] > div")!;
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).not.toContain("flex-wrap");
    for (const link of strip.querySelectorAll("a")) {
      expect(link.className).toContain("whitespace-nowrap");
    }
  });

  it("keeps the group headings in the strip, each before its first tab", () => {
    render(<SettingsPage paneId="members" />);
    const strip = container!.querySelector("nav[data-slot='tab-strip'] > div")!;
    const labels = [...strip.querySelectorAll("[data-slot='tab-strip-group']")];
    expect(labels.map((l) => l.textContent)).toEqual(["You", "Organisation", "Plan and usage"]);
    // Each label sits directly before the first tab of its group.
    expect(labels[1].nextElementSibling?.textContent).toBe("Organisation");
    expect(labels[2].nextElementSibling?.textContent).toBe("Usage");
    // Decoration for sighted readers; the side nav's role=group carries the structure.
    for (const label of labels) expect(label.getAttribute("aria-hidden")).toBe("true");
    // The active item is still found among the strip's children.
    expect(strip.querySelector("[data-active]")?.textContent).toBe("Members");
  });
});

describe("each pane is reachable by URL", () => {
  it.each(settingsPanes.map((pane) => pane.id))("renders the %s pane for its own id", (id) => {
    render(<SettingsPage paneId={id} />);
    const pane = settingsPanes.find((p) => p.id === id)!;
    const current = container!.querySelector("a[aria-current='page']");
    expect(current?.getAttribute("href")).toBe(`/settings/${id}`);
    expect(current?.textContent).toBe(pane.title);
    // The pane's title is the page's h1, and names the region the pane is in.
    const h1 = container!.querySelector("h1")!;
    expect(h1.textContent).toBe(pane.title);
    expect(container!.querySelector(`section[aria-labelledby='${h1.id}']`)).not.toBeNull();
    expect(container!.querySelectorAll("h1")).toHaveLength(1);
  });

  it("links every pane from the section nav", () => {
    render(<SettingsPage paneId="account" />);
    const nav = container!.querySelector("nav[aria-label='Settings sections']")!;
    expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(
      settingsPanes.map((pane) => `/settings/${pane.id}`),
    );
  });

  it("falls back to the first pane rather than 404ing on an unknown id", () => {
    render(<SettingsPage paneId="no-such-pane" />);
    expect(container!.querySelector("a[aria-current='page']")?.getAttribute("href")).toBe(
      "/settings/account",
    );
  });

  it("has no stub left: every pane's sections are real", () => {
    // Usage was the stub until its feature filled it, then email
    // preferences inside Preferences; both have landed. A "Coming soon"
    // reappearing here is a pane that regressed to a placeholder.
    for (const pane of settingsPanes) {
      render(<SettingsPage paneId={pane.id} />);
      expect(container!.textContent, pane.id).not.toContain("Coming soon");
      act(() => {
        root?.unmount();
      });
      container?.remove();
    }
  });
});

describe("the page header", () => {
  it("puts a pane's primary action beside the title, once", () => {
    const original = paneComponents.data;
    paneComponents.data = () => (
      <PaneActions>
        <button type="button">Export data</button>
      </PaneActions>
    );
    try {
      render(<SettingsPage paneId="data" />);
      const header = container!.querySelector("h1")!.closest("header")!;
      const slot = header.querySelector("[data-slot='pane-actions']")!;
      expect(slot.querySelector("button")?.textContent).toBe("Export data");
      expect(container!.querySelectorAll("button")).toHaveLength(1);
    } finally {
      paneComponents.data = original;
    }
  });
});

describe("the Account pane", () => {
  it("shows the signed-in identity", () => {
    render(<SettingsPage paneId="account" />);
    expect(container!.textContent).toContain("dev@localhost");
    expect(container!.textContent).toContain("dev-org");
  });
});

describe("the Preferences pane drives the shared theme store", () => {
  it("offers all three theme states and selects the current one", () => {
    render(<SettingsPage paneId="preferences" />);
    const group = container!.querySelector("[role='radiogroup'][aria-label='Theme']")!;
    const radios = [...group.querySelectorAll("[role='radio']")];
    expect(radios.map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);

    const dark = radios.find((r) => r.textContent === "Dark")!;
    act(() => {
      dark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      container!.querySelector("[role='radio'][aria-checked='true']")?.textContent,
    ).toBe("Dark");
    // It sets the real store, which is what puts `.dark` on <html>.
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("mw-theme")).toBe("dark");

    const system = radios.find((r) => r.textContent === "System")!;
    act(() => {
      system.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("mw-theme")).toBe("system");
  });
});

describe("account deletion cannot fire without its typed confirmation", () => {
  function confirmButton(): HTMLButtonElement {
    const dialog = document.querySelector("[data-slot='dialog-content']")!;
    return [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Delete account",
    )!;
  }

  it("keeps the Data pane's confirm button disabled until the phrase is typed", () => {
    render(<SettingsPage paneId="data" />);
    const open = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Delete account…",
    )!;
    act(() => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const button = confirmButton();
    expect(button.disabled).toBe(true);

    const input = document.querySelector(
      "[data-slot='dialog-content'] input",
    ) as HTMLInputElement;
    // A near-miss is still a miss.
    act(() => {
      setInputValue(input, "delete account");
    });
    expect(confirmButton().disabled).toBe(true);

    act(() => {
      setInputValue(input, "delete my account");
    });
    expect(confirmButton().disabled).toBe(false);
  });

  it("does not call onConfirm while the phrase is wrong", () => {
    const onConfirm = vi.fn();
    render(
      <DestructiveConfirm
        open
        onOpenChange={() => {}}
        title="Delete your account?"
        confirmLabel="Delete account"
        confirmPhrase="delete my account"
        typedValue="nope"
        onTypedValueChange={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const button = confirmButton();
    expect(button.disabled).toBe(true);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/** React tracks the input's value internally; set it the way the DOM would. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
