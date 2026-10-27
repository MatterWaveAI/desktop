import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { Onboarding } from "./Onboarding";
import { AI_DISCLOSURE } from "../apps/chat/aiDisclosureText";

/**
 * The first-run walkthrough: three steps, the AI disclosure on the first,
 * skippable from any of them, the flag recorded either way, and the name
 * saved only when it changed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const CONFIG: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "house-model" };

const PRINCIPAL: Principal = {
  subject: "dev",
  kind: "user",
  email: "new@example.com",
  name: "New Person",
  roles: [],
  org_id: "org-1",
  org_name: "Org One",
  org_role: "owner",
  onboarding_completed: false,
};

function stub(): { method: string; url: string; body: unknown }[] {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const method = (init?.method ?? "GET").toUpperCase();
      // Only the writes: the model list is read on mount and says nothing here.
      if (method !== "GET") calls.push({ method, url, body });
      const answer =
        url === "/api/me"
          ? { name: (body as { full_name: string }).full_name }
          : url === "/api/models"
            ? { object: "list", data: [{ id: "house-model", label: "House Model" }], default_model: "house-model" }
            : {};
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(answer),
      } as Response);
    }),
  );
  return calls;
}

function mount(onDone = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Onboarding config={CONFIG} principal={PRINCIPAL} onDone={onDone} />);
  });
  return onDone;
}

function button(label: string): HTMLButtonElement {
  return [...container!.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

describe("the first-run walkthrough", () => {
  it("opens on what the model is, by its label rather than its id, with the AI disclosure", async () => {
    stub();
    mount();
    expect(container!.textContent).toContain("Step 1 of 3");
    await act(async () => {
      await Promise.resolve();
    });
    expect(container!.textContent).toContain("House Model");
    expect(container!.textContent).not.toContain("house-model");
    expect(container!.textContent).toContain(AI_DISCLOSURE);
  });

  it("walks to where usage and billing live, then the name, and Finish records the flag", async () => {
    const calls = stub();
    const onDone = mount();
    await click("Next");
    expect(container!.textContent).toContain("Step 2 of 3");
    // Named, not linked: a link here would leave the walkthrough mid-way
    // and land back on it, since it is not finished yet.
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.textContent).toContain("Settings › Usage");
    expect(container!.textContent).toContain("Settings › Billing");
    await click("Next");
    expect(container!.textContent).toContain("Step 3 of 3");
    await click("Finish");
    // The name did not change, so only the flag is written.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/me/onboarding/complete"]);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ onboarding_completed: true }));
  });

  it("saves a changed display name before recording the flag", async () => {
    const calls = stub();
    const onDone = mount();
    await click("Next");
    await click("Next");
    const input = container!.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "  Ada Lovelace ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Finish");
    expect(calls[0]).toEqual({ method: "PATCH", url: "/api/me", body: { full_name: "Ada Lovelace" } });
    expect(calls[1].url).toBe("/api/me/onboarding/complete");
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ name: "Ada Lovelace" }));
  });

  it("is skippable from the first step, and skipping records the flag too", async () => {
    const calls = stub();
    const onDone = mount();
    // Says what it does: skipping is for good, not "for now".
    expect(button("Skip for now")).toBeUndefined();
    await click("Skip the tour");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/me/onboarding/complete"]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
