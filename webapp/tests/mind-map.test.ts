import { describe, expect, test } from "bun:test";
import {
  connectionPath,
  deleteNode,
  findNode,
  insertSibling,
  layoutMindMap,
  moveNode,
  navigationTarget,
  reorderNode,
  translateSubtree,
  updateNode,
} from "../src/mind-map";
import type { MindMapNode } from "../src/mind-map";

const tree = (): MindMapNode[] => [
  {
    id: "a",
    text: "A",
    next: [
      { id: "b", text: "B", next: [{ id: "c", text: "C" }] },
      { id: "d", text: "D" },
    ],
  },
  { id: "e", text: "E" },
];
const ids = (nodes: MindMapNode[]) => nodes.map((node) => node.id);

describe("free positioning", () => {
  const positions = (nodes: MindMapNode[]) =>
    new Map(layoutMindMap(nodes).nodes.map((node) => [node.id, node]));
  const edges = (nodes: MindMapNode[]) =>
    layoutMindMap(nodes).connections.map(({ from, to }) => [from.id, to.id]);

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
    const delta = {
      x: before.get("e")!.x - before.get("b")!.x,
      y: before.get("e")!.y - before.get("b")!.y,
    };
    const moved = translateSubtree(original, "b", before, delta);
    const after = positions(moved);
    for (const id of ["a", "d", "e"])
      expect(after.get(id)).toEqual(before.get(id));
    for (const id of ["b", "c"]) {
      expect(after.get(id)?.x).toBe(before.get(id)!.x + delta.x);
      expect(after.get(id)?.y).toBe(before.get(id)!.y + delta.y);
    }
    expect(edges(moved)).toEqual(edges(original));
  });

  test("a manually positioned descendant moves exactly once with its parent", () => {
    const original = tree();
    const childMoved = translateSubtree(original, "c", positions(original), {
      x: -600,
      y: -200,
    });
    const before = positions(childMoved);
    const parentMoved = translateSubtree(childMoved, "a", before, {
      x: 45.5,
      y: -32.25,
    });
    expect(positions(parentMoved).get("c")?.x).toBe(before.get("c")!.x + 45.5);
    expect(positions(parentMoved).get("c")?.y).toBe(before.get("c")!.y - 32.25);
    expect(edges(parentMoved)).toEqual(edges(original));
  });

  test("manual placement survives content resizing and new children are placed next to their moved parent", () => {
    const original = tree();
    const moved = translateSubtree(original, "b", positions(original), {
      x: -450,
      y: 220,
    });
    const before = positions(moved);
    const resized = layoutMindMap(
      moved,
      new Map([["b", { width: 160, height: 88 }]]),
    );
    for (const id of ["b", "c"]) {
      const node = resized.nodes.find((node) => node.id === id)!;
      expect({ x: node.x, y: node.y }).toEqual(findNode(moved, id)!.position!);
    }
    const extended = insertSibling(moved, "c", { id: "new", text: "New" });
    expect(positions(extended).get("new")!.x).toBe(
      before.get("b")!.x + before.get("b")!.width + 64,
    );
    expect(positions(extended).get("new")!.y).toBeGreaterThan(
      before.get("b")!.y,
    );
  });

  test("connectors bend and attach to facing borders in all directions", () => {
    const from = { id: "a", text: "A", x: 0, y: 0, width: 100, height: 40 };
    for (const [x, y, startX, startY, endX, endY] of [
      [200, 0, 100, 20, 200, 20],
      [-200, 0, 0, 20, -100, 20],
      [0, 200, 50, 40, 50, 200],
      [0, -200, 50, 0, 50, -160],
    ]) {
      const path = connectionPath({ from, to: { ...from, id: "b", x, y } });
      expect(path.startsWith(`M ${startX} ${startY} Q `)).toBe(true);
      expect(path.endsWith(`, ${endX} ${endY}`)).toBe(true);
      const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(
        (endX - startX) * (values[3] - startY) -
          (endY - startY) * (values[2] - startX),
      ).not.toBe(0);
    }
    expect(connectionPath({ from, to: from })).not.toMatch(/NaN|Infinity/);
  });
});

describe("layout stability", () => {
  const nodeAt = (layout: ReturnType<typeof layoutMindMap>, id: string) =>
    layout.nodes.find((node) => node.id === id)!;
  const centerY = (node: { y: number; height: number }) =>
    node.y + node.height / 2;

  test("adding a sibling spreads children around a stationary root", () => {
    const original = [
      { id: "parent", text: "Parent", next: [{ id: "one", text: "One" }] },
    ];
    const before = layoutMindMap(original);
    const after = layoutMindMap(
      insertSibling(original, "one", { id: "two", text: "Two" }),
    );
    expect(nodeAt(after, "parent")).toEqual(nodeAt(before, "parent"));
    expect(nodeAt(after, "one").y).toBeLessThan(nodeAt(before, "one").y);
    expect(centerY(nodeAt(after, "parent"))).toBe(
      (centerY(nodeAt(after, "one")) + centerY(nodeAt(after, "two"))) / 2,
    );
  });

  test("adding siblings keeps a nested parent stationary and branches separated", () => {
    let current = tree();
    let layout = layoutMindMap(current);
    const parent = nodeAt(layout, "b");
    const anchor = { id: parent.id, centerY: centerY(parent) };
    for (const id of ["new-1", "new-2", "new-3"]) {
      current = insertSibling(current, "c", { id, text: id });
      layout = layoutMindMap(current, new Map(), anchor);
      expect(nodeAt(layout, "b")).toEqual(parent);
      const children = findNode(current, "b")!.next!.map((child) =>
        nodeAt(layout, child.id),
      );
      expect(centerY(parent)).toBe(
        (children[0].y + children.at(-1)!.y + children.at(-1)!.height) / 2,
      );
      for (let i = 1; i < children.length; i++) {
        expect(
          children[i].y - (children[i - 1].y + children[i - 1].height),
        ).toBeGreaterThanOrEqual(24);
      }
      expect(nodeAt(layout, "d").y).toBeGreaterThanOrEqual(
        children.at(-1)!.y + children.at(-1)!.height + 24,
      );
      expect(nodeAt(layout, "e").y).toBeGreaterThanOrEqual(
        nodeAt(layout, "d").y + nodeAt(layout, "d").height + 24,
      );
    }
  });

  test("child insertion and measured sizes preserve the parent's center and connections", () => {
    const original = tree();
    const before = layoutMindMap(original);
    const parent = nodeAt(before, "b");
    const anchor = { id: parent.id, centerY: centerY(parent) };
    const current = updateNode(original, "b", (node) => ({
      ...node,
      next: [...node.next!, { id: "new", text: "New" }],
    }));
    const sizes = new Map([
      ["new", { width: 160, height: 120 }],
      ["b", { width: 100, height: 64 }],
    ]);
    const after = layoutMindMap(current, sizes, anchor);
    expect(centerY(nodeAt(after, "b"))).toBe(centerY(parent));
    expect(nodeAt(after, "new").y).toBeGreaterThanOrEqual(
      nodeAt(after, "c").y + nodeAt(after, "c").height + 24,
    );
    for (const connection of after.connections) {
      expect(connection.from).toBe(nodeAt(after, connection.from.id));
      expect(connection.to).toBe(nodeAt(after, connection.to.id));
      const values = connectionPath(connection)
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number);
      const onBorder = (node: typeof connection.from, x: number, y: number) =>
        Math.max(
          Math.abs(x - node.x - node.width / 2) / (node.width / 2),
          Math.abs(y - node.y - node.height / 2) / (node.height / 2),
        );
      expect(onBorder(connection.from, values[0], values[1])).toBeCloseTo(1);
      expect(onBorder(connection.to, values[4], values[5])).toBeCloseTo(1);
    }
  });

  test("root siblings, empty maps, and removed anchors have valid layouts", () => {
    const original = tree();
    const before = layoutMindMap(original);
    const root = nodeAt(before, "e");
    const after = layoutMindMap(
      insertSibling(original, "e", { id: "new", text: "New" }),
      new Map(),
      {
        id: root.id,
        centerY: centerY(root),
      },
    );
    expect(nodeAt(after, "e")).toEqual(root);
    expect(nodeAt(after, "new").y).toBeGreaterThanOrEqual(
      root.y + root.height + 24,
    );
    expect(
      layoutMindMap([], new Map(), { id: "missing", centerY: 100 }),
    ).toEqual({ nodes: [], connections: [] });
    expect(
      layoutMindMap(original, new Map(), { id: "missing", centerY: 100 }),
    ).toEqual(before);
  });

  test("adding a root keeps existing trees in place and leaves room between them", () => {
    const original = tree();
    const before = layoutMindMap(original);
    const firstRoot = nodeAt(before, "a");
    const after = layoutMindMap(
      [...original, { id: "new-root", text: "New idea" }],
      new Map(),
      { id: firstRoot.id, centerY: centerY(firstRoot) },
    );

    for (const node of before.nodes) {
      expect(nodeAt(after, node.id)).toEqual(node);
    }
    expect(nodeAt(after, "new-root").y).toBeGreaterThanOrEqual(
      nodeAt(after, "e").y + nodeAt(after, "e").height + 24,
    );
  });

  test("dragging an anchored parent takes precedence and leaves other branches in place", () => {
    const original = tree();
    const before = layoutMindMap(original);
    for (const id of ["a", "b"]) {
      const anchor = { id, centerY: centerY(nodeAt(before, id)) };
      const positions = new Map(before.nodes.map((node) => [node.id, node]));
      const moved = translateSubtree(original, id, positions, {
        x: -120,
        y: 175,
      });
      const after = layoutMindMap(moved, new Map(), anchor);
      for (const node of after.nodes) {
        const previous = nodeAt(before, node.id);
        const delta = findNode([findNode(original, id)!], node.id)
          ? { x: -120, y: 175 }
          : { x: 0, y: 0 };
        expect(node.x).toBe(previous.x + delta.x);
        expect(node.y).toBe(previous.y + delta.y);
      }
      // Restoring the drag snapshot (Escape/cancel) restores the anchored layout.
      expect(layoutMindMap(original, new Map(), anchor)).toEqual(before);
    }
  });

  test("adding siblings beside a manually moved branch preserves its saved positions", () => {
    const original = tree();
    const before = layoutMindMap(original);
    const moved = translateSubtree(
      original,
      "b",
      new Map(before.nodes.map((node) => [node.id, node])),
      { x: 75, y: -150 },
    );
    const parent = nodeAt(layoutMindMap(moved), "b");
    const current = insertSibling(moved, "c", { id: "new", text: "New" });
    const after = layoutMindMap(current, new Map(), {
      id: "b",
      centerY: centerY(parent),
    });
    expect(nodeAt(after, "b")).toEqual(parent);
    for (const id of ["b", "c"]) {
      const node = nodeAt(after, id);
      expect({ x: node.x, y: node.y }).toEqual(findNode(moved, id)!.position!);
    }
    expect(nodeAt(after, "new").x).toBe(parent.x + parent.width + 64);
    expect(nodeAt(after, "new").y).toBeGreaterThan(parent.y);
  });
});

describe("arrow-key navigation", () => {
  test("right descends to the first child, left returns to the parent", () => {
    const original = tree();
    expect(navigationTarget(original, "a", "right")).toBe("b");
    expect(navigationTarget(original, "b", "right")).toBe("c");
    expect(navigationTarget(original, "c", "right")).toBeUndefined();
    expect(navigationTarget(original, "e", "right")).toBeUndefined();
    expect(navigationTarget(original, "c", "left")).toBe("b");
    expect(navigationTarget(original, "d", "left")).toBe("a");
    expect(navigationTarget(original, "a", "left")).toBeUndefined();
    expect(navigationTarget(original, "e", "left")).toBeUndefined();
  });

  test("up and down move between adjacent siblings at any depth", () => {
    const original = tree();
    expect(navigationTarget(original, "d", "up")).toBe("b");
    expect(navigationTarget(original, "b", "down")).toBe("d");
    expect(navigationTarget(original, "b", "up")).toBeUndefined();
    expect(navigationTarget(original, "d", "down")).toBeUndefined();
    expect(navigationTarget(original, "a", "down")).toBe("e");
    expect(navigationTarget(original, "e", "up")).toBe("a");
    expect(navigationTarget(original, "a", "up")).toBeUndefined();
    expect(navigationTarget(original, "e", "down")).toBeUndefined();
    expect(navigationTarget(original, "c", "up")).toBeUndefined();
    expect(navigationTarget(original, "c", "down")).toBeUndefined();
  });

  test("unknown ids have no target", () => {
    const original = tree();
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(navigationTarget(original, "missing", direction)).toBeUndefined();
    }
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
    expect(ids(insertSibling(tree(), "b", sibling)[0].next!)).toEqual([
      "b",
      "new",
      "d",
    ]);
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
