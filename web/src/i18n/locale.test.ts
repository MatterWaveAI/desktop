import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  activateLocale,
  adoptServerLocale,
  DEVICE_LOCALE,
  directionFor,
  getLocalePreference,
  LOCALES,
  matchDeviceLocale,
  resolveLocale,
  setLocalePreference,
  SOURCE_LOCALE,
} from "./locale";

/**
 * How the language is decided: the device's list narrowed to a shipped
 * locale, a stored preference overriding it, the account's saved tag
 * adopted when it differs, and the document's `lang` and `dir` following
 * whichever wins. The catalogues themselves are checked in catalogs.test.ts.
 */

afterEach(async () => {
  localStorage.clear();
  vi.restoreAllMocks();
  await activateLocale(SOURCE_LOCALE);
});

describe("matching the device", () => {
  it("takes an exact tag, then the same language, then the source locale", () => {
    expect(matchDeviceLocale(["en-US", "fr"])).toBe("en-US");
    expect(matchDeviceLocale(["es-MX", "en"])).toBe("es-ES");
    expect(matchDeviceLocale(["en-AU"])).toBe("en-GB");
    expect(matchDeviceLocale(["fr-FR", "de"])).toBe("en-GB");
    expect(matchDeviceLocale([])).toBe(SOURCE_LOCALE);
  });

  it("is case-insensitive about the tag the browser reports", () => {
    expect(matchDeviceLocale(["es-es"])).toBe("es-ES");
  });

  it("prefers an exact match anywhere in the list over a language match earlier", () => {
    // A device set to "en" first and "es-ES" second has asked for English;
    // the exact pass finds es-ES, so the first pass must be the exact one.
    expect(matchDeviceLocale(["en", "es-ES"])).toBe("es-ES");
    expect(resolveLocale(DEVICE_LOCALE, ["en", "fr"])).toBe("en-GB");
  });
});

describe("the stored preference", () => {
  it("defaults to matching the device and ignores a tag this build does not ship", () => {
    expect(getLocalePreference()).toBe(DEVICE_LOCALE);
    localStorage.setItem("mw-locale", "fr-FR");
    expect(getLocalePreference()).toBe(DEVICE_LOCALE);
  });

  it("a chosen locale wins over the device and is applied to the document", async () => {
    await setLocalePreference("es-ES");
    expect(getLocalePreference()).toBe("es-ES");
    expect(resolveLocale(getLocalePreference(), ["en-US"])).toBe("es-ES");
    expect(i18n.locale).toBe("es-ES");
    expect(document.documentElement.lang).toBe("es-ES");
    expect(document.documentElement.dir).toBe("ltr");
    // The pilot catalogue is really loaded: a source string reads in Spanish.
    expect(i18n._(msg`Create account`)).toBe("Crear cuenta");
  });

  it("back to the device clears the stored value", async () => {
    await setLocalePreference("en-US");
    await setLocalePreference(DEVICE_LOCALE);
    expect(localStorage.getItem("mw-locale")).toBeNull();
  });
});

describe("the account's saved locale", () => {
  it("is adopted when it differs from this device's, and null means match device", async () => {
    await adoptServerLocale("es-ES");
    expect(getLocalePreference()).toBe("es-ES");
    await adoptServerLocale(null);
    expect(getLocalePreference()).toBe(DEVICE_LOCALE);
  });

  it("leaves a tag this build does not ship alone", async () => {
    await setLocalePreference("en-US");
    await adoptServerLocale("de-DE");
    expect(getLocalePreference()).toBe("en-US");
  });
});

describe("direction", () => {
  it("is rtl for right-to-left languages by primary subtag, ltr otherwise", () => {
    expect(directionFor("ar-EG")).toBe("rtl");
    expect(directionFor("he")).toBe("rtl");
    expect(directionFor("es-ES")).toBe("ltr");
    for (const option of LOCALES) expect(directionFor(option.tag)).toBe("ltr");
  });
});

describe("the language list", () => {
  it("names the draft locale as a draft, in its own language", () => {
    const es = LOCALES.find((option) => option.tag === "es-ES");
    expect(es?.draft).toBe(true);
    expect(es?.label).toBe("Español (borrador)");
    expect(LOCALES.filter((option) => !option.draft).map((option) => option.tag)).toEqual([
      "en-GB",
      "en-US",
    ]);
  });
});
