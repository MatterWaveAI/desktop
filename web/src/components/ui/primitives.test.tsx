import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button";
import { Field } from "./field";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { TabStrip, TabStripItem } from "./tab-strip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Textarea } from "./textarea";

/**
 * The shared primitives other surfaces adopt: Field, CopyButton, TabStrip,
 * Table, and the portalled Popover. Each test pins the behaviour a caller
 * relies on rather than the markup.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
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

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

describe("Field", () => {
  it("labels the control and describes it with the hint", async () => {
    const el = await render(
      <Field label="Webhook URL" hint="Must be https.">
        <Input />
      </Field>,
    );
    const input = el.querySelector("input")!;
    const label = el.querySelector("label")!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.id).not.toBe("");
    const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Must be https.");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("marks the control invalid and adds the error to its description", async () => {
    const el = await render(
      <Field label="Name" hint="Shown to members." error="Name is required." required>
        <Textarea />
      </Field>,
    );
    const textarea = el.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-required")).toBe("true");
    const described = textarea
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual(["Shown to members.", "Name is required."]);
    // The error region is live, so an error after submit is announced.
    expect(el.querySelector("[data-slot=field-error]")!.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps an id and description the child already has", async () => {
    const el = await render(
      <Field label="Key" hint="Secret.">
        <Input id="api-key" aria-describedby="elsewhere" />
      </Field>,
    );
    const input = el.querySelector("input")!;
    expect(input.id).toBe("api-key");
    expect(el.querySelector("label")!.htmlFor).toBe("api-key");
    expect(input.getAttribute("aria-describedby")).toBe("elsewhere api-key-hint");
  });

  it("hands a render function the control props", async () => {
    const el = await render(
      <Field label="Plan" error="Pick one.">
        {(control) => <button type="button" {...control}>Choose</button>}
      </Field>,
    );
    const button = el.querySelector("button")!;
    expect(el.querySelector("label")!.htmlFor).toBe(button.id);
    expect(button.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("CopyButton", () => {
  it("renders nothing without a clipboard (insecure context)", async () => {
    stubClipboard(null);
    const el = await render(<CopyButton text="secret" />);
    expect(el.querySelector("button")).toBeNull();
  });

  it("copies the text and reads Copied, then Copy again", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const el = await render(<CopyButton text={() => "built at click"} label="Copy key" />);
    const button = el.querySelector("button")!;
    expect(button.textContent).toBe("Copy key");
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith("built at click");
    expect(button.textContent).toBe("Copied");
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(button.textContent).toBe("Copy key");
  });

  it("does not claim a copy that failed", async () => {
    stubClipboard(async () => {
      throw new Error("not focused");
    });
    const el = await render(<CopyButton text="x" iconOnly label="Copy code" />);
    const button = el.querySelector("button")!;
    await act(async () => button.click());
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });
});

describe("TabStrip", () => {
  it("is labelled navigation with the active item marked current", async () => {
    const el = await render(
      <TabStrip aria-label="Settings">
        <TabStripItem href="/settings/account">Account</TabStripItem>
        <TabStripItem href="/settings/members" active>
          Members
        </TabStripItem>
      </TabStrip>,
    );
    const nav = el.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Settings");
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(links[1].hasAttribute("data-active")).toBe(true);
    // Never wraps: the scroller is a single nowrap row.
    expect(el.querySelector(".mw-tabstrip")!.className).toContain("flex-nowrap");
  });

  it("fades the edge there is more to scroll towards", async () => {
    const el = await render(
      <TabStrip aria-label="Admin">
        <TabStripItem href="#a">One</TabStripItem>
        <TabStripItem href="#b">Two</TabStripItem>
      </TabStrip>,
    );
    const scroller = el.querySelector<HTMLElement>(".mw-tabstrip")!;
    // jsdom has no layout; give the scroller one.
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 300 });
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(scroller.hasAttribute("data-fade-end")).toBe(true);
    expect(scroller.hasAttribute("data-fade-start")).toBe(false);
    scroller.scrollLeft = 200;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(scroller.hasAttribute("data-fade-start")).toBe(true);
    expect(scroller.hasAttribute("data-fade-end")).toBe(false);
  });

  it("renders items through a custom element such as the router's Link", async () => {
    const el = await render(
      <TabStrip aria-label="Panes">
        <TabStripItem active render={<button type="button" />}>
          Usage
        </TabStripItem>
      </TabStrip>,
    );
    const button = el.querySelector("button")!;
    expect(button.getAttribute("aria-current")).toBe("page");
  });
});

describe("Table", () => {
  it("scrolls inside its own container and scopes header cells", async () => {
    const el = await render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Ada</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(el.querySelector("[data-slot=table-container]")!.className).toContain("overflow-x-auto");
    expect(el.querySelector("th")!.getAttribute("scope")).toBe("col");
  });
});

describe("Table, wider than its wrapper", () => {
  function sized(scrollWidth: number, clientWidth: number): () => void {
    const proto = HTMLElement.prototype;
    const before = {
      scroll: Object.getOwnPropertyDescriptor(proto, "scrollWidth"),
      client: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
    };
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => scrollWidth });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => clientWidth });
    return () => {
      if (before.scroll) Object.defineProperty(proto, "scrollWidth", before.scroll);
      if (before.client) Object.defineProperty(proto, "clientWidth", before.client);
    };
  }

  const table = (
    <Table aria-label="Retention by organisation">
      <TableBody>
        <TableRow>
          <TableCell>Org One</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );

  it("takes a Tab stop and names itself after the table, so the keyboard can scroll it", async () => {
    const restore = sized(800, 300);
    try {
      const el = await render(table);
      const wrapper = el.querySelector<HTMLElement>("[data-slot=table-container]")!;
      expect(wrapper.tabIndex).toBe(0);
      expect(wrapper.getAttribute("role")).toBe("region");
      expect(wrapper.getAttribute("aria-label")).toBe("Retention by organisation");
    } finally {
      restore();
    }
  });

  it("adds no Tab stop while the table fits", async () => {
    const restore = sized(300, 300);
    try {
      const el = await render(table);
      const wrapper = el.querySelector<HTMLElement>("[data-slot=table-container]")!;
      expect(wrapper.hasAttribute("tabindex")).toBe(false);
      expect(wrapper.hasAttribute("role")).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("Popover (usage example)", () => {
  it("portals out of a clipping container so overflow-hidden cannot cut it off", async () => {
    const el = await render(
      <div style={{ overflow: "hidden", height: 10 }} data-testid="clip">
        <Popover defaultOpen>
          <PopoverTrigger>Filters</PopoverTrigger>
          <PopoverContent>Narrow the list.</PopoverContent>
        </Popover>
      </div>,
    );
    const popup = document.querySelector("[data-slot=popover-content]")!;
    expect(popup).not.toBeNull();
    expect(popup.textContent).toBe("Narrow the list.");
    expect(el.querySelector("[data-testid=clip]")!.contains(popup)).toBe(false);
  });
});
