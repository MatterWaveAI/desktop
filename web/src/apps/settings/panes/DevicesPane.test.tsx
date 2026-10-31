import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../../../lib/edgeSync";
import { DevicesPane, type EdgeDevice } from "./DevicesPane";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * Devices, both ways round. On the platform: a member is told it is for
 * admins; an admin names a box, gets the code once, sees the paired boxes
 * and unpairs one with the call the route expects. On a box: the pane takes
 * the platform address and the code, then shows the sync status and can
 * unpair.
 *
 * Desktop (clients/desktop): the pairing code is shown against the API base
 * the app was built with, not the webview's own origin.
 */

const desktop = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  desktopAppInfo: vi.fn<() => Promise<{ version: string; api_base_url: string | null } | null>>(
    async () => null,
  ),
  desktopDevicePairing: vi.fn<
    () => Promise<{
      paired: boolean;
      name: string | null;
      hint: string | null;
      device_id: string | null;
      paired_at: number | null;
    }>
  >(async () => ({ paired: false, name: null, hint: null, device_id: null, paired_at: null })),
  desktopPairDevice: vi.fn<
    (code: string) => Promise<{
      paired: boolean;
      name: string | null;
      hint: string | null;
      device_id: string | null;
      paired_at: number | null;
    }>
  >(async () => ({ paired: false, name: null, hint: null, device_id: null, paired_at: null })),
  desktopUnpairDevice: vi.fn<
    () => Promise<{
      paired: boolean;
      name: string | null;
      hint: string | null;
      device_id: string | null;
      paired_at: number | null;
    }>
  >(async () => ({ paired: false, name: null, hint: null, device_id: null, paired_at: null })),
}));

vi.mock("../../../lib/desktopAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/desktopAuth")>();
  return { ...actual, ...desktop };
});

const PLATFORM: SyncStatus = { box: false, paired: false };
const UNPAIRED_BOX: SyncStatus = { box: true, paired: false };
const PAIRED_BOX: SyncStatus = {
  box: true,
  paired: true,
  device_id: "0192b1c4-7a3e-7d10-9a51-3f6c2e8b4d21",
  platform_url: "https://app.example.test",
  name: "Kitchen Pi",
  last_synced_at: new Date().toISOString(),
  offline: false,
  pending: 0,
  pending_messages: 2,
  pending_capped: false,
  stopped: null,
  last_error: null,
};

const SHED: EdgeDevice = {
  id: "11111111-1111-7111-8111-111111111111",
  prefix: "mw_abcd",
  name: "Edge: Shed",
  box_name: "Shed",
  created_at: "2026-10-01T10:00:00+00:00",
  last_used_at: null,
  revoked_at: null,
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  desktop.isDesktop.mockReturnValue(false);
  desktop.desktopAppInfo.mockResolvedValue(null);
  desktop.desktopDevicePairing.mockResolvedValue({
    paired: false,
    name: null,
    hint: null,
    device_id: null,
    paired_at: null,
  });
  desktop.desktopPairDevice.mockResolvedValue({
    paired: false,
    name: null,
    hint: null,
    device_id: null,
    paired_at: null,
  });
  desktop.desktopUnpairDevice.mockResolvedValue({
    paired: false,
    name: null,
    hint: null,
    device_id: null,
    paired_at: null,
  });
});

describe("the pairing code", () => {
  const MINTED = {
    code: "ABCD-EFGH-JKMN",
    name: "Kitchen Pi",
    expires_in: 600,
    expires_at: "2026-10-20T12:10:00Z",
  };

  async function mintOne() {
    const calls = stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: PLATFORM };
      if (call.method === "GET" && call.url === "/api/sync/devices") return { status: 200, body: { data: [] } };
      if (call.method === "POST" && call.url === "/api/sync/pairings") {
        return { status: 201, body: { ...MINTED, code: calls.length > 3 ? "WXYZ-WXYZ-WXYZ" : MINTED.code } };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const form = pairForm(mounted.container, "Pair an edge box");
    setInputValue(form.querySelector("input")!, "Kitchen Pi");
    submit(form);
    await flush();
    return calls;
  }

  function countdown(): string {
    return mounted!.container.querySelector("[data-testid='pairing-countdown']")?.textContent ?? "";
  }

  it("copies the code and says so where a screen reader hears it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mintOne();
    const live = mounted!.container.querySelector("[data-slot='copy-button']")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Copy code");
    click(buttonNamed(mounted!.container, "Copy code"));
    await flush();
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH-JKMN");
    expect(live.textContent).toBe("Copied");
  });

  it("counts down to the expiry the API gave, then offers a new code", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const calls = await mintOne();
    expect(countdown()).toContain("10:00");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdown()).toContain("9:59");
    act(() => {
      vi.advanceTimersByTime(599_000);
    });
    expect(countdown()).toContain("Expired");
    // A spent code is not offered for copying; a fresh one for the same box is.
    expect([...mounted!.container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Copy code",
    );
    click(buttonNamed(mounted!.container, "Make a new code"));
    await flush();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body)).toEqual([{ name: "Kitchen Pi" }, { name: "Kitchen Pi" }]);
    expect(mounted!.container.querySelector("[data-testid='pairing-code']")!.textContent).toBe("WXYZ-WXYZ-WXYZ");
    expect(countdown()).toContain("10:00");
  });
});

describe("the box's pairing form", () => {
  it("hints at the code's shape instead of a placeholder that reads like a real code", async () => {
    stubApi((call) => (call.url === "/api/sync/status" ? { status: 200, body: UNPAIRED_BOX } : undefined));
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const [url, code] = [...pairForm(mounted.container, "Pair this box").querySelectorAll("input")];
    expect(code.placeholder).toMatch(/^e\.g\. /);
    expect(url.placeholder).toMatch(/^e\.g\. /);
    const hint = document.getElementById(code.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toContain("Settings → Devices");
  });
});

function pairForm(container: HTMLElement, label: string): HTMLFormElement {
  const form = container.querySelector(`form[aria-label='${label}']`);
  if (!form) throw new Error(`no form "${label}"`);
  return form as HTMLFormElement;
}

describe("on the platform", () => {
  it("tells a member the pane is for admins and lists nothing", async () => {
    const calls = stubApi((call) =>
      call.url === "/api/sync/status" ? { status: 200, body: PLATFORM } : undefined,
    );
    mounted = await mount(<DevicesPane />, principalWith(["user"], "member"));
    expect(mounted.container.textContent).toContain("Devices are for admins");
    expect(calls.map((c) => c.url)).toEqual(["/api/sync/status"]);
  });

  it("mints a code shown once, and unpairs a box", async () => {
    let devices: EdgeDevice[] = [SHED];
    const calls = stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: PLATFORM };
      if (call.method === "GET" && call.url === "/api/sync/devices") {
        return { status: 200, body: { data: devices } };
      }
      if (call.method === "POST" && call.url === "/api/sync/pairings") {
        return {
          status: 201,
          body: {
            code: "ABCD-EFGH-JKMN",
            name: "Kitchen Pi",
            expires_in: 600,
            expires_at: "2026-10-20T12:10:00Z",
          },
        };
      }
      if (call.method === "DELETE" && call.url === `/api/sync/devices/${SHED.id}`) {
        devices = [{ ...SHED, revoked_at: "2026-10-20T12:00:00Z" }];
        return { status: 204, body: undefined };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const { container } = mounted;
    expect(container.querySelector("[aria-label='Paired boxes']")!.textContent).toContain("Shed");

    const form = pairForm(container, "Pair an edge box");
    setInputValue(form.querySelector("input")!, "Kitchen Pi");
    submit(form);
    await flush();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Kitchen Pi" });
    expect(container.querySelector("[data-testid='pairing-code']")!.textContent).toBe(
      "ABCD-EFGH-JKMN",
    );

    click(buttonNamed(container, "Done"));
    await flush();
    expect(container.querySelector("[data-testid='pairing-code']")).toBeNull();

    click(buttonNamed(container, "Unpair…"));
    click(buttonNamed(container, "Unpair"));
    await flush();
    expect(
      calls.some((c) => c.method === "DELETE" && c.url === `/api/sync/devices/${SHED.id}`),
    ).toBe(true);
    expect(container.textContent).toContain("Unpaired");
  });

  it("refuses to mint for an unnamed box without calling the API", async () => {
    const calls = stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: PLATFORM };
      if (call.url === "/api/sync/devices") return { status: 200, body: { data: [] } };
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "admin"));
    await flush();
    submit(pairForm(mounted.container, "Pair an edge box"));
    await flush();
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain(
      "Name the box",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("on a box", () => {
  it("pairs with the platform address and the code, then shows the status", async () => {    const changed = vi.fn();
    window.addEventListener("mw:sync-changed", changed);
    const calls = stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: UNPAIRED_BOX };
      if (call.method === "POST" && call.url === "/api/sync/box/pairing") {
        return { status: 200, body: PAIRED_BOX };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const { container } = mounted;
    const form = pairForm(container, "Pair this box");
    const [url, code] = [...form.querySelectorAll("input")];
    setInputValue(url, "https://app.example.test");
    setInputValue(code, "abcd-efgh-jkmn");
    submit(form);
    await flush();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      platform_url: "https://app.example.test",
      code: "abcd-efgh-jkmn",
    });
    expect(container.textContent).toContain("Paired as Kitchen Pi");
    expect(container.querySelector("[aria-label='Sync status']")!.textContent).toContain(
      "2 messages",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("mw:sync-changed", changed);
  });

  it("shows the platform's refusal where the code was typed", async () => {
    stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: UNPAIRED_BOX };
      if (call.url === "/api/sync/box/pairing") {
        return {
          status: 502,
          body: { detail: "The platform refused the pairing code (404): expired" },
        };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const form = pairForm(mounted.container, "Pair this box");
    const [url, code] = [...form.querySelectorAll("input")];
    setInputValue(url, "https://app.example.test");
    setInputValue(code, "ZZZZ-ZZZZ-ZZZZ");
    submit(form);
    await flush();
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain(
      "refused the pairing code",
    );
  });

  it("unpairs, and offers pairing again when the key was rejected", async () => {
    const calls = stubApi((call) => {
      if (call.url === "/api/sync/status") {
        return {
          status: 200,
          body: { ...PAIRED_BOX, stopped: "key_rejected", last_error: "HTTP 401" },
        };
      }
      if (call.method === "DELETE" && call.url === "/api/sync/box/pairing") {
        return { status: 200, body: { ...UNPAIRED_BOX, revoked: true } };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const { container } = mounted;
    expect(container.textContent).toContain("Sync key rejected: pair again");
    expect(container.querySelector("form[aria-label='Pair this box']")).not.toBeNull();
    click(buttonNamed(container, "Unpair this box"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(container.textContent).not.toContain("Paired as");
  });
});

describe("in the desktop shell", () => {
  /** Mint one code and return the reveal's text, the state under test. */
  async function revealText(): Promise<string> {
    stubApi((call) => {
      if (call.url === "/api/sync/status") return { status: 200, body: PLATFORM };
      if (call.method === "GET" && call.url === "/api/sync/devices") return { status: 200, body: { data: [] } };
      if (call.method === "POST" && call.url === "/api/sync/pairings") {
        return {
          status: 201,
          body: { code: "ABCD-EFGH-JKMN", name: "Kitchen Pi", expires_in: 600, expires_at: "2026-10-20T12:10:00Z" },
        };
      }
      return undefined;
    });
    mounted = await mount(<DevicesPane />, principalWith(["user"], "owner"));
    await flush();
    const form = pairForm(mounted.container, "Pair an edge box");
    setInputValue(form.querySelector("input")!, "Kitchen Pi");
    submit(form);
    await flush();
    return mounted.container.querySelector("[data-testid='pairing-code-reveal']")!.textContent ?? "";
  }

  it("names the API base, not the webview's origin, as the address to pair against", async () => {
    desktop.isDesktop.mockReturnValue(true);
    desktop.desktopAppInfo.mockResolvedValue({
      version: "0.2.2",
      api_base_url: "https://app.example.test",
    });
    const reveal = await revealText();
    expect(reveal).toContain("https://app.example.test");
    expect(reveal).not.toContain(window.location.origin);
  });

  it("keeps the page's own origin in a browser, where no bridge is asked", async () => {
    const asked = vi.fn();
    desktop.desktopAppInfo.mockImplementation(asked);
    const reveal = await revealText();
    expect(reveal).toContain(window.location.origin);
    expect(asked).not.toHaveBeenCalled();
  });

  it("does not offer pairing this machine in a browser", async () => {
    const calls = stubApi((call) =>
      call.url === "/api/sync/status" ? { status: 200, body: PLATFORM } : undefined,
    );
    mounted = await mount(<DevicesPane />, principalWith(["user"], "member"));
    await flush();
    expect(mounted.container.textContent).not.toContain("Pair with the platform");
    expect(desktop.desktopDevicePairing).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual(["/api/sync/status"]);
  });
});

describe("pairing this machine (desktop)", () => {
  const PAIRED_MACHINE = {
    paired: true,
    name: "David's laptop",
    hint: "mw_ab12cd34\u2026",
    device_id: "0192b1c4-7a3e-7d10-9a51-3f6c2e8b4d99",
    paired_at: Math.floor(Date.now() / 1000) - 3600,
  };

  it("redeems a pasted code against the desktop bridge, then shows the pairing", async () => {
    stubApi((call) =>
      call.url === "/api/sync/status" ? { status: 200, body: PLATFORM } : undefined,
    );
    desktop.isDesktop.mockReturnValue(true);
    desktop.desktopAppInfo.mockResolvedValue({
      version: "0.2.2",
      api_base_url: "https://app.example.test",
    });
    desktop.desktopPairDevice.mockResolvedValue(PAIRED_MACHINE);
    mounted = await mount(<DevicesPane />, principalWith(["user"], "member"));
    await flush();
    const { container } = mounted;
    // A member, not an admin: the pairing section is still theirs, above
    // the admins-only note.
    expect(container.textContent).toContain("Pair with the platform");
    expect(container.textContent).toContain("Devices are for admins");

    const form = pairForm(container, "Pair with the platform");
    const code = form.querySelector("input")!;
    expect(code.placeholder).toBe("e.g. ABCD-EFGH-JKMN");
    setInputValue(code, "abcd-efgh-jkmn");
    submit(form);
    await flush();
    expect(desktop.desktopPairDevice).toHaveBeenCalledWith("abcd-efgh-jkmn");
    // The redeem route is anonymous on the platform; nothing rides the
    // session, and the pairing renders from the keychain's answer.
    const text = container.textContent ?? "";
    expect(text).toContain("Paired as David's laptop");
    expect(text).toContain("mw_ab12cd34");
    expect(text).toContain("https://app.example.test");
    expect(text).toContain("1 hour ago");
    expect(text).toContain("nothing reported yet");
  });

  it("shows the platform's refusal where the code was typed", async () => {
    stubApi((call) =>
      call.url === "/api/sync/status" ? { status: 200, body: PLATFORM } : undefined,
    );
    desktop.isDesktop.mockReturnValue(true);
    desktop.desktopPairDevice.mockRejectedValue(
      "That pairing code is not valid, or it has expired. Make a new one.",
    );
    mounted = await mount(<DevicesPane />, principalWith(["user"], "member"));
    await flush();
    const form = pairForm(mounted.container, "Pair with the platform");
    setInputValue(form.querySelector("input")!, "ZZZZ-ZZZZ-ZZZZ");
    submit(form);
    await flush();
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain(
      "not valid, or it has expired",
    );
    // Still the form: a refused code is not a pairing.
    expect(mounted.container.querySelector("dl[aria-label='Device pairing']")).toBeNull();
  });

  it("unpairs this machine after its confirmation", async () => {
    let paired = true;
    desktop.desktopDevicePairing.mockImplementation(async () =>
      paired
        ? PAIRED_MACHINE
        : { paired: false, name: null, hint: null, device_id: null, paired_at: null },
    );
    desktop.desktopUnpairDevice.mockImplementation(async () => {
      paired = false;
      return { paired: false, name: null, hint: null, device_id: null, paired_at: null };
    });
    stubApi((call) =>
      call.url === "/api/sync/status" ? { status: 200, body: PLATFORM } : undefined,
    );
    desktop.isDesktop.mockReturnValue(true);
    mounted = await mount(<DevicesPane />, principalWith(["user"], "member"));
    await flush();
    const { container } = mounted;
    click(buttonNamed(container, "Unpair this machine…"));
    await flush();
    // A confirmation stands between the click and the revoke.
    expect(desktop.desktopUnpairDevice).not.toHaveBeenCalled();
    click(buttonNamed(container, "Cancel"));
    await flush();
    expect(desktop.desktopUnpairDevice).not.toHaveBeenCalled();

    click(buttonNamed(container, "Unpair this machine…"));
    click(buttonNamed(container, "Unpair"));
    await flush();
    expect(desktop.desktopUnpairDevice).toHaveBeenCalledTimes(1);
    expect(container.querySelector("dl[aria-label='Device pairing']")).toBeNull();
    expect(pairForm(container, "Pair with the platform")).toBeTruthy();
  });
});
