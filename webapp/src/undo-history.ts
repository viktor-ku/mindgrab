import type { ProjectDocument } from "./project-document";

export type HistoryEntry<Selection> = { before?: Selection; after?: Selection };
type RestoreEvent<Selection> = {
  entry: HistoryEntry<Selection>;
  direction: "undo" | "redo";
};
// Only selection metadata is browser-owned. Loro's native UndoManager owns
// grouping, the 100-step bound, and transformations over remote edits.
export class EditHistory<Selection> {
  #doc: ProjectDocument;
  #undo: HistoryEntry<Selection>[] = [];
  #redo: HistoryEntry<Selection>[] = [];
  #recordListeners = new Set<(entry: HistoryEntry<Selection>) => void>();
  #restoreListeners = new Set<(event: RestoreEvent<Selection>) => void>();
  #popping = false;
  constructor(doc: ProjectDocument) {
    this.#doc = doc;
    if (doc.ready) doc.native().startGroup();
    doc.on("snapshot", this.#changed);
  }
  #changed = () => {
    if (this.#popping || !this.#doc.ready) return;
    const count = this.#doc.native().undoCount();
    if (count > this.#undo.length) {
      const entry: HistoryEntry<Selection> = {};
      this.#undo.push(entry);
      this.#redo = [];
      for (const listener of this.#recordListeners) listener(entry);
    }
    while (this.#undo.length > count) this.#undo.shift();
    while (this.#undo.length > 100) this.#undo.shift();
  };
  onRecord(listener: (entry: HistoryEntry<Selection>) => void) {
    this.#recordListeners.add(listener);
  }
  onRestore(listener: (event: RestoreEvent<Selection>) => void) {
    this.#restoreListeners.add(listener);
  }
  finishGroup() {
    if (this.#doc.ready) {
      this.#doc.native().stopGroup();
      this.#doc.native().startGroup();
    }
  }
  undo() {
    this.#pop("undo");
  }
  redo() {
    this.#pop("redo");
  }
  #pop(type: "undo" | "redo") {
    if (!(type === "undo" ? this.canUndo() : this.canRedo())) return;
    this.#doc.native().stopGroup();
    this.#popping = true;
    const source = type === "undo" ? this.#undo : this.#redo;
    const destination = type === "undo" ? this.#redo : this.#undo;
    const entry = source.pop() ?? {};
    try {
      this.#doc.dispatch({ type });
      destination.push(entry);
      for (const listener of this.#restoreListeners)
        listener({ entry, direction: type });
    } finally {
      this.#popping = false;
      this.#doc.native().startGroup();
    }
  }
  canUndo() {
    return this.#doc.ready && this.#doc.native().canUndo();
  }
  canRedo() {
    return this.#doc.ready && this.#doc.native().canRedo();
  }
  destroy() {
    this.#doc.off("snapshot", this.#changed);
    if (this.#doc.ready) this.#doc.native().stopGroup();
    this.#recordListeners.clear();
    this.#restoreListeners.clear();
  }
}
