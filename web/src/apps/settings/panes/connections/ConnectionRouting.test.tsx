import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionRouting } from "./ConnectionRouting";
import { memberLabelOf } from "./connectionsApi";
import { CONNECTION, MEMBERS, PRESETS, route } from "./fixtures";
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
  setInputValue,
  stubApi,
  submit,
  type Mounted,
  type RecordedCall,
} from "../paneHarness";

/**
 * The routing editor: the table names each channel's preset and paying
 * member and flags a deleted preset; the add dialog's selects offer the
 * org's presets and members and send the route the API expects; a refused
 * preset is shown under its field; the enabled box is a PATCH.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ROUTES_URL = `/api/org/connections/${CONNECTION.id}/routes`;

function stubRoutes(
  rows: () => ReturnType<typeof route>[],
  extra: (call: RecordedCall) => { status: number; body: unknown } | undefined = () => undefined,
) {
  return stubApi((call) => {
    const answered = extra(call);
    if (answered) return answered;
    if (call.method === "GET" && call.url === ROUTES_URL) return { status: 200, body: { data: rows() } };
    return undefined;
  });
}

async function render() {
  mounted = await mount(
    <ConnectionRouting connection={CONNECTION} presets={PRESETS} members={MEMBERS} nameOf={memberLabelOf(MEMBERS)} />,
    principalWith(["user"], "admin"),
  );
  return mounted.container;
}

describe("the routing editor", () => {
  it("lists each channel with its preset and paying member, flagging a deleted preset", async () => {
    stubRoutes(() => [route({}), route({ id: "r-2", external_channel_id: "C0SALES", channel_label: "", preset_id: "p-gone", preset_name: null, paying_subject: "cy", enabled: false })]);
    const container = await render();
    expect(container.textContent).toContain("Only channels listed here are answered. Spend is charged to the paying member and counts against their cap.");
    const rows = [...container.querySelectorAll("tr[data-route-id]")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("#support");
    expect(rows[0].textContent).toContain("C0SUPPORT");
    expect(rows[0].textContent).toContain("Support desk");
    expect(rows[0].textContent).toContain("Ada");
    expect(rows[0].querySelector<HTMLInputElement>("input[name='enabled']")!.checked).toBe(true);
    expect(rows[1].querySelector("[data-route-preset-missing]")!.textContent).toBe("Preset deleted");
    expect(rows[1].textContent).toContain("Cy");
    expect(rows[1].querySelector<HTMLInputElement>("input[name='enabled']")!.checked).toBe(false);
  });

  it("offers the org's presets and members in the add dialog's selects", async () => {
    stubRoutes(() => []);
    const container = await render();
    click(buttonNamed(container, "Add channel…"));
    await flush();
    const dialog = document.querySelector("[data-route-create-dialog]")!;
    expect(buttonNamed(dialog, "Add channel").disabled).toBe(true);
    expect(await optionsOf(selectNamed(dialog, "Preset")!)).toEqual(["Support desk", "Sales"]);
    expect(await optionsOf(selectNamed(dialog, "Paying member")!)).toEqual([
      "Ada (ada@acme.com)",
      "dev@localhost",
      "Cy (cy@acme.com)",
    ]);
  });

  it("adds a channel with the chosen preset and paying member", async () => {
    let rows = [route({})];
    const calls = stubRoutes(
      () => rows,
      ({ method, url, body }) => {
        if (method === "POST" && url === ROUTES_URL) {
          const draft = body as { external_channel_id: string; preset_id: string; paying_subject: string };
          rows = [...rows, route({ id: "r-new", ...draft, preset_name: "Sales" })];
          return { status: 201, body: rows[1] };
        }
        return undefined;
      },
    );
    const container = await render();
    click(buttonNamed(container, "Add channel…"));
    await flush();
    const dialog = document.querySelector("[data-route-create-dialog]")!;
    const add = buttonNamed(dialog, "Add channel");
    const preset = selectNamed(dialog, "Preset")!;
    const payer = selectNamed(dialog, "Paying member")!;

    setInputValue(dialog.querySelector("input[name='external_channel_id']")!, " C0SALES ");
    setInputValue(dialog.querySelector("input[name='channel_label']")!, "#sales");
    await chooseOption(preset, "Sales");
    await chooseOption(payer, "Cy (cy@acme.com)");
    expect(selectShown(preset)).toBe("Sales");
    expect(add.disabled).toBe(false);
    submit(dialog.querySelector("form")!);
    await flush();

    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      external_channel_id: "C0SALES",
      channel_label: "#sales",
      preset_id: "p-sales",
      paying_subject: "cy",
      enabled: true,
    });
    expect(document.querySelector("[data-route-create-dialog]")).toBeNull();
    expect(container.querySelectorAll("tr[data-route-id]")).toHaveLength(2);
  });

  it("shows a refused preset under its field, and a taken channel above the form", async () => {
    let attempt = 0;
    stubRoutes(
      () => [],
      ({ method, url }) => {
        if (method !== "POST" || url !== ROUTES_URL) return undefined;
        attempt += 1;
        return attempt === 1
          ? { status: 422, body: { detail: [{ loc: ["body", "preset_id"], msg: "No such preset in this organisation.", type: "value_error" }] } }
          : { status: 409, body: { detail: "C0SALES already has a route." } };
      },
    );
    const container = await render();
    click(buttonNamed(container, "Add channel…"));
    await flush();
    const dialog = document.querySelector("[data-route-create-dialog]")!;
    setInputValue(dialog.querySelector("input[name='external_channel_id']")!, "C0SALES");
    await chooseOption(selectNamed(dialog, "Preset")!, "Sales");
    await chooseOption(selectNamed(dialog, "Paying member")!, "Ada (ada@acme.com)");
    submit(dialog.querySelector("form")!);
    await flush();
    const alerts = () => [...dialog.querySelectorAll("[role='alert']")].map((el) => el.textContent);
    expect(alerts()).toEqual(["No such preset in this organisation."]);
    submit(dialog.querySelector("form")!);
    await flush();
    expect(alerts()).toEqual(["C0SALES already has a route."]);
  });

  it("edits a route by sending only what changed, and switches it off with a PATCH", async () => {
    let current = route({});
    const calls = stubRoutes(
      () => [current],
      ({ method, url, body }) => {
        if (method === "PATCH" && url === `${ROUTES_URL}/r-1`) {
          current = { ...current, ...(body as Partial<ReturnType<typeof route>>) };
          return { status: 200, body: current };
        }
        return undefined;
      },
    );
    const container = await render();
    click(buttonNamed(container, "Edit…"));
    await flush();
    const dialog = document.querySelector("[data-route-edit-dialog]")!;
    // The channel id is fixed: a route is the channel's.
    expect(dialog.querySelector("input[name='external_channel_id']")).toBeNull();
    expect(dialog.textContent).toContain("C0SUPPORT");
    expect(selectShown(selectNamed(dialog, "Preset")!)).toBe("Support desk");
    await chooseOption(selectNamed(dialog, "Paying member")!, "Cy (cy@acme.com)");
    submit(dialog.querySelector("form")!);
    await flush();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ paying_subject: "cy" });

    const box = container.querySelector<HTMLInputElement>("input[name='enabled']")!;
    click(box);
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")[1].body).toEqual({ enabled: false });
  });

  it("removes a channel only through the confirmation", async () => {
    let rows = [route({})];
    const calls = stubRoutes(
      () => rows,
      ({ method, url }) => {
        if (method === "DELETE" && url === `${ROUTES_URL}/r-1`) {
          rows = [];
          return { status: 204, body: {} };
        }
        return undefined;
      },
    );
    const container = await render();
    click(buttonNamed(container, "Remove…"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const confirm = document.querySelector("[role='dialog']")!;
    expect(confirm.textContent).toContain("Stop answering in #support?");
    click(buttonNamed(confirm, "Remove channel"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(container.textContent).toContain("No channels yet.");
  });
});
