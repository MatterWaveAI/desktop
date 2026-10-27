import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ago,
  SYNC_CHANGED_EVENT,
  SYNC_POLL_MS,
  syncLine,
  type SyncStatus,
} from "../lib/edgeSync";
import { SyncBadge } from "./SyncBadge";

/**
 * The box's sync badge: the one line the design names for each state of
 * the worker's last run, nothing on the platform or on an unpaired box, and
 * no polling once the API has said it is not a box.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-20T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const PAIRED: SyncStatus = {
  box: true,
  paired: true,
  device_id: "0192b1c4-7a3e-7d10-9a51-3f6c2e8b4d21",
  platform_url: "https://app.example.test",
  name: "Kitchen Pi",
  last_synced_at: minutesAgo(4),
  offline: false,
  pending: 0,
  pending_messages: 0,
  pending_capped: false,
  stopped: null,
  last_error: null,
};

describe("syncLine", () => {
  it("says nothing off a box or on a box that is not paired", () => {
    expect(syncLine(null, NOW)).toBeNull();
    expect(syncLine({ box: false, paired: false }, NOW)).toBeNull();
    expect(syncLine({ box: true, paired: false }, NOW)).toBeNull();
  });

  it.each<[string, Partial<SyncStatus>, string, string]>([
    ["synced", {}, "Synced 4 minutes ago", "ok"],
    ["just now", { last_synced_at: minutesAgo(0) }, "Synced just now", "ok"],
    [
      "offline",
      {
        offline: true,
        last_synced_at: minutesAgo(120),
        last_error: "ConnectError",
      },
      "Offline, last synced 2 hours ago",
      "warn",
    ],
    [
      "backlog",
      { pending: 12, pending_messages: 40 },
      "Syncing 12 conversations…",
      "busy",
    ],
    [
      "failing",
      { last_error: "HTTP 503" },
      "Sync failing, last synced 4 minutes ago",
      "warn",
    ],
    [
      "key rejected",
      { stopped: "key_rejected", last_error: "HTTP 401" },
      "Sync key rejected: pair again",
      "error",
    ],
    [
      "out of date",
      { stopped: "platform_newer" },
      "Box out of date for this platform",
      "error",
    ],
    [
      "first run",
      { last_synced_at: null },
      "Waiting for the first sync",
      "busy",
    ],
  ])("%s", (_name, patch, text, tone) => {
    const line = syncLine({ ...PAIRED, ...patch }, NOW)!;
    expect(line.text).toBe(text);
    expect(line.tone).toBe(tone);
  });

  it("puts the waiting count and the last error in the tooltip", () => {
    const line = syncLine(
      {
        ...PAIRED,
        offline: true,
        pending_messages: 1000,
        pending_capped: true,
        last_error: "ConnectError",
      },
      NOW,
    )!;
    expect(line.detail).toContain("1000+ messages waiting to sync");
    expect(line.detail).toContain("Last error: ConnectError.");
  });

  it("says when the platform refused messages the box stepped past", () => {
    const line = syncLine(
      {
        ...PAIRED,
        skipped: 2,
        skipped_recent: [
          {
            conversation_id: "c1",
            message_id: "m1",
            status: 422,
            at: minutesAgo(3),
          },
        ],
      },
      NOW,
    )!;
    expect(line.text).toBe("Synced 4 minutes ago, 2 messages not mirrored");
    expect(line.tone).toBe("warn");
    expect(line.detail).toContain(
      "The platform refused 2 messages; they were skipped",
    );
    expect(line.detail).toContain("last: HTTP 422");
    const one = syncLine({ ...PAIRED, skipped: 1 }, NOW)!;
    expect(one.text).toBe("Synced 4 minutes ago, 1 message not mirrored");
    expect(syncLine({ ...PAIRED, skipped: 0 }, NOW)!.tone).toBe("ok");
  });

  it("counts time in words", () => {
    expect(ago(minutesAgo(1), NOW)).toBe("1 minute ago");
    expect(ago(minutesAgo(60 * 49), NOW)).toBe("2 days ago");
  });
});

describe("<SyncBadge>", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stub(answers: SyncStatus[]) {
    const fetchMock = vi.fn(async () => {
      const body = answers.length > 1 ? answers.shift()! : answers[0];
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  async function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<SyncBadge now={() => NOW} />);
    });
    await settle();
  }

  it("shows the line on a paired box, with its tone and tooltip", async () => {
    stub([{ ...PAIRED, pending_messages: 3 }]);
    await render();
    const badge = container!.querySelector("[role='status']")!;
    expect(badge.textContent).toBe("Synced 4 minutes ago");
    expect(badge.getAttribute("data-tone")).toBe("ok");
    expect(badge.getAttribute("title")).toContain("3 messages waiting to sync");
  });

  it("renders nothing on the platform and stops asking", async () => {
    vi.useFakeTimers();
    const fetchMock = stub([{ box: false, paired: false }]);
    await render();
    expect(container!.textContent).toBe("");
    await act(async () => {
      vi.advanceTimersByTime(SYNC_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads at once when the Devices pane pairs the box", async () => {
    stub([{ box: true, paired: false }, PAIRED]);
    await render();
    expect(container!.textContent).toBe("");
    await act(async () => {
      window.dispatchEvent(new Event(SYNC_CHANGED_EVENT));
    });
    await settle();
    expect(container!.textContent).toBe("Synced 4 minutes ago");
  });
});
