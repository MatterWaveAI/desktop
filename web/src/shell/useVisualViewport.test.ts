import { describe, expect, it, vi, afterEach } from "vitest";
import { subscribeToViewport } from "./useVisualViewport";

/**
 * The part a jsdom test can actually prove: WHICH events are
 * subscribed to.
 *
 * This matters more than it looks. On iOS the on-screen keyboard fires
 * `resize` and `scroll` on `visualViewport` and fires **nothing on `window`**.
 * A handler bound to `window.resize` — the obvious implementation — therefore
 * does nothing at all on the platform where `dvh` is most wrong. Asserting the
 * listener set is how that regression gets caught here rather than on a phone.
 *
 * The geometry itself is measured in e2e/mobile.spec.ts against a real engine;
 * jsdom has no layout and could not answer it.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeViewport() {
  const listeners: Record<string, Set<() => void>> = {};
  return {
    height: 800,
    offsetTop: 0,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      (listeners[type] ??= new Set()).add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners[type]?.delete(fn);
    }),
    emit(type: string) {
      listeners[type]?.forEach((fn) => fn());
    },
    get types() {
      return Object.keys(listeners).sort();
    },
  };
}

describe("subscribeToViewport", () => {
  it("listens for both resize and scroll on visualViewport", () => {
    const vv = fakeViewport();
    vi.stubGlobal("visualViewport", vv);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });

    const onChange = vi.fn();
    const unsubscribe = subscribeToViewport(onChange);

    // `scroll` as well as `resize`: iOS both shrinks AND scrolls the visual
    // viewport for the keyboard, and resize alone misses the second half.
    expect(vv.types).toEqual(["resize", "scroll"]);

    vv.emit("resize");
    expect(onChange).toHaveBeenCalledTimes(1);
    vv.emit("scroll");
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    vv.emit("resize");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("falls back to window.resize where visualViewport does not exist", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const onChange = vi.fn();
    const unsubscribe = subscribeToViewport(onChange);
    expect(add).toHaveBeenCalledWith("resize", onChange);
    unsubscribe();
    expect(remove).toHaveBeenCalledWith("resize", onChange);

    add.mockRestore();
    remove.mockRestore();
  });
});
