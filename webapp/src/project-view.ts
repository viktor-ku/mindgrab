import { batch, createSignal, onCleanup } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { MindMapNode } from "./mind-map";
import {
  projectMindMap,
  readProject,
  savingPreferences,
} from "./project-document";
import type {
  ProjectDocument,
  ProjectState,
  SavingPreferences,
} from "./project-document";
export interface ProjectView {
  status: Accessor<ProjectState["status"]>;
  name: Accessor<string>;
  saving: Accessor<SavingPreferences>;
  forest: Accessor<MindMapNode[]>;
  text(id: string): string;
}
export function createProjectView(doc: ProjectDocument): ProjectView {
  const [status, setStatus] = createSignal<ProjectState["status"]>("loading");
  const [name, setName] = createSignal("");
  const [saving, setSaving] = createSignal(savingPreferences(doc));
  const [forest, setForest] = createSignal<MindMapNode[]>([]);
  const texts = new Map<string, [Accessor<string>, Setter<string>]>();
  let structure = "";
  function textSignal(id: string) {
    const signal = texts.get(id) ?? createSignal("");
    texts.set(id, signal);
    return signal;
  }
  function refresh() {
    const state = readProject(doc);
    batch(() => {
      setStatus(state.status);
      setSaving(savingPreferences(doc));
      if (state.status !== "ready") {
        setForest([]);
        return;
      }
      setName(state.view.name);
      for (const node of state.view.nodes) textSignal(node.id)[1](node.text);
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
  doc.on("snapshot", refresh);
  onCleanup(() => doc.off("snapshot", refresh));
  refresh();
  return { status, name, saving, forest, text: (id) => textSignal(id)[0]() };
}
