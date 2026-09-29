import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addNode,
  createDocument,
  createUndoManager,
  deleteObservedSubtree,
  effectiveParents,
  LIMITS,
  materialize,
  present,
  nodeMap,
  openDocument,
  ORIGIN,
  placeNode,
  projectForest,
  validateContent,
} from "./contract";
import {
  exportJSON,
  exportRecovery,
  importJSON,
  importRecovery,
} from "./formats";
import {
  base,
  capture,
  fork,
  ID,
  node,
  PROJECT,
  scenarios,
  text,
} from "./scenarios";

test("opening and projection never reseed shared types or emit updates", () => {
  const doc = base();
  const bytes = Y.encodeStateAsUpdate(doc);
  const opened = openDocument(PROJECT, bytes, 20);
  expect(
    capture(opened, () => {
      materialize(opened);
      projectForest(materialize(opened));
      nodeMap(opened);
    }),
  ).toHaveLength(0);
  expect(Y.encodeStateAsUpdate(opened)).toEqual(bytes);
  expect(materialize(opened)).toEqual(materialize(doc));
  const empty = new Y.Doc();
  expect(() => materialize(empty)).toThrow();
  for (const item of [doc, opened, empty]) item.destroy();
});
test("session undo/redo tracks local origins and preserves remote edits", () => {
  const doc = base();
  const undo = createUndoManager(doc);
  const remote = fork(doc, 9);
  doc.transact(() => text(doc).insert(0, "local "), ORIGIN.local);
  const updates = capture(remote, () =>
    remote.transact(
      () => text(remote).insert(text(remote).length, " remote"),
      ORIGIN.local,
    ),
  );
  for (const update of updates) Y.applyUpdate(doc, update, ORIGIN.remote);
  expect(undo.undoStack).toHaveLength(1);
  undo.undo();
  expect(text(doc).toString()).toBe("A😀é中B remote");
  undo.redo();
  expect(text(doc).toString()).toBe("local A😀é中B remote");
  const reopened = openDocument(PROJECT, Y.encodeStateAsUpdate(doc));
  const fresh = createUndoManager(reopened);
  expect(fresh.undoStack).toHaveLength(0);
  fresh.destroy();
  undo.destroy();
  for (const item of [doc, remote, reopened]) item.destroy();
});
test("observed deletion wins over concurrent move; unseen child survives as root", () => {
  const doc = base();
  const remote = fork(doc, 22);
  deleteObservedSubtree(doc, ID(1));
  placeNode(remote, ID(2), ID(3), 0);
  addNode(remote, ID(4), node("survivor", ID(2)));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
  const content = materialize(doc);
  expect(content.nodes[ID(1)].deleted).toBe(true);
  expect(content.nodes[ID(2)].deleted).toBe(true);
  expect(effectiveParents(content).get(ID(4))).toBeNull();
  expect(projectForest(content).map((n) => n.id)).toEqual([ID(4), ID(3)]);
  doc.destroy();
  remote.destroy();
});
test("cycles detach the smallest UUID; missing parents and self-cycles become roots without writes", () => {
  const doc = base();
  present(nodeMap(doc).get(ID(1))).set("placement", {
    parent: ID(3),
    rank: "a0",
  });
  present(nodeMap(doc).get(ID(3))).set("placement", {
    parent: ID(1),
    rank: "a1",
  });
  addNode(doc, ID(4), node("orphan", ID(99)));
  addNode(doc, ID(5), node("self", ID(5)));
  const parents = effectiveParents(materialize(doc));
  expect(parents.get(ID(1))).toBeNull();
  expect(parents.get(ID(3))).toBe(ID(1));
  expect(parents.get(ID(4))).toBeNull();
  expect(parents.get(ID(5))).toBeNull();
  expect(capture(doc, () => projectForest(materialize(doc)))).toHaveLength(0);
  expect(() => placeNode(doc, ID(1), ID(2), 0)).toThrow("own subtree");
  doc.destroy();
});
test("equal ranks use UUID ordering; insertion re-spaces in one undoable transaction", () => {
  const doc = base();
  addNode(doc, ID(4), node("equal", null, "a0"));
  expect(projectForest(materialize(doc)).map((n) => n.id)).toEqual([
    ID(1),
    ID(4),
    ID(3),
  ]);
  const before = materialize(doc);
  const undo = createUndoManager(doc);
  placeNode(doc, ID(3), null, 1);
  expect(projectForest(materialize(doc)).map((n) => n.id)).toEqual([
    ID(1),
    ID(3),
    ID(4),
  ]);
  expect(undo.undoStack).toHaveLength(1);
  undo.undo();
  expect(materialize(doc)).toEqual(before);
  undo.destroy();
  doc.destroy();
});
test("400 repeated insertions preserve ordering and bounded rank lengths", () => {
  const doc = base();
  for (let i = 4; i < 404; i++) {
    addNode(doc, ID(i), node(String(i)));
    placeNode(doc, ID(i), null, 1);
  }
  const content = materialize(doc);
  expect(
    projectForest(content)
      .slice(0, 3)
      .map((n) => n.id),
  ).toEqual([ID(1), ID(403), ID(402)]);
  expect(
    Object.values(content.nodes).every(
      (n) => n.placement.rank.length <= LIMITS.rank,
    ),
  ).toBe(true);
  doc.destroy();
});
test("schema rejects invalid versions, IDs, positions, names, text, local fields, and shared types", () => {
  const doc = base();
  const content = materialize(doc);
  expect(() => validateContent({ ...content, schemaVersion: 2 })).toThrow(
    "Unsupported schema",
  );
  expect(() => validateContent({ ...content, view: { zoom: 1 } })).toThrow(
    "Unknown schema",
  );
  expect(() =>
    validateContent({ ...content, nodes: { bad: node("bad") } }),
  ).toThrow("UUID");
  expect(() =>
    validateContent({
      ...content,
      nodes: { [ID(4)]: { ...node("bad"), position: { x: Infinity, y: 0 } } },
    }),
  ).toThrow("position");
  expect(() => createDocument(PROJECT, "😀".repeat(51))).toThrow("name");
  expect(() => addNode(doc, ID(4), node("x".repeat(LIMITS.text + 1)))).toThrow(
    "text",
  );
  expect(() => addNode(doc, ID(1), node("duplicate"))).toThrow("reused");
  text(doc).format(0, 1, { bold: true });
  expect(() => materialize(doc)).toThrow("Plain text");
  present(nodeMap(doc).get(ID(1))).set("text", "not shared");
  expect(() => materialize(doc)).toThrow("shared");
  doc.destroy();
});
test("JSON creates a new project; binary recovery preserves lineage and subsequent merges", () => {
  const doc = base();
  const json = exportJSON(doc);
  const clone = importJSON(json, ID(99));
  expect(clone.guid).toBe(ID(99));
  expect(materialize(clone)).toEqual(materialize(doc));
  expect(() => importJSON(json, PROJECT)).toThrow("new project UUID");
  const recovery = exportRecovery(doc);
  const restored = importRecovery(recovery);
  expect(restored.guid).toBe(PROJECT);
  expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(doc));
  const updates = capture(doc, () =>
    doc.transact(() => text(doc).insert(0, "later "), ORIGIN.local),
  );
  for (const update of updates) Y.applyUpdate(restored, update);
  expect(materialize(restored)).toEqual(materialize(doc));
  expect(() =>
    importRecovery(recovery.subarray(0, recovery.length - 1)),
  ).toThrow();
  expect(() => importRecovery(new Uint8Array(12))).toThrow();
  expect(() => importJSON('{"version":1}', ID(99))).toThrow("Unsupported");
  for (const item of [doc, clone, restored]) item.destroy();
});
test("golden conflict delivery orders have identical content and trees", () => {
  const values = scenarios();
  const a = present(values.find((s) => s.name === "move-delete-cycle"));
  const b = present(
    values.find((s) => s.name === "move-delete-cycle-reversed"),
  );
  expect(a.expected).toEqual(b.expected);
  expect(a.forest).toEqual(b.forest);
});

test("materialized atomic objects cannot mutate the document without a transaction", () => {
  const doc = base();
  const before = materialize(doc);
  const snapshot = materialize(doc);
  snapshot.nodes[ID(1)].placement.rank = "a9";
  const position = present(snapshot.nodes[ID(1)].position);
  position.x = 999;
  expect(materialize(doc)).toEqual(before);
  doc.destroy();
});

test("name and color cannot masquerade as atomic strings using shared text", () => {
  const doc = base();
  const metadata = doc.getMap("project").get("metadata") as Y.Map<unknown>;
  metadata.set("name", new Y.Text("not atomic"));
  expect(() => materialize(doc)).toThrow("atomic string");
  metadata.set("name", "Ideas");
  present(nodeMap(doc).get(ID(1))).set("color", new Y.Text("blue"));
  expect(() => materialize(doc)).toThrow("atomic string");
  doc.destroy();
});

test("rank length exhaustion re-spaces during the explicit insertion", () => {
  const doc = base();
  present(nodeMap(doc).get(ID(1))).set("placement", {
    parent: null,
    rank: `a0${"0".repeat(125)}1`,
  });
  present(nodeMap(doc).get(ID(3))).set("placement", {
    parent: null,
    rank: `a0${"0".repeat(125)}2`,
  });
  addNode(doc, ID(4), node("between"));
  placeNode(doc, ID(4), null, 1);
  const roots = projectForest(materialize(doc));
  expect(roots.map((n) => n.id)).toEqual([ID(1), ID(4), ID(3)]);
  expect(roots.map((n) => materialize(doc).nodes[n.id].placement.rank)).toEqual(
    ["a0", "a1", "a2"],
  );
  doc.destroy();
});
