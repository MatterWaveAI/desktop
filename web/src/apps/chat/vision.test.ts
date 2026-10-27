import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types";
import { visionCapableIds, visionOf, visionRefusal } from "./vision";

function model(id: string, supportsVision?: boolean | null): ModelInfo {
  return {
    id,
    context_window: null,
    research_preview: false,
    supports_vision: supportsVision,
    label: id,
    multiplier: 1,
    input_usd_per_m: 0.1,
    output_usd_per_m: 0.4,
    included: true,
    upgrade_to: null,
    partner: false,
  };
}

const MODELS: ModelInfo[] = [
  model("sees-images", true),
  model("text-only", false),
  model("unstated", null),
  model("predates-the-field"),
];

describe("visionOf", () => {
  it("reads the gateway's yes and no", () => {
    expect(visionOf(MODELS, "sees-images")).toBe("yes");
    expect(visionOf(MODELS, "text-only")).toBe("no");
  });

  it("treats an unstated capability as unknown, not as no", () => {
    // The trade `vision.py` documents: a bare llama.cpp or vLLM serves a
    // /v1/models with nothing but `id`. Reading silence as "no" would grey
    // out the paperclip for every model on the default local setup.
    expect(visionOf(MODELS, "unstated")).toBe("unknown");
    expect(visionOf(MODELS, "predates-the-field")).toBe("unknown");
  });

  it("treats a model missing from the list as unknown", () => {
    // The picker and the gateway can disagree transiently; that must not
    // become a refusal.
    expect(visionOf(MODELS, "added-since-the-fetch")).toBe("unknown");
  });

  it("treats the Default choice as unknown", () => {
    // `null` means "let the server decide", and the server resolves it to
    // `settings.default_model`, whose capability the client cannot know
    // without duplicating that resolution. The server's 422 is the backstop.
    expect(visionOf(MODELS, null)).toBe("unknown");
  });

  it("is unknown before the list has loaded", () => {
    expect(visionOf(null, "text-only")).toBe("unknown");
  });
});

describe("visionCapableIds", () => {
  it("lists only the positive yeses", () => {
    // UNKNOWN is excluded even though it is allowed through: suggesting a
    // model we do not know about sends the user from one failure to another.
    expect(visionCapableIds(MODELS)).toEqual(["sees-images"]);
  });

  it("is empty before the list loads", () => {
    expect(visionCapableIds(null)).toEqual([]);
  });
});

describe("visionRefusal", () => {
  it("names the model, the way out, and that the message is safe", () => {
    const message = visionRefusal("text-only", ["a-vision-model", "another"]);
    expect(message).toContain("text-only");
    expect(message).toContain("a-vision-model");
    // The sentence that makes this not infuriating.
    expect(message).toMatch(/message is untouched/);
  });

  it("omits the suggestion rather than faking one", () => {
    const message = visionRefusal("text-only", []);
    expect(message).toMatch(/vision-capable model/);
    expect(message).toMatch(/message is untouched/);
  });

  it("caps the suggestion list so the sentence stays readable", () => {
    const message = visionRefusal("text-only", ["epsilon", "delta", "gamma", "beta", "alpha"]);
    // Sorted and capped at three. (Single-letter ids would make this test
    // lie: "d" also appears inside the word "model".)
    expect(message).toContain("alpha, beta, delta");
    expect(message).not.toContain("gamma");
    expect(message).not.toContain("epsilon");
  });
});
