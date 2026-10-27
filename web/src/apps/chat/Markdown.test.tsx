import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./Markdown";
import { trimCodeBlock } from "./codeText";
import { safeImageUrl, safeLinkUrl } from "./safeUrl";

/**
 * The payload fixture. Every case here is markdown a model can
 * emit. The assertions are about what reaches the DOM, not about what the
 * renderer intended - a test that only checks the happy path would pass on a
 * renderer with rehype-raw switched on.
 */


// The project renders with react-dom/client directly rather than a testing
// library; this is the same shape as registry.test.tsx.
let host: HTMLDivElement | null = null;

function render(ui: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return { container: host };
}

afterEach(() => {
  host?.remove();
  host = null;
});

function onlyLink(container: HTMLElement): HTMLAnchorElement {
  const a = container.querySelector("a");
  if (!a) throw new Error("no link rendered");
  return a;
}

const XSS_PAYLOADS: ReadonlyArray<{ name: string; markdown: string }> = [
  { name: "script tag", markdown: "<script>window.__pwned = 1</script>" },
  { name: "img onerror", markdown: '<img src=x onerror="window.__pwned=1">' },
  { name: "svg onload", markdown: '<svg onload="window.__pwned=1"></svg>' },
  { name: "iframe", markdown: '<iframe src="https://evil.test"></iframe>' },
  { name: "javascript: link", markdown: "[click](javascript:window.__pwned=1)" },
  {
    name: "javascript: link, case and whitespace mangled",
    markdown: "[click](  JaVaScRiPt:window.__pwned=1)",
  },
  { name: "data: link", markdown: "[click](data:text/html;base64,PHNjcmlwdD4=)" },
  { name: "vbscript: link", markdown: "[click](vbscript:msgbox)" },
  { name: "data: image", markdown: "![x](data:image/svg+xml;base64,PHN2Zz4=)" },
  { name: "off-origin tracking pixel", markdown: "![x](https://evil.test/pixel.gif)" },
  { name: "anchor with onclick", markdown: '<a href="#" onclick="window.__pwned=1">x</a>' },
  { name: "object tag", markdown: '<object data="https://evil.test"></object>' },
  { name: "form with action", markdown: '<form action="https://evil.test"><input></form>' },
  { name: "style tag", markdown: "<style>body{display:none}</style>" },
  { name: "meta refresh", markdown: '<meta http-equiv="refresh" content="0;url=https://evil.test">' },
];

describe("markdown is a security boundary", () => {
  it.each(XSS_PAYLOADS)("neutralises: $name", ({ markdown }) => {
    const { container } = render(<MarkdownText text={markdown} />);
    // No executable element ever reaches the DOM.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector("meta")).toBeNull();

    // No inline handler survives as a real attribute. Checked on the DOM, not
    // on the HTML string: raw HTML is rendered as escaped text, so the string
    // legitimately contains "&lt;img ... onerror=..." as visible characters.
    for (const el of container.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.toLowerCase()).not.toMatch(/^on/);
      }
    }

    // No dangerous scheme reaches an href or src.
    for (const el of container.querySelectorAll("a")) {
      const href = el.getAttribute("href") ?? "";
      expect(href).not.toMatch(/^\s*(javascript|data|vbscript|file):/i);
    }
    for (const el of container.querySelectorAll("img")) {
      const src = el.getAttribute("src") ?? "";
      expect(src).not.toMatch(/^\s*(javascript|data|vbscript|file):/i);
      // Images are same-origin only: the browser fetches them without a click.
      expect(new URL(src, location.href).origin).toBe(location.origin);
    }
  });

  it("does not execute anything from the payloads", () => {
    for (const { markdown } of XSS_PAYLOADS) {
      render(<MarkdownText text={markdown} />);
      host?.remove();
    }
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("still renders ordinary markdown", () => {
    const { container } = render(
      <MarkdownText text={"# Title\n\nSome **bold** text and a [link](https://example.com)."} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(onlyLink(container).getAttribute("href")).toBe("https://example.com/");
  });

  it("opens external links safely", () => {
    const { container } = render(<MarkdownText text="[x](https://example.com)" />);
    const a = onlyLink(container);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });

  it("shows an off-origin image as text with a click-through, not as an <img>", () => {
    const { container } = render(<MarkdownText text="![x](https://cdn.evil.test/a.png)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("https://cdn.evil.test/a.png");
  });

  it("survives a renderer failure without blanking the message", () => {
    // An unterminated table is the usual cause; the boundary keeps the text.
    const nasty = "| a | b |\n| --- |\n| 1 | 2 | 3 | 4 |";
    const { container } = render(<MarkdownText text={nasty} />);
    expect(container.textContent).not.toBe("");
  });
});

describe("fenced code", () => {
  it("draws no card for a fence with nothing in it", () => {
    const { container } = render(<MarkdownText text={"before\n\n```\n\n```\n\nafter"} />);
    expect(container.querySelector("[data-mw-code-block]")).toBeNull();
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("drops the indent every line shares, so a padded line is not an empty-looking box", () => {
    const padded = "```\n" + " ".repeat(400) + "if\n```";
    const { container } = render(<MarkdownText text={padded} />);
    const block = container.querySelector("[data-mw-code-block] code")!;
    expect(block.textContent).toBe("if");
  });

  it("keeps relative indentation", () => {
    const { container } = render(
      <MarkdownText text={"```python\n    def f():\n        return 1\n```"} />,
    );
    expect(container.querySelector("[data-mw-code-block] code")?.textContent).toBe(
      "def f():\n    return 1",
    );
  });
});

describe("trimCodeBlock", () => {
  it("is empty for whitespace, dedents by the shared indent, and keeps blank lines out of the count", () => {
    expect(trimCodeBlock("")).toBe("");
    expect(trimCodeBlock("   \n\t\n")).toBe("");
    expect(trimCodeBlock("  a\n\n    b\n")).toBe("a\n\n  b");
    expect(trimCodeBlock("a\n  b\n")).toBe("a\n  b");
    expect(trimCodeBlock("\tx\n\t\ty")).toBe("x\n\ty");
  });
});

describe("the URL allowlist itself", () => {
  it.each([
    "javascript:alert(1)",
    "  javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
  ])("refuses %s as a link", (url) => {
    expect(safeLinkUrl(url)).toBeUndefined();
  });

  it.each(["https://example.com/", "http://example.com/", "mailto:a@b.test", "tel:+15550100"])(
    "allows %s as a link",
    (url) => {
      expect(safeLinkUrl(url)).toBeDefined();
    },
  );

  it("refuses every off-origin image", () => {
    expect(safeImageUrl("https://cdn.evil.test/a.png")).toBeUndefined();
    expect(safeImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
  });

  it("allows a same-origin image", () => {
    expect(safeImageUrl(`${location.origin}/a.png`)).toBe(`${location.origin}/a.png`);
    expect(safeImageUrl("/relative.png")).toBe(`${location.origin}/relative.png`);
  });
});

describe("math", () => {
  it("renders inline and display TeX with KaTeX", () => {
    const { container } = render(
      <MarkdownText text={"Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x\\,dx\n$$"} />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps trust off: \\href in TeX never becomes a link", () => {
    const { container } = render(
      <MarkdownText text={"$\\href{javascript:alert(1)}{x}$"} />,
    );
    expect(container.querySelector("a[href^=\"javascript\"]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});
