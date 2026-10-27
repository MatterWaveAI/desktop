import { ApiError } from "../../lib/api";
import type { Message } from "../../types";
import { compactFailureNotice, meterReading, type ContextReading } from "./compaction";

/**
 * Slash commands in the composer: a line that starts with `/` and names one
 * of these runs it instead of being sent. None of them reaches the model or
 * is stored as a message; each answers with an inline notice in the thread,
 * or, for `/compact`, with the same divider an automatic fold leaves.
 */

export type CommandName = "compact" | "context" | "help";

export type CommandSpec = {
  readonly name: CommandName;
  readonly description: string;
};

export const COMMANDS: readonly CommandSpec[] = [
  { name: "compact", description: "Summarise the earlier messages now" },
  { name: "context", description: "Show how much of the model's window is used" },
  { name: "help", description: "List these commands" },
];

export type ParsedCommand =
  | { readonly kind: "command"; readonly name: CommandName }
  | { readonly kind: "unknown"; readonly name: string };

/**
 * What a composer line is, before it is sent. Null for an ordinary message:
 * anything that does not start with `/`, or a `/` followed by a space, a
 * newline or nothing (a path, a fraction, a shrug), which is text, not a
 * command. A slash word that is not a command is `unknown`, so the thread
 * can say so rather than send `/compcat` to the model.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z][\w-]*)\s*$/.exec(text.trim());
  if (match === null) return null;
  const name = match[1].toLowerCase();
  const spec = COMMANDS.find((command) => command.name === name);
  return spec ? { kind: "command", name: spec.name } : { kind: "unknown", name };
}

/**
 * The commands the popover lists for what has been typed so far: all of
 * them for a bare `/`, those starting with the word after it otherwise.
 * Empty when the line is not the start of a command (a space after the
 * slash, a second line), which closes the popover. `/compact` is left out
 * where `compactable` is false: offering it on an empty conversation only
 * earns the "nothing to compact yet" notice.
 */
export function matchCommands(
  draft: string,
  options: { compactable?: boolean } = {},
): readonly CommandSpec[] {
  const match = /^\/([\w-]*)$/.exec(draft);
  if (match === null) return [];
  const prefix = match[1].toLowerCase();
  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(prefix) &&
      (command.name !== "compact" || options.compactable !== false),
  );
}

/**
 * Whether a fold would have anything to do: stored turns beyond the tail
 * the server always keeps. The kept count is the server's (`keep_pairs`
 * from `/context`); until it has answered, any stored turn counts, and the
 * server's 409 says the rest.
 */
export function canCompact(storedTurns: number, keepPairs: number | null): boolean {
  if (storedTurns === 0) return false;
  if (keepPairs === null) return true;
  return storedTurns > keepPairs * 2;
}

/**
 * The 409 sentence. The kept count comes from `/context` (`keep_pairs`)
 * when it has answered, else from the number in the server's detail, which
 * carries it for exactly this case; never from a constant here, because the
 * setting is the deployment's.
 */
export function nothingToCompactNotice(keepPairs: number | null, detail: string): string {
  const kept = keepPairs ?? numberIn(detail);
  if (kept === null) return "Nothing to compact yet - the most recent exchanges are always kept";
  return `Nothing to compact yet - the last ${kept} ${kept === 1 ? "exchange is" : "exchanges are"} always kept`;
}

function numberIn(text: string): number | null {
  const match = /\b(\d+)\b/.exec(text);
  return match === null ? null : Number(match[1]);
}

/** What `/context` says: the meter's numbers as a sentence, or why there are none. */
export function contextNotice(context: ContextReading): string {
  const reading = meterReading(context, "");
  if (reading === null) {
    return "This model states no context window, so nothing is counted and the conversation never compacts.";
  }
  const percent = Math.round(reading.ratio * 100);
  const used = `${reading.estimated ? "about " : ""}${reading.used.toLocaleString()}`;
  return `Context: ${used} of ${reading.window.toLocaleString()} tokens used (${percent}%), ${Math.max(
    reading.window - reading.used,
    0,
  ).toLocaleString()} left before the next turn.`;
}

/** What `/help` says: one line per command. */
export function helpNotice(): string {
  return ["Commands:", ...COMMANDS.map((command) => `/${command.name} - ${command.description}`)].join("\n");
}

export function unknownCommandNotice(name: string): string {
  return `Unknown command /${name}. Type /help for the list; nothing was sent, and your text is still in the box.`;
}

/**
 * Compact now, from the menu or `/compact`: the one fold with its two
 * outcomes. The summary message goes to `onSummary` (the tree hangs it as
 * the new leaf and the divider appears, as after an automatic fold); any
 * failure goes to `onNotice` as a sentence. The ordinary 409, nothing to
 * fold yet, quotes the kept count; the other 409s, 402 and 502 keep the
 * copy `compactFailureNotice` has for them.
 */
export async function runCompact(args: {
  conversationId: string | null;
  compact: (conversationId: string) => Promise<Message>;
  keepPairs: number | null;
  onSummary: (summary: Message) => void;
  onNotice: (text: string) => void;
}): Promise<void> {
  if (args.conversationId === null) {
    args.onNotice("Nothing to compact yet - this conversation has no messages.");
    return;
  }
  try {
    args.onSummary(await args.compact(args.conversationId));
  } catch (err) {
    if (!(err instanceof ApiError)) {
      args.onNotice(compactFailureNotice(null, ""));
    } else if (err.status === 409 && !/context window|switched off/i.test(err.message)) {
      args.onNotice(nothingToCompactNotice(args.keepPairs, err.message));
    } else {
      args.onNotice(compactFailureNotice(err.status, err.message));
    }
  }
}
