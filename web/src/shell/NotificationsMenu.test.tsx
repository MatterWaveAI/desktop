import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsMenu } from "./NotificationsMenu";

/**
 * The bell: the unread count from the API, the list on open, everything
 * marked read on open, a poll every minute, and a failure that says so
 * without taking the header with it.
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ROWS = [
  {
    id: "n2",
    kind: "budget.warn",
    title: "80% of this period's included tokens used",
    body: "The organisation is approaching the tokens its plan includes.",
    link: "/settings/usage",
    created_at: "2026-10-03T09:00:00Z",
    read_at: null,
  },
  {
    id: "n1",
    kind: "plan.changed",
    title: "The organisation is now on the pro plan",
    body: "",
    link: null,
    created_at: "2026-10-01T09:00:00Z",
    read_at: "2026-10-02T09:00:00Z",
  },
];

function stub(status = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      const body = url.includes("read-all")
        ? { read: 1, unread_count: 0 }
        : { data: ROWS, unread_count: 1 };
      return Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(status < 400 ? body : { detail: "down" }),
      } as Response);
    }),
  );
  return calls;
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NotificationsMenu />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function summary(): HTMLElement {
  return container!.querySelector("summary")!;
}

describe("the notification bell", () => {
  it("shows the unread count from the API, and names it for a screen reader", async () => {
    stub();
    await mount();
    expect(container!.querySelector("[data-mw-unread-count]")?.textContent).toBe("1");
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 1 unread");
  });

  it("lists the rows, links the one with a link, and marks everything read on open", async () => {
    const calls = stub();
    await mount();
    const details = container!.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container!.textContent).toContain("80% of this period's included tokens used");
    expect(container!.querySelector('a[href="/settings/usage"]')).not.toBeNull();
    expect(calls).toContain("POST /api/me/notifications/read-all");
    expect(container!.querySelector("[data-mw-unread-count]")).toBeNull();
    expect(summary().getAttribute("aria-label")).toBe("Notifications");
  });

  it("polls every minute rather than holding a socket", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stub();
    await mount();
    const before = calls.filter((c) => c.startsWith("GET")).length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls.filter((c) => c.startsWith("GET")).length).toBe(before + 1);
  });

  it("says so inside the menu when the list cannot load, and shows no count", async () => {
    stub(503);
    await mount();
    expect(container!.querySelector("[data-mw-unread-count]")).toBeNull();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be loaded",
    );
  });
});
