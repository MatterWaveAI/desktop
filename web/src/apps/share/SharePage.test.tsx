import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedTranscript } from "./SharePage";
import { AI_DISCLOSURE } from "../chat/aiDisclosureText";
import { describeExpiry, EXPIRY_PRESETS, shareUrl, type ShareRecord } from "./share";
import { mount, principalWith, stubApi, type Mounted } from "../settings/panes/paneHarness";

/**
 * The public page as a stranger meets it: the snapshot, the disclosure
 * above it, "Made with MatterWave" under it, and an honest line when the
 * link is dead. No composer, no sidebar, nothing that could act on the
 * conversation; attachments are names, never images.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SNAPSHOT = {
  title: "Quarterly plan",
  shared_at: "2026-10-03T12:00:00+00:00",
  org_name: null,
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "What is a process?" },
        { type: "attachment", kind: "image", filename: "diagram.png" },
      ],
      content: "What is a process?",
      model: null,
      created_at: "2026-10-03T11:58:00+00:00",
    },
    {
      role: "assistant",
      parts: [{ type: "text", text: "A process has **its own** memory." }],
      content: "A process has its own memory.",
      model: "fake-mini",
      created_at: "2026-10-03T11:59:00+00:00",
    },
  ],
};

async function open(respond: Parameters<typeof stubApi>[0]) {
  const calls = stubApi(respond);
  mounted = await mount(<SharedTranscript token="tok-123" />, principalWith([]));
  return { calls, page: mounted.container };
}

describe("the shared conversation page", () => {
  it("fetches the snapshot by token and renders it read-only with the disclosure and footer", async () => {
    const { calls, page } = await open(({ method, url }) =>
      method === "GET" && url === "/api/share/tok-123" ? { status: 200, body: SNAPSHOT } : undefined,
    );
    expect(calls.map((c) => c.url)).toEqual(["/api/share/tok-123"]);
    expect(page.getAttribute("data-mw-share-page") ?? page.firstElementChild?.getAttribute("data-mw-share-page")).toBe("ready");

    expect(page.querySelector("h1")?.textContent).toBe("Quarterly plan");
    expect(page.textContent).toContain("Snapshot from 3 Oct 2026");
    expect(page.textContent).not.toContain("Shared by");
    expect(page.textContent).toContain(AI_DISCLOSURE);
    // Markdown still goes through the renderer: the bold survives.
    expect(page.querySelector("strong")?.textContent).toBe("its own");
    expect(page.textContent).toContain("fake-mini");
    // The attachment is a name, never an image (the only image is the brand mark).
    expect(page.querySelector("article img")).toBeNull();
    expect(page.textContent).toContain("diagram.png");
    expect(page.textContent).toContain("not included in the share");
    // Nothing to type into, nothing to act on.
    expect(page.querySelector("textarea")).toBeNull();
    expect(page.querySelector("button")).toBeNull();
    const footer = page.querySelector("footer a");
    expect(footer?.textContent).toContain("Made with MatterWave");
    expect(footer?.getAttribute("href")).toBe("/");
  });

  it("names the org only when the API sent a name", async () => {
    const { page } = await open(() => ({ status: 200, body: { ...SNAPSHOT, org_name: "Acme" } }));
    expect(page.textContent).toContain("Shared by Acme");
  });

  it("says a dead link is unavailable without saying why, and still offers the way home", async () => {
    const { page } = await open(() => ({
      status: 404,
      body: { detail: "This shared conversation is not available." },
    }));
    expect(page.querySelector("h1")?.textContent).toBe("This shared conversation is not available");
    const status = page.querySelector("[role='status']");
    expect(status?.textContent).toContain("may have expired");
    expect(status?.textContent).toContain("ask them to share it again");
    // No title from a snapshot that never arrived, and a way on that is a button, not a footnote.
    expect(page.textContent).not.toContain("Snapshot from");
    const cta = [...page.querySelectorAll("a")].find((a) => a.textContent === "Go to MatterWave");
    expect(cta?.getAttribute("href")).toBe("/");
    expect(page.querySelector("footer a")?.getAttribute("href")).toBe("/");
  });

  it("shows the rate limit's own wording on a 429", async () => {
    const { page } = await open(() => ({
      status: 429,
      body: { detail: "Too many shared pages were opened from this address. Try again in 1 minutes." },
    }));
    expect(page.querySelector("[role='status']")?.textContent).toContain("Too many shared pages");
  });
});

describe("the share helpers", () => {
  const base: ShareRecord = {
    id: "s1",
    conversation_id: "c1",
    title: "T",
    message_count: 2,
    created_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    revoked_at: null,
    view_count: 0,
    status: "active",
  };

  it("builds the copied link from this origin and the API's path", () => {
    expect(shareUrl("/share/abc", "https://chat.example.com")).toBe(
      "https://chat.example.com/share/abc",
    );
  });

  it("describes expiry for a reader", () => {
    expect(describeExpiry(base)).toBe("Until revoked");
    expect(describeExpiry({ ...base, expires_at: "2026-10-12T12:00:00Z" })).toMatch(
      /^Expires 12 Oct 2026$/,
    );
    expect(describeExpiry({ ...base, status: "revoked" })).toBe("Revoked");
    expect(describeExpiry({ ...base, status: "expired" })).toBe("Expired");
  });

  it("offers bounded presets with 'until revoked' last", () => {
    expect(EXPIRY_PRESETS.at(-1)?.seconds).toBeNull();
    for (const preset of EXPIRY_PRESETS.slice(0, -1)) {
      expect(preset.seconds).toBeGreaterThanOrEqual(60);
      expect(preset.seconds).toBeLessThanOrEqual(365 * 24 * 60 * 60);
    }
  });
});

describe("the shared conversation page's chrome", () => {
  it("wears the brand, offers Continue in MatterWave, labels the model and asks crawlers to leave", async () => {
    const { page } = await open(() => ({
      status: 200,
      body: {
        ...SNAPSHOT,
        messages: [{ ...SNAPSHOT.messages[1], model_label: "Fake Mini" }],
      },
    }));
    const header = page.querySelector("header");
    expect(header?.textContent).toContain("MatterWave");
    expect(header?.textContent).toContain("Shared conversation");
    const ctas = [...page.querySelectorAll("a")].filter(
      (a) => a.textContent === "Continue in MatterWave",
    );
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    expect(ctas.every((a) => a.getAttribute("href") === "/")).toBe(true);
    // The label the picker shows, not the raw id.
    expect(page.querySelector("[data-mw-share-model='fake-mini']")?.textContent).toBe("Fake Mini");
    expect(document.head.querySelector("meta[name='robots']")?.getAttribute("content")).toBe(
      "noindex, nofollow",
    );
    mounted?.unmount();
    mounted = null;
    expect(document.head.querySelector("meta[name='robots']")).toBeNull();
  });

  it("renders an included attachment from the share's own route and never a signed URL", async () => {
    const { page } = await open(() => ({
      status: 200,
      body: {
        ...SNAPSHOT,
        messages: [
          {
            ...SNAPSHOT.messages[0],
            parts: [
              { type: "text", text: "Here" },
              {
                type: "attachment",
                kind: "image",
                filename: "diagram.png",
                attachment_id: "att-1",
                content_type: "image/png",
              },
              {
                type: "attachment",
                kind: "document",
                filename: "notes.pdf",
                attachment_id: "att-2",
                content_type: "application/pdf",
              },
            ],
          },
        ],
      },
    }));
    const img = page.querySelector<HTMLImageElement>("article img");
    expect(img?.getAttribute("src")).toBe("/api/share/tok-123/attachments/att-1");
    expect(img?.getAttribute("alt")).toBe("diagram.png");
    const link = [...page.querySelectorAll("article a")].find((a) => a.textContent === "notes.pdf");
    expect(link?.getAttribute("href")).toBe("/api/share/tok-123/attachments/att-2");
    expect(page.innerHTML).not.toContain("sig=");
    expect(page.textContent).not.toContain("not included in the share");
  });
});
