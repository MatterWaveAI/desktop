import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Preset, PresetRef } from "../../types";
import { PresetPicker } from "./PresetPicker";

/**
 * The picker against the org's presets: one pill naming the preset in
 * force, "No preset" first in the list, each preset by name with what it
 * does as its second line; a pick on a stored conversation is PATCHed as
 * its `preset_id` and "No preset" clears it; a conversation on a preset
 * the org has since deleted still names it, read on its own, without the
 * list offering it; and an org with no presets gets no control at all.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function preset(id: string, name: string, over: Partial<Preset> = {}): Preset {
  return {
    id,
    name,
    description: "",
    model: "grt-nano",
    instructions: "",
    tools: null,
    welcome_message: null,
    created_by: "u",
    created_at: "2026-10-01T00:00:00+00:00",
    updated_at: "2026-10-01T00:00:00+00:00",
    deleted_at: null,
    ...over,
  };
}

const SUPPORT = preset("p-support", "Support desk", {
  description: "Answers customer questions.",
  model: "grt-nano-pro",
  welcome_message: "Hello! How can I help?",
});
const RESEARCH = preset("p-research", "Research");
const RETIRED = preset("p-old", "Old desk", { deleted_at: "2026-10-02T00:00:00+00:00" });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(presets: Preset[], single: Preset | null = null, listStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let status = 200;
      let body: unknown = {};
      if (url === "/api/org/presets") {
        status = listStatus;
        body = status === 200 ? { data: presets, tools: [], limits: {}, can_manage: false } : { detail: "no" };
      } else if (url.startsWith("/api/org/presets/")) {
        status = single === null ? 404 : 200;
        body = single ?? { detail: "No such preset" };
      }
      return { ok: status < 400, status, statusText: "", headers: new Headers(), json: async () => body } as Response;
    }),
  );
  return calls;
}

async function render(props: {
  conversationId?: string | null;
  value?: PresetRef | null;
  onChange?: (preset: Preset | null) => void;
  onPresetsLoaded?: (presets: readonly Preset[]) => void;
}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PresetPicker
        conversationId={props.conversationId ?? null}
        value={props.value ?? null}
        onChange={props.onChange ?? (() => undefined)}
        onPresetsLoaded={props.onPresetsLoaded}
      />,
    );
  });
  await act(async () => {});
  await act(async () => {});
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function trigger(): HTMLElement | null {
  return container!.querySelector<HTMLElement>("[data-mw-preset-picker]");
}

/** Open the list: it is portalled, so its entries are looked for on the document. */
async function openList(): Promise<void> {
  await act(async () => {
    trigger()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger()!.click();
  });
  await act(async () => {});
}

function item(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="option"][data-mw-preset="${id}"]`);
}

function name(id: string): string | null | undefined {
  return item(id)?.querySelector("[data-slot='select-item-body'] > :first-child")?.textContent;
}

function description(id: string): string | null | undefined {
  return item(id)?.querySelector("[data-slot='select-item-description']")?.textContent;
}

async function choose(id: string): Promise<void> {
  await openList();
  await act(async () => {
    item(id)!.click();
  });
  await act(async () => {});
}

describe("PresetPicker", () => {
  it("is one pill reading No preset until one is picked, and lists each preset with what it does", async () => {
    stub([SUPPORT, RESEARCH]);
    const loaded = vi.fn();
    await render({ onPresetsLoaded: loaded });
    const pill = trigger()!;
    expect(pill.getAttribute("role")).toBe("combobox");
    expect(pill.getAttribute("aria-label")).toBe("Preset");
    expect(pill.textContent).toBe("No preset");
    expect(document.getElementById(pill.getAttribute("aria-describedby")!)?.textContent).toBe(
      "No preset: your own model and instructions.",
    );
    expect(loaded).toHaveBeenCalledWith([SUPPORT, RESEARCH]);

    await openList();
    const options = [...document.querySelectorAll("[role='option']")].map((o) => o.getAttribute("data-mw-preset"));
    expect(options).toEqual(["", "p-support", "p-research"]);
    expect(name("")).toBe("No preset");
    expect(name("p-support")).toBe("Support desk");
    expect(description("p-support")).toBe("Answers customer questions.");
    // Nothing written about it: the model it answers with is what it says.
    expect(description("p-research")).toBe("Answers with grt-nano.");
  });

  it("reports the pick and persists it on a stored conversation; No preset clears it", async () => {
    const calls = stub([SUPPORT, RESEARCH]);
    const onChange = vi.fn();
    await render({ conversationId: "c-1", onChange });
    await choose("p-support");
    expect(onChange).toHaveBeenLastCalledWith(SUPPORT);
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", url: "/api/conversations/c-1", body: { preset_id: "p-support" } },
    ]);

    await choose("");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ preset_id: null });
  });

  it("only reports the pick on a new chat, where the create carries it", async () => {
    const calls = stub([SUPPORT]);
    const onChange = vi.fn();
    await render({ conversationId: null, onChange });
    await choose("p-support");
    expect(onChange).toHaveBeenCalledWith(SUPPORT);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("names the preset in force on the pill, by the conversation's own ref", async () => {
    stub([SUPPORT, RESEARCH]);
    await render({ conversationId: "c-1", value: { id: "p-support", name: "Support desk" } });
    const pill = trigger()!;
    expect(pill.textContent).toBe("Support desk");
    expect(document.getElementById(pill.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Answering with the Support desk preset: Answers customer questions.",
    );
  });

  it("reads a deleted preset the conversation is still on, names it, and does not offer it to others", async () => {
    const calls = stub([SUPPORT], RETIRED);
    const loaded = vi.fn();
    await render({ conversationId: "c-1", value: { id: "p-old", name: "Old desk" }, onPresetsLoaded: loaded });
    expect(calls.map((c) => c.url)).toEqual(["/api/org/presets", "/api/org/presets/p-old"]);
    expect(trigger()!.textContent).toBe("Old desk");
    // The composer learns its model and welcome message the same way as a live one's.
    expect(loaded).toHaveBeenLastCalledWith([SUPPORT, RETIRED]);
    await openList();
    expect(description("p-old")).toBe("No longer offered; this conversation keeps it.");
    expect(name("p-support")).toBe("Support desk");
  });

  it("renders nothing while the org has no presets and none is in force", async () => {
    stub([]);
    await render({});
    expect(trigger()).toBeNull();
    expect(container!.innerHTML).toBe("");
  });

  it("renders nothing when the list cannot be read", async () => {
    stub([], null, 503);
    await render({});
    expect(trigger()).toBeNull();
  });

  it("still shows the pill for a conversation on a preset when the org has none left", async () => {
    stub([], RETIRED);
    await render({ conversationId: "c-1", value: { id: "p-old", name: "Old desk" } });
    expect(trigger()!.textContent).toBe("Old desk");
  });
});
