import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ApiError, currentToken } from "../../lib/api";
import { getAuthConfig } from "../../lib/auth";
import { isDesktop } from "../../lib/desktopAuth";
import { useKeyboardShortcuts } from "../../shell/useKeyboardShortcuts";
import {
  assembleTranscript,
  caretInsertion,
  dictationLanguage,
  failureMessage,
  failureOfMediaError,
  failureOfRecognitionError,
  markPrivacyNoticeSeen,
  pickEngine,
  privacyNotice,
  privacyNoticeSeen,
  recognitionConstructor,
  recordingFileName,
  recordingMimeType,
  spliceTranscript,
  type DictationEngine,
  type DictationFailure,
  type Insertion,
  type SpeechRecognitionLike,
  type Transcription,
} from "./speech";

/**
 * Dictation into the composer: the microphone button's state and the two
 * engines behind it (speech.ts says which this browser gets).
 *
 * The transcript is written into the draft at the caret and replaced in
 * place as the recognizer refines it, so the person watches their sentence
 * form where they would have typed it. Nothing is ever sent: the words are
 * text in the box, to be read, corrected and sent by the person -- a
 * misheard word in a message that went out on its own is unrecoverable.
 *
 * Esc stops it, from anywhere, the way Esc stops an answer. The global
 * `dictate` chord toggles it, so a keyboard user never has to find the
 * button.
 */

/** The server route's cap on one clip; the recorder stops itself there. */
export const MAX_RECORDING_MS = 60_000;

/** How long a server transcription may take before it is called failed. */
const TRANSCRIBE_TIMEOUT_MS = 45_000;

export type DictationState = "idle" | "listening" | "transcribing";

export interface UseDictation {
  /** Which engine this browser has; null means render no control at all. */
  readonly engine: DictationEngine | null;
  readonly state: DictationState;
  /** The last failure's message, until dismissed or the next start. */
  readonly failure: string | null;
  readonly dismissFailure: () => void;
  /** The one-time privacy note, until dismissed. */
  readonly privacy: string | null;
  readonly dismissPrivacy: () => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly toggle: () => void;
}

export interface DictationOptions {
  /** The composer's box, for the caret and for focus after a result. */
  readonly boxRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  /** Read only, offline, context full, a turn running: no new session starts. */
  readonly disabled: boolean;
  /** Overrides the document's language; the tests pass it. */
  readonly language?: string;
}

/**
 * The server route, posted the way the attachment upload posts: the same
 * cookie, the same CSRF header, the same bearer for the dev-token path.
 * `apiFetch` only takes JSON bodies, and a multipart body is what a
 * transcriber wants.
 */
export async function postTranscription(
  blob: Blob,
  fileName: string,
  language: string,
  signal?: AbortSignal,
): Promise<Transcription> {
  const body = new FormData();
  body.append("file", blob, fileName);
  body.append("language", language);
  const headers: Record<string, string> = {};
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const cookieName = getAuthConfig()?.csrf_cookie ?? "mw_csrf";
  const prefix = `${cookieName}=`;
  const entry = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  if (entry) headers["X-CSRF-Token"] = decodeURIComponent(entry.slice(prefix.length));
  const res = await fetch("/api/speech/transcribe", {
    method: "POST",
    headers,
    body,
    credentials: "include",
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch {
      // No body, or not JSON: the status is the message.
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as Transcription;
}

export function useDictation(options: DictationOptions): UseDictation {
  const [engine] = useState<DictationEngine | null>(() => pickEngine(globalThis, getAuthConfig()));
  const [state, setState] = useState<DictationState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<string | null>(null);

  const { boxRef, language: languageOverride, draft, onDraftChange, disabled } = options;

  // The latest draft and handler, read from inside recognizer callbacks
  // that were installed on an earlier render. Synced in an effect, the way
  // useKeyboardShortcuts keeps its handlers, so no render writes a ref.
  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    draftRef.current = draft;
    onDraftChangeRef.current = onDraftChange;
    disabledRef.current = disabled;
  });

  const recognizerRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insertionRef = useRef<Insertion | null>(null);
  const finalsRef = useRef<string[]>([]);
  // Where the caret goes once React has written the new draft into the box.
  const pendingCaretRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const caret = pendingCaretRef.current;
    const box = boxRef.current;
    if (caret === null || box === null) return;
    pendingCaretRef.current = null;
    if (box.value !== draft) return;
    try {
      box.setSelectionRange(caret, caret);
    } catch {
      // A detached or hidden box: the caret is cosmetic.
    }
  }, [draft, boxRef]);

  const fail = useCallback(
    (what: DictationFailure) => {
      // The desktop webview has no address bar, so a refused microphone is
      // fixed in the OS's privacy settings, not a browser toggle. (The
      // webview engines also ship no SpeechRecognition, so desktop dictation
      // is always the server engine -- the one that needs the microphone.)
      setFailure(failureMessage(what, engine ?? "browser", isDesktop()));
    },
    [engine],
  );

  /** Write `transcript` over the session's insertion; true when the cap was hit. */
  const write = useCallback((transcript: string): boolean => {
    const result = spliceTranscript(draftRef.current, insertionRef.current, transcript);
    insertionRef.current = result.insertion;
    pendingCaretRef.current = result.caret;
    if (result.draft !== draftRef.current) {
      draftRef.current = result.draft;
      onDraftChangeRef.current(result.draft);
    }
    return result.full;
  }, []);

  const releaseStream = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recognizer = recognizerRef.current;
    if (recognizer !== null) {
      recognizerRef.current = null;
      try {
        recognizer.stop();
      } catch {
        // Already stopped.
      }
      setState("idle");
      boxRef.current?.focus();
      return;
    }
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      // `onstop` posts the clip; the state moves to transcribing there.
      recorder.stop();
      return;
    }
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
      setState("idle");
    }
  }, [boxRef]);

  const startBrowser = useCallback(
    (language: string) => {
      const Ctor = recognitionConstructor();
      if (Ctor === null) {
        fail("unavailable");
        return;
      }
      const recognizer = new Ctor();
      recognizer.lang = language;
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.maxAlternatives = 1;
      finalsRef.current = [];
      recognizer.onresult = (event) => {
        if (recognizerRef.current !== recognizer) return;
        const finals: string[] = [];
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) finals.push(text);
          else interim += text;
        }
        finalsRef.current = finals;
        if (write(assembleTranscript(finals, interim))) {
          fail("too-long");
          stop();
        }
      };
      recognizer.onerror = (event) => {
        if (recognizerRef.current !== recognizer) return;
        recognizerRef.current = null;
        const what = failureOfRecognitionError(event.error);
        if (what !== null) fail(what);
        setState("idle");
      };
      recognizer.onend = () => {
        if (recognizerRef.current !== recognizer) return;
        recognizerRef.current = null;
        setState("idle");
        boxRef.current?.focus();
      };
      recognizerRef.current = recognizer;
      try {
        recognizer.start();
        setState("listening");
      } catch {
        recognizerRef.current = null;
        fail("unavailable");
      }
    },
    [fail, boxRef, stop, write],
  );

  const startServer = useCallback(
    async (language: string) => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        fail(failureOfMediaError(error instanceof DOMException ? error.name : ""));
        return;
      }
      if (disabledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = recordingMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        fail("unavailable");
        return;
      }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        releaseStream();
        fail("unavailable");
        setState("idle");
      };
      recorder.onstop = () => {
        releaseStream();
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) {
          fail("no-speech");
          setState("idle");
          return;
        }
        setState("transcribing");
        const controller = new AbortController();
        abortRef.current = controller;
        const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
        postTranscription(blob, recordingFileName(type), language, controller.signal)
          .then((answer) => {
            if (abortRef.current !== controller) return;
            const text = typeof answer.text === "string" ? answer.text.trim() : "";
            if (text === "") fail("no-speech");
            else if (write(text)) fail("too-long");
          })
          .catch((error: unknown) => {
            if (abortRef.current !== controller) return;
            if (error instanceof ApiError) fail(error.status === 413 ? "too-long" : "transcription-failed");
            else if (error instanceof DOMException && error.name === "AbortError") fail("network");
            else fail("network");
          })
          .finally(() => {
            clearTimeout(timer);
            if (abortRef.current === controller) abortRef.current = null;
            setState("idle");
            boxRef.current?.focus();
          });
      };
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start();
      setState("listening");
      recordingTimerRef.current = setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORDING_MS);
    },
    [fail, boxRef, releaseStream, write],
  );

  const start = useCallback(() => {
    if (engine === null || disabledRef.current || state !== "idle") return;
    setFailure(null);
    if (!privacyNoticeSeen()) setPrivacy(privacyNotice(engine));
    insertionRef.current = caretInsertion(boxRef.current, draftRef.current);
    const language = languageOverride ?? dictationLanguage();
    if (engine === "browser") startBrowser(language);
    else void startServer(language);
  }, [engine, state, boxRef, languageOverride, startBrowser, startServer]);

  const toggle = useCallback(() => {
    if (state === "idle") start();
    else stop();
  }, [state, start, stop]);

  // Esc stops, wherever focus is. Not through the global shortcut table: that
  // one skips a key something nearer already handled (the slash menu's Esc),
  // and a person who presses Esc while dictating means stop, whatever else
  // the key also closed.
  useEffect(() => {
    if (state === "idle") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [state, stop]);

  // The composer went read only, offline or full mid-sentence: stop, and
  // keep what was heard so far.
  useEffect(() => {
    if (disabled && state !== "idle") stop();
  }, [disabled, state, stop]);

  // Unmount: the microphone is never left open behind a page that is gone.
  useEffect(
    () => () => {
      recognizerRef.current?.abort();
      recognizerRef.current = null;
      if (recorderRef.current !== null && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      releaseStream();
      abortRef.current?.abort();
    },
    [releaseStream],
  );

  useKeyboardShortcuts({
    dictate: engine !== null && (state !== "idle" || !disabled) ? toggle : undefined,
  });

  const dismissPrivacy = useCallback(() => {
    markPrivacyNoticeSeen();
    setPrivacy(null);
  }, []);

  return {
    engine,
    state,
    failure,
    dismissFailure: useCallback(() => setFailure(null), []),
    privacy,
    dismissPrivacy,
    start,
    stop,
    toggle,
  };
}
