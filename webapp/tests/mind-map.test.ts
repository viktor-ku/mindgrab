import { expect, test } from "bun:test";
import type { MindMapNode } from "../src/mind-map";
import {
  connectionParts,
  connectionPath,
  layoutMindMap,
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
    const onBorder = (node: typeof connection.from, x: number, y: number) =>
      Math.max(
        Math.abs(x - node.x - node.width / 2) / (node.width / 2),
        Math.abs(y - node.y - node.height / 2) / (node.height / 2),
      );
    for (const style of ["freeform", "rounded", "square"] as const) {
      const values = connectionPath(connection, style)
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number);
      expect(onBorder(connection.from, values[0], values[1])).toBeCloseTo(1);
      expect(
        onBorder(connection.to, values[values.length - 2], values.at(-1) ?? 0),
      ).toBeCloseTo(1);
    }
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
  expect(layoutMindMap([], new Map(), { id: "missing", centerY: 100 })).toEqual(
    {
      nodes: [],
      connections: [],
      anchors: new Map(),
      heights: new Map(),
    },
  );
  expect(
    layoutMindMap(original, new Map(), { id: "missing", centerY: 100 }),
  ).toEqual(before);
});

test("children placed by hand keep the map's connection style", () => {
  const box = (id: string, x: number, y: number) => ({
    id,
    text: id,
    x,
    y,
    width: 80,
    height: 40,
  });
  const parent = box("parent", 0, 0);
  const placed = [
    box("left", -200, 90),
    box("above", 20, -160),
    box("below", -30, 140),
  ];
  const onBorder = (node: typeof parent, x: number, y: number) =>
    Math.max(
      Math.abs(x - node.x - node.width / 2) / (node.width / 2),
      Math.abs(y - node.y - node.height / 2) / (node.height / 2),
    );
  for (const to of placed) {
    const square = connectionPath({ from: parent, to }, "square");
    // Square turns are corners: only straight legs, each along one axis.
    expect(square).toMatch(/^M [-\d.]+ [-\d.]+( L [-\d.]+ [-\d.]+)+$/);
    const points = [...square.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(
      ([, x, y]) => [Number(x), Number(y)],
    );
    for (let index = 1; index < points.length; index++)
      expect(
        points[index][0] === points[index - 1][0] ||
          points[index][1] === points[index - 1][1],
      ).toBe(true);
    expect(connectionPath({ from: parent, to }, "rounded")).toContain("Q");
    for (const style of ["freeform", "rounded", "square"] as const) {
      const values = connectionPath({ from: parent, to }, style)
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number);
      expect(onBorder(parent, values[0], values[1])).toBeCloseTo(1);
      expect(
        onBorder(to, values[values.length - 2], values.at(-1) ?? 0),
      ).toBeCloseTo(1);
    }
  }
});

test("a tree's arm starts on the spine and alone carries the child's color", () => {
  const box = (id: string, x: number, y: number) => ({
    id,
    text: id,
    x,
    y,
    width: 80,
    height: 40,
  });
  const parent = box("parent", 0, 0);
  const child = box("child", 144, 120);
  for (const style of ["rounded", "square"] as const) {
    const { shared, arm } = connectionParts({ from: parent, to: child }, style);
    // The shared part ends where the arm starts, on the spine beside the parent.
    const end = shared!
      .match(/(-?[\d.]+) (-?[\d.]+)$/)!
      .slice(1)
      .map(Number);
    const start = arm
      .match(/^M (-?[\d.]+) (-?[\d.]+)/)!
      .slice(1)
      .map(Number);
    expect(start).toEqual(end);
    expect(start[0]).toBe(80 + 24);
  }
  expect(
    connectionParts({ from: parent, to: child }, "freeform").shared,
  ).toBeUndefined();
});
