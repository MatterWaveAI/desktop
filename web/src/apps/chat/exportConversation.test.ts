import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import {
  conversationToJson,
  conversationToMarkdown,
  downloadText,
  EXPORT_FORMAT,
  safeFilename,
} from "./exportConversation";

/**
 * The client-side export: the file name a title becomes, and what the two
 * formats say. Pure string work, so no DOM except for the download itself.
 */

const AT = new Date("2026-10-03T12:34:56.789Z");

function message(over: Partial<Message> & { id: string; role: Message["role"] }): Message {
  return {
    conversation_id: "c-1",
    content: "",
    created_at: "2026-10-01T00:00:00Z",
    parent_id: null,
    model: null,
    ...over,
  };
}

describe("safeFilename", () => {
  it("strips what no filesystem accepts and keeps the rest readable", () => {
    expect(safeFilename('Notes: Q3 / plan?')).toBe("Notes Q3 plan");
    expect(safeFilename("  a\\b|c<d>e\"f*g  ")).toBe("a b c d e f g");
  });

  it("refuses Windows' hidden rules: trailing dots, leading dots, device names", () => {
    expect(safeFilename("ends with a dot.")).toBe("ends with a dot");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("CON")).toBe("CON conversation");
    expect(safeFilename("lpt1")).toBe("lpt1 conversation");
  });

  it("never returns an empty name and bounds the length", () => {
    expect(safeFilename("")).toBe("conversation");
    expect(safeFilename("???")).toBe("conversation");
    expect(safeFilename("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("conversationToMarkdown", () => {
  it("writes the title, a provenance line and one section per turn", () => {
    const md = conversationToMarkdown(
      {
        id: "c-1",
        title: "Infra",
        messages: [
          message({ id: "m-0", role: "user", content: "What is a process?" }),
          message({
            id: "m-1",
            role: "assistant",
            content: "A process has its own memory.",
            parent_id: "m-0",
            model: "llama-8b",
          }),
        ],
      },
      AT,
    );
    expect(md.startsWith("# Infra\n")).toBe(true);
    expect(md).toContain("Exported from MatterWave on 2026-10-03T12:34:56Z. Conversation `c-1`.");
    expect(md).toContain("## You\n\nWhat is a process?");
    expect(md).toContain("## Assistant (llama-8b)\n\nA process has its own memory.");
  });

  it("describes attachments and tool calls rather than dropping them, and omits system turns", () => {
    const md = conversationToMarkdown(
      {
        id: "c-1",
        title: "T",
        messages: [
          message({ id: "s", role: "system", content: "Answer in British English." }),
          message({
            id: "u",
            role: "user",
            content: "Look at this",
            parts: [
              { type: "text", text: "Look at this" },
              {
                type: "image",
                attachment_id: "att-1",
                filename: "shot.png",
                content_type: "image/png",
              },
              {
                type: "document",
                attachment_id: "att-2",
                filename: "spec.pdf",
                content_type: "application/pdf",
                text: null,
                truncated: true,
              },
            ],
          }),
          message({
            id: "a",
            role: "assistant",
            content: "Done",
            parts: [
              { type: "reasoning", text: "thinking" },
              { type: "tool_call", id: "t1", name: "web_search", arguments: '{"q":"x"}' },
              { type: "tool_result", id: "t1", output: "results", is_error: false },
              { type: "text", text: "Done" },
            ],
          }),
        ],
      },
      AT,
    );
    expect(md).not.toContain("British English");
    expect(md).toContain("*Attached image: shot.png*");
    expect(md).toContain("*Attached file: spec.pdf (partly read)*");
    expect(md).toContain("*Called `web_search`*");
    expect(md).toContain("```json\n{\"q\":\"x\"}\n```");
    expect(md).toContain("*Tool result:*\n\n```\nresults\n```");
    // The model's working stays out of the document; the answer is in.
    expect(md).not.toContain("thinking");
    expect(md).toContain("Done");
  });
});

describe("conversationToJson", () => {
  it("names its schema and carries the path and the whole tree", () => {
    const path = [message({ id: "m-0", role: "user", content: "hi" })];
    const tree = [...path, message({ id: "m-1", role: "user", content: "hi again" })];
    const parsed = JSON.parse(
      conversationToJson({ id: "c-1", title: "Infra", messages: path, tree }, AT),
    );
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.version).toBe(1);
    expect(parsed.exported_at).toBe("2026-10-03T12:34:56.789Z");
    expect(parsed.title).toBe("Infra");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.tree).toHaveLength(2);
    // A message that predates typed parts still exports with one text part.
    expect(parsed.messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("downloadText", () => {
  it("clicks an anchor whose download name is the one asked for, then frees the URL", () => {
    const create = vi.fn(() => "blob:mw/1");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe("Infra.md");
      expect(this.href).toBe("blob:mw/1");
    });
    try {
      downloadText("Infra.md", "# Infra", "text/markdown");
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("blob:mw/1");
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
