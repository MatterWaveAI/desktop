import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Conversation } from "../types";
import { settingsPanes } from "../apps/settings/panes";
import { i18n as globalI18n } from "../i18n/runtime";
import { HELP_PATH } from "./help";

/**
 * The command palette's data: what it can do, and how typed text ranks it.
 *
 * A separate module from the component so the ranking is a pure function
 * a test can call, and so the file that exports the component exports only
 * the component (fast refresh).
 */

export type PaletteAction =
  | { kind: "new-chat" }
  | { kind: "conversation"; id: string }
  | { kind: "settings"; paneId: string }
  | { kind: "help" }
  | { kind: "shortcuts" }
  | { kind: "search"; query: string };

export interface PaletteCommand {
  /** Stable, unique: the listbox option id and the React key. */
  id: string;
  label: string;
  /**
   * Which group the command is from. A key, not a heading: the palette
   * translates it when it draws the run's heading.
   */
  group: "Actions" | "Conversations" | "Settings" | "Help";
  action: PaletteAction;
}

/**
 * How well `query` matches `text`, higher is better; 0 is no match.
 *
 * Fuzzy in the way a person expects of a switcher: a whole-word prefix wins
 * over a substring, a substring over a subsequence ("qvp" finds "Quarterly
 * velocity planning"), and anything that cannot be found in order is out.
 * Case-insensitive; deliberately simple so its behaviour can be read.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const at = t.indexOf(q);
  if (at >= 0) {
    // A substring at a word boundary ("vel" in "the velocity") beats one
    // inside a word ("vel" in "travel").
    return t[at - 1] === " " ? 80 : 60;
  }
  // Subsequence: every character of the query appears in order. Scored by
  // how tightly the matched characters sit, so "qvp" ranks a title whose
  // words start with those letters above one where they are scattered.
  let i = 0;
  let spread = 0;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (last >= 0) spread += j - last - 1;
      last = j;
      i++;
    }
  }
  if (i < q.length) return 0;
  return Math.max(1, 40 - Math.min(spread, 39));
}

/** How many conversations the empty palette lists before anything is typed. */
export const RECENT_CONVERSATIONS = 8;

/** How many results the palette shows at most, whatever is typed. */
export const PALETTE_LIMIT = 12;

/**
 * Built per call rather than once: the labels are in the active language,
 * which can change after this module loads. The pane titles are the
 * settings registry's own and read as it writes them.
 */
function staticCommands(i18n: I18n): readonly PaletteCommand[] {
  return [
    { id: "new-chat", label: i18n._(msg`New chat`), group: "Actions", action: { kind: "new-chat" } },
    ...settingsPanes.map((pane): PaletteCommand => {
      const title = pane.title;
      return {
        id: `settings:${pane.id}`,
        label: i18n._(msg`Settings: ${title}`),
        group: "Settings",
        action: { kind: "settings", paneId: pane.id },
      };
    }),
    { id: "help", label: i18n._(msg`Help`), group: "Help", action: { kind: "help" } },
    {
      id: "shortcuts",
      label: i18n._(msg`Keyboard shortcuts`),
      group: "Help",
      action: { kind: "shortcuts" },
    },
  ];
}

/** Where the help command goes, for a caller that navigates by path. */
export const HELP_COMMAND_PATH = HELP_PATH;

/**
 * The commands to show for `query`, ranked.
 *
 * Empty query: the actions, the most recent conversations, then help and
 * settings -- the order a person reaches for them. Otherwise everything is
 * scored, zeros dropped, ties kept in that same order; and a "Search
 * conversations for …" entry closes the list, so typing a word that is not
 * a title still leads somewhere.
 */
export function paletteCommands(
  query: string,
  conversations: Conversation[],
  /** Whose language the labels are in; the app's one instance unless a test says otherwise. */
  i18n: I18n = globalI18n,
): PaletteCommand[] {
  const q = query.trim();
  const conversationCommands = conversations.map(
    (c): PaletteCommand => ({
      id: `conversation:${c.id}`,
      label: c.title,
      group: "Conversations",
      action: { kind: "conversation", id: c.id },
    }),
  );
  const fixed = staticCommands(i18n);
  if (!q) {
    // Help ahead of the settings panes: the panes are many, and a capped
    // list that ran out before "Help" would hide the one entry a person new
    // to the palette is looking for. Every pane is a few letters away.
    const help = fixed.filter((c) => c.group === "Help");
    const settings = fixed.filter((c) => c.group === "Settings");
    return [
      fixed[0],
      ...conversationCommands.slice(0, RECENT_CONVERSATIONS),
      ...help,
      ...settings,
    ].slice(0, PALETTE_LIMIT);
  }
  const all = [...fixed, ...conversationCommands];
  const ranked = all
    .map((command, index) => ({ command, index, score: fuzzyScore(q, command.label) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, PALETTE_LIMIT - 1)
    .map((entry) => entry.command);
  ranked.push({
    id: "search",
    label: i18n._(msg`Search conversations for “${q}”`),
    group: "Actions",
    action: { kind: "search", query: q },
  });
  return ranked;
}

/** A run of neighbouring commands from one group, with the index of its first row. */
export interface PaletteSection {
  group: PaletteCommand["group"];
  /** Where the run starts in the flat list, which is what the active index counts. */
  start: number;
  commands: PaletteCommand[];
}

/**
 * The ranked list cut into runs of one group, in order, for the palette to
 * head each run once. Pure, and over the flat list's order: a group that
 * appears twice (ranking can interleave them) gets two headings, because a
 * heading that gathered rows from elsewhere would change what arrowing
 * through the list reaches next.
 */
export function groupRuns(commands: readonly PaletteCommand[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  commands.forEach((command, index) => {
    const last = sections[sections.length - 1];
    if (last && last.group === command.group) last.commands.push(command);
    else sections.push({ group: command.group, start: index, commands: [command] });
  });
  return sections;
}
