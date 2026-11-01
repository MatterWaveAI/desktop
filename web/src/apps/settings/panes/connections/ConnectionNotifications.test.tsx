import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionNotifications } from "./ConnectionNotifications";
import { CONNECTION, NOTIFIABLE_EVENTS } from "./fixtures";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "../paneHarness";

/**
 * Notifications: the form starts from the connection's config, offers
 * only the events the API allows, and saves the channel and the chosen
 * events into the config beside the adapter's keys.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connection notifications", () => {
  it("starts from the config and saves the channel with the chosen events, keeping the adapter's keys", async () => {
    const connection = { ...CONNECTION, config: { ...CONNECTION.config, bot_user_id: "U0BOT" } };
    const calls = stubApi(({ method, url, body }) =>
      method === "PATCH" && url === `/api/org/connections/${CONNECTION.id}`
        ? { status: 200, body: { ...connection, config: (body as { config: unknown }).config } }
        : undefined,
    );
    const onChanged = vi.fn();
    mounted = await mount(
      <ConnectionNotifications connection={connection} events={NOTIFIABLE_EVENTS} onChanged={onChanged} />,
      principalWith(["user"], "admin"),
    );
    const form = mounted.container.querySelector("form")!;
    const channel = form.querySelector<HTMLInputElement>("input[name='notify_channel']")!;
    expect(channel.value).toBe("C0ADMIN");
    const boxes = [...form.querySelectorAll<HTMLInputElement>("input[name='notify_events']")];
    expect(boxes.map((b) => b.value)).toEqual(NOTIFIABLE_EVENTS);
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(["budget.warn"]);
    const save = buttonNamed(form, "Save notifications");
    expect(save.disabled).toBe(true);

    setInputValue(channel, "C0OPS");
    click(boxes[NOTIFIABLE_EVENTS.indexOf("member.joined")]);
    click(boxes[NOTIFIABLE_EVENTS.indexOf("api_key.revoked")]);
    expect(save.disabled).toBe(false);
    submit(form);
    await flush();
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: {
        config: {
          bot_user_id: "U0BOT",
          notify_channel: "C0OPS",
          // The API's order, not the click order.
          notify_events: ["api_key.revoked", "budget.warn", "member.joined"],
        },
      },
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("needs a channel once an event is chosen, and shows a refused config", async () => {
    stubApi(({ method }) =>
      method === "PATCH"
        ? { status: 422, body: { detail: [{ loc: ["body", "config"], msg: "notify_events may name only budget.warn", type: "value_error" }] } }
        : undefined,
    );
    mounted = await mount(
      <ConnectionNotifications connection={{ ...CONNECTION, config: {} }} events={NOTIFIABLE_EVENTS} onChanged={() => undefined} />,
      principalWith(["user"], "admin"),
    );
    const form = mounted.container.querySelector("form")!;
    const save = buttonNamed(form, "Save notifications");
    click(form.querySelector<HTMLInputElement>("input[value='plan.changed']")!);
    expect(save.disabled).toBe(true);
    setInputValue(form.querySelector<HTMLInputElement>("input[name='notify_channel']")!, "C0OPS");
    expect(save.disabled).toBe(false);
    submit(form);
    await flush();
    expect(form.querySelector("[role='alert']")!.textContent).toBe("notify_events may name only budget.warn");
  });
});
