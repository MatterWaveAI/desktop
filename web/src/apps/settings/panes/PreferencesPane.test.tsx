import { afterEach, describe, expect, it, vi } from "vitest";
import { activateLocale, followAccountLocale, SOURCE_LOCALE } from "../../../i18n/locale";
import type { Preferences } from "../../../types";
import { PreferencesPane } from "./PreferencesPane";
import { act } from "react";
import {
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  optionsOf,
  principalWith,
  selectNamed,
  selectShown,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * The email preferences as the user sees them: loaded from the API, the
 * receipts toggle fixed on, a change enabling Save, and the PUT carrying
 * the whole shape so the API can validate it as one.
 */

/** The desktop half, mocked the way the webview would answer it. */
const desktop = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  desktopGlobalShortcutState: vi.fn<
    () => Promise<{ accelerator: string | null; default: string }>
  >(async () => ({ accelerator: "CommandOrControl+Shift+M", default: "CommandOrControl+Shift+M" })),
  desktopSetGlobalShortcut: vi.fn<
    (shortcut: string | null) => Promise<{ accelerator: string | null; default: string }>
  >(async (shortcut) => ({
    accelerator: shortcut,
    default: "CommandOrControl+Shift+M",
  })),
}));

vi.mock("../../../lib/desktopAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/desktopAuth")>();
  return { ...actual, ...desktop };
});

const STORED: Preferences = {
  email: { product_updates: false, usage_alerts: true, billing_receipts: true },
  locale: null,
  notifications: { budget_warn: true },
};

let mounted: Mounted | null = null;

afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  desktop.isDesktop.mockReturnValue(false);
  desktop.desktopGlobalShortcutState.mockResolvedValue({
    accelerator: "CommandOrControl+Shift+M",
    default: "CommandOrControl+Shift+M",
  });
  desktop.desktopSetGlobalShortcut.mockImplementation(async (shortcut) => ({
    accelerator: shortcut,
    default: "CommandOrControl+Shift+M",
  }));
  await activateLocale(SOURCE_LOCALE);
});

function toggle(label: string): HTMLInputElement {
  const input = [...mounted!.container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input");
  if (!input) throw new Error(`no toggle "${label}"`);
  return input;
}

describe("the grouping", () => {
  it("puts the in-app budget warning under In the app, not under Email", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));

    const groups = [...mounted.container.querySelectorAll("fieldset")];
    const byLegend = (name: string) =>
      groups.find((g) => g.querySelector("legend")?.textContent === name);
    expect(byLegend("Email")?.textContent).toContain("Usage alerts");
    expect(byLegend("Email")?.textContent).not.toContain("Budget warnings");
    expect(byLegend("In the app")?.textContent).toContain("Budget warnings");
  });
});

describe("email preferences", () => {
  it("loads the stored shape, fixes receipts on, and saves the whole shape", async () => {
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") return { status: 200, body };
      return undefined;
    });
    mounted = await mount(<PreferencesPane />, principalWith([]));

    expect(toggle("Product updates").checked).toBe(false);
    expect(toggle("Usage alerts").checked).toBe(true);
    expect(toggle("Billing receipts").checked).toBe(true);
    expect(toggle("Billing receipts").disabled).toBe(true);
    expect(toggle("Budget warnings").checked).toBe(true);
    const save = buttonNamed(mounted.container, "Save preferences");
    expect(save.disabled).toBe(true);

    click(toggle("Product updates"));
    click(toggle("Usage alerts"));
    expect(save.disabled).toBe(false);
    submit(save.form!);
    await flush();

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      email: { product_updates: true, usage_alerts: false, billing_receipts: true },
      locale: null,
      notifications: { budget_warn: true },
    });
    expect(mounted.container.textContent).toContain("Preferences saved.");
    expect(buttonNamed(mounted.container, "Save preferences").disabled).toBe(true);
  });

  it("shows the API's refusal and keeps the draft so the person can fix it", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") {
        return { status: 422, body: { detail: "locale: must be a BCP-47 language tag" } };
      }
      return undefined;
    });
    mounted = await mount(<PreferencesPane />, principalWith([]));

    click(toggle("Budget warnings"));
    submit(buttonNamed(mounted.container, "Save preferences").form!);
    await flush();

    expect(mounted.container.querySelector("[role='alert']")?.textContent).toContain("BCP-47");
    expect(toggle("Budget warnings").checked).toBe(false);
    expect(buttonNamed(mounted.container, "Save preferences").disabled).toBe(false);
  });

  it("says so when the preferences cannot be loaded, with no form to mislead", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences"
        ? { status: 503, body: { detail: "Preferences unavailable." } }
        : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    expect(mounted.container.querySelector("[role='alert']")?.textContent).toContain(
      "Preferences unavailable.",
    );
    // No email form; the device-only answer-ready toggles are not part of it.
    expect(mounted.container.querySelector("form input[type='checkbox']")).toBeNull();
  });
});

describe("the language", () => {
  function languageSelect(): HTMLElement {
    const select = selectNamed(mounted!.container, "Language");
    if (!select) throw new Error("no language select");
    return select;
  }

  /**
   * Flush until the pane has said its piece: the catalogue is a dynamic
   * import and the save two requests, which is more than one round of
   * microtasks.
   */
  async function settle(done: () => boolean): Promise<void> {
    // The es-ES chunk is the whole catalogue, compiled on import: under a
    // full parallel run that alone can take a second or more.
    const deadline = Date.now() + 4_000;
    while (!done() && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  /** Pick an option the way a person does: open the list, click the language. */
  async function chooseLanguage(label: string): Promise<void> {
    await chooseOption(languageSelect(), label);
  }

  it("offers match-device first, then every shipped locale in its own name, the draft marked", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));

    expect(selectShown(languageSelect())).toBe("Match device");
    expect(await optionsOf(languageSelect())).toEqual([
      "Match device",
      "English (UK)",
      "English (US)",
      "Español (borrador)",
    ]);
  });

  it("switches the page at once, remembers the device, and saves the tag on the account", async () => {
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") return { status: 200, body };
      return undefined;
    });
    mounted = await mount(<PreferencesPane />, principalWith([]));

    await chooseLanguage("Español (borrador)");
    await settle(() => mounted!.container.textContent?.includes("Guardado en tu cuenta.") ?? false);

    expect(localStorage.getItem("mw-locale")).toBe("es-ES");
    expect(document.documentElement.lang).toBe("es-ES");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ ...STORED, locale: "es-ES" });
    // The whole shape went up with only the locale changed, and the
    // confirmation reads in the chosen language. (Only the language control
    // re-renders here: the harness mounts no I18nProvider, which in the app
    // is what re-renders everything else on a switch.)
    expect(mounted.container.textContent).toContain("Guardado en tu cuenta.");
  });

  it("keeps a language picked while the account's saved locale is still on its way", async () => {
    stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") return { status: 200, body };
      return undefined;
    });
    // Boot asks the account for its locale as the session lands; the answer
    // (en-US, saved on another device) is slow, and Settings opens first.
    let answer!: (preferences: Preferences) => void;
    const late = new Promise<Preferences>((resolve) => {
      answer = resolve;
    });
    const following = followAccountLocale(() => late);
    mounted = await mount(<PreferencesPane />, principalWith([]));

    await chooseLanguage("Español (borrador)");
    await settle(() => mounted!.container.textContent?.includes("Guardado en tu cuenta.") ?? false);
    await act(async () => {
      answer({ ...STORED, locale: "en-US" });
      await following;
    });

    expect(localStorage.getItem("mw-locale")).toBe("es-ES");
    expect(document.documentElement.lang).toBe("es-ES");
    // The select is labelled in Spanish by now, so it is found by its id.
    expect(selectShown(mounted.container.querySelector<HTMLElement>("#preferences-language")!)).toBe(
      "Español (borrador)",
    );
  });

  it("puts the current language back with an email change, not the one loaded with the page", async () => {
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") return { status: 200, body };
      return undefined;
    });
    mounted = await mount(<PreferencesPane />, principalWith([]));
    await chooseLanguage("English (US)");
    await settle(() => mounted!.container.textContent?.includes("Saved to your account.") ?? false);

    click(toggle("Product updates"));
    submit(buttonNamed(mounted.container, "Save preferences").form!);
    await flush();

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.at(-1)?.body).toMatchObject({ locale: "en-US" });
  });

  it("keeps the device's choice and says so when the account cannot be updated", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/preferences") return { status: 200, body: STORED };
      if (method === "PUT" && url === "/api/me/preferences") return { status: 503, body: { detail: "down" } };
      return undefined;
    });
    mounted = await mount(<PreferencesPane />, principalWith([]));

    await chooseLanguage("English (US)");
    await settle(() => mounted!.container.textContent?.includes("Saved on this device only") ?? false);

    expect(localStorage.getItem("mw-locale")).toBe("en-US");
    expect(mounted.container.textContent).toContain(
      "Saved on this device only; the account could not be updated.",
    );
  });
});

describe("read aloud", () => {
  function stubSynthesis(voices: Array<{ voiceURI: string; name: string; lang: string }>): void {
    vi.stubGlobal("speechSynthesis", {
      speaking: false,
      paused: false,
      getVoices: () => voices,
      speak: () => {},
      cancel: () => {},
      onvoiceschanged: null,
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text = "";
        lang = "";
        rate = 1;
        voice = null;
        onend: (() => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
      },
    );
  }

  function readAloudSelect(name: string): HTMLElement {
    const select = selectNamed(mounted!.container, name);
    if (!select) throw new Error(`no "${name}" select`);
    return select;
  }

  it("hides itself where this browser has no speechSynthesis", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    expect(mounted.container.textContent).not.toContain("Read aloud");
  });

  it("offers Automatic and the voices, and stores the choice on this device", async () => {
    stubSynthesis([
      { voiceURI: "en-gb-serena", name: "Serena", lang: "en-GB" },
      { voiceURI: "en-us-sam", name: "Sam", lang: "en-US" },
    ]);
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));

    expect(mounted.container.textContent).toContain("Read aloud");
    expect(await optionsOf(readAloudSelect("Voice"))).toEqual([
      "Automatic",
      "Serena (en-GB)",
      "Sam (en-US)",
    ]);
    expect(await optionsOf(readAloudSelect("Pace"))).toEqual([
      "0.75×",
      "Normal (1×)",
      "1.25×",
      "1.5×",
      "1.75×",
      "2×",
    ]);

    await chooseOption(readAloudSelect("Voice"), "Serena (en-GB)");
    await chooseOption(readAloudSelect("Pace"), "1.5×");
    expect(JSON.parse(localStorage.getItem("mw.read-aloud")!)).toEqual({
      voiceURI: "en-gb-serena",
      rate: 1.5,
    });
  });

  it("mounts with the stored voice and pace, and the missing-voice note when it must", async () => {
    localStorage.setItem(
      "mw.read-aloud",
      JSON.stringify({ voiceURI: "gone", rate: 1.25 }),
    );
    stubSynthesis([{ voiceURI: "en-us-sam", name: "Sam", lang: "en-US" }]);
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));

    expect(selectShown(readAloudSelect("Voice"))).toBe("Automatic");
    expect(selectShown(readAloudSelect("Pace"))).toBe("1.25×");
    expect(mounted.container.textContent).toContain(
      "This voice is not available right now; Automatic is used until it is.",
    );
  });
});

describe("the global hotkey (desktop only)", () => {
  function hotkeySelect(): HTMLElement {
    const select = selectNamed(mounted!.container, "Shortcut");
    if (!select) throw new Error("no Shortcut select");
    return select;
  }

  it("hides itself outside the desktop shell, and reads the registered chord", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    expect(mounted.container.textContent).not.toContain("Global hotkey");

    desktop.isDesktop.mockReturnValue(true);
    mounted?.unmount();
    mounted = await mount(<PreferencesPane />, principalWith([]));
    await flush();

    expect(desktop.desktopGlobalShortcutState).toHaveBeenCalled();
    expect(selectShown(hotkeySelect())).toBe("Ctrl+Shift+M (default)");
    expect(mounted.container.textContent).toContain(
      "Ctrl+Shift+M is registered with the operating system.",
    );
    expect(await optionsOf(hotkeySelect())).toEqual([
      "Ctrl+Shift+M (default)",
      "Ctrl+Shift+K",
      "Ctrl+Alt+M",
      "Ctrl+Shift+Space",
      "Off",
    ]);
  });

  it("registers the chosen chord with the native side, and off with null", async () => {
    desktop.isDesktop.mockReturnValue(true);
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    await flush();

    await chooseOption(hotkeySelect(), "Ctrl+Shift+K");
    expect(desktop.desktopSetGlobalShortcut).toHaveBeenCalledExactlyOnceWith(
      "CommandOrControl+Shift+K",
    );
    expect(mounted.container.textContent).toContain(
      "Ctrl+Shift+K is registered with the operating system.",
    );

    await chooseOption(hotkeySelect(), "Off");
    expect(desktop.desktopSetGlobalShortcut).toHaveBeenCalledWith(null);
    expect(mounted.container.textContent).toContain(
      "Off: the app is summoned from its taskbar or tray icon.",
    );
  });

  it("a taken chord is the OS's refusal, shown, with the previous chord still the choice", async () => {
    desktop.isDesktop.mockReturnValue(true);
    desktop.desktopSetGlobalShortcut.mockRejectedValue(
      '"CommandOrControl+Shift+K" could not be registered -- the chord is already in use by another application',
    );
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    await flush();

    await chooseOption(hotkeySelect(), "Ctrl+Shift+K");
    const alert = mounted.container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("already in use");
    expect(alert?.textContent).toContain("The previous shortcut keeps working.");
    // The native side refused, so the state stayed on the default chord.
    expect(selectShown(hotkeySelect())).toBe("Ctrl+Shift+M (default)");
  });

  it("renders nothing when no native side answers the state", async () => {
    desktop.isDesktop.mockReturnValue(true);
    desktop.desktopGlobalShortcutState.mockRejectedValue("no bridge");
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/preferences" ? { status: 200, body: STORED } : undefined,
    );
    mounted = await mount(<PreferencesPane />, principalWith([]));
    await flush();
    expect(mounted.container.textContent).not.toContain("Global hotkey");
  });
});
