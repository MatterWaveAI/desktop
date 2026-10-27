import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABOUT_MAX_LEN,
  CustomInstructionsPane,
  STYLE_MAX_LEN,
  planAccessOf,
} from "./CustomInstructionsPane";
import {
  buttonNamed,
  flush,
  mount,
  principalWith,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * Custom instructions as the user meets them: the two fields load with what the API holds,
 * the counter tracks what they type, Save is off until something changes, and
 * the PUT carries exactly the two fields.
 */

// The plan notice's Upgrade is a router <Link>, which throws outside a
// RouterProvider; a plain anchor carries the same href for the assertion.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; className?: string; children?: React.ReactNode }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

/** `/api/entitlements` as a plan with, or without, custom instructions. */
function entitlement(allowed: boolean, planName = allowed ? "Pro" : "Free") {
  return { plan_name: planName, limits: { features: { custom_instructions: allowed } } };
}

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

function fields(container: HTMLElement): HTMLTextAreaElement[] {
  return [...container.querySelectorAll("textarea")];
}

async function mountPane(stored: { about: string; style: string }, allowed = true) {
  const calls = stubApi(({ method, url }) => {
    if (method === "GET" && url === "/api/entitlements") return { status: 200, body: entitlement(allowed) };
    if (method === "GET" && url === "/api/me/instructions") return { status: 200, body: stored };
    if (method === "PUT" && url === "/api/me/instructions") {
      return { status: 200, body: stored };
    }
    return undefined;
  });
  mounted = await mount(<CustomInstructionsPane />, principalWith(["user"]));
  return calls;
}

describe("the custom instructions pane", () => {
  it("loads both fields with what the API holds", async () => {
    await mountPane({ about: "I am a vet.", style: "Be brief." });
    const [about, style] = fields(mounted!.container);
    expect(about.value).toBe("I am a vet.");
    expect(style.value).toBe("Be brief.");
  });

  it("shows a character count per field against the cap", async () => {
    await mountPane({ about: "abc", style: "" });
    const counts = [...mounted!.container.querySelectorAll("p")]
      .map((p) => p.textContent)
      .filter((text) => text?.includes("/"));
    expect(counts).toContain(`3 / ${ABOUT_MAX_LEN}`);
    expect(counts).toContain(`0 / ${STYLE_MAX_LEN}`);
  });

  it("keeps Save off until something changes, then sends both fields", async () => {
    const calls = await mountPane({ about: "I am a vet.", style: "Be brief." });
    const save = buttonNamed(mounted!.container, "Save instructions");
    expect(save.disabled).toBe(true);

    const [about] = fields(mounted!.container);
    setTextarea(about, "I am a Python developer.");
    expect(save.disabled).toBe(false);

    submit(mounted!.container.querySelector("form")!);
    await flush();

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/api/me/instructions");
    expect(put?.body).toEqual({ about: "I am a Python developer.", style: "Be brief." });
  });

  it("refuses to send a field over the cap and marks it invalid", async () => {
    const calls = await mountPane({ about: "", style: "" });
    const [about] = fields(mounted!.container);
    setTextarea(about, "a".repeat(ABOUT_MAX_LEN + 1));

    expect(about.getAttribute("aria-invalid")).toBe("true");
    const save = buttonNamed(mounted!.container, "Save instructions");
    expect(save.disabled).toBe(true);

    submit(mounted!.container.querySelector("form")!);
    await flush();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("confirms the save where a screen reader will hear it", async () => {
    await mountPane({ about: "", style: "" });
    const [about] = fields(mounted!.container);
    setTextarea(about, "I am a vet.");
    submit(mounted!.container.querySelector("form")!);
    await flush();

    const status = mounted!.container.querySelector("p[role='status']");
    expect(status?.textContent).toContain("Saved");
  });

  it("shows the API's refusal rather than claiming a save", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/instructions") {
        return { status: 200, body: { about: "", style: "" } };
      }
      if (method === "PUT" && url === "/api/me/instructions") {
        return { status: 422, body: { detail: "Too long" } };
      }
      return undefined;
    });
    mounted = await mount(<CustomInstructionsPane />, principalWith(["user"]));

    const [about] = fields(mounted.container);
    setTextarea(about, "I am a vet.");
    submit(mounted.container.querySelector("form")!);
    await flush();

    const status = mounted.container.querySelector("p[role='status']");
    expect(status?.textContent).not.toContain("Saved");
    expect(status?.textContent?.length).toBeGreaterThan(0);
  });
});

describe("on a plan without custom instructions", () => {
  it("says so up front, offers Upgrade, and makes the fields read-only with no Save", async () => {
    await mountPane({ about: "I am a vet.", style: "" }, false);
    const { container } = mounted!;
    const notice = container.querySelector("[data-testid='plan-notice']")!;
    expect(notice.textContent).toContain("not included in the Free plan");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe("/pricing");
    expect(notice.querySelector("a")?.textContent).toBe("Upgrade");
    // What was saved before is still shown, just not editable.
    const [about, style] = fields(container);
    expect(about.value).toBe("I am a vet.");
    expect(about.readOnly).toBe(true);
    expect(style.readOnly).toBe(true);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Save instructions",
    );
  });

  it("is decided before the fields appear, not after a refused save", async () => {
    let answered = false;
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/instructions") return { status: 200, body: { about: "", style: "" } };
      if (method === "GET" && url === "/api/entitlements") {
        answered = true;
        return { status: 200, body: entitlement(false) };
      }
      return undefined;
    });
    mounted = await mount(<CustomInstructionsPane />, principalWith(["user"]));
    expect(answered).toBe(true);
    expect(mounted.container.querySelector("[data-testid='plan-notice']")).not.toBeNull();
    expect(fields(mounted.container)[0].readOnly).toBe(true);
  });

  it("treats an unreadable or switchless entitlement as allowed, leaving the PUT to decide", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/instructions") return { status: 200, body: { about: "", style: "" } };
      return undefined;
    });
    mounted = await mount(<CustomInstructionsPane />, principalWith(["user"]));
    expect(mounted.container.querySelector("[data-testid='plan-notice']")).toBeNull();
    expect(fields(mounted.container)[0].readOnly).toBe(false);
    expect(buttonNamed(mounted.container, "Save instructions")).toBeDefined();

    expect(planAccessOf(null)).toEqual({ allowed: true, planName: "Free" });
    expect(planAccessOf({ plan_name: "Team", limits: { features: {} } })).toEqual({ allowed: true, planName: "Team" });
    expect(planAccessOf(entitlement(false))).toEqual({ allowed: false, planName: "Free" });
  });
});

describe("an unsaved draft", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("survives leaving the pane and is offered back, with a way to discard it", async () => {
    await mountPane({ about: "I am a vet.", style: "" });
    setTextarea(fields(mounted!.container)[0], "I am a vet who codes.");
    mounted!.unmount();
    mounted = null;

    await mountPane({ about: "I am a vet.", style: "" });
    expect(fields(mounted!.container)[0].value).toBe("I am a vet who codes.");
    expect(mounted!.container.textContent).toContain("Restored your unsaved changes.");
    expect(buttonNamed(mounted!.container, "Save instructions").disabled).toBe(false);

    act(() => {
      buttonNamed(mounted!.container, "Discard changes").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(fields(mounted!.container)[0].value).toBe("I am a vet.");
    mounted!.unmount();
    mounted = null;

    await mountPane({ about: "I am a vet.", style: "" });
    expect(fields(mounted!.container)[0].value).toBe("I am a vet.");
  });

  it("is cleared once saved", async () => {
    await mountPane({ about: "", style: "" });
    setTextarea(fields(mounted!.container)[1], "Be brief.");
    submit(mounted!.container.querySelector("form")!);
    await flush();
    mounted!.unmount();
    mounted = null;

    await mountPane({ about: "", style: "" });
    expect(fields(mounted!.container)[1].value).toBe("");
    expect(mounted!.container.textContent).not.toContain("Restored your unsaved changes.");
  });
});
