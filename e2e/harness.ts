import { QueryClientProvider } from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { appRouter } from "./app-router";
import { queryClient } from "../webapp/src/query-client";
import { createComponent, render } from "solid-js/web";
import type { ProjectDocument } from "../webapp/src/project-document";
import { App } from "../webapp/src/App";
import "../webapp/src/index.css";
import {
  createChild,
  deleteSubtree,
  editNodeNote,
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
let localUpdates = 0;

function link(doc: ProjectDocument) {
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

const router = appRouter(() => createComponent(App, { onDocument: link }));

const harness = {
  projectId: () => local.id,
  content: () => local.view(),
  ids: () => nodes(remote).map((node) => node.id),
  text: (id: string) => nodes(remote).find((node) => node.id === id)?.text,
  position: (id: string) =>
    nodes(remote).find((node) => node.id === id)?.position,
  deleted: (id: string) => !remote.view().nodes.some((node) => node.id === id),
  localUpdates: () => localUpdates,
  // Remote edits, as another device would make them.
  edit: (id: string, index: number, deleteCount: number, insert: string) =>
    editNodeText(remote, id, index, deleteCount, insert),
  editNote: (id: string, index: number, deleteCount: number, insert: string) =>
    editNodeNote(remote, id, index, deleteCount, insert),
  note: (id: string) => nodes(remote).find((node) => node.id === id)?.note,
  addChild: (parent: string, text: string) =>
    createChild(remote, parent, { text }),
  remove: (id: string) => deleteSubtree(remote, id),
  place: (id: string, x: number, y: number) =>
    translateSubtree(remote, id, new Map([[id, { x, y }]]), { x: 0, y: 0 }),
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
        return createComponent(RouterProvider, { router });
      },
    }),
  root,
);
