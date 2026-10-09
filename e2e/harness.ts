import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "../webapp/src/query-client";
import { createComponent, render } from "solid-js/web";
import type { ProjectDocument } from "../webapp/src/project-document";
import { App } from "../webapp/src/App";
import "../webapp/src/index.css";
import {
  createChild,
  deleteSubtree,
  editNodeText,
  openProjectDocument,
  ORIGIN,
  projectMindMap,
  translateSubtree,
} from "../webapp/src/project-document";
import type { MindMapNode } from "../webapp/src/mind-map";

// Mounts the real app with a second in-process replica of its document that
// stands in for another device. Updates flow both ways immediately.
let local: ProjectDocument;
let remote: ProjectDocument;
const retired: ProjectDocument[] = [];
const retiredRemotes: ProjectDocument[] = [];
let localUpdates = 0;

function link(doc: ProjectDocument) {
  if (local) {
    retired.push(local);
    retiredRemotes.push(remote);
  }
  local = doc;
  const replica = openProjectDocument(doc.id, [doc.snapshot()], ORIGIN.remote);
  remote = replica;
  doc.on("snapshot", (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN.remote) return;
    localUpdates++;
    replica.merge(update, ORIGIN.remote);
  });
  replica.on("snapshot", (update: Uint8Array, origin: unknown) => {
    if (origin !== ORIGIN.remote && doc.ready) doc.merge(update, ORIGIN.remote);
  });
}

const flatten = (nodes: MindMapNode[]): MindMapNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.next ?? [])]);
const nodes = (doc: ProjectDocument) => flatten(projectMindMap(doc.view()));

const harness = {
  projectId: () => local.id,
  content: () => local.view(),
  ids: () => nodes(remote).map((node) => node.id),
  text: (id: string) => nodes(remote).find((node) => node.id === id)?.text,
  localText: (id: string) => nodes(local).find((node) => node.id === id)?.text,
  position: (id: string) =>
    nodes(remote).find((node) => node.id === id)?.position,
  deleted: (id: string) => !remote.view().nodes.some((node) => node.id === id),
  localUpdates: () => localUpdates,
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
    retiredRemotes
      .filter((doc) => doc.view().nodes.some((node) => node.id === id))
      .map((doc) => editNodeText(doc, id, 0, 0, insert)),
  retiredObservers: () => retired.map((doc) => doc.observerCount),
};
export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

// Account requests are answered as signed out; there is no API server here.
window.fetch = (async () =>
  new Response(null, { status: 401 })) as unknown as typeof window.fetch;
window.harness = harness;
const root = document.getElementById("root") as HTMLElement;
render(
  () =>
    createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        return createComponent(App, { onDocument: link });
      },
    }),
  root,
);
