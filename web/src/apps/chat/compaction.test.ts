import { describe, expect, it } from "vitest";
import type { Message, ModelInfo } from "../../types";
import {
  compactFailureNotice,
  endedOnLength,
  endedStopped,
  estimateTokens,
  foldPath,
  meterReading,
  noticeText,
  readingOfContext,
  readingOfFrame,
  resolveWindow,
  summaryOf,
  type FoldedRow,
} from "./compaction";
import type { BranchedMessage } from "./useBranchedThread";

/**
 * The client half of compaction is arithmetic and a fold over the path, so
 * it is tested as pure functions: same path in, same rows out.
 */

let clock = 0;

function msg(id: string, parent_id: string | null, role: Message["role"], extra: Partial<Message> = {}): Message {
  clock += 1;
  return {
    id,
    conversation_id: "c1",
    role,
    content: id,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    parent_id,
    model: null,
    ...extra,
  };
}

function summary(id: string, parent: string, from: string, to: string): Message {
  return msg(id, parent, "system", {
    content: "",
    parts: [
      { type: "summary", text: "They talked about tea.", covers_from: from, covers_to: to, tokens_before: 900, tokens_after: 80 } as never,
    ],
  });
}

const entries = (messages: Message[]): BranchedMessage[] => messages.map((message) => ({ message, branch: null }));

/**
 * The shape the API writes: the summary hangs under the leaf it was computed
 * from (a3), folds q1..a1, and keeps q2..a3 verbatim between `covers_to` and
 * itself. q4 a4 came after it.
 */
function compacted(): Message[] {
  clock = 0;
  return [
    msg("q1", null, "user"),
    msg("a1", "q1", "assistant"),
    msg("q2", "a1", "user"),
    msg("a2", "q2", "assistant"),
    msg("q3", "a2", "user"),
    msg("a3", "q3", "assistant"),
    summary("s1", "a3", "q1", "a1"),
    msg("q4", "s1", "user"),
    msg("a4", "q4", "assistant"),
  ];
}

const label = (r: FoldedRow) => (r.kind === "fold" ? `[${r.covered}]` : r.kind === "summary" ? "S" : r.entry.message.id);

const model = (id: string, context_window: number | null) => ({ id, context_window }) as ModelInfo;

describe("the meter", () => {
  it("estimates a quarter of the draft's length, rounded up, like the server", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("adds the draft to the last real count", () => {
    expect(meterReading({ used: 500, window: 1024 }, "x".repeat(40))).toMatchObject({ used: 510, window: 1024, level: "ok" });
  });

  it("turns amber at three quarters and red at nine tenths", () => {
    expect(meterReading({ used: 767, window: 1024 }, "")?.level).toBe("ok");
    expect(meterReading({ used: 768, window: 1024 }, "")?.level).toBe("warn");
    expect(meterReading({ used: 921, window: 1024 }, "")?.level).toBe("warn");
    expect(meterReading({ used: 922, window: 1024 }, "")?.level).toBe("full");
    // The draft alone can tip it.
    expect(meterReading({ used: 760, window: 1024 }, "x".repeat(40))?.level).toBe("warn");
  });

  it("is hidden when the model has no window, and counts the draft alone before any turn", () => {
    expect(meterReading({ used: 500, window: null }, "hi")).toBeNull();
    expect(meterReading({ used: null, window: 1024 }, "x".repeat(8))?.used).toBe(2);
  });

  it("takes the picked model's window, then the conversation's, then the default's", () => {
    const models = [model("small", 1024), model("big", 131072), model("open", null)];
    const ask = (selectedModel: string | null, contextWindow: number | null | undefined) =>
      resolveWindow({ selectedModel, defaultModel: "big", models, contextWindow });
    expect(ask("small", 131072)).toBe(1024);
    expect(ask("open", 1024)).toBeNull();
    expect(ask(null, 1024)).toBe(1024);
    // The conversation's model says it has no window: hidden, not the default's.
    expect(ask(null, null)).toBeNull();
    expect(ask(null, undefined)).toBe(131072);
  });
});

describe("the context frame and /context", () => {
  it("adds the answer to the prompt it was counted against", () => {
    expect(readingOfFrame({ prompt_tokens: 400, completion_tokens: 60, context_window: 1024 })).toEqual({
      used: 460,
      window: 1024,
      estimated: false,
    });
  });

  it("knows nothing counted when the upstream sent no usage", () => {
    expect(readingOfFrame({ prompt_tokens: null, completion_tokens: null, context_window: 1024 }).used).toBeNull();
  });

  it("carries /context's estimated flag to the meter", () => {
    const reading = readingOfContext({
      model: "grt-nano",
      context_window: 1024,
      used_tokens: 300,
      estimated: true,
      compactable: false,
    });
    expect(reading).toEqual({ used: 300, window: 1024, estimated: true });
    expect(meterReading(reading, "")?.estimated).toBe(true);
    expect(meterReading({ used: 300, window: 1024 }, "")?.estimated).toBe(false);
  });
});

describe("folding the path at a summary", () => {
  it("puts the divider after covers_to, keeps the tail verbatim, and the summary where it sits", () => {
    const rows = foldPath(entries(compacted()), new Set());
    expect(rows.map(label)).toEqual(["[2]", "q2", "a2", "q3", "a3", "S", "q4", "a4"]);
  });

  it("shows the originals above the divider when expanded, and keeps their path index", () => {
    const rows = foldPath(entries(compacted()), new Set(["s1"]));
    expect(rows.map(label)).toEqual(["q1", "a1", "[2]", "q2", "a2", "q3", "a3", "S", "q4", "a4"]);
    const fold = rows[2];
    expect(fold.kind === "fold" && fold.expanded).toBe(true);
    const last = rows[rows.length - 1];
    expect(last.kind === "message" && last.index).toBe(8);
  });

  it("folds by the latest summary only, whose range carries the earlier one", () => {
    // A second fold: covers_from carried forward from s1, covers_to a2.
    const path = [...compacted(), summary("s2", "a4", "q1", "a2"), msg("q5", "s2", "user")];
    expect(foldPath(entries(path), new Set()).map(label)).toEqual(["[4]", "q3", "a3", "S", "q4", "a4", "S", "q5"]);
    // Expanding the earlier summary does nothing: only the latest folds.
    expect(foldPath(entries(path), new Set(["s1"])).map(label)[0]).toBe("[4]");
  });

  it("hides an earlier summary that falls inside the latest one's range, and does not count it", () => {
    clock = 0;
    const path = [
      msg("q1", null, "user"),
      msg("a1", "q1", "assistant"),
      summary("s1", "a1", "q1", "q1"),
      msg("q2", "s1", "user"),
      msg("a2", "q2", "assistant"),
      summary("s2", "a2", "q1", "q2"),
    ];
    expect(foldPath(entries(path), new Set()).map(label)).toEqual(["[3]", "a2", "S"]);
  });

  it("never renders a system message as a turn", () => {
    clock = 0;
    const path = [msg("sys", null, "system"), msg("q1", "sys", "user")];
    expect(foldPath(entries(path), new Set()).map((r) => r.entry.message.id)).toEqual(["q1"]);
  });

  it("folds from the start when the first covered message is not on the path", () => {
    clock = 0;
    const path = [
      msg("q1", null, "user"),
      msg("a1", "q1", "assistant"),
      msg("q2", "a1", "user"),
      summary("s1", "q2", "gone", "a1"),
    ];
    expect(foldPath(entries(path), new Set()).map(label)).toEqual(["[2]", "q2", "S"]);
  });

  it("folds everything above the summary when covers_to is not on the path, as the server does", () => {
    clock = 0;
    const path = [msg("q1", null, "user"), msg("a1", "q1", "assistant"), summary("s1", "a1", "q1", "gone")];
    expect(foldPath(entries(path), new Set()).map(label)).toEqual(["[2]", "S"]);
  });

  it("reads a summary off a system message's summary part, not its empty content", () => {
    const s1 = compacted()[6];
    expect(s1.content).toBe("");
    expect(summaryOf(s1)?.text).toBe("They talked about tea.");
    expect(summaryOf({ ...s1, role: "assistant" })).toBeNull();
  });
});

describe("Compact now failing", () => {
  it("says which failure it was", () => {
    expect(compactFailureNotice(409, "Nothing to compact yet.")).toBe("Nothing to summarise yet.");
    expect(
      compactFailureNotice(409, "This model states no context window, so there is nothing to compact against."),
    ).toMatch(/no context window/);
    expect(compactFailureNotice(402, "budget")).toMatch(/budget is used up/);
    expect(compactFailureNotice(502, "x")).toMatch(/could not summarise.*Nothing was changed/);
    expect(compactFailureNotice(500, "x")).toMatch(/Nothing was lost/);
  });
});

describe("a notice frame", () => {
  it("reads the API's detail", () => {
    const frame = JSON.stringify({ detail: "Edits run uncompacted.", code: "compaction" });
    expect(noticeText(frame)).toBe("Edits run uncompacted.");
  });

  it("still says something for a frame without one", () => {
    expect(noticeText(JSON.stringify({ message: "older shape" }))).toBe("older shape");
    expect(noticeText("{}")).toMatch(/could not be summarised/);
  });
});

describe("a length-truncated answer", () => {
  it("is known by its flag, its finish reason, or the id the stream reported", () => {
    clock = 0;
    const answer = msg("a1", "q1", "assistant");
    expect(endedOnLength(answer, new Set())).toBe(false);
    expect(endedOnLength({ ...answer, truncated: true } as Message, new Set())).toBe(true);
    expect(endedOnLength({ ...answer, finish_reason: "length" } as Message, new Set())).toBe(true);
    expect(endedOnLength(answer, new Set(["a1"]))).toBe(true);
    expect(endedOnLength(msg("q1", null, "user"), new Set(["q1"]))).toBe(false);
  });

  it("is not an answer the person stopped: truncated with no finish reason", () => {
    clock = 0;
    const answer = msg("a1", "q1", "assistant");
    const stopped = { ...answer, truncated: true, finish_reason: null } as Message;
    expect(endedOnLength(stopped, new Set())).toBe(false);
    expect(endedStopped(stopped)).toBe(true);
    expect(endedStopped({ ...answer, truncated: true, finish_reason: "length" } as Message)).toBe(
      false,
    );
    expect(endedStopped(answer)).toBe(false);
    expect(endedStopped({ ...stopped, role: "user" } as Message)).toBe(false);
  });
});
