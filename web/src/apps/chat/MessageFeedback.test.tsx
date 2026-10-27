import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageParts } from "./MessageParts";
import { FEEDBACK_REASONS, type Feedback } from "./feedback";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  stubApi,
  type Mounted,
} from "../settings/panes/paneHarness";

/**
 * Thumbs under a reply: a click rates at once, thumbs-down opens the
 * "why", chips and a comment ride on the PUT, the lit thumb withdraws, and
 * a reply rendered without the feedback prop (a user turn, a reply still
 * streaming, the public page) has no thumbs at all.
 */

const MESSAGE_ID = "22222222-2222-7222-8222-222222222222";

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The parent's half: ChatPage holds the map of ratings and re-renders the
 * row with the new value, so the harness must too, or a thumbs-down would
 * never see its own rating land.
 */
function Rated(props: { initial: Feedback | null; onChange: (next: Feedback | null) => void }) {
  const [current, setCurrent] = useState<Feedback | null>(props.initial);
  return (
    <MessageParts
      parts={[{ type: "text", text: "An answer." }]}
      feedback={{
        messageId: MESSAGE_ID,
        current,
        onChange: (next) => {
          setCurrent(next);
          props.onChange(next);
        },
      }}
    />
  );
}

async function render(
  respond: Parameters<typeof stubApi>[0],
  current: Feedback | null = null,
) {
  const changes: (Feedback | null)[] = [];
  const calls = stubApi(respond);
  mounted = await mount(
    <Rated initial={current} onChange={(next) => changes.push(next)} />,
    principalWith([]),
  );
  // The "why" is portalled; everything is looked for in the document.
  return { calls, changes, el: document.body };
}

function thumb(el: HTMLElement, label: "Good reply" | "Bad reply"): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

function setTextarea(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const saved = (rating: 1 | -1, reasons: string[] = [], comment: string | null = null) => ({
  status: 200,
  body: { message_id: MESSAGE_ID, rating, reasons, comment },
});

describe("thumbs on a reply", () => {
  it("renders no thumbs without the feedback prop", async () => {
    stubApi(() => undefined);
    mounted = await mount(<MessageParts parts={[{ type: "text", text: "x" }]} />, principalWith([]));
    expect(mounted.container.querySelector("[aria-label='Good reply']")).toBeNull();
  });

  it("a thumbs-up is one PUT and lights the thumb", async () => {
    const { calls, changes, el } = await render(({ method, url }) =>
      method === "PUT" && url === `/api/messages/${MESSAGE_ID}/feedback` ? saved(1) : undefined,
    );
    expect(el.querySelector("[data-mw-feedback]")?.getAttribute("data-mw-feedback")).toBe("none");

    click(thumb(el, "Good reply"));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ rating: 1, reasons: [], comment: null });
    expect(changes.at(-1)?.rating).toBe(1);
    // The details stay closed for a thumbs-up; they are a click away.
    expect(el.querySelector("[role='group']")).toBeNull();
    expect(buttonNamed(el, "Say why")).toBeDefined();
  });

  it("a thumbs-down rates at once and opens the why; chips and the comment ride on Save", async () => {
    const { calls, el } = await render(({ method }) =>
      method === "PUT" ? saved(-1, ["wrong", "too_long"], "Not that.") : undefined,
    );

    click(thumb(el, "Bad reply"));
    await flush();
    expect(calls[0].body).toEqual({ rating: -1, reasons: [], comment: null });

    const why = el.querySelector("[role='group']")!;
    expect(why).not.toBeNull();
    const chips = [...why.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent);
    expect(chips).toEqual(FEEDBACK_REASONS.map((r) => r.label));
    expect(why.textContent).toContain("not shown to the model");

    click(buttonNamed(why, "Wrong"));
    click(buttonNamed(why, "Too long"));
    setTextarea(why.querySelector("textarea")!, "  Not that.  ");
    click(buttonNamed(why, "Save"));
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({
      rating: -1,
      reasons: ["wrong", "too_long"],
      comment: "Not that.",
    });
    expect(el.querySelector("[role='group']")).toBeNull();
    expect(buttonNamed(el, "Edit why")).toBeDefined();
  });

  it("clicking the lit thumb withdraws the rating", async () => {
    const { calls, changes, el } = await render(
      ({ method }) => (method === "DELETE" ? { status: 200, body: { status: "removed" } } : undefined),
      { message_id: MESSAGE_ID, rating: 1, reasons: [], comment: null },
    );
    expect(thumb(el, "Good reply").getAttribute("aria-pressed")).toBe("true");

    click(thumb(el, "Good reply"));
    await flush();

    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(changes).toEqual([null]);
  });

  it("switching thumbs is a PUT, not a delete and a put", async () => {
    const { calls, el } = await render(
      ({ method }) => (method === "PUT" ? saved(-1) : undefined),
      { message_id: MESSAGE_ID, rating: 1, reasons: [], comment: null },
    );
    click(thumb(el, "Bad reply"));
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(calls[0].body).toEqual({ rating: -1, reasons: [], comment: null });
  });

  it("says when the rating could not be saved", async () => {
    const { el } = await render(() => ({ status: 500, body: { detail: "boom" } }));
    click(thumb(el, "Good reply"));
    await flush();
    expect(el.querySelector("[role='alert']")?.textContent).toContain("Could not save");
    expect(thumb(el, "Good reply").getAttribute("aria-pressed")).toBe("false");
  });
});
