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
 * feature -- as a note under the list, where a choice is being made.
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

function trigger(): HTMLElement {
  return container!.querySelector<HTMLElement>("[data-mw-model-picker]")!;
}

/** Open the list: it is portalled, so its entries are looked for on the document. */
async function openList(): Promise<void> {
  await act(async () => {
    trigger().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger().click();
  });
  await act(async () => {});
}

function item(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="option"][data-mw-model="${id}"]`);
}

function name(id: string): string | null | undefined {
  return item(id)?.querySelector("[data-slot='select-item-body'] > :first-child")?.textContent;
}

function description(id: string): string | null | undefined {
  return item(id)?.querySelector("[data-slot='select-item-description']")?.textContent;
}

function disabled(id: string): boolean {
  return item(id)?.getAttribute("aria-disabled") === "true";
}

describe("ModelPicker with a priced model list", () => {
  it("is one pill naming the model in force by its label, never by id", async () => {
    stubModels(FREE_ORG);
    await render();
    const pill = trigger();
    expect(pill.getAttribute("role")).toBe("combobox");
    expect(pill.getAttribute("aria-label")).toBe("Model");
    expect(pill.textContent).toBe("GRT Nano");
    expect(pill.querySelector("[data-slot='status-dot']")).not.toBeNull();
    // The hint line is gone from the page; the description is the control's.
    expect(container!.querySelector("[data-model-upgrade]")).toBeNull();
    const described = pill.getAttribute("aria-describedby")!;
    expect(document.getElementById(described)?.textContent).toBe("Using GRT Nano, the default model.");
  });

  it("lists the default by label, each model with its price as its second line", async () => {
    stubModels(FREE_ORG);
    await render();
    await openList();
    expect(name("")).toBe("Default (GRT Nano)");
    expect(name("grt-nano")).toBe("GRT Nano");
    expect(description("grt-nano")).toBe("$0.10 / $0.40 per 1M · counts 1× · 8k context");
    // GRT is the product: an ordinary entry, outside any group.
    expect(item("grt-nano")?.closest("[role='group']")).toBeNull();
  });

  it("lists a model the plan does not include as disabled, with the plan that has it", async () => {
    stubModels(FREE_ORG);
    await render();
    await openList();
    expect(disabled("grt-nano-pro")).toBe(true);
    expect(description("grt-nano-pro")).toBe("Needs Pro");
    expect(disabled("grt-nano-max")).toBe(true);
    expect(description("grt-nano-max")).toBe("Needs Pro Plus");
    expect(disabled("grt-nano")).toBe(false);

    // The plan note sits under the list, outside the listbox, with the link.
    const upgrade = document.querySelector("[data-model-upgrade]")!;
    expect(upgrade.closest("[role='listbox']")).toBeNull();
    expect(upgrade.textContent).toContain("Pro includes GRT Nano Pro.");
    expect(upgrade.textContent).toContain("Pro Plus includes GRT Nano Max.");
    expect(upgrade.textContent).toContain("GLM 4.6: not on your plan.");
    const link = upgrade.querySelector("a")!;
    expect(link.textContent).toBe("See plans");
    expect(link.getAttribute("href")).toBe("/pricing");
  });

  it("puts partner models and research previews in their own groups, by the API's flags", async () => {
    stubModels(FREE_ORG);
    await render();
    await openList();
    const groups = [...document.querySelectorAll("[role='group']")];
    expect(groups.map((g) => g.querySelector("[data-slot='select-label']")?.textContent)).toEqual([
      "Partner models",
      "Research preview — not for real use",
    ]);
    expect(groups[0]!.contains(item("glm-4.6"))).toBe(true);
    expect(disabled("glm-4.6")).toBe(true);
    expect(description("glm-4.6")).toBe("Not on your plan");
    expect(groups[1]!.contains(item("tiny-demo"))).toBe(true);
    expect(description("tiny-demo")).toMatch(/^Research demo/);
  });

  it("offers a partner model a plan names like any other", async () => {
    stubModels({
      ...FREE_ORG,
      data: FREE_ORG.data.map((m) => (m.partner ? { ...m, included: true } : m)),
    });
    await render();
    await openList();
    expect(disabled("glm-4.6")).toBe(false);
    expect(name("glm-4.6")).toBe("GLM 4.6");
  });

  it("says nothing about upgrades when the plan includes every listed model", async () => {
    stubModels({
      ...FREE_ORG,
      data: FREE_ORG.data.map((m) => ({ ...m, included: true, upgrade_to: null })),
    });
    await render();
    await openList();
    expect(document.querySelectorAll("[role='option'][aria-disabled='true']").length).toBe(0);
    expect(document.querySelector("[data-model-upgrade]")).toBeNull();
  });

  it("shows a preset's model as fixed: named by its label, not openable, and said to be the preset's", async () => {
    stubModels(FREE_ORG);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RouterContextProvider router={router}>
          <ModelPicker
            conversationId={null}
            value={null}
            onChange={() => {}}
            fixed={{ model: "grt-nano-pro", by: "Support desk" }}
          />
        </RouterContextProvider>,
      );
    });
    await act(async () => {});
    const pill = trigger();
    expect(pill.textContent).toBe("GRT Nano Pro");
    expect(pill.hasAttribute("data-mw-model-fixed")).toBe(true);
    expect(pill.getAttribute("aria-disabled") === "true" || (pill as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(pill.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Set by the Support desk preset: $0.50 / $2.00 per 1M · counts 5× · 8k context",
    );
    await openList();
    expect(document.querySelector("[role='listbox']")).toBeNull();
  });
});
