import { describe, expect, test } from "bun:test";
import { connectionPath, deleteNode, findNode, insertSibling, layoutMindMap, moveNode, reorderNode, translateSubtree } from "../src/mind-map";
import type { MindMapNode } from "../src/mind-map";

const tree = (): MindMapNode[] => [
  { id: "a", text: "A", next: [
    { id: "b", text: "B", next: [{ id: "c", text: "C" }] },
    { id: "d", text: "D" },
  ] },
  { id: "e", text: "E" },
];
const ids = (nodes: MindMapNode[]) => nodes.map((node) => node.id);

describe("free positioning", () => {
  const positions = (nodes: MindMapNode[]) => new Map(layoutMindMap(nodes).nodes.map((node) => [node.id, node]));
  const edges = (nodes: MindMapNode[]) => layoutMindMap(nodes).connections.map(({ from, to }) => [from.id, to.id]);

  test("moving a parent translates every descendant and preserves unrelated nodes and connections", () => {
    const original = tree();
    const before = positions(original);
    const moved = translateSubtree(original, "a", before, { x: -250, y: 135 });
    const after = positions(moved);
    for (const id of ["a", "b", "c", "d"]) {
      expect(after.get(id)?.x).toBe(before.get(id)!.x - 250);
      expect(after.get(id)?.y).toBe(before.get(id)!.y + 135);
    }
    expect(after.get("e")).toEqual(before.get("e"));
    expect(edges(moved)).toEqual(edges(original));
    expect(findNode(original, "a")?.position).toBeUndefined();
  });

  test("moving a child retains its parent and siblings, including when dropped over another node", () => {
    const original = tree();
    const before = positions(original);
    const delta = { x: before.get("e")!.x - before.get("b")!.x, y: before.get("e")!.y - before.get("b")!.y };
    const moved = translateSubtree(original, "b", before, delta);
    const after = positions(moved);
    for (const id of ["a", "d", "e"]) expect(after.get(id)).toEqual(before.get(id));
    for (const id of ["b", "c"]) {
      expect(after.get(id)?.x).toBe(before.get(id)!.x + delta.x);
      expect(after.get(id)?.y).toBe(before.get(id)!.y + delta.y);
    }
    expect(edges(moved)).toEqual(edges(original));
  });

  test("a manually positioned descendant moves exactly once with its parent", () => {
    const original = tree();
    const childMoved = translateSubtree(original, "c", positions(original), { x: -600, y: -200 });
    const before = positions(childMoved);
    const parentMoved = translateSubtree(childMoved, "a", before, { x: 45.5, y: -32.25 });
    expect(positions(parentMoved).get("c")?.x).toBe(before.get("c")!.x + 45.5);
    expect(positions(parentMoved).get("c")?.y).toBe(before.get("c")!.y - 32.25);
    expect(edges(parentMoved)).toEqual(edges(original));
  });

  test("manual placement survives content resizing and new children are placed next to their moved parent", () => {
    const original = tree();
    const moved = translateSubtree(original, "b", positions(original), { x: -450, y: 220 });
    const before = positions(moved);
    const resized = layoutMindMap(moved, new Map([["b", { width: 160, height: 88 }]]));
    for (const id of ["b", "c"]) {
      const node = resized.nodes.find((node) => node.id === id)!;
      expect({ x: node.x, y: node.y }).toEqual(findNode(moved, id)!.position!);
    }
    const extended = insertSibling(moved, "c", { id: "new", text: "New" });
    expect(positions(extended).get("new")!.x).toBe(before.get("b")!.x + before.get("b")!.width + 64);
    expect(positions(extended).get("new")!.y).toBeGreaterThan(before.get("b")!.y);
  });

  test("connectors bend and attach to facing borders in all directions", () => {
    const from = { id: "a", text: "A", x: 0, y: 0, width: 100, height: 40 };
    for (const [x, y, startX, startY, endX, endY] of [
      [200, 0, 100, 20, 200, 20], [-200, 0, 0, 20, -100, 20],
      [0, 200, 50, 40, 50, 200], [0, -200, 50, 0, 50, -160],
    ]) {
      const path = connectionPath({ from, to: { ...from, id: "b", x, y } });
      expect(path.startsWith(`M ${startX} ${startY} Q `)).toBe(true);
      expect(path.endsWith(`, ${endX} ${endY}`)).toBe(true);
      const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect((endX - startX) * (values[3] - startY) - (endY - startY) * (values[2] - startX)).not.toBe(0);
    }
    expect(connectionPath({ from, to: from })).not.toMatch(/NaN|Infinity/);
  });
});

describe("editing a tree", () => {
  test("deleting a node removes every descendant, preserving unrelated branches", () => {
    const original = tree();
    const result = deleteNode(original, "b");
    expect(findNode(result, "b")).toBeUndefined();
    expect(findNode(result, "c")).toBeUndefined();
    expect(ids(result[0].next!)).toEqual(["d"]);
    expect(ids(result)).toEqual(["a", "e"]);
    expect(findNode(original, "c")).toBeDefined();
  });
  test("the final subtree can be deleted", () => {
    expect(deleteNode([tree()[0]], "a")).toEqual([]);
    expect(deleteNode([{ id: "a", text: "A" }], "a")).toEqual([]);
  });
  test("inserting siblings works at child and root level", () => {
    const sibling = { id: "new", text: "New" };
    expect(ids(insertSibling(tree(), "b", sibling)[0].next!)).toEqual(["b", "new", "d"]);
    expect(ids(insertSibling(tree(), "a", sibling))).toEqual(["a", "new", "e"]);
  });
  test("reordering swaps only adjacent siblings, retaining their descendants", () => {
    const original = tree();
    const result = reorderNode(original, "b", 1);
    expect(ids(result[0].next!)).toEqual(["d", "b"]);
    expect(findNode(result, "b")?.next?.[0].id).toBe("c");
    expect(ids(reorderNode(original, "e", -1))).toEqual(["e", "a"]);
    expect(reorderNode(original, "a", -1)).toEqual(original);
    expect(reorderNode(original, "d", 1)).toEqual(original);
    expect(ids(original[0].next!)).toEqual(["b", "d"]);
  });
});

describe("dragging subtrees", () => {
  test("reparenting carries descendants and removes the old reference", () => {
    const original = tree();
    const result = moveNode(original, "b", { id: "e", placement: "child" });
    expect(ids(result[0].next!)).toEqual(["d"]);
    expect(findNode(result, "e")?.next?.[0]).toEqual(original[0].next![0]);
    expect(findNode(original, "a")?.next).toHaveLength(2);
  });
  test("edges insert before and after a target, across hierarchy levels", () => {
    const before = moveNode(tree(), "b", { id: "e", placement: "before" });
    expect(ids(before)).toEqual(["a", "b", "e"]);
    const after = moveNode(tree(), "e", { id: "b", placement: "after" });
    expect(ids(after)).toEqual(["a"]);
    expect(ids(after[0].next!)).toEqual(["b", "e", "d"]);
  });
  test("dropping on self, descendants, or stale targets is a lossless no-op", () => {
    const original = tree();
    for (const placement of ["child", "before", "after"] as const) {
      for (const id of ["a", "b", "c", "missing"]) {
        expect(moveNode(original, "a", { id, placement })).toBe(original);
      }
    }
    expect(moveNode(original, "missing", { placement: "root" })).toBe(original);
  });
  test("detach then reparent can invert an ancestor relationship safely", () => {
    const detached = moveNode(tree(), "b", { placement: "root" });
    expect(ids(detached)).toEqual(["a", "e", "b"]);
    const inverted = moveNode(detached, "a", { id: "b", placement: "child" });
    expect(ids(inverted)).toEqual(["e", "b"]);
    expect(ids(findNode(inverted, "b")!.next!)).toEqual(["c", "a"]);
    expect(findNode(inverted, "a")?.next?.[0].id).toBe("d");
  });
});
