import { Y } from "./project-document";
import {
  addNode,
  createDocument,
  deleteObservedSubtree,
  materialize,
  present,
  nodeMap,
  openDocument,
  ORIGIN,
  placeNode,
  projectForest,
  type NodeValue,
} from "./project-document";
export const PROJECT = "10000000-0000-4000-8000-000000000000";
export const ID = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const node = (
  text: string,
  parent: string | null = null,
  rank = "a0",
): NodeValue => ({
  text,
  placement: { parent, rank },
  deleted: false,
  color: "blue",
});
export function base() {
  const doc = createDocument(PROJECT, "Ideas 🌍", 1);
  addNode(doc, ID(1), {
    ...node("A😀é中B"),
    position: { x: 12.5, y: -8 },
    color: "teal",
  });
  addNode(doc, ID(2), node("Child", ID(1)));
  addNode(doc, ID(3), node("Other root", null, "a1"));
  return doc;
}
export function fork(doc: Y.Doc, client: number) {
  return openDocument(PROJECT, Y.encodeStateAsUpdate(doc), client);
}
export function capture(doc: Y.Doc, action: () => void) {
  const updates: Uint8Array[] = [];
  const observer = (update: Uint8Array) => updates.push(update);
  doc.on("update", observer);
  action();
  doc.off("update", observer);
  return updates;
}
export function text(doc: Y.Doc, id = ID(1)): Y.Text {
  return present(nodeMap(doc).get(id)).get("text") as Y.Text;
}
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
export function shuffle<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export type Scenario = {
  name: string;
  updates: Uint8Array[];
  expected: ReturnType<typeof materialize>;
  forest: ReturnType<typeof projectForest>;
};
export function scenarios(): Scenario[] {
  const cases: Scenario[] = [];
  const add = (name: string, updates: Uint8Array[]) => {
    const doc = new Y.Doc();
    for (const update of updates) Y.applyUpdate(doc, update);
    const expected = materialize(doc);
    cases.push({ name, updates, expected, forest: projectForest(expected) });
    doc.destroy();
  };
  const doc = base();
  const initial = Y.encodeStateAsUpdate(doc);
  add("unicode", [initial]);
  const left = fork(doc, 2);
  const right = fork(doc, 3);
  const edits = capture(left, () => {
    left.transact(() => text(left).insert(3, "✨"), ORIGIN.local);
    left.transact(() => text(left).delete(1, 2), ORIGIN.local);
  });
  add("text-causal-reversal", [initial, edits[1], edits[0], edits[1]]);
  const deletion = capture(right, () =>
    right.transact(() => text(right).delete(1, 2), ORIGIN.local),
  );
  add("delete-only", [initial, ...deletion, ...deletion]);
  const a = fork(doc, 4);
  const b = fork(doc, 5);
  const au = capture(a, () => {
    placeNode(a, ID(1), ID(3), 0);
    deleteObservedSubtree(a, ID(2));
  });
  const bu = capture(b, () => {
    placeNode(b, ID(3), ID(1), 0); // Concurrently creates a cycle with a's move.
    addNode(b, ID(4), node("Concurrent survivor", ID(2)));
  });
  add("move-delete-cycle", [initial, ...au, ...bu]);
  add("move-delete-cycle-reversed", [
    initial,
    ...bu.toReversed(),
    ...au.toReversed(),
    ...bu,
  ]);
  const c = fork(doc, 6);
  const d = fork(doc, 7);
  const cu = capture(c, () => {
    addNode(c, ID(5), node("Equal A", null, "a0"));
    placeNode(c, ID(3), ID(1), 0);
  });
  const du = capture(d, () => {
    addNode(d, ID(6), node("Equal B", null, "a0"));
    placeNode(d, ID(3), null, 0);
  });
  add("equal-ranks-conflicting-move", [initial, ...cu, ...du]);
  const repeated = fork(doc, 8);
  for (let i = 10; i < 34; i++) {
    addNode(repeated, ID(i), node(`Insertion ${i}`));
    placeNode(repeated, ID(i), null, 1);
  }
  add("repeated-insertion", [Y.encodeStateAsUpdate(repeated)]);
  for (const item of [doc, left, right, a, b, c, d, repeated]) item.destroy();
  return cases;
}
