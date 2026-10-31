/**
 * Read-aloud, the pure half: what a speechSynthesis looks like, the text of
 * a reply as something worth saying, and the voice/rate preferences. The
 * hook (useReadAloud) owns the synth and the speaking state; this file owns
 * nothing and is what the unit tests exercise.
 *
 * Client-side only, per the ticket: the words go to the webview's OS
 * voices (WebView2 and WKWebView both ship one) and never over the network,
 * which is the difference between this and a platform TTS route.
 */

/** The utterance interface TypeScript's lib.dom leaves loose enough to fake. */
export interface SpeechSynthesisUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: SpeechSynthesisVoiceLike | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SpeechSynthesisVoiceLike {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly default: boolean;
  readonly localService: boolean;
}

export interface SpeechSynthesisLike {
  readonly speaking: boolean;
  readonly paused: boolean;
  getVoices(): SpeechSynthesisVoiceLike[];
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
  onvoiceschanged: (() => void) | null;
}

type UtteranceCtor = new () => SpeechSynthesisUtteranceLike;

type SpeechWindow = {
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: UtteranceCtor;
};

/** The browser's synth, or null where there is none. */
export function synthesisOf(win: unknown = globalThis): SpeechSynthesisLike | null {
  const w = win as SpeechWindow;
  return w.speechSynthesis ?? null;
}

/** The utterance constructor, which some engines ship only beside the synth. */
export function utteranceCtorOf(win: unknown = globalThis): UtteranceCtor | null {
  const w = win as SpeechWindow;
  return w.SpeechSynthesisUtterance ?? null;
}

/** Can this browser read a reply aloud at all? */
export function canSpeak(win: unknown = globalThis): boolean {
  return synthesisOf(win) !== null && utteranceCtorOf(win) !== null;
}

/**
 * Markdown as something worth saying: the words, without the furniture.
 * Code keeps its contents (a person asked for the reply out loud, and a
 * silent gap where the code was would be worse) but loses the fences and
 * the language tag; links keep their words and lose their URLs; images
 * drop entirely, because a URL read aloud is noise.
 */
export function speechText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => code.trim());
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // A table's separator row, and a horizontal rule, are pure punctuation.
  text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)([^\s*_][^*_]*?)\1/g, "$2");
  text = text.replace(/\|/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Hand one reply to the synth: the previous utterance is cancelled first
 * (two overlapping speakers is never what anybody wanted), the end and
 * error callbacks collapse into one `onEnd`, and the utterance comes back
 * so a caller can hold it. A zero-length text speaks nothing -- some
 * engines treat the empty utterance as an error, so the caller is filtered
 * it before here.
 */
export function speakText(
  synth: SpeechSynthesisLike,
  utteranceCtor: UtteranceCtor,
  text: string,
  options: {
    lang: string;
    rate: number;
    voice?: SpeechSynthesisVoiceLike | null;
    onEnd?: () => void;
  },
): SpeechSynthesisUtteranceLike {
  synth.cancel();
  const utterance = new utteranceCtor();
  utterance.text = text;
  utterance.lang = options.lang;
  utterance.rate = options.rate;
  if (options.voice) utterance.voice = options.voice;
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = () => options.onEnd?.();
  synth.speak(utterance);
  return utterance;
}

/** The read-aloud preferences, on this device like the theme. */
export interface ReadAloudSettings {
  /** The chosen voice's URI, or null to let the synth pick per language. */
  voiceURI: string | null;
  /** Words per the normal pace; 1 is the voice's own default. */
  rate: number;
}

export const READ_ALOUD_KEY = "mw.read-aloud";
export const DEFAULT_RATE = 1;
/** The Web Speech API's own bounds on rate. */
export const MIN_RATE = 0.1;
export const MAX_RATE = 10;
/** The choices the settings pane offers; 1 among them, nothing exotic. */
export const RATE_CHOICES: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

export const DEFAULT_READ_ALOUD: ReadAloudSettings = { voiceURI: null, rate: DEFAULT_RATE };

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A rate from storage (or a form field) that an engine will accept. */
export function clampRate(rate: unknown): number {
  const value = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(value)) return DEFAULT_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, value));
}

/** The stored settings, or the defaults; anything unreadable reads as unset. */
export function loadReadAloudSettings(storage: Pick<Storage, "getItem"> | null = safeStorage()): ReadAloudSettings {
  try {
    const raw = storage?.getItem(READ_ALOUD_KEY);
    if (!raw) return DEFAULT_READ_ALOUD;
    const parsed = JSON.parse(raw) as { voiceURI?: unknown; rate?: unknown };
    return {
      voiceURI: typeof parsed.voiceURI === "string" && parsed.voiceURI ? parsed.voiceURI : null,
      rate: clampRate(parsed.rate),
    };
  } catch {
    return DEFAULT_READ_ALOUD;
  }
}

/** Store the settings; a failure (private mode) keeps them for this page. */
export function saveReadAloudSettings(
  settings: ReadAloudSettings,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(
      READ_ALOUD_KEY,
      JSON.stringify({ voiceURI: settings.voiceURI, rate: clampRate(settings.rate) }),
    );
  } catch {
    // Private mode or storage blocked: the choice stands until the page closes.
  }
}

/**
 * The voice to ask for, in order: the one the person chose, then one that
 * speaks the reply's language exactly, then one for its language family
 * (a `de-DE` reply may be read by `de-AT`), then the synth's own default.
 * Null means "the engine decides", which is also the answer when the list
 * has not loaded yet -- Chromium fills it a moment after launch.
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoiceLike[],
  settings: ReadAloudSettings,
  language: string,
): SpeechSynthesisVoiceLike | null {
  if (voices.length === 0) return null;
  const chosen = settings.voiceURI
    ? voices.find((voice) => voice.voiceURI === settings.voiceURI)
    : undefined;
  if (chosen) return chosen;
  const normalize = (lang: string) => lang.trim().replace("_", "-").toLowerCase();
  const wanted = normalize(language);
  const exact = voices.filter((voice) => normalize(voice.lang) === wanted);
  if (exact.length > 0) return exact.find((voice) => voice.default) ?? exact[0];
  const family = wanted.split("-")[0];
  const loose = voices.filter((voice) => normalize(voice.lang).split("-")[0] === family);
  if (loose.length > 0) return loose.find((voice) => voice.default) ?? loose[0];
  return null;
}
