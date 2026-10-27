import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShikiCode } from "./CodeBlock";

/**
 * The code block's header: the language label, and a Copy that hands the
 * clipboard the raw source rather than shiki's markup.
 *
 * Shiki is mocked: what it renders is its own concern, and loading its
 * grammars in jsdom only adds seconds to a test about a label and a button.
 */

vi.mock("shiki", () => ({
  codeToHtml: async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`,
}));

// React 19: silence act warnings for renders driven outside React's test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

/** jsdom ships no `navigator.clipboard`; each test states whether it has one. */
function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  stubClipboard(null);
});

const SOURCE = 'def greet(name):\n    return f"hi {name}"';

describe("the code block header", () => {
  it("names the language, lower-cased, as the fence wrote it", async () => {
    stubClipboard(async () => {});
    await render(<ShikiCode code={SOURCE} language="Python" />);
    expect(container!.querySelector("[data-mw-code-language]")?.textContent).toBe("python");
  });

  it("labels an unfenced block as text", async () => {
    stubClipboard(async () => {});
    await render(<ShikiCode code={SOURCE} language="text" />);
    expect(container!.querySelector("[data-mw-code-language]")?.textContent).toBe("text");
  });

  it("offers a keyboard-reachable Copy named for a screen reader", async () => {
    stubClipboard(async () => {});
    await render(<ShikiCode code={SOURCE} language="python" />);
    const button = container!.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
    expect(button).not.toBeNull();
    expect(button!.tabIndex).toBe(0);
    expect(button!.textContent).toBe("Copy");
  });

  it("copies the raw source, not the highlighted HTML, and says so", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    await render(<ShikiCode code={SOURCE} language="python" />);
    // Shiki has rendered by now: the body is markup, the clipboard must not be.
    expect(container!.querySelector("pre.shiki")).not.toBeNull();

    await act(async () => {
      container!
        .querySelector('button[aria-label="Copy code"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledExactlyOnceWith(SOURCE);
    expect(container!.querySelector('button[aria-label="Copy code"]')?.textContent).toBe("Copied");
  });

  it("hides Copy in a browser with no clipboard API, and keeps the label", async () => {
    stubClipboard(null);
    await render(<ShikiCode code={SOURCE} language="python" />);
    expect(container!.querySelector('button[aria-label="Copy code"]')).toBeNull();
    expect(container!.querySelector("[data-mw-code-language]")?.textContent).toBe("python");
    // The source is still on screen to select by hand.
    expect(container!.textContent).toContain("def greet");
  });

  it("stays on Copy when the clipboard refuses, rather than claiming a copy", async () => {
    stubClipboard(async () => {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    });
    await render(<ShikiCode code={SOURCE} language="python" />);
    await act(async () => {
      container!
        .querySelector('button[aria-label="Copy code"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('button[aria-label="Copy code"]')?.textContent).toBe("Copy");
  });
});
