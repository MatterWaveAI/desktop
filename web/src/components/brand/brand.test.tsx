import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "../ui/alert";
import { NavItem } from "../ui/nav-item";
import { SimpleSelect } from "../ui/select";
import { AssistantMark, BrandLockup, WaveMark, Wordmark } from ".";

/**
 * The brand pieces and the primitives the brand added: the logo's waves,
 * the wordmark, the assistant's mark, the nav row's selected state, the
 * notice and the styled select that replaces a native one. Each test pins
 * what a caller relies on -- names, ids, roles, keyboard -- not the classes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("WaveMark", () => {
  it("draws the logo's four waves, each stroked by its own gradient", async () => {
    const el = await render(<WaveMark />);
    const svg = el.querySelector("svg")!;
    const paths = [...svg.querySelectorAll("path")];
    expect(paths).toHaveLength(4);
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(4);
    // Every stroke points at a gradient this svg defines.
    for (const path of paths) {
      const ref = /^url\(#(.+)\)$/.exec(path.getAttribute("stroke") ?? "")![1];
      expect(svg.querySelector(`linearGradient[id="${ref}"]`)).not.toBeNull();
    }
    // The base waves at the logo's 4.8, the M and W highlights at 6.4.
    expect(paths.map((p) => p.getAttribute("stroke-width"))).toEqual(["4.8", "4.8", "6.4", "6.4"]);
  });

  it("gives every instance its own gradient ids", async () => {
    const el = await render(
      <>
        <WaveMark />
        <WaveMark />
      </>,
    );
    const ids = [...el.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it("is decorative unless labelled, and an img with that name when it is", async () => {
    const el = await render(
      <>
        <WaveMark />
        <WaveMark label="MatterWave ai" />
      </>,
    );
    const [plain, named] = [...el.querySelectorAll("svg")];
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect(plain.getAttribute("role")).toBeNull();
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("MatterWave ai");
    expect(named.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps the logo's proportions at any width", async () => {
    const el = await render(<WaveMark width={328} />);
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("height")).toBe("46");
  });

  it("takes its colours from the wave tokens, never a literal", async () => {
    const el = await render(<WaveMark />);
    for (const stop of el.querySelectorAll("stop")) {
      expect(stop.getAttribute("style")).toMatch(/stop-color: var\(--mw-wave-[a-z]+\)/);
    }
  });
});

describe("Wordmark", () => {
  it("reads as the logo does: Matter, an italic Wave, and ai", async () => {
    const el = await render(<Wordmark />);
    const mark = el.querySelector("[data-slot=wordmark]")!;
    expect(mark.textContent).toBe("MatterWave ai");
    expect(mark.querySelector("em")?.textContent).toBe("Wave");
    expect(mark.className).toContain("font-display");
  });

  it("stacks over decorative waves in the lockup", async () => {
    const el = await render(<BrandLockup />);
    expect(el.textContent).toBe("MatterWave ai");
    expect(el.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("AssistantMark", () => {
  it("is a decorative two-colour wave", async () => {
    const el = await render(<AssistantMark />);
    const mark = el.querySelector("[data-slot=assistant-mark]")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelectorAll("path")).toHaveLength(2);
  });
});

describe("NavItem", () => {
  it("marks the active row as the current page, and only that one", async () => {
    const el = await render(
      <nav>
        <NavItem href="#a" active>
          Members
        </NavItem>
        <NavItem href="#b">Keys</NavItem>
      </nav>,
    );
    const [a, b] = [...el.querySelectorAll("a")];
    expect(a.getAttribute("aria-current")).toBe("page");
    expect(a.className).toContain("shadow-selected");
    expect(b.hasAttribute("aria-current")).toBe(false);
    expect(b.className).not.toContain("shadow-selected");
  });
});

describe("Alert", () => {
  it("shows the title and copy, and announces nothing unless asked", async () => {
    const el = await render(
      <Alert variant="warning" title="2 of 1 seat in use" action={<button type="button">Add seats</button>}>
        Invites are paused.
      </Alert>,
    );
    const alert = el.querySelector("[data-slot=alert]")!;
    expect(alert.getAttribute("data-variant")).toBe("warning");
    expect(alert.textContent).toContain("2 of 1 seat in use");
    expect(alert.textContent).toContain("Invites are paused.");
    expect(alert.getAttribute("role")).toBeNull();
    expect(alert.querySelector("button")?.textContent).toBe("Add seats");
  });

  it("passes a role through for a notice that arrives after an action", async () => {
    const el = await render(<Alert variant="danger" role="alert" title="Payment failed" />);
    expect(el.querySelector("[role=alert]")).not.toBeNull();
  });
});

describe("SimpleSelect", () => {
  const OPTIONS = [
    { value: "owner", label: "Owner" },
    { value: "admin", label: "Admin" },
    { value: "member", label: "Member" },
  ];

  it("is a named combobox showing the chosen option's label", async () => {
    const el = await render(
      <SimpleSelect aria-label="Role" value="member" onValueChange={() => {}} options={OPTIONS} />,
    );
    const trigger = el.querySelector("[data-slot=select-trigger]")!;
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-label")).toBe("Role");
    expect(trigger.textContent).toContain("Member");
  });

  it("opens from the keyboard, lists every option, and reports the choice", async () => {
    const chosen: string[] = [];
    const el = await render(
      <SimpleSelect aria-label="Role" value="member" onValueChange={(v) => chosen.push(v)} options={OPTIONS} />,
    );
    const trigger = el.querySelector<HTMLElement>("[data-slot=select-trigger]")!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[role=option]")).toHaveLength(3);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const admin = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
      (o) => o.textContent === "Admin",
    )!;
    await act(async () => {
      admin.click();
    });
    expect(chosen).toEqual(["admin"]);
  });
});
