import { batch, createSignal, onCleanup } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import * as Y from "yjs";
import type { MindMapNode } from "./mind-map";
import { LIMITS, projectMindMap, readProject } from "./project-document";
import type { ProjectState } from "./project-document";

// A read-only reactive view of one project document. Writes go through the
// document commands; the view follows every transaction, local or remote.
export interface ProjectView {
  status: Accessor<ProjectState["status"]>;
  name: Accessor<string>;
  // Hierarchy, colors, and positions. Its `text` fields refresh only with
  // structural changes, so render text through `text(id)`.
  forest: Accessor<MindMapNode[]>;
  text(id: string): string;
}

// Observes the document until the current reactive owner is disposed. Each
// transaction updates the view once: text-only transactions update just the
// edited nodes' signals, and anything else re-projects the tree.
export function createProjectView(doc: Y.Doc): ProjectView {
  const [status, setStatus] = createSignal<ProjectState["status"]>("loading");
  const [name, setName] = createSignal("");
  const [forest, setForest] = createSignal<MindMapNode[]>([]);
  const texts = new Map<string, [Accessor<string>, Setter<string>]>();
  let ready = false;

  function textSignal(id: string) {
    const signal = texts.get(id) ?? createSignal("");
    texts.set(id, signal);
    return signal;
  }

  function refresh() {
    const state = readProject(doc);
    ready = state.status === "ready";
    batch(() => {
      setStatus(state.status);
      if (state.status !== "ready") {
        setForest([]);
        return;
      }
      const { content } = state;
      setName(content.metadata.name);
      for (const [id, node] of Object.entries(content.nodes))
        if (!node.deleted) textSignal(id)[1](node.text);
      setForest(projectMindMap(content));
    });
  }

  const root = doc.getMap("project");
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const textOnly = events.every(
      (event) =>
        event.target instanceof Y.Text && event.target.length <= LIMITS.text,
    );
    if (!ready || !textOnly) return refresh();
    batch(() => {
      // Paths are relative to the root: ["nodes", nodeId, "text"].
      for (const event of events)
        texts.get(String(event.path[1]))?.[1](event.target.toString());
    });
  };
  root.observeDeep(observer);
  onCleanup(() => root.unobserveDeep(observer));
  refresh();

  return {
    status,
    name,
    forest,
    text: (id) => textSignal(id)[0](),
  };
}
