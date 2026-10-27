import { afterEach, describe, expect, it, vi } from "vitest";
import { activateLocale, SOURCE_LOCALE } from "../../../i18n/locale";
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
    expect(mounted.container.querySelector("input[type='checkbox']")).toBeNull();
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
    for (let i = 0; i < 50 && !done(); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
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
