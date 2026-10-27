import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_INSTRUCTIONS_MAX_LEN,
  InstructionsBadge,
} from "./InstructionsBadge";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  stubApi,
  type Mounted,
} from "../settings/panes/paneHarness";
import type { EffectiveInstructions } from "../../types";

/**
 * The instructions badge as the user meets it: the conversation says whether
 * anything is shaping its answers, opening it shows the assembled text the
 * model receives, and the owner can override or clear it for this thread.
 */

const CONVERSATION_ID = "11111111-1111-7111-8111-111111111111";

const NONE: EffectiveInstructions = {
  org: "",
  user: { about: "", style: "" },
  conversation: "",
  user_overridden: false,
  effective: "",
};

const FROM_USER: EffectiveInstructions = {
  org: "",
  user: { about: "I am a vet.", style: "" },
  conversation: "",
  user_overridden: false,
  effective: "About the user:\nI am a vet.",
};

const OVERRIDDEN: EffectiveInstructions = {
  org: "Answer in British English.",
  user: { about: "I am a vet.", style: "" },
  conversation: "Answer as a teacher would.",
  user_overridden: true,
  effective:
    "Organisation instructions (policy; apply to every conversation here):\n" +
    "Answer in British English.\n\n" +
    "Instructions for this conversation:\nAnswer as a teacher would.",
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setTextarea(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountBadge(
  instructions: EffectiveInstructions | null,
  conversationId: string | null = CONVERSATION_ID,
) {
  const changed: EffectiveInstructions[] = [];
  const calls = stubApi(({ method, url }) => {
    if (method === "PUT" && url === `/api/conversations/${CONVERSATION_ID}/instructions`) {
      return { status: 200, body: { conversation_id: CONVERSATION_ID, instructions: NONE } };
    }
    return undefined;
  });
  mounted = await mount(
    <InstructionsBadge
      conversationId={conversationId}
      instructions={instructions}
      onChanged={(next) => changed.push(next)}
    />,
    principalWith(["user"]),
  );
  return { calls, changed };
}

describe("the conversation's instructions affordance", () => {
  it("says nothing is in force when no level is set", async () => {
    await mountBadge(NONE);
    expect(buttonNamed(document.body, "InstructionsOff")).toBeTruthy();
  });

  it("says instructions are on when any level applies", async () => {
    await mountBadge(FROM_USER);
    expect(buttonNamed(document.body, "InstructionsOn")).toBeTruthy();
  });

  it("is absent on a new chat when the person's own instructions cannot be read", async () => {
    await mountBadge(NONE, null);
    expect(document.body.querySelector("button")).toBeNull();
  });

  it("on a new chat, says the person's own instructions will apply, read only", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/instructions"
        ? { status: 200, body: { about: "I am a vet.", style: "" } }
        : undefined,
    );
    mounted = await mount(
      <InstructionsBadge conversationId={null} instructions={null} onChanged={() => undefined} />,
      principalWith(["user"]),
    );
    await flush();
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();
    expect(document.body.textContent).toContain("I am a vet.");
    // Nothing to write to before the first turn creates the conversation.
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.querySelector("a[href='/settings/instructions']")).not.toBeNull();
  });

  it("shows the assembled text the model receives, not its own guess", async () => {
    await mountBadge(OVERRIDDEN);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();
    expect(document.body.querySelector("pre")?.textContent).toBe(OVERRIDDEN.effective);
  });

  it("says when the thread is displacing the user's own instructions", async () => {
    await mountBadge(OVERRIDDEN);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();
    expect(document.body.textContent).toContain(
      "replaces your own custom instructions",
    );
  });

  it("says the organisation's instructions cannot be turned off here", async () => {
    await mountBadge(OVERRIDDEN);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();
    expect(document.body.textContent).toContain("cannot be turned off here");
  });

  it("saves an override for this thread through the API", async () => {
    const { calls, changed } = await mountBadge(FROM_USER);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();

    setTextarea(document.body.querySelector("textarea")!, "Answer as a teacher would.");
    click(buttonNamed(document.body, "Save"));
    await flush();

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe(`/api/conversations/${CONVERSATION_ID}/instructions`);
    expect(put?.body).toEqual({ text: "Answer as a teacher would." });
    // The parent is handed what the API returned, so the banner and the next
    // turn agree without a refetch.
    expect(changed).toHaveLength(1);
  });

  it("clears the override with null rather than an empty string", async () => {
    const { calls } = await mountBadge(OVERRIDDEN);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();

    click(buttonNamed(document.body, "Use my instructions"));
    await flush();

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body).toEqual({ text: null });
  });

  it("treats a box emptied by hand as a clear, not as a blank prompt", async () => {
    const { calls } = await mountBadge(OVERRIDDEN);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();

    setTextarea(document.body.querySelector("textarea")!, "   ");
    click(buttonNamed(document.body, "Save"));
    await flush();

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ text: null });
  });

  it("refuses to send a prompt over the cap", async () => {
    const { calls } = await mountBadge(FROM_USER);
    click(buttonNamed(document.body, "InstructionsOn"));
    await flush();

    const field = document.body.querySelector("textarea")!;
    setTextarea(field, "c".repeat(CONVERSATION_INSTRUCTIONS_MAX_LEN + 1));
    expect(field.getAttribute("aria-invalid")).toBe("true");

    const save = buttonNamed(document.body, "Save");
    expect(save.disabled).toBe(true);
    click(save);
    await flush();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
