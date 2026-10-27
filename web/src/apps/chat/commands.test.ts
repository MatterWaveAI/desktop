import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { Message } from "../../types";
import {
  COMMANDS,
  canCompact,
  contextNotice,
  helpNotice,
  matchCommands,
  nothingToCompactNotice,
  parseCommand,
  runCompact,
  unknownCommandNotice,
} from "./commands";

/**
 * The composer's slash commands: what a line parses as, what the popover
 * lists for it, and the two outcomes of /compact. All pure, or async with
 * the fetch injected; the composer itself is wired in ChatPage.
 */

describe("parsing a composer line", () => {
  it("names a known command, whatever the case or trailing space", () => {
    expect(parseCommand("/compact")).toEqual({ kind: "command", name: "compact" });
    expect(parseCommand("  /Context \n")).toEqual({ kind: "command", name: "context" });
    expect(parseCommand("/help")).toEqual({ kind: "command", name: "help" });
  });

  it("is null for an ordinary message, so nothing but a slash word is intercepted", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/ a path")).toBeNull();
    expect(parseCommand("1/2 cup")).toBeNull();
    expect(parseCommand("/compact the thread please")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("flags a slash word it does not know, rather than sending it to the model", () => {
    expect(parseCommand("/compcat")).toEqual({ kind: "unknown", name: "compcat" });
    expect(unknownCommandNotice("compcat")).toMatch(/Unknown command \/compcat.*\/help/);
    // The draft is kept, and the notice says so.
    expect(unknownCommandNotice("compcat")).toMatch(/still in the box/);
  });
});

describe("the popover's matches", () => {
  it("lists every command for a bare slash and narrows on the prefix", () => {
    expect(matchCommands("/")).toEqual(COMMANDS);
    expect(matchCommands("/co").map((c) => c.name)).toEqual(["compact", "context"]);
    expect(matchCommands("/H").map((c) => c.name)).toEqual(["help"]);
    expect(matchCommands("/compact").map((c) => c.name)).toEqual(["compact"]);
  });

  it("closes once the line stops being a command", () => {
    expect(matchCommands("")).toEqual([]);
    expect(matchCommands("hi /")).toEqual([]);
    expect(matchCommands("/compact ")).toEqual([]);
    expect(matchCommands("/x")).toEqual([]);
    expect(matchCommands("/help\nmore")).toEqual([]);
  });

  it("leaves /compact out where there is nothing to fold", () => {
    expect(matchCommands("/", { compactable: false }).map((c) => c.name)).toEqual(["context", "help"]);
    expect(matchCommands("/co", { compactable: false }).map((c) => c.name)).toEqual(["context"]);
    expect(matchCommands("/compact", { compactable: false })).toEqual([]);
    expect(matchCommands("/", { compactable: true })).toEqual(COMMANDS);
  });
});

describe("whether a fold has anything to do", () => {
  it("needs stored turns beyond the tail the server keeps", () => {
    expect(canCompact(0, null)).toBe(false);
    expect(canCompact(0, 2)).toBe(false);
    // Until /context has said how many it keeps, any stored turn may do.
    expect(canCompact(2, null)).toBe(true);
    expect(canCompact(4, 2)).toBe(false);
    expect(canCompact(5, 2)).toBe(true);
  });
});

describe("the nothing-to-compact notice", () => {
  it("quotes the kept count /context reported", () => {
    expect(nothingToCompactNotice(2, "Nothing to compact yet.")).toBe(
      "Nothing to compact yet - the last 2 exchanges are always kept",
    );
    expect(nothingToCompactNotice(1, "")).toBe("Nothing to compact yet - the last 1 exchange is always kept");
  });

  it("falls back to the number in the 409's detail, and to no number at all", () => {
    expect(nothingToCompactNotice(null, "Nothing to compact yet: the last 3 exchanges are always kept.")).toBe(
      "Nothing to compact yet - the last 3 exchanges are always kept",
    );
    expect(nothingToCompactNotice(null, "Nothing to compact yet.")).toBe(
      "Nothing to compact yet - the most recent exchanges are always kept",
    );
  });
});

describe("/context and /help", () => {
  it("says the meter's numbers", () => {
    expect(contextNotice({ used: 512, window: 1024 })).toBe(
      "Context: 512 of 1,024 tokens used (50%), 512 left before the next turn.",
    );
    expect(contextNotice({ used: 300, window: 1024, estimated: true })).toMatch(/^Context: about 300 of 1,024/);
    expect(contextNotice({ used: null, window: 1024 })).toMatch(/0 of 1,024 tokens used \(0%\)/);
  });

  it("says why there is no meter for a model with no window", () => {
    expect(contextNotice({ used: 500, window: null })).toMatch(/no context window/);
  });

  it("lists every command with its description", () => {
    const help = helpNotice();
    for (const command of COMMANDS) {
      expect(help).toContain(`/${command.name} - ${command.description}`);
    }
  });
});

describe("/compact", () => {
  const summary = { id: "s1", role: "system", content: "" } as Message;

  it("hands the summary to the tree on success, with no notice", async () => {
    const onSummary = vi.fn();
    const onNotice = vi.fn();
    const compact = vi.fn().mockResolvedValue(summary);
    await runCompact({ conversationId: "c1", compact, keepPairs: 2, onSummary, onNotice });
    expect(compact).toHaveBeenCalledExactlyOnceWith("c1");
    expect(onSummary).toHaveBeenCalledExactlyOnceWith(summary);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("answers a 409 with the kept count, from /context first", async () => {
    const onSummary = vi.fn();
    const onNotice = vi.fn();
    const compact = vi.fn().mockRejectedValue(new ApiError(409, "Nothing to compact yet."));
    await runCompact({ conversationId: "c1", compact, keepPairs: 2, onSummary, onNotice });
    expect(onSummary).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      "Nothing to compact yet - the last 2 exchanges are always kept",
    );
  });

  it("answers a 409 from the detail's number when /context has not answered", async () => {
    const onNotice = vi.fn();
    const compact = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "Nothing to compact yet: the last 4 exchanges are always kept."));
    await runCompact({ conversationId: "c1", compact, keepPairs: null, onSummary: vi.fn(), onNotice });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      "Nothing to compact yet - the last 4 exchanges are always kept",
    );
  });

  it("keeps the existing copy for the other failures", async () => {
    const said = async (err: unknown) => {
      const onNotice = vi.fn();
      await runCompact({
        conversationId: "c1",
        compact: vi.fn().mockRejectedValue(err),
        keepPairs: 2,
        onSummary: vi.fn(),
        onNotice,
      });
      return onNotice.mock.calls[0][0] as string;
    };
    expect(await said(new ApiError(402, "budget"))).toMatch(/budget is used up/);
    expect(await said(new ApiError(502, "x"))).toMatch(/could not summarise.*Nothing was changed/);
    expect(await said(new ApiError(409, "This model states no context window"))).toMatch(/no context window/);
    expect(await said(new ApiError(409, "Compaction is switched off on this deployment."))).toMatch(/switched off/);
    expect(await said(new TypeError("Failed to fetch"))).toMatch(/Nothing was lost/);
  });

  it("has nothing to fold before the conversation exists", async () => {
    const compact = vi.fn();
    const onNotice = vi.fn();
    await runCompact({ conversationId: null, compact, keepPairs: 2, onSummary: vi.fn(), onNotice });
    expect(compact).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith("Nothing to compact yet - this conversation has no messages.");
  });
});
