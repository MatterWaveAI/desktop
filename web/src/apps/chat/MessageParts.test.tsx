import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { MessagePart } from "./chatAdapter";
import { MessageParts } from "./MessageParts";

/**
 * The renderer maps part kinds to components, and an unknown
 * kind renders a placeholder rather than throwing -- so an older client does
 * not crash on a message written by a newer API.
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
});

function render(parts: readonly MessagePart[]): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MessageParts parts={parts} />);
  });
  return container;
}

describe("MessageParts", () => {
  it("renders text through the markdown renderer", () => {
    const el = render([{ type: "text", text: "**bold**" }]);
    expect(el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders a tool call as a compact row naming the tool", () => {
    const el = render([
      { type: "tool_call", id: "c1", name: "get_current_time", arguments: '{"timezone":"UTC"}' },
      { type: "tool_result", id: "c1", output: '{"human":"ten o clock"}', is_error: false },
    ]);

    expect(el.textContent).toContain("Called");
    expect(el.textContent).toContain("get_current_time");
    // Collapsed by default: the arguments and the result are not on screen.
    expect(el.textContent).not.toContain("ten o clock");
  });

  it("shows the arguments and the result when the row is expanded", () => {
    const el = render([
      { type: "tool_call", id: "c1", name: "get_current_time", arguments: '{"timezone":"UTC"}' },
      { type: "tool_result", id: "c1", output: '{"human":"ten o clock"}', is_error: false },
    ]);

    act(() => {
      el.querySelector("button")!.click();
    });

    expect(el.textContent).toContain("UTC");
    expect(el.textContent).toContain("ten o clock");
  });

  it("says a tool call is still running until its result lands", () => {
    const el = render([
      { type: "tool_call", id: "c1", name: "get_current_time", arguments: "{}" },
    ]);
    expect(el.textContent).toContain("running");
  });

  it("marks a failed tool result as failed", () => {
    const el = render([
      { type: "tool_call", id: "c1", name: "get_current_time", arguments: "{}" },
      { type: "tool_result", id: "c1", output: "Unknown timezone 'Mars/Base'.", is_error: true },
    ]);
    expect(el.textContent).toContain("failed");
  });

  it("pairs a result with its own call by id, not by arrival order", () => {
    const el = render([
      { type: "tool_call", id: "a", name: "first", arguments: "{}" },
      { type: "tool_call", id: "b", name: "second", arguments: "{}" },
      { type: "tool_result", id: "b", output: "B-OUTPUT", is_error: false },
      { type: "tool_result", id: "a", output: "A-OUTPUT", is_error: false },
    ]);

    const [firstRow, secondRow] = Array.from(el.querySelectorAll("button"));
    act(() => firstRow.click());
    expect(el.textContent).toContain("A-OUTPUT");
    expect(el.textContent).not.toContain("B-OUTPUT");

    act(() => secondRow.click());
    expect(el.textContent).toContain("B-OUTPUT");
  });

  it("collapses reasoning by default", () => {
    const el = render([{ type: "reasoning", text: "the user wants the time" }]);

    expect(el.textContent).toContain("Reasoning");
    expect(el.textContent).not.toContain("the user wants the time");

    act(() => {
      el.querySelector("button")!.click();
    });
    expect(el.textContent).toContain("the user wants the time");
  });

  it("renders a placeholder for an unknown part kind instead of throwing", () => {
    const el = render([
      { type: "text", text: "before" },
      { type: "hologram" } as MessagePart,
      { type: "text", text: "after" },
    ]);

    expect(el.textContent).toContain("before");
    expect(el.textContent).toContain("after");
    expect(el.textContent).toContain("hologram");
    expect(el.textContent).toContain("cannot show");
  });

  it("does not render an empty text part the stream has only just opened", () => {
    const el = render([{ type: "text", text: "" }]);
    expect(el.textContent).toBe("");
  });

  it("renders tool output as plain text, never as markdown", () => {
    // Tool data has no reason to get link or image rendering.
    const el = render([
      { type: "tool_call", id: "c1", name: "t", arguments: "{}" },
      { type: "tool_result", id: "c1", output: "[click](javascript:alert(1))", is_error: false },
    ]);
    act(() => {
      el.querySelector("button")!.click();
    });

    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("[click](javascript:alert(1))");
  });

  // --- web search citations ------------------------------------------

  /**
   * A `web_search` result is the one tool output rendered as something other
   * than a `<pre>`, because an answer built from search results that does not
   * say where they came from is unverifiable. These tests are about the two
   * halves of that: the citation is reachable, and the URL is still filtered.
   */
  function searchResult(rows: unknown): readonly MessagePart[] {
    return [
      { type: "tool_call", id: "c1", name: "web_search", arguments: '{"query":"rust 2.0"}' },
      {
        type: "tool_result",
        id: "c1",
        output: JSON.stringify({ query: "rust 2.0", results: rows }),
        is_error: false,
      },
    ];
  }

  it("renders web search results as clickable sources, open by default", () => {
    const el = render(
      searchResult([
        { title: "Rust 2.0 released", url: "https://blog.rust-lang.org/2-0", snippet: "Today." },
      ]),
    );

    // Open without a click: a citation the user has to go looking for is one
    // they will not check.
    const link = el.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://blog.rust-lang.org/2-0");
    expect(link?.textContent).toBe("Rust 2.0 released");
    // The URL itself is visible, not only the title: the user should be able
    // to see where a claim came from without hovering.
    expect(el.textContent).toContain("https://blog.rust-lang.org/2-0");
    expect(el.textContent).toContain("Searched the web");
  });

  it("opens search sources in a new tab without leaking the referrer or opener", () => {
    const el = render(
      searchResult([{ title: "T", url: "https://example.com/a", snippet: "s" }]),
    );
    const rel = el.querySelector("a")?.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
    expect(rel).toContain("nofollow");
    expect(el.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });

  it("drops a search source whose URL the client allowlist refuses", () => {
    // The API already refused this before storing the part. Checking again
    // here is deliberate: the URL is attacker-chosen text about to become an
    // href, and a client that trusted the server would be one API bug away
    // from having no allowlist at all.
    const el = render(
      searchResult([
        { title: "evil", url: "javascript:alert(1)", snippet: "x" },
        { title: "good", url: "https://example.com/ok", snippet: "y" },
      ]),
    );
    const hrefs = Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/ok"]);
  });

  it("renders a search snippet as plain text, never as markdown", () => {
    // A snippet is quoted from a page we do not own. Giving third-party text
    // link and image rendering would widen the markdown security boundary to anyone who
    // can rank for a query.
    const el = render(
      searchResult([
        {
          title: "T",
          url: "https://example.com/a",
          snippet: "[click](javascript:alert(1)) ![x](http://evil/x.png)",
        },
      ]),
    );
    expect(el.querySelectorAll("a").length).toBe(1); // the source link only
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("[click](javascript:alert(1))");
  });

  it("falls back to the raw output when a search result is not the shape it expects", () => {
    // A provider change, an older stored row, or a failed search: showing the
    // user what actually arrived beats rendering an empty list.
    for (const output of ["not json", JSON.stringify({ results: "nope" }), "{}"]) {
      const el = render([
        { type: "tool_call", id: "c1", name: "web_search", arguments: "{}" },
        { type: "tool_result", id: "c1", output, is_error: false },
      ]);
      act(() => el.querySelector("button")!.click());
      expect(el.textContent).toContain("Called");
      expect(el.textContent).toContain(output);
      act(() => root!.unmount());
      container!.remove();
    }
  });

  it("falls back to the raw output when a search found nothing", () => {
    const el = render(searchResult([]));
    act(() => el.querySelector("button")!.click());
    expect(el.textContent).toContain("Called");
    expect(el.querySelector("a")).toBeNull();
  });

  it("shows a failed search as a failed tool call, not as sources", () => {
    const el = render([
      { type: "tool_call", id: "c1", name: "web_search", arguments: '{"query":"x"}' },
      {
        type: "tool_result",
        id: "c1",
        output: JSON.stringify({ error: "Web search is unavailable", results: [] }),
        is_error: true,
      },
    ]);
    expect(el.textContent).toContain("failed");
    expect(el.querySelector("a")).toBeNull();
  });

  // --- attachments ---------------------------------------------------

  it("renders an image part through the app's own view route", () => {
    const el = render([
      {
        type: "image",
        attachment_id: "abc-123",
        filename: "screenshot.png",
        content_type: "image/png",
      },
    ]);
    const img = el.querySelector("img");
    // The URL is built from the id, never taken from the part: a signed URL
    // is short-lived and scoped to the viewer, so one baked into stored
    // content would be stale by the time anyone re-read the conversation.
    expect(img?.getAttribute("src")).toBe("/api/attachments/abc-123/view");
    expect(img?.getAttribute("alt")).toBe("screenshot.png");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  it("falls back to a link when an image cannot be loaded", () => {
    const el = render([
      { type: "image", attachment_id: "gone", filename: "old.png", content_type: "image/png" },
    ]);
    act(() => {
      el.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("no longer available");
  });

  it("says when only part of a document reached the model", () => {
    // "say so in the UI when it is truncated". Silently feeding
    // the model a prefix is the failure the flag exists to make visible.
    const el = render([
      {
        type: "document",
        attachment_id: "d1",
        filename: "server.log",
        content_type: "text/plain",
        text: "a very long log",
        truncated: true,
      },
    ]);
    expect(el.textContent).toContain("server.log");
    expect(el.textContent).toContain("Only the first part");
  });

  it("says when a document's text was never extracted", () => {
    const el = render([
      {
        type: "document",
        attachment_id: "d2",
        filename: "contract.pdf",
        content_type: "application/pdf",
        text: null,
        truncated: false,
      },
    ]);
    expect(el.textContent).toContain("did not read its contents");
  });

  it("does not render a document's extracted text inline", () => {
    // It is the file's content, it can be 32,000 characters, and the user
    // already knows what they attached.
    const el = render([
      {
        type: "document",
        attachment_id: "d3",
        filename: "notes.md",
        content_type: "text/markdown",
        text: "SECRET-CANARY-STRING",
        truncated: false,
      },
    ]);
    expect(el.textContent).not.toContain("SECRET-CANARY-STRING");
  });

  it("escapes a hostile filename rather than rendering it", () => {
    const el = render([
      {
        type: "image",
        attachment_id: "x",
        filename: "<img src=x onerror=alert(1)>.png",
        content_type: "image/png",
      },
    ]);
    act(() => {
      el.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    // One element from the fallback row, none injected by the name. React
    // escapes it; this test is what would notice if it stopped.
    expect(el.querySelectorAll("img").length).toBe(0);
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>.png");
  });
});
