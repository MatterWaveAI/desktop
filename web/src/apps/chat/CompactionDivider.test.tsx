import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { CompactionDivider, ContextMeter, SummaryMarker } from "./CompactionDivider";
import { ConversationActions } from "./ConversationActions";
import { TranscriptError } from "./ChatStates";
import { foldPath, type SummaryPart } from "./compaction";

/**
 * The divider, the meter, Compact now and Continue, mounted the way the
 * other chat leaves are: react-dom/client plus act, no testing-library.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

const SUMMARY: SummaryPart = {
  type: "summary",
  text: "They agreed on green tea.",
  covers_from: "q1",
  covers_to: "a1",
  tokens_before: 600,
  tokens_after: 40,
};

function message(id: string, parent_id: string | null, role: Message["role"]): Message {
  return {
    id,
    conversation_id: "c1",
    role,
    content: role === "system" ? "" : `text of ${id}`,
    parts: role === "system" ? [SUMMARY as never] : undefined,
    created_at: "2026-01-01T00:00:00Z",
    parent_id,
    model: null,
  };
}

/**
 * The transcript loop of ThreadView in miniature. The path is the API's
 * shape: s1 folds q1..a1 and hangs under a3, the leaf it was computed from,
 * so q2..a3 between them is the kept tail.
 */
function Transcript() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const path = [
    message("q1", null, "user"),
    message("a1", "q1", "assistant"),
    message("q2", "a1", "user"),
    message("a2", "q2", "assistant"),
    message("q3", "a2", "user"),
    message("a3", "q3", "assistant"),
    message("s1", "a3", "system"),
    message("q4", "s1", "user"),
  ];
  const rows = foldPath(
    path.map((m) => ({ message: m, branch: null })),
    expanded,
  );
  return (
    <div>
      {rows.map((row) =>
        row.kind === "fold" ? (
          <CompactionDivider
            key="fold"
            covered={row.covered}
            expanded={row.expanded}
            onToggle={() => setExpanded((cur) => (cur.has("s1") ? new Set() : new Set(["s1"])))}
          />
        ) : row.kind === "summary" ? (
          <SummaryMarker key={row.entry.message.id} summary={row.summary} />
        ) : (
          <p key={row.entry.message.id} data-row={row.entry.message.id}>
            {row.entry.message.content}
          </p>
        ),
      )}
    </div>
  );
}

const shownRows = () => [...(container?.querySelectorAll("[data-row]") ?? [])].map((el) => el.getAttribute("data-row"));

describe("the compaction divider", () => {
  it("says the earlier messages were summarised, with the summary collapsed", () => {
    render(<Transcript />);
    expect(container?.textContent).toContain("Earlier messages were summarised");
    expect(container?.textContent).not.toContain("They agreed on green tea.");
    expect(shownRows()).toEqual(["q2", "a2", "q3", "a3", "q4"]);
    click(button("Show summary"));
    expect(container?.textContent).toContain("They agreed on green tea.");
  });

  it("sits after covers_to and before the kept tail, with the summary after that tail", () => {
    render(<Transcript />);
    const at = (selector: string) => container!.querySelector(selector)!;
    const before = (x: Element, y: Element) => Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(at("[data-mw-compaction]"), at("[data-row='q2']"))).toBe(true);
    expect(before(at("[data-row='a3']"), at("[data-mw-summary]"))).toBe(true);
    expect(before(at("[data-mw-summary]"), at("[data-row='q4']"))).toBe(true);
  });

  it("renders the covered originals above it on Show original messages, and folds them again", () => {
    render(<Transcript />);
    click(button("Show original messages"));
    expect(shownRows()).toEqual(["q1", "a1", "q2", "a2", "q3", "a3", "q4"]);
    // Above the divider: the originals come before it in document order.
    const divider = container!.querySelector("[data-mw-compaction]")!;
    const q1 = container!.querySelector("[data-row='q1']")!;
    expect(q1.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button("Hide original messages")?.getAttribute("aria-pressed")).toBe("true");
    click(button("Hide original messages"));
    expect(shownRows()).toEqual(["q2", "a2", "q3", "a3", "q4"]);
  });
});

describe("the context meter", () => {
  it("shows used over window and colours by level", () => {
    render(<ContextMeter context={{ used: 900, window: 1024 }} draft={"x".repeat(40)} />);
    const meter = container!.querySelector("[role='meter']")!;
    expect(meter.textContent).toBe("910 / 1,024");
    expect(meter.getAttribute("data-mw-context-meter")).toBe("warn");
  });

  it("marks a count that is the summary's estimate", () => {
    render(<ContextMeter context={{ used: 300, window: 1024, estimated: true }} draft="" />);
    const meter = container!.querySelector("[role='meter']")!;
    expect(meter.textContent).toBe("~300 / 1,024");
    expect(meter.getAttribute("aria-valuetext")).toBe("about 300 of 1,024 tokens");
  });

  it("renders nothing for a model with no window", () => {
    render(<ContextMeter context={{ used: 900, window: null }} draft="hi" />);
    expect(container!.querySelector("[role='meter']")).toBeNull();
  });

  it("offers Compact beside a full count, with a sentence on what it does", () => {
    const onCompact = vi.fn();
    render(<ContextMeter context={{ used: 1024, window: 1024 }} draft="" onCompact={onCompact} />);
    expect(container!.querySelector("[role='meter']")?.textContent).toBe("1,024 / 1,024");
    const compact = button("Compact")!;
    expect(compact).toBeDefined();
    expect(container!.querySelector("[data-mw-compact-hint]")?.textContent).toMatch(
      /summarises the earlier messages/,
    );
    click(compact);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("keeps the button for a full count only, and waits while a turn runs", () => {
    render(<ContextMeter context={{ used: 800, window: 1024 }} draft="" onCompact={() => undefined} />);
    expect(button("Compact")).toBeUndefined();
    expect(container!.querySelector("[data-mw-compact-hint]")).toBeNull();

    act(() => root?.unmount());
    container?.remove();
    render(
      <ContextMeter context={{ used: 1024, window: 1024 }} draft="" onCompact={() => undefined} compactDisabled />,
    );
    expect(button("Compact")?.disabled).toBe(true);

    act(() => root?.unmount());
    container?.remove();
    // No fold on offer (a new chat, a support session): the number alone.
    render(<ContextMeter context={{ used: 1024, window: 1024 }} draft="" />);
    expect(button("Compact")).toBeUndefined();
  });
});

describe("Compact now", () => {
  function open(props: { busy?: boolean; onCompact?: () => void }) {
    render(
      <ConversationActions
        busy={props.busy ?? false}
        onShare={() => undefined}
        onExport={() => undefined}
        onReport={() => undefined}
        onCompact={props.onCompact ?? (() => undefined)}
      />,
    );
    click(container!.querySelector("[aria-label='Conversation actions']"));
    return button("Compact now") as HTMLButtonElement | undefined;
  }

  it("is disabled while a turn streams", () => {
    // A menu item stays focusable while disabled (the menu pattern), so it
    // says so with aria-disabled rather than the attribute.
    expect(open({ busy: true })?.getAttribute("aria-disabled")).toBe("true");
  });

  // Whether there is anything to fold is the server's answer to the click
  // (a 409 the thread explains), not a greyed item nobody can account for.
  it("is enabled whenever the thread exists, and runs the fold", () => {
    const onCompact = vi.fn();
    const item = open({ onCompact });
    expect(item?.getAttribute("aria-disabled")).not.toBe("true");
    expect(item?.title).toMatch(/Summarise the earlier messages/);
    click(item);
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("is not offered at all without a handler", () => {
    render(
      <ConversationActions
        busy={false}
        onShare={() => undefined}
        onExport={() => undefined}
        onReport={() => undefined}
      />,
    );
    click(container!.querySelector("[aria-label='Conversation actions']"));
    expect(button("Compact now")).toBeUndefined();
    expect(button("Export as JSON")).not.toBeUndefined();
  });
});

describe("Continue on a length-truncated answer", () => {
  it("is the truncated notice with Continue in place of Retry", () => {
    const onContinue = vi.fn();
    render(<TranscriptError kind="truncated" onContinue={onContinue} />);
    expect(container!.querySelector("[data-error-kind='truncated']")).not.toBeNull();
    expect(button("Retry")).toBeUndefined();
    click(button("Continue"));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
