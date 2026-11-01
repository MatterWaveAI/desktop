import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionEvents } from "./ConnectionEvents";
import { memberLabelOf } from "./connectionsApi";
import { CONNECTION, MEMBERS, OUTCOMES, event } from "./fixtures";
import {
  buttonNamed,
  chooseOption,
  click,
  flush,
  mount,
  principalWith,
  selectNamed,
  stubApi,
  type Mounted,
} from "../paneHarness";

/**
 * The trigger log: newest first with each event's outcome, who asked and
 * where; the conversation is a link only for the paying member and an id
 * for everyone else; the outcome filter is the API's query; Load more
 * follows the cursor and appends the page.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EVENTS_URL = `/api/org/connections/${CONNECTION.id}/events`;

const FIRST = [
  event({}),
  event({ id: "e-2", outcome: "bad_signature", kind: "unverified", external_user_id: null, external_channel_id: null, conversation_id: null, paying_subject: null }),
  event({ id: "e-3", outcome: "answered", conversation_id: "conv-mine", paying_subject: "dev-user" }),
];
const SECOND = [event({ id: "e-4", outcome: "channel_not_routed", conversation_id: null, paying_subject: null, detail: "C0RANDOM" })];

function stubEvents() {
  return stubApi(({ method, url }) => {
    if (method !== "GET" || !url.startsWith(EVENTS_URL)) return undefined;
    const params = new URL(url, "http://x").searchParams;
    if (params.get("outcome") === "bad_signature") return { status: 200, body: { data: [FIRST[1]], next_cursor: null } };
    if (params.get("outcome")) return { status: 200, body: { data: [], next_cursor: null } };
    if (params.get("cursor") === "after-e-3") return { status: 200, body: { data: SECOND, next_cursor: null } };
    return { status: 200, body: { data: FIRST, next_cursor: "after-e-3" } };
  });
}

async function render() {
  mounted = await mount(
    <ConnectionEvents connection={CONNECTION} outcomes={OUTCOMES} nameOf={memberLabelOf(MEMBERS)} />,
    principalWith(["user"], "admin"),
  );
  return mounted.container;
}

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("tr[data-event-id]")];

describe("the trigger log", () => {
  it("lists each event's outcome, who asked and where, linking the conversation only for its paying member", async () => {
    const calls = stubEvents();
    const container = await render();
    expect(calls[0].url).toBe(`${EVENTS_URL}?limit=50`);
    const [answered, forged, mine] = rows(container);
    expect(answered.textContent).toContain("Answered");
    expect(answered.textContent).toContain("U0JANE");
    expect(answered.textContent).toContain("C0SUPPORT");
    expect(answered.textContent).toContain("Ada");
    // Ada's conversation: the id, no link, for this admin.
    expect(answered.textContent).toContain("conv-1");
    expect(answered.querySelector("[data-event-conversation-link]")).toBeNull();
    expect(forged.textContent).toContain("Bad signature");
    expect(forged.getAttribute("data-event-outcome")).toBe("bad_signature");
    const link = mine.querySelector<HTMLAnchorElement>("[data-event-conversation-link]")!;
    expect(link.textContent).toBe("conv-mine");
    expect(link.getAttribute("href")).toBe("/apps/chat?c=conv-mine");
  });

  it("follows the cursor with Load more and appends the page", async () => {
    const calls = stubEvents();
    const container = await render();
    expect(rows(container)).toHaveLength(3);
    click(buttonNamed(container, "Load more"));
    await flush();
    expect(calls.at(-1)!.url).toBe(`${EVENTS_URL}?cursor=after-e-3&limit=50`);
    expect(rows(container).map((r) => r.getAttribute("data-event-id"))).toEqual(["e-1", "e-2", "e-3", "e-4"]);
    expect(rows(container)[3].textContent).toContain("Channel not routed");
    expect(rows(container)[3].textContent).toContain("C0RANDOM");
    // The last page: nothing more to load.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(false);
  });

  it("filters by outcome with the API's query", async () => {
    const calls = stubEvents();
    const container = await render();
    await chooseOption(selectNamed(container, "Outcome")!, "Bad signature");
    expect(calls.at(-1)!.url).toBe(`${EVENTS_URL}?outcome=bad_signature&limit=50`);
    expect(rows(container)).toHaveLength(1);
    await chooseOption(selectNamed(container, "Outcome")!, "Guest");
    await flush();
    expect(container.textContent).toContain("No events with this outcome.");
  });
});
