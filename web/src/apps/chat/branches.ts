import type { Message } from "../../types";

/**
 * The tree, client-side.
 *
 * The server owns which branch is current and returns one path for the
 * transcript. But switching branches must not cost a round trip: the reader
 * is comparing two answers, and a spinner between them defeats the point. So
 * the SPA holds the whole tree (`GET .../tree`) and derives the path itself;
 * the PUT that records the new leaf is fire-and-forget, because the render
 * has already happened.
 *
 * Everything here is pure: same tree in, same path out, no fetch and no
 * state. That is what makes the switcher testable without a server.
 */

/** Children of a message id, in creation order. `null` keys the roots. */
export type ChildIndex = ReadonlyMap<string | null, readonly Message[]>;

export function indexChildren(tree: readonly Message[]): ChildIndex {
  const byParent = new Map<string | null, Message[]>();
  // Creation order decides sibling order, so "2 / 3" counts the way the
  // reader made them. The server already returns the tree in that order;
  // sorting here as well keeps this pure function honest on any input.
  const ordered = [...tree].sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
  );
  for (const message of ordered) {
    const key = message.parent_id ?? null;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(message);
    else byParent.set(key, [message]);
  }
  return byParent;
}

/**
 * The path from a leaf up to its root, root first.
 *
 * Mirrors the server's recursive CTE. A missing parent ends the walk rather
 * than throwing: a tree can arrive pruned (a deleted message tombstones, it
 * does not re-parent), and half a transcript beats a blank page.
 */
export function pathToLeaf(tree: readonly Message[], leafId: string | null): Message[] {
  if (leafId === null) return [];
  const byId = new Map(tree.map((m) => [m.id, m]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(leafId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path.reverse();
}

/**
 * Follow the newest child at every step, down from `from` to a leaf.
 *
 * Switching to a sibling only names one message; the transcript below it has
 * to come from somewhere, and "the most recent continuation" is the branch
 * the reader last worked on. The server applies the same rule when it has no
 * cursor.
 */
export function descendToLeaf(children: ChildIndex, from: string): string {
  let current = from;
  const seen = new Set<string>([current]);
  for (;;) {
    const next = children.get(current);
    if (!next || next.length === 0) return current;
    const youngest = next[next.length - 1];
    if (seen.has(youngest.id)) return current;
    seen.add(youngest.id);
    current = youngest.id;
  }
}

/** Where a message sits among its siblings, for the "2 / 3" switcher. */
export interface BranchPosition {
  readonly index: number;
  readonly total: number;
  readonly siblings: readonly Message[];
}

export function branchPosition(children: ChildIndex, message: Message): BranchPosition | null {
  const siblings = children.get(message.parent_id ?? null);
  // One child is not a branch, and a switcher over it would be noise on every
  // message of an ordinary conversation.
  if (!siblings || siblings.length < 2) return null;
  const index = siblings.findIndex((m) => m.id === message.id);
  if (index < 0) return null;
  return { index, total: siblings.length, siblings };
}

/**
 * The leaf to show after stepping from `message` to the sibling `delta` away.
 * Returns null at either end, which is what disables the arrow.
 */
export function siblingLeaf(
  children: ChildIndex,
  message: Message,
  delta: number,
): string | null {
  const position = branchPosition(children, message);
  if (!position) return null;
  const target = position.index + delta;
  if (target < 0 || target >= position.total) return null;
  return descendToLeaf(children, position.siblings[target].id);
}

/**
 * The leaf the transcript should show for a tree, preferring the server's
 * recorded cursor and falling back to the newest leaf -- the same fallback
 * the server makes, so a conversation written before the column renders the
 * same in both places.
 */
export function defaultLeaf(tree: readonly Message[], recorded?: string | null): string | null {
  if (recorded && tree.some((m) => m.id === recorded)) return recorded;
  if (tree.length === 0) return null;
  const children = indexChildren(tree);
  const roots = children.get(null);
  if (!roots || roots.length === 0) return null;
  return descendToLeaf(children, roots[roots.length - 1].id);
}
