import init, {
  ProjectState as WasmState,
} from "./generated/mindgrab-state/mindgrab_state";
import type {
  Command,
  CommandResult,
  ProjectView as RustView,
  SavingPreferences,
} from "./generated/mindgrab-state/model";
import type { MindMapNode, NodePosition } from "./mind-map";
import type { NodeColor } from "./node-colors";
import { z } from "zod";

// WASM is loaded before any editor or repository can create a document.
const bun = (
  globalThis as unknown as {
    Bun?: { file(path: URL): { arrayBuffer(): Promise<ArrayBuffer> } };
  }
).Bun;
await init(
  bun && typeof window === "undefined"
    ? {
        module_or_path: await bun
          .file(
            new URL(
              "./generated/mindgrab-state/mindgrab_state_bg.wasm",
              import.meta.url,
            ),
          )
          .arrayBuffer(),
      }
    : undefined,
);
export const SCHEMA_VERSION = 1;
export const LIMITS = { nodes: 10_000, text: 65_536, nameBytes: 200 } as const;
export const ORIGIN = {
  create: Symbol("create"),
  local: Symbol("local"),
  remote: Symbol("remote"),
  persistence: Symbol("persistence"),
  import: Symbol("import"),
} as const;
export const DEFAULT_NODE_COLOR: NodeColor = "blue";
export type { SavingPreferences };
export const SavingPreferencesSchema = z.strictObject({
  local: z.boolean(),
  cloud: z.boolean(),
});
export const DEFAULT_SAVING_PREFERENCES: SavingPreferences = {
  local: true,
  cloud: true,
};
export const isProjectId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );
export type DocumentView = RustView;
export type ProjectState =
  | { status: "ready"; view: DocumentView }
  | { status: "loading" }
  | { status: "invalid"; message: string };
export interface NewNode {
  text?: string;
  color?: NodeColor;
  position?: NodePosition;
}
export interface ForestNode {
  id: string;
  text: string;
  color: NodeColor;
  position?: NodePosition;
  children: ForestNode[];
}
export type SnapshotListener = (snapshot: Uint8Array, origin: unknown) => void;

// This class owns browser lifetimes and notifications. Document behavior lives
// in mindgrab-state; TypeScript never mutates a Loro container.
export class ProjectDocument {
  readonly id: string;
  importedIds?: ReadonlyMap<string, string>;
  #state?: WasmState;
  #snapshots = new Set<SnapshotListener>();
  #before = new Set<() => void>();
  #destroyed = false;
  constructor(id: string, state?: WasmState) {
    this.id = id;
    this.#state = state;
  }
  get ready() {
    return !!this.#state;
  }
  get observerCount() {
    return this.#snapshots.size;
  }
  native() {
    if (!this.#state || this.#destroyed)
      throw new Error("The project has not loaded.");
    return this.#state;
  }
  version() {
    return this.#state ? Array.from(this.#state.version()).join(",") : "";
  }
  snapshot() {
    return this.#state?.snapshot() ?? new Uint8Array();
  }
  view(): RustView {
    return JSON.parse(this.native().view());
  }
  on(name: "snapshot", listener: SnapshotListener): void;
  on(name: "beforeChange", listener: () => void): void;
  on(
    name: "snapshot" | "beforeChange",
    listener: SnapshotListener | (() => void),
  ) {
    if (name === "snapshot") this.#snapshots.add(listener as SnapshotListener);
    else this.#before.add(listener as () => void);
  }
  off(name: "snapshot", listener: SnapshotListener): void;
  off(name: "beforeChange", listener: () => void): void;
  off(
    name: "snapshot" | "beforeChange",
    listener: SnapshotListener | (() => void),
  ) {
    if (name === "snapshot")
      this.#snapshots.delete(listener as SnapshotListener);
    else this.#before.delete(listener as () => void);
  }
  change<T>(action: () => T, origin: unknown = ORIGIN.local): T {
    if (this.#destroyed) throw new Error("This document is closed.");
    for (const listener of this.#before) listener();
    const version = this.version();
    const result = action();
    if (this.version() !== version) {
      const bytes = this.snapshot();
      for (const listener of this.#snapshots) listener(bytes, origin);
    }
    return result;
  }
  dispatch(command: Command): CommandResult {
    return this.change(() =>
      JSON.parse(this.native().dispatch(JSON.stringify(command))),
    );
  }
  merge(bytes: Uint8Array, origin: unknown = ORIGIN.remote) {
    if (!bytes.length) return;
    this.change(() => {
      if (this.#state) this.#state.merge(bytes);
      else this.#state = WasmState.fromSnapshot(bytes);
    }, origin);
  }
  clearHistory() {
    this.native().clearHistory();
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#snapshots.clear();
    this.#before.clear();
    this.#state?.free();
    this.#state = undefined;
  }
}

export function createProjectDocument(
  id: string,
  name: string,
  root?: NewNode,
) {
  const doc = new ProjectDocument(id, new WasmState(name));
  if (root) createRoot(doc, root);
  doc.clearHistory();
  return doc;
}
export function openProjectDocument(
  id: string,
  snapshots: Iterable<Uint8Array> = [],
  origin: unknown = ORIGIN.persistence,
) {
  const doc = new ProjectDocument(id);
  try {
    for (const bytes of snapshots) doc.merge(bytes, origin);
    if (doc.ready) doc.clearHistory();
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
export function readProject(doc: ProjectDocument): ProjectState {
  if (!doc.ready) return { status: "loading" };
  try {
    return { status: "ready", view: doc.view() };
  } catch (error) {
    return { status: "invalid", message: String(error) };
  }
}
export function projectName(doc: ProjectDocument) {
  return doc.ready ? doc.view().name : undefined;
}
export function savingPreferences(doc: ProjectDocument): SavingPreferences {
  return doc.ready ? doc.view().saving : { ...DEFAULT_SAVING_PREFERENCES };
}
export function setSavingPreferences(
  doc: ProjectDocument,
  value: SavingPreferences,
) {
  doc.dispatch({ type: "setSaving", ...value });
}
export function projectMindMap(view: DocumentView): MindMapNode[] {
  const entries = new Map<string, MindMapNode>();
  for (const node of view.nodes)
    entries.set(node.id, {
      id: node.id,
      text: node.text,
      color: node.color,
      ...(node.position && { position: node.position }),
    });
  for (const node of view.nodes)
    if (node.children.length)
      entries.get(node.id)!.next = node.children.map((id) => entries.get(id)!);
  return view.roots.map((id) => entries.get(id)!);
}
export function projectForest(content: DocumentView): ForestNode[] {
  const convert = (nodes: MindMapNode[]): ForestNode[] =>
    nodes.map(({ next, ...node }) => ({
      ...node,
      color: node.color ?? "blue",
      children: convert(next ?? []),
    }));
  return convert(projectMindMap(content));
}
function create(
  doc: ProjectDocument,
  parent: string | null,
  init: NewNode = {},
) {
  const id = doc.dispatch({
    type: "createNode",
    parent,
    index: null,
    text: init.text ?? "",
    color: init.color ?? "blue",
  }).createdNode!;
  if (init.position)
    doc.dispatch({ type: "setPosition", id, position: init.position });
  return id;
}
export const createRoot = (doc: ProjectDocument, init: NewNode = {}) =>
  create(doc, null, init);
export const createChild = (
  doc: ProjectDocument,
  parent: string,
  init: NewNode = {},
) => create(doc, parent, init);
export function createSibling(
  doc: ProjectDocument,
  id: string,
  init: NewNode = {},
) {
  return doc.dispatch({
    type: "createSibling",
    id,
    text: init.text ?? "",
    color: init.color ?? "blue",
  }).createdNode!;
}
export const renameProject = (doc: ProjectDocument, name: string) =>
  doc.dispatch({ type: "rename", name }).changed;
export const editNodeText = (
  doc: ProjectDocument,
  id: string,
  index: number,
  deleteCount: number,
  insert: string,
) => doc.dispatch({ type: "editText", id, index, deleteCount, insert }).changed;
export const replaceNodeText = (
  doc: ProjectDocument,
  id: string,
  text: string,
) => doc.dispatch({ type: "setText", id, text }).changed;
export const deleteSubtree = (doc: ProjectDocument, id: string) =>
  doc.dispatch({ type: "deleteNode", id }).changed;
export const setNodeColor = (
  doc: ProjectDocument,
  id: string,
  color: NodeColor,
  branch = false,
) =>
  doc.dispatch({ type: branch ? "colorBranch" : "setColor", id, color })
    .changed;
export const reorderNode = (
  doc: ProjectDocument,
  id: string,
  direction: -1 | 1,
) => doc.dispatch({ type: "reorderNode", id, direction }).changed;
export const translateSubtree = (
  doc: ProjectDocument,
  id: string,
  positions: ReadonlyMap<string, NodePosition>,
  delta: NodePosition,
) =>
  doc.dispatch({
    type: "translateSubtree",
    id,
    positions: Object.fromEntries(
      [...positions].map(([key, { x, y }]) => [key, { x, y }]),
    ),
    delta,
  }).changed;
export function importProjectDocument(id: string, view: DocumentView) {
  const doc = createProjectDocument(id, view.name);
  const ids = new Map<string, string>();
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  try {
    const pending = view.roots
      .toReversed()
      .map((id) => ({ id, parent: null as string | null }));
    while (pending.length) {
      const { id: oldId, parent } = pending.pop()!;
      const node = nodes.get(oldId);
      if (!node || ids.has(oldId))
        throw new Error("Invalid project hierarchy.");
      const newId = create(doc, parent, {
        ...node,
        position: node.position ?? undefined,
      });
      ids.set(oldId, newId);
      pending.push(
        ...node.children.toReversed().map((id) => ({ id, parent: newId })),
      );
    }
    if (ids.size !== nodes.size) throw new Error("Invalid project hierarchy.");
    setSavingPreferences(doc, view.saving);
    doc.importedIds = ids;
    doc.clearHistory();
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
