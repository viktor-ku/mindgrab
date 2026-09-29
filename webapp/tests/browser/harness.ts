import { createComponent, render } from "solid-js/web";
import * as Y from "yjs";
import { App } from "../../src/App";
import "../../src/index.css";
import {
  createChild,
  deleteSubtree,
  editNodeText,
  materializeProject,
  openProjectDocument,
  ORIGIN,
  projectMindMap,
  translateSubtree,
} from "../../src/project-document";
import type { MindMapNode } from "../../src/mind-map";

// Mounts the real app with a second in-process replica of its document that
// stands in for another device. Updates flow both ways immediately.
let local: Y.Doc;
let remote: Y.Doc;
const retired: Y.Doc[] = [];
const retiredRemotes: Y.Doc[] = [];
let localUpdates = 0;
let textDeltas: unknown[] = [];

function link(doc: Y.Doc) {
  if (local) {
    retired.push(local);
    retiredRemotes.push(remote);
  }
  local = doc;
  const replica = openProjectDocument(
    doc.guid,
    [Y.encodeStateAsUpdate(doc)],
    ORIGIN.remote,
  );
  remote = replica;
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN.remote) return;
    localUpdates++;
    Y.applyUpdate(replica, update, ORIGIN.remote);
  });
  replica.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== ORIGIN.remote) Y.applyUpdate(doc, update, ORIGIN.remote);
  });
  replica.getMap("project").observeDeep((events, transaction) => {
    if (transaction.origin !== ORIGIN.remote) return;
    for (const event of events)
      if (event.target instanceof Y.Text) textDeltas.push(event.delta);
  });
}

const flatten = (nodes: MindMapNode[]): MindMapNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.next ?? [])]);
const nodes = (doc: Y.Doc) => flatten(projectMindMap(materializeProject(doc)));

const harness = {
  ids: () => nodes(remote).map((node) => node.id),
  text: (id: string) => nodes(remote).find((node) => node.id === id)?.text,
  localText: (id: string) => nodes(local).find((node) => node.id === id)?.text,
  position: (id: string) =>
    nodes(remote).find((node) => node.id === id)?.position,
  deleted: (id: string) => materializeProject(remote).nodes[id]?.deleted,
  localUpdates: () => localUpdates,
  takeTextDeltas: () => {
    const deltas = textDeltas;
    textDeltas = [];
    return deltas;
  },
  // Remote edits, as another device would make them.
  edit: (id: string, index: number, deleteCount: number, insert: string) =>
    editNodeText(remote, id, index, deleteCount, insert),
  addChild: (parent: string, text: string) =>
    createChild(remote, parent, { text }),
  remove: (id: string) => deleteSubtree(remote, id),
  place: (id: string, x: number, y: number) =>
    translateSubtree(remote, id, new Map([[id, { x, y }]]), { x: 0, y: 0 }),
  // Previous documents and their replicas stay linked after a project switch.
  editRetired: (id: string, insert: string) =>
    retiredRemotes.map((doc) => editNodeText(doc, id, 0, 0, insert)),
  retiredObservers: () =>
    retired.map(
      (doc) =>
        (doc.getMap("project") as unknown as { _dEH: { l: unknown[] } })._dEH.l
          .length,
    ),
};
export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

// Account requests are answered as signed out; there is no API server here.
window.fetch = async () => new Response(null, { status: 401 });
window.harness = harness;
const root = document.getElementById("root") as HTMLElement;
render(() => createComponent(App, { onDocument: link }), root);
