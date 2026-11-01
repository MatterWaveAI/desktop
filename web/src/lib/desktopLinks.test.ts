import { afterEach, describe, expect, it, vi } from "vitest";

/** Links out of the app, under a fake bridge that records `open_external`. */

function fakeBridge() {
  const invoke = vi.fn(async () => undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

let uninstall: () => void = () => {};

async function load() {
  vi.resetModules();
  const links = await import("./desktopLinks");
  return {
    ...links,
    installExternalLinks: () => {
      uninstall = links.installExternalLinks();
    },
  };
}

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = "a link";
  document.body.append(a);
  return a;
}

/** Click the way a person does, and report whether the webview would follow it. */
function click(target: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent(init.button === 1 ? "auxclick" : "click", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
}

afterEach(() => {
  uninstall();
  uninstall = () => {};
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("externalUrl", () => {
  const origin = "http://tauri.localhost";

  it("sends web and mail links that leave the app to the browser", async () => {
    const { externalUrl } = await load();
    expect(externalUrl("https://docs.example.test/a?b=1", origin)).toBe("https://docs.example.test/a?b=1");
    expect(externalUrl("http://example.test", origin)).toBe("http://example.test/");
    expect(externalUrl("mailto:help@example.test", origin)).toBe("mailto:help@example.test");
  });

  it("leaves the app's own links, and every other scheme, to the webview", async () => {
    const { externalUrl } = await load();
    expect(externalUrl("/settings/billing", origin)).toBeNull();
    expect(externalUrl("http://tauri.localhost/apps/chat", origin)).toBeNull();
    expect(externalUrl("#top", origin)).toBeNull();
    expect(externalUrl("javascript:alert(1)", origin)).toBeNull();
    expect(externalUrl("blob:http://tauri.localhost/x", origin)).toBeNull();
    expect(externalUrl("file:///etc/passwd", origin)).toBeNull();
    expect(externalUrl(null, origin)).toBeNull();
  });
});

describe("installExternalLinks", () => {
  it("opens a reply's link in the system browser instead of the webview", async () => {
    const invoke = fakeBridge();
    const { installExternalLinks } = await load();
    installExternalLinks();

    const a = link("https://example.test/paper", { target: "_blank", rel: "noopener noreferrer" });
    expect(click(a)).toBe(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_external", { url: "https://example.test/paper" }),
    );
  });

  it("does the same for a middle click and for a click on something inside the link", async () => {
    const invoke = fakeBridge();
    const { installExternalLinks } = await load();
    installExternalLinks();

    const a = link("https://example.test/one");
    const inner = document.createElement("span");
    a.append(inner);
    expect(click(inner)).toBe(false);
    expect(click(a, { button: 1 })).toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it("leaves the router's links, downloads, handled clicks and right clicks alone", async () => {
    const invoke = fakeBridge();
    const { installExternalLinks } = await load();
    installExternalLinks();

    expect(click(link("/apps/chat?c=1"))).toBe(true);
    expect(click(link("https://example.test/export.json", { download: "" }))).toBe(true);
    expect(click(link("https://example.test/menu"), { button: 2 })).toBe(true);
    const handled = link("https://example.test/handled");
    handled.addEventListener("click", (event) => event.preventDefault());
    click(handled);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing in a browser", async () => {
    const { installExternalLinks, openOutside } = await load();
    installExternalLinks();
    expect(click(link("https://example.test/x"))).toBe(true);
    expect(openOutside("https://example.test/x")).toBe(false);
  });
});
