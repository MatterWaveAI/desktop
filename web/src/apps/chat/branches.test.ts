import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  branchPosition,
  defaultLeaf,
  descendToLeaf,
  indexChildren,
  pathToLeaf,
  siblingLeaf,
} from "./branches";

/**
 * The client-side tree. Switching branches must re-render from what
 * the SPA already holds, so these functions are pure and provable without a
 * server -- which is the whole reason they are not inside the component.
 */

let clock = 0;

function msg(id: string, parent_id: string | null, content = id): Message {
  clock += 1;
  return {
    id,
    conversation_id: "c1",
    role: content.startsWith("q") ? "user" : "assistant",
    content,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    parent_id,
    model: null,
  };
}

/**
 *   q1
 *   ├── a1        (first answer)
 *   │   └── q2
 *   │       └── a2
 *   └── a1b       (regenerated)
 */
function branchedTree(): Message[] {
  clock = 0;
  return [
    msg("q1", null, "q1"),
    msg("a1", "q1", "a1"),
    msg("q2", "a1", "q2"),
    msg("a2", "q2", "a2"),
    msg("a1b", "q1", "a1b"),
  ];
}

describe("indexChildren", () => {
  it("groups by parent, roots under null", () => {
    const children = indexChildren(branchedTree());
    expect(children.get(null)?.map((m) => m.id)).toEqual(["q1"]);
    expect(children.get("q1")?.map((m) => m.id)).toEqual(["a1", "a1b"]);
    expect(children.get("a1")?.map((m) => m.id)).toEqual(["q2"]);
  });

  it("orders siblings by creation, whatever order they arrive in", () => {
    const tree = branchedTree();
    const children = indexChildren([...tree].reverse());
    expect(children.get("q1")?.map((m) => m.id)).toEqual(["a1", "a1b"]);
  });
});

describe("pathToLeaf", () => {
  it("returns the path root first", () => {
    expect(pathToLeaf(branchedTree(), "a2").map((m) => m.id)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("returns the other branch for the other leaf", () => {
    expect(pathToLeaf(branchedTree(), "a1b").map((m) => m.id)).toEqual(["q1", "a1b"]);
  });

  it("is empty for no leaf", () => {
    expect(pathToLeaf(branchedTree(), null)).toEqual([]);
  });

  it("stops at a missing parent rather than throwing", () => {
    // A pruned tree: `a1`'s parent is not in the array.
    const orphan = [msg("a1", "gone", "a1")];
    expect(pathToLeaf(orphan, "a1").map((m) => m.id)).toEqual(["a1"]);
  });
});

describe("descendToLeaf", () => {
  it("follows the newest child to the bottom", () => {
    const children = indexChildren(branchedTree());
    expect(descendToLeaf(children, "a1")).toBe("a2");
  });

  it("stops where a message has no children", () => {
    const children = indexChildren(branchedTree());
    expect(descendToLeaf(children, "a1b")).toBe("a1b");
  });
});

describe("branchPosition", () => {
  it("reports index and total among siblings", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const a1 = tree.find((m) => m.id === "a1")!;
    const a1b = tree.find((m) => m.id === "a1b")!;
    expect(branchPosition(children, a1)).toMatchObject({ index: 0, total: 2 });
    expect(branchPosition(children, a1b)).toMatchObject({ index: 1, total: 2 });
  });

  it("is null for an only child -- no switcher on an ordinary message", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const q2 = tree.find((m) => m.id === "q2")!;
    expect(branchPosition(children, q2)).toBeNull();
  });

  it("counts three siblings as 3", () => {
    const tree = [...branchedTree(), msg("a1c", "q1", "a1c")];
    const children = indexChildren(tree);
    const a1c = tree.find((m) => m.id === "a1c")!;
    expect(branchPosition(children, a1c)).toMatchObject({ index: 2, total: 3 });
  });
});

describe("siblingLeaf", () => {
  it("steps to the next sibling and descends to its leaf", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const a1 = tree.find((m) => m.id === "a1")!;
    expect(siblingLeaf(children, a1, +1)).toBe("a1b");
  });

  it("steps back and descends the other branch to its deepest leaf", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const a1b = tree.find((m) => m.id === "a1b")!;
    expect(siblingLeaf(children, a1b, -1)).toBe("a2");
  });

  it("is null at either end, which disables the arrow", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const a1 = tree.find((m) => m.id === "a1")!;
    const a1b = tree.find((m) => m.id === "a1b")!;
    expect(siblingLeaf(children, a1, -1)).toBeNull();
    expect(siblingLeaf(children, a1b, +1)).toBeNull();
  });
});

describe("defaultLeaf", () => {
  it("prefers the server's recorded cursor", () => {
    expect(defaultLeaf(branchedTree(), "a1b")).toBe("a1b");
  });

  it("falls back to the newest leaf when there is no cursor", () => {
    // Same fallback the server makes, so a conversation from before branching renders
    // identically on both sides.
    expect(defaultLeaf(branchedTree(), null)).toBe("a1b");
  });

  it("ignores a cursor that is not in the tree", () => {
    expect(defaultLeaf(branchedTree(), "no-such-id")).toBe("a1b");
  });

  it("is null for an empty tree", () => {
    expect(defaultLeaf([], null)).toBeNull();
  });
});

describe("switching is a pure re-render", () => {
  it("the same tree yields both transcripts with no fetch", () => {
    const tree = branchedTree();
    const children = indexChildren(tree);
    const a1 = tree.find((m) => m.id === "a1")!;

    const forward = siblingLeaf(children, a1, +1)!;
    expect(pathToLeaf(tree, forward).map((m) => m.content)).toEqual(["q1", "a1b"]);

    const a1b = tree.find((m) => m.id === "a1b")!;
    const back = siblingLeaf(children, a1b, -1)!;
    expect(pathToLeaf(tree, back).map((m) => m.content)).toEqual(["q1", "a1", "q2", "a2"]);
  });
});
