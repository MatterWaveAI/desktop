import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, Preset, PresetListing } from "../../../types";
import { PresetsPane } from "./PresetsPane";
import {
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  principalWith,
  selectNamed,
  selectShown,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * Presets as the API's `can_manage` decides them: a member reads the list
 * with an explanation and nothing to press; an owner or admin creates one
 * from the org's models and the registry's tools, edits one sending only
 * what changed, sees a refused model under its field, and deletes behind
 * a confirmation. The feature being off is a neutral note, not an error.
 */

const TOOLS = [
  { name: "get_current_time", description: "The current date and time." },
  { name: "web_search", description: "Search the web." },
];

const LIMITS = {
  max_presets: 20,
  name_max_len: 80,
  description_max_len: 200,
  instructions_max_len: 8000,
  welcome_max_len: 1000,
};

function model(id: string, label: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    context_window: 8192,
    research_preview: false,
    label,
    multiplier: 1,
    input_usd_per_m: 0.1,
    output_usd_per_m: 0.4,
    included: true,
    upgrade_to: null,
    partner: false,
    ...over,
  };
}

const MODELS = {
  object: "list",
  default_model: "grt-nano",
  data: [
    model("grt-nano", "GRT Nano"),
    model("grt-nano-pro", "GRT Nano Pro"),
    model("grt-nano-max", "GRT Nano Max", { included: false, upgrade_to: "Pro Plus" }),
  ],
};

const SUPPORT: Preset = {
  id: "11111111-1111-7111-8111-111111111111",
  name: "Support desk",
  description: "Answers customer questions.",
  model: "grt-nano-pro",
  instructions: "Be brief and kind.",
  tools: ["web_search"],
  welcome_message: "Hello! How can I help?",
  created_by: "dev-user",
  created_at: "2026-10-01T10:00:00+00:00",
  updated_at: "2026-10-01T10:00:00+00:00",
  deleted_at: null,
};

const RESEARCH: Preset = {
  ...SUPPORT,
  id: "22222222-2222-7222-8222-222222222222",
  name: "Research",
  description: "",
  model: "grt-nano",
  tools: null,
  welcome_message: null,
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** React tracks the textarea's value internally; set it the way the DOM would. */
function setTextarea(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const listing = (presets: Preset[], over: Partial<PresetListing> = {}) => ({
  status: 200,
  body: { data: presets, tools: TOOLS, limits: LIMITS, can_manage: true, ...over },
});

/** The listing and the models, as an admin's pane reads both. */
function stubListing(presets: Preset[], over: Partial<PresetListing> = {}) {
  return stubApi(({ method, url }) => {
    if (method === "GET" && url === "/api/org/presets") return listing(presets, over);
    if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
    return undefined;
  });
}

function rows(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-testid='preset-row']")];
}

describe("the presets pane", () => {
  it("shows a member the list with an explanation and nothing to press", async () => {
    const calls = stubListing([SUPPORT, RESEARCH], { can_manage: false });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "member"));
    const note = mounted.container.querySelector("[data-presets-member-note]")!;
    expect(note.textContent).toContain("set up by an owner or admin");
    expect(rows(mounted.container).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Support desk"),
      expect.stringContaining("Research"),
    ]);
    expect(mounted.container.querySelectorAll("button")).toHaveLength(0);
    // Only the form needs the models, and a member never opens it.
    expect(calls.map((c) => c.url)).toEqual(["/api/org/presets"]);
  });

  it("lists each preset's model by its label, its tools and its welcome message for an admin", async () => {
    stubListing([SUPPORT, RESEARCH]);
    mounted = await mount(<PresetsPane />, principalWith(["user"], "admin"));
    await flush();
    const [support, research] = rows(mounted.container);
    expect(support.textContent).toContain("Answers customer questions.");
    expect(support.textContent).toContain("Model: GRT Nano Pro");
    expect(support.textContent).toContain("web_search");
    expect(support.querySelector("[data-preset-welcome]")!.textContent).toContain("Hello! How can I help?");
    expect(research.textContent).toContain("Model: GRT Nano");
    expect(research.textContent).toContain("Default tools");
    expect(research.querySelector("[data-preset-welcome]")).toBeNull();
    expect(buttonNamed(support, "Edit…")).toBeTruthy();
    expect(buttonNamed(support, "Delete…")).toBeTruthy();
    expect(mounted.container.querySelector("[data-presets-member-note]")).toBeNull();
  });

  it("shows an empty state, and a neutral note with nothing to retry when the feature is off", async () => {
    stubListing([]);
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.textContent).toContain("No presets yet");
    mounted.unmount();

    stubApi(() => ({ status: 503, body: { detail: "Presets need Postgres; set MW_DATABASE_URL." } }));
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.textContent).toContain("Not available on this deployment");
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
    expect(mounted.container.textContent).not.toContain("MW_DATABASE_URL");
    expect([...mounted.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([]);
  });

  it("still reports any other load failure as an error with Retry", async () => {
    stubApi(() => ({ status: 500, body: { detail: "Something broke." } }));
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    expect(mounted.container.querySelector("[role='alert']")!.textContent).toContain("Something broke.");
    expect(buttonNamed(mounted.container, "Retry")).toBeTruthy();
  });

  it("creates a preset from the org's models and the registry's tools", async () => {
    let presets: Preset[] = [];
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/presets") return listing(presets);
      if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
      if (method === "POST" && url === "/api/org/presets") {
        presets = [SUPPORT];
        return { status: 201, body: SUPPORT };
      }
      return undefined;
    });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    await flush();
    click(buttonNamed(mounted.container, "New preset…"));
    await flush();
    const dialog = document.querySelector("[data-preset-dialog]")!;
    expect(dialog).not.toBeNull();
    const create = buttonNamed(dialog, "Create preset");
    expect(create.disabled).toBe(true); // no name yet

    setInputValue(dialog.querySelector("input[name='name']") as HTMLInputElement, " Support desk ");
    setInputValue(dialog.querySelector("input[name='description']") as HTMLInputElement, "Answers customer questions.");
    // The org's models the plan includes, by label: a locked one would only earn a 422.
    const modelSelect = selectNamed(dialog, "Model")!;
    expect(selectShown(modelSelect)).toBe("GRT Nano");
    await chooseOption(modelSelect, "GRT Nano Pro");
    setTextarea(dialog.querySelector("textarea[name='instructions']") as HTMLTextAreaElement, "Be brief and kind.");
    // The default set is on until it is switched off; then each tool is its own choice.
    const defaults = dialog.querySelector("input[name='default-tools']") as HTMLInputElement;
    const boxes = [...dialog.querySelectorAll("input[name='tools']")] as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(["get_current_time", "web_search"]);
    expect(defaults.checked).toBe(true);
    expect(boxes.every((b) => b.disabled && b.checked)).toBe(true);
    click(defaults);
    expect(boxes.every((b) => !b.disabled && !b.checked)).toBe(true);
    click(boxes[1]);
    setTextarea(dialog.querySelector("textarea[name='welcome_message']") as HTMLTextAreaElement, "Hello! How can I help?");
    expect(create.disabled).toBe(false);
    submit(dialog.querySelector("form")!);
    await flush();

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      name: "Support desk",
      description: "Answers customer questions.",
      model: "grt-nano-pro",
      instructions: "Be brief and kind.",
      tools: ["web_search"],
      welcome_message: "Hello! How can I help?",
    });
    await flush();
    expect(document.querySelector("[data-preset-dialog]")).toBeNull();
    expect(rows(mounted.container)).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/org/presets" && c.method === "GET")).toHaveLength(2);
  });

  it("sends an empty tool list when every tool is switched off", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/presets") return listing([]);
      if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
      if (method === "POST") return { status: 201, body: RESEARCH };
      return undefined;
    });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    await flush();
    click(buttonNamed(mounted.container, "New preset…"));
    await flush();
    const dialog = document.querySelector("[data-preset-dialog]")!;
    setInputValue(dialog.querySelector("input[name='name']") as HTMLInputElement, "Quiet");
    click(dialog.querySelector("input[name='default-tools']") as HTMLInputElement);
    submit(dialog.querySelector("form")!);
    await flush();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "Quiet",
      description: "",
      model: "grt-nano",
      instructions: "",
      tools: [],
      welcome_message: null,
    });
  });

  it("shows a refused model under its field, from the 422 the API answers", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/presets") return listing([]);
      if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
      if (method === "POST") {
        return {
          status: 422,
          body: {
            detail: [{ loc: ["body", "model"], msg: "Model 'grt-nano-pro' is not on your plan.", type: "value_error" }],
          },
        };
      }
      return undefined;
    });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    await flush();
    click(buttonNamed(mounted.container, "New preset…"));
    await flush();
    const dialog = document.querySelector("[data-preset-dialog]")!;
    setInputValue(dialog.querySelector("input[name='name']") as HTMLInputElement, "Pro");
    await chooseOption(selectNamed(dialog, "Model")!, "GRT Nano Pro");
    submit(dialog.querySelector("form")!);
    await flush();
    const alerts = [...dialog.querySelectorAll("[role='alert']")];
    expect(alerts.map((a) => a.textContent)).toEqual(["Model 'grt-nano-pro' is not on your plan."]);
    expect(document.querySelector("[data-preset-dialog]")).not.toBeNull();
  });

  it("edits a preset, sending only what changed, and keeps a model the org no longer offers", async () => {
    const retired: Preset = { ...SUPPORT, model: "grt-retired" };
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/presets") return listing([retired]);
      if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
      if (method === "PATCH") return { status: 200, body: retired };
      return undefined;
    });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "admin"));
    await flush();
    click(buttonNamed(rows(mounted.container)[0], "Edit…"));
    await flush();
    const dialog = document.querySelector("[data-preset-dialog]")!;
    expect((dialog.querySelector("input[name='name']") as HTMLInputElement).value).toBe("Support desk");
    expect((dialog.querySelector("textarea[name='instructions']") as HTMLTextAreaElement).value).toBe(
      "Be brief and kind.",
    );
    // Its model is not in the list any more, but the form still shows it.
    expect(selectShown(selectNamed(dialog, "Model")!)).toBe("grt-retired");
    const box = (name: string) => dialog.querySelector(`input[name='tools'][value='${name}']`) as HTMLInputElement;
    expect(box("web_search").checked).toBe(true);
    expect(box("get_current_time").checked).toBe(false);
    click(box("get_current_time"));
    setTextarea(dialog.querySelector("textarea[name='welcome_message']") as HTMLTextAreaElement, "");
    submit(dialog.querySelector("form")!);
    await flush();
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/api/org/presets/${SUPPORT.id}`);
    // In the registry's order; a blanked welcome message is dropped, not sent empty.
    expect(patch.body).toEqual({ tools: ["get_current_time", "web_search"], welcome_message: null });
  });

  it("deletes behind a confirmation that says conversations on it keep answering", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/org/presets") return listing([SUPPORT]);
      if (method === "GET" && url === "/api/models") return { status: 200, body: MODELS };
      if (method === "DELETE") return { status: 204, body: null };
      return undefined;
    });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    await flush();
    click(buttonNamed(rows(mounted.container)[0], "Delete…"));
    await flush();
    const confirm = [...document.querySelectorAll("[role='dialog']")].find((d) => d.textContent?.includes("Delete Support desk?"))!;
    expect(confirm.textContent).toContain("Conversations already on it keep answering");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    click(buttonNamed(confirm, "Delete preset"));
    await flush();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe(`/api/org/presets/${SUPPORT.id}`);
    expect(calls.filter((c) => c.url === "/api/org/presets" && c.method === "GET")).toHaveLength(2);
  });

  it("disables New preset at the org's cap and says why", async () => {
    stubListing([SUPPORT, RESEARCH], { limits: { ...LIMITS, max_presets: 2 } });
    mounted = await mount(<PresetsPane />, principalWith(["user"], "owner"));
    await flush();
    expect(buttonNamed(mounted.container, "New preset…").disabled).toBe(true);
    expect(mounted.container.querySelector("[data-presets-at-cap]")!.textContent).toContain("2 presets");
  });
});
