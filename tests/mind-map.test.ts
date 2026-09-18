import { describe, expect, test } from "bun:test";
import { deleteNode, findNode, insertSibling, moveNode, reorderNode } from "../src/mind-map";
import type { MindMapNode } from "../src/mind-map";

const tree = (): MindMapNode[] => [
  { id: "a", text: "A", next: [
    { id: "b", text: "B", next: [{ id: "c", text: "C" }] },
    { id: "d", text: "D" },
  ] },
  { id: "e", text: "E" },
];
const ids = (nodes: MindMapNode[]) => nodes.map((node) => node.id);

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
