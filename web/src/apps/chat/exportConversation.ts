import type { Message } from "../../types";
import type { MessagePart } from "./chatAdapter";
import {
  isDocumentPart,
  isImagePart,
  isReasoningPart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
} from "./chatAdapter";

/**
 * Export a conversation the SPA already holds, entirely in the browser.
 *
 * No API: `?full=1` has already delivered every message of the conversation
 * to the page, so an export is a formatting job, not a request. That is also
 * what makes it work offline and what keeps it out of the budget. Pure
 * functions here, the download itself at the bottom, so the two formats are
 * testable as strings.
 */

/** What an export is built from: the branch on screen, and every branch. */
export interface ConversationExport {
  readonly id: string;
  readonly title: string;
  /** The root-to-leaf path the transcript shows, in order. */
  readonly messages: readonly Message[];
  /** Every message including the siblings the path leaves out, if known. */
  readonly tree?: readonly Message[];
}

/** The schema the JSON file names itself with, for whatever reads it next. */
export const EXPORT_FORMAT = "matterwave-conversation";
export const EXPORT_VERSION = 1;

/** Names Windows refuses as a basename whatever the extension. */
const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Characters no mainstream filesystem accepts in a name, plus controls. */
// eslint-disable-next-line no-control-regex -- the control range is the point
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

const MAX_BASENAME_LENGTH = 80;

/**
 * A title as a filename stem that every filesystem will take.
 *
 * Windows is the strict one: the forbidden set above, no trailing dot or
 * space, and a handful of device names that are refused even with an
 * extension. Everything is reduced to that, so a conversation called
 * `"Notes: Q3 / plan?"` downloads as `Notes Q3 plan.md` on every platform
 * instead of failing on one of them.
 */
export function safeFilename(title: string): string {
  let name = title
    .normalize("NFKC")
    .replace(FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASENAME_LENGTH)
    // Leading dots hide the file on Unix; trailing dots and spaces are
    // dropped silently by Windows, which would make the name differ from
    // the one shown.
    .replace(/^[. ]+|[. ]+$/g, "");
  if (name === "") name = "conversation";
  if (RESERVED_BASENAMES.test(name)) name = `${name} conversation`;
  return name;
}

/** The ISO timestamp with no fractional seconds, for a line a person reads. */
function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * One part as Markdown. Text is itself; everything else is described rather
 * than embedded, because the bytes of an attachment are not in the page and
 * a tool's output is data, not prose. Reasoning is omitted: it is the model's
 * working, shown collapsed in the transcript, and an export is the answer.
 */
function partToMarkdown(part: MessagePart): string | null {
  if (isTextPart(part)) return part.text;
  if (isReasoningPart(part)) return null;
  if (isToolCallPart(part)) {
    return `*Called \`${part.name}\`*\n\n\`\`\`json\n${part.arguments}\n\`\`\``;
  }
  if (isToolResultPart(part)) {
    return `*Tool result${part.is_error ? " (error)" : ""}:*\n\n\`\`\`\n${part.output}\n\`\`\``;
  }
  if (isImagePart(part)) return `*Attached image: ${part.filename}*`;
  if (isDocumentPart(part)) {
    return `*Attached file: ${part.filename}${part.truncated ? " (partly read)" : ""}*`;
  }
  return `*(unsupported content: ${part.type})*`;
}

function messageToMarkdown(message: Message): string | null {
  // System messages are the instructions in force, which the transcript
  // does not show either; an export mirrors what the reader saw.
  if (message.role === "system") return null;
  const heading =
    message.role === "user"
      ? "## You"
      : `## Assistant${message.model ? ` (${message.model})` : ""}`;
  const parts = message.parts ?? [{ type: "text", text: message.content }];
  const body = parts
    .map(partToMarkdown)
    .filter((text): text is string => text !== null && text !== "")
    .join("\n\n");
  return `${heading}\n\n${body}`;
}

/** The conversation as a Markdown document: a title, a provenance line, one section per turn. */
export function conversationToMarkdown(data: ConversationExport, exportedAt: Date): string {
  const sections = data.messages
    .map(messageToMarkdown)
    .filter((section): section is string => section !== null);
  return [
    `# ${data.title}`,
    "",
    `Exported from MatterWave on ${stamp(exportedAt)}. Conversation \`${data.id}\`.`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

/**
 * The conversation as JSON: the messages as the API sent them, with the
 * file naming its own schema so a later reader can tell what it has.
 */
export function conversationToJson(data: ConversationExport, exportedAt: Date): string {
  const strip = (message: Message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    parts: message.parts ?? [{ type: "text", text: message.content }],
    model: message.model,
    created_at: message.created_at,
    parent_id: message.parent_id,
  });
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exported_at: exportedAt.toISOString(),
      id: data.id,
      title: data.title,
      messages: data.messages.map(strip),
      ...(data.tree ? { tree: data.tree.map(strip) } : {}),
    },
    null,
    2,
  );
}

/**
 * Hand the browser a file to save. A blob URL on an anchor with `download`,
 * revoked once the click has dispatched; the same mechanism the account
 * export in Settings uses.
 */
export function downloadText(filename: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
