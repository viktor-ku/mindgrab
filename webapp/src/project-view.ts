import { batch, createSignal, onCleanup } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { MindMapNode } from "./mind-map";
import type { LegacyPreferences } from "./generated/mindgrab-state/model";
import {
  legacyPreferences,
  projectMindMap,
  readProject,
} from "./project-document";
import type { ProjectDocument, ProjectState } from "./project-document";
export interface ProjectView {
  status: Accessor<ProjectState["status"]>;
  name: Accessor<string>;
  // Colors and a connection style an older map still keeps in its document.
  legacy: Accessor<LegacyPreferences | undefined>;
  forest: Accessor<MindMapNode[]>;
  text(id: string): string;
  note(id: string): string;
}
export function createProjectView(doc: ProjectDocument): ProjectView {
  return createReplaceableProjectView(doc).view;
}
/**
 * One view of the documents shown in turn, as a shared map replaces its
 * document with each revision. Ideas and structure that did not change keep
 * their identity, so nothing on screen is rebuilt for them.
 */
export function createReplaceableProjectView(first?: ProjectDocument) {
  let doc = first;
  const [status, setStatus] = createSignal<ProjectState["status"]>("loading");
  const [name, setName] = createSignal("");
  const [legacy, setLegacy] = createSignal(
    doc ? legacyPreferences(doc) : undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const [forest, setForest] = createSignal<MindMapNode[]>([]);
  const texts = new Map<string, [Accessor<string>, Setter<string>]>();
  const notes = new Map<string, [Accessor<string>, Setter<string>]>();
  let structure = "";
  function textSignal(id: string) {
    const signal = texts.get(id) ?? createSignal("");
    texts.set(id, signal);
    return signal;
  }
  function noteSignal(id: string) {
    const signal = notes.get(id) ?? createSignal("");
    notes.set(id, signal);
    return signal;
  }
  function refresh() {
    if (!doc) {
      batch(() => {
        setStatus("loading");
        setForest([]);
      });
      structure = "";
      return;
    }
    const current = doc;
    const state = readProject(current);
    batch(() => {
      setStatus(state.status);
      setLegacy(legacyPreferences(current));
      if (state.status !== "ready") {
        // The empty forest has no structure, so the next map shows in full.
        structure = "";
        setForest([]);
        return;
      }
      setName(state.view.name);
      for (const node of state.view.nodes) {
        textSignal(node.id)[1](node.text);
        noteSignal(node.id)[1](node.note);
      }
      const next = JSON.stringify([
        state.view.roots,
        state.view.nodes.map(({ text, ...node }) => node),
      ]);
      if (next !== structure) {
        structure = next;
        setForest(projectMindMap(state.view));
      }
    });
  }
  function show(next?: ProjectDocument) {
    if (next === doc) return;
    doc?.off("snapshot", refresh);
    doc = next;
    doc?.on("snapshot", refresh);
    refresh();
  }
  doc?.on("snapshot", refresh);
  onCleanup(() => doc?.off("snapshot", refresh));
  refresh();
  const view: ProjectView = {
    status,
    name,
    legacy,
    forest,
    text: (id) => textSignal(id)[0](),
    note: (id) => noteSignal(id)[0](),
  };
  return { view, show };
}
