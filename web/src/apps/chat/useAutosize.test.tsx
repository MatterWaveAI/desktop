import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useAutosize } from "./useAutosize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** jsdom lays nothing out, so the height the text needs is set by the test. */
let contentHeight = 0;
Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => contentHeight,
});

function Box(props: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, props.value);
  return <textarea ref={ref} value={props.value} readOnly style={{ maxHeight: "160px" }} />;
}

function render(value: string): HTMLTextAreaElement {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(<Box value={value} />));
  return container.querySelector("textarea")!;
}

describe("the composer's height", () => {
  it("grows with the text and shrinks when it is deleted", () => {
    contentHeight = 24;
    expect(render("one line").style.height).toBe("24px");
    contentHeight = 96;
    const box = render("four\nlines\nof\ntext");
    expect(box.style.height).toBe("96px");
    expect(box.style.overflowY).toBe("hidden");
    contentHeight = 24;
    expect(render("one").style.height).toBe("24px");
  });

  it("stops at its max height and scrolls from there", () => {
    contentHeight = 400;
    const box = render("a very long draft");
    expect(box.style.height).toBe("160px");
    expect(box.style.overflowY).toBe("auto");
  });
});
