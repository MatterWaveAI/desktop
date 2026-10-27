/**
 * The keyboard shortcuts, as data: what each one is called, which keys fire
 * it, and how to spell those keys on the platform in front of the user.
 *
 * Data rather than a switch in a handler so the help overlay and the help
 * page list exactly what the listener dispatches -- a shortcut added here
 * appears in both without anyone remembering to document it.
 */

export type ShortcutId =
  | "send"
  | "stop"
  | "new-chat"
  | "focus-composer"
  | "toggle-sidebar"
  | "help"
  | "command-palette"
  | "copy-last-reply"
  | "copy-last-code"
  | "edit-last"
  | "delete-chat"
  | "search-chats"
  | "dictate";

/**
 * One key combination. `mod` is the platform's command modifier: the
 * Command key on a Mac, Control everywhere else, which is the one spelling
 * difference a user notices.
 */
export interface Chord {
  readonly key: string;
  /**
   * The physical key, for a chord whose `key` changes under Shift: Shift+;
   * arrives as `:` on a US layout, and the chord still means the semicolon
   * key. Either the key or the code matching is enough.
   */
  readonly code?: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
}

export interface Shortcut {
  readonly id: ShortcutId;
  readonly label: string;
  /** One line under the label in the overlay, where a reader needs it. */
  readonly hint?: string;
  readonly chords: readonly Chord[];
  /**
   * Handled by the control that owns it (the composer's Enter), so the
   * global listener never dispatches it. Listed, because it is still a
   * shortcut the user wants to know about.
   */
  readonly local?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "send",
    label: "Send the message",
    hint: "Shift+Enter adds a line instead.",
    chords: [{ key: "Enter" }],
    local: true,
  },
  {
    id: "stop",
    label: "Stop the answer",
    hint: "While one is being written. A dialog that is open keeps Esc for itself.",
    chords: [{ key: "Escape" }],
  },
  {
    id: "new-chat",
    label: "Start a new chat",
    chords: [{ key: "o", mod: true, shift: true }],
  },
  {
    id: "focus-composer",
    label: "Jump to the message box",
    chords: [{ key: "Escape", shift: true }],
  },
  {
    id: "toggle-sidebar",
    label: "Show or hide the sidebar",
    chords: [{ key: "s", mod: true, shift: true }],
  },
  {
    id: "help",
    label: "Keyboard shortcuts and help",
    chords: [{ key: "/", mod: true }, { key: "?" }],
  },
  {
    id: "command-palette",
    label: "Open the command palette",
    hint: "New chat, switch conversation, settings, help, search.",
    chords: [{ key: "k", mod: true }],
  },
  {
    id: "copy-last-reply",
    label: "Copy the last reply",
    chords: [{ key: "c", mod: true, shift: true }],
  },
  {
    id: "copy-last-code",
    label: "Copy the last code block",
    chords: [{ key: ";", code: "Semicolon", mod: true, shift: true }],
  },
  {
    id: "edit-last",
    label: "Edit your last message",
    hint: "From an empty message box.",
    chords: [{ key: "ArrowUp" }],
    local: true,
  },
  {
    id: "delete-chat",
    label: "Delete this conversation",
    hint: "Asks first.",
    chords: [{ key: "Backspace", mod: true, shift: true }],
  },
  {
    id: "search-chats",
    label: "Search conversations",
    chords: [{ key: "f", mod: true, shift: true }],
  },
  {
    id: "dictate",
    label: "Start or stop dictating",
    hint: "Where the browser can hear you. Esc also stops it.",
    chords: [{ key: "m", mod: true, shift: true }],
  },
];

/** The palette's chord, for the surfaces that spell it out (the account menu). */
export const PALETTE_CHORD: Chord = SHORTCUTS.find((s) => s.id === "command-palette")!.chords[0];

/**
 * Is this a Mac, for the purpose of which key `mod` means?
 *
 * `userAgentData.platform` where the browser has it, `navigator.platform`
 * otherwise; iOS counts because an iPad with a keyboard uses Command too.
 */
export function isMacPlatform(nav: Navigator = navigator): boolean {
  const platform =
    (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    nav.platform ??
    "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

const KEY_NAMES: Record<string, string> = {
  Escape: "Esc",
  Enter: "Enter",
  ArrowUp: "↑",
  Backspace: "Backspace",
};

/** Where a Mac's keycap reads differently from the name above. */
const MAC_KEY_NAMES: Record<string, string> = {
  Backspace: "⌫",
};

/** The keys of a chord in press order, each spelt for the platform. */
export function chordKeys(chord: Chord, mac: boolean): string[] {
  const keys: string[] = [];
  if (chord.mod) keys.push(mac ? "⌘" : "Ctrl");
  if (chord.shift) keys.push(mac ? "⇧" : "Shift");
  const named = (mac ? MAC_KEY_NAMES[chord.key] : undefined) ?? KEY_NAMES[chord.key];
  keys.push(named ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
  return keys;
}

/** The chord as one string: `⌘⇧O` on a Mac, `Ctrl+Shift+O` elsewhere. */
export function chordLabel(chord: Chord, mac: boolean): string {
  return chordKeys(chord, mac).join(mac ? "" : "+");
}

/** Is the key event's target somewhere a person types? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "range", "file"].includes(type);
  }
  return false;
}

/**
 * The subset of a KeyboardEvent the matcher reads. A plain object in tests;
 * the real event in the listener.
 */
export interface KeyPress {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

/**
 * May this chord fire while the user is typing in a field?
 *
 * A modifier chord cannot be mistaken for typing, and the Esc chords exist
 * precisely to be pressed from inside a field: Shift+Esc to reach it, Esc
 * to stop the answer the person is waiting on. A bare printable key like
 * `?` is a character the person meant to type, so it never fires there.
 */
function firesWhileTyping(chord: Chord): boolean {
  return chord.mod === true || chord.key === "Escape";
}

function chordMatches(chord: Chord, press: KeyPress, mac: boolean): boolean {
  if (press.altKey) return false;
  const keyMatches = chord.key.toLowerCase() === press.key.toLowerCase();
  const codeMatches = chord.code !== undefined && chord.code === press.code;
  if (!keyMatches && !codeMatches) return false;
  const modPressed = mac ? press.metaKey : press.ctrlKey;
  const otherPressed = mac ? press.ctrlKey : press.metaKey;
  if (otherPressed) return false;
  if ((chord.mod === true) !== modPressed) return false;
  // Shift only matters for a key whose value does not already encode it: a
  // `?` arrives with Shift held and the chord does not need to say so. A
  // chord that names Shift itself always needs it.
  const shiftMatters =
    chord.shift === true || /^[a-z]$/i.test(chord.key) || chord.key.length > 1;
  if (shiftMatters && (chord.shift === true) !== press.shiftKey) return false;
  return true;
}

/**
 * Which global shortcut, if any, this key press is. Local shortcuts are
 * never returned; chords that would collide with typing are skipped when
 * the press landed in a field.
 */
export function matchShortcut(
  press: KeyPress,
  mac: boolean,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): Shortcut | null {
  const typing = isTypingTarget(press.target);
  for (const shortcut of shortcuts) {
    if (shortcut.local) continue;
    for (const chord of shortcut.chords) {
      if (typing && !firesWhileTyping(chord)) continue;
      if (chordMatches(chord, press, mac)) return shortcut;
    }
  }
  return null;
}

/** The sidebar's search box, which `search-chats` focuses. */
export const CONVERSATION_SEARCH_ID = "mw-conversation-search";
