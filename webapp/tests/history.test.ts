import { expect, test } from "bun:test";
import { createHistory, type MapSnapshot } from "../src/history";
import {
  deleteNode,
  insertSibling,
  layoutMindMap,
  reorderNode,
  translateSubtree,
  updateNode,
} from "../src/mind-map";
import type { MindMapNode } from "../src/mind-map";

const snapshot = (nodes: MindMapNode[]): MapSnapshot => ({
  nodes,
  selectedId: "a",
  anchor: { id: "a", centerY: 120 },
  sizes: new Map([["a", { width: 140, height: 64 }]]),
});

test("undo restores creation, edits, reorder, movement, and deleted subtrees in order", () => {
  const history = createHistory();
  let nodes: MindMapNode[] = [
    { id: "a", text: "A", next: [{ id: "b", text: "B" }] },
  ];
  const states: MapSnapshot[] = [];
  const change = (next: MindMapNode[]) => {
    const before = snapshot(nodes);
    states.push(before);
    history.record(before, next);
    nodes = next;
  };
  change(insertSibling(nodes, "b", { id: "c", text: "C" }));
  change(updateNode(nodes, "a", (node) => ({ ...node, text: "Edited" })));
  change(reorderNode(nodes, "b", 1));
  change(
    translateSubtree(
      nodes,
      "a",
      new Map(layoutMindMap(nodes).nodes.map((node) => [node.id, node])),
      { x: 80, y: -40 },
    ),
  );
  change(deleteNode(nodes, "a"));
  expect(nodes).toEqual([]);
  for (const state of states.reverse()) {
    const restored = history.undo()!;
    expect(restored).toEqual(state);
    expect(
      layoutMindMap(restored.nodes, restored.sizes, restored.anchor),
    ).toEqual(layoutMindMap(state.nodes, state.sizes, state.anchor));
  }
  expect(history.undo()).toBeUndefined();
});

test("a completed gesture uses one entry and unchanged operations use none", () => {
  const history = createHistory();
  const before = snapshot([{ id: "a", text: "A" }]);
  history.record(before, reorderNode(before.nodes, "a", -1));
  history.record(
    before,
    updateNode(before.nodes, "a", (node) => ({ ...node, text: "A" })),
  );
  expect(history.undo()).toBeUndefined();
  const positions = new Map(
    layoutMindMap(before.nodes).nodes.map((node) => [node.id, node]),
  );
  let dragged = before.nodes;
  for (let x = 1; x <= 150; x++)
    dragged = translateSubtree(before.nodes, "a", positions, { x, y: 30 });
  history.record(before, dragged);
  expect(history.undo()).toEqual(before);
  expect(history.undo()).toBeUndefined();
});

test("only the latest 100 changes remain available", () => {
  const history = createHistory();
  for (let i = 0; i < 105; i++) {
    history.record(snapshot([{ id: "a", text: String(i) }]), [
      { id: "a", text: String(i + 1) },
    ]);
  }
  for (let i = 104; i >= 5; i--)
    expect(history.undo()?.nodes[0].text).toBe(String(i));
  expect(history.undo()).toBeUndefined();
});

test("editing after undo continues from the restored state", () => {
  const history = createHistory();
  const original = snapshot([{ id: "a", text: "Original" }]);
  history.record(original, [{ id: "a", text: "First edit" }]);
  const restored = history.undo()!;
  history.record(restored, [{ id: "a", text: "Replacement edit" }]);
  expect(history.undo()).toEqual(original);
  expect(history.undo()).toBeUndefined();
});

test("clearing history prevents undo from restoring a previous project", () => {
  const history = createHistory();
  history.record(snapshot([{ id: "a", text: "Old project" }]), []);
  history.clear();
  expect(history.undo()).toBeUndefined();
  const current = snapshot([{ id: "b", text: "New project" }]);
  history.record(current, []);
  expect(history.undo()).toEqual(current);
});
