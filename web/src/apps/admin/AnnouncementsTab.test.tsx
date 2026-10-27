import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncementsTab } from "./AnnouncementsTab";
import type { AdminAnnouncement } from "./announcementsApi";
import { chooseOption, combobox } from "./selectTesting";

/**
 * The operator's tab: the list with each row's state, a post that sends
 * what was typed, "end now" on the server's clock, and a critical one that
 * the form will not offer as dismissible.
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
});

const ROW: AdminAnnouncement = {
  id: "a1",
  message: "Planned maintenance tonight",
  severity: "warning",
  link: "https://status.example.com",
  starts_at: "2026-10-20T12:00:00Z",
  ends_at: null,
  dismissible: true,
  created_by: "ops",
  created_at: "2026-10-20T11:00:00Z",
  updated_by: "ops",
  updated_at: "2026-10-20T11:00:00Z",
  state: "active",
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(rows: AdminAnnouncement[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = method === "GET" ? { data: rows } : { ...ROW, state: "ended" };
      return Promise.resolve({
        ok: true,
        status: method === "POST" ? 201 : 200,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
  return calls;
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AnnouncementsTab />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

describe("AnnouncementsTab", () => {
  it("lists each announcement with its severity and state", async () => {
    stub([ROW, { ...ROW, id: "a2", message: "Old incident", severity: "critical", state: "ended" }]);
    const el = await render();
    const items = el.querySelectorAll("ul[aria-label='Announcements'] > li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Planned maintenance tonight");
    expect(items[0].textContent).toContain("active");
    expect(items[1].textContent).toContain("ended");
    // An ended one has nothing left to end.
    expect(Array.from(items[1].querySelectorAll("button")).map((b) => b.textContent)).not.toContain("End now");
  });

  it("posts what was typed and leaves the start to the server", async () => {
    const calls = stub([]);
    const el = await render();
    const form = el.querySelector<HTMLFormElement>("form[aria-label='New announcement']")!;
    await act(async () => {
      type(form.querySelector("textarea")!, "Chat is degraded");
      type(form.querySelector<HTMLInputElement>("input[placeholder^='https']")!, "/help");
    });
    await chooseOption(combobox(form, "Severity"), "Warning");
    await act(async () => {
      button(form, "Post announcement").click();
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/admin/announcements");
    expect(post.body).toEqual({
      message: "Chat is degraded",
      severity: "warning",
      link: "/help",
      ends_at: null,
      dismissible: true,
    });
  });

  it("will not offer a critical one as dismissible", async () => {
    const calls = stub([]);
    const el = await render();
    const form = el.querySelector<HTMLFormElement>("form[aria-label='New announcement']")!;
    await act(async () => {
      type(form.querySelector("textarea")!, "Outage");
    });
    await chooseOption(combobox(form, "Severity"), "Critical");
    const checkbox = form.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    await act(async () => {
      button(form, "Post announcement").click();
    });
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ severity: "critical", dismissible: false });
  });

  it("ends one now on the server's clock", async () => {
    const calls = stub([ROW]);
    const el = await render();
    await act(async () => {
      button(el, "End now").click();
    });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/admin/announcements/a1");
    expect(patch.body).toEqual({ end_now: true });
  });
});
