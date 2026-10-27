import { afterEach, describe, expect, it, vi } from "vitest";
import { DataPane } from "./DataPane";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  stubApi,
  type Mounted,
} from "./paneHarness";

/**
 * The export button asks the API for a background export and offers the
 * signed download once the job says it is ready; a failed build says so.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

const LINK = "/api/me/export/e1/download?expires=1&sig=abc";

describe("DataPane export", () => {
  it("requests an export and links the download when it is ready", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "POST" && url === "/api/me/export")
        return { status: 202, body: { id: "e1", status: "ready" } };
      if (method === "GET" && url === "/api/me/export/e1")
        return {
          status: 200,
          body: { id: "e1", status: "ready", download_url: LINK },
        };
      if (url === "/api/me/shares") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<DataPane />, principalWith(["user"]));

    click(buttonNamed(mounted.container, "Prepare export"));
    await flush();
    await flush();

    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/me/export"),
    ).toBe(true);
    const link =
      mounted.container.querySelector<HTMLAnchorElement>("a[download]");
    expect(link?.getAttribute("href")).toBe(LINK);
    // The outcome is announced, not only shown by a link appearing.
    const status = mounted.container.querySelector("[role='status'][aria-live='polite']");
    expect(status?.textContent).toBe("Your export is ready.");
  });

  it("announces that the export is being prepared while it runs", async () => {
    stubApi(({ method, url }) => {
      if (method === "POST" && url === "/api/me/export")
        return { status: 202, body: { id: "e3", status: "pending" } };
      if (method === "GET" && url === "/api/me/export/e3")
        return { status: 200, body: { id: "e3", status: "pending" } };
      if (url === "/api/me/shares") return { status: 200, body: { data: [] } };
      return undefined;
    });
    vi.useFakeTimers();
    try {
      mounted = await mount(<DataPane />, principalWith(["user"]));
      click(buttonNamed(mounted.container, "Prepare export"));
      await flush();
      const status = mounted.container.querySelector("[role='status'][aria-live='polite']");
      expect(status?.textContent).toBe("Preparing your export. This can take a minute.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the build failed", async () => {
    stubApi(({ method, url }) => {
      if (method === "POST" && url === "/api/me/export")
        return { status: 202, body: { id: "e2", status: "failed" } };
      if (url === "/api/me/shares") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<DataPane />, principalWith(["user"]));

    click(buttonNamed(mounted.container, "Prepare export"));
    await flush();

    expect(mounted.container.querySelector("[role='alert']")?.textContent).toBe(
      "Could not build the export.",
    );
    expect(mounted.container.querySelector("a[download]")).toBeNull();
  });
});
