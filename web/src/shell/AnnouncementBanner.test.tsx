import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAnnouncement } from "../apps/admin/announcementsApi";
import { AnnouncementBanner } from "./AnnouncementBanner";

/**
 * The banner: the active announcements in the order the API gave, a link
 * only when it passes the safe-URL check, a dismissal that holds on this
 * device across a reload, a critical one hidden only for now, one line per
 * severity with the rest behind "N more", and silence when the read fails
 * or storage throws.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const row = (over: Partial<ActiveAnnouncement>): ActiveAnnouncement => ({
  id: "a1",
  message: "Planned maintenance tonight at 22:00 UTC",
  severity: "info",
  link: null,
  starts_at: "2026-10-20T12:00:00Z",
  ends_at: null,
  dismissible: true,
  ...over,
});

function stub(rows: ActiveAnnouncement[], status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status < 400,
        status,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(status < 400 ? { data: rows } : { detail: "down" }),
      } as Response),
    ),
  );
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AnnouncementBanner />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

async function remount() {
  act(() => root?.unmount());
  container?.remove();
  return render();
}

const banners = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>("[data-announcement]"));

describe("AnnouncementBanner", () => {
  it("shows each active announcement, in the API's order, with its severity", async () => {
    stub([
      row({ id: "c", severity: "critical", message: "Chat is down", dismissible: false }),
      row({ id: "w", severity: "warning", message: "Slow responses" }),
      row({ id: "i", message: "New: folders" }),
    ]);
    const el = await render();
    const shown = banners(el);
    expect(shown.map((b) => b.textContent)).toEqual([
      expect.stringContaining("Chat is down"),
      expect.stringContaining("Slow responses"),
      expect.stringContaining("New: folders"),
    ]);
    expect(shown.map((b) => b.dataset.announcement)).toEqual(["critical", "warning", "info"]);
    expect(shown[0].getAttribute("role")).toBe("alert");
    expect(shown[1].getAttribute("role")).toBe("status");
  });

  it("renders nothing when there is nothing active, or the read fails", async () => {
    stub([]);
    expect((await render()).innerHTML).toBe("");
    stub([], 500);
    expect((await remount()).innerHTML).toBe("");
  });

  it("keeps a dismissed one dismissed on this device, and only that one", async () => {
    stub([row({ id: "a1", severity: "warning", message: "First" }), row({ id: "a2", message: "Second" })]);
    const el = await render();
    const first = banners(el)[0];
    await act(async () => {
      first.querySelector<HTMLButtonElement>("button[aria-label='Dismiss announcement']")!.click();
    });
    expect(banners(el).map((b) => b.textContent)).toEqual([expect.stringContaining("Second")]);
    expect(JSON.parse(localStorage.getItem("mw-dismissed-announcements")!)).toEqual(["a1"]);

    const again = await remount();
    expect(banners(again).map((b) => b.textContent)).toEqual([expect.stringContaining("Second")]);
  });

  it("lets a critical one be hidden for now, never remembered", async () => {
    localStorage.setItem("mw-dismissed-announcements", JSON.stringify(["c"]));
    stub([row({ id: "c", severity: "critical", message: "Chat is down", dismissible: false })]);
    const el = await render();
    expect(banners(el)).toHaveLength(1);
    expect(el.querySelector("button[aria-label='Dismiss announcement']")).toBeNull();
    await act(async () => {
      el.querySelector<HTMLButtonElement>("button[aria-label='Hide announcement for now']")!.click();
    });
    expect(banners(el)).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("mw-dismissed-announcements")!)).toEqual(["c"]);
    expect(banners(await remount())).toHaveLength(1);
  });

  it("shows one line per severity, the rest behind 'N more', clamped to two lines", async () => {
    stub([
      row({ id: "w1", severity: "warning", message: "Slow responses" }),
      row({ id: "w2", severity: "warning", message: "Search is degraded" }),
      row({ id: "w3", severity: "warning", message: "Uploads are slow" }),
      row({ id: "i1", message: "New: folders" }),
    ]);
    const el = await render();
    expect(banners(el).map((b) => b.dataset.announcement)).toEqual(["warning", "info"]);
    expect(banners(el)[0].querySelector("p")!.className).toContain("line-clamp-2");
    const more = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "2 more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      more.click();
    });
    expect(banners(el).map((b) => b.textContent)).toEqual([
      expect.stringContaining("Slow responses"),
      expect.stringContaining("Search is degraded"),
      expect.stringContaining("Uploads are slow"),
      expect.stringContaining("New: folders"),
    ]);
    expect(banners(el)[0].querySelector("p")!.className).not.toContain("line-clamp-2");
    const less = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Show less")!;
    expect(less.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      less.click();
    });
    expect(banners(el)).toHaveLength(2);
  });

  it("links only through the safe-URL check", async () => {
    stub([
      row({ id: "ok", severity: "critical", message: "Status", link: "https://status.example.com/" }),
      row({ id: "local", severity: "warning", message: "Help", link: "/help" }),
      row({ id: "bad", message: "Evil", link: "javascript:alert(1)" }),
    ]);
    const el = await render();
    const [ok, local, bad] = banners(el);
    const okLink = ok.querySelector("a")!;
    expect(okLink.getAttribute("href")).toBe("https://status.example.com/");
    expect(okLink.getAttribute("target")).toBe("_blank");
    expect(okLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(local.querySelector("a")!.getAttribute("target")).toBeNull();
    expect(bad.querySelector("a")).toBeNull();
  });

  it("survives storage that throws: it shows, and a dismissal holds for the page", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stub([row({ id: "a1" })]);
    const el = await render();
    expect(banners(el)).toHaveLength(1);
    await act(async () => {
      el.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(banners(el)).toHaveLength(0);
  });
});
