import { describe, expect, test } from "bun:test";
import type { LayoutAnchor, NodeSize } from "../src/mind-map";
import {
  branchIds,
  layoutMindMap,
  newIdeaSpace,
  slotSpace,
  visibleMindMap,
} from "../src/mind-map";
import {
  clearGaps,
  createChild,
  createProjectDocument,
  createRoot,
  createSibling,
  deleteSubtree,
  moveNode,
  projectMindMap,
  reorderNode,
  translateSubtree,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import {
  parseProjectFile,
  prepareProjectImport,
  serializeProjectFile,
} from "../src/project-import-export";

// R ─ P ─ a, b (tall), c
//   └ Q ─ d, e
// S ─ f
// T
function sample() {
  const doc = createProjectDocument(crypto.randomUUID(), "Gaps");
  const ids: Record<string, string> = {};
  const add = (name: string, parent?: string) => {
    ids[name] = parent
      ? createChild(doc, ids[parent], { text: name })
      : createRoot(doc, { text: name });
  };
  add("R");
  add("P", "R");
  for (const name of ["a", "b", "c"]) add(name, "P");
  add("Q", "R");
  for (const name of ["d", "e"]) add(name, "Q");
  add("S");
  add("f", "S");
  add("T");
  doc.clearHistory();
  const sizes = new Map<string, NodeSize>([
    [ids.b, { width: 160, height: 88 }],
    [ids.R, { width: 120, height: 56 }],
  ]);
  return { doc, ids, sizes };
}

type Layout = ReturnType<typeof layoutMindMap>;
const layoutOf = (
  doc: ProjectDocument,
  sizes: ReadonlyMap<string, NodeSize>,
  anchor?: LayoutAnchor,
  collapsed: ReadonlySet<string> = new Set(),
) =>
  layoutMindMap(
    visibleMindMap(projectMindMap(doc.view()), collapsed),
    sizes,
    anchor,
  );
const places = (layout: Layout) =>
  new Map(layout.nodes.map(({ id, x, y }) => [id, { x, y }]));

// Deletes as the app does, holding the layout on an idea that stays, and
// checks that every remaining idea is exactly where it was.
function deleteInPlace(
  doc: ProjectDocument,
  sizes: ReadonlyMap<string, NodeSize>,
  id: string,
  collapsed: ReadonlySet<string> = new Set(),
) {
  const forest = projectMindMap(doc.view());
  const before = layoutOf(doc, sizes, undefined, collapsed);
  const removed = branchIds(forest, id);
  const view = doc.view();
  const parent = view.nodes.find((node) => node.id === id)?.parent;
  const siblings = parent
    ? view.nodes.find((node) => node.id === parent)!.children.length
    : view.roots.length;
  const holder = [...before.anchors].find(
    ([key, anchor]) => !removed.has(key) && anchor.id === key,
  );
  const anchor = holder?.[1];
  expect(
    deleteSubtree(doc, id, slotSpace(before.heights.get(id)!, siblings)),
  ).toBe(true);
  const after = layoutOf(doc, sizes, anchor, collapsed);
  const expected = places(before);
  for (const key of removed) expected.delete(key);
  expect(places(after)).toEqual(expected);
  return { before, anchor };
}

describe("deleting an idea moves no other idea", () => {
  for (const [name, target] of [
    ["a middle child", "b"],
    ["a first child", "a"],
    ["a last child", "c"],
    ["an only child", "f"],
    ["a branch with children", "P"],
    ["a middle top-level idea", "S"],
    ["the first top-level idea", "R"],
    ["the last top-level idea", "T"],
  ] as const)
    test(name, () => {
      const { doc, ids, sizes } = sample();
      const { before, anchor } = deleteInPlace(doc, sizes, ids[target]);
      // Undo restores the document, and with it the layout, exactly.
      doc.dispatch({ type: "undo" });
      expect(layoutOf(doc, sizes, anchor)).toEqual(before);
      doc.destroy();
    });

  test("one deletion after another, down to a single idea", () => {
    const { doc, ids, sizes } = sample();
    for (const name of ["b", "a", "d", "c", "R", "T", "f"])
      deleteInPlace(doc, sizes, ids[name]);
    expect(doc.view().roots).toEqual([ids.S]);
    doc.destroy();
  });

  test("inside and of a dragged branch", () => {
    const { doc, ids, sizes } = sample();
    const start = layoutOf(doc, sizes);
    const positions = new Map(
      start.nodes
        .filter((node) =>
          branchIds(projectMindMap(doc.view()), ids.Q).has(node.id),
        )
        .map((node) => [node.id, { x: node.x, y: node.y }]),
    );
    translateSubtree(doc, ids.Q, positions, { x: 200, y: 300 });
    deleteInPlace(doc, sizes, ids.d);
    deleteInPlace(doc, sizes, ids.Q);
    doc.destroy();
  });

  test("beside and of a folded branch", () => {
    const { doc, ids, sizes } = sample();
    const collapsed = new Set([ids.P]);
    deleteInPlace(doc, sizes, ids.Q, collapsed);
    deleteInPlace(doc, sizes, ids.P, collapsed);
    doc.destroy();
  });
});

describe("deleted space", () => {
  test("a new idea where one was deleted fills its place", () => {
    const { doc, ids, sizes } = sample();
    const { before, anchor } = deleteInPlace(doc, sizes, ids.c);
    const added = createSibling(doc, ids.b, {
      text: "new",
      fill: newIdeaSpace(3),
    });
    const after = places(layoutOf(doc, sizes, anchor));
    for (const [id, place] of places(before))
      expect(after.get(id === ids.c ? added : id)).toEqual(place);
    doc.destroy();
  });

  test("a new idea elsewhere spreads its siblings as before", () => {
    const { doc, ids, sizes } = sample();
    const before = places(layoutOf(doc, sizes));
    createChild(doc, ids.Q, { text: "new", fill: newIdeaSpace(3) });
    const after = places(layoutOf(doc, sizes));
    expect(after.get(ids.d)!.y).toBeLessThan(before.get(ids.d)!.y);
    doc.destroy();
  });

  test("an only child's space stays in its parent until refilled", () => {
    const { doc, ids, sizes } = sample();
    const { before, anchor } = deleteInPlace(doc, sizes, ids.f);
    const added = createChild(doc, ids.S, {
      text: "new",
      fill: newIdeaSpace(1),
    });
    const after = places(layoutOf(doc, sizes, anchor));
    expect(after.get(added)).toEqual(places(before).get(ids.f));
    doc.destroy();
  });

  test("moving an idea leaves its gap where it was", () => {
    const { doc, ids, sizes } = sample();
    deleteInPlace(doc, sizes, ids.a);
    const before = places(layoutOf(doc, sizes));
    reorderNode(doc, ids.b, 1);
    const after = places(layoutOf(doc, sizes));
    // B and C trade places below the kept space; the rest stays.
    expect(after.get(ids.c)!.y).toBe(before.get(ids.b)!.y);
    for (const name of ["R", "P", "Q", "d", "e", "S", "f", "T"])
      expect(after.get(ids[name])).toEqual(before.get(ids[name]));
    moveNode(doc, ids.c, ids.S, 0);
    expect(projectMindMap(doc.view())[1].next?.[0].gap).toBeUndefined();
    doc.destroy();
  });

  test("returning to automatic placement closes kept space", () => {
    const { doc, ids, sizes } = sample();
    const fresh = layoutOf(doc, sizes);
    deleteInPlace(doc, sizes, ids.e);
    deleteInPlace(doc, sizes, ids.a);
    const spaced = [...branchIds(projectMindMap(doc.view()), ids.R)];
    expect(clearGaps(doc, spaced)).toBe(true);
    const closed = places(layoutOf(doc, sizes));
    // R's branch closes up, so the ideas below it move up.
    expect(closed.get(ids.S)!.y).toBeLessThan(places(fresh).get(ids.S)!.y);
    expect(projectMindMap(doc.view())[0].next?.[1].endGap).toBeUndefined();
    doc.destroy();
  });

  test("backups keep the space", () => {
    const { doc, ids, sizes } = sample();
    deleteInPlace(doc, sizes, ids.b);
    deleteInPlace(doc, sizes, ids.e);
    const file = parseProjectFile(serializeProjectFile(doc.view()));
    const { content } = prepareProjectImport(file);
    const restored = projectMindMap(content);
    const original = projectMindMap(doc.view());
    const strip = (nodes: typeof original): unknown =>
      nodes.map(({ gap, endGap, next }) => ({
        gap,
        endGap,
        next: strip(next ?? []),
      }));
    expect(strip(restored)).toEqual(strip(original));
    doc.destroy();
  });
});
