import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationButton, DictationNotices } from "./DictationButton";
import { PRIVACY_NOTICE_KEY, type SpeechRecognitionEventLike } from "./speech";
import { useDictation } from "./useDictation";

/**
 * The composer's dictation in miniature: a textarea, the hook, the button
 * and the notices, with a scripted SpeechRecognition on the window. What is
 * asserted is what the person sees -- the words landing in the box as they
 * are refined, the button's pressed state, the spoken status, each failure's
 * sentence -- not the recognizer's calls.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The scripted recognizer: the test drives its events by hand. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static failStart = false;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = false;
  stopped = false;
  aborted = false;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.failStart) throw new Error("already started");
    this.started = true;
  }
  stop() {
    this.stopped = true;
    // Chrome fires `end` after `stop`; so does this.
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  /** One `result` event carrying these alternatives, finals first. */
  emit(finals: string[], interim = "") {
    const results = [
      ...finals.map((text) => ({ isFinal: true, length: 1, 0: { transcript: text } })),
      ...(interim ? [{ isFinal: false, length: 1, 0: { transcript: interim } }] : []),
    ];
    this.onresult?.({ resultIndex: 0, results });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
}

const w = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness(props: { initial?: string; disabled?: boolean; disabledHint?: string }) {
  const [draft, setDraft] = useState(props.initial ?? "");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    boxRef,
    draft,
    onDraftChange: setDraft,
    disabled: props.disabled ?? false,
    language: "en-GB",
  });
  return (
    <div>
      <DictationNotices dictation={dictation} />
      <DictationButton
        dictation={dictation}
        disabled={props.disabled ?? false}
        disabledHint={props.disabledHint}
      />
      <textarea ref={boxRef} value={draft} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

function mount(props: { initial?: string; disabled?: boolean; disabledHint?: string } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness {...props} />));
}

const button = () => container!.querySelector<HTMLButtonElement>("[data-mw-dictate-button]");
const status = () => container!.querySelector("[data-mw-dictation-status]")?.textContent ?? "";
const failure = () => container!.querySelector("[data-mw-dictation-failure]")?.textContent ?? null;
const privacy = () => container!.querySelector("[data-mw-dictation-privacy]");
const box = () => container!.querySelector("textarea")!;
/** The draft as the person sees it: the controlled box's value. */
const latestDraft = () => box().value;
const recognizer = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.failStart = false;
  w.SpeechRecognition = FakeRecognition;
  localStorage.setItem(PRIVACY_NOTICE_KEY, "1");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("where the browser cannot hear", () => {
  it("renders no control at all, rather than a disabled one", () => {
    delete w.SpeechRecognition;
    mount();
    expect(button()).toBeNull();
    expect(container!.querySelector("[data-mw-dictation-status]")).toBeNull();
  });
});

describe("dictating with the browser's recognizer", () => {
  it("listens in the given language, writes the words as they are refined, and announces itself", () => {
    mount({ initial: "Hello" });
    // A browser leaves the caret at the end of a value it was given; jsdom
    // leaves it at 0, so the test puts it where the browser would.
    box().setSelectionRange(5, 5);
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    expect(status()).toBe("");

    act(() => button()!.click());
    const r = recognizer();
    expect(r.started).toBe(true);
    expect(r.lang).toBe("en-GB");
    expect(r.interimResults).toBe(true);
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    expect(button()!.getAttribute("aria-label")).toBe("Stop dictating");
    expect(status()).toBe("Listening…");
    expect(container!.querySelector("[data-mw-dictation-indicator]")).not.toBeNull();

    act(() => r.emit([], "wor"));
    expect(latestDraft()).toBe("Hello wor");
    act(() => r.emit([], "world and"));
    expect(latestDraft()).toBe("Hello world and");
    act(() => r.emit(["world and"], "more"));
    expect(latestDraft()).toBe("Hello world and more");
    act(() => r.emit(["world and", "more"]));
    expect(latestDraft()).toBe("Hello world and more");
    // The caret sits after the dictated words, ready for the next ones.
    expect(box().selectionStart).toBe("Hello world and more".length);

    act(() => button()!.click());
    expect(r.stopped).toBe(true);
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    expect(status()).toBe("");
    // The words stay: dictation only ever writes into the box, never sends.
    expect(latestDraft()).toBe("Hello world and more");
  });

  it("inserts at the caret, not at the end", () => {
    mount({ initial: "one three" });
    box().setSelectionRange(3, 3);
    act(() => button()!.click());
    act(() => recognizer().emit(["two"]));
    expect(latestDraft()).toBe("one two three");
  });

  it("Esc stops it from anywhere", () => {
    mount();
    act(() => button()!.click());
    expect(status()).toBe("Listening…");
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(recognizer().stopped).toBe(true);
    expect(status()).toBe("");
  });

  it("the shortcut toggles it", () => {
    mount();
    const press = () =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "M",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    press();
    expect(status()).toBe("Listening…");
    press();
    expect(status()).toBe("");
    expect(recognizer().stopped).toBe(true);
  });

  it("the recognizer ending on its own (silence) returns the button to rest", () => {
    mount();
    act(() => button()!.click());
    act(() => recognizer().onend?.());
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    expect(failure()).toBeNull();
  });
});

describe("the failures, each by name", () => {
  it.each([
    ["not-allowed", /Microphone access was refused/],
    ["audio-capture", /No microphone was found/],
    ["network", /network connection/],
    ["no-speech", /Nothing was heard/],
  ])("%s", (code, message) => {
    mount();
    act(() => button()!.click());
    act(() => recognizer().fail(code));
    expect(failure()).toMatch(message);
    expect(status()).toBe("");
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    // Dismissible, and the next start clears it on its own.
    act(() => container!.querySelector<HTMLButtonElement>("[data-mw-dictation-failure] button")!.click());
    expect(failure()).toBeNull();
  });

  it("aborted says nothing: the person stopped it", () => {
    mount();
    act(() => button()!.click());
    act(() => recognizer().fail("aborted"));
    expect(failure()).toBeNull();
  });

  it("a recognizer that will not start is reported, not thrown", () => {
    FakeRecognition.failStart = true;
    mount();
    act(() => button()!.click());
    expect(failure()).toMatch(/not available in this browser/);
    expect(status()).toBe("");
  });

  it("stops at the message cap and says why", () => {
    mount({ initial: "a".repeat(99_995) });
    act(() => button()!.click());
    act(() => recognizer().emit([], "far too many words"));
    expect(latestDraft()).toHaveLength(100_000);
    expect(failure()).toMatch(/100,000-character limit/);
    expect(recognizer().stopped).toBe(true);
  });
});

describe("the gates", () => {
  it("a disabled composer keeps the button, says why, and will not start", () => {
    mount({ disabled: true, disabledHint: "You are offline" });
    expect(button()!.disabled).toBe(true);
    expect(button()!.title).toBe("You are offline");
    act(() => button()!.click());
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("going disabled mid-sentence stops the microphone and keeps the words", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    act(() => button()!.click());
    act(() => recognizer().emit(["kept"]));
    act(() => root!.render(<Harness disabled disabledHint="You are offline" />));
    expect(recognizer().stopped).toBe(true);
    expect(latestDraft()).toBe("kept");
  });
});

describe("the privacy note", () => {
  it("shows on the first start, and never again once dismissed", () => {
    localStorage.removeItem(PRIVACY_NOTICE_KEY);
    mount();
    expect(privacy()).toBeNull();
    act(() => button()!.click());
    expect(privacy()!.textContent).toMatch(/browser vendor/);
    act(() => button()!.click());
    // Still there until dismissed, across a stop and a start.
    act(() => button()!.click());
    expect(privacy()).not.toBeNull();
    act(() => privacy()!.querySelector("button")!.click());
    expect(privacy()).toBeNull();
    expect(localStorage.getItem(PRIVACY_NOTICE_KEY)).toBe("1");
    act(() => button()!.click());
    act(() => button()!.click());
    expect(privacy()).toBeNull();
  });
});

describe("the server route, where the browser has no recognizer", () => {
  class FakeRecorder {
    static instances: FakeRecorder[] = [];
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state: "inactive" | "recording" = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(
      public stream: MediaStream,
      options?: { mimeType?: string },
    ) {
      this.mimeType = options?.mimeType ?? "";
      FakeRecorder.instances.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const tracks = [{ stop: vi.fn() }];

  beforeEach(() => {
    delete w.SpeechRecognition;
    FakeRecorder.instances = [];
    tracks[0].stop.mockReset();
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) },
    });
    // The deployment advertises its transcriber.
    vi.stubGlobal("__mwAuthConfig", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it("records, posts the clip with its language, and writes the answer", async () => {
    const auth = await import("../../lib/auth");
    vi.spyOn(auth, "getAuthConfig").mockReturnValue({
      auth_mode: "none",
      csrf_cookie: "mw_csrf",
      default_model: "m",
      speech_transcription: true,
    });
    document.cookie = "mw_csrf=tok";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      expect(body.get("language")).toBe("en-GB");
      expect((body.get("file") as File).name).toBe("dictation.webm");
      expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
      return new Response(JSON.stringify({ text: " from the server " }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    mount({ initial: "typed" });
    box().setSelectionRange(5, 5);
    expect(button()).not.toBeNull();
    await act(async () => {
      button()!.click();
    });
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(status()).toBe("Listening…");
    await act(async () => {
      button()!.click();
    });
    expect(tracks[0].stop).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/speech/transcribe", expect.anything());
    expect(latestDraft()).toBe("typed from the server");
    expect(status()).toBe("");
  });

  it("a refused microphone and a failed transcription each get their own sentence", async () => {
    const auth = await import("../../lib/auth");
    vi.spyOn(auth, "getAuthConfig").mockReturnValue({
      auth_mode: "none",
      csrf_cookie: "mw_csrf",
      default_model: "m",
      speech_transcription: true,
    });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    mount();
    await act(async () => {
      button()!.click();
    });
    expect(failure()).toMatch(/Microphone access was refused/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "upstream down" }), { status: 502 })),
    );
    await act(async () => {
      button()!.click();
    });
    await act(async () => {
      button()!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(failure()).toMatch(/could not be transcribed/);
    expect(latestDraft()).toBe("");
  });
});
