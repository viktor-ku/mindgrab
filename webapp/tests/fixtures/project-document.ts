// Fixed client IDs and arbitrary shared values are test inputs only. Validation,
// materialization, projection and semantic moves use the shipped document model.
import * as Y from "yjs";
export { Y };
import {
  deleteSubtree,
  effectiveParents,
  materializeProject,
  moveNode,
  openProjectDocument,
  ORIGIN,
  SCHEMA_VERSION,
} from "../../src/project-document";
import type { NodeContent } from "../../src/project-document";

export {
  ORIGIN,
  materializeProject as materialize,
  projectForest,
} from "../../src/project-document";
export type {
  ProjectContent as Content,
  ForestNode,
  NodeContent as NodeValue,
} from "../../src/project-document";

export function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture entry");
  return value;
}

export function nodeMap(doc: Y.Doc) {
  return doc.getMap("project").get("nodes") as Y.Map<Y.Map<unknown>>;
}

export function createDocument(id: string, name: string, client: number) {
  const doc = new Y.Doc({ guid: id });
  doc.clientID = client;
  doc.transact(() => {
    const root = doc.getMap("project");
    root.set("schemaVersion", SCHEMA_VERSION);
    const metadata = new Y.Map();
    metadata.set("name", name);
    root.set("metadata", metadata);
    root.set("nodes", new Y.Map());
  }, ORIGIN.create);
  return doc;
}

export function openDocument(id: string, bytes: Uint8Array, client: number) {
  const doc = openProjectDocument(id, [bytes]);
  doc.clientID = client;
  return doc;
}

export function addNode(doc: Y.Doc, id: string, value: NodeContent) {
  doc.transact(() => {
    // Construct wire fixtures directly, including arbitrary placements needed
    // for orphan/cycle/causal-gap tests. No UI command or validation copy lives here.
    const nodes = nodeMap(doc);
    if (nodes.has(id)) throw new Error("Fixture node ID already exists");
    const node = new Y.Map();
    node.set("text", new Y.Text(value.text));
    node.set("placement", { ...value.placement });
    node.set("deleted", value.deleted);
    node.set("color", value.color);
    if (value.position) node.set("position", { ...value.position });
    nodes.set(id, node);
  }, ORIGIN.local);
}

export function deleteObservedSubtree(doc: Y.Doc, id: string) {
  deleteSubtree(doc, id);
}

export function placeNode(
  doc: Y.Doc,
  id: string,
  parent: string | null,
  index: number,
) {
  const content = materializeProject(doc);
  const parents = effectiveParents(content);
  const siblings = [...parents.keys()]
    .filter((key) => key !== id && parents.get(key) === parent)
    .sort((a, b) => {
      const left = content.nodes[a].placement.rank;
      const right = content.nodes[b].placement.rank;
      return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  const next = siblings[index];
  const previous = siblings[index - 1];
  moveNode(
    doc,
    id,
    next
      ? { id: next, placement: "before" }
      : previous
        ? { id: previous, placement: "after" }
        : parent
          ? { id: parent, placement: "child" }
          : { placement: "root" },
  );
}

export function createUndoManager(doc: Y.Doc) {
  return new Y.UndoManager(doc.getMap("project"), {
    trackedOrigins: new Set([ORIGIN.local]),
    captureTimeout: 0,
  });
}
