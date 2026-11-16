import { expect, test } from "bun:test";
import type { LayoutAnchor, NodeSize } from "../src/mind-map";
import {
  branchIds,
  layoutMindMap,
  newIdeaSpace,
  slotSpace,
  visibleMindMap,
} from "../src/mind-map";
import {
  createChild,
  createProjectDocument,
  createRoot,
  createSibling,
  deleteSubtree,
  projectMindMap,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";

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

test("one deletion after another, down to a single idea", () => {
  const { doc, ids, sizes } = sample();
  for (const name of ["b", "a", "d", "c", "R", "T", "f"])
    deleteInPlace(doc, sizes, ids[name]);
  expect(doc.view().roots).toEqual([ids.S]);
  doc.destroy();
});

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
