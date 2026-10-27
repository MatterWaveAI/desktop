import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "@tanstack/react-router";
import { router } from "../../routes";
import type { ModelInfo, ModelsResponse } from "../../types";
import { ModelPicker } from "./ModelPicker";

/**
 * The picker against a priced `/api/models`: models are named by the API's
 * labels with their list price, the deployment's own models are ordinary
 * entries, partner models and research previews each sit in their own
 * group by the API's flags, a model the plan does not include is listed but
 * cannot be chosen, and the line under the control names the plan that has
 * it with the same "See plans" link UpgradePrompt gives every other gated
 * feature.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function entry(id: string, label: string, multiplier: number, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    context_window: 8192,
    research_preview: false,
    label,
    multiplier,
    input_usd_per_m: 0.1 * multiplier,
    output_usd_per_m: 0.4 * multiplier,
    included: true,
    upgrade_to: null,
    partner: false,
    ...over,
  };
}

const FREE_ORG: ModelsResponse = {
  object: "list",
  default_model: "grt-nano",
  data: [
    entry("grt-nano", "GRT Nano", 1),
    entry("grt-nano-pro", "GRT Nano Pro", 5, { included: false, upgrade_to: "Pro" }),
    entry("grt-nano-max", "GRT Nano Max", 20, { included: false, upgrade_to: "Pro Plus" }),
    // Another provider's model no plan names: listed, apart, and not on the plan.
    entry("glm-4.6", "GLM 4.6", 1, { partner: true, included: false, upgrade_to: null }),
    entry("tiny-demo", "Tiny Demo", 1, { research_preview: true }),
  ],
};

function stubModels(body: ModelsResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "",
      headers: new Headers(),
      json: async () => body,
    })),
  );
}

async function render(onChange: (model: string | null) => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RouterContextProvider router={router}>
        <ModelPicker conversationId={null} value={null} onChange={onChange} />
      </RouterContextProvider>,
    );
  });
  await act(async () => {});
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function options(): HTMLOptionElement[] {
  return [...container!.querySelectorAll("option")];
}

describe("ModelPicker with a priced model list", () => {
  it("names models and the default by label with the price, never by id", async () => {
    stubModels(FREE_ORG);
    await render();
    const texts = options().map((o) => o.textContent);
    expect(texts[0]).toBe("Default (GRT Nano)");
    // GRT is the product: an ordinary entry, with its list price, outside any group.
    const nano = options().find((o) => o.value === "grt-nano")!;
    // The label alone: the price and window are on the line under the box,
    // where they can be read in full, not squeezed into a one-line option.
    expect(nano.textContent).toBe("GRT Nano");
    expect(nano.parentElement?.tagName).toBe("SELECT");
    expect(container!.querySelector("#mw-model-description")?.textContent).toBe(
      "Using GRT Nano, the default model.",
    );
  });

  it("lists a model the plan does not include as disabled, with the plan that has it", async () => {
    stubModels(FREE_ORG);
    await render();
    const pro = options().find((o) => o.value === "grt-nano-pro")!;
    const max = options().find((o) => o.value === "grt-nano-max")!;
    const nano = options().find((o) => o.value === "grt-nano")!;
    expect(pro.disabled).toBe(true);
    expect(pro.textContent).toBe("GRT Nano Pro — needs Pro");
    expect(max.disabled).toBe(true);
    expect(max.textContent).toBe("GRT Nano Max — needs Pro Plus");
    expect(nano.disabled).toBe(false);
    // An ordinary entry, not in a group.
    expect(pro.parentElement?.tagName).toBe("SELECT");

    const upgrade = container!.querySelector("[data-model-upgrade]")!;
    expect(upgrade.textContent).toContain("Pro includes GRT Nano Pro.");
    expect(upgrade.textContent).toContain("Pro Plus includes GRT Nano Max.");
    expect(upgrade.textContent).toContain("GLM 4.6: not on your plan.");
    const link = upgrade.querySelector("a")!;
    expect(link.textContent).toBe("See plans");
    expect(link.getAttribute("href")).toBe("/pricing");
  });

  it("lets both hint lines wrap rather than cutting them to one line each", async () => {
    stubModels(FREE_ORG);
    await render();
    const description = container!.querySelector("#mw-model-description")!;
    const upgrade = container!.querySelector("[data-model-upgrade]")!;
    for (const line of [description, upgrade]) {
      expect(line.className).not.toContain("truncate");
      expect(line.className).not.toContain("line-clamp");
    }
    expect(description.parentElement?.className).toContain("flex-wrap");
    // The box is not capped on a phone: a cap clipped the default's name.
    const select = container!.querySelector("select")!;
    expect(select.className).not.toMatch(/max-w-\d/);
    expect(select.className).not.toContain("truncate");
  });

  it("puts partner models and research previews in their own groups, by the API's flags", async () => {
    stubModels(FREE_ORG);
    await render();
    const groups = [...container!.querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["Partner models", "Research preview — not for real use"]);
    const glm = groups[0]!.querySelector("option")!;
    expect(glm.value).toBe("glm-4.6");
    expect(glm.textContent).toBe("GLM 4.6 — not on your plan");
    expect(glm.disabled).toBe(true);
    expect(groups[1]!.querySelector("option")?.value).toBe("tiny-demo");
  });

  it("offers a partner model a plan names like any other", async () => {
    stubModels({
      ...FREE_ORG,
      data: FREE_ORG.data.map((m) => (m.partner ? { ...m, included: true } : m)),
    });
    await render();
    const glm = container!.querySelector("optgroup[label='Partner models'] option") as HTMLOptionElement;
    expect(glm.disabled).toBe(false);
    expect(glm.textContent).toBe("GLM 4.6");
  });

  it("says nothing about upgrades when the plan includes every listed model", async () => {
    stubModels({
      ...FREE_ORG,
      data: FREE_ORG.data.map((m) => ({ ...m, included: true, upgrade_to: null })),
    });
    await render();
    expect(options().every((o) => !o.disabled)).toBe(true);
    expect(container!.querySelector("[data-model-upgrade]")).toBeNull();
  });
});
