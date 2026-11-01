import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceAnswerReady,
  installAnswerReady,
  resetAnswerReadyForTests,
  setAnswerReadyFocus,
  unreadAnswers,
  writeAnswerReadyPrefs,
} from "./answerReady";
import { PreferencesPane } from "../apps/settings/panes/PreferencesPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The tab says an answer is ready only when the person is not looking,
 * and stops saying it when they come back; the notification is opt-in,
 * carries the conversation's title and nothing of the answer, and opens
 * that conversation. Visibility and Notification are both mocked: jsdom
 * has neither a hidden tab nor a notification centre.
 */

let hidden = false;
const created: FakeNotification[] = [];
const requestPermission = vi.fn(async () => "granted" as NotificationPermission);

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = requestPermission;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    created.push(this);
  }
}

function setHidden(next: boolean) {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

let uninstall: (() => void) | null = null;

beforeEach(() => {
  resetAnswerReadyForTests();
  localStorage.clear();
  created.length = 0;
  requestPermission.mockClear();
  FakeNotification.permission = "default";
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  hidden = false;
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
  document.title = "MatterWave";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('<svg viewBox="0 0 64 64"><rect/></svg>', { status: 200 })),
  );
  uninstall = installAnswerReady();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the tab title and icon", () => {
  it("change nothing while the tab is visible", async () => {
    announceAnswerReady({ conversationId: "c1", title: "Plans" });
    await flush();
    expect(document.title).toBe("MatterWave");
    expect(unreadAnswers()).toBe(0);
  });

  it("count answers that finish while hidden, dot the icon, and revert on return", async () => {
    setHidden(true);
    announceAnswerReady({ conversationId: "c1", title: "Plans" });
    await flush();
    expect(document.title).toBe("(1) MatterWave");
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    expect(icon.href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(icon.href)).toContain("<circle");

    announceAnswerReady({ conversationId: "c2", title: "Other" });
    expect(document.title).toBe("(2) MatterWave");

    setHidden(false);
    expect(document.title).toBe("MatterWave");
    expect(icon.getAttribute("href")).toBe("/favicon.svg");
  });

  it("stay quiet when the person asked for quiet", async () => {
    writeAnswerReadyPrefs({ quiet: true, notify: true });
    FakeNotification.permission = "granted";
    setHidden(true);
    announceAnswerReady({ conversationId: "c1", title: "Plans" });
    await flush();
    expect(document.title).toBe("MatterWave");
    expect(created).toHaveLength(0);
  });
});

describe("the system notification", () => {
  it("is not sent unless switched on, and never asks for permission by itself", () => {
    FakeNotification.permission = "granted";
    setHidden(true);
    announceAnswerReady({ conversationId: "c1", title: "Plans" });
    expect(created).toHaveLength(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("carries the title only and opens that conversation when clicked", () => {
    writeAnswerReadyPrefs({ quiet: false, notify: true });
    FakeNotification.permission = "granted";
    const focus = vi.fn();
    setAnswerReadyFocus(focus);
    const windowFocus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    setHidden(true);
    announceAnswerReady({ conversationId: "c1", title: "Quarterly plans" });
    expect(created).toHaveLength(1);
    const [note] = created;
    expect(note.title).toBe("Your answer is ready");
    expect(note.options.body).toBe("Quarterly plans");
    note.onclick?.();
    expect(windowFocus).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith("c1");
    expect(note.close).toHaveBeenCalled();
  });

  it("is not sent without the browser's permission", () => {
    writeAnswerReadyPrefs({ quiet: false, notify: true });
    FakeNotification.permission = "denied";
    setHidden(true);
    announceAnswerReady({ conversationId: "c1", title: "Plans" });
    expect(created).toHaveLength(0);
    expect(document.title).toBe("(1) MatterWave");
  });
});

describe("Settings > Preferences", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
  });

  it("asks for permission only from the toggle's click", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ email: {}, notifications: {} }), { status: 200 })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<PreferencesPane />));
    expect(requestPermission).not.toHaveBeenCalled();

    const toggle = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("System notification"))!
      .querySelector("input")!;
    await act(async () => {
      toggle.click();
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("mw-answer-ready")!)).toEqual({
      quiet: false,
      notify: true,
    });
  });
});
