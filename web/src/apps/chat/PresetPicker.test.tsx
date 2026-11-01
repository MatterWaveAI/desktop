import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Preset, PresetRef } from "../../types";
import { PresetPicker } from "./PresetPicker";

/**
 * The picker against the org's presets: one box naming the preset in
 * force, "No preset" first in the list, each preset by name with what it
 * does on the line under the box; a pick on a stored conversation is
 * PATCHed as its `preset_id` and "No preset" clears it; a conversation on
 * a preset the org has since deleted still names it, read on its own,
 * without the list offering it; and an org with no presets gets no
 * control at all.
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

function box(): HTMLSelectElement | null {
  return container!.querySelector<HTMLSelectElement>("[data-mw-preset-picker]");
}

function options(): HTMLOptionElement[] {
  return [...container!.querySelectorAll("option")];
}

function name(id: string): string | null | undefined {
  return options().find((o) => o.value === id)?.textContent;
}

function shown(): string | undefined {
  return box()!.selectedOptions[0]?.textContent ?? undefined;
}

function description(): string | null | undefined {
  return container!.querySelector("#mw-preset-description")?.textContent;
}

async function choose(id: string): Promise<void> {
  const select = box()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, id);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {});
}

describe("PresetPicker", () => {
  it("is one box reading No preset until one is picked, and lists each preset by name", async () => {
    stub([SUPPORT, RESEARCH]);
    const loaded = vi.fn();
    await render({ onPresetsLoaded: loaded });
    const select = box()!;
    expect(select.getAttribute("aria-label")).toBe("Preset");
    expect(shown()).toBe("No preset");
    expect(select.getAttribute("aria-describedby")).toBe("mw-preset-description");
    expect(description()).toBe("No preset: your own model and instructions.");
    expect(loaded).toHaveBeenCalledWith([SUPPORT, RESEARCH]);

    expect(options().map((o) => o.value)).toEqual(["", "p-support", "p-research"]);
    expect(name("")).toBe("No preset");
    expect(name("p-support")).toBe("Support desk");
    expect(name("p-research")).toBe("Research");
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

  it("names the preset in force, by the conversation's own ref, with what it does under the box", async () => {
    stub([SUPPORT, RESEARCH]);
    await render({ conversationId: "c-1", value: { id: "p-support", name: "Support desk" } });
    expect(shown()).toBe("Support desk");
    expect(description()).toBe("Answering with the Support desk preset: Answers customer questions.");
  });

  it("reads a deleted preset the conversation is still on, names it, and does not offer it to others", async () => {
    const calls = stub([SUPPORT], RETIRED);
    const loaded = vi.fn();
    await render({ conversationId: "c-1", value: { id: "p-old", name: "Old desk" }, onPresetsLoaded: loaded });
    expect(calls.map((c) => c.url)).toEqual(["/api/org/presets", "/api/org/presets/p-old"]);
    expect(shown()).toBe("Old desk — no longer offered");
    expect(description()).toBe("Answering with the Old desk preset.");
    // The composer learns its model and welcome message the same way as a live one's.
    expect(loaded).toHaveBeenLastCalledWith([SUPPORT, RETIRED]);
    expect(options().map((o) => o.value)).toEqual(["", "p-support", "p-old"]);
    expect(name("p-support")).toBe("Support desk");
  });

  it("renders nothing while the org has no presets and none is in force", async () => {
    stub([]);
    await render({});
    expect(box()).toBeNull();
    expect(container!.innerHTML).toBe("");
  });

  it("renders nothing when the list cannot be read", async () => {
    stub([], null, 503);
    await render({});
    expect(box()).toBeNull();
  });

  it("still shows the box for a conversation on a preset when the org has none left", async () => {
    stub([], RETIRED);
    await render({ conversationId: "c-1", value: { id: "p-old", name: "Old desk" } });
    expect(shown()).toBe("Old desk — no longer offered");
  });
});
