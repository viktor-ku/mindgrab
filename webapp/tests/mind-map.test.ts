import { describe, expect, test } from "bun:test";
import type { MindMapNode } from "../src/mind-map";
import {
  connectionPath,
  findNode,
  layoutMindMap,
  translateSubtree,
} from "../src/mind-map";

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

describe("free positioning", () => {
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

  test("child insertion and measured sizes preserve the parent's center and connections", () => {
    const original = tree();
    const before = layoutMindMap(original);
    const parent = nodeAt(before, "b");
    const anchor = { id: parent.id, centerY: centerY(parent) };
    const current = tree();
    current[0].next![0].next!.push({ id: "new", text: "New" });
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
      [...original, { id: "new", text: "New" }],
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
      // Canceling the drag discards the preview and restores the original layout.
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
    const current = structuredClone(moved);
    current[0].next![0].next!.push({ id: "new", text: "New" });
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
