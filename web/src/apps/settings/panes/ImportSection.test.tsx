import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSection } from "./ImportSection";
import { importFailureMessage, leftBehind, percentDone, summarize, type ImportRecord } from "../importApi";
import { buttonNamed, flush, mount, principalWith, stubApi, type Mounted } from "./paneHarness";
import { ApiError } from "../../../lib/api";

/**
 * The Import card: pick or drop an export, see what was found and how far
 * the import has got, then the summary and what the import could not
 * carry. A refused upload says why in the API's own words.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PENDING: ImportRecord = {
  id: "imp-1",
  status: "pending",
  source: "chatgpt",
  filename: "conversations.json",
  size_bytes: 2048,
  conversations_total: 3,
  conversations_done: 0,
  conversations_created: 0,
  conversations_existing: 0,
  conversations_skipped: 0,
  messages_created: 0,
  attachments_skipped: 0,
  branches_dropped: 0,
  error: null,
  created_at: "2026-10-03T12:00:00Z",
  started_at: null,
  completed_at: null,
};

const DONE: ImportRecord = {
  ...PENDING,
  status: "done",
  conversations_done: 3,
  conversations_created: 2,
  conversations_existing: 1,
  messages_created: 12,
  attachments_skipped: 1,
  branches_dropped: 2,
  completed_at: "2026-10-03T12:00:09Z",
};

function fileInput(): HTMLInputElement {
  const input = mounted!.container.querySelector<HTMLInputElement>("input[type='file']");
  if (!input) throw new Error("no file input");
  return input;
}

async function pick(file: File): Promise<void> {
  const input = fileInput();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

describe("the import card", () => {
  it("uploads the file as multipart, shows the result and what was left behind", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/imports") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === "/api/me/imports") return { status: 202, body: DONE };
      return undefined;
    });
    mounted = await mount(<ImportSection />, principalWith(["user"]));
    expect(buttonNamed(mounted.container, "Choose export file")).toBeDefined();

    await pick(new File(["[]"], "conversations.json", { type: "application/json" }));
    const result = mounted.container.querySelector("[data-mw-import-result]");
    expect(result?.textContent).toContain("2 conversations imported from ChatGPT");
    expect(result?.textContent).toContain("12 messages");
    expect(result?.textContent).toContain("1 already here");
    expect(result?.textContent).toContain("2 messages on other branches");
    expect(result?.textContent).toContain("1 attachment was not imported");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/me/imports")).toBe(true);
    // The row joins the history list.
    expect(mounted.container.querySelector("[data-mw-import-status='done']")?.textContent).toContain(
      "2 imported",
    );
  });

  it("follows a pending import until it is done", async () => {
    vi.useFakeTimers();
    let polls = 0;
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/imports") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === "/api/me/imports") return { status: 202, body: PENDING };
      if (method === "GET" && url === "/api/me/imports/imp-1") {
        polls += 1;
        return {
          status: 200,
          body: polls < 2 ? { ...PENDING, status: "running", conversations_done: 1 } : DONE,
        };
      }
      return undefined;
    });
    mounted = await mount(<ImportSection />, principalWith(["user"]));
    await pick(new File(["[]"], "conversations.json", { type: "application/json" }));
    expect(mounted.container.querySelector("[data-mw-import-progress='pending']")?.textContent).toContain(
      "Found 3 conversations",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await flush();
    const running = mounted.container.querySelector("[data-mw-import-progress='running']");
    expect(running?.textContent).toContain("Importing 1 of 3");
    expect(running?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("33");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await flush();
    expect(mounted.container.querySelector("[data-mw-import-result]")?.textContent).toContain(
      "2 conversations imported",
    );
  });

  it("says why an upload was refused, in the API's words", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/imports") return { status: 200, body: { data: [] } };
      if (method === "POST" && url === "/api/me/imports") {
        return { status: 422, body: { detail: "This file is not a ChatGPT or Claude export." } };
      }
      return undefined;
    });
    mounted = await mount(<ImportSection />, principalWith(["user"]));
    await pick(new File(["{}"], "notes.json", { type: "application/json" }));
    const alert = mounted.container.querySelector("[role='alert'][data-mw-import-error]");
    expect(alert?.textContent).toBe("This file is not a ChatGPT or Claude export.");
    expect(mounted.container.querySelector("[data-mw-import-result]")).toBeNull();
  });

  it("picks up an import that was already running", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/imports") {
        return { status: 200, body: { data: [{ ...PENDING, status: "running", conversations_done: 2 }] } };
      }
      return undefined;
    });
    mounted = await mount(<ImportSection />, principalWith(["user"]));
    expect(mounted.container.querySelector("[data-mw-import-progress='running']")?.textContent).toContain(
      "Importing 2 of 3",
    );
    expect(buttonNamed(mounted.container, "Choose export file").disabled).toBe(true);
  });
});

describe("the import helpers", () => {
  it("summarises and names what was left behind", () => {
    expect(summarize(DONE)).toBe(
      "2 conversations imported from ChatGPT · 12 messages · 1 already here",
    );
    expect(summarize({ ...DONE, conversations_skipped: 4, source: "claude" })).toBe(
      "2 conversations imported from Claude · 12 messages · 1 already here · 4 skipped",
    );
    expect(leftBehind(DONE)).toContain("2 messages on other branches");
    expect(leftBehind(DONE)).toContain("1 attachment was not imported");
    expect(leftBehind({ ...DONE, branches_dropped: 0, attachments_skipped: 0 })).toBe("");
    expect(percentDone(PENDING)).toBe(0);
    expect(percentDone({ ...PENDING, conversations_done: 1 })).toBe(33);
    expect(percentDone(DONE)).toBe(100);
  });

  it("explains a refusal", () => {
    expect(importFailureMessage(new ApiError(413, "Request body is larger"))).toContain("100 MB");
    expect(importFailureMessage(new ApiError(402, "Over the cap"))).toBe("Over the cap");
    expect(importFailureMessage(new ApiError(409, "Already running"))).toBe("Already running");
    expect(importFailureMessage(new Error("x"))).toContain("could not be uploaded");
  });
});
