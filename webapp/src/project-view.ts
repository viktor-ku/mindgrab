import { batch, createSignal, onCleanup } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { DEFAULT_LINK_STYLE, type MindMapNode } from "./mind-map";
import {
  colorPreferences,
  DEFAULT_COLOR_PREFERENCES,
  DEFAULT_SAVING_PREFERENCES,
  linkStyle,
  projectMindMap,
  sameColorPreferences,
  readProject,
  savingPreferences,
} from "./project-document";
import type {
  ColorPreferences,
  LinkStyle,
  ProjectDocument,
  ProjectState,
  SavingPreferences,
} from "./project-document";
export interface ProjectView {
  status: Accessor<ProjectState["status"]>;
  name: Accessor<string>;
  saving: Accessor<SavingPreferences>;
  colors: Accessor<ColorPreferences>;
  links: Accessor<LinkStyle>;
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
  const [saving, setSaving] = createSignal(
    doc ? savingPreferences(doc) : { ...DEFAULT_SAVING_PREFERENCES },
  );
  const [colors, setColors] = createSignal(
    doc ? colorPreferences(doc) : DEFAULT_COLOR_PREFERENCES,
    { equals: sameColorPreferences },
  );
  const [links, setLinks] = createSignal(
    doc ? linkStyle(doc) : DEFAULT_LINK_STYLE,
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
      setSaving(savingPreferences(current));
      setColors(colorPreferences(current));
      setLinks(linkStyle(current));
      if (state.status !== "ready") {
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
    saving,
    colors,
    links,
    forest,
    text: (id) => textSignal(id)[0](),
    note: (id) => noteSignal(id)[0](),
  };
  return { view, show };
}
