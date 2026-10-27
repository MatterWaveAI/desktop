import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";
import { JumpToLatest } from "./JumpToLatest";

/**
 * The follow rule and the way back. jsdom has no layout, so the scroller's
 * geometry is faked onto the element: a 500px box showing `height` px of
 * content, with a `scrollTo` that lands where a browser's would. What the
 * fake cannot answer -- whether the box really keeps up with a stream on a
 * phone -- is e2e/mobile.spec.ts's.
 *
 * Same harness as useChatThread.test.tsx.
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

const VIEWPORT = 500;

/** Give the scroller a size, once, and a content height, on every render. */
function fakeGeometry(el: HTMLElement, height: number, scrollTo: (opts: { top: number }) => void) {
  Object.defineProperty(el, "scrollHeight", { value: height, configurable: true });
  if (!("__faked" in el)) {
    Object.defineProperty(el, "clientHeight", { value: VIEWPORT, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(el, "scrollTo", { value: scrollTo, configurable: true });
    Object.defineProperty(el, "__faked", { value: true });
  }
}

function harness() {
  let el: HTMLElement | null = null;
  // A browser clamps the target to the end of the content.
  const scrollTo = vi.fn((opts: { top: number }) => {
    if (el) el.scrollTop = Math.max(0, opts.top - VIEWPORT);
  });

  function Host(props: { contentKey: unknown; height: number; pin?: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const stick = useStickToBottom(ref, props.contentKey, props.pin);
    return (
      <>
        <div
          ref={(node) => {
            ref.current = node;
            if (node) {
              el = node;
              fakeGeometry(node, props.height, scrollTo);
            }
          }}
          data-testid="scroller"
        />
        <JumpToLatest visible={stick.away} unseen={stick.unseen} onJump={stick.jumpToLatest} />
      </>
    );
  }

  return {
    scrollTo,
    render(contentKey: unknown, height: number, pin?: boolean) {
      if (root === null) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
      }
      act(() => {
        root!.render(<Host contentKey={contentKey} height={height} pin={pin} />);
      });
    },
    /** The reader drags the scroller to `top`, which fires `scroll`. */
    readerScrollsTo(top: number) {
      act(() => {
        el!.scrollTop = top;
        el!.dispatchEvent(new Event("scroll"));
      });
    },
    button() {
      return container!.querySelector<HTMLButtonElement>("[data-mw-jump-to-latest]");
    },
  };
}

describe("useStickToBottom", () => {
  it("leaves an empty chat's welcome at the top, and follows once a transcript exists", () => {
    const h = harness();
    h.render("empty", 900, false);
    expect(h.scrollTo).not.toHaveBeenCalled();
    h.render("rows:1", 1000, true);
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 1000 }));
  });

  it("follows whenever the content key changes, which is whatever the caller renders, not a send alone", () => {
    const h = harness();
    h.render("rows:1", 1000);
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 1000 }));
    // A regenerate streams through the stored rows; the key is the caller's.
    h.render("rows:2", 1500);
    expect(h.scrollTo).toHaveBeenCalledTimes(2);
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 1500 }));
    // The same content, re-rendered, is not a reason to move the reader.
    h.render("rows:2", 1500);
    expect(h.scrollTo).toHaveBeenCalledTimes(2);
    expect(h.button()).toBeNull();
  });

  it("a reader a viewport up is offered the jump, is not dragged down, and is told what arrived", () => {
    const h = harness();
    h.render("a", 2000);
    expect(h.scrollTo).toHaveBeenCalledTimes(1);
    h.readerScrollsTo(0);
    const button = h.button();
    expect(button).not.toBeNull();
    expect(button!.dataset.mwJumpToLatest).toBe("seen");
    expect(button!.textContent).not.toContain("new content");
    h.render("b", 2500);
    expect(h.scrollTo).toHaveBeenCalledTimes(1);
    expect(h.button()!.dataset.mwJumpToLatest).toBe("unseen");
    expect(h.button()!.textContent).toContain("new content below");
  });

  it("the jump scrolls to the end, follows again, and the button goes on arrival", () => {
    const h = harness();
    h.render("a", 2000);
    h.readerScrollsTo(0);
    expect(h.button()).not.toBeNull();
    act(() => {
      h.button()!.click();
    });
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 2000 }));
    // The browser's scroll event for the landing.
    h.readerScrollsTo(2000 - VIEWPORT);
    expect(h.button()).toBeNull();
    h.render("b", 2400);
    expect(h.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 2400 }));
  });

  it("a reader less than a viewport up is neither followed nor offered the button, until content pushes them past one", () => {
    const h = harness();
    h.render("a", 2000);
    h.readerScrollsTo(2000 - VIEWPORT - 300);
    expect(h.button()).toBeNull();
    h.render("b", 2100);
    expect(h.scrollTo).toHaveBeenCalledTimes(1);
    expect(h.button()).toBeNull();
    // They did not move; the bottom did. Six hundred pixels below them now.
    h.render("c", 2400);
    expect(h.scrollTo).toHaveBeenCalledTimes(1);
    expect(h.button()!.dataset.mwJumpToLatest).toBe("unseen");
  });

  it("its own easing toward the bottom is not the reader scrolling up: a stream faster than the scroll is still followed", () => {
    const h = harness();
    h.render("a", 1000);
    // A smooth scroll does not land at once: the browser eases over
    // several frames, each firing `scroll` from a position still short of
    // the bottom. The fake's scrollTo is made to do nothing, and the frames
    // are dispatched by hand, the way a stream outrunning the easing looks.
    h.scrollTo.mockImplementation(() => {});
    h.render("b", 3000);
    expect(h.scrollTo).toHaveBeenCalledTimes(2);
    // Two frames of easing down from 500 (where the first render landed),
    // 1900px and 1800px from the bottom: a reader scrolling here would be
    // far above the follow line, but this is the browser moving down on the
    // hook's behalf.
    h.readerScrollsTo(600);
    h.readerScrollsTo(700);
    expect(h.button(), "the easing must not be read as the reader leaving").toBeNull();
    h.render("c", 3500);
    expect(h.scrollTo, "the next chunk is still followed").toHaveBeenCalledTimes(3);
    expect(h.button()).toBeNull();
    // The reader really does scroll up, which cancels the easing in a
    // browser and arrives as a position above the last one.
    h.readerScrollsTo(650);
    h.render("d", 4000);
    expect(h.scrollTo).toHaveBeenCalledTimes(3);
    expect(h.button()!.dataset.mwJumpToLatest).toBe("unseen");
  });

  it("honours reduced motion with an instant scroll", () => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query: string) => ({ matches: query.includes("reduce") }) as MediaQueryList);
    const h = harness();
    h.render("a", 1000);
    expect(h.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "instant" });
    matchMedia.mockRestore();
  });
});
