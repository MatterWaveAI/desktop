import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityId } from "./IdentityId";

/**
 * The identity id is for pasting into the IdP's console, so it is a Copy
 * button; a browser that cannot copy still shows the id.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("an identity id", () => {
  it("is a Copy button that writes the id, and never shows the raw id beside it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const view = render(<IdentityId id="z-acme-1234" label="Copy identity org id" />);
    const button = view.querySelector("button")!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("Copy identity org id");
    expect(view.textContent).not.toContain("z-acme-1234");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith("z-acme-1234");
    await vi.waitFor(() => expect(button.textContent).toBe("Copied"));
  });

  it("shows the id itself where the clipboard is unavailable", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const view = render(<IdentityId id="z-acme-1234" label="Copy identity org id" />);
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent).toBe("z-acme-1234");
  });
});
