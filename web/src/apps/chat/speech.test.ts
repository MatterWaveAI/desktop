import { describe, expect, it } from "vitest";
import {
  assembleTranscript,
  caretInsertion,
  dictationLanguage,
  failureMessage,
  failureOfMediaError,
  failureOfRecognitionError,
  MAX_MESSAGE_CHARS,
  markPrivacyNoticeSeen,
  pickEngine,
  privacyNoticeSeen,
  recognitionConstructor,
  recordingFileName,
  recordingMimeType,
  serverTranscriptionAdvertised,
  spliceTranscript,
} from "./speech";

class FakeRecognition {}

describe("which engine a browser gets", () => {
  it("the browser's recognizer under either spelling, before anything else", () => {
    expect(recognitionConstructor({})).toBeNull();
    expect(recognitionConstructor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(recognitionConstructor({ webkitSpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(
      pickEngine(
        { SpeechRecognition: FakeRecognition },
        { auth_mode: "none", csrf_cookie: "c", default_model: "m", speech_transcription: true },
      ),
    ).toBe("browser");
  });

  it("the server route only where the deployment advertises it AND the browser can record", () => {
    const recorder = {
      MediaRecorder: function MediaRecorder() {},
      navigator: { mediaDevices: { getUserMedia: () => undefined } },
    };
    const advertised = { auth_mode: "none" as const, csrf_cookie: "c", default_model: "m" };
    expect(pickEngine(recorder, { ...advertised, speech_transcription: true })).toBe("server");
    expect(pickEngine(recorder, advertised)).toBeNull();
    expect(pickEngine(recorder, null)).toBeNull();
    // Firefox with a transcriber but no microphone API in this context.
    expect(pickEngine({}, { ...advertised, speech_transcription: true })).toBeNull();
    expect(serverTranscriptionAdvertised(null)).toBe(false);
  });
});

describe("the language", () => {
  it("is the document's, then the browser's, then en-US", () => {
    expect(dictationLanguage({ documentElement: { lang: "de-DE" } }, { language: "fr" })).toBe(
      "de-DE",
    );
    expect(dictationLanguage({ documentElement: { lang: "  " } }, { language: "fr-CA" })).toBe(
      "fr-CA",
    );
    expect(dictationLanguage({ documentElement: { lang: "" } }, { language: "" })).toBe("en-US");
    expect(dictationLanguage(null, null)).toBe("en-US");
  });
});

describe("writing the transcript into the draft", () => {
  it("starts at the caret and replaces its own earlier text as the recognizer refines it", () => {
    const first = spliceTranscript("before  after", { start: 7, text: "" }, "hel");
    expect(first.draft).toBe("before hel after");
    const second = spliceTranscript(first.draft, first.insertion, "hello world");
    expect(second.draft).toBe("before hello world after");
    expect(second.caret).toBe("before hello world".length);
  });

  it("puts a space between typed text and the dictated words, and only when needed", () => {
    expect(spliceTranscript("well", null, "hello").draft).toBe("well hello");
    expect(spliceTranscript("well ", null, "hello").draft).toBe("well hello");
    expect(spliceTranscript("", null, "hello").draft).toBe("hello");
    expect(spliceTranscript("", null, "").draft).toBe("");
  });

  it("appends at the end when the person edited over the earlier insertion", () => {
    const first = spliceTranscript("x ", { start: 2, text: "" }, "one");
    // The person deleted the dictated word and typed something else there.
    const edited = "x typed";
    const next = spliceTranscript(edited, first.insertion, "one two");
    expect(next.draft).toBe("x typed one two");
  });

  it("replaces a selection, as typing over it would", () => {
    const box = { selectionStart: 4, selectionEnd: 9, value: "the quick fox" };
    const insertion = caretInsertion(box, box.value);
    expect(insertion).toEqual({ start: 4, text: "quick" });
    expect(spliceTranscript(box.value, insertion, "slow").draft).toBe("the slow fox");
  });

  it("goes to the end when the box and the draft disagree, or there is no box", () => {
    expect(caretInsertion(null, "abc")).toEqual({ start: 3, text: "" });
    expect(caretInsertion({ selectionStart: 1, selectionEnd: 2, value: "stale" }, "abc")).toEqual({
      start: 3,
      text: "",
    });
    expect(caretInsertion({ selectionStart: 9, selectionEnd: 9, value: "abc" }, "abc")).toEqual({
      start: 3,
      text: "",
    });
  });

  it("stops at the message cap and says so", () => {
    const nearly = "a".repeat(MAX_MESSAGE_CHARS - 3);
    const result = spliceTranscript(nearly, null, "bcdefg");
    expect(result.full).toBe(true);
    expect(result.draft).toHaveLength(MAX_MESSAGE_CHARS);
    expect(result.draft.endsWith(" bc")).toBe(true);
    expect(spliceTranscript("short", null, "words", 100).full).toBe(false);
  });

  it("joins finals and the interim tail with single spaces", () => {
    expect(assembleTranscript(["one ", " two"], " three")).toBe("one two three");
    expect(assembleTranscript([], "")).toBe("");
  });
});

describe("the failures", () => {
  it("each recognizer code has its own message; aborted has none", () => {
    expect(failureOfRecognitionError("not-allowed")).toBe("not-allowed");
    expect(failureOfRecognitionError("service-not-allowed")).toBe("not-allowed");
    expect(failureOfRecognitionError("audio-capture")).toBe("no-microphone");
    expect(failureOfRecognitionError("network")).toBe("network");
    expect(failureOfRecognitionError("no-speech")).toBe("no-speech");
    expect(failureOfRecognitionError("aborted")).toBeNull();
    expect(failureOfRecognitionError("something-new")).toBe("unavailable");
    expect(failureOfMediaError("NotAllowedError")).toBe("not-allowed");
    expect(failureOfMediaError("NotFoundError")).toBe("no-microphone");
    expect(failureOfMediaError("AbortError")).toBe("unavailable");
  });

  it("the messages name the remedy, and the network one names where the audio goes", () => {
    expect(failureMessage("not-allowed", "browser")).toMatch(/address bar/);
    expect(failureMessage("no-microphone", "browser")).toMatch(/No microphone/);
    expect(failureMessage("network", "browser")).toMatch(/browser sends the audio/);
    expect(failureMessage("network", "server")).not.toMatch(/browser sends/);
    expect(failureMessage("too-long", "browser")).toContain("100,000");
  });
});

describe("the privacy note", () => {
  it("is unseen until marked, and storage failures read as unseen", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(privacyNoticeSeen(storage)).toBe(false);
    markPrivacyNoticeSeen(storage);
    expect(privacyNoticeSeen(storage)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(privacyNoticeSeen(broken)).toBe(false);
    expect(() => markPrivacyNoticeSeen(broken)).not.toThrow();
  });
});

describe("the recording container", () => {
  it("is the first the browser supports, and the file is named for it", () => {
    expect(recordingMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(recordingMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(recordingMimeType(() => false)).toBeUndefined();
    expect(recordingFileName("audio/mp4")).toBe("dictation.m4a");
    expect(recordingFileName("audio/webm;codecs=opus")).toBe("dictation.webm");
    expect(recordingFileName(undefined)).toBe("dictation.webm");
  });
});
