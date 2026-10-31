import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReadAloud, type UseReadAloud } from "./useReadAloud";
import type { SpeechSynthesisLike, SpeechSynthesisUtteranceLike } from "./tts";

/**
 * The read-aloud hook against a mocked synth: that the speaker button
 * wires the synth call, that one voice supersedes another, and that a new
 * generation (stopWhen) stops the narration.
 *
 * State is read through the probe's latest render (`live()`), not through a
 * captured hook object: the object a render returns carries that render's
 * state, and the calls below commit new ones.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeUtterance implements SpeechSynthesisUtteranceLike {
  text = "";
  lang = "";
  rate = 1;
  voice = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
}

/** A synth that records what it was asked to say, ending nothing on its own. */
function stubSynthesis(): {
  spoken: SpeechSynthesisUtteranceLike[];
  cancelCount: () => number;
} {
  const spoken: SpeechSynthesisUtteranceLike[] = [];
  let cancelled = 0;
  const synth: SpeechSynthesisLike = {
    speaking: false,
    paused: false,
    getVoices: () => [],
    speak: (utterance) => spoken.push(utterance),
    cancel: () => {
      cancelled += 1;
    },
    onvoiceschanged: null,
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return { spoken, cancelCount: () => cancelled };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let current: UseReadAloud | null = null;

function Probe(props: { stopWhen?: boolean }) {
  const hook = useReadAloud({ stopWhen: props.stopWhen });
  // Published from an effect, not render: the lint's purity rule is right,
  // and act() flushes effects, so `current` is always the latest render's.
  useEffect(() => {
    current = hook;
  });
  return null;
}

function render(stopWhen?: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe stopWhen={stopWhen} />);
  });
}

/** The hook as the probe's latest render returned it. */
function live(): UseReadAloud {
  if (!current) throw new Error("the probe is not mounted");
  return current;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  current = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useReadAloud", () => {
  it("offers nothing where the webview has no speechSynthesis", () => {
    render();
    expect(live().supported).toBe(false);
    act(() => {
      live().toggle("m1", "words");
    });
    expect(live().speakingId).toBeNull();
  });

  it("the button's toggle hands the reply to the synth, markdown spoken as prose", () => {
    const { spoken } = stubSynthesis();
    render();
    expect(live().supported).toBe(true);
    act(() => {
      live().toggle("m1", "**Hello** there. `code`");
    });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Hello there. code");
    expect(spoken[0].lang).not.toBe("");
    expect(live().speakingId).toBe("m1");
  });

  it("the same button again is the stop button", () => {
    const { spoken, cancelCount } = stubSynthesis();
    render();
    act(() => {
      live().toggle("m1", "words");
    });
    act(() => {
      live().toggle("m1", "words");
    });
    // Once inside speakText (before the second speak), once for the stop.
    expect(cancelCount()).toBe(2);
    expect(live().speakingId).toBeNull();
    expect(spoken).toHaveLength(1);
  });

  it("starting a second reply stops the first, and the second is the speaker", () => {
    const { spoken, cancelCount } = stubSynthesis();
    render();
    act(() => {
      live().toggle("m1", "first");
    });
    act(() => {
      live().toggle("m2", "second");
    });
    // Each speak clears whatever came before it.
    expect(cancelCount()).toBe(2);
    expect(spoken).toHaveLength(2);
    expect(spoken[1].text).toBe("second");
    expect(live().speakingId).toBe("m2");
  });

  it("the utterance finishing clears the state, but a superseding one is not cleared by it", () => {
    const { spoken } = stubSynthesis();
    render();
    act(() => {
      live().toggle("m1", "first");
    });
    const first = spoken[0];
    act(() => {
      live().toggle("m2", "second");
    });
    // The first utterance's end arrives late; it must not clear the second.
    act(() => {
      first.onend?.();
    });
    expect(live().speakingId).toBe("m2");
    act(() => {
      spoken[1].onend?.();
    });
    expect(live().speakingId).toBeNull();
  });

  it("a new generation (stopWhen) stops whatever was reading", () => {
    const { cancelCount } = stubSynthesis();
    render(false);
    act(() => {
      live().toggle("m1", "words");
    });
    expect(live().speakingId).toBe("m1");
    // The busy flag turns true with the new send.
    act(() => {
      root!.render(<Probe stopWhen />);
    });
    expect(cancelCount()).toBe(2);
    expect(live().speakingId).toBeNull();
  });

  it("nothing is spoken for a reply with nothing to say", () => {
    const { spoken } = stubSynthesis();
    render();
    act(() => {
      live().toggle("m1", "![only an image](https://example.com/x.png)");
    });
    expect(spoken).toHaveLength(0);
    expect(live().speakingId).toBeNull();
  });

  it("unmount cancels the voice, so nothing reads on behind the page", () => {
    const { cancelCount } = stubSynthesis();
    render();
    act(() => {
      live().toggle("m1", "words");
    });
    act(() => {
      root?.unmount();
    });
    // Once inside speakText, once on the way out.
    expect(cancelCount()).toBe(2);
  });
});
