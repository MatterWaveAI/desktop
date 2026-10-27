import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../types";
import { describeModel, formatContextWindow, groupModels, lockedOptionText, upgradeGroups } from "./models";

/**
 * The picker renders the deployment's own models, partner models and
 * research previews as three groups, and the grouping reads only the API's
 * flags -- never a model id. Pure logic; the wire format is covered by the
 * API tests.
 */

function model(
  id: string,
  research_preview: boolean,
  context_window: number | null = null,
  over: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id,
    research_preview,
    context_window,
    label: id,
    multiplier: 1,
    input_usd_per_m: 0.1,
    output_usd_per_m: 0.4,
    included: true,
    upgrade_to: null,
    partner: false,
    ...over,
  };
}

function priced(id: string, label: string, upgrade_to: string | null, included = false): ModelInfo {
  return { ...model(id, false), label, included, upgrade_to };
}

describe("groupModels", () => {
  it("keeps ordinary models, GRT among them, in the main list", () => {
    const { models, partners, researchPreviews } = groupModels([
      model("grt-nano", false, 8192),
      model("grt-nano-pro", false),
    ]);
    expect(models.map((m) => m.id)).toEqual(["grt-nano", "grt-nano-pro"]);
    expect(partners).toEqual([]);
    expect(researchPreviews).toEqual([]);
  });

  it("puts partner models and research previews in their own groups, preserving order", () => {
    const { models, partners, researchPreviews } = groupModels([
      model("grt-nano", false),
      model("glm-4.6", false, null, { partner: true }),
      model("tiny-demo", true, 2048),
      model("llama-1b", false, null, { partner: true }),
      model("grt-nano-max", false),
    ]);
    expect(models.map((m) => m.id)).toEqual(["grt-nano", "grt-nano-max"]);
    expect(partners.map((m) => m.id)).toEqual(["glm-4.6", "llama-1b"]);
    expect(researchPreviews.map((m) => m.id)).toEqual(["tiny-demo"]);
  });

  it("keeps a partner's research preview under the preview warning", () => {
    const { partners, researchPreviews } = groupModels([model("p-demo", true, null, { partner: true })]);
    expect(partners).toEqual([]);
    expect(researchPreviews.map((m) => m.id)).toEqual(["p-demo"]);
  });

  it("handles an empty list", () => {
    expect(groupModels([])).toEqual({ models: [], partners: [], researchPreviews: [] });
  });
});

describe("describeModel", () => {
  it("states the list price, the multiplier and the context window", () => {
    expect(
      describeModel(model("grt-nano-pro", false, 32768, { multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2 })),
    ).toBe("$0.50 / $2.00 per 1M · counts 5× · 33k context");
    expect(describeModel(model("grt-nano", false))).toBe("$0.10 / $0.40 per 1M · counts 1×");
  });

  it("warns about a research preview instead", () => {
    expect(describeModel(model("tiny-demo", true))).toMatch(/not for real use/);
  });
});

describe("formatContextWindow", () => {
  it("formats thousands and millions", () => {
    expect(formatContextWindow(32768)).toBe("33k");
    expect(formatContextWindow(40960)).toBe("41k");
    expect(formatContextWindow(2048)).toBe("2k");
    expect(formatContextWindow(2_000_000)).toBe("2M");
  });

  it("passes small values and unknown through unchanged", () => {
    expect(formatContextWindow(512)).toBe("512");
    expect(formatContextWindow(null)).toBeNull();
  });
});

describe("upgradeGroups", () => {
  it("groups what the plan does not include by the plan that has it, in list order", () => {
    const groups = upgradeGroups([
      priced("grt-nano", "GRT Nano", null, true),
      priced("grt-nano-pro", "GRT Nano Pro", "Pro"),
      priced("grt-nano-max", "GRT Nano Max", "Pro Plus"),
      priced("grt-nano-ultra", "GRT Nano Ultra", "Pro Plus"),
    ]);
    expect(groups).toEqual([
      { plan: "Pro", labels: ["GRT Nano Pro"] },
      { plan: "Pro Plus", labels: ["GRT Nano Max", "GRT Nano Ultra"] },
    ]);
  });

  it("is empty when everything is included", () => {
    expect(upgradeGroups([priced("grt-nano", "GRT Nano", null, true)])).toEqual([]);
  });

  it("keeps a partner model no plan names, under a null plan", () => {
    expect(upgradeGroups([priced("glm-4.6", "GLM 4.6", null)])).toEqual([{ plan: null, labels: ["GLM 4.6"] }]);
  });
});

describe("lockedOptionText", () => {
  it("names the model by its label and the plan that has it", () => {
    expect(lockedOptionText(priced("grt-nano-pro", "GRT Nano Pro", "Pro"))).toBe("GRT Nano Pro — needs Pro");
    expect(lockedOptionText(priced("glm-4.6", "GLM 4.6", null))).toBe("GLM 4.6 — not on your plan");
  });
});
