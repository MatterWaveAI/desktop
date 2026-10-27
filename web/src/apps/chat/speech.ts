/**
 * Dictation, the pure half: which engine a browser has, which language to
 * listen in, how a transcript lands in the draft, and what each failure is
 * called. The hook (useDictation) owns the recognizer and the state; this
 * file owns nothing and is what the unit tests exercise.
 *
 * Two engines. The browser's SpeechRecognition is the first choice where it
 * exists (Chromium, Safari): it streams interim words while the person is
 * still speaking, which is what makes dictation feel live. Where it does not
 * (Firefox), the deployment may advertise a transcriber of its own
 * (`speech_transcription` on /api/auth-config): the microphone is recorded
 * with MediaRecorder and the clip posted to `/api/speech/transcribe` when
 * the person stops. Neither present: no control at all. A greyed-out button
 * for a feature this browser cannot have is a question with no answer.
 */

import type { AuthConfig } from "../../types";

/**
 * The constructor lib.dom leaves out: TypeScript ships the result types but
 * not the recognizer, because only the WebKit-prefixed name has ever been
 * stable. Declared here, minimal, as the shape the hook uses.
 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly length: number;
    [index: number]: { readonly transcript: string };
  }>;
}

export interface SpeechRecognitionErrorLike {
  readonly error: string;
  readonly message?: string;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  MediaRecorder?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
};

/** The browser's recognizer, under either spelling, or null where there is none. */
export function recognitionConstructor(win: unknown = globalThis): SpeechRecognitionCtor | null {
  const w = win as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Can this browser record the microphone for the server route? */
export function canRecord(win: unknown = globalThis): boolean {
  const w = win as SpeechWindow;
  return (
    typeof w.MediaRecorder === "function" &&
    typeof w.navigator?.mediaDevices?.getUserMedia === "function"
  );
}

/** Did the deployment say it transcribes audio itself? Absent reads as no. */
export function serverTranscriptionAdvertised(config: AuthConfig | null): boolean {
  return config?.speech_transcription === true;
}

export type DictationEngine = "browser" | "server";

/**
 * Which engine this browser gets, in order of preference. The browser's own
 * recognizer wins where it exists: it is live, and it costs the deployment
 * nothing. The server route is for the browsers without one.
 */
export function pickEngine(
  win: unknown = globalThis,
  config: AuthConfig | null = null,
): DictationEngine | null {
  if (recognitionConstructor(win) !== null) return "browser";
  if (serverTranscriptionAdvertised(config) && canRecord(win)) return "server";
  return null;
}

/**
 * The language to listen in: the document's, which the app sets, then the
 * browser's. A BCP 47 tag either way, which is what the recognizer wants.
 */
export function dictationLanguage(
  doc: { documentElement?: { lang?: string } } | null = typeof document === "undefined"
    ? null
    : document,
  nav: { language?: string } | null = typeof navigator === "undefined" ? null : navigator,
): string {
  const fromDocument = doc?.documentElement?.lang?.trim();
  if (fromDocument) return fromDocument;
  const fromBrowser = nav?.language?.trim();
  return fromBrowser || "en-US";
}

/**
 * The API's cap on one message (`SendMessage.content`, `max_length=100_000`),
 * mirrored so dictation stops at the line the send would be refused on.
 */
export const MAX_MESSAGE_CHARS = 100_000;

/** Where the dictated text sits in the draft, so the next result can replace it. */
export interface Insertion {
  /** The offset the transcript starts at. */
  readonly start: number;
  /** What was written there last; replaced by the next, longer transcript. */
  readonly text: string;
}

/**
 * Put `transcript` into `draft` in place of what the last result wrote.
 *
 * The recognizer sends the same utterance over and over, longer each time,
 * then once more marked final; each arrival replaces the previous one rather
 * than adding to it. If the draft no longer holds the previous text where it
 * was -- the person edited around it mid-sentence -- the new text goes at
 * the end instead of overwriting whatever they typed there. A space is put
 * before the transcript when the character before it is not already one, so
 * "hello" dictated after "well" reads "well hello" and not "wellhello".
 *
 * Truncated at `max` so dictating past the message cap cannot build a draft
 * the API would refuse; the caller sees `full` and stops listening.
 */
export function spliceTranscript(
  draft: string,
  previous: Insertion | null,
  transcript: string,
  max: number = MAX_MESSAGE_CHARS,
): { draft: string; insertion: Insertion; caret: number; full: boolean } {
  let start: number;
  let before: string;
  let after: string;
  if (
    previous !== null &&
    draft.slice(previous.start, previous.start + previous.text.length) === previous.text
  ) {
    start = previous.start;
    before = draft.slice(0, start);
    after = draft.slice(start + previous.text.length);
  } else {
    start = draft.length;
    before = draft;
    after = "";
  }
  const needsSpace = before.length > 0 && !/\s$/.test(before) && transcript.length > 0;
  let text = (needsSpace ? " " : "") + transcript;
  const room = Math.max(0, max - before.length - after.length);
  const full = text.length > room;
  if (full) text = text.slice(0, room);
  return {
    draft: before + text + after,
    insertion: { start, text },
    caret: start + text.length,
    full,
  };
}

/** Where the caret is, for the insertion a session starts with. */
export function caretInsertion(
  box: { selectionStart: number; selectionEnd: number; value: string } | null,
  draft: string,
): Insertion {
  if (box === null || box.selectionStart !== box.selectionEnd) {
    // A selection is replaced, as typing over it would: the selected text is
    // "what was written there last".
    if (box !== null && box.value === draft) {
      return { start: box.selectionStart, text: draft.slice(box.selectionStart, box.selectionEnd) };
    }
    return { start: draft.length, text: "" };
  }
  return { start: Math.min(box.selectionStart, draft.length), text: "" };
}

/**
 * The join of a session's final results so far plus the interim tail, as the
 * one string the splice writes. Finals are separated by a space; the
 * recognizer trims its own.
 */
export function assembleTranscript(finals: readonly string[], interim: string): string {
  return [...finals, interim]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

export type DictationFailure =
  | "not-allowed"
  | "no-microphone"
  | "network"
  | "no-speech"
  | "aborted"
  | "unavailable"
  | "too-long"
  | "transcription-failed";

/**
 * The recognizer's error codes, each to its own message. "Could not
 * dictate" would be true of all of them and useful for none: a denied
 * permission is fixed in the address bar, a missing microphone by plugging
 * one in, a network error by waiting, and the person needs to know which.
 */
export function failureOfRecognitionError(code: string): DictationFailure | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "audio-capture":
      return "no-microphone";
    case "network":
      return "network";
    case "no-speech":
      return "no-speech";
    case "aborted":
      // The person stopped it, or the page did. Nothing to say.
      return null;
    case "language-not-supported":
    case "bad-grammar":
      return "unavailable";
    default:
      return "unavailable";
  }
}

/** The getUserMedia failures, by the DOMException name the browser gives them. */
export function failureOfMediaError(name: string): DictationFailure {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "not-allowed";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-microphone";
    default:
      return "unavailable";
  }
}

export function failureMessage(failure: DictationFailure, engine: DictationEngine): string {
  switch (failure) {
    case "not-allowed":
      return "Microphone access was refused. Allow the microphone for this site in your browser's address bar, then try again.";
    case "no-microphone":
      return "No microphone was found. Plug one in or pick one in your system settings, then try again.";
    case "network":
      return engine === "browser"
        ? "Dictation needs a network connection: the browser sends the audio to its speech service. Check the connection and try again."
        : "The transcription request did not get through. Check the connection and try again.";
    case "no-speech":
      return "Nothing was heard. Check the microphone is picking you up, then try again.";
    case "aborted":
      return "Dictation stopped.";
    case "too-long":
      return `The message is at its ${MAX_MESSAGE_CHARS.toLocaleString()}-character limit, so dictation stopped. Send it or shorten it to add more.`;
    case "transcription-failed":
      return "The recording could not be transcribed. Try again, or type the message.";
    case "unavailable":
      return "Dictation is not available in this browser right now. You can still type the message.";
  }
}

/**
 * The one-time privacy note, by engine. The browser's recognizer is not
 * local: Chrome and Safari send the audio to their vendor's speech service,
 * which a person would not guess from a microphone button in our composer.
 * The server route keeps the audio with the deployment, and says so.
 */
export function privacyNotice(engine: DictationEngine): string {
  return engine === "browser"
    ? "Dictation uses your browser's speech recognition, which may send the audio to the browser vendor (Google for Chrome, Apple for Safari) to be transcribed. Nothing is recorded or kept by MatterWave; the words land here as text for you to review before sending."
    : "Dictation records your microphone and sends the clip to this deployment's transcription service, which returns text and keeps no copy of the audio. Review the words here before sending.";
}

export const PRIVACY_NOTICE_KEY = "mw.dictation.privacy-seen";

/** Has the privacy note been dismissed on this device? Storage failures read as "not yet". */
export function privacyNoticeSeen(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(PRIVACY_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPrivacyNoticeSeen(storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(PRIVACY_NOTICE_KEY, "1");
  } catch {
    // Private mode or storage blocked: the note shows again next time, which
    // is the safe failure.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What the server route answers. */
export interface Transcription {
  readonly text: string;
}

/**
 * The recorder's container, whichever the browser can produce. Chromium and
 * Firefox record WebM/Opus; Safari records MP4/AAC and knows no WebM. Asking
 * for one it cannot make throws, so the first supported one wins.
 */
export function recordingMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string | undefined {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (isSupported(type)) return type;
  }
  return undefined;
}

/** The file name the clip is posted under, from its container. */
export function recordingFileName(mimeType: string | undefined): string {
  if (!mimeType) return "dictation.webm";
  if (mimeType.startsWith("audio/mp4")) return "dictation.m4a";
  if (mimeType.startsWith("audio/ogg")) return "dictation.ogg";
  if (mimeType.startsWith("audio/wav")) return "dictation.wav";
  return "dictation.webm";
}
