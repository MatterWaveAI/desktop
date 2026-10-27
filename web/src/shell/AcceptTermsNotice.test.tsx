import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthConfig, Principal } from "../types";
import { AcceptTermsNotice } from "./AcceptTermsNotice";

/**
 * The re-accept page says what changed: each revision since the version
 * the person accepted, from `termsChanges.ts`, or "Updated wording" when
 * the list has nothing newer than what they accepted. The acceptance flow
 * itself is covered in boot.test.tsx.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config: AuthConfig = { auth_mode: "none", csrf_cookie: "mw_csrf", default_model: "m", terms_version: "2026-10" };

function principal(terms_version: string | null): Principal {
  return {
    subject: "ada",
    kind: "user",
    email: "ada@example.com",
    name: null,
    roles: [],
    org_id: "org",
    org_name: null,
    org_role: "owner",
    terms_version,
    terms_current: false,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("AcceptTermsNotice: what changed", () => {
  it("lists each revision newer than the one accepted, dated and in plain words", () => {
    const page = render(<AcceptTermsNotice config={config} principal={principal("2026-09")} onAccepted={() => {}} />);
    expect(page.querySelector("#terms-what-changed")?.textContent).toBe("What changed");
    const entries = [...page.querySelectorAll("[data-terms-change]")];
    expect(entries.map((e) => e.getAttribute("data-terms-change"))).toEqual(["2026-10"]);
    expect(entries[0].textContent).toContain("Version 2026-10");
    expect(entries[0].textContent).toContain("22 October 2026");
    expect(entries[0].textContent).toMatch(/overage cap/);
    expect(page.textContent).not.toContain("Updated wording");
  });

  it("lists every revision for an account with no recorded version", () => {
    const page = render(<AcceptTermsNotice config={config} principal={principal(null)} onAccepted={() => {}} />);
    expect(page.querySelectorAll("[data-terms-change]").length).toBeGreaterThanOrEqual(2);
  });

  it("says 'Updated wording' when the list has nothing newer than what was accepted", () => {
    const page = render(
      <AcceptTermsNotice config={{ ...config, terms_version: "2027-01" }} principal={principal("2026-10")} onAccepted={() => {}} />,
    );
    expect(page.querySelectorAll("[data-terms-change]").length).toBe(0);
    expect(page.textContent).toContain("Updated wording.");
  });

  it("gives the checkbox a thumb-sized box and a label that is the hit area", () => {
    const page = render(<AcceptTermsNotice config={config} principal={principal("2026-09")} onAccepted={() => {}} />);
    const box = page.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(box.className).toContain("size-5");
    expect(box.closest("label")?.className).toContain("min-h-6");
  });
});
