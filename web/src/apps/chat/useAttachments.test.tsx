import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentChips } from "./AttachmentChips";
import { useAttachments } from "./useAttachments";
import type { UseAttachments } from "./useAttachments";

/**
 * The attachment state machine, driven through a fake XHR.
 *
 * The questions here are the ones that matter most, and none of
 * them can be answered by asserting a class name exists:
 *
 * - does a refused upload leave the typed text alone?
 * - does the progress reach the UI while the upload is still running?
 * - does a removed upload actually get aborted?
 * - does Retry resend the file the user already chose?
 *
 * The draft is a real `useState` in the harness below, deliberately: the claim
 * being tested is that nothing in the attachment layer can clear it, and the
 * only way to test that is to give it one it could clear if it were able to.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One fake XHR, with the hooks the upload installs and a way to drive them. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  withCredentials = false;
  aborted = false;
  sent: FormData | null = null;
  headers: Record<string, string> = {};
  method = "";
  url = "";

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  /** Report `percent` of the body on the wire. */
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  /** Answer 201 with an attachment row. */
  succeed(body: Record<string, unknown>) {
    this.status = 201;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  /** Answer a refusal, the way the API does: a `detail` string. */
  refuse(status: number, detail: string) {
    this.status = status;
    this.responseText = JSON.stringify({ detail });
    this.onload?.();
  }
  /** The connection dropped. */
  fail() {
    this.onerror?.();
  }
}

const ROW = {
  id: "a-1",
  filename: "shot.png",
  content_type: "image/png",
  size_bytes: 2048,
  scan_status: "clean",
  created_at: "2026-01-01T00:00:00Z",
  message_id: null,
  extract_truncated: false,
};

const LIMITS = {
  max_upload_bytes: 10 * 1024 * 1024,
  quota_bytes: 100 * 1024 * 1024,
  quota_used_bytes: 0,
  quota_remaining_bytes: 100 * 1024 * 1024,
};

function imageFile(name = "shot.png", size = 2048): File {
  return new File([new Blob([new Uint8Array(size)], { type: "image/png" })], name, {
    type: "image/png",
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;
/** The hook's current value, captured from the harness on every render. */
let api: UseAttachments | null = null;
/** The harness's draft, so a test can assert it survived. */
let draft = "";
let guardAnswer: string | null = null;

/**
 * The harness: the hook, a real draft beside it, and the chips.
 *
 * Shaped like `ThreadView`, which is the component under discussion — the
 * draft is a sibling of the attachment state, not a child of it.
 *
 * The two module-level captures are written in an effect, not during render:
 * a reassignment during render is a side effect React is allowed to discard
 * or replay, and `react-hooks/globals` is right to refuse it. The effect runs
 * after every commit, so `api` is still the current value when a test reads
 * it after an `act`.
 */
function Harness() {
  const [text, setText] = useState("the message I typed");
  const attachments = useAttachments({
    conversationId: "c-1",
    csrfCookieName: "mw_csrf",
    bearerToken: null,
    guard: () => guardAnswer,
  });
  useEffect(() => {
    draft = text;
    api = attachments;
  });
  return (
    <div>
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
      <AttachmentChips
        pending={attachments.pending}
        onRemove={attachments.remove}
        onRetry={attachments.retry}
      />
    </div>
  );
}

/** Mount the harness and let the limits fetch settle. */
async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
}

/** Let the queued microtask that starts an upload run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakeXHR.instances = [];
  guardAnswer = null;
  draft = "";
  api = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  // The limits endpoint, and nothing else: `apiFetch` is the only other
  // caller and the DELETE on remove is fire-and-forget.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/attachments/limits/me")) {
        return new Response(JSON.stringify(LIMITS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "deleted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  // jsdom has no object-URL implementation. Patched onto the real `URL`
  // rather than replaced with an object literal: `URL` is also a constructor
  // and several things in the stack call `new URL(...)`, so a literal makes
  // every one of them throw "URL is not a constructor" — which is exactly
  // what it did, and the failure surfaced as an upload that reported that
  // string as its reason.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("the upload, while it runs", () => {
  it("shows a chip with real progress before the server has answered", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();

    const xhr = FakeXHR.instances[0];
    expect(xhr).toBeDefined();
    expect(xhr.method).toBe("POST");
    // The conversation is on the query string, so the row is bound to it.
    expect(xhr.url).toContain("conversation_id=c-1");
    // Cookie auth: the upload rides the same session as every other request.
    expect(xhr.withCredentials).toBe(true);
    // The browser owns the multipart boundary, so the app must NOT set this.
    expect(xhr.headers["Content-Type"]).toBeUndefined();

    await act(async () => {
      xhr.progress(1024, 2048);
    });
    const bar = container!.querySelector("[data-mw-upload-progress]");
    expect(bar?.getAttribute("data-mw-upload-progress")).toBe("50");
    expect(container!.textContent).toContain("50%");
    // A chip is on screen with the filename, while the upload is in flight.
    expect(container!.querySelector('[data-mw-attachment-chip="uploading"]')).not.toBeNull();
    expect(container!.textContent).toContain("shot.png");
  });

  it("never reports 100% before the 201 lands", async () => {
    // The bytes being on the wire is not the upload being done: the server
    // still sniffs, scans, hashes and writes. A bar parked at 100% reads as
    // a hang, which is the failure this cap exists for.
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].progress(2048, 2048);
    });
    expect(
      container!.querySelector("[data-mw-upload-progress]")?.getAttribute(
        "data-mw-upload-progress",
      ),
    ).toBe("99");
  });

  it("does not let the bar go backwards", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    const xhr = FakeXHR.instances[0];
    await act(async () => {
      xhr.progress(1536, 2048);
    });
    await act(async () => {
      // A retried chunk can report a lower `loaded`.
      xhr.progress(512, 2048);
    });
    expect(
      container!.querySelector("[data-mw-upload-progress]")?.getAttribute(
        "data-mw-upload-progress",
      ),
    ).toBe("75");
  });

  it("becomes a ready chip carrying the server's id", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].succeed(ROW);
    });
    expect(container!.querySelector('[data-mw-attachment-chip="ready"]')).not.toBeNull();
    expect(api!.pending).toHaveLength(1);
    const entry = api!.pending[0];
    expect(entry.status).toBe("ready");
    if (entry.status === "ready") expect(entry.attachment.id).toBe("a-1");
  });
});

describe("the typed message survives every failure", () => {
  it("survives a 413 refusal from the server", async () => {
    await mount();
    expect(draft).toBe("the message I typed");
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].refuse(413, "That file is larger than the 10 MB limit.");
    });

    // The draft is exactly as it was.
    expect(draft).toBe("the message I typed");
    expect(container!.querySelector("textarea")!.value).toBe("the message I typed");
    // And the failure is visible, with the SERVER's wording and its real cap.
    expect(container!.querySelector('[data-mw-attachment-chip="failed"]')).not.toBeNull();
    expect(container!.textContent).toContain("larger than the 10 MB limit");
  });

  it("survives a dropped connection", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].fail();
    });
    expect(draft).toBe("the message I typed");
    expect(container!.textContent).toContain("could not reach the server");
  });

  it("survives a client-side refusal, with no upload attempted", async () => {
    await mount();
    await act(async () => {
      api!.add([new File([new Blob([new Uint8Array(10)], { type: "video/mp4" })], "clip.mp4", {
        type: "video/mp4",
      })]);
    });
    await settle();
    expect(draft).toBe("the message I typed");
    // Refused before the network: this is the "for speed, not security" half.
    expect(FakeXHR.instances).toHaveLength(0);
    expect(api!.notice).toMatch(/not a kind of file/);
    expect(api!.pending).toHaveLength(0);
  });

  it("survives the vision refusal, with no upload attempted", async () => {
    // The user learns while choosing, not after waiting.
    guardAnswer = "text-only cannot read images. Your message is untouched.";
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    expect(draft).toBe("the message I typed");
    expect(FakeXHR.instances).toHaveLength(0);
    expect(api!.notice).toContain("cannot read images");
  });

  it("survives a refusal that names the real cap from the API", async () => {
    // The caps come from /api/attachments/limits/me, so the number in the
    // refusal is the one the server enforces.
    await mount();
    await act(async () => {
      api!.add([imageFile("huge.png", 11 * 1024 * 1024)]);
    });
    await settle();
    expect(draft).toBe("the message I typed");
    expect(FakeXHR.instances).toHaveLength(0);
    expect(api!.notice).toContain("10 MB limit");
  });
});

describe("removing and retrying", () => {
  it("aborts an upload in flight when the chip is removed", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    const xhr = FakeXHR.instances[0];
    await act(async () => {
      api!.remove(api!.pending[0].key);
    });
    // Actually cancelled, not merely hidden: the bytes stop going up.
    expect(xhr.aborted).toBe(true);
    expect(api!.pending).toHaveLength(0);
    // An abort is the user's own action, so it reports nothing.
    expect(api!.notice).toBeNull();
    expect(draft).toBe("the message I typed");
  });

  it("deletes an uploaded attachment server-side when it is removed", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].succeed(ROW);
    });
    await act(async () => {
      api!.remove(api!.pending[0].key);
    });
    await settle();
    // Not left for the sweeper: it would charge the user's quota in the
    // meantime for a file they have just said they do not want.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const deletes = calls.filter(
      (call) =>
        String(call[0]).includes("/api/attachments/a-1") &&
        (call[1] as { method?: string } | undefined)?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
  });

  it("retries with the file the user already chose", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].fail();
    });
    expect(api!.pending[0].status).toBe("failed");

    await act(async () => {
      api!.retry(api!.pending[0].key);
    });
    await settle();
    // A second request, with the same file: the user is not asked to find it
    // in a file picker again.
    expect(FakeXHR.instances).toHaveLength(2);
    expect(api!.pending[0].status).toBe("uploading");
    await act(async () => {
      FakeXHR.instances[1].succeed(ROW);
    });
    expect(api!.pending[0].status).toBe("ready");
    expect(draft).toBe("the message I typed");
  });

  it("offers Retry on the failed chip and nothing else loses the text", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].fail();
    });
    // The accessible name names the file, so two failed chips are
    // distinguishable to a screen reader.
    const retry = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry shot.png"]',
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
    });
    await settle();
    expect(FakeXHR.instances).toHaveLength(2);
    expect(draft).toBe("the message I typed");
  });

  it("removes a chip through its own remove control", async () => {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].succeed(ROW);
    });
    const remove = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove shot.png"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => {
      remove!.click();
    });
    expect(api!.pending).toHaveLength(0);
    expect(draft).toBe("the message I typed");
  });
});

describe("the quota, kept in step with the server", () => {
  it("spends the uploaded bytes so the next pre-check is honest", async () => {
    await mount();
    expect(api!.limits?.quota_remaining_bytes).toBe(LIMITS.quota_bytes);
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].succeed(ROW);
    });
    // Without this, the client's idea of "remaining" drifts above the
    // server's for the rest of the session and the pre-check stops helping.
    expect(api!.limits?.quota_used_bytes).toBe(ROW.size_bytes);
    expect(api!.limits?.quota_remaining_bytes).toBe(LIMITS.quota_bytes - ROW.size_bytes);
  });
});

describe("the attachment cap", () => {
  it("refuses the eleventh file, naming the cap", async () => {
    await mount();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        api!.add([imageFile(`shot-${i}.png`)]);
      });
      await settle();
    }
    expect(api!.pending).toHaveLength(10);
    await act(async () => {
      api!.add([imageFile("one-too-many.png")]);
    });
    await settle();
    expect(api!.pending).toHaveLength(10);
    expect(api!.notice).toContain("10 attachments");
    expect(draft).toBe("the message I typed");
  });
});

describe("a deployment with no attachment store", () => {
  it("hides the control rather than offering one that fails", async () => {
    // `require_attachment_store` answers 503 when there is no Postgres.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Attachments need Postgres." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await mount();
    await settle();
    expect(api!.available).toBe(false);
  });

  it("stays available when the limits merely failed to load", async () => {
    // A 500 or a dropped request is not "attachments are off": the caps are
    // unknown, the pre-check skips the size checks rather than guessing, and
    // the server's 413 is still the authority.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await mount();
    await settle();
    expect(api!.available).toBe(true);
    expect(api!.limits).toBeNull();
  });
});

describe("the scan, after the upload", () => {
  /** A 201 whose row is still waiting on the scanner. */
  const SCANNING = {
    id: "att-9",
    filename: "shot.png",
    content_type: "image/png",
    size_bytes: 2048,
    scan_status: "scanning",
    created_at: "2026-10-24T00:00:00Z",
    message_id: null,
    extract_truncated: false,
  };

  /** Route the status poll; everything else as the shared stub does. */
  function answerScan(statuses: string[]) {
    const queue = [...statuses];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/api/attachments/limits/me")) {
          return new Response(JSON.stringify(LIMITS), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/scan")) {
          const status = queue.length > 1 ? queue.shift()! : queue[0];
          return new Response(JSON.stringify({ id: "att-9", scan_status: status }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "deleted" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return calls;
  }

  async function uploadScanning(): Promise<void> {
    await mount();
    await act(async () => {
      api!.add([imageFile()]);
    });
    await settle();
    await act(async () => {
      FakeXHR.instances[0].succeed(SCANNING);
    });
  }

  async function poll(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the chip as scanning and holds the send until the verdict is clean", async () => {
    const calls = answerScan(["scanning", "scanning", "clean"]);
    await uploadScanning();
    expect(container!.querySelector('[data-mw-attachment-chip="scanning"]')).not.toBeNull();
    expect(container!.textContent).toContain("scanning for malware");
    // Nothing to send yet: a scanning entry has no ready id.
    expect(api!.pending.some((entry) => entry.status === "ready")).toBe(false);

    await poll(2);
    expect(container!.querySelector('[data-mw-attachment-chip="scanning"]')).not.toBeNull();
    await poll(1);
    expect(container!.querySelector('[data-mw-attachment-chip="ready"]')).not.toBeNull();
    expect(calls.filter((c) => c.endsWith("/api/attachments/att-9/scan"))).toHaveLength(3);
    // The draft was never touched by any of it.
    expect(draft).toBe("the message I typed");
  });

  it("reports a file the scanner removed, with no retry", async () => {
    answerScan(["infected"]);
    await uploadScanning();
    await poll(1);
    const chip = container!.querySelector('[data-mw-attachment-chip="blocked"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Removed by malware scan.");
    expect(container!.querySelector('[aria-label="Retry shot.png"]')).toBeNull();
    expect(container!.querySelector('[aria-label="Remove shot.png"]')).not.toBeNull();
  });

  it("offers a retry when the scan itself could not run", async () => {
    answerScan(["scan_failed"]);
    await uploadScanning();
    await poll(1);
    const chip = container!.querySelector('[data-mw-attachment-chip="failed"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("could not be scanned");
    expect(container!.querySelector('[aria-label="Retry shot.png"]')).not.toBeNull();
  });

  it("stops polling when the chip is removed, and deletes the row", async () => {
    const calls = answerScan(["scanning"]);
    await uploadScanning();
    await poll(1);
    const before = calls.filter((c) => c.endsWith("/scan")).length;
    await act(async () => {
      api!.remove(api!.pending[0].key);
    });
    await poll(3);
    expect(calls.filter((c) => c.endsWith("/scan")).length).toBe(before);
    expect(calls).toContain("DELETE /api/attachments/att-9");
    expect(api!.pending).toHaveLength(0);
  });
});
