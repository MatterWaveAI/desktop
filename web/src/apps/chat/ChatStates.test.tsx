import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AwaitingFirstToken,
  ConversationListSkeleton,
  ConversationMissing,
  NewConversationState,
  OfflineBanner,
  PhaseAnnouncer,
  RequestReference,
  StoppedNote,
  StreamingIndicator,
  TranscriptError,
  TranscriptSkeleton,
} from "./ChatStates";
import { ApiError } from "../../lib/api";
import { EXAMPLE_PROMPTS } from "./examplePrompts";
import {
  classifyStreamError,
  isMissingConversation,
  STREAM_ERROR_COPY,
  STREAM_ERROR_KINDS,
  TRUNCATED_CODE,
} from "./streamErrors";

/**
 * The chat surface's empty, loading and error states. Same harness as
 * patterns.test.tsx: react-dom/client plus act, no testing-library.
 */

// React 19: silence act warnings for renders driven outside React's test renderer.
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
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("the new-conversation empty state", () => {
  it("is a designed surface: product line, disclosure and the example prompts", () => {
    render(<NewConversationState onPickPrompt={() => undefined} />);
    // Not a bare "New chat" fallback.
    expect(container!.querySelector("h2")?.textContent).toContain("What can I help you with?");
    // The AI disclosure is on the surface before a first message.
    expect(container!.textContent).toContain("AI");
    // Three to four example prompts, by design.
    const buttons = [...container!.querySelectorAll("button")];
    expect(buttons.length).toBe(EXAMPLE_PROMPTS.length);
    expect(EXAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(3);
    expect(EXAMPLE_PROMPTS.length).toBeLessThanOrEqual(4);
    for (const example of EXAMPLE_PROMPTS) {
      expect(container!.textContent).toContain(example.title);
    }
  });

  it("sends the clicked prompt in one click", () => {
    const onPickPrompt = vi.fn();
    const onSendPrompt = vi.fn();
    render(
      <NewConversationState onPickPrompt={onPickPrompt} onSendPrompt={onSendPrompt} />,
    );
    const first = container!.querySelector("button")!;
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // One click, not two: a new user who clicks a card gets an answer, not a
    // filled box and a second control to find.
    expect(onSendPrompt).toHaveBeenCalledExactlyOnceWith(EXAMPLE_PROMPTS[0].prompt);
    expect(onPickPrompt).not.toHaveBeenCalled();
  });

  it("still offers 'Edit first' for anyone who wants to see the prompt", () => {
    const onPickPrompt = vi.fn();
    const onSendPrompt = vi.fn();
    render(
      <NewConversationState onPickPrompt={onPickPrompt} onSendPrompt={onSendPrompt} />,
    );
    const edit = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Edit first"),
    )!;
    act(() => {
      edit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPickPrompt).toHaveBeenCalledExactlyOnceWith(EXAMPLE_PROMPTS[0].prompt);
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("falls back to filling the composer where there is no send handler", () => {
    // /dev/states mounts this with no thread behind it; the cards must still
    // be reviewable there.
    const onPickPrompt = vi.fn();
    render(<NewConversationState onPickPrompt={onPickPrompt} />);
    act(() => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPickPrompt).toHaveBeenCalledExactlyOnceWith(EXAMPLE_PROMPTS[0].prompt);
  });

  it("disables every card when sending would fail", () => {
    const onSendPrompt = vi.fn();
    render(
      <NewConversationState
        onPickPrompt={() => undefined}
        onSendPrompt={onSendPrompt}
        disabled
      />,
    );
    const buttons = [...container!.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    act(() => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Offline, the cards must not offer an action guaranteed to fail — but
    // they stay visible, because showing what is waiting is the point.
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(container!.textContent).toContain(EXAMPLE_PROMPTS[0].title);
  });

  it("says what MatterWave is, for a stranger from a shared link", () => {
    render(<NewConversationState onPickPrompt={() => undefined} />);
    expect(container!.textContent).toContain("MatterWave is a chat workspace");
    // Plain words: "the models this deployment serves" is how an operator
    // talks, not a person who arrived from a link.
    expect(container!.textContent).not.toMatch(/deployment/i);
  });

  it("links the help page, which is otherwise reachable only by a keystroke", () => {
    render(<NewConversationState onPickPrompt={() => undefined} />);
    const link = [...container!.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Help"),
    )!;
    expect(link.getAttribute("href")).toBe("/help");
  });
});

describe("the loading skeletons", () => {
  it("shape the transcript, announce as busy, and use no spinner", () => {
    render(<TranscriptSkeleton />);
    expect(container!.querySelector("[role='status']")).not.toBeNull();
    expect(container!.textContent).toContain("Loading conversation…");
    // Bars, not a spinner: two turns of user bubble plus three assistant lines.
    expect(container!.querySelectorAll("[data-slot='skeleton']").length).toBe(8);
  });

  it("shape the conversation list at the row count asked for", () => {
    render(<ConversationListSkeleton rows={4} />);
    expect(container!.querySelector("[role='status']")).not.toBeNull();
    expect(container!.textContent).toContain("Loading conversations…");
    expect(container!.querySelectorAll("[data-slot='skeleton']").length).toBe(4);
  });
});

describe("awaiting the first token", () => {
  it("says what is being waited on, politely announced", () => {
    render(<AwaitingFirstToken />);
    const live = container!.querySelector("[aria-live='polite']")!;
    expect(live).not.toBeNull();
    expect(live.textContent).toContain("Waiting for the model");
    // The reason a cold model looks like a hang is named for the user.
    expect(live.textContent).toContain("cold model");
  });

  it("escalates after 15 seconds and gives up after a minute", () => {
    vi.useFakeTimers();
    try {
      const onGiveUp = vi.fn();
      render(<AwaitingFirstToken onGiveUp={onGiveUp} />);
      expect(container!.textContent).toContain("cold model");
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(container!.textContent).toContain("longer than usual");
      expect(onGiveUp).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(45_000);
      });
      expect(onGiveUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an answer the person stopped", () => {
  it("is a quiet note with Continue, not the red cut-off alert", () => {
    const onContinue = vi.fn();
    render(<StoppedNote onContinue={onContinue} />);
    expect(container!.querySelector("[role='alert']")).toBeNull();
    expect(container!.textContent).toContain("Stopped");
    expect(container!.textContent).not.toMatch(/cut off/i);
    const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Continue")!;
    act(() => button.click());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("the answer announcer", () => {
  it("is always in the page and says when an answer has finished", () => {
    render(<PhaseAnnouncer phase="idle" failed={false} />);
    const region = () => container!.querySelector("[data-mw-announcer]")!;
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(region().textContent).toBe("");
    act(() => root!.render(<PhaseAnnouncer phase="awaiting-first-token" failed={false} />));
    expect(region().textContent).toContain("Waiting");
    act(() => root!.render(<PhaseAnnouncer phase="streaming" failed={false} />));
    act(() => root!.render(<PhaseAnnouncer phase="idle" failed={false} />));
    expect(region().textContent).toBe("Answer finished");
  });

  it("leaves a failure to the alert that reports it", () => {
    render(<PhaseAnnouncer phase="streaming" failed={false} />);
    act(() => root!.render(<PhaseAnnouncer phase="idle" failed />));
    expect(container!.querySelector("[data-mw-announcer]")!.textContent).toBe("");
  });
});

describe("the inline transcript error", () => {
  it("renders in the transcript as an alert with guidance and a retry", () => {
    const onRetry = vi.fn();
    render(<TranscriptError kind="gateway" onRetry={onRetry} />);
    const alert = container!.querySelector("[role='alert']")!;
    expect(alert).not.toBeNull();
    expect(alert.getAttribute("data-error-kind")).toBe("gateway");
    expect(alert.textContent).toContain(STREAM_ERROR_COPY.gateway.title);
    const retry = [...alert.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retry"),
    )!;
    act(() => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no retry where retrying cannot succeed", () => {
    render(<TranscriptError kind="budget" onRetry={() => undefined} />);
    const labels = [...container!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels.some((label) => label?.includes("Retry"))).toBe(false);
  });

  it("every kind has copy that answers what to do now, and never a raw body", () => {
    for (const kind of STREAM_ERROR_KINDS) {
      const copy = STREAM_ERROR_COPY[kind];
      expect(copy.title.length, kind).toBeGreaterThan(0);
      expect(copy.guidance.length, kind).toBeGreaterThan(40);
    }
    render(<TranscriptError kind="unknown" reference="trace 0000" />);
    // The component renders only what it was given; the detail string the
    // adapter saw never reaches it.
    expect(container!.textContent).not.toContain("Error:");
  });

  it("tells the four ways a stream can fail apart, each with its own honest copy", () => {
    const titles = STREAM_ERROR_KINDS.map((kind) => STREAM_ERROR_COPY[kind].title);
    expect(new Set(titles).size).toBe(titles.length);
    // Upstream unavailable: nothing was started.
    expect(STREAM_ERROR_COPY.gateway.guidance).toMatch(/no answer was started/i);
    // Cut mid-answer: what arrived is real but incomplete, and retry is right.
    expect(STREAM_ERROR_COPY.truncated.title).toMatch(/cut off/i);
    expect(STREAM_ERROR_COPY.truncated.guidance).toMatch(/kept above/i);
    expect(STREAM_ERROR_COPY.truncated.retryable).toBe(true);
    // Timed out: reached the gateway, then silence; worth a second try.
    expect(STREAM_ERROR_COPY.timeout.title).toMatch(/too long/i);
    expect(STREAM_ERROR_COPY.timeout.retryable).toBe(true);
    // Refused by screening: not a fault, and retrying unchanged cannot work.
    expect(STREAM_ERROR_COPY.moderation.retryable).toBe(false);
    // A refusal is retryable: the documented way through is a sentence of
    // context and a second attempt.
    expect(STREAM_ERROR_COPY.refusal.retryable).toBe(true);
    // Never reached: nothing was sent, so a retry is a first attempt.
    expect(STREAM_ERROR_COPY.network.guidance).toMatch(/nothing was sent/i);
  });

  it("offers a way out of a context overflow that needs no model decision", () => {
    render(<TranscriptError kind="context" onRetry={() => undefined} />);
    const link = container!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/apps/chat");
    expect(link.textContent).toContain("Start a new chat");
    // And no retry: the same message against the same window fails the same way.
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent?.includes("Retry"))).toBe(
      false,
    );
  });
});

describe("the two streaming phases", () => {
  it("are told apart by an attribute, not just by their wording", () => {
    render(
      <>
        <AwaitingFirstToken />
        <StreamingIndicator />
      </>,
    );
    expect(container!.querySelector("[data-mw-phase='awaiting-first-token']")?.textContent).toContain(
      "Waiting for the model",
    );
    expect(container!.querySelector("[data-mw-phase='streaming']")?.textContent).toContain(
      "Responding",
    );
  });
});

describe("classifyStreamError", () => {
  it("maps the failure modes streamErrors.ts names, and is honest when it cannot", () => {
    expect(classifyStreamError("Bad gateway", 502)).toBe("gateway");
    expect(classifyStreamError("upstream refused the connection")).toBe("gateway");
    expect(classifyStreamError("", 402)).toBe("budget");
    expect(classifyStreamError("monthly budget exceeded")).toBe("budget");
    // The exact detail the API's pre-check sends (matterwave/budget.py,
    // BUDGET_EXHAUSTED_DETAIL): a refused turn lands in the non-retryable state.
    expect(
      classifyStreamError(
        "Your organisation's monthly token budget is used up: the plan's included tokens and any overage its cap allows",
      ),
    ).toBe("budget");
    expect(STREAM_ERROR_COPY.budget.retryable).toBe(false);
    expect(classifyStreamError("context length exceeded for this model")).toBe("context");
    expect(classifyStreamError("token limit: context window is 8192")).toBe("context");
    expect(classifyStreamError("", 401)).toBe("session");
    expect(classifyStreamError("session expired")).toBe("session");
    expect(classifyStreamError("network error")).toBe("network");
    expect(classifyStreamError("Failed to fetch")).toBe("network");
    expect(classifyStreamError("something nobody anticipated")).toBe("unknown");
  });

  it("reads a timeout as a timeout even when the sentence also names the gateway", () => {
    // The API's own wording for an upstream read timeout (inference.py):
    // the gateway words in it must not outrank the timeout it describes.
    expect(
      classifyStreamError("Lost the connection to the model gateway: The read operation timed out"),
    ).toBe("timeout");
    expect(classifyStreamError("", 504)).toBe("timeout");
    expect(classifyStreamError("deadline exceeded")).toBe("timeout");
    // But a gateway failure with no timeout in it is still the gateway.
    expect(classifyStreamError("Lost the connection to the model gateway: connection reset")).toBe(
      "gateway",
    );
  });

  it("trusts the stream layer's truncation code, and reads the API's words for it", () => {
    expect(classifyStreamError("anything", undefined, TRUNCATED_CODE)).toBe("truncated");
    // A thrown read after the stream opened arrives with the browser's own
    // words and the code; the code wins over the "network" in the words.
    expect(classifyStreamError("network error", undefined, TRUNCATED_CODE)).toBe("truncated");
    expect(classifyStreamError("The connection dropped before the answer finished.")).toBe(
      "truncated",
    );
    expect(classifyStreamError("This generation ended before any output arrived.")).toBe(
      "truncated",
    );
  });

  it("prefers the status code over the text where both are present", () => {
    // A 402 body that mentions the gateway is still a budget refusal.
    expect(classifyStreamError("gateway said no", 402)).toBe("budget");
  });

  it("trusts a refusal frame's code above any prose", () => {
    // The code is the only signal a user's own message cannot spoof: a user
    // is free to type "monthly budget exceeded" and have a model echo it.
    expect(classifyStreamError("anything at all", undefined, "moderation")).toBe("moderation");
    expect(classifyStreamError("monthly budget exceeded", 402, "moderation")).toBe("moderation");
    expect(classifyStreamError("anything at all", undefined, "refusal")).toBe("refusal");
    // And a block is never retryable, so no button promises what cannot work.
    expect(STREAM_ERROR_COPY.moderation.retryable).toBe(false);
  });

  it("does not guess moderation from prose alone", () => {
    // Without the code there is no claim: a message that merely talks about
    // moderation is not a moderation refusal.
    expect(classifyStreamError("the moderation policy is interesting")).toBe("unknown");
  });
});

describe("the correlation id", () => {
  it("renders the id, selectable, so a screenshot leads to the trace", () => {
    render(<RequestReference requestId="req-abc-123" />);
    const code = container!.querySelector("[data-testid='request-id']")!;
    expect(code).not.toBeNull();
    expect(code.textContent).toBe("req-abc-123");
    expect(container!.textContent).toContain("Reference");
  });

  it("says there is no reference rather than rendering blank", () => {
    render(<RequestReference requestId={null} />);
    // An empty slot reads as an id that failed to load; "no reference" tells
    // the reader their screenshot will not be enough, which is worth knowing.
    expect(container!.querySelector("[data-testid='request-id']")).toBeNull();
    expect(container!.textContent).toContain("No reference");
  });

  it("appears inside the transcript error that carries it", () => {
    render(
      <TranscriptError kind="gateway" reference={<RequestReference requestId="req-xyz" />} />,
    );
    const alert = container!.querySelector("[role='alert']")!;
    expect(alert.textContent).toContain("req-xyz");
  });
});

describe("a MatterWave content refusal", () => {
  it("is not a technical error and offers no retry", () => {
    render(<TranscriptError kind="moderation" onRetry={() => undefined} />);
    const alert = container!.querySelector("[role='alert']")!;
    expect(alert.getAttribute("data-error-kind")).toBe("moderation");
    // Distinguished from a fault, so the user does not retry forever, and
    // distinguished from the model declining, which is a different fact.
    expect(alert.textContent).toContain("MatterWave would not send this");
    expect(alert.textContent).toMatch(/rephrase/i);
    expect([...alert.querySelectorAll("button")].some((b) => b.textContent?.includes("Retry"))).toBe(
      false,
    );
  });
});

describe("the offline banner", () => {
  it("says sending is paused and that the draft is kept", () => {
    render(<OfflineBanner />);
    const status = container!.querySelector("[role='status']")!;
    expect(status).not.toBeNull();
    expect(status.textContent).toContain("offline");
    expect(status.textContent).toContain("draft is kept");
    // Automatic reconnect: nothing to press.
    expect(container!.querySelector("button")).toBeNull();
  });
});

describe("a conversation that is not there", () => {
  it("reads a 404 load as missing, not as a failed stream", () => {
    expect(isMissingConversation(new ApiError(404, "Conversation not found"))).toBe(true);
    expect(isMissingConversation(new ApiError(500, "boom"))).toBe(false);
    expect(isMissingConversation(new Error("Failed to fetch"))).toBe(false);
  });

  it("says it was deleted or never existed, with no Retry that would loop", () => {
    render(<ConversationMissing />);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "This conversation is not available",
    );
    expect(container!.textContent).not.toContain(STREAM_ERROR_COPY.unknown.title);
    const buttons = [...container!.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).not.toContain("Retry");
    expect(container!.querySelector('a[href="/apps/chat"]')).not.toBeNull();
  });
});
